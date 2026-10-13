jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import { CIRCUIT_DEFERRED_SINCE_HEADER, DeliveryConsumer } from '../src/consumers/delivery.consumer';
import { SenderRegistry } from '../src/senders/sender.registry';
import { CIRCUIT_MAX_DEFER_MS } from '@hub/messaging';
import { buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg } from './delivery-fixtures';

/**
 * BP2 §3.2 (ADR-196, C9): gate TRƯỚC khi nạp DB theo gợi ý `destinationId` + `rateLimitRps`; gợi ý luôn kiểm lại với row thật.
 * Row giả: đích thật `dest-1`, rps 0 (buildDeliveryRow).
 */
type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
function setup(states: Record<string, State>, opts: { probe?: boolean; throttleAllowed?: boolean; row?: any } = {}) {
  const row = opts.row === undefined ? buildDeliveryRow() : opts.row;
  const tx = {
    deliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
    delivery: { findFirst: jest.fn().mockResolvedValue({ id: 'x' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    processedMessage: { create: jest.fn().mockResolvedValue({}) },
  };
  const repo = {
    findDeliveryForSend: jest.fn().mockResolvedValue(row),
    claimForSend: jest.fn().mockResolvedValue(1),
    deferDelivery: jest.fn().mockResolvedValue(1),
    getDeliveryLeaseState: jest.fn(),
  };
  const prisma: any = {
    forTenant: jest.fn().mockReturnValue(repo),
    processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
    tenantTx: (_t: any, fn: any) => fn(tx),
  };
  const cb = buildFakeCircuitBreaker('CLOSED', { probe: opts.probe });
  cb.getState.mockImplementation(async (id: string, rps: number) => {
    const state = states[id] ?? 'CLOSED';
    const v: any = { state, failures: state === 'CLOSED' ? 0 : 5 };
    if (state === 'CLOSED' && rps > 0) v.throttleAllowed = opts.throttleAllowed ?? true;
    return v;
  });
  cb.recheckThrottle = jest.fn(async (_id: string, v: any) => v);
  const send = jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 3 });
  jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send } as any);
  return { consumer: new DeliveryConsumer(prisma, cb), repo, tx, cb, send };
}
const amqp = (body: unknown, headers: Record<string, unknown> = {}) =>
  ({ content: Buffer.from(JSON.stringify(body)), properties: { headers: { 'x-correlation-id': 'corr-1', ...headers } } }) as any;
const hinted = (destinationId: string, rateLimitRps = 0, extra: Record<string, unknown> = {}) => buildSlimMsg({ destinationId, rateLimitRps, ...extra });

