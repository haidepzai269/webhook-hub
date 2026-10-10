import { randomUUID } from 'crypto';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * DLQ = DEAD chưa bị replay (ADR-031). Chạy trên Postgres local khi RUN_DB_TESTS=1 (xem timeseries.spec.ts).
 */

describeDb('TenantScopedRepository DLQ (Postgres)', () => {
  const prisma = newTestPrisma();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const runId = randomUUID().slice(0, 8);
  let gen1Id = '';
  let gen2Id = '';
  let otherDeadId = '';

  beforeAll(async () => {
    const dest = await prisma.destination.create({
      data: { tenantId: tenantA, name: `dlq-${runId}`, type: 'webhook', configEncrypted: 'x' },
    });
    const sub = await prisma.subscription.create({
      data: { tenantId: tenantA, destinationId: dest.id, name: `dlq-${runId}`, eventTypes: ['t.test'] },
    });
    const mkEvent = (n: number) =>
      prisma.event.create({
        data: {
          id: `DLQ${runId}${n}`, tenantId: tenantA, idempotencyKey: `dlq:${runId}:${n}`,
          correlationId: randomUUID(), type: 't.test', source: 'test', data: {},
        },
      });
    const e1 = await mkEvent(1);
    const e2 = await mkEvent(2);

    // e1: gen1 DEAD → đã replay thành gen2 (cũng DEAD). Chỉ gen2 được nằm trong DLQ.
    gen1Id = (await prisma.delivery.create({
      data: { tenantId: tenantA, eventId: e1.id, subscriptionId: sub.id, attemptGeneration: 1, status: 'DEAD' },
    })).id;
    gen2Id = (await prisma.delivery.create({
      data: { tenantId: tenantA, eventId: e1.id, subscriptionId: sub.id, attemptGeneration: 2, status: 'DEAD' },
    })).id;
    // e2: DEAD, chưa replay.
    otherDeadId = (await prisma.delivery.create({
      data: { tenantId: tenantA, eventId: e2.id, subscriptionId: sub.id, attemptGeneration: 1, status: 'DEAD' },
    })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.delivery.deleteMany({ where: { tenantId: tenantA } });
    await prisma.event.deleteMany({ where: { tenantId: tenantA } });
    await prisma.subscription.deleteMany({ where: { tenantId: tenantA } });
    await prisma.destination.deleteMany({ where: { tenantId: tenantA } });
    await prisma.$disconnect();
  });

  it('bản DEAD đã bị replay biến khỏi DLQ, bản mới nhất thì có', async () => {
    const repo = new TenantScopedRepository(prisma, tenantA);
    const ids = (await repo.findDeadDeliveries(50)).map((d) => d.id).sort();
    expect(ids).toEqual([gen2Id, otherDeadId].sort());
    expect(ids).not.toContain(gen1Id);
    await expect(repo.countDeadDeliveries()).resolves.toBe(2);
  });

  it('hasNewerGeneration: gen1 đã bị thay thế, gen2 thì chưa', async () => {
    const repo = new TenantScopedRepository(prisma, tenantA);
    const [g1, g2] = await Promise.all([repo.findDeliveryById(gen1Id), repo.findDeliveryById(gen2Id)]);
    await expect(repo.hasNewerGeneration(g1!)).resolves.toBe(true);
    await expect(repo.hasNewerGeneration(g2!)).resolves.toBe(false);
  });

  it('tenant khác không thấy DLQ của A', async () => {
    const repo = new TenantScopedRepository(prisma, tenantB);
    await expect(repo.findDeadDeliveries(50)).resolves.toEqual([]);
    await expect(repo.countDeadDeliveries()).resolves.toBe(0);
  });
});
