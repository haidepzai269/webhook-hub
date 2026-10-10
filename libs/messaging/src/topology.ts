import * as amqp from 'amqplib';

export const EXCHANGES = {
  EVENTS: 'x.hub.events',
  NORMALIZE_DLX: 'x.hub.normalize.dlx',
  DELIVERY: 'x.hub.delivery',
  DELIVERY_DLX: 'x.hub.delivery.dlx',
} as const;

export const ROUTING_KEYS = {
  EVENT_RECEIVED: 'event.received',
  DELIVER: 'deliver',
  DEAD: 'dead',
} as const;

export const QUEUES = {
  NORMALIZE: 'q.normalize',
  NORMALIZE_DLQ: 'q.normalize.dlq',
  // Lỗi tạm ở normalize (S1-3): nằm 30s rồi dead-letter về đúng exchange/routing key mà q.normalize nghe.
  NORMALIZE_RETRY: 'q.normalize.retry.30s',
  DELIVERY_MAIN: 'q.delivery.main',
  DELIVERY_DLQ: 'q.delivery.dlq',
} as const;

export const NORMALIZE_RETRY_TTL_MS = 30_000;

/**
 * Giới hạn DLQ bằng RabbitMQ POLICY (review SPEC-1, ADR-052). DLQ không có consumer -> không giới hạn
 * thì phình tới trần CloudAMQP free. KHÔNG thêm `x-max-length` vào arguments của queue: queue đã tồn
 * tại khác arguments -> PRECONDITION_FAILED (CLAUDE.md cạm bẫy 3). Policy đổi được nóng, không cần xoá queue.
 * drop-head: bỏ bản CŨ nhất. Chấp nhận được vì nguồn sự thật DLQ là Postgres (deliveries DEAD, raw_events),
 * bản trong broker chỉ là bản sao để soi.
 * Policy KHÔNG khai báo từ app (app không có quyền management trên CloudAMQP): local đặt bởi service
 * `rabbitmq-init` trong docker-compose.yml, deployed đặt tay qua management API (docs/DEPLOYMENT.md).
 * Giá trị ở đây là nguồn — test `libs/messaging/test/dlq-policy.spec.ts` bắt compose phải khớp.
 */
export const DLQ_POLICY = {
  name: 'hub-dlq-bounded',
  pattern: String.raw`^q\.(delivery|normalize)\.dlq$`,
  definition: { 'max-length': 5000, overflow: 'drop-head' },
  priority: 10,
  applyTo: 'queues',
} as const;

export interface RetryTier {
  queueName: string;
  ttlMs: number;
  attempt: number;
}

export const RETRY_TIERS: RetryTier[] = [
  { queueName: 'q.delivery.retry.10s', ttlMs: 10000, attempt: 1 },
  { queueName: 'q.delivery.retry.1m', ttlMs: 60000, attempt: 2 },
  { queueName: 'q.delivery.retry.5m', ttlMs: 300000, attempt: 3 },
  { queueName: 'q.delivery.retry.30m', ttlMs: 1800000, attempt: 4 },
  { queueName: 'q.delivery.retry.2h', ttlMs: 7200000, attempt: 5 },
];

// Đảm bảo RETRY_TIERS luôn sắp TĂNG DẦN theo ttlMs ngay lúc module load. Nếu sau
// này ai đó chèn/sắp lại tầng mà quên giữ thứ tự này, throw ngay tại đây thay vì
// âm thầm route sai ở nơi khác (vd. delivery.consumer.ts suy ra "tầng dài nhất"
// bằng cách tìm ttlMs lớn nhất trong mảng này -- nếu mảng sai thứ tự mà logic suy
// ra lại dựa vào vị trí, lỗi sẽ không hiện ra ở đâu cả).
RETRY_TIERS.forEach((tier, i) => {
  if (i > 0 && tier.ttlMs <= RETRY_TIERS[i - 1].ttlMs) {
    throw new Error(
      `RETRY_TIERS (libs/messaging/src/topology.ts) phải sắp TĂNG DẦN theo ttlMs: tầng "${tier.queueName}" ` +
        `(ttlMs=${tier.ttlMs}) không lớn hơn tầng trước đó "${RETRY_TIERS[i - 1].queueName}" (ttlMs=${RETRY_TIERS[i - 1].ttlMs}).`,
    );
  }
});