describe('BP2 §3.2 — gate trước khi nạp DB', () => {
  afterEach(() => jest.restoreAllMocks());

  it('[BP:T6] (phần b) OPEN theo gợi ý: hoãn retry.1m, KHÔNG nạp row, KHÔNG gửi, attemptCount giữ nguyên; HALF_OPEN không giành probe cũng vậy', async () => {
    for (const [state, probe] of [['OPEN', true], ['HALF_OPEN', false]] as const) {
      const { consumer, repo, send, cb } = setup({ 'dest-1': state }, { probe });
      const ch = buildChannel();
      await consumer.handleMessage(amqp(hinted('dest-1', 0, { attemptCount: 3 })), ch);
      expect(repo.findDeliveryForSend).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(cb.getState).toHaveBeenCalledTimes(1);
      expect(ch.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
      expect(JSON.parse(ch.sendToQueue.mock.calls[0][1].toString())).toMatchObject({ attemptCount: 3, destinationId: 'dest-1', rateLimitRps: 0 });
      expect(ch.ack).toHaveBeenCalledTimes(1);
    }
  });

  it('[BP:T6] (phần c) vượt throttle theo gợi ý: retry.10s, KHÔNG nạp row, KHÔNG ghi DB', async () => {
    const { consumer, repo } = setup({}, { throttleAllowed: false });
    const ch = buildChannel();
    await consumer.handleMessage(amqp(hinted('dest-1', 5)), ch);
    expect(repo.findDeliveryForSend).not.toHaveBeenCalled();
    expect(repo.deferDelivery).not.toHaveBeenCalled();
    expect(ch.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.10s');
  });

  it('CLOSED theo gợi ý đúng: nạp row, gửi, gate ĐÚNG một lần (không gọi getState lần hai -> không đếm throttle hai lần)', async () => {
    const { consumer, send, cb } = setup({});
    const ch = buildChannel();
    await consumer.handleMessage(amqp(hinted('dest-1', 0)), ch);
    expect(send).toHaveBeenCalledTimes(1);
    expect(cb.getState).toHaveBeenCalledTimes(1);
    expect(cb.recheckThrottle).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledTimes(1);
  });

  it('[BP:T11] (phần a) gợi ý destinationId KHÁC row (subscription đổi đích): gate lại với id thật; đích thật OPEN -> KHÔNG gửi nhầm, hoãn với gợi ý đã sửa', async () => {
    const { consumer, send, cb } = setup({ 'dest-stale': 'CLOSED', 'dest-1': 'OPEN' });
    const ch = buildChannel();
    await consumer.handleMessage(amqp(hinted('dest-stale', 0)), ch);
    expect(cb.getState.mock.calls.map((c: any[]) => c[0])).toEqual(['dest-stale', 'dest-1']);
    expect(send).not.toHaveBeenCalled();
    expect(ch.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
    expect(JSON.parse(ch.sendToQueue.mock.calls[0][1].toString())).toMatchObject({ destinationId: 'dest-1' }); // gợi ý đã sửa
  });

  it('[BP:T11] (phần b) gợi ý trỏ đích cũ đang OPEN, đích thật sống: hoãn tới trần thời gian rồi nạp, gate lại -> GỬI, không ghi lần thử thất bại oan', async () => {
    const { consumer, send, tx } = setup({ 'dest-stale': 'OPEN', 'dest-1': 'CLOSED' });
    const ch = buildChannel();
    await consumer.handleMessage(amqp(hinted('dest-stale', 0), { [CIRCUIT_DEFERRED_SINCE_HEADER]: Date.now() - CIRCUIT_MAX_DEFER_MS - 1000 }), ch);
    expect(send).toHaveBeenCalledTimes(1);
    const attempt = tx.deliveryAttempt.create.mock.calls[0][0].data;
    expect(attempt.responseStatus).toBe(200);
    expect(attempt.error).toBeUndefined();
  });

  it('[BP:T11] (phần c) gợi ý rps LỆCH: kiểm throttle lại với rps thật (recheckThrottle), không gate lần hai', async () => {
    const row = buildDeliveryRow({ rateLimitRps: 10 });
    const { consumer, cb, send } = setup({}, { row });
    await consumer.handleMessage(amqp(hinted('dest-1', 5)), buildChannel());
    expect(cb.getState).toHaveBeenCalledTimes(1);
    expect(cb.recheckThrottle).toHaveBeenCalledWith('dest-1', expect.objectContaining({ state: 'CLOSED' }), 10);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('HALF_OPEN theo gợi ý + giành được probe: nạp row, gửi (probe); delivery đã mất -> NHẢ probe', async () => {
    const a = setup({ 'dest-1': 'HALF_OPEN' }, { probe: true });
    await a.consumer.handleMessage(amqp(hinted('dest-1', 0)), buildChannel());
    expect(a.cb.tryAcquireProbe).toHaveBeenCalledWith('dest-1');
    expect(a.send).toHaveBeenCalledTimes(1);

    const b = setup({ 'dest-1': 'HALF_OPEN' }, { probe: true, row: null });
    const ch = buildChannel();
    await b.consumer.handleMessage(amqp(hinted('dest-1', 0)), ch);
    expect(b.cb.releaseProbe).toHaveBeenCalledWith('dest-1', 'probe-token');
    expect(ch.ack).toHaveBeenCalledTimes(1);
  });

  it('[BP:T10] (phần b) message thiếu gợi ý (hoặc chỉ có destinationId, không rps) -> đường cũ: nạp row rồi mới gate', async () => {
    for (const body of [buildSlimMsg(), buildSlimMsg({ destinationId: 'dest-1' })]) {
      const { consumer, repo, cb, send } = setup({});
      await consumer.handleMessage(amqp(body), buildChannel());
      expect(repo.findDeliveryForSend.mock.invocationCallOrder[0]).toBeLessThan(cb.getState.mock.invocationCallOrder[0]);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
