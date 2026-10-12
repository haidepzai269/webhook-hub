import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService, getMasterKey } from '@hub/database';
import { RedisService } from '../redis/redis.service';
import { AdapterContext, IdempotencyKeyMissingError, ProviderRegistry } from '@hub/providers';
import { aesGcmDecrypt } from '@hub/crypto';
import {
  RawWebhookRequest,
  IngestResult,
  ProviderType,
  logger,
  generateCorrelationId,
  OutboxPayload,
  TraceIngestedNotice,
  MAX_INGEST_PAYLOAD_BYTES,
} from '@hub/common';
import { Prisma } from '@prisma/client';
import { REJECTED_META_KEY, RejectedRecordLimiter, sampleRejectedBody } from './rejected-sample';
import { redactHeaders } from './redact-headers';
import {
  ingestDuration,
  ingestRequests,
  penaltyEntries,
  penaltyGoodEntries,
  penaltySkippedPrivate,
  trafficFlushDropped,
  unknownSourceTotal,
} from '../metrics/metrics';
import { DuplicateCounter } from './duplicate-counter';
import { PenaltyBox, PenaltyVerdict, isLocalOrPrivateIp, resolvePenaltyConfig } from './penalty-box';
import { createPenaltyBox } from './penalty-provider';
import { IngestResponse, blockedAck, providerMetricLabel } from './blocked-ack';
import { TrafficOutcome, TrafficRecorder } from './traffic-recorder';
import { onShutdownFlush } from '../../shutdown';

export type { IngestResponse } from './blocked-ack';

/**
 * S2-2 (ADR-049): chặng ①–④ (nhận, verify, COMMIT, ACK) chạy trong hub-api -> phát `trace.ingested`
 * THẲNG vào Socket.IO cùng tiến trình, 0 lệnh Redis. RealtimeGateway cài interface này (ADR-021).
 */
export interface TraceNotifier {
  traceIngested(tenantId: string, notice: TraceIngestedNotice): void;
}
export const TRACE_NOTIFIER = Symbol('TRACE_NOTIFIER');

interface TraceState {
  correlationId: string;
  tenantId?: string;
  outcome?: TraceIngestedNotice['outcome'];
  rawEventId?: string;
  /** EG2: cặp (ip, sourceKey) đang bị hộp phạt chặn — tenant đã biết, không có `outcome` (không phát trace). */
  blocked?: boolean;
  /** EG4: source đã biết -> lưu lượng theo phút. */
  sourceId?: string;
}

/** EG4: outcome của trace -> outcome của bảng lưu lượng (ERROR không lưu — đã có metric + log). */
const TRAFFIC_OUTCOMES = new Set<string>(['ACCEPTED', 'DUPLICATE', 'REJECTED', 'RATE_LIMITED']);

/**
 * ADR-139 (Q1 = a): ack TỪ CHỐI (401 chữ ký / 422 thiếu khoá chống trùng) theo định dạng của CHÍNH provider
 * (`adapter.buildAck`) — GenericAdapter kèm `fix` cho dev đang cấu hình nguồn. STATUS do lõi quyết, adapter chỉ
 * quyết body (không provider nào đổi được 401/422). `message` là hằng của lõi — không bao giờ chứa secret hay body
 * request. Hàm thuần, không I/O: không thêm gì vào đường nóng. buildAck lỗi -> body cũ.
 */
function rejectAck(
  adapter: { buildAck(r: IngestResult): { status: number; body: unknown } },
  status: 401 | 422,
  message: string,
  log: { warn: (o: unknown, m?: string) => void },
): { status: number; body: unknown } {
  try {
    return { status, body: adapter.buildAck({ accepted: false, status, message }).body };
  } catch (err: any) {
    log.warn({ err: err?.message }, 'buildAck lỗi khi dựng ack từ chối -> dùng body mặc định');
    return { status, body: { error: message } };
  }
}

