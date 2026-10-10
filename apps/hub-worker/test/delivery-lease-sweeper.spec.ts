import { randomUUID } from 'crypto';
import { TenantScopedRepository } from '@hub/database';
import { RETRY_TIERS } from '@hub/messaging';
import { buildSweepSql, LEGACY_RETRY_SWEEP_AFTER_MS } from '../src/scheduler/delivery.sweeper';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * S1-2 trên Postgres THẬT (RUN_DB_TESTS=1, DATABASE_URL trỏ localhost:5433):
 *  - lease: hai lần claimForSend liên tiếp cùng tham số -> lần 2 trả 0;
 *  - sweeper: delivery PENDING 11 phút không attempt -> được ghi outbox; có outbox chưa publish -> không.
 */

describeDb('Lease + sweeper (Postgres, S1-2)', () => {
  const prisma = newTestPrisma('owner');
  // AU6 (SPEC-verification §4.3): fixture bằng owner; repo (code đang test) bằng hub_app -> RLS có hiệu lực.
  const appDb = newTestPrisma('app');
  const tenant = randomUUID();
  const runId = randomUUID().slice(0, 8);
  let subId = '';
  let eventId = '';
  const ids: string[] = [];

  async function mkDelivery(
    gen: number,
    minutesAgo: number,
    status: 'PENDING' | 'DELIVERING' | 'RETRYING' = 'PENDING',
    extra: { attemptCount?: number; nextAttemptMinutesFromNow?: number } = {},
  ) {
    const d = await prisma.delivery.create({
      data: {
        tenantId: tenant,
        eventId,
        subscriptionId: subId,
        attemptGeneration: gen,
        status,
        attemptCount: extra.attemptCount ?? 0,
        nextAttemptAt:
          extra.nextAttemptMinutesFromNow === undefined ? null : new Date(Date.now() + extra.nextAttemptMinutesFromNow * 60_000),
      },
    });
    await prisma.$executeRaw`UPDATE hub.deliveries SET created_at = now() - make_interval(mins => ${minutesAgo}::int),
      updated_at = now() - make_interval(mins => ${minutesAgo}::int) WHERE id = ${d.id}::uuid`;
    ids.push(d.id);
    return d.id;
  }

  const outboxFor = (deliveryId: string) =>
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM hub.outbox
      WHERE topic = 'delivery.requested' AND payload->>'deliveryId' = ${deliveryId}`.then((r) => Number(r[0].n));

  beforeAll(async () => {
    const dest = await prisma.destination.create({
      data: { tenantId: tenant, name: `lease-${runId}`, type: 'webhook', configEncrypted: 'x' },
    });
    subId = (
      await prisma.subscription.create({
        data: { tenantId: tenant, destinationId: dest.id, name: `lease-${runId}`, eventTypes: ['t.lease'] },
      })
    ).id;
    eventId = (
      await prisma.event.create({
        data: {
          id: `LEASE${runId}`,
          tenantId: tenant,
          idempotencyKey: `lease:${runId}`,
          correlationId: randomUUID(),
          type: 't.lease',
          source: 'test',
          data: {},
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    for (const id of ids) {
      await prisma.$executeRaw`DELETE FROM hub.outbox WHERE payload->>'deliveryId' = ${id}`;
    }
    await prisma.delivery.deleteMany({ where: { tenantId: tenant } });
    await prisma.event.deleteMany({ where: { tenantId: tenant } });
    await prisma.subscription.deleteMany({ where: { tenantId: tenant } });
    await prisma.destination.deleteMany({ where: { tenantId: tenant } });
    await prisma.$disconnect();
    await appDb.$disconnect();
  });

  it('[AF:#19] S1-3: findOrphanRawEvents — raw ACCEPTED > 2 phút chưa có event thì là mồ côi; tenant khác không thấy', async () => {
    const src = await prisma.source.create({
      data: { tenantId: tenant, provider: 'sepay', name: `orphan-${runId}`, sourceKey: `src_orphan_${runId}` },
    });
    const mkRaw = (key: string, minutesAgo: number) =>
      prisma.rawEvent
        .create({
          data: { sourceId: src.id, idempotencyKey: key, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: true },
        })
        .then(async (r) => {
          await prisma.$executeRaw`UPDATE hub.raw_events SET received_at = now() - make_interval(mins => ${minutesAgo}::int) WHERE id = ${r.id}::uuid`;
          return r.id;
        });
    const orphan = await mkRaw(`o1-${runId}`, 5);
    const fresh = await mkRaw(`o2-${runId}`, 0);
    const repo = new TenantScopedRepository(appDb, tenant);
    const res = await repo.findOrphanRawEvents({ limit: 100 });
    expect(res.items.map((r) => r.id)).toEqual([orphan]);
    expect(res.total).toBe(1);
    expect((await repo.findOrphanRawEvents({ limit: 100, ids: [fresh] })).items).toHaveLength(0);
    expect((await new TenantScopedRepository(appDb, randomUUID()).findOrphanRawEvents({ limit: 100 })).total).toBe(0);
    await prisma.source.delete({ where: { id: src.id } });
  });

  it('claimForSend: lần 1 = 1, lần 2 cùng tham số = 0; tenant khác = 0', async () => {
    const id = await mkDelivery(1, 0);
    const repo = new TenantScopedRepository(appDb, tenant);
    expect(await new TenantScopedRepository(appDb, randomUUID()).claimForSend(id, 1, 0)).toBe(0);
    expect(await repo.claimForSend(id, 1, 0)).toBe(1);
    expect(await repo.claimForSend(id, 1, 0)).toBe(0);
    // attemptCount lệch (message cũ của tầng trước) cũng không nhận được
    expect(await repo.claimForSend(id, 1, 5)).toBe(0);
  });

  it('claimForSend nhận lại DELIVERING đã treo quá lease 60s', async () => {
    const id = await mkDelivery(2, 2, 'DELIVERING');
    expect(await new TenantScopedRepository(appDb, tenant).claimForSend(id, 2, 0)).toBe(1);
  });

  it('[AF:#17] sweeper: PENDING 11 phút không attempt -> có outbox; có outbox chưa publish -> không ghi thêm; PENDING mới -> không', async () => {
    const stuck = await mkDelivery(3, 11);
    const hasPending = await mkDelivery(4, 11);
    await prisma.outbox.create({
      data: { topic: 'delivery.requested', payload: { deliveryId: hasPending, tenantId: tenant, attemptGeneration: 4, attemptCount: 0, correlationId: 'x' } },
    });
    const fresh = await mkDelivery(5, 1);

    await prisma.$executeRaw(buildSweepSql(10 * 60_000, 10_000));

    expect(await outboxFor(stuck)).toBe(1);
    expect(await outboxFor(hasPending)).toBe(1); // vẫn chỉ dòng có sẵn
    expect(await outboxFor(fresh)).toBe(0);

    const [row] = await prisma.$queryRaw<{ payload: any }[]>`SELECT payload FROM hub.outbox WHERE payload->>'deliveryId' = ${stuck}`;
    expect(Object.keys(row.payload).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'tenantId']);
    expect(row.payload).toMatchObject({ tenantId: tenant, attemptGeneration: 3, attemptCount: 0 });

    // Chạy lại ngay: dòng vừa ghi còn chưa publish -> không nhân bản
    await prisma.$executeRaw(buildSweepSql(10 * 60_000, 10_000));
    expect(await outboxFor(stuck)).toBe(1);
  });

  // --- S2 (review SPEC-1 #1, #2): RETRYING kẹt theo next_attempt_at; PENDING bị circuit hoãn không bị nhân bản ---

  it('sweeper RETRYING: next_attempt_at quá hạn > 5 phút -> outbox với attemptCount = attempt_count TRONG DB; chưa quá hạn -> không', async () => {
    // Kịch bản #1: worker COMMIT RETRYING (attempt_count=2, processed_messages(...:2)) rồi chết trước sendToQueue.
    const stuck = await mkDelivery(10, 30, 'RETRYING', { attemptCount: 2, nextAttemptMinutesFromNow: -6 });
    const waiting = await mkDelivery(11, 30, 'RETRYING', { attemptCount: 2, nextAttemptMinutesFromNow: 20 });
    const graceNotPassed = await mkDelivery(12, 30, 'RETRYING', { attemptCount: 1, nextAttemptMinutesFromNow: -2 });

    await prisma.$executeRaw(buildSweepSql(10 * 60_000, 10_000, 5 * 60_000));

    expect(await outboxFor(stuck)).toBe(1);
    expect(await outboxFor(waiting)).toBe(0);
    expect(await outboxFor(graceNotPassed)).toBe(0);
    const [row] = await prisma.$queryRaw<{ payload: any }[]>`SELECT payload FROM hub.outbox WHERE payload->>'deliveryId' = ${stuck}`;
    expect(row.payload).toMatchObject({ attemptGeneration: 10, attemptCount: 2 });

    // Chạy lại: đã có outbox chưa publish -> không nhân bản
    await prisma.$executeRaw(buildSweepSql(10 * 60_000, 10_000, 5 * 60_000));
    expect(await outboxFor(stuck)).toBe(1);
  });

  // --- Review SPEC-2 (thấp): RETRYING có từ trước cột next_attempt_at (NULL) ---

  it('ngưỡng RETRYING legacy (3h) lớn hơn tầng retry dài nhất', () => {
    expect(LEGACY_RETRY_SWEEP_AFTER_MS).toBe(3 * 3600_000);
    expect(LEGACY_RETRY_SWEEP_AFTER_MS).toBeGreaterThan(Math.max(...RETRY_TIERS.map((t) => t.ttlMs)));
  });

  it('sweeper RETRYING next_attempt_at NULL: updated_at > 3h -> có outbox; < 3h (vd 2h59) -> không', async () => {
    const legacyStuck = await mkDelivery(20, 3 * 60 + 5, 'RETRYING', { attemptCount: 4 });
    const legacyWaiting = await mkDelivery(21, 2 * 60 + 59, 'RETRYING', { attemptCount: 5 });

    await prisma.$executeRaw(buildSweepSql(10 * 60_000, 10_000, 5 * 60_000));

    expect(await outboxFor(legacyStuck)).toBe(1);
    expect(await outboxFor(legacyWaiting)).toBe(0);
    const [row] = await prisma.$queryRaw<{ payload: any }[]>`SELECT payload FROM hub.outbox WHERE payload->>'deliveryId' = ${legacyStuck}`;
    expect(row.payload).toMatchObject({ attemptGeneration: 20, attemptCount: 4 });

    await prisma.$executeRaw(buildSweepSql(10 * 60_000, 10_000, 5 * 60_000));
    expect(await outboxFor(legacyStuck)).toBe(1);
  });

  it('lease chặn gửi trùng khi message gốc VẪN còn trong queue: bản sweeper và bản gốc cùng attemptCount -> chỉ một claim được', async () => {
    const id = await mkDelivery(13, 30, 'RETRYING', { attemptCount: 2, nextAttemptMinutesFromNow: -6 });
    const repo = new TenantScopedRepository(appDb, tenant);
    // bản do sweeper ghi (attemptCount=2) tới trước
    expect(await repo.claimForSend(id, 13, 2)).toBe(1);
    // bản gốc (cũng attemptCount=2) tới trong lúc đang gửi -> thua lease
    expect(await repo.claimForSend(id, 13, 2)).toBe(0);
    expect(await repo.getDeliveryLeaseState(id)).toMatchObject({ status: 'DELIVERING', attemptCount: 2 });
    // lần gửi xong, ghi RETRYING attempt_count=3 -> bản gốc tới muộn vẫn thua (attemptCount lệch)
    await repo.updateDeliveryStatus(id, { status: 'RETRYING', attemptCount: 3 });
    expect(await repo.claimForSend(id, 13, 2)).toBe(0);
    // message của lần kế (attemptCount=3) thì nhận được
    expect(await repo.claimForSend(id, 13, 3)).toBe(1);
  });

  it('sweeper PENDING: delivery bị circuit hoãn (next_attempt_at mới ghi) KHÔNG bị quét dù đã > 10 phút không attempt', async () => {
    const deferred = await mkDelivery(14, 15, 'PENDING', { nextAttemptMinutesFromNow: 1 });
    const repo = new TenantScopedRepository(appDb, tenant);
    expect(await repo.deferDelivery(deferred, new Date(Date.now() + 60_000))).toBe(1);
    await prisma.$executeRaw(buildSweepSql(10 * 60_000, 10_000, 5 * 60_000));
    expect(await outboxFor(deferred)).toBe(0);
  });

  it('updateDestinationCircuitState: chỉ đổi khi khác giá trị (1 rồi 0); tenant khác = 0', async () => {
    const dest = await prisma.destination.create({
      data: { tenantId: tenant, name: `circuit-${runId}`, type: 'webhook', configEncrypted: 'x' },
    });
    const repo = new TenantScopedRepository(appDb, tenant);
    expect(await new TenantScopedRepository(appDb, randomUUID()).updateDestinationCircuitState(dest.id, 'OPEN')).toBe(0);
    expect(await repo.updateDestinationCircuitState(dest.id, 'OPEN')).toBe(1);
    expect(await repo.updateDestinationCircuitState(dest.id, 'OPEN')).toBe(0);
    expect(await repo.updateDestinationCircuitState(dest.id, 'HALF_OPEN')).toBe(1);
    await prisma.destination.delete({ where: { id: dest.id } });
  });
});
