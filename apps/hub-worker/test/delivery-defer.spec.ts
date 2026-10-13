jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import {
  CIRCUIT_DEFERRALS_HEADER,
  CIRCUIT_DEFERRED_SINCE_HEADER,
  DEFER_WRITTEN_AT_HEADER,
  DeliveryConsumer,
  circuitDeferDecision,
} from '../src/consumers/delivery.consumer';
import { CIRCUIT_MAX_DEFER_MS } from '@hub/messaging';
import { buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg } from './delivery-fixtures';

/** BP2: bản republish mang gợi ý ĐÚNG với row vừa đọc (buildDeliveryRow: dest-1, rps 0). */
const ROW_HINT = { destinationId: 'dest-1', rateLimitRps: 0 };

/**
 * BP2 §3.3 (ADR-196): hoãn vì circuit ghi `next_attempt_at` THƯA (≤ 1 lần / 2 phút, không bỏ hẳn — F7) và trần tính theo THỜI GIAN.
 */
function setup() {
  const repo = {
    findDeliveryForSend: jest.fn().mockResolvedValue(buildDeliveryRow()),
    deferDelivery: jest.fn().mockResolvedValue(1),
    claimForSend: jest.fn(),
  };
  const prisma: any = { forTenant: jest.fn().mockReturnValue(repo), processedMessage: { findUnique: jest.fn() } };
  return { repo, consumer: new DeliveryConsumer(prisma, buildFakeCircuitBreaker('OPEN')) };
}
const amqp = (body: unknown, headers: Record<string, unknown> = {}) =>
  ({ content: Buffer.from(JSON.stringify(body)), properties: { headers: { 'x-correlation-id': 'corr-1', ...headers } } }) as any;
const again = (ch: any) => ({ content: ch.sendToQueue.mock.calls[0][1], properties: { headers: ch.sendToQueue.mock.calls[0][2].headers } }) as any;

describe('BP2 §3.3 — hoãn thưa + trần theo thời gian', () => {
  afterEach(() => jest.restoreAllMocks());

  it('[BP:T7] (phần a) hoãn 5 lần trong 4 phút (mỗi phút một lần, tầng 1m): tối đa 2 lần deferDelivery; mốc ghi = now + TTL tầng hoãn', async () => {
    const { repo, consumer } = setup();
    const t0 = Date.parse('2026-10-13T10:00:00Z');
    let now = t0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let msg = amqp(buildSlimMsg({ attemptCount: 1 }));
    for (let i = 0; i < 5; i++) {
      now = t0 + i * 60_000;
      const ch = buildChannel();
      await consumer.handleMessage(msg, ch);
      expect(ch.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
      expect(JSON.parse(ch.sendToQueue.mock.calls[0][1].toString()).attemptCount).toBe(1);
      expect(ch.sendToQueue.mock.calls[0][2].headers[CIRCUIT_DEFERRED_SINCE_HEADER]).toBe(t0); // since đặt một lần
      expect(ch.ack).toHaveBeenCalledTimes(1);
      msg = again(ch);
    }
    expect(repo.deferDelivery.mock.calls.length).toBeLessThanOrEqual(2);
    expect(repo.deferDelivery.mock.calls.length).toBeGreaterThanOrEqual(1); // F7: KHÔNG bỏ hẳn
    expect(repo.deferDelivery.mock.calls[0][1].getTime()).toBe(t0 + 60_000);
    // Biên với sweeper: mốc lưu không bao giờ cũ quá ngưỡng quét (PENDING 10 phút, RETRYING 5 phút).
    const lastWrite = repo.deferDelivery.mock.calls.at(-1)![1].getTime();
    expect(t0 + 4 * 60_000 - lastWrite).toBeLessThan(5 * 60_000);
  });

  it('[BP:T7] (phần b) ghi DB lỗi -> không đặt x-defer-written-at mới, lần sau ghi lại', async () => {
    const { repo, consumer } = setup();
    repo.deferDelivery.mockRejectedValueOnce(new Error('db chậm'));
    const ch = buildChannel();
    await consumer.handleMessage(amqp(buildSlimMsg()), ch);
    expect(ch.sendToQueue.mock.calls[0][2].headers).not.toHaveProperty(DEFER_WRITTEN_AT_HEADER);
    const ch2 = buildChannel();
    await consumer.handleMessage(again(ch), ch2);
    expect(repo.deferDelivery).toHaveBeenCalledTimes(2);
    expect(ch2.sendToQueue.mock.calls[0][2].headers[DEFER_WRITTEN_AT_HEADER]).toEqual(expect.any(Number));
  });

  it('[BP:T10] (phần a) message cũ (không destinationId, có x-circuit-deferrals, chưa có since) vẫn chạy: since = now, KHÔNG bị tính quá trần theo số lần cũ', async () => {
    const { repo, consumer } = setup();
    const ch = buildChannel();
    const before = Date.now();
    await consumer.handleMessage(amqp(buildSlimMsg({ attemptCount: 2 }), { [CIRCUIT_DEFERRALS_HEADER]: 30 }), ch);
    expect(repo.findDeliveryForSend).toHaveBeenCalledTimes(1); // đường cũ: nạp rồi mới gate
    expect(repo.claimForSend).not.toHaveBeenCalled(); // không thành lần thử thất bại
    const [queue, content, opts] = ch.sendToQueue.mock.calls[0];
    expect(queue).toBe('q.delivery.retry.1m');
    expect(JSON.parse(content.toString())).toEqual({ ...buildSlimMsg({ attemptCount: 2 }), ...ROW_HINT });
    expect(opts.headers[CIRCUIT_DEFERRALS_HEADER]).toBe(31);
    expect(opts.headers[CIRCUIT_DEFERRED_SINCE_HEADER]).toBeGreaterThanOrEqual(before);
    expect(repo.deferDelivery).toHaveBeenCalledTimes(1);
  });

  it('circuitDeferDecision: since từ header; vượt trần khi quá CIRCUIT_MAX_DEFER_MS; ghi DB khi chưa ghi hoặc đã cũ hơn 2 phút', () => {
    const now = 10_000_000_000;
    expect(circuitDeferDecision({}, now)).toMatchObject({ since: now, exceeded: false, writeDb: true, deferrals: 1 });
    expect(circuitDeferDecision({ [CIRCUIT_DEFERRED_SINCE_HEADER]: now - CIRCUIT_MAX_DEFER_MS }, now).exceeded).toBe(false);
    expect(circuitDeferDecision({ [CIRCUIT_DEFERRED_SINCE_HEADER]: now - CIRCUIT_MAX_DEFER_MS - 1 }, now).exceeded).toBe(true);
    expect(circuitDeferDecision({ [DEFER_WRITTEN_AT_HEADER]: now - 120_000 }, now).writeDb).toBe(false);
    expect(circuitDeferDecision({ [DEFER_WRITTEN_AT_HEADER]: now - 120_001 }, now).writeDb).toBe(true);
    expect(circuitDeferDecision({ [CIRCUIT_DEFERRED_SINCE_HEADER]: 'rác' }, now).since).toBe(now);
    expect(circuitDeferDecision({ [CIRCUIT_DEFERRED_SINCE_HEADER]: now - 600_000 }, now, 300_000).exceeded).toBe(true); // env kẹp thấp
  });
});
