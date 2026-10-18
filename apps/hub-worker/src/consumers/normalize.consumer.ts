import { Inject, Injectable, Optional } from '@nestjs/common';
import { BACKPRESSURE_DB, FailureRateController } from '../backpressure/failure-rate.controller';
import { PrismaService, TenantScopedRepository } from '@hub/database';
import { ProviderRegistry } from '@hub/providers';
import { performance } from 'perf_hooks';
import { NORMALIZE_RETRY_TTL_MS, QUEUES, normalizeMaxDeferMs } from '@hub/messaging';
import {
  CanonicalLogger,
  CanonicalOutcome,
  Cause,
  Stage,
  TRACEPARENT_HEADER,
  computeQueueWait,
  errInfo,
  formatTraceparent,
  traceFromHeaders,
  logger,
  OutboxPayload,
  NormalizedEvent,
  buildDeliveryMessage,
  EventReceivedNotice,
  isHubOnlyType,
  isReservedType,
  validateCanonical,
  fastFailRedisOptions,
  LogThrottle,
} from '@hub/common';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import {
  NORMALIZE_MAX_RETRIES,
  NORMALIZE_RETRY_HEADER,
  classifyNormalizeError,
  readNormalizeRetryCount,
} from './normalize-errors';
import { normalizeDeferred, normalizeRetries, normalizeSchemaErrors } from '../metrics';

/** Ngữ cảnh một lần xử lý message normalize (log `normalize.done`, LOGGING.md §3). */
interface NormalizeRun {
  ctx: ReturnType<typeof traceFromHeaders>;
  t0: number;
  /** Chỉ có khi message mang `timestamp` AMQP (relay) hoặc `x-due-at` (tầng retry). */
  queueWaitMs?: number;
  clockSkew: boolean;
  outboxLagMs?: number;
  stages: Partial<Record<Stage, number>>;
  payload?: Partial<OutboxPayload>;
}

/** BP5 §7.4: mốc bắt đầu hoãn không đốt lượt của một raw event ở normalize (epoch ms). */
export const NORMALIZE_DEFERRED_SINCE_HEADER = 'x-normalize-deferred-since';
import { DELIVERY_REQUESTED_TOPIC, routeEventToSubscriptions } from './route-event';

/**
 * S3-2 (ADR-053): adapter phát kiểu thuộc không gian dành riêng (`payment.*`, `repo.*`) mà `data`
 * không qua validator catalog. Lỗi VĨNH VIỄN (ADR-044): không đẩy dữ liệu sai khuôn ra ngoài, không
 * âm thầm hạ xuống `normalized:false`. raw_event còn nguyên -> sửa adapter rồi renormalize.
 * `field` chỉ là TÊN trường, không bao giờ kèm giá trị.
 */
export class CanonicalSchemaError extends Error {
  constructor(readonly eventType: string, readonly field: string) {
    super(`Event kiểu '${eventType}' sai khuôn catalog ở trường '${field}'`);
    this.name = 'CanonicalSchemaError';
  }
}

/**
 * Chỗ DUY NHẤT lõi biết về catalog: kiểu dành riêng thì phải đúng khuôn. Không hỏi provider nào.
 * Ném `CanonicalSchemaError` ở event sai đầu tiên.
 */
export function assertCanonical(events: NormalizedEvent[], source: string): void {
  for (const evt of events) {
    if (!isReservedType(evt.type)) continue;
    // Review QT-S2 M1: adapter (kể cả Generic map kiểu tuỳ ý) không được sinh `hub.*` — chỉ `emitHubEvent` phát kiểu này.
    const r = isHubOnlyType(evt.type) ? { ok: false as const, field: 'type' } : validateCanonical(evt.type, evt.data);
    if (!r.ok) {
      normalizeSchemaErrors.inc({ source });
      throw new CanonicalSchemaError(evt.type, r.field);
    }
  }
}

/**
 * PK5 khoá 3 (SPEC-provider-khac §7.1, E24, ADR-206): raw nhận KHÔNG xác thực (`raw_events.verified=false`) mà adapter phát
 * kiểu thuộc namespace chuẩn (`payment.*`, `repo.*`, `hub.*`) -> lỗi VĨNH VIỄN (DLQ, 0 event, 0 delivery). Kiểm lần hai sau
 * `validateGenericConfig` (422 lúc lưu): config bị ép qua DB, hoặc đổi sang scheme có ánh xạ rồi renormalize raw cũ chưa
 * xác thực (E5) — không bao giờ có `payment.received` chưa xác thực. Chỉ đọc cờ của raw, không đọc config.
 */
