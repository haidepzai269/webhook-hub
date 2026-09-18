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
  DELIVERY_MAIN: 'q.delivery.main',
  DELIVERY_DLQ: 'q.delivery.dlq',
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
