jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import { DELIVERY_MESSAGE_KEYS, buildDeliveryMessage, parseDeliveryMessage } from '@hub/common';
import { buildSweepSql } from '../src/scheduler/delivery.sweeper';
import { DeliveryConsumer } from '../src/consumers/delivery.consumer';
import { buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg } from './delivery-fixtures';

/**
 * BP2 §3.1 (ADR-196): message giao hàng mang GỢI Ý `destinationId` + `rateLimitRps` để gate trước khi nạp DB.
 * Mọi nơi tạo message đều điền (normalize/hub.* qua route-event, sweeper, replay đơn + hàng loạt, slim() khi republish).
 */
describe('BP2 — gợi ý destinationId/rateLimitRps trong message giao hàng', () => {
  it('[BP:T5] (phần c) sweeper: câu SQL ghi destinationId + rateLimitRps vào payload outbox (join subscriptions/destinations)', () => {
    const sql = buildSweepSql(10 * 60_000).strings.join('?');
    expect(sql).toMatch(/'destinationId', sub\.destination_id::text/);
    expect(sql).toMatch(/'rateLimitRps', dst\.rate_limit_rps/);
    expect(sql).toMatch(/JOIN hub\.subscriptions sub ON sub\.id = s\.subscription_id/);
    expect(sql).toMatch(/JOIN hub\.destinations dst ON dst\.id = sub\.destination_id/);
  });

  it('[BP:T5] (phần d) build/parse giữ gợi ý; slim() khi republish giữ gợi ý; không có khoá lạ', async () => {
    const msg = buildDeliveryMessage({ ...buildSlimMsg(), destinationId: 'dest-9', rateLimitRps: 5 } as any);
    expect(Object.keys(msg).sort()).toEqual([...DELIVERY_MESSAGE_KEYS].sort());
    expect(parseDeliveryMessage(Buffer.from(JSON.stringify(msg)))).toEqual(msg);

    // Republish (hoãn circuit) dựng lại bằng slim() -> gợi ý còn nguyên.
    const repo = {
      findDeliveryForSend: jest.fn().mockResolvedValue(buildDeliveryRow()),
      deferDelivery: jest.fn().mockResolvedValue(1),
    };
    const prisma: any = { forTenant: jest.fn().mockReturnValue(repo) };
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('OPEN'));
    const ch = buildChannel();
    await consumer.handleMessage({ content: Buffer.from(JSON.stringify(msg)), properties: { headers: {} } } as any, ch);
    const out = JSON.parse(ch.sendToQueue.mock.calls[0][1].toString());
    expect(out).toMatchObject({ destinationId: 'dest-9', rateLimitRps: 5 });
  });

  it('message cũ (không gợi ý) vẫn đọc được, không bịa gợi ý; gợi ý bậy bị bỏ', () => {
    const old = parseDeliveryMessage(Buffer.from(JSON.stringify(buildSlimMsg())));
    expect(old).not.toHaveProperty('destinationId');
    expect(old).not.toHaveProperty('rateLimitRps');
    const bad = parseDeliveryMessage(Buffer.from(JSON.stringify({ ...buildSlimMsg(), destinationId: 42, rateLimitRps: -1 })));
    expect(bad).not.toHaveProperty('destinationId');
    expect(bad).not.toHaveProperty('rateLimitRps');
    expect(parseDeliveryMessage(Buffer.from(JSON.stringify({ ...buildSlimMsg(), rateLimitRps: 2.5 })))).not.toHaveProperty('rateLimitRps');
  });
});
