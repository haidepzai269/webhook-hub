import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService, getMasterKey } from '@hub/database';
import { RedisService } from '../redis/redis.service';
import { AdapterContext, HandshakeOutcome, IdempotencyKeyMissingError, ProviderAdapter, ProviderRegistry, VerifyRefusal, verdictOf } from '@hub/providers';
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
  STORAGE_LEVELS,
  isWriteBlocked,
  parseStorageLevel,
  resolveStorageLockEnabled,
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
  storageRejectedTotal,
  storageWouldRejectTotal,
  trafficFlushDropped,
  unknownSourceTotal,
} from '../metrics/metrics';
import { DuplicateCounter } from './duplicate-counter';
import { PenaltyBox, PenaltyVerdict, isLocalOrPrivateIp, resolvePenaltyConfig } from './penalty-box';
import { createPenaltyBox } from './penalty-provider';
import { IngestResponse, blockedAck, providerMetricLabel, storageFullAck } from './blocked-ack';
import { TrafficOutcome, TrafficRecorder } from './traffic-recorder';
import { onShutdownFlush } from '../../shutdown';
import { publicIngestBase } from '../console/public-ingest-base';
import { CatchnetMode, catchnetVia } from './catchnet';
import { HubOutcome } from './hub-outcome';

export type { IngestResponse } from './blocked-ack';

/**
 * LH3 (H3/H5, ADR-217): request đi qua lưới hứng — CHỈ khi chữ ký đầu của lưới hợp lệ (controller kiểm). `receivedAt` CHỈ
 * có khi chữ ký body cũng khớp: làm "bây giờ" khi verify (`ctx.verifyAt`) và làm `raw_events.received_at`.
 */
export interface IngestOptions {
  catchnet?: { mode: CatchnetMode; receivedAt?: Date };
}

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
  /** QT E2 (ADR-183): byte THỰC SỰ ghi xuống DB bởi request này (body_raw khi ACCEPTED, mẫu ≤4KB khi REJECTED có lưu). */
  bytes?: number;
  /** QT3 (ADR-182): bị 507 vì project đầy — tenant đã biết, không phát trace, lưu lượng outcome STORAGE_FULL (bytes 0). */
  storageFull?: boolean;
  /** ADR-205 bổ sung: HEAD `head-ok` trả 200 rỗng — chỉ metric `HEAD_OK`, không lưu lượng, không trace. */
  headOk?: boolean;
  /** LH3 (H1): đã trả lời bắt tay (outcome REJECTED cho lưu lượng — E8 — nhưng `x-hub-outcome: handshake`). */
  handshake?: boolean;
  /** LH3 (H1): adapter từ chối vì chính sách (cờ unverified tắt, 413 unverified) — `refused`, không phải chữ ký sai. */
  refused?: boolean;
}

/**
 * LH3 (H1, ADR-221): `x-hub-outcome` của một phản hồi `/hooks` — MỘT chỗ suy từ trạng thái trace (mọi nhánh của ingestCore
 * đã ghi vào trace). Nhánh không ghi gì (404, 400, 405, 413, 414…) -> theo status: ≥ 500 `unavailable`, còn lại `rejected`.
 */
export function outcomeOf(
  trace: Pick<TraceState, 'outcome' | 'blocked' | 'storageFull' | 'headOk' | 'handshake' | 'refused'>,
  status: number,
): HubOutcome {
  if (trace.blocked || trace.storageFull || trace.refused) return 'refused';
  if (trace.headOk || trace.handshake) return 'handshake';
  switch (trace.outcome) {
    case 'ACCEPTED':
      return 'accepted';
    case 'DUPLICATE':
      return 'duplicate';
    case 'REJECTED':
      return 'rejected';
    case 'RATE_LIMITED':
      return 'refused';
    case 'ERROR':
      return 'unavailable';
    default:
      return status >= 500 ? 'unavailable' : 'rejected';
  }
}

/** EG4: outcome của trace -> outcome của bảng lưu lượng (ERROR không lưu — đã có metric + log). */
const TRAFFIC_OUTCOMES = new Set<string>(['ACCEPTED', 'DUPLICATE', 'REJECTED', 'RATE_LIMITED']);

/**
 * PK4 (§6.3, ADR-205): mã từ chối chữ ký mà adapter được chọn (`ack.rejectStatus`). KHÔNG BAO GIỜ 2xx: 2xx cho request sai
 * chữ ký là lối vòng qua EG2 (BB-3). Lõi kẹp, không tin adapter.
 */
