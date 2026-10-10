import { randomUUID } from 'crypto';
import { PrismaService } from '@hub/database';
import { ApiController } from '../src/modules/api/api.controller';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * S2-3 trên Postgres THẬT (RUN_DB_TESTS=1): tập chọn dùng đúng điều kiện DLQ (ADR-031); bản đã replay
 * bị loại; dryRun không ghi; chạy thật N delivery + N outbox + 1 audit; lỗi giữa chừng rollback thật.
 */

describeDb('replay-bulk (Postgres, S2-3)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const controller = new ApiController(svc);
  const tenant = randomUUID();
  const runId = randomUUID().slice(0, 8);
  let destId = '';
  let subId = '';
  const deadIds: string[] = [];
  let supersededId = '';

  const count = async () => {
    const [d] = await raw.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM hub.deliveries WHERE tenant_id = ${tenant}::uuid`;
    const [a] = await raw.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM hub.audit_logs WHERE tenant_id = ${tenant}::uuid`;
    const [o] = await raw.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM hub.outbox WHERE payload->>'tenantId' = ${tenant}`;
    return { deliveries: Number(d.n), audit: Number(a.n), outbox: Number(o.n) };
  };

  beforeAll(async () => {
    destId = (await raw.destination.create({ data: { tenantId: tenant, name: `bulk-${runId}`, type: 'webhook', configEncrypted: 'x' } })).id;
    subId = (await raw.subscription.create({ data: { tenantId: tenant, destinationId: destId, name: `bulk-${runId}`, eventTypes: ['t.bulk'] } })).id;
    for (let i = 0; i < 4; i++) {
      const evt = await raw.event.create({
        data: { id: `BULK${runId}${i}`, tenantId: tenant, idempotencyKey: `bulk:${runId}:${i}`, correlationId: randomUUID(), type: 't.bulk', source: 'test', data: {} },
      });
      const d = await raw.delivery.create({
        data: { tenantId: tenant, eventId: evt.id, subscriptionId: subId, status: 'DEAD', attemptCount: 6, lastError: i === 3 ? 'Non-retryable HTTP 404' : 'Hết 5 lần retry: 500' },
      });
      if (i === 2) {
        // đã được replay trước đó -> có generation 2 -> phải bị loại khỏi tập chọn
        await raw.delivery.create({ data: { tenantId: tenant, eventId: evt.id, subscriptionId: subId, attemptGeneration: 2, status: 'SUCCEEDED' } });
        supersededId = d.id;
      } else deadIds.push(d.id);
    }
  }, 60_000);

  afterAll(async () => {
    await raw.$executeRaw`DELETE FROM hub.outbox WHERE payload->>'tenantId' = ${tenant}`;
    await raw.auditLog.deleteMany({ where: { tenantId: tenant } });
    await raw.delivery.deleteMany({ where: { tenantId: tenant } });
    await raw.event.deleteMany({ where: { tenantId: tenant } });
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('[AF:#29] dryRun: đúng tập (bản đã replay bị loại), bộ lọc errorContains, KHÔNG ghi gì', async () => {
    const before = await count();
    const all: any = await controller.replayBulk(tenant, 'tester', { reason: 'kiểm dryRun', dryRun: true });
    expect(all.count).toBe(3);
    expect(all.sample.map((r: any) => r.id).sort()).toEqual([...deadIds].sort());
    expect(all.sample.map((r: any) => r.id)).not.toContain(supersededId);
    const only404: any = await controller.replayBulk(tenant, 'tester', { reason: 'kiểm dryRun', dryRun: true, errorContains: 'http 404' });
    expect(only404.count).toBe(1);
    expect(await count()).toEqual(before);
  });

  it('lỗi giữa chừng (audit ném) -> rollback THẬT: không thêm delivery/outbox/audit nào', async () => {
    const before = await count();
    const spy = jest.spyOn(svc, 'forTenant').mockImplementation(((tenantId: string, tx?: any) => {
      const repo = (PrismaService.prototype.forTenant as any).call(svc, tenantId, tx);
      if (tx) repo.createAuditLog = async () => { throw new Error('audit lỗi giả'); };
      return repo;
    }) as any);
    await expect(controller.replayBulk(tenant, 'tester', { reason: 'kiểm rollback', dryRun: false })).rejects.toThrow('audit lỗi giả');
    spy.mockRestore();
    expect(await count()).toEqual(before);
  });

  it('chạy thật: 3 delivery mới + 3 outbox + 1 audit; chạy lại -> 0 (đã bị replay thì loại khỏi tập)', async () => {
    const before = await count();
    const res: any = await controller.replayBulk(tenant, 'tester', { reason: 'đích sống lại', dryRun: false });
    expect(res.count).toBe(3);
    expect(await count()).toEqual({ deliveries: before.deliveries + 3, outbox: before.outbox + 3, audit: before.audit + 1 });
    const [audit] = await raw.auditLog.findMany({ where: { tenantId: tenant, action: 'delivery.replay_bulk' } });
    expect(audit).toMatchObject({ actor: 'tester', reason: 'đích sống lại', entityType: 'delivery_batch', entityId: res.batchId });
    expect((audit.metadata as any).deliveryIds.sort()).toEqual([...deadIds].sort());

    const again: any = await controller.replayBulk(tenant, 'tester', { reason: 'chạy lại lần hai', dryRun: false });
    expect(again.count).toBe(0);
  });
});
