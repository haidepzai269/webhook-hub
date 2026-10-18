import { Inject, Injectable, Optional } from '@nestjs/common';
import { deliveriesDeferred, deliveriesTotal, deliveryDuration, deliveryHandleDuration, deliveryInfraErrors } from '../metrics';
import { BACKPRESSURE_DB, FailureRateController } from '../backpressure/failure-rate.controller';
import { classifyInfraError } from './infra-errors';
import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { Prisma } from '@prisma/client';
import { CircuitBreakerService, CircuitTarget, CircuitView } from '../circuit/circuit-breaker.service';
import { SenderRegistry } from '../senders/sender.registry';
import { SendResult } from '../senders/sender.interface';
import { performance } from 'perf_hooks';
import { EXCHANGES, ROUTING_KEYS, circuitDeferTier, circuitMaxDeferMs, getNextRetryQueue, retryQueueForDelay, retryTtlMs } from '@hub/messaging';
import {
  CanonicalLogger,
  CanonicalOutcome,
  Cause,
  ErrInfo,
  Stage,
  TRACEPARENT_HEADER,
  causeOfSendFailure,
  computeQueueWait,
  errInfo,
  formatTraceparent,
  traceFromHeaders,
  logger,
  CircuitState,
  DeliveryAttemptNotice,
  DeliveryMessage,
  DestinationType,
  NormalizedEvent,
  buildDeliveryMessage,
  parseDeliveryMessage,
  renderTemplate,
  fastFailRedisOptions,
  countsTowardCircuit,
  isNonRetryableHttpStatus,
  LOG_THROTTLE_INTERVAL_MS,
  LogThrottle,
} from '@hub/common';
import { aesGcmDecrypt } from '@hub/crypto';
import * as amqp from 'amqplib';
import { createHash } from 'crypto';
import Redis from 'ioredis';

// BP3 (C4, ADR-197): hoãn vì circuit tới HẾT OPEN theo PTTL thật của `:open` mà gate trả về -> `circuitDeferTier(pttl)`
// (@hub/messaging — cùng nguồn với cửa sổ retry): `retry.1m` (OPEN 60s) hoặc `retry.5m` (OPEN 300s). Không thêm queue.
// Thua lease (không thuộc circuit): hoãn 1 phút để thử giành lại sau khi lease 60s hết.
const LEASE_DEFER = retryQueueForDelay(60_000);
// Throttle: phòng ngừa, giữ tầng ngắn nhất.
const THROTTLE_DEFER = retryQueueForDelay(0);

/**
 * Review SPEC-2 #4 (ADR-054): số lần hoãn LIÊN TIẾP vì circuit (OPEN / HALF_OPEN không giành được probe)
 * đếm trong header message. Không có trần thì một đích chết hẳn làm delivery quay vòng retry.1m mãi,
 * đốt Redis/DB. Vượt trần -> tính là MỘT lần thử thất bại (ghi attempt) và đi tầng retry kế tiếp như
 * lỗi retryable, cuối cùng thành DEAD. BP2 (ADR-196): trần nay tính theo THỜI GIAN (`x-circuit-deferred-since`,
 * `CIRCUIT_MAX_DEFER_MS`); header đếm số lần giữ lại chỉ để quan sát.
 */
export const CIRCUIT_DEFERRALS_HEADER = 'x-circuit-deferrals';
/**
 * BP1 (ADR-195): lỗi bắt ở `catch` ngoài cùng KHÔNG BAO GIỜ requeue (RabbitMQ giao lại ngay -> vòng lặp nóng
 * đập vào DB đang hỏng). Lỗi hạ tầng (transient) hoãn vào tầng ngắn nhất (10s), KHÔNG tăng attemptCount (chưa gọi đích);
 * lỗi lạ (unknown) hoãn 1 phút, tới lần thứ UNKNOWN_ERROR_MAX thì publish bản sao vào DELIVERY_DLX rồi ack (q.delivery.main không có
 * DLX nên nack(false) sẽ vứt message). Postgres vẫn là trọng tài:
 * sweeper hồi sinh delivery còn PENDING/RETRYING, tối đa một lần mỗi 10 phút.
 */
export const INFRA_DEFERRALS_HEADER = 'x-infra-deferrals';
export const UNKNOWN_ERRORS_HEADER = 'x-unknown-errors';
export const UNKNOWN_ERROR_MAX = 5;
const INFRA_DEFER = retryQueueForDelay(0); // q.delivery.retry.10s
const UNKNOWN_DEFER = retryQueueForDelay(60_000); // q.delivery.retry.1m

/**
 * BP1 review M3: lỗi hạ tầng lặp lại cho TỪNG message mỗi 10s tới khi DB về -> không log mỗi lần. Tối đa một dòng
 * mỗi `intervalMs` mỗi tiến trình, kèm số lần đã gộp. Đếm trong bộ nhớ (0 lệnh Redis); metric vẫn đếm đủ từng lần.
 */
export const INFRA_LOG_INTERVAL_MS = LOG_THROTTLE_INTERVAL_MS;
/** Review PK10 T-b: lớp dời về `@hub/common` (hub-api dùng chung); giữ export ở đây cho chỗ import cũ. */
export { LogThrottle };

/**
 * BP6 (nợ §16 của BP1): message delivery HỎNG (không parse được). `q.delivery.main` KHÔNG có DLX (topology.ts) nên
 * `nack(requeue=false)` là VỨT message — log cũ "chuyển DLQ" sai. Publish bản sao vào `x.hub.delivery.dlx` (như nhánh DEAD và
 * lỗi lạ của BP1), header `x-dead-reason: parse_error`, RỒI ack. Bỏ các trường cấu hình/bí mật của message kiểu cũ (S1-1: DLQ
 * không giữ secret). Publish ném lỗi (channel đóng) -> không ack, RabbitMQ giao lại.
 */
function deadLetterUnparsable(msg: amqp.ConsumeMessage, channel: amqp.Channel, err: unknown): void {
  // Review BP6 TH-5: KHÔNG đưa byte thô vào DLQ khi không parse được — message kiểu cũ bị cắt cụt (JSON hỏng) có thể còn chuỗi
  // secret. Chỉ giữ chỗ: độ dài + sha256 (đối chiếu log/broker nếu cần), lý do nằm ở header `x-dead-reason`.
  let content: Buffer;
  try {
    const raw = JSON.parse(msg.content.toString());
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const k of ['config', 'signingSecret', 'event']) delete (raw as Record<string, unknown>)[k];
      content = Buffer.from(JSON.stringify(raw));
    } else {
      content = unparsablePlaceholder(msg.content);
    }
  } catch {
    content = unparsablePlaceholder(msg.content);
  }
  logger.error({ err: (err as Error)?.message }, 'Lỗi parse DeliveryMessage -> bản sao vào q.delivery.dlq (x-dead-reason=parse_error), ack');
  try {
    channel.publish(EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD, content, {
      persistent: true,
      headers: { ...(msg.properties.headers ?? {}), 'x-dead-reason': 'parse_error', 'x-dead-error': deadErrorHeader(err) },
    });
    channel.ack(msg);
  } catch (e: any) {
    logger.error({ err: e?.message }, 'Không publish được bản sao DLQ (channel đóng?) -> để RabbitMQ giao lại');
  }
}