const SIGNATURE_REJECT_STATUSES: ReadonlySet<number> = new Set([401, 403, 503]);
/** PK4: mã thành công adapter được chọn (`ack.successStatus`). Ngoài tập -> 200. */
const SUCCESS_STATUSES: ReadonlySet<number> = new Set([200, 202, 204]);
/** PK4 (E27): trần chuỗi query ở ingest (nginx giữ mặc định). */
export const MAX_INGEST_QUERY_CHARS = 8 * 1024;

/**
 * ADR-139 (Q1 = a): ack TỪ CHỐI (401 chữ ký / 422 thiếu khoá chống trùng) theo định dạng của CHÍNH provider
 * (`adapter.buildAck`) — GenericAdapter kèm `fix` cho dev đang cấu hình nguồn. STATUS do lõi quyết: 422 giữ nguyên; 401
 * chỉ được adapter đổi thành 403/503 (PK4 `rejectStatus`, ADR-205) — không bao giờ 2xx. `message` là hằng của lõi — không
 * bao giờ chứa secret hay body request. Hàm thuần, không I/O: không thêm gì vào đường nóng. buildAck lỗi -> body cũ.
 */
function rejectAck(
  adapter: { buildAck(r: IngestResult, ctx?: AdapterContext): { status: number; body: unknown } },
  status: 401 | 422,
  message: string,
  log: { warn: (o: unknown, m?: string) => void },
  ctx?: AdapterContext,
): { status: number; body: unknown } {
  try {
    const ack = adapter.buildAck({ accepted: false, status, message }, ctx);
    const final = status === 401 && SIGNATURE_REJECT_STATUSES.has(ack.status) ? ack.status : status;
    return { status: final, body: ack.body };
  } catch (err: any) {
    log.warn({ err: err?.message }, 'buildAck lỗi khi dựng ack từ chối -> dùng body mặc định');
    return { status, body: { error: message } };
  }
}

/** PK4: 405 cho method adapter không nhận (GET ngoài `query-echo`, HEAD không khai `head-ok` — E27). Không ghi DB, không phạt. */
const METHOD_NOT_ALLOWED: IngestResponse = { status: 405, body: { error: 'method_not_allowed' } };
/** Review PK4 T-2: trần dòng bắt tay ghi DB / phút / source (trong bộ nhớ, như S1-4). */
export const HANDSHAKE_ROWS_PER_MINUTE = 5;

@Injectable()
export class IngestService implements OnModuleInit, OnModuleDestroy {
  /** S1-4: trần 20 bản ghi REJECTED/phút/source, trong bộ nhớ (không tốn Redis). */
  private readonly rejectedLimiter = new RejectedRecordLimiter();
  /**
   * Review PK4 T-2: dòng bắt tay không bị phạt (provider thật bắt tay lặp lại) nên trần RIÊNG, chặt hơn — 5 dòng/phút/source,
   * và chỉ lưu meta (không body). Vượt trần vẫn trả lời bắt tay, chỉ không ghi DB.
   */
  private readonly handshakeLimiter = new RejectedRecordLimiter(HANDSHAKE_ROWS_PER_MINUTE);
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
   * QT E5 (ADR-189): `STORAGE_LOCK_ENABLED` đọc MỘT lần lúc khởi động (đổi = đổi env + restart). Tắt (mặc định production):
   * vẫn đo, vẫn đổi nấc, KHÔNG trả 507 — chỉ đếm `hub_ingest_storage_would_reject_total`. Gán lại được (test).
   */
  storageLockEnabled = resolveStorageLockEnabled();
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

  async ingestWebhook(req: RawWebhookRequest, opts: IngestOptions = {}): Promise<IngestResponse> {
    let seen: TraceState | undefined;
    const result = await this.traced(req, (trace) => {
      seen = trace;
      return this.ingestCore(req, trace, opts);
    });
    return { ...result, outcome: outcomeOf(seen ?? {}, result.status) };
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
      // QT3 (E4): nấc dung lượng JOIN vào chính câu nạp source (+0 lượt DB).
      const source = await this.prisma.forTenant(tenantId).findSourceById(sourceId, { withStorageLevel: true });
      // ADR-161: source đã lưu trữ ("Xoá" trên bản đồ) bị từ chối y như source tắt (lưu trữ luôn kèm is_active=false).
      if (!source || !source.isActive || source.archivedAt) {
        log.warn('Source api của key không tồn tại hoặc đã tắt');
        return { status: 409, body: { error: 'source_inactive' } };
      }
      trace.tenantId = source.tenantId;
      trace.sourceId = source.id;
      // QT3 (E4): khoá chiều ghi SAU nạp source, TRƯỚC rate limit — project đầy không tốn EVAL.
      if (this.storageBlocked(source, 'publish', log)) {
        trace.storageFull = true;
        return { status: 507, body: { error: 'project_storage_full' } };
      }
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
    /**
     * PK5 (E5, ADR-206): `verified: false` = nhận KHÔNG xác thực (scheme `unverified`) -> `raw_events.verified=false`; normalize
     * chép sang `events.verified`. `signature_valid` vẫn true ("không sai chữ ký" — không mở cảnh báo signature_failing).
     */
    opts: { verified?: boolean } & IngestPath = {},
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
            verified: opts.verified !== false,
            status: 'ACCEPTED',
            origin: stored.origin ?? 'webhook', // MS-R6: /events = 'api'
            ...pathColumns(opts), // LH3 (H5): via + received_at của lưới; gọi thẳng -> {}
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
    return { kind: 'accepted', rawEventId: rawEventRecord.id, bytes: req.rawBody.length };
  }

