import { Injectable } from '@nestjs/common';
import { deliveriesTotal, deliveryDuration, deliveryHandleDuration, deliveryInfraErrors } from '../metrics';
import { classifyInfraError } from './infra-errors';
import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { Prisma } from '@prisma/client';
import { CIRCUIT_OPEN_MS, CircuitBreakerService, CircuitTarget, CircuitView } from '../circuit/circuit-breaker.service';
import { SenderRegistry } from '../senders/sender.registry';
import { SendResult } from '../senders/sender.interface';
import { EXCHANGES, ROUTING_KEYS, getNextRetryQueue, retryQueueForDelay, retryTtlMs } from '@hub/messaging';
import {
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
} from '@hub/common';
import { aesGcmDecrypt } from '@hub/crypto';
import * as amqp from 'amqplib';
import { performance } from 'perf_hooks';
import Redis from 'ioredis';

// S2-1: circuit OPEN chỉ mở 60s -> hoãn vào tầng NGẮN NHẤT có TTL >= 60s (q.delivery.retry.1m),
// không phải tầng 2h như trước. Tính từ RETRY_TIERS theo giá trị TTL (topology một chỗ duy nhất).
const CIRCUIT_DEFER = retryQueueForDelay(CIRCUIT_OPEN_MS);
// Throttle: phòng ngừa, giữ tầng ngắn nhất.
const THROTTLE_DEFER = retryQueueForDelay(0);

/**
 * Review SPEC-2 #4 (ADR-054): số lần hoãn LIÊN TIẾP vì circuit (OPEN / HALF_OPEN không giành được probe)
 * đếm trong header message. Không có trần thì một đích chết hẳn làm delivery quay vòng retry.1m mãi,
 * đốt Redis/DB. Vượt trần -> tính là MỘT lần thử thất bại (ghi attempt) và đi tầng retry kế tiếp như
 * lỗi retryable, cuối cùng thành DEAD. Mặc định 30 lần ≈ 30 phút (tầng 1m).
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
export const INFRA_LOG_INTERVAL_MS = 30_000;
export class LogThrottle {
  private lastAt = -Infinity;
  private suppressed = 0;
  constructor(
    private readonly intervalMs = INFRA_LOG_INTERVAL_MS,
    // Đồng hồ đơn điệu (review L2-1): chỉnh giờ hệ thống/NTP không làm log im lâu hay bật lại sớm. Test tiêm đồng hồ giả.
    private readonly now: () => number = () => performance.now(),
  ) {}
  /** Trả số lần đã gộp từ dòng log trước (>= 0) nếu được log lúc này; null nếu phải im. */
  take(): number | null {
    const t = this.now();
    if (t - this.lastAt < this.intervalMs) {
      this.suppressed++;
      return null;
    }
    const n = this.suppressed;
    this.lastAt = t;
    this.suppressed = 0;
    return n;
  }
}

/** `x-dead-error`: chỉ tên lỗi + message cắt 200 ký tự, không stack (review T4). */
export function deadErrorHeader(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' && e.name ? e.name : 'Error';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return `${name}: ${message}`.slice(0, 200);
}

export function maxCircuitDeferrals(env: string | undefined = process.env.CIRCUIT_MAX_DEFERRALS): number {
  const n = Number(env ?? 30);
  return Number.isInteger(n) && n > 0 ? n : 30;
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
  };
}

@Injectable()
export class DeliveryConsumer {
  private redisPub: Redis;
  /** BP1 review M3: log lỗi hạ tầng theo nhịp, mỗi tiến trình (mỗi instance consumer) một bộ. */
  readonly infraLogThrottle = new LogThrottle();

