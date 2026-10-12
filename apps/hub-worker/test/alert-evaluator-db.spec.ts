import { randomUUID } from 'crypto';
import { DESTINATION_ARCHIVED_ERROR_PREFIX } from '@hub/common';
import { IdentityRepository, PrismaService } from '@hub/database';
import { AlertEvaluator } from '../src/scheduler/alert.evaluator';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * CB2 trên Postgres THẬT (RUN_DB_TESTS=1): AlertEvaluator chạy bằng role `hub_app` (RLS), fixture dựng bằng owner.
 * Truy vấn tổng hợp thật (cửa sổ, probe, D9), upsert/resolve + outbox email cùng transaction, hai evaluator song song.
 * Gọi `evaluateProject` (không `evaluateOnce`): DB kiểm chứng dùng chung, không đánh giá project của test khác.
 */
describeDb('CB2 AlertEvaluator (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const app = newTestPrisma('app');
  const run = randomUUID().slice(0, 8);
  const [P1, P2, P3, P4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const projects = [P1, P2, P3, P4];
  const users: string[] = [];
  const redis = () => ({ publish: jest.fn().mockResolvedValue(1), on: jest.fn() }) as any;
  const svc1 = new PrismaService();
  const svc2 = new PrismaService();
  const MIN = 60_000;
  let seq = 0;

  beforeAll(async () => {
    for (const id of projects) await owner.project.create({ data: { id, slug: `cb2-${run}-${id.slice(0, 6)}`, name: `cb2 ${run}` } });
  }, 60_000);

  afterAll(async () => {
    await owner.alertEmail.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.alert.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.delivery.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.event.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.subscription.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.destination.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.source.deleteMany({ where: { tenantId: { in: projects } } }); // cascade raw_events
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: { in: projects } } });
    await Promise.all([owner.$disconnect(), app.$disconnect(), svc1.$disconnect(), svc2.$disconnect()]);
  });

  async function flow(tenantId: string, opts: { archived?: boolean } = {}) {
    const dest = await owner.destination.create({
      data: { tenantId, name: `cb2-${run}-${++seq}`, type: 'webhook', configEncrypted: 'x', ...(opts.archived ? { isActive: false, archivedAt: new Date() } : {}) },
    });
    const sub = await owner.subscription.create({ data: { tenantId, destinationId: dest.id, name: `cb2-${run}-${seq}`, eventTypes: ['t.cb2'] } });
    const evt = await owner.event.create({
      data: { id: `CB2${run}${++seq}`.slice(0, 36), tenantId, idempotencyKey: `cb2:${run}:${seq}`, correlationId: randomUUID(), type: 't.cb2', source: 'test', data: {} },
    });
    return { destId: dest.id, subId: sub.id, eventId: evt.id };
  }

  /** Một delivery (generation riêng) + MỘT attempt với HTTP `status` lúc `at`. */
  async function attempt(tenantId: string, f: { subId: string; eventId: string }, status: number, at: Date, deliveryStatus: 'DEAD' | 'SUCCEEDED', lastError?: string) {
    const d = await owner.delivery.create({
      data: { tenantId, eventId: f.eventId, subscriptionId: f.subId, attemptGeneration: ++seq, status: deliveryStatus, attemptCount: 1, lastError: lastError ?? null },
    });
    await owner.deliveryAttempt.create({ data: { deliveryId: d.id, attemptNo: 1, responseStatus: status, createdAt: at } });
    return d.id;
  }

  async function operator(emailOnResolve: boolean) {
    const idn = new IdentityRepository(owner);
    const u = await idn.createUser({ email: `cb2-${run}-${++seq}@t.vn`, name: 'Op', passwordHash: null, isOperator: true, emailVerifiedAt: new Date() });
    users.push(u.id);
    await idn.upsertAlertPreferences(u.id, { emailEnabled: true, emailOnResolve });
    const all = await new IdentityRepository(app).listAlertEmailRecipients();
    return all.filter((r) => r.userId === u.id);
  }

  const alertsOf = (tenantId: string, rule: string) => owner.alert.findMany({ where: { tenantId, rule }, orderBy: { openedAt: 'asc' } });

  it('[CB:T4] 401 ba lần liên tiếp -> destination.auth_rejected mở với facts.dead đúng (+ email OPEN); 1 lần 2xx -> đóng (+ email RESOLVED); [CB:T7] (phần a) mở lại trong 30 phút -> không email OPEN thứ hai', async () => {
    const f = await flow(P1);
    const recipients = await operator(true);
    expect(recipients).toHaveLength(1);
    const userId = recipients[0].userId;
    const ev = new AlertEvaluator(svc1, redis());
    const t0 = new Date();
    for (const k of [3, 2, 1]) await attempt(P1, f, 401, new Date(t0.getTime() - k * MIN), 'DEAD', 'http 401');

    await ev.evaluateProject(P1, t0, recipients);
    let rows = await alertsOf(P1, 'destination.auth_rejected');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'OPEN', severity: 'critical', subjectType: 'destination', subjectId: f.destId });
    expect(rows[0].facts).toMatchObject({ count: 3, dead: 3, httpStatus: 401 });
    expect(await alertsOf(P1, 'destination.client_error')).toHaveLength(0);
    expect(await alertsOf(P1, 'destination.failing')).toHaveLength(0); // 3 < 10 attempt
    let emails = await owner.alertEmail.findMany({ where: { tenantId: P1 } });
    expect(emails.map((e) => [e.alertId, e.userId, e.kind, e.state])).toEqual([[rows[0].id, userId, 'OPEN', 'PENDING']]);

    // lượt sau, không gì mới -> vẫn MỘT dòng OPEN, không email thêm
    await ev.evaluateProject(P1, new Date(t0.getTime() + 1000), recipients);
    expect(await owner.alert.count({ where: { tenantId: P1, rule: 'destination.auth_rejected' } })).toBe(1);

    const t1 = new Date(t0.getTime() + 30_000);
    await attempt(P1, f, 200, t1, 'SUCCEEDED');
    await ev.evaluateProject(P1, new Date(t0.getTime() + MIN), recipients);
    rows = await alertsOf(P1, 'destination.auth_rejected');
    expect(rows[0]).toMatchObject({ state: 'RESOLVED' });
    expect(rows[0].facts).toMatchObject({ httpStatus: 200 });
    emails = await owner.alertEmail.findMany({ where: { tenantId: P1 }, orderBy: { createdAt: 'asc' } });
    expect(emails.map((e) => e.kind)).toEqual(['OPEN', 'RESOLVED']);

    // [CB:T7] 401×3 lại ngay sau -> mở cảnh báo MỚI nhưng không email OPEN (flapping trong 30 phút)
    for (const k of [1, 2, 3]) await attempt(P1, f, 401, new Date(t1.getTime() + k * 1000), 'DEAD', 'http 401');
    await ev.evaluateProject(P1, new Date(t0.getTime() + 2 * MIN), recipients);
    rows = await alertsOf(P1, 'destination.auth_rejected');
    expect(rows.map((r) => r.state)).toEqual(['RESOLVED', 'OPEN']);
    expect(await owner.alertEmail.count({ where: { tenantId: P1, userId, kind: 'OPEN' } })).toBe(1);
  });

  it('[CB:T2] (phần b) hai evaluator (hai pool) chạy evaluateProject song song nhiều lần -> đúng 1 dòng OPEN mỗi (tenant, rule, subject), 1 email OPEN mỗi người', async () => {
    const f = await flow(P2);
    const recipients = await operator(false);
    const t0 = new Date();
    for (const k of [3, 2, 1]) await attempt(P2, f, 403, new Date(t0.getTime() - k * MIN), 'DEAD', 'http 403');
    const a = new AlertEvaluator(svc1, redis());
    const b = new AlertEvaluator(svc2, redis());
    const results = await Promise.all([a, b, a, b, a, b].map((e, i) => e.evaluateProject(P2, new Date(t0.getTime() + i), recipients)));
    expect(results.every((r) => r.errors === 0)).toBe(true);
    const open = await owner.alert.findMany({ where: { tenantId: P2, state: 'OPEN' } });
    const keys = open.map((r) => `${r.rule}|${r.subjectId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(open.filter((r) => r.rule === 'destination.auth_rejected')).toHaveLength(1);
    expect(await owner.alertEmail.count({ where: { tenantId: P2, kind: 'OPEN' } })).toBe(1);
    // chỉ MỘT lượt thực sự chuyển trạng thái (dòng mở)
    expect(results.reduce((n, r) => n + r.transitions, 0)).toBe(1);
  });

  it('[CB:T17] lưu trữ đích có ≥ 10 delivery đang chờ (worker đánh DEAD destination_archived:) -> KHÔNG mở delivery.dead_spike; 10 DEAD thật ở đích còn dùng -> mở', async () => {
    const gone = await flow(P3, { archived: true });
    const now = new Date();
    for (let i = 0; i < 12; i++) await attempt(P3, gone, 0, new Date(now.getTime() - (i + 1) * 1000), 'DEAD', `${DESTINATION_ARCHIVED_ERROR_PREFIX} đích đã lưu trữ`);
    const ev = new AlertEvaluator(svc1, redis());
    await ev.evaluateProject(P3, now);
    expect(await alertsOf(P3, 'delivery.dead_spike')).toHaveLength(0);
    // đích lưu trữ không mở luật destination.* nào dù có attempt (lifecycle)
    expect(await owner.alert.count({ where: { tenantId: P3, subjectId: gone.destId } })).toBe(0);

    const live = await flow(P3);
    for (let i = 0; i < 10; i++) await attempt(P3, live, 500, new Date(now.getTime() - (i + 1) * 1000), 'DEAD', 'http 500');
    await ev.evaluateProject(P3, new Date(now.getTime() + 1000));
    const spike = await alertsOf(P3, 'delivery.dead_spike');
    expect(spike).toHaveLength(1);
    expect(spike[0]).toMatchObject({ state: 'OPEN', subjectType: 'project', subjectId: P3 });
    expect(spike[0].facts).toMatchObject({ count: 10 });
  });

  it('[CB:T5] probe (GitHub ping / PayOS confirm = event probe) không tính: không làm baseline source.silent, không vào mẫu số/tử số source.signature_failing', async () => {
    const src = await owner.source.create({ data: { tenantId: P4, provider: 'github', name: `cb2-${run}`, sourceKey: `src_cb2_${run}` } });
    const now = new Date();
    let n = 0;
    async function raw(at: Date, valid: boolean, probe: boolean | null) {
      const r = await owner.rawEvent.create({
        data: {
          sourceId: src.id, idempotencyKey: `cb2:${run}:${++n}`, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), signatureValid: valid,
          status: valid ? 'ACCEPTED' : 'REJECTED', receivedAt: at,
        },
      });
      if (probe !== null) {
        await owner.event.create({
          data: {
            id: `CB2P${run}${n}`.slice(0, 36), tenantId: P4, sourceId: src.id, rawEventId: r.id, idempotencyKey: `cb2p:${run}:${n}`, correlationId: randomUUID(),
            type: probe ? 'github.ping' : 'repo.push', source: 'github', data: {}, probe, normalized: !probe, receivedAt: at,
          },
        });
      }
    }
    // 25 ping trong 7 ngày (mốc cuối 7 giờ trước) -> KHÔNG phải baseline
    for (let i = 0; i < 25; i++) await raw(new Date(now.getTime() - (7 * 60 + i * 60) * MIN), true, true);
    // trong 15 phút: 10 ping hợp lệ + 4 request ký sai
    for (let i = 0; i < 10; i++) await raw(new Date(now.getTime() - (i + 1) * 10_000), true, true);
    for (let i = 0; i < 4; i++) await raw(new Date(now.getTime() - (i + 1) * 15_000), false, null);

    const repo = svc1.forTenant(P4);
    expect(await repo.countSignatureBySource(new Date(now.getTime() - 15 * MIN))).toEqual([{ sourceId: src.id, requests: 4, invalid: 4 }]);
    const [act] = await repo.findSourceActivity([src.id], new Date(now.getTime() - 7 * 24 * 60 * MIN), 500);
    expect(act).toMatchObject({ sourceId: src.id, n: 0, lastAt: null });

    const ev = new AlertEvaluator(svc1, redis());
    await ev.evaluateProject(P4, now);
    expect(await alertsOf(P4, 'source.silent')).toHaveLength(0);
    expect(await alertsOf(P4, 'source.signature_failing')).toHaveLength(0); // 4 < 5 ký sai

    // thêm 1 ký sai -> 5/5 request KHÔNG probe -> mở (nếu probe vào mẫu số: 5/15 = 33% -> không mở)
    await raw(new Date(now.getTime() - 1000), false, null);
    await ev.evaluateProject(P4, new Date(now.getTime() + 1000));
    const sig = await alertsOf(P4, 'source.signature_failing');
    expect(sig).toHaveLength(1);
    expect(sig[0].facts).toMatchObject({ total: 5, failed: 5, pct: 100 });
  });
});