export function assertUnverifiedNotReserved(events: NormalizedEvent[], verified: boolean, source: string): void {
  if (verified) return;
  for (const evt of events) {
    if (!isReservedType(evt.type)) continue;
    normalizeSchemaErrors.inc({ source });
    throw new CanonicalSchemaError(evt.type, 'verified');
  }
}

/** Topic outbox cho chặng normalize → delivery (S1-2) — nguồn ở route-event.ts (dùng chung với event của hub, QT4b). */
export { DELIVERY_REQUESTED_TOPIC };

@Injectable()
export class NormalizeConsumer {
  private redisPub: Redis;
  /**
   * Tiêm lỗi để kiểm S1-3 trên docker: N lần xử lý đầu ném P1001 giả. CHỈ khi NODE_ENV !== 'production'
   * — trên môi trường thật biến này bị bỏ qua hoàn toàn.
   */
  private faultsLeft: number;
  /** F2 (ADR-231): warn "Lỗi tạm ở normalize" tối đa 1 dòng / 30s / tiến trình (như `infraLogThrottle` của delivery). */
  readonly transientLogThrottle = new LogThrottle();
  /** LOGGING.md §3: MỘT dòng `normalize.done` mỗi lần xử lý message (ok/skip/lỗi/hoãn). Gán lại được (test). */
  canonical: CanonicalLogger = new CanonicalLogger({ log: logger });

