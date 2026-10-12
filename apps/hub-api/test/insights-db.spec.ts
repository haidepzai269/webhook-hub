import { randomUUID } from 'crypto';
import { DESTINATION_ARCHIVED_ERROR_PREFIX } from '@hub/common';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { DuplicateCounter, isForeignKeyViolation } from '../src/modules/ingest/duplicate-counter';
import { getInsights } from '../src/modules/insights/insights-api';

/**
 * CB6 trên Postgres THẬT (RUN_DB_TESTS=1): `getInsights` + bộ đếm bản trùng chạy bằng `hub_app` (RLS), fixture dựng bằng owner.
 * - Phạm vi project: nhận định của A không chứa đích/nguồn/bản trùng/DLQ của B (BB-5), kể cả khi B có đủ mọi thứ.
 * - `ingest_duplicates`: cộng dồn đúng qua nhiều lượt ghi; không ghi được số cho source của project khác (FK ghép + RLS).
 * - `I-dead` = đúng tập DLQ (DEAD chưa bị replay) trừ D9 (đích lưu trữ); `recent` theo `updated_at` 24h.
 */
describeDb('CB6 nhận định (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const [A, B] = [randomUUID(), randomUUID()];
  const projects = [A, B];
  let seq = 0;

  beforeAll(async () => {
    for (const id of projects) await owner.project.create({ data: { id, slug: `cb6-${run}-${id.slice(0, 6)}`, name: `cb6 ${run}` } });
  }, 60_000);

  afterAll(async () => {
    await owner.delivery.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.event.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.subscription.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.destination.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.source.deleteMany({ where: { tenantId: { in: projects } } }); // cascade raw_events, ingest_duplicates
    await owner.project.deleteMany({ where: { id: { in: projects } } });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  const source = (tenantId: string, provider: 'payos' | 'github') =>
    owner.source.create({ data: { tenantId, provider, name: `cb6-${run}-${++seq}`, sourceKey: `cb6-${run}-${++seq}` } });

  async function flow(tenantId: string, opts: { archived?: boolean } = {}) {
    const dest = await owner.destination.create({
      data: { tenantId, name: `cb6-${run}-${++seq}`, type: 'webhook', configEncrypted: 'x', ...(opts.archived ? { isActive: false, archivedAt: new Date() } : {}) },
    });
    const sub = await owner.subscription.create({ data: { tenantId, destinationId: dest.id, name: `cb6-${run}-${seq}`, eventTypes: ['t.cb6'] } });
    return { destId: dest.id, subId: sub.id };
  }

  const event = (tenantId: string) =>
    owner.event.create({
      data: { id: `CB6${run}${++seq}`.slice(0, 36), tenantId, idempotencyKey: `cb6:${run}:${seq}`, correlationId: randomUUID(), type: 't.cb6', source: 'test', data: {} },
    });

  /** Delivery (một sự kiện mới) + một attempt `status` — `deadAgoMs` dời `updated_at` (lúc thành DEAD) về quá khứ. */
  async function delivery(
    tenantId: string,
    f: { subId: string },
    o: { status: 'DEAD' | 'SUCCEEDED'; http?: number; lastError?: string; deadAgoMs?: number; eventId?: string; generation?: number },
  ) {
    const eventId = o.eventId ?? (await event(tenantId)).id;
    const d = await owner.delivery.create({
      data: { tenantId, eventId, subscriptionId: f.subId, attemptGeneration: o.generation ?? 1, status: o.status, attemptCount: 1, lastError: o.lastError ?? null },
    });
    if (o.http !== undefined) await owner.deliveryAttempt.create({ data: { deliveryId: d.id, attemptNo: 1, responseStatus: o.http, createdAt: new Date(Date.now() - 60_000 + ++seq * 10) } });
    if (o.deadAgoMs) await owner.$executeRaw`UPDATE hub.deliveries SET updated_at = now() - make_interval(secs => ${o.deadAgoMs / 1000}::double precision) WHERE id = ${d.id}::uuid`;
    return { id: d.id, eventId };
  }

  it('bộ đếm bản trùng: cộng dồn qua nhiều lượt ghi (ON CONFLICT), tách theo provider; không ghi được cho source của project khác', async () => {
    const [aPay, aGh, bPay] = [await source(A, 'payos'), await source(A, 'github'), await source(B, 'payos')];
    const counter = new DuplicateCounter((t, rows) => svc.forTenant(t).addIngestDuplicates(rows), 0);
    for (let i = 0; i < 3; i++) counter.record(A, aPay.id);
    counter.record(A, aGh.id);
    for (let i = 0; i < 7; i++) counter.record(B, bPay.id);
    await counter.flush();
    counter.record(A, aPay.id); // lượt thứ hai cùng giờ -> cộng vào dòng sẵn có
    await counter.flush();
    expect(counter.pendingCount()).toBe(0);

    const ins = await getInsights(svc, A, { codes: 'I-dup' });
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ code: 'I-dup', subjectId: A, level: 'info', facts: { total: 5, byProvider: [{ provider: 'payos', n: 4 }, { provider: 'github', n: 1 }] } });
    expect((await getInsights(svc, B, { codes: 'I-dup' }))[0].facts).toMatchObject({ total: 7 });

    // project A ghi số cho source của B: FK ghép (source_id, tenant_id) từ chối — không bao giờ "mượn" source chéo
    const err = await svc.forTenant(A).addIngestDuplicates([{ sourceId: bPay.id, bucket: new Date(), n: 1 }]).then(() => null, (e) => e);
    expect(isForeignKeyViolation(err)).toBe(true); // lỗi THẬT của Prisma được nhận ra là 23503 (review Thấp 4)
    // bộ đếm: dòng hỏng bị bỏ, dòng tốt cùng lô vẫn được ghi, không treo lại mãi
    counter.record(A, bPay.id);
    counter.record(A, aGh.id);
    await counter.flush();
    expect(counter.pendingCount()).toBe(0);
    expect((await getInsights(svc, A, { codes: 'I-dup' }))[0].facts).toMatchObject({ total: 6 });
    // và hub_app (RLS) đọc từ phạm vi A không thấy dòng của B
    const rows = await svc.tenantTx(A, (tx) => tx.ingestDuplicate.findMany({ select: { tenantId: true } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === A)).toBe(true);
  });

  it('phạm vi project: nhận định của A không chứa đích/nguồn/DLQ của B; I-dead = DLQ trừ bản đã replay và D9; I-dest theo phân loại chung', async () => {
    const aLive = await flow(A);
    const aIdle = await flow(A);
    const aGone = await flow(A, { archived: true });
    const bAuth = await flow(B);
    const bSrc = await source(B, 'github');

    await delivery(A, aLive, { status: 'SUCCEEDED', http: 200 });
    await delivery(A, aLive, { status: 'DEAD', http: 500, lastError: 'http 500' }); // DLQ, mới (24h)
    await delivery(A, aLive, { status: 'DEAD', lastError: 'http 404', deadAgoMs: 2 * 86_400_000 }); // DLQ, cũ
    const replayed = await delivery(A, aLive, { status: 'DEAD', lastError: 'http 502' });
    await delivery(A, aLive, { status: 'SUCCEEDED', eventId: replayed.eventId, generation: 2 }); // đã replay -> rời DLQ
    await delivery(A, aGone, { status: 'DEAD', lastError: `${DESTINATION_ARCHIVED_ERROR_PREFIX} đích đã lưu trữ` }); // D9
    for (let i = 0; i < 4; i++) await delivery(B, bAuth, { status: 'DEAD', http: 401, lastError: 'http 401' });

    const a = await getInsights(svc, A);
    const ids = a.map((i) => i.subjectId);
    expect(ids).not.toContain(bAuth.destId);
    expect(ids).not.toContain(bSrc.id);
    expect(ids).not.toContain(B);
    expect(ids).not.toContain(aGone.destId); // đích lưu trữ không có nhãn

    const dead = a.find((i) => i.code === 'I-dead')!;
    expect(dead).toMatchObject({ subjectId: A, level: 'warning', facts: { total: 2, recent: 1, excludedArchived: 1, capped: false }, actions: [{ code: 'open_dlq' }] });

    const byDest = new Map(a.filter((i) => i.code === 'I-dest').map((i) => [i.subjectId, i]));
    // aLive: 200 rồi 500 (mới nhất) -> "Lỗi/chậm phía nhận (đang retry)"; attempt không có (404 cũ, 502) không tính
    expect(byDest.get(aLive.destId)).toMatchObject({ level: 'warning', facts: { health: 'receiver_failing', total: 2, success: 1, retrying: 1, lastStatus: 500 } });
    expect(byDest.get(aIdle.destId)).toMatchObject({ level: 'info', facts: { health: 'no_deliveries', total: 0 } });

    const b = await getInsights(svc, B, { codes: 'I-dest,I-dead,I-silent' });
    expect(b.find((i) => i.subjectId === bAuth.destId)).toMatchObject({ level: 'critical', facts: { health: 'auth_rejected', total: 4 } });
    expect(b.find((i) => i.code === 'I-dead')!.facts).toMatchObject({ total: 4, excludedArchived: 0 });
    expect(b.find((i) => i.subjectId === bSrc.id)).toMatchObject({ code: 'I-silent', facts: { state: 'no_events' } });
    expect(b.map((i) => i.subjectId)).not.toContain(aLive.destId);
  });
});
