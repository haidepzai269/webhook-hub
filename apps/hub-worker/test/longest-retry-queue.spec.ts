jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

// Mô phỏng ai đó SẮP LẠI thứ tự RETRY_TIERS mà không cố ý. S2-1: circuit OPEN hoãn vào tầng
// NGẮN NHẤT có TTL >= 60s — phải chọn theo GIÁ TRỊ TTL ('q.delivery.retry.1m'), không theo vị trí.
// (Trước S2-1 circuit OPEN đẩy vào tầng 2h — hoãn 2 giờ cho một circuit chỉ mở 60s.)
jest.mock('@hub/messaging', () => {
  const actual = jest.requireActual('@hub/messaging');
  const reordered = [
    { queueName: 'q.delivery.retry.2h', ttlMs: 7200000, attempt: 5 },
    { queueName: 'q.delivery.retry.10s', ttlMs: 10000, attempt: 1 },
    { queueName: 'q.delivery.retry.1m', ttlMs: 60000, attempt: 2 },
    { queueName: 'q.delivery.retry.5m', ttlMs: 300000, attempt: 3 },
    { queueName: 'q.delivery.retry.30m', ttlMs: 1800000, attempt: 4 },
  ];
  return { ...actual, RETRY_TIERS: reordered };
});

import { DeliveryConsumer } from '../src/consumers/delivery.consumer';
import { SenderRegistry } from '../src/senders/sender.registry';
import { buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg, toAmqpMsg } from './delivery-fixtures';

describe('Hoãn vì circuit OPEN -- chọn tầng theo TTL, không theo vị trí mảng (S2-1)', () => {
  it('RETRY_TIERS bị sắp lại vẫn chọn q.delivery.retry.1m (TTL 60s = thời gian OPEN), không phải 2h hay phần tử đầu/cuối', async () => {
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue({
        findDeliveryForSend: jest.fn().mockResolvedValue(buildDeliveryRow()),
        claimForSend: jest.fn().mockResolvedValue(1),
        updateDeliveryStatus: jest.fn().mockResolvedValue({}),
        deferDelivery: jest.fn().mockResolvedValue(1),
      }),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (fn: any) => fn({})),
    };
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('OPEN'));
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledWith('q.delivery.retry.1m', expect.anything(), expect.anything());
    for (const q of ['q.delivery.retry.2h', 'q.delivery.retry.30m', 'q.delivery.retry.10s']) {
      expect(channel.sendToQueue).not.toHaveBeenCalledWith(q, expect.anything(), expect.anything());
    }
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });
});