  /** Kết quả persistAccepted -> ACK đúng định dạng của adapter (provider hoặc API). */
  private ackFor(
    adapter: { buildAck(r: IngestResult, ctx?: AdapterContext): { status: number; body: unknown } },
    r: PersistResult,
    idempotencyKey: string,
    trace: TraceState,
    ctx?: AdapterContext,
  ): { status: number; body: unknown } {
    // PK4: 2xx chỉ SAU COMMIT (BB-3 — hàm này chỉ chạy sau persistAccepted); mã ngoài 200/202/204 -> 200.
    const ok = (a: { status: number; body: unknown }) => (SUCCESS_STATUSES.has(a.status) ? a : { status: 200, body: a.body });
    if (r.kind === 'duplicate') {
      trace.outcome = 'DUPLICATE';
      return ok(adapter.buildAck({ accepted: true, status: 200, isDuplicate: true, idempotencyKey }, ctx));
    }
    if (r.kind === 'error') {
      trace.outcome = 'ERROR';
      return { status: 500, body: { error: 'Lỗi máy chủ nội bộ khi lưu sự kiện' } };
    }
    trace.outcome = 'ACCEPTED';
    trace.rawEventId = r.rawEventId;
    trace.bytes = r.bytes; // QT E2: = octet_length(body_raw) vừa COMMIT
    return ok(adapter.buildAck({ accepted: true, status: 200, rawEventId: r.rawEventId, idempotencyKey, isDuplicate: false }, ctx));
  }

  /** PK4: hỏi adapter có phải bắt tay không. Adapter ném -> coi như không phải (log), request đi tiếp đường thường. */
  private runHandshake(
    adapter: ProviderAdapter,
    req: RawWebhookRequest,
    secrets: string[],
    ctx: AdapterContext,
    phase: 'before-verify' | 'after-verify',
    log: { warn: (o: object, m: string) => void },
  ): HandshakeOutcome | null {
    if (!adapter.handshake) return null;
    try {
      return adapter.handshake(req, secrets, ctx, phase);
    } catch (err: any) {
      log.warn({ err: err?.message, phase }, 'handshake của adapter lỗi -> coi như không phải bắt tay');
      return null;
    }
  }

