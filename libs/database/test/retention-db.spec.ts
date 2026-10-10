import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma.service';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * S7 + DINH-CHINH §3 (ADR-077) trên Postgres THẬT: xoá `events` quá N ngày kéo theo deliveries + attempts,
 * raw_events ACCEPTED CÒN NGUYÊN (ADR-045), và raw cũ hơn N ngày không bị báo "orphan" giả.
 */
describeDb('Retention events (S7)', () => {
  const raw = newTestPrisma();
  const svc = new PrismaService();
  const tenant = randomUUID();
  const run = randomUUID().slice(0, 8);
  const DAY = 86_400;
  const ago = (days: number) => new Date(Date.now() - days * DAY * 1000);
  let sourceId = '';
  let subId = '';

  beforeAll(async () => {
    sourceId = (await raw.source.create({ data: { tenantId: tenant, provider: 'api', name: `r-${run}`, sourceKey: `ret_${run}` } })).id;
    const dest = await raw.destination.create({ data: { tenantId: tenant, name: `d-${run}`, type: 'webhook', configEncrypted: 'x' } });
    subId = (await raw.subscription.create({ data: { tenantId: tenant, destinationId: dest.id, name: `s-${run}`, eventTypes: ['*'] } })).id;
  });

  afterAll(async () => {
    await raw.delivery.deleteMany({ where: { tenantId: tenant } });
    await raw.event.deleteMany({ where: { tenantId: tenant } });
    await raw.rawEvent.deleteMany({ where: { sourceId } });
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.source.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  async function eventWithRaw(name: string, days: number) {
    const r = await raw.rawEvent.create({
      data: { sourceId, idempotencyKey: `${run}:${name}`, headers: {}, body: {}, bodyRaw: new Uint8Array(), signatureValid: true, status: 'ACCEPTED', receivedAt: ago(days) },
    });
    const e = await raw.event.create({
      data: { id: `ret_${run}_${name}`, tenantId: tenant, rawEventId: r.id, idempotencyKey: `ret:${run}:${name}`, correlationId: randomUUID(), type: 'order.x', source: 'api', data: {}, receivedAt: ago(days), createdAt: ago(days) },
    });
    const d = await raw.delivery.create({ data: { tenantId: tenant, eventId: e.id, subscriptionId: subId, status: 'SUCCEEDED' } });
    await raw.deliveryAttempt.create({ data: { deliveryId: d.id, attemptNo: 1, durationMs: 1 } });
    return { raw: r, event: e, delivery: d };
  }

  it('[MS:T13] (phần b) xoá event quá N ngày + delivery + attempt; event mới còn; raw ACCEPTED còn nguyên; orphan không báo raw cũ', async () => {
    const old = await eventWithRaw('old', 10);
    const fresh = await eventWithRaw('fresh', 1);
    // Lô nhỏ, lặp tới khi hết dòng của tenant này (DB dùng chung với test khác: không assert số tuyệt đối)
    while ((await svc.deleteExpiredEventsBatch(9 * DAY, 1000)) > 0) {
      /* tiếp */
    }
    expect(await raw.event.findUnique({ where: { id: old.event.id } })).toBeNull();
    expect(await raw.delivery.findUnique({ where: { id: old.delivery.id } })).toBeNull();
    expect(await raw.deliveryAttempt.count({ where: { deliveryId: old.delivery.id } })).toBe(0);
    expect(await raw.event.findUnique({ where: { id: fresh.event.id } })).not.toBeNull();
    expect(await raw.rawEvent.findUnique({ where: { id: old.raw.id } })).toMatchObject({ status: 'ACCEPTED' });

    const orphans = await new TenantScopedRepository(raw, tenant).findOrphanRawEvents({ limit: 100, maxAgeSeconds: 9 * DAY });
    expect(orphans.items.map((o) => o.id)).not.toContain(old.raw.id);
  });
});
