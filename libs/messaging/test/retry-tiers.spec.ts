import { getNextRetryQueue, RETRY_TIERS } from '../src/topology';

describe('RabbitMQ Retry Tiers & Backoff (§5.4 & ADR-007)', () => {
  it('phải có đủ 5 tầng retry với TTL tăng dần và không bị head-of-line blocking', () => {
    expect(RETRY_TIERS).toHaveLength(5);
    expect(RETRY_TIERS[0]).toEqual({
      queueName: 'q.delivery.retry.10s',
      ttlMs: 10000,
      attempt: 1,
    });
    expect(RETRY_TIERS[1]).toEqual({
      queueName: 'q.delivery.retry.1m',
      ttlMs: 60000,
      attempt: 2,
    });
    expect(RETRY_TIERS[2]).toEqual({
      queueName: 'q.delivery.retry.5m',
      ttlMs: 300000,
      attempt: 3,
    });
    expect(RETRY_TIERS[3]).toEqual({
      queueName: 'q.delivery.retry.30m',
      ttlMs: 1800000,
      attempt: 4,
    });
    expect(RETRY_TIERS[4]).toEqual({
      queueName: 'q.delivery.retry.2h',
      ttlMs: 7200000,
      attempt: 5,
    });
  });

  it('phải định tuyến chính xác từng tầng retry tương ứng với attemptCount', () => {
    expect(getNextRetryQueue(1)).toBe('q.delivery.retry.10s');
    expect(getNextRetryQueue(2)).toBe('q.delivery.retry.1m');
    expect(getNextRetryQueue(3)).toBe('q.delivery.retry.5m');
    expect(getNextRetryQueue(4)).toBe('q.delivery.retry.30m');
    expect(getNextRetryQueue(5)).toBe('q.delivery.retry.2h');
  });

  it('phải trả về null khi vượt quá 5 lần retry để chuyển sang DLQ', () => {
    expect(getNextRetryQueue(6)).toBeNull();
    expect(getNextRetryQueue(10)).toBeNull();
  });
});