function unparsablePlaceholder(body: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ unparsable: true, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
}

/** `x-dead-error`: chỉ tên lỗi + message cắt 200 ký tự, không stack (review T4). */
export function deadErrorHeader(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' && e.name ? e.name : 'Error';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return `${name}: ${message}`.slice(0, 200);
}

/**
 * BP2 §3.3 (ADR-196): trần hoãn vì circuit tính theo THỜI GIAN (`CIRCUIT_MAX_DEFER_MS`, @hub/messaging retry-window.ts), không
 * theo số lần — OPEN dài 5 phút (BP3) thì "30 lần" thành 2,5 giờ. `x-circuit-deferred-since` (epoch ms) đặt ở lần hoãn đầu của
 * MỘT lần thử, xoá khi lần thử thật diễn ra. Message cũ chỉ có `x-circuit-deferrals` (chưa có since) -> since = now.
 * `x-circuit-deferrals` vẫn đếm để quan sát (log), không còn là trần.
 */
export const CIRCUIT_DEFERRED_SINCE_HEADER = 'x-circuit-deferred-since';
/**
 * BP2 §3.3 (F7): VẪN ghi `next_attempt_at` (sweeper dựa vào nó để biết PENDING/RETRYING nào đang hoãn hợp lệ — bỏ hẳn thì cứ
 * 10 phút sweeper nhân bản message), nhưng THƯA: chỉ khi header chưa có hoặc đã cũ hơn 2 phút. Mốc = now + TTL tầng hoãn.
 */
export const DEFER_WRITTEN_AT_HEADER = 'x-defer-written-at';
export const DEFER_WRITE_EVERY_MS = 120_000;