  constructor(
    private readonly prisma: PrismaService,
    /** BP5 (ADR-200): bộ điều khiển áp lực ngược `db` (dùng chung với delivery trong tiến trình). */
    @Optional() @Inject(BACKPRESSURE_DB) private readonly backpressure: FailureRateController | null = null,
  ) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl, fastFailRedisOptions()); // MS-P2-3
    this.redisPub.on?.('error', (err) => logger.warn({ err: err.message }, 'Redis pub (normalize) lỗi'));
    this.redisPub.connect().catch(() => {});
    this.faultsLeft =
      process.env.NODE_ENV === 'production' ? 0 : Math.max(0, parseInt(process.env.NORMALIZE_FAULT_FIRST_N || '0', 10) || 0);
    if (this.faultsLeft > 0) {
      logger.warn({ faults: this.faultsLeft }, 'NORMALIZE_FAULT_FIRST_N bật: sẽ tiêm lỗi P1001 giả (chỉ để kiểm, không dùng production)');
    }
  }

  async handleMessage(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void> {
    const outcome = await this.handle(msg, channel);
    // BP5 §7.2: chỉ lỗi HẠ TẦNG (transient) là tín hiệu; lỗi dữ liệu (permanent) không ghi gì.
    if (outcome === 'transient') this.backpressure?.record('infra_fail');
    else if (outcome === undefined) this.backpressure?.record('ok');
  }

  /**
   * BP5 §7.3: giữ quá `BACKPRESSURE_HOLD_MAX_MS` chờ permit -> `retry.30s` KHÔNG tăng `x-normalize-retry`, rồi ack. Không xử lý,
   * không đọc DB. Review BP5 TH-1: spill DÙNG CHUNG trần `NORMALIZE_MAX_DEFER_MS` với nhánh hoãn §7.4 (gắn/giữ
   * `x-normalize-deferred-since`) — quá trần thì về đường cũ: đốt một lượt (`x-normalize-retry` + 1), hết lượt thì DLQ (raw thành
   * ứng viên renormalize) — không spill vô hạn vượt sàn dọn của QT.
   */
  spill(msg: amqp.ConsumeMessage, channel: amqp.Channel): void {
    const run = this.begin(msg);
    const headers = this.outHeaders(run, msg.properties.headers, NORMALIZE_RETRY_TTL_MS);
    const now = Date.now();
    const sinceRaw = Number(headers[NORMALIZE_DEFERRED_SINCE_HEADER]);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : now;
    if (now - since <= normalizeMaxDeferMs()) {
      channel.sendToQueue(QUEUES.NORMALIZE_RETRY, msg.content, { persistent: true, headers: { ...headers, [NORMALIZE_DEFERRED_SINCE_HEADER]: since } });
      channel.ack(msg);
      this.emitDone(run, 'deferred', { cause: 'slow.deferred_backpressure', deferMs: NORMALIZE_RETRY_TTL_MS, nextQueue: QUEUES.NORMALIZE_RETRY });
      return;
    }
    const retries = readNormalizeRetryCount(headers);
    if (retries < NORMALIZE_MAX_RETRIES) {
      normalizeRetries.inc();
      channel.sendToQueue(QUEUES.NORMALIZE_RETRY, msg.content, { persistent: true, headers: { ...headers, [NORMALIZE_RETRY_HEADER]: retries + 1 } });
      channel.ack(msg);
      this.emitDone(run, 'retry', { cause: 'slow.deferred_backpressure', deferMs: NORMALIZE_RETRY_TTL_MS, nextQueue: QUEUES.NORMALIZE_RETRY });
      return;
    }
    logger.error({ deferredSince: since, retries }, 'Normalize giữ/hoãn quá NORMALIZE_MAX_DEFER_MS và hết lượt -> DLQ (renormalize từ Postgres)');
    channel.nack(msg, false, false);
    this.emitDone(run, 'dead', { cause: 'slow.deferred_backpressure' });
  }

  /** Ngữ cảnh MỘT lần xử lý: trace (đọc header), đồng hồ, chờ hàng đợi / tuổi outbox. Không I/O. */
  private begin(msg: amqp.ConsumeMessage, payload?: Partial<OutboxPayload>): NormalizeRun {
    const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
    const correlation = headers['x-correlation-id'] ?? payload?.correlationId;
    const ctx = traceFromHeaders(!headers[TRACEPARENT_HEADER] && payload?.traceparent ? { ...headers, [TRACEPARENT_HEADER]: payload.traceparent } : headers, correlation);
    const due = Number(headers['x-due-at']);
    const published = msg.properties.timestamp;
    const hasQw = (typeof published === 'number' && published > 0) || (Number.isFinite(due) && due > 0);
    const qw = computeQueueWait({ nowMs: Date.now(), publishedTs: published, dueTs: Number.isFinite(due) ? due : undefined });
    const lag = Number(headers['x-outbox-age-ms']);
    return { ctx, t0: performance.now(), queueWaitMs: hasQw ? qw.ms : undefined, clockSkew: qw.clockSkew, outboxLagMs: Number.isFinite(lag) && lag > 0 ? Math.round(lag) : undefined, stages: {}, payload };
  }

  /**
   * Header cho bản republish (retry/hoãn): giữ `traceparent` (cùng trace_id, span của chặng này làm cha), đặt `x-due-at` = lúc tầng
   * hoãn hết hạn (để lần sau `queue_wait` chỉ tính phần QUÁ hạn), bỏ `x-outbox-age-ms` (đã cũ). LOGGING.md §3.2, §4.
   */
  private outHeaders(run: NormalizeRun, headers: Record<string, unknown> | undefined, ttlMs: number): Record<string, unknown> {
    const h: Record<string, unknown> = { ...(headers || {}), [TRACEPARENT_HEADER]: formatTraceparent(run.ctx.traceId, run.ctx.spanId), 'x-due-at': Date.now() + ttlMs };
    delete h['x-outbox-age-ms'];
    return h;
  }

  /** MỘT dòng `normalize.done` (LOGGING.md §3). Không bao giờ ném. */
  private emitDone(
    run: NormalizeRun,
    outcome: CanonicalOutcome,
    o: { cause?: Cause; err?: unknown; deferMs?: number; nextQueue?: string; eventName?: string; policy?: string } = {},
  ): void {
    try {
      const handlerMs = performance.now() - run.t0;
      const stageMs: Partial<Record<Stage, number>> = { ...run.stages };
      if (run.queueWaitMs !== undefined) stageMs.queue_wait = run.queueWaitMs;
      if (run.outboxLagMs !== undefined) stageMs.outbox_lag = run.outboxLagMs;
      const p = run.payload;
      this.canonical.emit({
        svc: 'hub-worker',
        msg: 'normalize.done',
        outcome,
        traceId: run.ctx.traceId,
        spanId: run.ctx.spanId,
        tenantId: p?.tenantId,
        sourceId: p?.sourceId,
        rawEventId: p?.rawEventId,
        provider: typeof p?.provider === 'string' ? p.provider : undefined,
        eventName: o.eventName,
        cause: o.cause,
        err: o.err,
        totalMs: handlerMs + (run.queueWaitMs ?? 0) + (run.outboxLagMs ?? 0),
        stageMs,
        extra: {
          ...(run.ctx.origin !== 'propagated' ? { trace_origin: run.ctx.origin } : {}),
          ...(run.ctx.parentSpanId ? { parent_span_id: run.ctx.parentSpanId } : {}),
          ...(run.ctx.replayOf ? { replay_of: run.ctx.replayOf } : {}),
          ...(run.clockSkew ? { clock_skew: true } : {}),
          ...(o.deferMs ? { defer_ms: o.deferMs } : {}),
          ...(o.nextQueue ? { next_queue: o.nextQueue } : {}),
          ...(o.policy ? { policy: o.policy } : {}),
        },
      });
    } catch {
      /* log không bao giờ làm hỏng consumer */
    }
  }

  private async timed<T>(run: NormalizeRun, stage: Stage, fn: () => Promise<T> | T): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      run.stages[stage] = (run.stages[stage] ?? 0) + (performance.now() - t);
    }
  }

  private async handle(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<'transient' | 'permanent' | void> {
    const correlationId = msg.properties.headers?.['x-correlation-id'] || 'unknown';
    let payload: OutboxPayload;

    try {
      payload = JSON.parse(msg.content.toString());
    } catch (e: any) {
      logger.error({ err: errInfo(e) }, 'Lỗi parse JSON payload trong NormalizeConsumer -> chuyển DLQ');
      channel.nack(msg, false, false);
      this.emitDone(this.begin(msg), 'dead', { cause: 'fail.poison_message', err: e });
      return 'permanent';
    }

    const { rawEventId, tenantId, sourceId, provider } = payload;
    const log = logger.child({ correlationId, rawEventId, provider });
    const run = this.begin(msg, payload);

    try {
      this.maybeInjectFault();

      // 1. Idempotency (§5.2): processed_messages
      const alreadyProcessed = await this.timed(run, 'db_read', () =>
        this.prisma.processedMessage.findUnique({
          where: { consumer_messageId: { consumer: 'normalize', messageId: rawEventId } },
        }),
      );
      if (alreadyProcessed) {
        log.info('Message đã được normalize trước đó (processed_messages hit), bỏ qua');
        channel.ack(msg);
        this.emitDone(run, 'skipped', { policy: 'already_processed' });
        return;
      }

      // 2. Nạp raw_event QUA REPO đã scope tenant (S1-5, BB-5): raw event của tenant khác không đọc được.
      const repo = this.prisma.forTenant(tenantId);
      const rawEvent = await this.timed(run, 'db_read', () => repo.findRawEventById(rawEventId));
      if (!rawEvent) {
        log.warn('Không tìm thấy raw_event (hoặc không thuộc tenant trong message)');
        channel.ack(msg);
        this.emitDone(run, 'skipped', { policy: 'raw_missing' });
        return;
      }

      // 3. Adapter chuẩn hoá
      const tAdapter = performance.now();
      const adapter = ProviderRegistry.get(provider);
      const normalizedEvents: NormalizedEvent[] = adapter.normalize(
        {
          provider,
          sourceKey: '',
          headers: rawEvent.headers as any,
          rawBody: Buffer.from(rawEvent.bodyRaw),
          body: rawEvent.body,
          contentType: rawEvent.contentType || undefined,
        },
        {
          tenantId,
          sourceId,
          correlationId,
          rawEventId,
          // Review SPEC-3 #4: thời gian dự phòng = lúc hub NHẬN, không phải lúc normalize -> renormalize ổn định.
          receivedAt: rawEvent.receivedAt ? new Date(rawEvent.receivedAt).toISOString() : undefined,
          // S8: cấu hình riêng của source (GenericAdapter) — lõi chỉ chuyển qua.
          verificationConfig: (rawEvent as { source?: { verificationConfig?: unknown } }).source?.verificationConfig ?? undefined,
        },
      );
      // 3b. Kiểu dành riêng phải đúng khuôn — kiểm TRƯỚC transaction: sai thì không có dòng nào.
      assertCanonical(normalizedEvents, provider);
      // 3c. PK5 (E5): `verified` CHÉP từ raw (ghi lúc ingest) — không suy từ config hiện tại. Chưa xác thực + kiểu chuẩn -> vĩnh viễn.
      const verified = (rawEvent as { verified?: boolean }).verified !== false;
      assertUnverifiedNotReserved(normalizedEvents, verified, provider);
      run.stages.adapter = performance.now() - tAdapter;

      // 4. Event + delivery + outbox `delivery.requested` + processed_messages trong MỘT transaction (S1-2).
      // Không còn publish thẳng sau COMMIT: hoặc tất cả cùng COMMIT, hoặc không có gì — relay lo phần gửi.
      const routed: EventReceivedNotice['deliveries'] = [];
      // LOGGING.md §4: traceparent của CHẶNG NÀY (span normalize) đi vào payload outbox `delivery.requested`; relay chuyển thành header.
      const outTraceparent = formatTraceparent(run.ctx.traceId, run.ctx.spanId);
      // AU6: RLS — mọi bảng nghiệp vụ trong transaction này thuộc tenantId của message.
      await this.timed(run, 'db_write', () => this.prisma.tenantTx(tenantId, async (tx) => {
        routed.length = 0; // phòng khi callback bị gọi lại
        const repoTx = new TenantScopedRepository(tx, tenantId);

        for (const evt of normalizedEvents) {
          await repoTx.createEvent({
            id: evt.id,
            rawEventId: evt.rawEventId,
            idempotencyKey: evt.id,
            correlationId: evt.correlationId,
            sourceId, // S5: lọc subscription theo sourceIds + polling biết nguồn
            type: evt.type,
            source: evt.source,
            subject: evt.subject,
            data: evt.data,
            normalized: evt.normalized !== false,
            probe: evt.probe === true,
            verified,
            origin: evt.origin,
            occurredAt: new Date(evt.occurredAt),
            receivedAt: new Date(evt.receivedAt),
          });

          // KQ1: request kiểm tra của chính provider (adapter đặt `probe`) — lưu event cho console, KHÔNG định tuyến tới
          // service nào (kể cả subscription `*`). Lõi chỉ đọc cờ, không hỏi provider (BB-1).
          if (evt.probe === true) {
            log.info({ eventType: evt.type }, 'Event probe của provider -> lưu, không định tuyến');
            continue;
          }
          // QT4b: định tuyến dùng CHUNG với event do hub phát (route-event.ts) — một đường outbox duy nhất.
          routed.push(
            ...(await routeEventToSubscriptions(tx, repoTx, tenantId, { id: evt.id, type: evt.type, sourceId: sourceId ?? null, correlationId: String(correlationId), verified, traceparent: outTraceparent }, log)),
          );
        }

        await tx.processedMessage.create({ data: { consumer: 'normalize', messageId: rawEventId } });
      }));

      // 5. Realtime (best-effort, Redis được phép sai). S2-2: MỘT publish cho mỗi raw event (gộp mảng)
      // để giữ ngân sách Redis; mang đủ N nhánh (đích) để dashboard vẽ "toả ra" ngay.
      const routedCount = routed.length;
      if (normalizedEvents.length > 0) {
        const notice: EventReceivedNotice = {
          tenantId,
          correlationId: String(correlationId),
          rawEventId,
          events: normalizedEvents.map((e) => ({ id: e.id, type: e.type, source: e.source })),
          deliveries: routed,
        };
        this.redisPub.publish('hub:realtime:events', JSON.stringify(notice)).catch(() => {});
      }

      channel.ack(msg);
      log.info({ deliveryCount: routedCount }, 'Normalize & Route hoàn thành (delivery đi qua outbox)');
      this.emitDone(run, normalizedEvents.length === 0 ? 'skipped' : 'ok', { eventName: normalizedEvents[0]?.type, policy: normalizedEvents.length === 0 ? 'no_events' : undefined });
    } catch (err: any) {
      return this.handleFailure(err, msg, channel, log, run);
    }
  }

  /** S1-3: lỗi tạm -> hàng đợi 30s (tối đa 5 lần); lỗi dữ liệu hoặc hết lượt -> DLQ. */
  private handleFailure(err: any, msg: amqp.ConsumeMessage, channel: amqp.Channel, log: typeof logger, run: NormalizeRun): 'transient' | 'permanent' {
    const kind = classifyNormalizeError(err);
    const retries = readNormalizeRetryCount(msg.properties.headers);
    // LOGGING.md §2.2: tách `wrong.schema_mismatch` (adapter ra sai khuôn catalog) khỏi `fail.hub_unknown` (adapter ném / lỗi lạ);
    // lỗi tạm hạ tầng là `fail.hub_db`. Trước đây hai nhánh permanent gộp một.
    const cause: Cause = kind === 'transient' ? 'fail.hub_db' : err instanceof CanonicalSchemaError ? 'wrong.schema_mismatch' : 'fail.hub_unknown';

    // BP5 §7.4 (ADR-200): hub ĐÃ BIẾT DB đang ốm (factor > 0) -> lỗi tạm HOÃN không đốt lượt, tối đa NORMALIZE_MAX_DEFER_MS.
    // DB khoẻ (factor = 0, lỗi lẻ) -> hành vi cũ 5 lượt × 30s, để một message có vấn đề riêng không được hoãn mãi.
    if (kind === 'transient' && (this.backpressure?.factor() ?? 0) > 0) {
      const now = Date.now();
      const sinceRaw = Number(msg.properties.headers?.[NORMALIZE_DEFERRED_SINCE_HEADER]);
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : now;
      if (now - since <= normalizeMaxDeferMs()) {
        normalizeDeferred.inc();
        log.debug({ err: errInfo(err), deferredSince: since }, 'Lỗi tạm ở normalize khi DB đang ốm -> retry.30s, KHÔNG đốt lượt');
        channel.sendToQueue(QUEUES.NORMALIZE_RETRY, msg.content, {
          persistent: true,
          headers: { ...this.outHeaders(run, msg.properties.headers, NORMALIZE_RETRY_TTL_MS), [NORMALIZE_DEFERRED_SINCE_HEADER]: since },
        });
        channel.ack(msg);
        this.emitDone(run, 'deferred', { cause, err, deferMs: NORMALIZE_RETRY_TTL_MS, nextQueue: QUEUES.NORMALIZE_RETRY });
        return kind;
      }
      log.warn({ deferredSince: since }, 'Normalize hoãn quá NORMALIZE_MAX_DEFER_MS -> đốt lượt như cũ');
    }

    if (kind === 'transient' && retries < NORMALIZE_MAX_RETRIES) {
      // F2 (chaos [BP:T4] phần b, ADR-231): DB vừa chết, factor còn 0 (trước nhịp tick đầu) -> cả prefetch lỗi trong ~1 s, mỗi
      // message một dòng warn (đo được 225 dòng/s). Gộp như delivery (BP1): tối đa 1 dòng warn / 30s / tiến trình kèm số đã gộp;
      // từng message vẫn có dòng debug (rawEventId nằm trong `log`). Nhánh DLQ (log.error) bên dưới KHÔNG gộp.
      const detail = { err: errInfo(err), [NORMALIZE_RETRY_HEADER]: retries + 1 };
      log.debug(detail, 'Lỗi tạm ở normalize -> q.normalize.retry.30s');
      const suppressed = this.transientLogThrottle.take();
      if (suppressed !== null) {
        log.warn({ ...detail, suppressedSinceLastLog: suppressed }, 'Lỗi tạm ở normalize -> q.normalize.retry.30s (log gộp tối đa 1 dòng/30s)');
      }
      normalizeRetries.inc();
      channel.sendToQueue(QUEUES.NORMALIZE_RETRY, msg.content, {
        persistent: true,
        headers: { ...this.outHeaders(run, msg.properties.headers, NORMALIZE_RETRY_TTL_MS), [NORMALIZE_RETRY_HEADER]: retries + 1 },
      });
      channel.ack(msg);
      this.emitDone(run, 'retry', { cause, err, deferMs: NORMALIZE_RETRY_TTL_MS, nextQueue: QUEUES.NORMALIZE_RETRY });
      return kind;
    }

    log.error(
      { err: errInfo(err), kind, retries, ...(err instanceof CanonicalSchemaError ? { eventType: err.eventType, field: err.field } : {}) },
      kind === 'transient' ? 'Lỗi tạm ở normalize đã hết lượt thử lại -> DLQ' : 'Lỗi dữ liệu ở normalize -> DLQ',
    );
    channel.nack(msg, false, false);
    // CanonicalSchemaError.message chỉ có kiểu event + TÊN trường (không giá trị) nhưng vẫn đi qua errInfo như mọi lỗi.
    this.emitDone(run, 'dead', { cause, err });
    return kind;
  }

  private maybeInjectFault() {
    if (this.faultsLeft <= 0) return;
    this.faultsLeft--;
    throw new Prisma.PrismaClientKnownRequestError('NORMALIZE_FAULT_FIRST_N: lỗi P1001 giả (tiêm để kiểm)', {
      code: 'P1001',
      clientVersion: Prisma.prismaVersion?.client ?? 'fault-injection',
    });
  }
}
