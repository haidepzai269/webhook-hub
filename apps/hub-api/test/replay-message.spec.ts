import { ApiController } from '../src/modules/api/api.controller';

/**
 * S1-1: replay ghi vào hub.outbox CHỈ message tham chiếu — không config, signingSecret, event.
 * (Trước đây payload outbox chứa cấu hình đích + signing secret đã giải mã, nằm nguyên trong Postgres.)
 */
describe('POST /api/v1/deliveries/:id/replay — outbox không chứa secret (S1-1)', () => {
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const DELIVERY = '33333333-3333-3333-3333-333333333333';

  it('payload outbox delivery.replayed chỉ có 5 khoá tham chiếu', async () => {
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
        subscription: { destination: { id: 'd', configEncrypted: 'iv:ct:tag', signingSecretEncrypted: 'iv:ct:tag' } },
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
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const res = await new ApiController(prisma).replayDelivery(TENANT, 'admin', DELIVERY, { reason: 'đích đã sửa' });

    expect(res.generation).toBe(2);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].topic).toBe('delivery.replayed');
    const payload = outboxRows[0].payload;
    expect(Object.keys(payload).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'tenantId']);
    expect(payload).toMatchObject({ tenantId: TENANT, attemptGeneration: 2, attemptCount: 0, correlationId: 'corr-1' });
    expect(JSON.stringify(payload)).not.toMatch(/config|signingSecret|"event"/);
    // S2-3: audit trong CÙNG transaction (tx), có actor + reason
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ tenantId: TENANT, action: 'delivery.replay', entityId: DELIVERY, actor: 'admin', reason: 'đích đã sửa' });
  });
});