/**
 * Khởi tạo topology RabbitMQ tập trung tại một nơi duy nhất.
 * Đảm bảo idempotent, bền vững (durable).
 */
export async function setupRabbitMQTopology(channel: amqp.Channel): Promise<void> {
  // 1. Exchanges
  await channel.assertExchange(EXCHANGES.EVENTS, 'topic', { durable: true });
  await channel.assertExchange(EXCHANGES.NORMALIZE_DLX, 'direct', { durable: true });
  await channel.assertExchange(EXCHANGES.DELIVERY, 'direct', { durable: true });
  await channel.assertExchange(EXCHANGES.DELIVERY_DLX, 'direct', { durable: true });

  // 2. Normalize Queue & DLQ
  await channel.assertQueue(QUEUES.NORMALIZE_DLQ, { durable: true });
  await channel.bindQueue(QUEUES.NORMALIZE_DLQ, EXCHANGES.NORMALIZE_DLX, ROUTING_KEYS.DEAD);

  await channel.assertQueue(QUEUES.NORMALIZE, {
    durable: true,
    deadLetterExchange: EXCHANGES.NORMALIZE_DLX,
    deadLetterRoutingKey: ROUTING_KEYS.DEAD,
  });
  await channel.bindQueue(QUEUES.NORMALIZE, EXCHANGES.EVENTS, ROUTING_KEYS.EVENT_RECEIVED);

  // 2b. Normalize retry (S1-3, ADR-044) — queue MỚI, không đổi tham số của queue nào đang có
  // (CLAUDE.md cạm bẫy 3). Không bind: consumer gửi thẳng bằng sendToQueue; hết TTL thì
  // dead-letter về x.hub.events/event.received -> q.normalize nhận lại.
  await channel.assertQueue(QUEUES.NORMALIZE_RETRY, {
    durable: true,
    messageTtl: NORMALIZE_RETRY_TTL_MS,
    deadLetterExchange: EXCHANGES.EVENTS,
    deadLetterRoutingKey: ROUTING_KEYS.EVENT_RECEIVED,
  });

  // 3. Delivery DLQ
  await channel.assertQueue(QUEUES.DELIVERY_DLQ, { durable: true });
  await channel.bindQueue(QUEUES.DELIVERY_DLQ, EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD);

  // 4. Delivery Main Queue
  await channel.assertQueue(QUEUES.DELIVERY_MAIN, { durable: true });
  await channel.bindQueue(QUEUES.DELIVERY_MAIN, EXCHANGES.DELIVERY, ROUTING_KEYS.DELIVER);

  // 5. Retry Queues (5 tầng)
  for (const tier of RETRY_TIERS) {
    await channel.assertQueue(tier.queueName, {
      durable: true,
      messageTtl: tier.ttlMs,
      deadLetterExchange: EXCHANGES.DELIVERY,
      deadLetterRoutingKey: ROUTING_KEYS.DELIVER,
    });
  }
}

/**
 * Chọn queue retry tiếp theo dựa trên attemptCount
 */
export function getNextRetryQueue(attemptCount: number): string | null {
  // attemptCount bắt đầu từ 1 sau lần thử đầu tiên
  const tier = RETRY_TIERS.find((t) => t.attempt === attemptCount);
  return tier ? tier.queueName : null;
}

/**
 * S2-1: hoãn một lần gửi ít nhất `delayMs` (circuit OPEN / mất lượt probe) -> tầng retry NGẮN
 * NHẤT có TTL >= delayMs. Tính theo GIÁ TRỊ TTL, không theo vị trí mảng. Delay vượt mọi tầng thì
 * lấy tầng dài nhất. Đây là hoãn gửi, không phải một lần thử: caller không tăng attemptCount.
 */
export function retryQueueForDelay(delayMs: number): { queueName: string; ttlMs: number } {
  const byTtl = [...RETRY_TIERS].sort((a, b) => a.ttlMs - b.ttlMs);
  const tier = byTtl.find((t) => t.ttlMs >= delayMs) ?? byTtl[byTtl.length - 1];
  return { queueName: tier.queueName, ttlMs: tier.ttlMs };
}

/** TTL của tầng retry theo tên queue (để tính `next_attempt_at = now + TTL`, S2-2). */
export function retryTtlMs(queueName: string): number | null {
  return RETRY_TIERS.find((t) => t.queueName === queueName)?.ttlMs ?? null;
}