  /**
   * PK4 (§6.1, E8): trả lời bắt tay. `respond` -> ghi MỘT dòng REJECTED `signature_valid=true` + `__hub_meta.reason=
   * 'handshake'` (đường `storeRejected` sẵn có: ≤4KB, ≤20/phút/source) để tab Lắng nghe hiện "Đã bắt tay ✓"; EG4 outcome
   * REJECTED (không thêm enum, E8). Không event, không outbox, không SET NX, không EG3. `invalid` -> 400, không ghi DB.
   */
  private async answerHandshake(
    h: Exclude<HandshakeOutcome, { kind: 'reject' }>,
    source: { id: string; tenantId: string },
    req: RawWebhookRequest,
    storedHeaders: Record<string, unknown>,
    signatureHeader: string | null,
    trace: TraceState,
    log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void; info: (o: object, m: string) => void },
    path: IngestPath = {},
  ): Promise<IngestResponse> {
    if (h.kind === 'invalid') {
      log.warn({ message: h.message }, 'Bắt tay không hợp lệ -> 400');
      return { status: 400, body: { error: 'handshake_invalid', message: h.message } };
    }
    // Lõi kẹp: bắt tay là phản hồi thành công của provider — chỉ 200/202/204.
    const status = SUCCESS_STATUSES.has(h.status) ? h.status : 200;
    // Review PK4 T-2: chỉ meta (không body, ≤ 1KB) + trần riêng 5/phút/source — dòng bắt tay không bị phạt nên phải rẻ.
    trace.bytes = await this.storeRejected(source, req, storedHeaders, signatureHeader, true, trace.correlationId, log, {
      meta: { reason: 'handshake', handshake: h.meta },
      metaOnly: true,
      path,
    });
    trace.outcome = 'REJECTED';
    trace.handshake = true;
    log.info({ kind: h.meta?.kind }, 'Đã trả lời bắt tay của provider');
    return {
      status,
      body: status === 204 ? null : h.body,
      ...(h.contentType ? { contentType: h.contentType } : {}),
      ...(h.headers ? { headers: h.headers } : {}),
    };
  }

  /**
   * S3-4: đếm trong bộ nhớ (0 lệnh Redis). Nhãn `provider` chỉ nhận provider ĐÃ ĐĂNG KÝ — path
   * `/hooks/:provider` do client gửi, để nguyên thì kẻ xấu làm nổ số chuỗi thời gian (cardinality).
   */
  private recordMetrics(provider: string, trace: TraceState, status: number, startedAt: number) {
    try {
      const label = providerMetricLabel(provider);
      const outcome = trace.outcome ?? (trace.headOk ? 'HEAD_OK' : trace.storageFull ? 'STORAGE_FULL' : trace.blocked ? 'BLOCKED' : status === 404 ? 'NOT_FOUND' : status === 413 ? 'TOO_LARGE' : 'INVALID');
      ingestRequests.inc({ provider: label, outcome });
      ingestDuration.observe({ provider: label }, (Date.now() - startedAt) / 1000);
    } catch {
      /* metric không bao giờ làm hỏng ingest */
    }
  }

  private async ingestCore(req: RawWebhookRequest, trace: TraceState, opts: IngestOptions = {}): Promise<IngestResponse> {
    const correlationId = trace.correlationId;
    // LH3 (H5, ADR-217): đường vào của request -> raw_events.via (+ received_at khi chữ ký body khớp). Gọi thẳng -> {}.
    const path: IngestPath = opts.catchnet ? { via: catchnetVia(opts.catchnet.mode), receivedAt: opts.catchnet.receivedAt } : {};
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
    // 1 (PK4, E27): trần chuỗi query 8KB — GET bắt tay đọc query; query khổng lồ không đi tiếp tới DB/adapter.
    if ((req.query ?? '').length > MAX_INGEST_QUERY_CHARS) {
      log.warn('Query vượt quá 8KB');
      return { status: 414, body: { error: 'uri_too_long', message: 'Query quá dài (tối đa 8KB)' } };
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
    // 2 (PK0, ADR-201): adapter chọn theo segment URL, source chọn theo sourceKey — hai giá trị phải khớp. Lệch = URL sai:
    // 404 CÙNG body với source không tồn tại (ADR-161), không cộng điểm phạt EG2 (URL sai của provider thật không được
    // khoá IP dùng chung). Đặt TRƯỚC `trace.tenantId`: 404 này không mang tenant, không vào lưu lượng. So hai giá trị,
    // không phải `if (provider === 'x')`.
    if (source.provider !== req.provider) {
      log.warn({ sourceProvider: source.provider }, 'Segment provider của URL không khớp provider của source -> 404');
      return { status: 404, body: { error: 'Source webhook không hợp lệ hoặc đã tắt' } };
    }
    // S8: cấu hình riêng của source (GenericAdapter) — lõi chỉ chuyển qua, KHÔNG đọc, không `if (provider)`.
    // PK4 (E13): `openSealed` mở giá trị adapter cần (token bắt tay mã hoá) — lõi không biết đó là gì.
    const masterKey = getMasterKey();
    const ctx: AdapterContext = {
      verificationConfig: (source as { verificationConfig?: unknown }).verificationConfig ?? undefined,
      openSealed: (enc) => {
        try {
          return aesGcmDecrypt(enc, masterKey);
        } catch {
          return null;
        }
      },
      // PK5 (E14): cờ project nạp CÙNG câu với source (+0 lượt DB). Lõi chỉ chuyển qua — adapter quyết (khoá 1).
      projectFlags: { allowUnverified: (source as { allowUnverified?: unknown }).allowUnverified === true },
      // PK5 (E6/E18): URL công khai của request, KHÔNG từ Host. Lười. LH3 (H4, ADR-217): theo ĐƯỜNG VÀO — qua lưới (chữ ký
      // lưới hợp lệ) -> base ingest (HUB_INGEST_PUBLIC_URL); gọi thẳng -> HUB_PUBLIC_URL (URL source cũ đã đăng ký, U-C).
      publicUrl: () => publicHooksUrl(req, process.env, opts.catchnet ? 'catchnet' : 'direct'),
      // LH3 (H3, ADR-217): giờ Worker nhận (đã ký, body khớp) làm "bây giờ" cho cửa sổ thời gian (Stripe, Standard Webhooks,
      // signed-template). Không có -> adapter dùng Date.now() như cũ.
      ...(opts.catchnet?.receivedAt ? { verifyAt: opts.catchnet.receivedAt } : {}),
    };
    // 2 (PK4, §6.2, E27): method. Không cài `acceptsMethod` = chỉ POST; HEAD chỉ khi adapter nhận (`head-ok`, ADR-205 bổ sung). 405 không ghi DB, không phạt, không vào
    // lưu lượng (đặt TRƯỚC `trace.tenantId`) — URL đúng mà sai method là lỗi cấu hình, không phải dò sourceKey.
    const method = req.method ?? 'POST';
    if (!(adapter.acceptsMethod ? adapter.acceptsMethod(method, ctx, req) : method === 'POST')) {
      log.warn({ method }, 'Method không được nhận ở source này -> 405');
      return METHOD_NOT_ALLOWED;
    }
    trace.tenantId = source.tenantId;
    trace.sourceId = source.id;

    // 2q. QT3 (SPEC-han-muc-dung-luong E1/E4, ADR-182/189): khoá chiều ghi khi project đầy. Nấc đã nạp CÙNG câu với source
    // (bước 2, +0 lượt DB); quyết định là hàm thuần (0 Redis, 0 HMAC). Áp như nhau cho mọi provider. 507 không phải 2xx —
    // BB-3 giữ, provider tự gửi lại. Đặt TRƯỚC hộp phạt theo cặp / verify / rate limit: project đầy không tốn HMAC, EVAL.
    if (this.storageBlocked(source, 'hooks', log)) {
      trace.storageFull = true;
      return storageFullAck(req.headers, trace.correlationId);
    }

    // 2a. EG2 luật (b): cặp (IP, sourceKey) đang bị phạt vì ký sai liên tục -> chặn trước verify (0 HMAC, 0 Redis).
    const pairVerdict = this.penaltySafe(() => this.penalty.checkPair(req.ip, req.sourceKey), { blocked: false } as PenaltyVerdict);
    if (pairVerdict.blocked) {
      trace.blocked = true;
      return blockedAck(pairVerdict.retryAfterSec, req.headers, trace.correlationId);
    }
    // 2a' (ADR-205 bổ sung, sửa E27): HEAD chỉ tới đây khi adapter nhận (`head-ok` — Intercom kiểm URL bằng HEAD). Đã qua hộp
    // phạt, checkIp, PK0, QT3, checkPair -> 200 rỗng. KHÔNG giải mã secret, không verify, không ghi DB, không phạt, 0 Redis;
    // không vào lưu lượng / trace (không có outcome). HEAD không bao giờ đi tiếp tới verify / persist.
    if (method === 'HEAD') {
      trace.headOk = true;
      return { status: 200, body: null };
    }

    // Giải mã danh sách secrets còn hiệu lực
    const decryptedSecrets = source.secrets.map((s) => {
      try {
        return aesGcmDecrypt(s.secretEncrypted, masterKey);
      } catch (e) {
        log.error({ secretId: s.id }, 'Không thể giải mã secret của source');
        return '';
      }
    }).filter(Boolean);

    // ADR-051: chỉ lưu bản headers ĐÃ che (Authorization/Cookie/X-API-Key...), cộng header bí mật theo cấu hình source mà
    // adapter khai (S8: token static ở header tuỳ chọn). `req.headers` gốc vẫn còn cho adapter (extractIdempotencyKey/
    // buildAck); bodyRaw giữ nguyên bytes. PK4: tính TRƯỚC bắt tay (dòng `handshake` cũng chỉ lưu bản đã che).
    const storedHeaders = redactHeaders(req.headers as Record<string, unknown>, adapter.sensitiveHeaders?.(ctx) ?? []);
    // S3-1: adapter tự biết chữ ký của mình ở đâu (header GitHub/Stripe, body PayOS, SePay đã che).
    // Lõi không đoán header -> thêm provider không phải sửa dòng này.
    const signatureHeader = adapter.extractSignature(req, ctx);
    const rejectSignature = async (): Promise<IngestResponse> => {
      log.warn('Chữ ký webhook không hợp lệ! Lưu raw_event với status REJECTED');
      // Lưu MẪU request lỗi để điều tra (§7.1) — có giới hạn (S1-4): tối đa 4KB body và
      // 20 bản ghi/phút/source. Vượt trần vẫn trả 401, chỉ không ghi DB.
      trace.bytes = await this.storeRejected(source, req, storedHeaders, signatureHeader, false, correlationId, log, { path });
      trace.outcome = 'REJECTED';
      // EG2 luật (b): phạt theo CẶP (ip, sourceKey) — tenant khác dùng chung IP của provider không bị vạ lây.
      // PK4 (E21): `rejectStatus: 503` vẫn phạt — mã HTTP đổi, luật phạt thì không.
      this.penaltySafe(() => this.penalty.recordBadSignature(req.ip, req.sourceKey, { tenantId: source.tenantId, sourceId: source.id }), undefined);
      return rejectAck(adapter, 401, 'Chữ ký webhook không hợp lệ (Unauthorized)', log, ctx);
    };

    // 2h (PK4, E9): bắt tay query/body/header-echo, manual-url — TRƯỚC verify, KHÔNG qua EG3, 0 lệnh Redis, không outbox,
    // không SET NX. Ghi MỘT dòng REJECTED `signature_valid=true` + `__hub_meta.reason='handshake'` (E8).
    const before = this.runHandshake(adapter, req, decryptedSecrets, ctx, 'before-verify', log);
    if (before) return before.kind === 'reject' ? rejectSignature() : this.answerHandshake(before, source, req, storedHeaders, signatureHeader, trace, log, path);
    // GET chỉ để bắt tay (§6.2, §15): GET không phải bắt tay thì không bao giờ tới verify / persist.
    if (method !== 'POST') return METHOD_NOT_ALLOWED;

    // 3. Adapter xác thực chữ ký (verify). PK5 (E5): kết quả có thể là `{ok, verified}` — `verdictOf` chuẩn hoá.
    const verdict = verdictOf(await adapter.verify(req, decryptedSecrets, ctx));
    // PK5 (E14, E17): từ chối KHÔNG vì chữ ký sai (cờ project tắt, body quá trần) -> không lưu mẫu, không phạt, không lưu lượng.
    if (verdict.refusal) {
      trace.refused = true;
      return this.refuse(adapter, verdict.refusal, log, ctx);
    }
    if (!verdict.ok) return rejectSignature();

    // 3h (PK4, E3): hmac-echo CHỈ sau verify qua — kẻ biết sourceKey không xin được chữ ký hộ. Vẫn trước EG3, 0 lệnh Redis.
    const after = this.runHandshake(adapter, req, decryptedSecrets, ctx, 'after-verify', log);
    if (after) return after.kind === 'reject' ? rejectSignature() : this.answerHandshake(after, source, req, storedHeaders, signatureHeader, trace, log, path);

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
    // Review PK5 T-2: "cặp tốt" nghĩa là KÝ ĐÚNG — request `unverified` (không ai kiểm chữ ký) không được nâng ngưỡng phạt.
    if (verdict.verified) this.penaltySafe(() => this.penalty.markGood(req.ip, req.sourceKey, source.tenantId), undefined);

    // 4. Trích xuất Idempotency Key, rồi bước 5–7 qua lõi dùng chung (S4)
    let idempotencyKey: string;
    try {
      idempotencyKey = adapter.extractIdempotencyKey(req, ctx);
    } catch (err) {
      if (!(err instanceof IdempotencyKeyMissingError)) throw err;
      // S8: lỗi CHUNG — chữ ký đúng nhưng không có khoá chống trùng. KHÔNG fallback ulid (gửi lại = 2 sự kiện).
      // Lưu REJECTED (signature_valid = true) để chế độ lắng nghe chẩn đoán được; trả 422.
      log.warn({ where: err.where }, 'Thiếu khoá chống trùng -> REJECTED 422');
      trace.bytes = await this.storeRejected(source, req, storedHeaders, signatureHeader, true, correlationId, log, { path });
      trace.outcome = 'REJECTED';
      return rejectAck(adapter, 422, 'missing_idempotency_key', log, ctx);
    }
    // PK5 (E6): meta adapter dựng lúc nhận (vd URL công khai khi `forwardUrl`) -> `headers.__hub_meta` của raw ACCEPTED.
    const meta = this.storedMetaOf(adapter, req, ctx, log);
    const persisted = await this.persistAccepted(
      source,
      req,
      idempotencyKey,
      correlationId,
      { headers: meta ? { ...storedHeaders, [REJECTED_META_KEY]: meta } : storedHeaders, signatureHeader },
      { verified: verdict.verified, ...path },
    );
    // 8. ACK theo định dạng của provider (PK4: mã thành công theo `ack.successStatus`)
    return this.ackFor(adapter, persisted, idempotencyKey, trace, ctx);
  }

  /**
   * PK5 (E14, E17, ADR-206): adapter từ chối KHÔNG phải vì chữ ký sai — cờ project `allowUnverified` tắt (401 -> `rejectStatus`
   * của adapter, không bao giờ 2xx) hoặc body vượt trần của `unverified` (413). KHÔNG `storeRejected`, KHÔNG `recordBadSignature`
   * (kẻ biết sourceKey không làm bẩn cảnh báo / khoá IP của provider thật), không vào lưu lượng; metric outcome INVALID/TOO_LARGE.
   */
  private refuse(
    adapter: ProviderAdapter,
    refusal: VerifyRefusal,
    log: { warn: (o: unknown, m?: string) => void },
    ctx: AdapterContext,
  ): IngestResponse {
    log.warn({ error: refusal.error }, 'Adapter từ chối (không phải chữ ký sai) -> không lưu, không phạt');
    if (refusal.status === 401) return rejectAck(adapter, 401, refusal.error, log, ctx);
    return { status: 413, body: { error: refusal.error, message: 'Payload quá lớn cho nguồn chưa xác thực', fix: refusal.fix } };
  }

  /** PK5 (E6): meta adapter muốn lưu cùng raw ACCEPTED. Adapter ném -> không lưu meta (log), request vẫn được nhận. */
  private storedMetaOf(adapter: ProviderAdapter, req: RawWebhookRequest, ctx: AdapterContext, log: { warn: (o: object, m: string) => void }): Record<string, unknown> | null {
    if (!adapter.storedMeta) return null;
    try {
      return adapter.storedMeta(req, ctx);
    } catch (err: any) {
      log.warn({ err: err?.message }, 'storedMeta của adapter lỗi -> không lưu meta');
      return null;
    }
  }

  /** EG4: cộng một request vào lưu lượng trong bộ nhớ (không I/O). Lỗi -> bỏ qua (số liệu quan sát). */
  private recordTraffic(req: RawWebhookRequest, trace: TraceState): void {
    if (!trace.tenantId || !trace.sourceId) return; // 404 sourceKey lạ: không thuộc tenant nào -> chỉ metric + log
    const outcome: TrafficOutcome | null = trace.storageFull ? 'STORAGE_FULL' : trace.blocked ? 'BLOCKED' : trace.outcome && TRAFFIC_OUTCOMES.has(trace.outcome) ? (trace.outcome as TrafficOutcome) : null;
    if (!outcome) return;
    try {
      // QT E2: chỉ ACCEPTED / REJECTED có ghi mẫu mới mang byte; còn lại 0 (trùng, 429, chặn, 507).
      this.traffic.record(trace.tenantId, trace.sourceId, outcome, req.ip, trace.bytes ?? 0);
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

  /**
   * QT3 (E1/E4/E5, ADR-182/189): `true` = trả 507. Nấc đọc từ source đã nạp (`storageLevel`, JOIN cùng câu): null = chưa
   * đo = OK; giá trị lạ / lỗi đọc -> FAIL-OPEN (coi như OK) + log — hạn mức là chống lạm dụng, không phải bất biến đúng–sai.
   * "Giữ lâu" (`keepLonger`, cờ user TỰ gắn) còn nhận tới HARD_LOCKED. Cờ tắt -> chỉ đếm "lẽ ra chặn".
   */
  private storageBlocked(
    source: { keepLonger?: boolean | null; storageLevel?: unknown },
    path: 'hooks' | 'publish',
    log: { warn: (o: object, m: string) => void },
  ): boolean {
    let blocked: boolean;
    try {
      const raw = source.storageLevel;
      if (raw !== null && raw !== undefined && !(STORAGE_LEVELS as readonly unknown[]).includes(raw)) {
        log.warn({ storageLevel: String(raw).slice(0, 32) }, 'Nấc dung lượng không đọc được -> fail-open (coi như OK)');
      }
      blocked = isWriteBlocked(parseStorageLevel(raw), source.keepLonger === true, true);
    } catch (err: any) {
      log.warn({ err: err?.message }, 'Lỗi khi đọc nấc dung lượng -> fail-open (coi như OK)');
      return false;
    }
    if (!blocked) return false;
    try {
      (this.storageLockEnabled ? storageRejectedTotal : storageWouldRejectTotal).inc({ path });
    } catch {
      /* metric không làm hỏng ingest */
    }
    return this.storageLockEnabled;
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

  /**
   * Mẫu request bị từ chối (§7.1, S1-4): ≤4KB body, ≤20 bản ghi/phút/source; vượt trần chỉ log. Trả số byte body_raw đã
   * ghi (QT E2) — 0 khi vượt trần hoặc ghi lỗi.
   */
  private async storeRejected(
    source: { id: string; tenantId: string },
    req: RawWebhookRequest,
    storedHeaders: Record<string, unknown>,
    signatureHeader: string | null,
    signatureValid: boolean,
    correlationId: string,
    log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
    /**
     * PK4 (E8, E29): `meta.reason: 'handshake'` (+ `handshake`) — `countSignatureBySource` loại dòng có reason. `metaOnly`
     * (review PK4 T-2): không lưu body (bytes rỗng, body `{}`), trần riêng `HANDSHAKE_ROWS_PER_MINUTE`.
     */
    extra?: { meta?: Record<string, unknown>; metaOnly?: boolean; path?: IngestPath },
  ): Promise<number> {
    const sourceId = source.id;
    const limiter = extra?.metaOnly ? this.handshakeLimiter : this.rejectedLimiter;
    if (!limiter.tryAcquire(sourceId)) {
      log.warn({ sourceId, metaOnly: extra?.metaOnly === true }, 'Vượt trần bản ghi REJECTED/phút cho source này -> không lưu raw_event, chỉ log');
      return 0;
    }
    const sample = extra?.metaOnly
      ? { bodyRaw: Buffer.alloc(0), body: {}, meta: { bodyOmitted: true, originalBytes: req.rawBody.length } }
      : sampleRejectedBody(req.rawBody, req.body);
    try {
      // AU6: raw_events có RLS (theo source) -> ghi trong transaction của đúng project.
      await this.prisma.tenantTx(source.tenantId, (tx) => tx.rawEvent.create({
        data: {
          sourceId,
          idempotencyKey: `rejected_${correlationId}`,
          headers: { ...(storedHeaders as any), [REJECTED_META_KEY]: { ...sample.meta, ...(extra?.meta ?? {}) } },
          body: sample.body as any,
          bodyRaw: new Uint8Array(sample.bodyRaw),
          contentType: req.contentType,
          signatureHeader,
          signatureValid,
          status: 'REJECTED',
          origin: 'webhook',
          ...pathColumns(extra?.path),
        },
      }));
      return sample.bodyRaw.length;
    } catch (err) {
      log.error({ err }, 'Lỗi khi lưu rejected raw_event');
      return 0;
    }
  }
}

export type PersistResult = { kind: 'accepted'; rawEventId: string; bytes: number } | { kind: 'duplicate' } | { kind: 'error' };

/** LH3 (H5): đường vào của request — `raw_events.via` (+ `received_at` = giờ Worker khi chữ ký body khớp, §5.2). */
export interface IngestPath {
  via?: 'catchnet-forward' | 'catchnet-replay';
  receivedAt?: Date;
}

/** Cột raw_events theo đường vào. Gọi thẳng -> {} (via NULL, received_at = now() của DB như cũ). */
function pathColumns(p: IngestPath | undefined): { via?: string; receivedAt?: Date } {
  if (!p?.via) return {};
  return p.receivedAt ? { via: p.via, receivedAt: p.receivedAt } : { via: p.via };
}

/**
 * PK5 (E6/E18, ADR-206): URL công khai đầy đủ của request `/hooks` — base + path + query gốc. KHÔNG BAO GIỜ dựng từ `Host`
 * (giả được). Thuần. LH3 (H4, ADR-217; sửa REVIEW-LH-URL L1): base theo ĐƯỜNG VÀO của request —
 *   - `catchnet` (chữ ký lưới hợp lệ): base ingest `publicIngestBase` (`HUB_INGEST_PUBLIC_URL`, thiếu thì `HUB_PUBLIC_URL`);
 *   - `direct` (mặc định — gọi thẳng, hoặc header lưới sai chữ ký): `HUB_PUBLIC_URL`, URL mà source cũ đã đăng ký (U-C).
 * Provider ký trên URL (Twilio) tính chữ ký trên đúng URL nó đã gọi; dựng sai base là 401 oan.
 */
export function publicHooksUrl(
  req: Pick<RawWebhookRequest, 'provider' | 'sourceKey' | 'query'>,
  env: Record<string, string | undefined> = process.env,
  via: 'catchnet' | 'direct' = 'direct',
): string | null {
  const base = publicIngestBase(env, { route: via === 'catchnet' ? 'ingest' : 'direct' });
  if (!base) return null;
  const q = req.query ?? '';
  return `${base}/hooks/${req.provider}/${req.sourceKey}${q ? `?${q}` : ''}`;
}

/** Trần request/phút/source (mặc định 100). Giá trị không hợp lệ -> 100. */
export function ingestRateLimitPerMin(v: string | undefined = process.env.INGEST_RATE_LIMIT_PER_MIN): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 100;
}