  constructor(
    private readonly prisma: PrismaService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl, fastFailRedisOptions()); // MS-P2-3: không xếp hàng publish vô hạn khi Redis chết
    // Không để ioredis văng 'Unhandled error event' khi Redis chết (BB-2: Redis được phép sai).
    this.redisPub.on?.('error', (err) => logger.warn({ err: err.message }, 'Redis pub (delivery) lỗi'));
    this.redisPub.connect().catch(() => {});
  }

  async handleMessage(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void> {
    const end = deliveryHandleDuration.startTimer(); // R-4: 0 lệnh Redis, đếm trong bộ nhớ
    try {
      await this.handle(msg, channel);
    } finally {
      end();
    }
  }

  private async handle(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void> {
    const correlationHeader = msg.properties.headers?.['x-correlation-id'] || 'unknown';
    let deliveryMsg: DeliveryMessage;

    try {
      // Tương thích ngược: message kiểu cũ (có config/signingSecret/event) vẫn đọc được,
      // nhưng CHỈ lấy các trường tham chiếu — cấu hình luôn đọc lại từ DB (S1-1).
      deliveryMsg = parseDeliveryMessage(msg.content, String(correlationHeader));
    } catch (e: any) {
      logger.error({ err: e.message }, 'Lỗi parse DeliveryMessage -> chuyển DLQ');
      channel.nack(msg, false, false);
      return;
    }

    const { deliveryId, attemptCount, tenantId } = deliveryMsg;
    const correlationId = deliveryMsg.correlationId;
    const log = logger.child({ correlationId, deliveryId, attemptCount });
    // Tenant ĐÃ BIẾT tại đây (deliveryMsg.tenantId) -> mọi truy vấn đi qua TenantScopedRepository (BB-5).
    const repo = this.prisma.forTenant(tenantId);
    // Mọi lần đẩy lại (retry, hoãn vì circuit/throttle, DLQ) đều dựng lại message GỌN — kể cả
    // khi message nhận vào là kiểu cũ còn secret, bản sao gửi tiếp sẽ không còn secret nữa.
    const slim = (count = attemptCount) => Buffer.from(JSON.stringify(buildDeliveryMessage({ ...deliveryMsg, attemptCount: count })));

    try {
      // 0. Nạp delivery + event + subscription + destination bằng MỘT truy vấn đã scope tenant.
      const row = await repo.findDeliveryForSend(deliveryId);
      if (!row) {
        log.warn('Delivery không còn tồn tại (đã bị xoá hoặc khác tenant) -> ack, bỏ qua');
        channel.ack(msg);
        return;
      }
      const destination = row.subscription.destination;
      // ADR-161 (T3): đích đã LƯU TRỮ ("Xoá" trên bản đồ luồng) -> không gửi; delivery thành DEAD kèm lý do rõ, ack.
      // Đích chỉ "Ngắt" (is_active=false) thì delivery đang bay vẫn chạy nốt (ADR-161) — chỉ normalize/replay chặn mới.
      if ((destination as { archivedAt?: Date | null }).archivedAt) {
        await repo.abandonDelivery(deliveryId, 'destination_archived: đích đã bị xoá khỏi luồng (lưu trữ, ADR-161) — không gửi');
        log.warn({ destinationId: destination.id }, 'Đích đã lưu trữ -> delivery DEAD, không gửi');
        channel.ack(msg);
        return;
      }
      const destinationId = destination.id;
      const destinationType = destination.type as DestinationType;
      const event = toNormalizedEvent(row);

      const currentAttemptNo = attemptCount + 1;
      // Realtime `delivery.attempt` (S2-2): luôn kèm tenantId để gateway chỉ phát vào room đúng tenant (BB-5).
      // DEFERRED (circuit hoãn) KHÔNG publish — tiết kiệm Redis.
      const notifyAttempt = (n: Pick<DeliveryAttemptNotice, 'status' | 'httpStatus' | 'ms' | 'nextQueue' | 'nextAttemptAt'>) => {
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
        deliveriesTotal.inc({ destination_type: destinationType, status: n.status });
        if (n.ms > 0) deliveryDuration.observe({ destination_type: destinationType }, n.ms / 1000);
      };

      // 1. Circuit breaker 3 trạng thái (S2-1, §5.4). Redis là nguồn chạy; DB chỉ để hiển thị.
      const circuit: CircuitTarget = {
        destinationId,
        tenantId,
        persistedState: ((destination as { circuitState?: CircuitState }).circuitState ?? 'CLOSED') as CircuitState,
      };
      // Review SPEC-3 #2: circuit + throttle trong MỘT lệnh Redis khi đích có rate_limit_rps.
      const rateLimitRps = destination.rateLimitRps && destination.rateLimitRps > 0 ? destination.rateLimitRps : 0;
      const view: CircuitView = await this.circuitBreaker.getState(destinationId, rateLimitRps);
      // `:open` hết hạn (-> HALF_OPEN) hay mọi khoá hết hạn (-> CLOSED) không có sự kiện nào báo:
      // phát hiện ở message kế tiếp bằng cách so với bản DB.
      await this.circuitBreaker.syncObserved(circuit, view);

      let probeToken: string | null = null;
      if (view.state === 'HALF_OPEN') {
        probeToken = await this.circuitBreaker.tryAcquireProbe(destinationId);
      }
      const isProbe = probeToken !== null;
      /** Khác null = hoãn vì circuit đã quá trần -> ghi một lần thử thất bại thay vì gửi (ADR-054). */
      let circuitTimeout: string | null = null;
      if (view.state === 'OPEN' || (view.state === 'HALF_OPEN' && !isProbe)) {
        const deferrals = (Number(msg.properties.headers?.[CIRCUIT_DEFERRALS_HEADER]) || 0) + 1;
        const maxDeferrals = maxCircuitDeferrals();
        if (deferrals <= maxDeferrals) {
          // Hoãn gửi, KHÔNG phải một lần thử: giữ nguyên attemptCount, chỉ tăng bộ đếm hoãn.
          const nextAttemptAt = new Date(Date.now() + CIRCUIT_DEFER.ttlMs);
          log.warn({ queue: CIRCUIT_DEFER.queueName, circuit: view.state, deferrals }, 'Circuit chưa cho gửi -> hoãn (DEFERRED)');
          await repo.deferDelivery(deliveryId, nextAttemptAt).catch(() => 0);
          channel.sendToQueue(CIRCUIT_DEFER.queueName, slim(), {
            persistent: true,
            headers: { ...msg.properties.headers, [CIRCUIT_DEFERRALS_HEADER]: deferrals },
          });
          channel.ack(msg);
          return;
        }
        circuitTimeout = `circuit ${view.state} quá lâu: đã hoãn ${maxDeferrals} lần liên tiếp -> tính là một lần thử thất bại`;
        log.warn({ circuit: view.state, deferrals: maxDeferrals }, 'Circuit hoãn quá trần -> ghi một lần thử thất bại, đi tầng retry kế');
      }
      const releaseProbe = () => (isProbe ? this.circuitBreaker.releaseProbe(destinationId, probeToken) : Promise.resolve());

      // 1b. Outbound Throttle per destination (§5.4b & ADR-016): phòng ngừa, giữ tầng NGẮN nhất.
      // Bộ đếm đã tăng trong getState (cùng lệnh). Chỉ áp khi CLOSED: probe HALF_OPEN và lần "thử" do
      // circuit quá trần không đi qua throttle (probe chỉ một request; lần quá trần không gọi đích).
      if (!circuitTimeout && view.throttleAllowed !== undefined) {
        if (!view.throttleAllowed) {
          log.warn(
            { destinationId, rateLimitRps: destination.rateLimitRps },
            'Outbound Throttle kích hoạt (vượt RPS đích) -> đẩy sang tầng retry ngắn nhất',
          );
          await releaseProbe();
          channel.sendToQueue(THROTTLE_DEFER.queueName, slim(), { persistent: true, headers: msg.properties.headers });
          channel.ack(msg);
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
          log.info({ messageId, queue: CIRCUIT_DEFER.queueName }, 'Lease DELIVERING còn hạn -> hoãn 1 phút rồi thử giành lại');
          channel.sendToQueue(CIRCUIT_DEFER.queueName, slim(), { persistent: true, headers: msg.properties.headers });
          channel.ack(msg);
          return;
        }
        log.debug({ messageId, status: lease?.status }, 'Lần gửi này đã xong hoặc đã sang lần khác (lease) -> ack, bỏ qua');
        channel.ack(msg);
        return;
      }

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
        result = await sender.send(config, rendered, event, signingSecret);
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
        try {
          await persistAttempt(statusData);
          return true;
        } catch (err) {
          if (err instanceof DuplicateProcessedMessageError) {
            log.debug({ messageId }, 'Delivery message đã được xử lý bởi worker khác (duplicate processed_messages) -> ack');
            channel.ack(msg);
            return false;
          }
          throw err;
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

      if (nextQueue) {
        log.info({ nextQueue, nextAttempt: currentAttemptNo + 1 }, 'Lỗi retryable -> đẩy vào queue retry tiếp theo');
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
        });
        channel.sendToQueue(nextQueue, slim(currentAttemptNo), {
          persistent: true,
          // Lần thử mới -> bộ đếm hoãn vì circuit bắt đầu lại từ 0.
          // BP1 review M1: bộ đếm lỗi hạ tầng/lỗi lạ cũng là "liên tiếp trong MỘT lần thử" -> về 0 như bộ đếm circuit.
          headers: {
            ...msg.properties.headers,
            'x-attempt': currentAttemptNo,
            [CIRCUIT_DEFERRALS_HEADER]: 0,
            [UNKNOWN_ERRORS_HEADER]: 0,
            [INFRA_DEFERRALS_HEADER]: 0,
          },
        });
        channel.ack(msg);
        return;
      }

      const lastError = isNonRetryable
        ? `Non-retryable HTTP ${result.status}: ${result.error || result.body}`
        : `Hết 5 lần retry: ${result.error || result.body}`;
      log.warn({ status: result.status }, isNonRetryable ? 'Lỗi non-retryable (4xx) -> DEAD + DLQ' : 'Vượt quá 5 tầng retry -> DEAD + DLQ');
      if (!(await persistAttemptOrSkipIfDuplicate({ status: 'DEAD', attemptCount: currentAttemptNo, lastError, nextAttemptAt: null }))) {
        return;
      }
      notifyAttempt({ status: 'DEAD', httpStatus: result.status, ms: result.durationMs });
      // DLQ broker chỉ là bản sao để quan sát — Postgres (status DEAD) mới là trọng tài. Bản sao gọn, không secret.
      channel.publish(EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD, slim(currentAttemptNo), { persistent: true });
      channel.ack(msg);
    } catch (err: any) {
      // BP1 (ADR-195): KHÔNG requeue ngay — hoãn có nhịp. attemptCount giữ nguyên: lần này chưa hề gọi tới đích
      // (hoặc đã gọi nhưng chưa ghi được kết quả — lần sau idempotency/lease xử lý), đốt lượt vì lỗi của hub là sai.
      const kind = classifyInfraError(err);
      deliveryInfraErrors.inc({ kind });
      const headers = msg.properties.headers ?? {};
      try {
        if (kind === 'transient') {
          // TODO(BP5): báo tín hiệu infra_fail cho bộ điều khiển áp lực ngược.
          const n = (Number(headers[INFRA_DEFERRALS_HEADER]) || 0) + 1;
          // Lỗi hạ tầng lặp mỗi 10s cho TỪNG message tới khi DB về -> tối đa 1 dòng / 30s / tiến trình (review M3).
          const suppressed = this.infraLogThrottle.take();
          if (suppressed !== null) {
            log.warn(
              { err: err?.message, queue: INFRA_DEFER.queueName, infraDeferrals: n, suppressedSinceLastLog: suppressed },
              'Lỗi hạ tầng hub ở delivery -> hoãn 10s, không đốt lượt (log gộp tối đa 1 dòng/30s)',
            );
          }
          channel.sendToQueue(INFRA_DEFER.queueName, slim(), { persistent: true, headers: { ...headers, [INFRA_DEFERRALS_HEADER]: n } });
          channel.ack(msg);
          return;
        }
        const n = (Number(headers[UNKNOWN_ERRORS_HEADER]) || 0) + 1;
        if (n >= UNKNOWN_ERROR_MAX) {
          // Có thể là poison message (bug cố định). q.delivery.main KHÔNG có DLX (topology.ts) -> nack(false) là vứt message;
          // muốn có bản sao trong q.delivery.dlq thì publish thẳng vào DELIVERY_DLX như nhánh DEAD, publish xong mới ack.
          // DLQ broker chỉ là bản sao để quan sát; Postgres vẫn là nguồn sự thật (sweeper hồi sinh delivery kẹt).
          log.error({ err: err?.message, unknownErrors: n }, `Lỗi lạ ở delivery lần thứ ${n} -> bản sao vào DLQ, ack`);
          channel.publish(EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD, slim(), {
            persistent: true,
            headers: { ...headers, [UNKNOWN_ERRORS_HEADER]: n, 'x-dead-reason': 'unknown_error', 'x-dead-error': deadErrorHeader(err) },
          });
          channel.ack(msg);
          return;
        }
        log.warn({ err: err?.message, queue: UNKNOWN_DEFER.queueName, unknownErrors: n }, 'Lỗi lạ ở delivery -> hoãn 1 phút');
        channel.sendToQueue(UNKNOWN_DEFER.queueName, slim(), { persistent: true, headers: { ...headers, [UNKNOWN_ERRORS_HEADER]: n } });
        channel.ack(msg);
      } catch (e: any) {
        // Channel/kết nối đã đóng: không ack được -> message unacked, RabbitMQ giao lại khi tiến trình nối lại (main.ts thoát
        // khi CONNECTION đóng). Riêng channel đóng mà connection sống thì worker không dựng lại channel — nợ cũ, SPEC-BP §16.
        log.error({ err: e?.message, cause: err?.message }, 'Không hoãn được message lỗi (channel đóng?) -> để RabbitMQ giao lại');
      }
    }
  }
}
