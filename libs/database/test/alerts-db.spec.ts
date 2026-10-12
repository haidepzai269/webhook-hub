import { randomUUID } from 'crypto';
import { DEFAULT_EMAIL_RULES } from '@hub/common';
import { PrismaService } from '../src/prisma.service';
import { IdentityRepository } from '../src/identity.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * CB1 (SPEC-canh-bao-nhan-dinh §3, DINH-CHINH D1–D4): bảng `alerts` / `alert_emails` / `alert_preferences` + `users.locale`.
 * Chạy bằng role `hub_app` (DATABASE_URL); fixture bằng owner. Trọng tài chống trùng là unique index MỘT PHẦN — không khoá (D4).
 */
describeDb('CB1 alerts (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const app = newTestPrisma('app');
  // Hai "worker": hai PrismaService = hai pool kết nối riêng.
  const w1 = new PrismaService();
  const w2 = new PrismaService();
  const idn = new IdentityRepository(app);
  const A = randomUUID();
  const B = randomUUID();
  const run = randomUUID().slice(0, 8);
  const users: string[] = [];
  const now = new Date('2026-10-12T07:00:00.000Z');
  const destA = randomUUID();

  beforeAll(async () => {
    for (const [id, slug] of [[A, `cb1-a-${run}`], [B, `cb1-b-${run}`]]) {
      await owner.project.create({ data: { id, slug, name: slug } });
    }
  }, 60_000);

  afterAll(async () => {
    await owner.alertEmail.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.alert.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: { in: [A, B] } } });
    await Promise.all([owner.$disconnect(), app.$disconnect(), w1.$disconnect(), w2.$disconnect()]);
  });

  const upsert = (svc: PrismaService, facts: Record<string, unknown>, at = now) =>
    svc.forTenant(A).upsertOpenAlert({ rule: 'destination.auth_rejected', severity: 'critical', subjectType: 'destination', subjectId: destA, facts, now: at });

  it('[CB:T2] hai evaluator song song upsert cùng (tenant, rule, subject) -> đúng MỘT dòng OPEN, đúng MỘT lần "opened"; đóng rồi mở lại -> dòng OPEN mới', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => upsert(i % 2 ? w1 : w2, { count: i }, new Date(now.getTime() + i))));
    expect(results.filter((r) => r.opened)).toHaveLength(1);
    expect(new Set(results.map((r) => r.alert.id)).size).toBe(1);
    const rows = await owner.alert.findMany({ where: { tenantId: A, rule: 'destination.auth_rejected', subjectId: destA } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'OPEN', severity: 'critical', subjectType: 'destination' });
    // last_seen_at không lùi dù lượt muộn mang `now` cũ hơn
    expect(rows[0].lastSeenAt.getTime()).toBe(now.getTime() + 11);
    expect(rows[0].openedAt.getTime()).toBeLessThanOrEqual(rows[0].lastSeenAt.getTime());

    // đóng song song: chỉ MỘT lượt thấy dòng OPEN (lượt kia null -> không publish lần hai)
    const closed = await Promise.all([w1, w2].map((s) => s.forTenant(A).resolveAlert('destination.auth_rejected', destA, now, { reason: 'archived' })));
    expect(closed.filter(Boolean)).toHaveLength(1);
    const r = closed.find(Boolean)!;
    expect(r).toMatchObject({ state: 'RESOLVED', resolvedAt: now, tenantId: A });
    expect(r.facts).toMatchObject({ reason: 'archived' });

    const again = await upsert(w1, { count: 1 });
    expect(again.opened).toBe(true);
    expect(again.alert.id).not.toBe(rows[0].id);
    expect(await owner.alert.count({ where: { tenantId: A, subjectId: destA } })).toBe(2);
    expect(await owner.alert.count({ where: { tenantId: A, subjectId: destA, state: 'OPEN' } })).toBe(1);
    expect((await w1.forTenant(A).findOpenAlerts()).map((x) => x.id)).toEqual([again.alert.id]);
  });

  it('ack idempotent (chỉ ghi lần đầu, không đóng) · ack-all theo project · outbox email (alert, user, kind) không trùng', async () => {
    const u1 = await idn.createUser({ email: `cb1-u1-${run}@t.vn`, name: 'U1', passwordHash: null });
    const u2 = await idn.createUser({ email: `cb1-u2-${run}@t.vn`, name: 'U2', passwordHash: null });
    users.push(u1.id, u2.id);
    const repo = w1.forTenant(A);
    const { alert } = await repo.upsertOpenAlert({ rule: 'normalize.backlog', severity: 'warning', subjectType: 'project', subjectId: A, facts: { count: 2 }, now });
    expect(await repo.ackAlert(alert.id, u1.id, now)).toEqual({ found: true, changed: true });
    expect(await repo.ackAlert(alert.id, u2.id, new Date(now.getTime() + 1000))).toEqual({ found: true, changed: false });
    const acked = await repo.findAlertById(alert.id);
    expect(acked).toMatchObject({ state: 'OPEN', acknowledgedBy: u1.id, acknowledgedAt: now });
    expect(await repo.ackAllOpenAlerts(u2.id, now)).toBeGreaterThanOrEqual(1); // auth_rejected đang mở của phần trước
    expect(await repo.ackAllOpenAlerts(u2.id, now)).toBe(0);

    expect(await repo.enqueueAlertEmails(alert.id, 'OPEN', [u1.id, u2.id, u1.id])).toBe(2);
    expect(await repo.enqueueAlertEmails(alert.id, 'OPEN', [u1.id])).toBe(0);
    expect(await repo.enqueueAlertEmails(alert.id, 'RESOLVED', [u1.id])).toBe(1);
    const emails = await owner.alertEmail.findMany({ where: { alertId: alert.id } });
    expect(emails).toHaveLength(3);
    expect(emails.every((e) => e.tenantId === A && e.state === 'PENDING' && e.attempts === 0)).toBe(true);
  });

  it('[BB:5] (phần d) RLS: project B không đọc/ack/gắn email vào alert của A; client trần không set project -> 0 dòng', async () => {
    const [who] = await app.$queryRaw<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ current_user: 'hub_app', rolsuper: false, rolbypassrls: false });
    expect(await owner.alert.count({ where: { tenantId: A } })).toBeGreaterThan(0); // "0 dòng" dưới đây không phải vì bảng rỗng

    const alertA = (await owner.alert.findFirst({ where: { tenantId: A, state: 'OPEN' } }))!;
    const repoB = w1.forTenant(B);
    expect(await repoB.findAlertById(alertA.id)).toBeNull();
    expect(await repoB.findOpenAlerts()).toEqual([]);
    expect(await repoB.ackAlert(alertA.id, randomUUID(), now)).toEqual({ found: false, changed: false });
    expect(await repoB.resolveAlert(alertA.rule, alertA.subjectId, now)).toBeNull();
    // khoá ngoại ghép (alert_id, tenant_id): B không gắn được email vào alert của A
    await expect(repoB.enqueueAlertEmails(alertA.id, 'OPEN', [users[0]])).rejects.toThrow();

    expect(await app.alert.count({ where: { tenantId: { in: [A, B] } } })).toBe(0);
    expect(await app.alertEmail.count({ where: { tenantId: { in: [A, B] } } })).toBe(0);
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.project_id', ${B}, true)`;
        await tx.alert.create({ data: { tenantId: A, rule: 'x', severity: 'info', subjectType: 'project', subjectId: A } });
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('IdentityRepository: users.locale mặc định vi + đổi được; alert_preferences mặc định mọi luật critical; người nhận email = operator + đã xác minh + bật email', async () => {
    const op = await idn.createUser({ email: `cb1-op-${run}@t.vn`, name: 'Op', passwordHash: null, isOperator: true, emailVerifiedAt: now });
    const unverified = await idn.createUser({ email: `cb1-uv-${run}@t.vn`, name: 'Uv', passwordHash: null, isOperator: true });
    const dev = await idn.createUser({ email: `cb1-dev-${run}@t.vn`, name: 'Dev', passwordHash: null, emailVerifiedAt: now });
    users.push(op.id, unverified.id, dev.id);
    expect(op.locale).toBe('vi');
    expect(await idn.setUserLocale(op.id, 'en')).toBe(1);
    expect((await idn.findUserById(op.id))?.locale).toBe('en');

    expect(await idn.findAlertPreferences(op.id)).toBeNull();
    const p = await idn.upsertAlertPreferences(op.id, { emailEnabled: true });
    expect(p).toMatchObject({ emailEnabled: true, emailOnResolve: false, mutedProjects: [] });
    expect([...p.emailRules].sort()).toEqual([...DEFAULT_EMAIL_RULES].sort());
    const p2 = await idn.upsertAlertPreferences(op.id, { emailRules: ['destination.failing'], mutedProjects: [B] });
    expect(p2).toMatchObject({ emailEnabled: true, emailRules: ['destination.failing'], mutedProjects: [B] });
    await idn.upsertAlertPreferences(unverified.id, { emailEnabled: true });
    await idn.upsertAlertPreferences(dev.id, { emailEnabled: true });

    const mine = (await idn.listAlertEmailRecipients()).filter((r) => users.includes(r.userId));
    expect(mine).toEqual([
      { userId: op.id, email: op.email, locale: 'en', emailRules: ['destination.failing'], emailOnResolve: false, mutedProjects: [B] },
    ]);
  });
});
