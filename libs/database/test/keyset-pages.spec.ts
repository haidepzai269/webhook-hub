import { randomUUID } from 'crypto';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * ADR-163 (Postgres thật, RUN_DB_TESTS=1): keyset `(created_at, id)` của findDeliveryPage / findAuditLogPage —
 * nhiều dòng TRÙNG created_at (đến µs) vẫn đi hết đúng một lần mỗi dòng, cả chiều cũ hơn lẫn mới hơn; tenant khác rỗng.
 */
describeDb('TenantScopedRepository keyset pages (Postgres)', () => {
  const owner = newTestPrisma('owner');
  const appDb = newTestPrisma('app');
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const runId = randomUUID().slice(0, 8);
  const at = new Date('2026-10-12T03:00:00.000Z');
  let ids: string[] = [];
  let microIds: string[] = [];

  beforeAll(async () => {
    const dest = await owner.destination.create({ data: { tenantId: tenantA, name: `ks-${runId}`, type: 'webhook', configEncrypted: 'x' } });
    const sub = await owner.subscription.create({ data: { tenantId: tenantA, destinationId: dest.id, name: `ks-${runId}`, eventTypes: ['t.test'] } });
    for (let i = 0; i < 7; i++) {
      const e = await owner.event.create({
        data: { id: `KS${runId}${i}`, tenantId: tenantA, idempotencyKey: `ks:${runId}:${i}`, correlationId: randomUUID(), type: 't.test', source: 'test', data: {} },
      });
      // 3 nhóm mốc: 0-2 cùng mốc A, 3-5 cùng mốc B, 6 mốc C — thế hoà phân định bằng id.
      const createdAt = new Date(at.getTime() + Math.floor(i / 3) * 1000);
      await owner.delivery.create({ data: { tenantId: tenantA, eventId: e.id, subscriptionId: sub.id, status: 'DEAD', createdAt } });
    }
    await owner.auditLog.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({ tenantId: tenantA, action: 'delivery.replay', entityType: 'delivery', entityId: `x${i}`, createdAt: at })),
    });
    // L13: thêm 4 dòng cách nhau VÀI µs trong CÙNG một ms (Date JS chỉ thấy ms — cursor phải giữ µs mới không nhảy cóc).
    const micro: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = await owner.event.create({
        data: { id: `KSU${runId}${i}`, tenantId: tenantA, idempotencyKey: `ksu:${runId}:${i}`, correlationId: randomUUID(), type: 't.test', source: 'test', data: {} },
      });
      const d = await owner.delivery.create({ data: { tenantId: tenantA, eventId: e.id, subscriptionId: sub.id, status: 'DEAD' } });
      await owner.$executeRaw`UPDATE hub.deliveries SET created_at = TIMESTAMPTZ '2026-10-12 03:00:05.000100+00' + make_interval(secs => ${i * 3}::double precision / 1000000) WHERE id = ${d.id}::uuid`;
      micro.push(d.id);
    }
    // Lần thử cuối cho bộ lọc code / errorKind: micro[0] -> 404, micro[1] -> 503, micro[2] -> không status, micro[3] không attempt.
    await owner.deliveryAttempt.create({ data: { deliveryId: micro[0], attemptNo: 1, responseStatus: 500 } });
    await owner.deliveryAttempt.create({ data: { deliveryId: micro[0], attemptNo: 2, responseStatus: 404 } });
    await owner.deliveryAttempt.create({ data: { deliveryId: micro[1], attemptNo: 1, responseStatus: 503 } });
    await owner.deliveryAttempt.create({ data: { deliveryId: micro[2], attemptNo: 1, responseStatus: null } });
    microIds = micro;
    const rows = await owner.$queryRaw<{ id: string }[]>`
      SELECT id FROM hub.deliveries WHERE tenant_id = ${tenantA}::uuid ORDER BY created_at DESC, id DESC`;
    ids = rows.map((r) => r.id);
  }, 60_000);

  afterAll(async () => {
    await owner.deliveryAttempt.deleteMany({ where: { deliveryId: { in: microIds } } });
    await owner.auditLog.deleteMany({ where: { tenantId: tenantA } });
    await owner.delivery.deleteMany({ where: { tenantId: tenantA } });
    await owner.event.deleteMany({ where: { tenantId: tenantA } });
    await owner.subscription.deleteMany({ where: { tenantId: tenantA } });
    await owner.destination.deleteMany({ where: { tenantId: tenantA } });
    await owner.$disconnect();
    await appDb.$disconnect();
  });

  it('deliveries: trang 2 dòng đi tới hết rồi lùi về — đúng thứ tự (created_at, id) DESC, không trùng/sót', async () => {
    const repo = new TenantScopedRepository(appDb, tenantA);
    const seen: string[] = [];
    let cursor: { at: string; id: string } | undefined;
    for (;;) {
      const { rows } = await repo.findDeliveryPage({ dir: 'older', cursor, limit: 2, dlq: true });
      const page = rows.slice(0, 2);
      seen.push(...page.map((r) => r.id));
      if (rows.length <= 2) break;
      cursor = { at: page[1].cursorAt, id: page[1].id };
    }
    expect(seen).toEqual(ids);

    // Mới hơn dòng cuối cùng: ASC sát cursor.
    const last = await repo.findDeliveryPage({ dir: 'older', limit: 100 });
    const tail = last.rows[last.rows.length - 1];
    const newer = await repo.findDeliveryPage({ dir: 'newer', cursor: { at: tail.cursorAt, id: tail.id }, limit: 2 });
    expect(newer.rows.slice(0, 2).map((r) => r.id)).toEqual([ids[ids.length - 2], ids[ids.length - 3]]);
  });

  it('dòng cách nhau vài µs: cursor giữ µs, trang 1 dòng đi đúng thứ tự', async () => {
    const repo = new TenantScopedRepository(appDb, tenantA);
    const head = await repo.findDeliveryPage({ dir: 'older', limit: 1 });
    expect(head.rows[0].id).toBe(microIds[3]);
    expect(head.rows[0].cursorAt).toBe('2026-10-12T03:00:05.000109');
    const next = await repo.findDeliveryPage({ dir: 'older', limit: 1, cursor: { at: head.rows[0].cursorAt, id: head.rows[0].id } });
    expect(next.rows[0].id).toBe(microIds[2]);
  });

  it('bộ lọc code / errorKind theo lần thử CUỐI; dlq loại bản đã bị thay', async () => {
    const repo = new TenantScopedRepository(appDb, tenantA);
    const ids = async (f: Parameters<TenantScopedRepository['findDeliveryPage']>[0]) => (await repo.findDeliveryPage(f)).rows.map((r) => r.id);
    expect(await ids({ dir: 'older', limit: 50, httpCode: { exact: 404 } })).toEqual([microIds[0]]);
    expect(await ids({ dir: 'older', limit: 50, httpCode: { klass: 5 } })).toEqual([microIds[1]]);
    expect(await ids({ dir: 'older', limit: 50, dlq: true, errorKind: 'http_4xx' })).toEqual([microIds[0]]);
    expect(await ids({ dir: 'older', limit: 50, dlq: true, errorKind: 'http_other' })).toEqual([microIds[1]]);
    const noResp = await ids({ dir: 'older', limit: 50, dlq: true, errorKind: 'no_response' });
    expect(noResp).toEqual(expect.arrayContaining([microIds[2], microIds[3]]));
    expect(noResp).not.toContain(microIds[0]);
  });

  it('audit: 5 dòng cùng mốc, trang 2 -> đi hết đúng một lần', async () => {
    const repo = new TenantScopedRepository(appDb, tenantA);
    const seen: string[] = [];
    let cursor: { at: string; id: string } | undefined;
    for (;;) {
      const rows = await repo.findAuditLogPage({ dir: 'older', cursor, limit: 2, action: 'delivery' });
      const page = rows.slice(0, 2);
      seen.push(...page.map((r) => r.id.toString()));
      if (rows.length <= 2) break;
      cursor = { at: page[1].cursorAt, id: page[1].id.toString() };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].map(BigInt)).toEqual([...seen].map(BigInt).sort((a, b) => (a < b ? 1 : -1)));
  });

  it('tenant khác: rỗng', async () => {
    const repo = new TenantScopedRepository(appDb, tenantB);
    await expect(repo.findDeliveryPage({ dir: 'older', limit: 50 })).resolves.toEqual({ rows: [] });
    await expect(repo.findAuditLogPage({ dir: 'older', limit: 50 })).resolves.toEqual([]);
  });
});