function headerEpoch(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Quyết định thuần cho MỘT lần hoãn vì circuit (BP2 §3.3). */
export function circuitDeferDecision(
  headers: Record<string, unknown> | undefined,
  now: number,
  maxDeferMs: number = circuitMaxDeferMs(),
): { since: number; exceeded: boolean; writeDb: boolean; deferrals: number } {
  const since = headerEpoch(headers?.[CIRCUIT_DEFERRED_SINCE_HEADER]) ?? now;
  const writtenAt = headerEpoch(headers?.[DEFER_WRITTEN_AT_HEADER]);
  return {
    since,
    exceeded: now - since > maxDeferMs,
    writeDb: writtenAt === null || now - writtenAt > DEFER_WRITE_EVERY_MS,
    deferrals: (Number(headers?.[CIRCUIT_DEFERRALS_HEADER]) || 0) + 1,
  };
}

/** Header cho lần thử MỚI (tầng retry kế): mọi bộ đếm/mốc "trong một lần thử" về 0 / bị xoá. */
function freshAttemptHeaders(headers: Record<string, unknown> | undefined, attempt: number): Record<string, unknown> {
  const h: Record<string, unknown> = {
    ...headers,
    'x-attempt': attempt,
    [CIRCUIT_DEFERRALS_HEADER]: 0,
    // BP1 review M1: bộ đếm lỗi hạ tầng/lỗi lạ cũng là "liên tiếp trong MỘT lần thử" -> về 0 như bộ đếm circuit.
    [UNKNOWN_ERRORS_HEADER]: 0,
    [INFRA_DEFERRALS_HEADER]: 0,
  };
  delete h[CIRCUIT_DEFERRED_SINCE_HEADER];
  delete h[DEFER_WRITTEN_AT_HEADER];
  return h;
}

/**
 * Review SPEC-2 #3 (ADR-054): chỉ lỗi cho thấy ĐÍCH đang hỏng mới tính vào circuit. CB1: bảng phân loại HTTP đã tách ra
 * `libs/common/src/http-outcome.ts` (luật cảnh báo dùng CHÍNH hàm đó) — re-export để chỗ import cũ không đổi.
 */
export { countsTowardCircuit };

/**
 * Đánh dấu CHÍNH XÁC lỗi P2002 (unique-violation) xảy ra ở bước ghi
 * `processed_messages` (composite PK `[consumer, messageId]`) trong transaction
 * chốt idempotency. Đây là tình huống VÔ HẠI, tự lành: 2 worker xử lý gần như đồng
 * thời 2 message trùng `deliveryId:attemptGeneration:attemptNo`, worker thua cuộc
 * chạm unique constraint vì worker kia đã COMMIT trước — chỉ ack, không requeue.
 */
class DuplicateProcessedMessageError extends Error {
  constructor(readonly cause: unknown) {
    super('processed_messages unique violation (P2002) -- lần gửi này đã được worker khác xử lý xong');
  }
}

type DeliveryForSend = NonNullable<Awaited<ReturnType<TenantScopedRepository['findDeliveryForSend']>>>;

/** Dựng NormalizedEvent từ dòng `events` trong DB — message không còn mang event (S1-1). */
function toNormalizedEvent(row: DeliveryForSend): NormalizedEvent {
  const e = row.event;
  return {
    id: e.id,
    tenantId: e.tenantId,
    type: e.type,
    source: e.source as NormalizedEvent['source'],
    sourceId: (e as { sourceId?: string | null }).sourceId ?? e.rawEvent?.sourceId ?? '',
    subject: e.subject ?? undefined,
    data: (e.data ?? {}) as Record<string, any>,
    occurredAt: e.occurredAt.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    correlationId: e.correlationId,
    rawEventId: e.rawEventId ?? undefined,
    parentEventId: e.parentEventId ?? undefined,
    origin: e.origin as NormalizedEvent['origin'],
    normalized: (e as { normalized?: boolean }).normalized !== false,
    // PK5 (E4): phong bì / tin nhắn phải nói được "chưa xác thực" — chép cờ của dòng events.
    verified: (e as { verified?: boolean }).verified !== false,
  };
}

/** Ngữ cảnh MỘT lần xử lý message delivery (log `delivery.attempt`, LOGGING.md §3). */
interface DeliveryRun {
  ctx: ReturnType<typeof traceFromHeaders>;
  t0: number;
  /** Chỉ có khi message mang `timestamp` AMQP (relay) hoặc `x-due-at` (tầng retry/hoãn). */
  queueWaitMs?: number;
  clockSkew: boolean;
  outboxLagMs?: number;
  stages: Partial<Record<Stage, number>>;
  tenantId: string;
  deliveryId: string;
  /** Lần thử đang chờ/đang chạy (attemptCount + 1). */
  attempt: number;
  destinationId?: string;
  eventName?: string;
}

/** Lỗi gửi đích -> `{class, code, msg}` (§3.1): code máy đọc (HTTP_5xx / TIMEOUT / ECONNREFUSED…); msg đã scrub, KHÔNG body phản hồi. */
function sendErrInfo(r: SendResult, cause: Cause): ErrInfo {
  const base = errInfo(String(r.error ?? ''));
  const status = r.status;
  if (cause === 'fail.dest_timeout') return { ...base, class: 'TimeoutError', code: status === 408 ? 'HTTP_408' : 'TIMEOUT' };
  if (cause === 'fail.dest_network') return { ...base, class: 'NetworkError', code: /\b(E[A-Z]{3,}[A-Z0-9_]*)\b/.exec(String(r.error ?? ''))?.[1] ?? 'NETWORK' };
  const code = status >= 500 ? 'HTTP_5xx' : status === 429 || status === 408 ? `HTTP_${status}` : status >= 400 ? 'HTTP_4xx' : `HTTP_${status}`;
  return { ...base, class: 'HttpError', code };
}

@Injectable()
export class DeliveryConsumer {
  private redisPub: Redis;
  /** BP1 review M3: log lỗi hạ tầng theo nhịp, mỗi tiến trình (mỗi instance consumer) một bộ. */
  readonly infraLogThrottle = new LogThrottle();
  /** LOGGING.md §3: MỘT dòng `delivery.attempt` mỗi lần thử/hoãn/bỏ (kể cả thất bại còn retry). Gán lại được (test). */
  canonical: CanonicalLogger = new CanonicalLogger({ log: logger });

  /** Ngữ cảnh một lần xử lý: trace (đọc header), đồng hồ, chờ hàng đợi / tuổi outbox. Không I/O. */
  private begin(msg: amqp.ConsumeMessage, m: { tenantId: string; deliveryId: string; correlationId: string; attemptCount: number; destinationId?: string }): DeliveryRun {
    const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
    const ctx = traceFromHeaders(headers, m.correlationId);
    const due = Number(headers['x-due-at']);
    const published = msg.properties.timestamp;
    const hasQw = (typeof published === 'number' && published > 0) || (Number.isFinite(due) && due > 0);
    const qw = computeQueueWait({ nowMs: Date.now(), publishedTs: published, dueTs: Number.isFinite(due) ? due : undefined });
    const lag = Number(headers['x-outbox-age-ms']);
    return {
      ctx,
      t0: performance.now(),
      queueWaitMs: hasQw ? qw.ms : undefined,
      clockSkew: qw.clockSkew,
      outboxLagMs: Number.isFinite(lag) && lag > 0 ? Math.round(lag) : undefined,
      stages: {},
      tenantId: m.tenantId,
      deliveryId: m.deliveryId,
      attempt: m.attemptCount + 1,
      destinationId: m.destinationId,
    };
  }

  /**
   * Header cho bản republish (retry/hoãn/DLQ): giữ `traceparent` (cùng trace_id; span của chặng này làm cha của lần sau), đặt
   * `x-due-at` = lúc tầng hoãn hết hạn (lần sau `queue_wait` chỉ tính phần QUÁ hạn — chờ cố ý của retry không phải sự cố), bỏ
   * `x-outbox-age-ms` (đã cũ). LOGGING.md §3.2, §4.
   */
  private outHeaders(run: DeliveryRun, headers: Record<string, unknown> | undefined, ttlMs: number | null): Record<string, unknown> {
    const h: Record<string, unknown> = { ...(headers || {}), [TRACEPARENT_HEADER]: formatTraceparent(run.ctx.traceId, run.ctx.spanId) };
    if (ttlMs !== null) h['x-due-at'] = Date.now() + ttlMs;
    delete h['x-outbox-age-ms'];
    return h;
  }

  /** MỘT dòng `delivery.attempt`. Không bao giờ ném (log không làm hỏng đường giao). */
  private emitAttempt(
    run: DeliveryRun,
    outcome: CanonicalOutcome,
    o: { cause?: Cause; err?: unknown; httpStatus?: number; deferMs?: number; nextQueue?: string; lastCause?: Cause; policy?: string; destMs?: number; circuit?: string } = {},
  ): void {
    try {
      const handlerMs = performance.now() - run.t0;
      const stageMs: Partial<Record<Stage, number>> = { ...run.stages };
      if (o.destMs !== undefined) stageMs.dest_http = o.destMs;
      if (run.queueWaitMs !== undefined) stageMs.queue_wait = run.queueWaitMs;
      if (run.outboxLagMs !== undefined) stageMs.outbox_lag = run.outboxLagMs;
      this.canonical.emit({
        svc: 'hub-worker',
        msg: 'delivery.attempt',
        outcome,
        traceId: run.ctx.traceId,
        spanId: run.ctx.spanId,
        tenantId: run.tenantId,
        deliveryId: run.deliveryId,
        destinationId: run.destinationId,
        eventName: run.eventName,
        attempt: run.attempt,
        httpStatus: o.httpStatus,
        cause: o.cause,
        err: o.err,
        // handler (đã gồm dest_http vì dest_http là một phần của thời gian chạy) + phần chờ nằm NGOÀI handler
        totalMs: handlerMs + (run.queueWaitMs ?? 0) + (run.outboxLagMs ?? 0),
        stageMs,
        extra: {
          ...(run.ctx.origin !== 'propagated' ? { trace_origin: run.ctx.origin } : {}),
          ...(run.ctx.parentSpanId ? { parent_span_id: run.ctx.parentSpanId } : {}),
          ...(run.ctx.replayOf ? { replay_of: run.ctx.replayOf } : {}),
          ...(run.clockSkew ? { clock_skew: true } : {}),
          ...(o.deferMs ? { defer_ms: o.deferMs } : {}),
          ...(o.nextQueue ? { next_queue: o.nextQueue } : {}),
          ...(o.lastCause ? { last_cause: o.lastCause } : {}),
          ...(o.policy ? { policy: o.policy } : {}),
          ...(o.circuit ? { circuit: o.circuit } : {}),
        },
      });
    } catch {
      /* log không bao giờ làm hỏng consumer */
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly circuitBreaker: CircuitBreakerService,
    /** BP5 (ADR-200): bộ điều khiển áp lực ngược `db` — chỉ nhận tín hiệu lỗi HẠ TẦNG của hub, không bao giờ lỗi của đích. */
    @Optional() @Inject(BACKPRESSURE_DB) private readonly backpressure: FailureRateController | null = null,
  ) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl, fastFailRedisOptions()); // MS-P2-3: không xếp hàng publish vô hạn khi Redis chết
    // Không để ioredis văng 'Unhandled error event' khi Redis chết (BB-2: Redis được phép sai).
    this.redisPub.on?.('error', (err) => logger.warn({ err: err.message }, 'Redis pub (delivery) lỗi'));
    this.redisPub.connect().catch(() => {});
  }

  /**
   * Hoãn vì circuit (BP2 §3.3): KHÔNG phải một lần thử — giữ nguyên attemptCount. Ghi `next_attempt_at` THƯA (≤ 1 lần / 2 phút,
   * F7: không bỏ hẳn), giữ `since` để trần tính theo thời gian, rồi republish + ack. Không cần row (dùng được trước khi nạp).
   */
  private async deferForCircuit(
    msg: amqp.ConsumeMessage,
    channel: amqp.Channel,
    repo: Pick<TenantScopedRepository, 'deferDelivery'>,
    deliveryId: string,
    slim: () => Buffer,
    state: CircuitState,
    d: ReturnType<typeof circuitDeferDecision>,
    log: Pick<typeof logger, 'warn'>,
    openPttlMs?: number,
    run?: DeliveryRun,
  ): Promise<void> {
    const now = Date.now();
    const tier = circuitDeferTier(state === 'OPEN' ? openPttlMs : undefined);
    let writtenAt = headerEpoch(msg.properties.headers?.[DEFER_WRITTEN_AT_HEADER]);
    if (d.writeDb) {
      const n = await repo.deferDelivery(deliveryId, new Date(now + tier.ttlMs)).catch(() => null);
      if (n !== null) writtenAt = now; // ghi lỗi -> lần sau thử ghi lại
    }
    log.warn({ queue: tier.queueName, circuit: state, openPttlMs, deferrals: d.deferrals, wroteDb: d.writeDb }, 'Circuit chưa cho gửi -> hoãn (DEFERRED)');
    const headers: Record<string, unknown> = {
      ...(run ? this.outHeaders(run, msg.properties.headers, tier.ttlMs) : msg.properties.headers),
      [CIRCUIT_DEFERRALS_HEADER]: d.deferrals,
      [CIRCUIT_DEFERRED_SINCE_HEADER]: d.since,
    };
    if (writtenAt !== null) headers[DEFER_WRITTEN_AT_HEADER] = writtenAt;
    deliveriesDeferred.inc({ reason: 'circuit' });
    channel.sendToQueue(tier.queueName, slim(), { persistent: true, headers });
    channel.ack(msg);
    if (run) this.emitAttempt(run, 'deferred', { cause: 'slow.deferred_circuit', deferMs: tier.ttlMs, nextQueue: tier.queueName, circuit: state, policy: 'circuit' });
  }

  async handleMessage(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void> {
    const end = deliveryHandleDuration.startTimer(); // R-4: 0 lệnh Redis, đếm trong bộ nhớ
    try {
      const outcome = await this.handle(msg, channel);
      // BP5 §7.2: tín hiệu CHỈ là lỗi hạ tầng của hub. Đích trả 5xx/4xx/timeout vẫn là `ok` (xử lý xong). Lỗi lạ / dữ liệu
      // và các lần hoãn không chạm DB (gate trước khi nạp) không ghi gì.
      if (outcome === 'infra_fail') this.backpressure?.record('infra_fail');
      else if (outcome === undefined) this.backpressure?.record('ok');
    } finally {
      end();
    }
  }

  /**
   * BP5 §7.3: giữ quá `BACKPRESSURE_HOLD_MAX_MS` chờ permit -> republish message GỌN sang `retry.10s` KHÔNG tăng attemptCount
   * (header giữ nguyên), rồi ack. Message hỏng -> như nhánh parse lỗi của `handle`.
   */
  spill(msg: amqp.ConsumeMessage, channel: amqp.Channel): void {
    let m: DeliveryMessage;
    try {
      m = parseDeliveryMessage(msg.content, String(msg.properties.headers?.['x-correlation-id'] || 'unknown'));
    } catch (e: any) {
      deadLetterUnparsable(msg, channel, e);
      this.emitAttempt(this.begin(msg, { tenantId: '', deliveryId: '', correlationId: 'unknown', attemptCount: 0 }), 'dead', { cause: 'fail.poison_message', err: e });
      return;
    }
    const run = this.begin(msg, m);
    channel.sendToQueue(INFRA_DEFER.queueName, Buffer.from(JSON.stringify(buildDeliveryMessage(m))), { persistent: true, headers: this.outHeaders(run, msg.properties.headers, INFRA_DEFER.ttlMs) });
    channel.ack(msg);
    this.emitAttempt(run, 'deferred', { cause: 'slow.deferred_backpressure', deferMs: INFRA_DEFER.ttlMs, nextQueue: INFRA_DEFER.queueName, policy: 'backpressure_hold' });
  }

  /** `undefined` = xử lý xong có chạm DB (tín hiệu `ok`); 'nodb' = hoãn trước khi nạp; 'infra_fail' / 'unknown' = catch. */
  private async handle(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<'infra_fail' | 'unknown' | 'nodb' | void> {
    const correlationHeader = msg.properties.headers?.['x-correlation-id'] || 'unknown';
    let deliveryMsg: DeliveryMessage;

    try {
      // Tương thích ngược: message kiểu cũ (có config/signingSecret/event) vẫn đọc được,
      // nhưng CHỈ lấy các trường tham chiếu — cấu hình luôn đọc lại từ DB (S1-1).
      deliveryMsg = parseDeliveryMessage(msg.content, String(correlationHeader));
    } catch (e: any) {
      deadLetterUnparsable(msg, channel, e);
      this.emitAttempt(this.begin(msg, { tenantId: '', deliveryId: '', correlationId: String(correlationHeader), attemptCount: 0 }), 'dead', { cause: 'fail.poison_message', err: e });
      return 'unknown';
    }

    const { deliveryId, attemptCount, tenantId } = deliveryMsg;
    const correlationId = deliveryMsg.correlationId;
    const log = logger.child({ correlationId, deliveryId, attemptCount });
    const run = this.begin(msg, { tenantId, deliveryId, correlationId, attemptCount, destinationId: deliveryMsg.destinationId });
    // Tenant ĐÃ BIẾT tại đây (deliveryMsg.tenantId) -> mọi truy vấn đi qua TenantScopedRepository (BB-5).
    const repo = this.prisma.forTenant(tenantId);
    // Mọi lần đẩy lại (retry, hoãn vì circuit/throttle, DLQ) đều dựng lại message GỌN — kể cả
    // khi message nhận vào là kiểu cũ còn secret, bản sao gửi tiếp sẽ không còn secret nữa.
    const slim = (count = attemptCount) => Buffer.from(JSON.stringify(buildDeliveryMessage({ ...deliveryMsg, attemptCount: count })));

    // Probe HALF_OPEN đang giữ (và đích của nó) — khai báo NGOÀI try để `catch` ngoài cùng nhả được (review BP2 TH-1).
    let probeToken: string | null = null;
    /** Đích mà `probeToken` thuộc về (gợi ý có thể lệch đích thật). */
    let probeFor: string | null = null;

    try {
      // BP2 §3.2 (ADR-196): message có GỢI Ý đích + rps -> GATE TRƯỚC khi nạp DB (1 lệnh Redis). Mạch OPEN / HALF_OPEN không
      // giành được probe -> hoãn với 0 truy vấn đọc; vượt throttle -> retry.10s, 0 truy vấn DB. Message cũ (thiếu gợi ý) đi đường
      // cũ: nạp row rồi mới gate. Gợi ý luôn được KIỂM LẠI với row thật trước khi gửi (C9).
      const hint =
        typeof deliveryMsg.destinationId === 'string' && typeof deliveryMsg.rateLimitRps === 'number'
          ? { destinationId: deliveryMsg.destinationId, rateLimitRps: deliveryMsg.rateLimitRps }
          : null;
      let view: CircuitView | null = null;
      if (hint) {
        view = await this.circuitBreaker.getState(hint.destinationId, hint.rateLimitRps);
        // ADR-233: probe đang bị giữ (gate đã thấy, cùng lệnh) -> bên thua không gọi tryAcquireProbe: hoãn với đúng 1 lệnh.
        if (view.state === 'HALF_OPEN' && !view.probeHeld) {
          probeToken = await this.circuitBreaker.tryAcquireProbe(hint.destinationId);
          probeFor = probeToken ? hint.destinationId : null;
        }
        if (view.state === 'OPEN' || (view.state === 'HALF_OPEN' && !probeToken)) {
          const d = circuitDeferDecision(msg.properties.headers, Date.now());
          if (!d.exceeded) {
            await this.deferForCircuit(msg, channel, repo, deliveryId, slim, view.state, d, log, view.openPttlMs, run);
            return 'nodb';
          }
          // Quá trần thời gian -> phải nạp row để ghi một lần thử thất bại (nhánh chung bên dưới quyết định lại).
        } else if (view.throttleAllowed === false) {
          // BP4: vượt trần slow-start (ramp) là chuyện bình thường ngay sau hồi phục (hàng trăm message/giây) -> debug, không xả log.
          (view.rampCap !== undefined ? log.debug : log.warn).call(
            log,
            { destinationId: hint.destinationId, rateLimitRps: hint.rateLimitRps, rampCap: view.rampCap },
            'Outbound Throttle / slow-start (gợi ý) -> tầng retry ngắn nhất, không nạp DB',
          );
          deliveriesDeferred.inc({ reason: view.rampCap !== undefined ? 'ramp' : 'throttle' });
          channel.sendToQueue(THROTTLE_DEFER.queueName, slim(), { persistent: true, headers: this.outHeaders(run, msg.properties.headers, THROTTLE_DEFER.ttlMs) });
          channel.ack(msg);
          this.emitAttempt(run, 'deferred', { cause: 'slow.deferred_throttle', deferMs: THROTTLE_DEFER.ttlMs, nextQueue: THROTTLE_DEFER.queueName, policy: view.rampCap !== undefined ? 'ramp' : 'throttle' });
          return 'nodb';
        }
      }
      const releaseHeldProbe = async () => {
        if (probeToken && probeFor) await this.circuitBreaker.releaseProbe(probeFor, probeToken);
        probeToken = null;
        probeFor = null;
      };

      // 0. Nạp delivery + event + subscription + destination bằng MỘT truy vấn đã scope tenant.
      const row = await repo.findDeliveryForSend(deliveryId);
      if (!row) {
        await releaseHeldProbe();
        log.warn('Delivery không còn tồn tại (đã bị xoá hoặc khác tenant) -> ack, bỏ qua');
        channel.ack(msg);
        this.emitAttempt(run, 'skipped', { policy: 'delivery_gone' });
        return;
      }
      const destination = row.subscription.destination;
      // ADR-161 (T3): đích đã LƯU TRỮ ("Xoá" trên bản đồ luồng) -> không gửi; delivery thành DEAD kèm lý do rõ, ack.
      // Đích chỉ "Ngắt" (is_active=false) thì delivery đang bay vẫn chạy nốt (ADR-161) — chỉ normalize/replay chặn mới.
      if ((destination as { archivedAt?: Date | null }).archivedAt) {
        await releaseHeldProbe();
        await repo.abandonDelivery(deliveryId, 'destination_archived: đích đã bị xoá khỏi luồng (lưu trữ, ADR-161) — không gửi');
        log.warn({ destinationId: destination.id }, 'Đích đã lưu trữ -> delivery DEAD, không gửi');
        channel.ack(msg);
        run.destinationId = destination.id;
        this.emitAttempt(run, 'skipped', { cause: 'wrong.policy_blocked', policy: 'destination_archived' });
        return;
      }
      const destinationId = destination.id;
      const destinationType = destination.type as DestinationType;
      const event = toNormalizedEvent(row);
      run.destinationId = destinationId;
      run.eventName = event.type; // kiểu chuẩn (payment.paid…) — hub không biết nghiệp vụ (BB-1)

      const currentAttemptNo = attemptCount + 1;
      // Realtime `delivery.attempt` (S2-2): luôn kèm tenantId để gateway chỉ phát vào room đúng tenant (BB-5).
      // DEFERRED (circuit hoãn) KHÔNG publish — tiết kiệm Redis.
      const notifyAttempt = (n: Pick<DeliveryAttemptNotice, 'status' | 'httpStatus' | 'ms' | 'nextQueue' | 'nextAttemptAt'>, cause?: Cause) => {
        const notice: DeliveryAttemptNotice = {
          tenantId,
          correlationId,
          eventId: event.id,
          deliveryId,
          destinationId,
          attemptNo: currentAttemptNo,
          generation: deliveryMsg.attemptGeneration,
          ...n,
        };
        this.redisPub.publish('hub:realtime:deliveries', JSON.stringify(notice)).catch(() => {});
        // S3-4: metric trong bộ nhớ (0 lệnh Redis), chỉ sau khi kết quả đã ghi DB.
        deliveriesTotal.inc({ destination_type: destinationType, status: n.status, cause: cause ?? '' });
        if (n.ms > 0) deliveryDuration.observe({ destination_type: destinationType }, n.ms / 1000);
      };

      // 1. Circuit breaker 3 trạng thái (S2-1, §5.4). Redis là nguồn chạy; DB chỉ để hiển thị.
      const circuit: CircuitTarget = {
        destinationId,
        tenantId,
        persistedState: ((destination as { circuitState?: CircuitState }).circuitState ?? 'CLOSED') as CircuitState,
      };
      const rateLimitRps = destination.rateLimitRps && destination.rateLimitRps > 0 ? destination.rateLimitRps : 0;
      if (!view || !hint || hint.destinationId !== destinationId) {
        // Message cũ (không gợi ý), hoặc gợi ý LỆCH đích thật (subscription đổi đích sau khi tạo message): gate với id thật.
        // Ca lệch tốn thêm 1 lệnh (hiếm); lần INCR throttle (nếu có) ở đích gợi ý là một lần đếm dư cho đích đó — chấp nhận.
        if (hint) log.info({ hinted: hint.destinationId, actual: destinationId }, 'Gợi ý destinationId lệch row -> gate lại với id thật');
        await releaseHeldProbe();
        view = await this.circuitBreaker.getState(destinationId, rateLimitRps);
        if (view.state === 'HALF_OPEN' && !view.probeHeld) {
          probeToken = await this.circuitBreaker.tryAcquireProbe(destinationId);
          probeFor = probeToken ? destinationId : null;
        }
      } else if ((hint.rateLimitRps > 0 ? hint.rateLimitRps : 0) !== rateLimitRps) {
        // Gợi ý rps LỆCH (đổi cấu hình): kiểm throttle lại với rps thật, KHÔNG đếm hai lần (C9).
        log.info({ hinted: hint.rateLimitRps, actual: rateLimitRps }, 'Gợi ý rateLimitRps lệch row -> kiểm throttle lại với giá trị thật');
        view = await this.circuitBreaker.recheckThrottle(destinationId, view, rateLimitRps);
      }
      // Bản republish (hoãn/retry/DLQ) mang gợi ý ĐÚNG với row vừa đọc.
      deliveryMsg = { ...deliveryMsg, destinationId, rateLimitRps };
      // `:open` hết hạn (-> HALF_OPEN) hay mọi khoá hết hạn (-> CLOSED) không có sự kiện nào báo:
      // phát hiện ở message kế tiếp bằng cách so với bản DB. (Lần hoãn trước khi nạp không đồng bộ — trễ một nhịp, ADR-196.)
      await this.circuitBreaker.syncObserved(circuit, view);

      const isProbe = probeToken !== null;
      /** Khác null = hoãn vì circuit đã quá trần -> ghi một lần thử thất bại thay vì gửi (ADR-054). */
      let circuitTimeout: string | null = null;
      if (view.state === 'OPEN' || (view.state === 'HALF_OPEN' && !isProbe)) {
        const d = circuitDeferDecision(msg.properties.headers, Date.now());
        if (!d.exceeded) {
          await this.deferForCircuit(msg, channel, repo, deliveryId, slim, view.state, d, log, view.openPttlMs, run);
          return;
        }
        const waitedMin = Math.round((Date.now() - d.since) / 60_000);
        circuitTimeout = `circuit ${view.state} quá lâu: đã hoãn ${waitedMin} phút (trần ${Math.round(circuitMaxDeferMs() / 60_000)} phút) -> tính là một lần thử thất bại`;
        log.warn({ circuit: view.state, deferredSince: d.since, deferrals: d.deferrals }, 'Circuit hoãn quá trần thời gian -> ghi một lần thử thất bại, đi tầng retry kế');
      }
      const heldToken = probeToken;
      const releaseProbe = () => (isProbe ? this.circuitBreaker.releaseProbe(destinationId, heldToken) : Promise.resolve());

      // 1b. Outbound Throttle per destination (§5.4b & ADR-016) + slow-start sau hồi phục (BP4, ADR-198): trần = min(rps, ramp),
      // vượt -> tầng NGẮN nhất (retry.10s), không tăng lượt, không ghi DB.
      // Bộ đếm đã tăng trong getState (cùng lệnh). Chỉ áp khi CLOSED: probe HALF_OPEN và lần "thử" do
      // circuit quá trần không đi qua throttle (probe chỉ một request; lần quá trần không gọi đích).
      if (!circuitTimeout && view.throttleAllowed !== undefined) {
        if (!view.throttleAllowed) {
          (view.rampCap !== undefined ? log.debug : log.warn).call(
            log,
            { destinationId, rateLimitRps: destination.rateLimitRps, rampCap: view.rampCap },
            'Outbound Throttle / slow-start kích hoạt (vượt trần) -> đẩy sang tầng retry ngắn nhất',
          );
          await releaseProbe();
          deliveriesDeferred.inc({ reason: view.rampCap !== undefined ? 'ramp' : 'throttle' });
          channel.sendToQueue(THROTTLE_DEFER.queueName, slim(), { persistent: true, headers: this.outHeaders(run, msg.properties.headers, THROTTLE_DEFER.ttlMs) });
          channel.ack(msg);
          this.emitAttempt(run, 'deferred', { cause: 'slow.deferred_throttle', deferMs: THROTTLE_DEFER.ttlMs, nextQueue: THROTTLE_DEFER.queueName, policy: view.rampCap !== undefined ? 'ramp' : 'throttle' });
          return;
        }
      }

      const rendered = renderTemplate(row.subscription.template || '', event);

      // 2. Chốt idempotency processed_messages (§5.2 chốt 5) TRƯỚC KHI gửi thật.
      // message_id = deliveryId + attemptGeneration + attemptNo (mỗi tầng retry một id riêng).
      const messageId = `${deliveryId}:${deliveryMsg.attemptGeneration}:${currentAttemptNo}`;

      const alreadyProcessed = await this.prisma.processedMessage.findUnique({
        where: { consumer_messageId: { consumer: 'delivery', messageId } },
      });
      if (alreadyProcessed) {
        log.info({ messageId }, 'Message đã xử lý xong trước đó (processed_messages hit) -> bỏ qua, không gửi lại');
        await releaseProbe();
        channel.ack(msg);
        this.emitAttempt(run, 'skipped', { policy: 'already_processed' });
        return;
      }

      // 2b. Lease (S1-2): cập nhật CÓ ĐIỀU KIỆN sang DELIVERING. Sweeper và message gốc có thể
      // cùng tới — chỉ một bên nhận được lần gửi này, bên kia ack và thôi.
      const claimed = await repo.claimForSend(deliveryId, deliveryMsg.attemptGeneration, attemptCount);
      if (claimed === 0) {
        await releaseProbe();
        // Lease còn hạn cho ĐÚNG lần gửi này (worker khác đang gửi, hoặc worker trước chết/shutdown
        // giữa chừng và message bị redeliver sớm): KHÔNG bỏ — hoãn 1 phút để thử giành lại sau khi
        // lease (60s) hết. Đã SUCCEEDED/DEAD/sang lần thử khác thì message này thừa -> ack bỏ.
        const lease = await repo.getDeliveryLeaseState(deliveryId);
        if (
          lease?.status === 'DELIVERING' &&
          lease.attemptGeneration === deliveryMsg.attemptGeneration &&
          lease.attemptCount === attemptCount
        ) {
          log.info({ messageId, queue: LEASE_DEFER.queueName }, 'Lease DELIVERING còn hạn -> hoãn 1 phút rồi thử giành lại');
          channel.sendToQueue(LEASE_DEFER.queueName, slim(), { persistent: true, headers: this.outHeaders(run, msg.properties.headers, LEASE_DEFER.ttlMs) });
          channel.ack(msg);
          this.emitAttempt(run, 'deferred', { deferMs: LEASE_DEFER.ttlMs, nextQueue: LEASE_DEFER.queueName, policy: 'lease_held' });
          return;
        }
        log.debug({ messageId, status: lease?.status }, 'Lần gửi này đã xong hoặc đã sang lần khác (lease) -> ack, bỏ qua');
        channel.ack(msg);
        this.emitAttempt(run, 'skipped', { policy: 'lease_done' });
        return;
      }

      // Chặng chuẩn bị = từ đầu handler tới ngay trước khi gọi đích (nạp delivery, gate, circuit, render, lease — đã có truy vấn, chỉ bọc đồng hồ).
      run.stages.deliver_prep = performance.now() - run.t0 - (run.stages.db_persist ?? 0);
      let result: SendResult;
      if (circuitTimeout) {
        // Không gọi đích: lần "thử" này là circuit quá trần. status 0 = không có phản hồi (retryable).
        result = { status: 0, error: circuitTimeout, body: '', durationMs: 0 };
      } else {
        // 3. Giải mã cấu hình đích NGAY LÚC GỬI (S1-1) — secret không bao giờ rời Postgres
        // dưới dạng rõ, trừ trong bộ nhớ worker trong khoảnh khắc gửi.
        const masterKey = getMasterKey();
        let config: Record<string, any> = {};
        try {
          config = JSON.parse(aesGcmDecrypt(destination.configEncrypted, masterKey));
        } catch (err: any) {
          log.error({ err: err.message, destinationId }, 'Không thể giải mã config của destination');
        }
        let signingSecret: string | undefined;
        if (destination.signingSecretEncrypted) {
          try {
            signingSecret = aesGcmDecrypt(destination.signingSecretEncrypted, masterKey);
          } catch (err: any) {
            log.error({ err: err.message, destinationId }, 'Không thể giải mã signing secret của destination');
          }
        }

        // 4. Gửi (sender KHÔNG throw -- luôn trả SendResult, kể cả lỗi mạng/timeout)
        const sender = SenderRegistry.get(destinationType);
        // LOGGING.md §4: `traceparent` ra đích (W3C, vô hại, KHÔNG nằm trong chuỗi ký) để đích có OTel nối được trace.
        result = await sender.send(config, rendered, event, signingSecret, { traceparent: formatTraceparent(run.ctx.traceId, run.ctx.spanId) });
      }

      const attemptData: Prisma.DeliveryAttemptUncheckedCreateInput = {
        deliveryId,
        attemptNo: currentAttemptNo,
        requestBody: { content: rendered, event } as any,
        responseStatus: circuitTimeout ? null : result.status,
        responseBody: (result.body || '').substring(0, 2048),
        durationMs: result.durationMs,
        error: result.error,
      };

      // Ghi delivery_attempts + update delivery.status + processed_messages CÙNG một transaction (§5.2 chốt 5).
      const persistAttempt = (statusData: Prisma.DeliveryUncheckedUpdateInput) =>
        // AU6: delivery_attempts có RLS (theo delivery) -> transaction đặt app.project_id NGAY ĐẦU.
        this.prisma.tenantTx(tenantId, async (tx) => {
          await tx.deliveryAttempt.create({ data: attemptData });
          const repoTx = new TenantScopedRepository(tx, tenantId);
          await repoTx.updateDeliveryStatus(deliveryId, statusData);
          try {
            await tx.processedMessage.create({ data: { consumer: 'delivery', messageId } });
          } catch (err: any) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              throw new DuplicateProcessedMessageError(err);
            }
            throw err;
          }
        });

      const persistAttemptOrSkipIfDuplicate = async (statusData: Prisma.DeliveryUncheckedUpdateInput): Promise<boolean> => {
        const tPersist = performance.now();
        try {
          await persistAttempt(statusData);
          return true;
        } catch (err) {
          if (err instanceof DuplicateProcessedMessageError) {
            log.debug({ messageId }, 'Delivery message đã được xử lý bởi worker khác (duplicate processed_messages) -> ack');
            channel.ack(msg);
            this.emitAttempt(run, 'skipped', { policy: 'duplicate_processed', httpStatus: result.status, destMs: result.durationMs });
            return false;
          }
          throw err;
        } finally {
          run.stages.db_persist = (run.stages.db_persist ?? 0) + (performance.now() - tPersist);
        }
      };

      const isSuccess = result.status >= 200 && result.status < 300;

      if (isSuccess) {
        await this.circuitBreaker.recordSuccess(circuit, view);
        if (
          !(await persistAttemptOrSkipIfDuplicate({
            status: 'SUCCEEDED',
            attemptCount: currentAttemptNo,
            lastError: null,
            nextAttemptAt: null,
          }))
        ) {
          return;
        }
        notifyAttempt({ status: 'SUCCEEDED', httpStatus: result.status, ms: result.durationMs });
        log.info({ durationMs: result.durationMs, destinationType }, 'Chuyển phát webhook thành công');
        channel.ack(msg);
        this.emitAttempt(run, 'ok', { httpStatus: result.status, destMs: result.durationMs });
        return;
      }

      // --- THẤT BẠI ---
      // Chỉ lỗi phía đích mới tính vào circuit (ADR-054). Lần "thử" do circuit quá trần không gọi đích
      // nên không phải bằng chứng mới. Probe HALF_OPEN nhận 4xx (không tính): đích trả lời được nhưng
      // không chứng minh sống/chết -> NHẢ probe, giữ HALF_OPEN để lần gửi kế tiếp thử lại ngay.
      if (!circuitTimeout && countsTowardCircuit(result.status)) {
        await this.circuitBreaker.recordFailure(circuit, view);
      } else if (isProbe) {
        log.info({ status: result.status }, 'Probe HALF_OPEN nhận 4xx (không tính vào circuit) -> nhả probe, giữ HALF_OPEN');
        await releaseProbe();
      }

      // 4xx (trừ 408, 429) -> lỗi cấu hình/client -> DEAD ngay (§7.3)
      const isNonRetryable = isNonRetryableHttpStatus(result.status);
      const nextQueue = isNonRetryable ? null : getNextRetryQueue(currentAttemptNo);
      // LOGGING.md §2.2: nguyên nhân của lần thất bại này (đích 5xx / timeout / mạng / 429 / 4xx cấu hình) + `{class, code, msg}` đã scrub.
      const failCause = causeOfSendFailure({ status: result.status, error: result.error });
      const failErr = sendErrInfo(result, failCause);

      if (nextQueue) {
        // Trước đây dòng này KHÔNG có status/err/durationMs — lỗ hổng lớn nhất (LOGGING.md §1 #2).
        log.info({ nextQueue, nextAttempt: currentAttemptNo + 1, status: result.status, durationMs: result.durationMs, cause: failCause, err: failErr }, 'Lỗi retryable -> đẩy vào queue retry tiếp theo');
        // S2-2: next_attempt_at = now + TTL tầng kế — UI đếm ngược, sweeper dùng để phát hiện RETRYING kẹt.
        const nextAttemptAt = new Date(Date.now() + (retryTtlMs(nextQueue) ?? 0));
        if (
          !(await persistAttemptOrSkipIfDuplicate({
            status: 'RETRYING',
            attemptCount: currentAttemptNo,
            nextAttemptAt,
            lastError: `Lần ${currentAttemptNo} thất bại (${result.status}): ${result.error || result.body}`,
          }))
        ) {
          return;
        }
        notifyAttempt({
          status: 'RETRYING',
          httpStatus: result.status,
          ms: result.durationMs,
          nextQueue,
          nextAttemptAt: nextAttemptAt.toISOString(),
        }, failCause);
        channel.sendToQueue(nextQueue, slim(currentAttemptNo), {
          persistent: true,
          // Lần thử mới -> bộ đếm/mốc hoãn trong một lần thử bắt đầu lại (BP2: xoá `since`, `written-at`). traceparent GIỮ (cùng trace
          // qua mọi tầng retry — LOGGING.md §4); x-due-at = lúc tầng retry hết hạn (chờ cố ý không tính vào queue_wait).
          headers: this.outHeaders(run, freshAttemptHeaders(msg.properties.headers, currentAttemptNo), retryTtlMs(nextQueue)),
        });
        channel.ack(msg);
        this.emitAttempt(run, 'retry', { cause: failCause, err: failErr, httpStatus: result.status, destMs: result.durationMs, nextQueue });
        return;
      }

      const lastError = isNonRetryable
        ? `Non-retryable HTTP ${result.status}: ${result.error || result.body}`
        : `Hết 5 lần retry: ${result.error || result.body}`;
      // DEAD vì 4xx cấu hình (lỗi của khách) hay hết 5 tầng (đích hỏng) — trước đây phải suy từ `status` (LOGGING.md §1).
      const deadCause: Cause = isNonRetryable ? failCause : 'fail.exhausted';
      log.warn({ status: result.status, durationMs: result.durationMs, cause: deadCause, lastCause: failCause, err: failErr }, isNonRetryable ? 'Lỗi non-retryable (4xx) -> DEAD + DLQ' : 'Vượt quá 5 tầng retry -> DEAD + DLQ');
      if (!(await persistAttemptOrSkipIfDuplicate({ status: 'DEAD', attemptCount: currentAttemptNo, lastError, nextAttemptAt: null }))) {
        return;
      }
      notifyAttempt({ status: 'DEAD', httpStatus: result.status, ms: result.durationMs }, deadCause);
      // DLQ broker chỉ là bản sao để quan sát — Postgres (status DEAD) mới là trọng tài. Bản sao gọn, không secret.
      channel.publish(EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD, slim(currentAttemptNo), { persistent: true });
      channel.ack(msg);
      this.emitAttempt(run, 'dead', { cause: deadCause, err: failErr, httpStatus: result.status, destMs: result.durationMs, lastCause: isNonRetryable ? undefined : failCause });
    } catch (err: any) {
      // BP1 (ADR-195): KHÔNG requeue ngay — hoãn có nhịp. attemptCount giữ nguyên: lần này chưa hề gọi tới đích
      // (hoặc đã gọi nhưng chưa ghi được kết quả — lần sau idempotency/lease xử lý), đốt lượt vì lỗi của hub là sai.
      // Review BP2 TH-1: nhả probe đang giữ (theo token — đã bị thay/xoá thì là no-op), không khoá dò đích 30s vì lỗi của hub.
      if (probeToken && probeFor) await this.circuitBreaker.releaseProbe(probeFor, probeToken).catch(() => {});
      const kind = classifyInfraError(err);
      deliveryInfraErrors.inc({ kind });
      const headers = msg.properties.headers ?? {};
      try {
        if (kind === 'transient') {
          // BP5: tín hiệu `infra_fail` ghi ở handleMessage (giá trị trả về); hoãn không đốt lượt.
          deliveriesDeferred.inc({ reason: 'infra' });
          const n = (Number(headers[INFRA_DEFERRALS_HEADER]) || 0) + 1;
          // Lỗi hạ tầng lặp mỗi 10s cho TỪNG message tới khi DB về -> tối đa 1 dòng / 30s / tiến trình (review M3).
          const suppressed = this.infraLogThrottle.take();
          if (suppressed !== null) {
            log.warn(
              { err: errInfo(err), queue: INFRA_DEFER.queueName, infraDeferrals: n, suppressedSinceLastLog: suppressed },
              'Lỗi hạ tầng hub ở delivery -> hoãn 10s, không đốt lượt (log gộp tối đa 1 dòng/30s)',
            );
          }
          channel.sendToQueue(INFRA_DEFER.queueName, slim(), { persistent: true, headers: { ...this.outHeaders(run, headers, INFRA_DEFER.ttlMs), [INFRA_DEFERRALS_HEADER]: n } });
          channel.ack(msg);
          this.emitAttempt(run, 'deferred', { cause: 'fail.hub_db', err, deferMs: INFRA_DEFER.ttlMs, nextQueue: INFRA_DEFER.queueName });
          return 'infra_fail';
        }
        const n = (Number(headers[UNKNOWN_ERRORS_HEADER]) || 0) + 1;
        if (n >= UNKNOWN_ERROR_MAX) {
          // Có thể là poison message (bug cố định). q.delivery.main KHÔNG có DLX (topology.ts) -> nack(false) là vứt message;
          // muốn có bản sao trong q.delivery.dlq thì publish thẳng vào DELIVERY_DLX như nhánh DEAD, publish xong mới ack.
          // DLQ broker chỉ là bản sao để quan sát; Postgres vẫn là nguồn sự thật (sweeper hồi sinh delivery kẹt).
          log.error({ err: errInfo(err), unknownErrors: n }, `Lỗi lạ ở delivery lần thứ ${n} -> bản sao vào DLQ, ack`);
          channel.publish(EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD, slim(), {
            persistent: true,
            headers: { ...this.outHeaders(run, headers, null), [UNKNOWN_ERRORS_HEADER]: n, 'x-dead-reason': 'unknown_error', 'x-dead-error': deadErrorHeader(err) },
          });
          channel.ack(msg);
          this.emitAttempt(run, 'dead', { cause: 'fail.hub_unknown', err });
          return 'unknown';
        }
        log.warn({ err: errInfo(err), queue: UNKNOWN_DEFER.queueName, unknownErrors: n }, 'Lỗi lạ ở delivery -> hoãn 1 phút');
        channel.sendToQueue(UNKNOWN_DEFER.queueName, slim(), { persistent: true, headers: { ...this.outHeaders(run, headers, UNKNOWN_DEFER.ttlMs), [UNKNOWN_ERRORS_HEADER]: n } });
        channel.ack(msg);
        this.emitAttempt(run, 'deferred', { cause: 'fail.hub_unknown', err, deferMs: UNKNOWN_DEFER.ttlMs, nextQueue: UNKNOWN_DEFER.queueName });
      } catch (e: any) {
        // Channel/kết nối đã đóng: không ack được -> message unacked, RabbitMQ giao lại khi tiến trình nối lại (main.ts thoát
        // khi CONNECTION hoặc channel consumer đóng — BP5 đóng nợ channel zombie, SPEC-BP §16).
        log.error({ err: errInfo(e), cause: 'fail.hub_broker', original: errInfo(err) }, 'Không hoãn được message lỗi (channel đóng?) -> để RabbitMQ giao lại');
      }
      return kind === 'transient' ? 'infra_fail' : 'unknown';
    }
  }
}
