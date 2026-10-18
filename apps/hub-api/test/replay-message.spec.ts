import { ApiController } from '../src/modules/api/api.controller';

/**
 * S1-1: replay ghi vào hub.outbox CHỈ message tham chiếu — không config, signingSecret, event.
 * (Trước đây payload outbox chứa cấu hình đích + signing secret đã giải mã, nằm nguyên trong Postgres.)
 */
describe('POST /api/v1/deliveries/:id/replay — outbox không chứa secret (S1-1)', () => {
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const DELIVERY = '33333333-3333-3333-3333-333333333333';

  it('[BP:T5] (phần e) payload outbox delivery.replayed chỉ có 5 khoá tham chiếu + gợi ý gate BP2 (destinationId, rateLimitRps), không secret', async () => {
    const outboxRows: any[] = [];
    const repo = {
      findDeliveryById: jest.fn().mockResolvedValue({
        id: DELIVERY,
        tenantId: TENANT,
        status: 'DEAD',
        eventId: 'evt-1',
        subscriptionId: 'sub-1',
        attemptGeneration: 1,
        event: { id: 'evt-1', correlationId: 'corr-1' },
        subscription: { destination: { id: 'd', rateLimitRps: 3, configEncrypted: 'iv:ct:tag', signingSecretEncrypted: 'iv:ct:tag' } },
      }),
      hasNewerGeneration: jest.fn().mockResolvedValue(false),
      createDelivery: jest.fn().mockResolvedValue({}),
    };
    const auditRows: any[] = [];
    const tx = {
      outbox: { create: jest.fn(async ({ data }: any) => outboxRows.push(data)) },
      auditLog: { create: jest.fn(async ({ data }: any) => auditRows.push(data)) },
    };
    const prisma: any = {
      forTenant: jest.fn((t: string, client?: any) => (client ? { ...repo, createAuditLog: (d: any) => client.auditLog.create({ data: { ...d, tenantId: t } }) } : repo)),
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const res = await new ApiController(prisma).replayDelivery(TENANT, 'admin', DELIVERY, { reason: 'đích đã sửa' });

    expect(res.generation).toBe(2);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].topic).toBe('delivery.replayed');
    const payload = outboxRows[0].payload;
    // LOGGING.md §4: + `traceparent` (replay = trace MỚI) [+ `replayOf` khi correlationId là UUID]; relay đưa vào HEADER, body vẫn 7 khoá.
    expect(Object.keys(payload).filter((k) => k !== 'replayOf').sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'destinationId', 'rateLimitRps', 'tenantId', 'traceparent']);
    expect(payload.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(payload).toMatchObject({ tenantId: TENANT, attemptGeneration: 2, attemptCount: 0, correlationId: 'corr-1', destinationId: 'd', rateLimitRps: 3 });
    expect(JSON.stringify(payload)).not.toMatch(/config|signingSecret|"event"/);
    // S2-3: audit trong CÙNG transaction (tx), có actor + reason
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ tenantId: TENANT, action: 'delivery.replay', entityId: DELIVERY, actor: 'admin', reason: 'đích đã sửa' });
  });

  it('m-3: correlationId UUID -> replayOf = trace_id gốc, traceparent mang trace_id MỚI (replay = trace mới có link)', async () => {
    const CORR = '3f2a9c1e-5b7d-4a08-b6c1-d2e3f4a5b6c7';
    const outboxRows: any[] = [];
    const repo = {
      findDeliveryById: jest.fn().mockResolvedValue({ id: DELIVERY, tenantId: TENANT, status: 'DEAD', eventId: 'evt-1', subscriptionId: 'sub-1', attemptGeneration: 1, event: { id: 'evt-1', correlationId: CORR }, subscription: { destination: { id: 'd', rateLimitRps: 3 } } }),
      hasNewerGeneration: jest.fn().mockResolvedValue(false),
      createDelivery: jest.fn().mockResolvedValue({}),
    };
    const tx = { outbox: { create: jest.fn(async ({ data }: any) => outboxRows.push(data)) }, auditLog: { create: jest.fn() } };
    const prisma: any = {
      forTenant: jest.fn((t: string, client?: any) => (client ? { ...repo, createAuditLog: jest.fn() } : repo)),
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    await new ApiController(prisma).replayDelivery(TENANT, 'admin', DELIVERY, { reason: 'đích đã sửa' });
    const p = outboxRows[0].payload;
    expect(p.replayOf).toBe('3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7');
    expect(p.traceparent.split('-')[1]).not.toBe(p.replayOf);
    expect(p.correlationId).toBe(CORR);
  });

  it('[QT:T20] (phần a) event đã "Dọn" (trimmed_at) -> 409 event_trimmed, KHÔNG tạo delivery/outbox', async () => {
    const repo = {
      findDeliveryById: jest.fn().mockResolvedValue({
        id: DELIVERY,
        tenantId: TENANT,
        status: 'DEAD',
        eventId: 'evt-1',
        subscriptionId: 'sub-1',
        attemptGeneration: 1,
        event: { id: 'evt-1', correlationId: 'corr-1', trimmedAt: new Date() },
        subscription: { destination: { id: 'd' } },
      }),
      hasNewerGeneration: jest.fn().mockResolvedValue(false),
      createDelivery: jest.fn(),
    };
    const prisma: any = { forTenant: jest.fn(() => repo), tenantTx: jest.fn(), $transaction: jest.fn() };
    let err: any;
    try {
      await new ApiController(prisma).replayDelivery(TENANT, 'admin', DELIVERY, {});
    } catch (e) {
      err = e;
    }
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ error: 'event_trimmed' });
    expect(repo.createDelivery).not.toHaveBeenCalled();
    expect(prisma.tenantTx).not.toHaveBeenCalled();
  });
});
