jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import { DeliveryConsumer } from '../src/consumers/delivery.consumer';
import { SenderRegistry } from '../src/senders/sender.registry';
import { DELIVERY_ID, buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg, toAmqpMsg } from './delivery-fixtures';

/**
 * ADR-161 (T3): đích đã LƯU TRỮ ("Xoá" trên bản đồ luồng) -> worker KHÔNG gửi; delivery thành DEAD kèm lý do
 * `destination_archived`, ack. Đích chỉ "Ngắt" (is_active=false) -> delivery đang bay vẫn gửi nốt.
 */
describe('DeliveryConsumer — đích đã lưu trữ (ADR-161)', () => {
  function setup(destPatch: Record<string, unknown>) {
    const row: any = buildDeliveryRow();
    Object.assign(row.subscription.destination, destPatch);
    const repo = {
      findDeliveryForSend: jest.fn().mockResolvedValue(row),
      abandonDelivery: jest.fn().mockResolvedValue(1),
      claimForSend: jest.fn().mockResolvedValue(1),
      updateDeliveryStatus: jest.fn().mockResolvedValue({}),
      deferDelivery: jest.fn().mockResolvedValue(1),
      getDeliveryLeaseState: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', attemptGeneration: 1, attemptCount: 1 }),
    };
    const tx = {
      deliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
      delivery: { findFirst: jest.fn().mockResolvedValue({ id: DELIVERY_ID }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processedMessage: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue(repo),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantTx(_t: any, fn: any, o?: any) {
        return this.$transaction(fn, o);
      },
      systemTx(_r: any, fn: any) {
        return this.$transaction(fn);
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const send = jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 5 });
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send } as any);
    return { consumer: new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED')), repo, send };
  }

  afterEach(() => jest.restoreAllMocks());

  it('đích lưu trữ -> abandonDelivery(DEAD, destination_archived), không gửi, không claim, ack', async () => {
    const { consumer, repo, send } = setup({ archivedAt: new Date(), isActive: false });
    const ch = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), ch);
    expect(repo.abandonDelivery).toHaveBeenCalledWith(DELIVERY_ID, expect.stringMatching(/^destination_archived/));
    expect(repo.claimForSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledTimes(1);
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it('đích chỉ Ngắt (is_active=false, chưa lưu trữ) -> delivery đang bay vẫn gửi nốt', async () => {
    const { consumer, repo, send } = setup({ archivedAt: null, isActive: false });
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), buildChannel());
    expect(repo.abandonDelivery).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