@Injectable()
export class IngestService implements OnModuleInit, OnModuleDestroy {
  /** S1-4: trần 20 bản ghi REJECTED/phút/source, trong bộ nhớ (không tốn Redis). */
  private readonly rejectedLimiter = new RejectedRecordLimiter();
  /**
   * CB6 (ADR-171): bản trùng không có dòng raw_events -> đếm trong bộ nhớ, ghi Postgres mỗi ~5s (nhận định `I-dup`).
   * `record()` không I/O: ACK trùng không chậm thêm, ngân sách Redis không đổi.
   */
  readonly duplicates = new DuplicateCounter((tenantId, rows) => this.prisma.forTenant(tenantId).addIngestDuplicates(rows));
  /**
   * EG2 (ADR-177): hộp phạt IP trong bộ nhớ — 0 lệnh Redis, 0 truy vấn DB. Mọi lời gọi đi qua `penaltySafe` (fail-open).
   * D3: cùng MỘT instance với gate trước body parser (provider `PenaltyBox`, `penalty-provider.ts`); không có DI (test
   * `new IngestService(...)`) thì tự tạo. Gán lại được (test).
   */
  penalty: PenaltyBox;
  private lastPrivateLog = 0;
  private readonly penaltyEnabled = resolvePenaltyConfig().enabled !== false;
  /**
   * EG4 (ADR-179): lưu lượng theo (source, phút, outcome) — `record()` không I/O; đẩy xuống Postgres mỗi `TRAFFIC_FLUSH_MS`
   * qua `forTenant` (RLS). Ghi lỗi -> giữ tối đa 10 phút dữ liệu.
   */
  readonly traffic = new TrafficRecorder((tenantId, rows) => this.prisma.forTenant(tenantId).addSourceTraffic(rows), {
    onDropped: (n) => trafficFlushDropped.inc(n),
  });
  private unregisterShutdown?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() @Inject(TRACE_NOTIFIER) private readonly notifier?: TraceNotifier,
    @Optional() penalty?: PenaltyBox,
  ) {
    this.penalty = penalty ?? createPenaltyBox();
  }

  /**
   * `app.close()` (test, Nest): ghi nốt bộ đếm bản trùng. Tín hiệu SIGTERM/SIGINT thật KHÔNG đi qua đây — `main.ts`
   * (`installShutdown`) gọi `duplicates.close()` có trần thời gian rồi thoát (review CB6 Thấp 3).
   */
  onModuleInit(): void {
    // SIGTERM thật không đi qua onModuleDestroy (xem trên) -> lưu lượng đăng ký ghi nốt với `installShutdown` (best-effort).
    this.unregisterShutdown = onShutdownFlush(() => this.traffic.close());
  }

  async onModuleDestroy(): Promise<void> {
    this.unregisterShutdown?.();
    await Promise.all([this.duplicates.close(), this.traffic.close()]);
  }

  async ingestWebhook(req: RawWebhookRequest): Promise<IngestResponse> {
    return this.traced(req, (trace) => this.ingestCore(req, trace));
  }

  /**
   * S4 (SPEC §4.4): service tự phát sự kiện qua `POST /v1/p/:project/events`. Xác thực (API key + scope) và kiểm
   * đầu vào/catalog đã xong ở controller. Đi ĐÚNG đường ingest: rate limit -> chống trùng -> `persistAccepted`
   * (raw_event + outbox cùng transaction, SET NX SAU COMMIT) -> 202. Cùng số lệnh Redis như `/hooks` (X9) và
   * cũng phát `trace.ingested`.
   */
  async publishFromService(tenantId: string, sourceId: string, req: RawWebhookRequest): Promise<{ status: number; body: unknown }> {
    return this.traced(req, async (trace) => {
      const log = logger.child({ correlationId: trace.correlationId, provider: req.provider, sourceId });
      const source = await this.prisma.forTenant(tenantId).findSourceById(sourceId);
      // ADR-161: source đã lưu trữ ("Xoá" trên bản đồ) bị từ chối y như source tắt (lưu trữ luôn kèm is_active=false).
      if (!source || !source.isActive || source.archivedAt) {
        log.warn('Source api của key không tồn tại hoặc đã tắt');
        return { status: 409, body: { error: 'source_inactive' } };
      }
      trace.tenantId = source.tenantId;
      trace.sourceId = source.id;
      if (!(await this.redis.checkRateLimit(`rate:source:${source.id}`, ingestRateLimitPerMin(), 60))) {
        trace.outcome = 'RATE_LIMITED';
        return { status: 429, body: { error: 'rate_limited' } };
      }
      const adapter = ProviderRegistry.get(req.provider);
      const idempotencyKey = adapter.extractIdempotencyKey(req);
      const r = await this.persistAccepted(source, req, idempotencyKey, trace.correlationId, {
        headers: redactHeaders(req.headers as Record<string, unknown>) as Record<string, unknown>,
        signatureHeader: null,
        origin: 'api',
      });
      return this.ackFor(adapter, r, idempotencyKey, trace);
    });
  }

  /** Bọc chung cho /hooks và /events: metric trong bộ nhớ + `trace.ingested` in-process (0 lệnh Redis). */
  private async traced(
    req: RawWebhookRequest,
    run: (trace: TraceState) => Promise<IngestResponse>,
  ): Promise<IngestResponse> {
    const startedAt = Date.now();
    const trace: TraceState = { correlationId: generateCorrelationId() };
    const result = await run(trace);
    this.recordMetrics(req.provider, trace, result.status, startedAt);
    this.recordTraffic(req, trace);
    // Chỉ phát khi ĐÃ BIẾT tenant (source tồn tại) — 404/400/413 không phát gì. Best-effort.
    if (trace.tenantId && trace.outcome && this.notifier) {
      try {
        this.notifier.traceIngested(trace.tenantId, {
          correlationId: trace.correlationId,
          provider: req.provider,
          sourceKey: req.sourceKey,
          httpStatus: result.status,
          outcome: trace.outcome,
          rawEventId: trace.rawEventId,
          ms: Date.now() - startedAt,
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Không phát được trace.ingested (bỏ qua)');
      }
    }
    return result;
  }

  /**
   * Lõi dùng chung của `/hooks` và `/events` (SPEC §4.4) — ARCHITECTURE §3.1 bước 5–7, KHÔNG nhân bản:
   *   5. Redis GET (đường tắt, được phép sai — BB-2)
   *   6. Transaction: raw_events ACCEPTED + outbox `event.received` (Postgres là trọng tài: unique -> trùng)
   *   7. SAU COMMIT mới SET NX Redis (BB-3: chưa COMMIT thì chưa có gì để nhớ)
   */
  async persistAccepted(
    source: { id: string; tenantId: string },
    req: RawWebhookRequest,
    idempotencyKey: string,
    correlationId: string,
    stored: { headers: Record<string, unknown>; signatureHeader: string | null; origin?: 'webhook' | 'api' },
  ): Promise<PersistResult> {
    const log = logger.child({ correlationId, provider: req.provider, sourceId: source.id });
    const redisIdemKey = `idem:${source.id}:${idempotencyKey}`;
    if (await this.redis.getIdempotencyKey(redisIdemKey)) {
      log.info({ idempotencyKey }, 'Chống trùng lớp 1 (Redis Cache Hit): đã nhận trước đó');
      this.duplicates.record(source.tenantId, source.id);
      return { kind: 'duplicate' };
    }

    let rawEventRecord;
    try {
      // AU6: RLS — raw_events/outbox ghi trong transaction đã đặt app.project_id của source (tenant đã biết từ bước 2).
      rawEventRecord = await this.prisma.tenantTx(source.tenantId, async (tx) => {
        const rawEvent = await tx.rawEvent.create({
          data: {
            sourceId: source.id,
            idempotencyKey,
            headers: stored.headers as any,
            body: typeof req.body === 'object' && req.body !== null ? req.body : {},
            bodyRaw: new Uint8Array(req.rawBody),
            contentType: req.contentType,
            signatureHeader: stored.signatureHeader,
            signatureValid: true,
            status: 'ACCEPTED',
            origin: stored.origin ?? 'webhook', // MS-R6: /events = 'api'
          },
        });
        // Transactional outbox trong CÙNG transaction
        const outboxPayload: OutboxPayload = {
          rawEventId: rawEvent.id,
          sourceId: source.id,
          tenantId: source.tenantId,
          provider: req.provider,
          correlationId,
        };
        await tx.outbox.create({ data: { topic: 'event.received', payload: outboxPayload as any } });
        return rawEvent;
      });
    } catch (error: any) {
      // UNIQUE(source_id, idempotency_key): PostgreSQL là trọng tài
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        log.info({ idempotencyKey }, 'Chống trùng lớp 2 (PostgreSQL Unique Violation): bỏ qua bản trùng');
        this.duplicates.record(source.tenantId, source.id);
        return { kind: 'duplicate' };
      }
      log.error({ err: error.message }, 'Lỗi transaction khi lưu raw_event và outbox');
      return { kind: 'error' };
    }

    // Sau khi COMMIT thành công: cập nhật đường tắt Redis (BB-3)
    await this.redis.setIdempotencyKey(redisIdemKey, rawEventRecord.id, 86400);
    log.info({ rawEventId: rawEventRecord.id }, 'Đã tiếp nhận và commit thành công vào Outbox');
    return { kind: 'accepted', rawEventId: rawEventRecord.id };
  }

  /** Kết quả persistAccepted -> ACK đúng định dạng của adapter (provider hoặc API). */
  private ackFor(
    adapter: { buildAck(r: IngestResult): { status: number; body: unknown } },
    r: PersistResult,
    idempotencyKey: string,
    trace: TraceState,
  ): { status: number; body: unknown } {
    if (r.kind === 'duplicate') {
      trace.outcome = 'DUPLICATE';
      return adapter.buildAck({ accepted: true, status: 200, isDuplicate: true, idempotencyKey });
    }
    if (r.kind === 'error') {
      trace.outcome = 'ERROR';
      return { status: 500, body: { error: 'Lỗi máy chủ nội bộ khi lưu sự kiện' } };
    }
    trace.outcome = 'ACCEPTED';
    trace.rawEventId = r.rawEventId;
    return adapter.buildAck({ accepted: true, status: 200, rawEventId: r.rawEventId, idempotencyKey, isDuplicate: false });
  }

  /**
   * S3-4: đếm trong bộ nhớ (0 lệnh Redis). Nhãn `provider` chỉ nhận provider ĐÃ ĐĂNG KÝ — path
   * `/hooks/:provider` do client gửi, để nguyên thì kẻ xấu làm nổ số chuỗi thời gian (cardinality).
   */
  private recordMetrics(provider: string, trace: TraceState, status: number, startedAt: number) {
    try {
      const label = providerMetricLabel(provider);
      const outcome = trace.outcome ?? (trace.blocked ? 'BLOCKED' : status === 404 ? 'NOT_FOUND' : status === 413 ? 'TOO_LARGE' : 'INVALID');
      ingestRequests.inc({ provider: label, outcome });
      ingestDuration.observe({ provider: label }, (Date.now() - startedAt) / 1000);
    } catch {
      /* metric không bao giờ làm hỏng ingest */
    }
  }

  private async ingestCore(req: RawWebhookRequest, trace: TraceState): Promise<IngestResponse> {
    const correlationId = trace.correlationId;
    const log = logger.child({
      correlationId,
      provider: req.provider,
      sourceKey: req.sourceKey,
    });

    // 0. EG2 luật (a): IP đang bị phạt vì dò sourceKey -> chặn TRƯỚC khi chạm Postgres (0 Redis, 0 DB).
    this.countPrivateIp(req.ip);
    // Cặp (ip, sourceKey) đã verify đúng gần đây vẫn đi tiếp (IP chung của provider không cắt source đang chạy).
    const ipVerdict = this.penaltySafe(() => this.penalty.checkIp(req.ip, req.sourceKey), { blocked: false } as PenaltyVerdict);
    if (ipVerdict.blocked) {
      trace.blocked = true;
      return blockedAck(ipVerdict.retryAfterSec, req.headers, trace.correlationId);
    }

    // 1. Kiểm tra kích thước payload <= 1MB
    if (req.rawBody.length > MAX_INGEST_PAYLOAD_BYTES) {
      log.warn('Payload vượt quá giới hạn 1MB');
      return { status: 413, body: { error: 'Payload quá lớn (tối đa 1MB)' } };
    }

    // Nạp adapter
    let adapter;
    try {
      adapter = ProviderRegistry.get(req.provider);
    } catch (err: any) {
      log.error({ err: err.message }, 'Không tìm thấy adapter cho provider');
      return { status: 400, body: { error: err.message } };
    }

    // 2. Nạp source và secrets từ DB — đây là bước XÁC ĐỊNH tenant (tenant chưa
    // biết tới khi tìm ra source qua sourceKey), nên KHÔNG đi qua
    // TenantScopedRepository (repo đòi tenantId sẵn có). Dùng escape hatch riêng
    // trên PrismaService thay vì gọi thẳng model — BB-5 vẫn giữ nguyên vì đây là
    // điểm duy nhất được phép truy vấn `source` không scope.
    const source = await this.prisma.findSourceBySourceKeyForIngest(req.sourceKey);

    // ADR-161: source đã lưu trữ bị từ chối y như source tắt — cùng 404, không lộ khác biệt.
    if (!source || !source.isActive || source.archivedAt) {
      log.warn('Source không tồn tại hoặc đã bị vô hiệu hóa');
      // EG2 luật (a): CHỈ 404 do không tìm thấy source mới tính điểm. Source tắt/đã lưu trữ thì không (provider thật
      // vẫn gửi vào source đã "Xoá" — đếm nó là khoá IP của GitHub/PayOS cho mọi tenant).
      if (!source) {
        try {
          unknownSourceTotal.inc();
        } catch {
          /* metric không làm hỏng ingest */
        }
        this.penaltySafe(() => this.penalty.recordUnknownSource(req.ip), undefined);
      }
      return { status: 404, body: { error: 'Source webhook không hợp lệ hoặc đã tắt' } };
    }
    trace.tenantId = source.tenantId;
    trace.sourceId = source.id;

    // 2a. EG2 luật (b): cặp (IP, sourceKey) đang bị phạt vì ký sai liên tục -> chặn trước verify (0 HMAC, 0 Redis).
    const pairVerdict = this.penaltySafe(() => this.penalty.checkPair(req.ip, req.sourceKey), { blocked: false } as PenaltyVerdict);
    if (pairVerdict.blocked) {
      trace.blocked = true;
      return blockedAck(pairVerdict.retryAfterSec, req.headers, trace.correlationId);
    }

    // Giải mã danh sách secrets còn hiệu lực
    const masterKey = getMasterKey();
    const decryptedSecrets = source.secrets.map((s) => {
      try {
        return aesGcmDecrypt(s.secretEncrypted, masterKey);
      } catch (e) {
        log.error({ secretId: s.id }, 'Không thể giải mã secret của source');
        return '';
      }
    }).filter(Boolean);

    // S8: cấu hình riêng của source (GenericAdapter) — lõi chỉ chuyển qua, KHÔNG đọc, không `if (provider)`.
    const ctx: AdapterContext = { verificationConfig: (source as { verificationConfig?: unknown }).verificationConfig ?? undefined };

    // 3. Adapter xác thực chữ ký (verify)
    const isSignatureValid = await adapter.verify(req, decryptedSecrets, ctx);
    // ADR-051: verify đã xong -> từ đây chỉ lưu bản headers ĐÃ che (Authorization/Cookie/X-API-Key...), cộng
    // header bí mật theo cấu hình source mà adapter khai (S8: token static ở header tuỳ chọn).
    // `req.headers` gốc vẫn còn cho adapter (extractIdempotencyKey/buildAck); bodyRaw giữ nguyên bytes.
    const storedHeaders = redactHeaders(req.headers as Record<string, unknown>, adapter.sensitiveHeaders?.(ctx) ?? []);
    // S3-1: adapter tự biết chữ ký của mình ở đâu (header GitHub/Stripe, body PayOS, SePay đã che).
    // Lõi không đoán header -> thêm provider không phải sửa dòng này.
    const signatureHeader = adapter.extractSignature(req, ctx);
    if (!isSignatureValid) {
      log.warn('Chữ ký webhook không hợp lệ! Lưu raw_event với status REJECTED');
      // Lưu MẪU request lỗi để điều tra (§7.1) — có giới hạn (S1-4): tối đa 4KB body và
      // 20 bản ghi/phút/source. Vượt trần vẫn trả 401, chỉ không ghi DB.
      await this.storeRejected(source, req, storedHeaders, signatureHeader, false, correlationId, log);
      trace.outcome = 'REJECTED';
      // EG2 luật (b): phạt theo CẶP (ip, sourceKey) — tenant khác dùng chung IP của provider không bị vạ lây.
      this.penaltySafe(() => this.penalty.recordBadSignature(req.ip, req.sourceKey, { tenantId: source.tenantId, sourceId: source.id }), undefined);
      return rejectAck(adapter, 401, 'Chữ ký webhook không hợp lệ (Unauthorized)', log);
    }

    // 3c. EG3 (ADR-178): rate limit theo source chạy SAU verify — chỉ request ký đúng mới tiêu hạn mức. Kẻ biết một
    // sourceKey thật bắn chữ ký sai không còn khoá được webhook thật của nạn nhân. Cửa sổ cố định 60s, 1 EVAL INCR+EXPIRE,
    // trần `INGEST_RATE_LIMIT_PER_MIN` (S3-4, mặc định 100/phút/source). Redis chết -> fail-open.
    const allowed = await this.redis.checkRateLimit(`rate:source:${source.id}`, ingestRateLimitPerMin(), 60);
    if (!allowed) {
      log.warn('Bị chặn bởi Rate Limit theo Source');
      trace.outcome = 'RATE_LIMITED';
      return { status: 429, body: { error: 'Vượt quá tần suất cho phép (Rate limit)' } };
    }
    // EG2 (đính chính ADR-177): ký đúng VÀ qua rate limit -> nhớ "cặp tốt" (bộ nhớ, 0 I/O). Request bị 429 không được tính.
    this.penaltySafe(() => this.penalty.markGood(req.ip, req.sourceKey, source.tenantId), undefined);

    // 4. Trích xuất Idempotency Key, rồi bước 5–7 qua lõi dùng chung (S4)
    let idempotencyKey: string;
    try {
      idempotencyKey = adapter.extractIdempotencyKey(req, ctx);
    } catch (err) {
      if (!(err instanceof IdempotencyKeyMissingError)) throw err;
      // S8: lỗi CHUNG — chữ ký đúng nhưng không có khoá chống trùng. KHÔNG fallback ulid (gửi lại = 2 sự kiện).
      // Lưu REJECTED (signature_valid = true) để chế độ lắng nghe chẩn đoán được; trả 422.
      log.warn({ where: err.where }, 'Thiếu khoá chống trùng -> REJECTED 422');
      await this.storeRejected(source, req, storedHeaders, signatureHeader, true, correlationId, log);
      trace.outcome = 'REJECTED';
      return rejectAck(adapter, 422, 'missing_idempotency_key', log);
    }
    const persisted = await this.persistAccepted(source, req, idempotencyKey, correlationId, {
      headers: storedHeaders as Record<string, unknown>,
      signatureHeader,
    });
    // 8. ACK theo định dạng của provider
    return this.ackFor(adapter, persisted, idempotencyKey, trace);
  }

  /** EG4: cộng một request vào lưu lượng trong bộ nhớ (không I/O). Lỗi -> bỏ qua (số liệu quan sát). */
  private recordTraffic(req: RawWebhookRequest, trace: TraceState): void {
    if (!trace.tenantId || !trace.sourceId) return; // 404 sourceKey lạ: không thuộc tenant nào -> chỉ metric + log
    const outcome: TrafficOutcome | null = trace.blocked ? 'BLOCKED' : trace.outcome && TRAFFIC_OUTCOMES.has(trace.outcome) ? (trace.outcome as TrafficOutcome) : null;
    if (!outcome) return;
    try {
      this.traffic.record(trace.tenantId, trace.sourceId, outcome, req.ip);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Không ghi được lưu lượng vào bộ nhớ (bỏ qua)');
    }
  }

  /**
   * D9: IP loopback/private/dùng chung -> hộp phạt không chấm điểm. Đếm MỘT lần mỗi request (không phải mỗi lần hộp phạt
   * nhìn IP) vào `hub_ingest_penalty_skipped_private_total`; production hoặc TRUST_PROXY=1 thì log warn ≤ 1 lần/giờ.
   */
  private countPrivateIp(ip: string | undefined): void {
    try {
      if (!this.penaltyEnabled || !isLocalOrPrivateIp(ip)) return;
      penaltySkippedPrivate.inc();
      if ((process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === '1') && Date.now() - this.lastPrivateLog > 3_600_000) {
        this.lastPrivateLog = Date.now();
        logger.warn('Hộp phạt: /hooks nhận request từ IP loopback/private -> KHÔNG chấm điểm. Kiểm cấu hình IP thật (TRUST_PROXY, proxy/edge)');
      }
    } catch {
      /* metric không làm hỏng ingest */
    }
  }

  /** EG2: hộp phạt lỗi thì cho request đi qua như chưa có hộp phạt (fail-open) — chỉ log. */
  private penaltySafe<T>(fn: () => T, fallback: T): T {
    let r: T;
    try {
      r = fn();
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Hộp phạt lỗi -> cho request đi qua (fail-open)');
      return fallback;
    }
    // Metric tách khỏi `try` trên: lỗi metric không được lật kết luận `blocked` thành "cho qua".
    try {
      penaltyEntries.set(this.penalty.size());
      penaltyGoodEntries.set(this.penalty.goodSize());
    } catch {
      /* bỏ qua */
    }
    return r;
  }

  /** Mẫu request bị từ chối (§7.1, S1-4): ≤4KB body, ≤20 bản ghi/phút/source; vượt trần chỉ log. */
  private async storeRejected(
    source: { id: string; tenantId: string },
    req: RawWebhookRequest,
    storedHeaders: Record<string, unknown>,
    signatureHeader: string | null,
    signatureValid: boolean,
    correlationId: string,
    log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
  ): Promise<void> {
    const sourceId = source.id;
    if (!this.rejectedLimiter.tryAcquire(sourceId)) {
      log.warn({ sourceId }, 'Vượt trần 20 bản ghi REJECTED/phút cho source này -> không lưu raw_event, chỉ log');
      return;
    }
    const sample = sampleRejectedBody(req.rawBody, req.body);
    try {
      // AU6: raw_events có RLS (theo source) -> ghi trong transaction của đúng project.
      await this.prisma.tenantTx(source.tenantId, (tx) => tx.rawEvent.create({
        data: {
          sourceId,
          idempotencyKey: `rejected_${correlationId}`,
          headers: { ...(storedHeaders as any), [REJECTED_META_KEY]: sample.meta },
          body: sample.body as any,
          bodyRaw: new Uint8Array(sample.bodyRaw),
          contentType: req.contentType,
          signatureHeader,
          signatureValid,
          status: 'REJECTED',
          origin: 'webhook',
        },
      }));
    } catch (err) {
      log.error({ err }, 'Lỗi khi lưu rejected raw_event');
    }
  }
}

export type PersistResult = { kind: 'accepted'; rawEventId: string } | { kind: 'duplicate' } | { kind: 'error' };

/** Trần request/phút/source (mặc định 100). Giá trị không hợp lệ -> 100. */
export function ingestRateLimitPerMin(v: string | undefined = process.env.INGEST_RATE_LIMIT_PER_MIN): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 100;
}
