import { randomUUID } from 'crypto';
import { TenantScopedRepository } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { longPoll } from '../src/modules/service-api/polling';

/**
 * S7 (SPEC §4.5, ADR-077) trên Postgres THẬT: polling theo cursor `seq` (R-3/ADR-095: poll_seq theo thứ tự COMMIT),
 * lọc `types` (wildcard) ∩ `readTypes`, `status=failed` theo generation MỚI NHẤT, long-poll.
 */
describeDb('Polling (A) — GET /v1/p/:project/events (S7)', () => {
  const raw = newTestPrisma('owner');
  // AU6 (SPEC-verification §4.3): fixture bằng owner; repo (code đang test) bằng hub_app -> RLS có hiệu lực.
  const appDb = newTestPrisma('app');
  const tenant = randomUUID();
  const run = randomUUID().slice(0, 8);
  const ago = (s: number) => new Date(Date.now() - s * 1000);
  let n = 0;
  const mk = (type: string, createdAt: Date, t = tenant) =>
    raw.event.create({
      data: {
        id: `ev_${run}_${++n}`,
        tenantId: t,
        idempotencyKey: `poll:${run}:${n}`,
        correlationId: randomUUID(),
        type,
        source: 'api',
        data: { n },
        createdAt,
      },
    });
  const repo = () => new TenantScopedRepository(appDb, tenant);

  afterAll(async () => {
    await raw.delivery.deleteMany({ where: { tenantId: tenant } });
    await raw.event.deleteMany({ where: { tenantId: tenant } });
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await appDb.$disconnect();
  });

  it('[MS:U24] R-3 (ADR-095): event vừa COMMIT được trả NGAY (không còn trễ 2s); chưa commit thì không (xem polling-commit-order-db)', async () => {
    const fresh = await mk('order.fresh', new Date());
    const ids = (await repo().pollEvents({ after: 0n, limit: 1000 })).map((e) => e.id);
    expect(ids).toContain(fresh.id);
  });

  it('[MS:U25] (phần a) 3 event, cursor = seq poll của event đầu -> trả 2 event sau theo seq TĂNG dần; seq là bigint', async () => {
    const a = await mk('order.a', ago(10));
    const b = await mk('order.b', ago(10));
    const c = await mk('order.c', ago(10));
    const all = await repo().pollEvents({ after: 0n, limit: 1000 });
    const seqOf = (id: string) => all.find((r) => r.id === id)!.cursor;
    const rows = await repo().pollEvents({ after: seqOf(a.id), limit: 100 });
    expect(rows.map((r) => r.id)).toEqual([b.id, c.id]);
    expect(rows.map((r) => r.cursor)).toEqual([...rows.map((r) => r.cursor)].sort((x, y) => (x < y ? -1 : 1)));
    expect(typeof rows[0].cursor).toBe('bigint');
    expect((await repo().pollEvents({ after: seqOf(c.id), limit: 100 })).map((r) => r.id)).not.toContain(c.id);
  });

  it('[DX:UX11] latestPollCursor = cursor lớn nhất sau khi cấp cho event đã commit; poll từ đó chỉ thấy event MỚI', async () => {
    const old = await mk('order.before_latest', ago(10));
    const latest = await repo().latestPollCursor();
    const all = await repo().pollEvents({ after: 0n, limit: 1000 });
    expect(all.find((r) => r.id === old.id)!.cursor).toBeLessThanOrEqual(latest);
    expect(all.every((r) => r.cursor <= latest)).toBe(true);
    const fresh = await mk('order.after_latest', ago(0));
    expect((await repo().pollEvents({ after: latest, limit: 100 })).map((r) => r.id)).toEqual([fresh.id]);
    expect(await new TenantScopedRepository(appDb, randomUUID()).latestPollCursor()).toBe(0n); // project trống
  });

  it('[DX:UX11] M-1: latestPollCursor có TRẦN số lô — backlog lớn hơn trần -> null (chưa xong, không vòng vô hạn); gọi lại thì tiến tiếp và xong', async () => {
    const t2 = randomUUID();
    const r2 = () => new TenantScopedRepository(appDb, t2);
    for (let i = 0; i < 5; i++) await mk(`order.backlog_${i}`, ago(10), t2);
    expect(await r2().latestPollCursor({ maxRounds: 2, batch: 2 })).toBeNull(); // cấp 4/5, còn 1 -> null
    const latest = await r2().latestPollCursor({ maxRounds: 2, batch: 2 });
    expect(typeof latest).toBe('bigint');
    const all = await r2().pollEvents({ after: 0n, limit: 100 });
    expect(all).toHaveLength(5);
    expect(all.every((e) => e.cursor <= latest!)).toBe(true); // "latest" = sau MỌI event đã commit, không sót
    await raw.event.deleteMany({ where: { tenantId: t2 } });
  });

  it('S7: types (wildcard) giao với readTypes; project khác không thấy', async () => {
    const p = await mk('payment.received', ago(10));
    const r = await mk('repo.push', ago(10));
    const other = await mk('payment.received', ago(10), randomUUID());
    const types = async (t?: string[], rt?: string[]) =>
      (await repo().pollEvents({ after: 0n, limit: 1000, types: t, readTypes: rt })).map((e) => e.id);
    expect(await types(['payment.*'])).toContain(p.id);
    expect(await types(['payment.*'])).not.toContain(r.id);
    expect(await types(['*'])).toEqual(expect.arrayContaining([p.id, r.id]));
    expect(await types(['repo.push', 'payment.received'], ['payment.*'])).toContain(p.id);
    expect(await types(['repo.push', 'payment.received'], ['payment.*'])).not.toContain(r.id);
    expect(await types(undefined, ['repo.*'])).not.toContain(p.id);
    expect(await types()).not.toContain(other.id);
    await raw.event.delete({ where: { id: other.id } });
  });

  it('S7: status=failed — có delivery DEAD/RETRYING ở generation MỚI NHẤT; endpointId lọc theo đích', async () => {
    const d1 = await raw.destination.create({ data: { tenantId: tenant, name: `d1-${run}`, type: 'webhook', configEncrypted: 'x' } });
    const d2 = await raw.destination.create({ data: { tenantId: tenant, name: `d2-${run}`, type: 'webhook', configEncrypted: 'x' } });
    const s1 = await raw.subscription.create({ data: { tenantId: tenant, destinationId: d1.id, name: `s1-${run}`, eventTypes: ['*'] } });
    const s2 = await raw.subscription.create({ data: { tenantId: tenant, destinationId: d2.id, name: `s2-${run}`, eventTypes: ['*'] } });
    const dead = await mk('order.dead', ago(10));
    const replayed = await mk('order.replayed', ago(10));
    const ok = await mk('order.ok', ago(10));
    const retrying2 = await mk('order.retry', ago(10));
    await raw.delivery.createMany({
      data: [
        { tenantId: tenant, eventId: dead.id, subscriptionId: s1.id, status: 'DEAD' },
        { tenantId: tenant, eventId: replayed.id, subscriptionId: s1.id, status: 'DEAD', attemptGeneration: 1 },
        { tenantId: tenant, eventId: replayed.id, subscriptionId: s1.id, status: 'SUCCEEDED', attemptGeneration: 2 },
        { tenantId: tenant, eventId: ok.id, subscriptionId: s1.id, status: 'SUCCEEDED' },
        { tenantId: tenant, eventId: retrying2.id, subscriptionId: s2.id, status: 'RETRYING' },
      ],
    });
    const failed = async (endpointId?: string) =>
      (await repo().pollEvents({ after: 0n, limit: 1000, failedOnly: true, endpointId })).map((e) => e.id);
    expect((await failed()).sort()).toEqual([dead.id, retrying2.id].sort());
    expect(await failed(d1.id)).toEqual([dead.id]);
    expect(await failed(d2.id)).toEqual([retrying2.id]);
  });

  it('[MS:U26] wait=3, rỗng, sau 1.5s chèn event (created_at lùi 5s) -> trả trong 1.5–3s, có event đó', async () => {
    const start = await repo().pollEvents({ after: 0n, limit: 1000 });
    const after = start.length ? start[start.length - 1].cursor : 0n;
    const t0 = Date.now();
    let inserted = '';
    setTimeout(() => void mk('order.late', ago(5)).then((e) => (inserted = e.id)), 1500);
    const rows = await longPoll(() => repo().pollEvents({ after, limit: 100 }), 3, () => false);
    const ms = Date.now() - t0;
    expect(rows.map((r) => r.id)).toContain(inserted);
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(3200);
  });

  it('[MS:U27] wait=2, không có gì -> rỗng sau ~2s; client ngắt -> dừng sớm', async () => {
    const t0 = Date.now();
    const rows = await longPoll(() => repo().pollEvents({ after: 9_000_000_000_000n, limit: 10 }), 2, () => false);
    expect(rows).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - t0).toBeLessThan(3000);
    let closed = false;
    setTimeout(() => (closed = true), 300);
    const t1 = Date.now();
    await longPoll(() => repo().pollEvents({ after: 9_000_000_000_000n, limit: 10 }), 20, () => closed);
    expect(Date.now() - t1).toBeLessThan(2500);
  });
});
