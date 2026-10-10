import { Inject, Injectable, Optional } from '@nestjs/common';
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
} from '@hub/common';
import { Prisma } from '@prisma/client';
import { REJECTED_META_KEY, RejectedRecordLimiter, sampleRejectedBody } from './rejected-sample';
import { redactHeaders } from './redact-headers';
import { ingestDuration, ingestRequests } from '../metrics/metrics';

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
}

@Injectable()
export class IngestService {
  /** S1-4: trần 20 bản ghi REJECTED/phút/source, trong bộ nhớ (không tốn Redis). */
  private readonly rejectedLimiter = new RejectedRecordLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() @Inject(TRACE_NOTIFIER) private readonly notifier?: TraceNotifier,
  ) {}

  async ingestWebhook(req: RawWebhookRequest): Promise<{ status: number; body: unknown }> {
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
      if (!source || !source.isActive) {
        log.warn('Source api của key không tồn tại hoặc đã tắt');
        return { status: 409, body: { error: 'source_inactive' } };
      }
      trace.tenantId = source.tenantId;
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
    run: (trace: TraceState) => Promise<{ status: number; body: unknown }>,
  ): Promise<{ status: number; body: unknown }> {
    const startedAt = Date.now();
    const trace: TraceState = { correlationId: generateCorrelationId() };
    const result = await run(trace);
    this.recordMetrics(req.provider, trace, result.status, startedAt);
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
      return { kind: 'duplicate' };
    }

    let rawEventRecord;
    try {
      rawEventRecord = await this.prisma.$transaction(async (tx) => {
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
      let label = 'unknown';
      try {
        label = ProviderRegistry.get(provider as ProviderType).provider;
      } catch {
        /* provider lạ -> 'unknown' */
      }
      const outcome = trace.outcome ?? (status === 404 ? 'NOT_FOUND' : status === 413 ? 'TOO_LARGE' : 'INVALID');
      ingestRequests.inc({ provider: label, outcome });
      ingestDuration.observe({ provider: label }, (Date.now() - startedAt) / 1000);
    } catch {
      /* metric không bao giờ làm hỏng ingest */
    }
  }

  private async ingestCore(req: RawWebhookRequest, trace: TraceState): Promise<{ status: number; body: unknown }> {
    const correlationId = trace.correlationId;
    const log = logger.child({
      correlationId,
      provider: req.provider,
      sourceKey: req.sourceKey,
    });

    // 1. Kiểm tra kích thước payload <= 1MB
    const MAX_PAYLOAD_BYTES = 1024 * 1024;
    if (req.rawBody.length > MAX_PAYLOAD_BYTES) {
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

    if (!source || !source.isActive) {
      log.warn('Source không tồn tại hoặc đã bị vô hiệu hóa');
      return { status: 404, body: { error: 'Source webhook không hợp lệ hoặc đã tắt' } };
    }
    trace.tenantId = source.tenantId;

    // 2b. Rate limit theo source (cửa sổ cố định 60s, INCR+EXPIRE)
    const rateLimitKey = `rate:source:${source.id}`;
    // S3-4: trần cấu hình được (`INGEST_RATE_LIMIT_PER_MIN`, mặc định 100/phút/source) — k6 cần nâng trần.
    const allowed = await this.redis.checkRateLimit(rateLimitKey, ingestRateLimitPerMin(), 60);
    if (!allowed) {
      log.warn('Bị chặn bởi Rate Limit theo Source');
      trace.outcome = 'RATE_LIMITED';
      return { status: 429, body: { error: 'Vượt quá tần suất cho phép (Rate limit)' } };
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
      await this.storeRejected(source.id, req, storedHeaders, signatureHeader, false, correlationId, log);
      trace.outcome = 'REJECTED';
      return { status: 401, body: { error: 'Chữ ký webhook không hợp lệ (Unauthorized)' } };
    }

    // 4. Trích xuất Idempotency Key, rồi bước 5–7 qua lõi dùng chung (S4)
    let idempotencyKey: string;
    try {
      idempotencyKey = adapter.extractIdempotencyKey(req, ctx);
    } catch (err) {
      if (!(err instanceof IdempotencyKeyMissingError)) throw err;
      // S8: lỗi CHUNG — chữ ký đúng nhưng không có khoá chống trùng. KHÔNG fallback ulid (gửi lại = 2 sự kiện).
      // Lưu REJECTED (signature_valid = true) để chế độ lắng nghe chẩn đoán được; trả 422.
      log.warn({ where: err.where }, 'Thiếu khoá chống trùng -> REJECTED 422');
      await this.storeRejected(source.id, req, storedHeaders, signatureHeader, true, correlationId, log);
      trace.outcome = 'REJECTED';
      return { status: 422, body: { error: 'missing_idempotency_key' } };
    }
    const persisted = await this.persistAccepted(source, req, idempotencyKey, correlationId, {
      headers: storedHeaders as Record<string, unknown>,
      signatureHeader,
    });
    // 8. ACK theo định dạng của provider
    return this.ackFor(adapter, persisted, idempotencyKey, trace);
  }

  /** Mẫu request bị từ chối (§7.1, S1-4): ≤4KB body, ≤20 bản ghi/phút/source; vượt trần chỉ log. */
  private async storeRejected(
    sourceId: string,
    req: RawWebhookRequest,
    storedHeaders: Record<string, unknown>,
    signatureHeader: string | null,
    signatureValid: boolean,
    correlationId: string,
    log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
  ): Promise<void> {
    if (!this.rejectedLimiter.tryAcquire(sourceId)) {
      log.warn({ sourceId }, 'Vượt trần 20 bản ghi REJECTED/phút cho source này -> không lưu raw_event, chỉ log');
      return;
    }
    const sample = sampleRejectedBody(req.rawBody, req.body);
    try {
      await this.prisma.rawEvent.create({
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
      });
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
