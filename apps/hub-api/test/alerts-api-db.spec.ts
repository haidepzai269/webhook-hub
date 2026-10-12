import { randomUUID } from 'crypto';
import { PrismaService } from '@hub/database';
import { JwtService } from '@nestjs/jwt';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthRateLimiter } from '../src/modules/auth/rate-limit';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { ackAlert, ackAllAlerts, alertSummary, getAlertPreferences, listAlerts, putAlertPreferences, putUserLocale } from '../src/modules/alerts/alerts-api';

/**
 * CB3 (SPEC-canh-bao-nhan-dinh §5.2, ADR-169) trên Postgres THẬT, code chạy bằng `hub_app` (RLS bật):
 * - escape hatch có tên của operator đọc xuyên project; mọi đường theo project vẫn bị RLS chặn chéo;
 * - cursor keyset `(opened_at, id)` không trùng / không sót khi có dòng chen vào giữa hai trang;
 * - ack idempotent + `audit_logs` cùng transaction; tuỳ chọn / ngôn ngữ ghi `auth_audit`.
 * Mốc thời gian của fixture ở năm 2089–2091 để luôn đứng đầu danh sách (DB dùng chung với test khác).
 */
describeDb('CB3 API cảnh báo (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const app = newTestPrisma('app');
  const svc = new PrismaService();
  const A = randomUUID();
  const B = randomUUID();
  const run = randomUUID().slice(0, 8);
  const users: string[] = [];
  let op = '';

  beforeAll(async () => {
    for (const [id, slug] of [[A, `cb3-a-${run}`], [B, `cb3-b-${run}`]]) await owner.project.create({ data: { id, slug, name: `Project ${slug}` } });
    op = (await owner.user.create({ data: { email: `cb3-op-${run}@t.vn`, name: 'Op', isOperator: true } })).id;
    users.push(op);
  }, 60_000);

  afterAll(async () => {
    await owner.auditLog.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.alert.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.authAudit.deleteMany({ where: { userId: { in: users } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: { in: [A, B] } } });
    await Promise.all([owner.$disconnect(), app.$disconnect(), svc.$disconnect()]);
  });

  const mk = (tenantId: string, id: string, openedAt: Date, extra: Record<string, unknown> = {}) =>
    owner.alert.create({
      data: { id, tenantId, rule: 'destination.failing', severity: 'warning', subjectType: 'destination', subjectId: randomUUID(), openedAt, lastSeenAt: openedAt, facts: { count: 1 }, ...extra },
    });
  /** id có thứ tự đọc được: hậu tố hex tăng dần. */
  const idOf = (n: number) => `${run}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

  it('[CB:T12] cursor keyset (opened_at, id): không trùng, không sót khi có dòng mới chen vào giữa hai trang (cả dòng hoà mốc thời gian)', async () => {
    const t = (iso: string) => new Date(iso);
    const tie = t('2090-06-01T00:00:00.000Z');
    // 7 dòng gốc, xen kẽ hai project; 3 dòng HOÀ mốc `tie` -> id phá thế hoà
    const original = [
      [A, 70, t('2090-06-03T00:00:00.000Z')],
      [B, 60, t('2090-06-02T00:00:00.000Z')],
      [A, 52, tie],
      [B, 51, tie],
      [A, 50, tie],
      [B, 40, t('2090-05-01T00:00:00.000Z')],
      [A, 30, t('2090-04-01T00:00:00.000Z')],
    ] as const;
    for (const [tenant, n, at] of original) await mk(tenant, idOf(n), at);
    const mine = (ids: string[]) => ids.filter((id) => id.startsWith(`${run}-`));

    const seen: string[] = [];
    const p1 = await listAlerts(svc, { limit: '3' });
    seen.push(...mine(p1.items.map((x) => x.id)));
    expect(seen).toEqual([idOf(70), idOf(60), idOf(52)]);
    expect(p1.items[0].project).toEqual({ id: A, slug: `cb3-a-${run}`, name: `Project cb3-a-${run}` });
    expect(p1.items[1].project.id).toBe(B);
    expect(p1.next).toBeTruthy();

    // chen giữa hai trang: một dòng MỚI HƠN mọi thứ (không được hiện ở trang sau), một dòng HOÀ mốc với cursor nhưng id
    // nhỏ hơn (phải hiện), một dòng cũ hơn cursor (phải hiện)
    await mk(A, idOf(99), t('2091-01-01T00:00:00.000Z'));
    await mk(B, idOf(1), tie);
    await mk(B, idOf(45), t('2090-05-15T00:00:00.000Z'));

    let next = p1.next;
    for (let guard = 0; next && guard < 10; guard++) {
      const page = await listAlerts(svc, { limit: '3', cursor: next });
      const ids = page.items.map((x) => x.id);
      seen.push(...mine(ids));
      if (mine(ids).length < ids.length) break; // đã đi qua hết dòng của test này
      next = page.next;
    }
    expect(seen).toEqual([idOf(70), idOf(60), idOf(52), idOf(51), idOf(50), idOf(1), idOf(45), idOf(40), idOf(30)]);
    expect(new Set(seen).size).toBe(seen.length);

    // tải lại trang đầu: dòng mới chen vào đứng đầu (người xem thấy nó ở trang 1, không bao giờ lẫn vào trang sau)
    const fresh = await listAlerts(svc, { limit: '3' });
    expect(fresh.items[0].id).toBe(idOf(99));
    // lọc theo project / mức / trạng thái vẫn keyset
    const onlyB = await listAlerts(svc, { project: B, state: 'OPEN', severity: 'warning', limit: '200' });
    expect(onlyB.items.map((x) => x.id)).toEqual([idOf(60), idOf(51), idOf(1), idOf(45), idOf(40)]);
    expect(onlyB.items.every((x) => x.project.id === B)).toBe(true);
  });

  it('[CB:T10] (phần b) escape hatch có tên thấy MỌI project; đường theo project (forTenant, RLS) không đọc / ack được cảnh báo của project khác', async () => {
    const [who] = await app.$queryRaw<{ current_user: string; rolbypassrls: boolean }[]>`SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ current_user: 'hub_app', rolbypassrls: false });
    const aId = idOf(70);
    expect(await svc.operatorFindAlertTenant(aId)).toBe(A);
    expect(await svc.operatorFindAlertTenant(randomUUID())).toBeNull();
    const sum = await alertSummary(svc);
    expect(sum.perProject.find((p) => p.project.id === A)).toMatchObject({ warning: 5, critical: 0, unacked: 5, project: { slug: `cb3-a-${run}` } });
    expect(sum.perProject.find((p) => p.project.id === B)).toMatchObject({ warning: 5, unacked: 5 });
    expect(sum.openBySeverity.warning).toBeGreaterThanOrEqual(10);
    // tổng tính trên toàn bảng: không nhỏ hơn tổng các project được liệt kê
    expect(sum.unacked).toBeGreaterThanOrEqual(sum.perProject.reduce((n, p) => n + p.unacked, 0));
    // CB4 review L1: chưa xem theo mức cộng lại đúng bằng tổng chưa xem (cùng một lượt quét).
    const u = sum.unackedBySeverity;
    expect(u.critical + u.warning + u.info).toBe(sum.unacked);

    const repoB = svc.forTenant(B);
    expect(await repoB.findAlertById(aId)).toBeNull();
    expect((await repoB.findOpenAlerts()).some((x) => x.tenantId === A)).toBe(false);
    expect(await repoB.ackAlert(aId, op, new Date())).toEqual({ found: false, changed: false });
    expect(await repoB.ackAllOpenAlerts(op, new Date())).toBe(5); // chỉ 5 dòng của B
    expect(await owner.alert.count({ where: { tenantId: A, acknowledgedAt: { not: null } } })).toBe(0);
    // client trần (không set project, không systemTx) dưới hub_app: RLS trả 0 dòng
    expect(await app.alert.count({ where: { tenantId: { in: [A, B] } } })).toBe(0);
    await owner.alert.updateMany({ where: { tenantId: B }, data: { acknowledgedAt: null, acknowledgedBy: null } });
  });

  it('ack idempotent: lần đầu ghi + MỘT dòng audit_logs (đúng tenant), lần hai changed:false không audit thêm, không đóng cảnh báo; ack-all theo project + audit', async () => {
    const aId = idOf(70);
    const r1 = await ackAlert(svc, aId, op);
    expect(r1).toMatchObject({ id: aId, state: 'OPEN', acknowledgedBy: op, changed: true });
    const r2 = await ackAlert(svc, aId.toUpperCase(), op);
    expect(r2).toMatchObject({ id: aId, changed: false, acknowledgedAt: r1.acknowledgedAt });
    const audits = await owner.auditLog.findMany({ where: { action: 'alert.acknowledged', entityId: aId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: A, entityType: 'alert', actor: op });
    await expect(ackAlert(svc, randomUUID(), op)).rejects.toMatchObject({ status: 404 });

    const unacked = await svc.operatorAlertsUnackedTenants();
    expect(unacked).toEqual(expect.arrayContaining([A, B]));
    expect(await svc.operatorAlertsUnackedTenants(new Date('2000-01-01T00:00:00Z'))).not.toContain(A);
    // asOf = lúc mở chuông: dòng 2091 (mở sau mốc) KHÔNG bị đánh dấu
    const asOf = '2090-12-31T00:00:00.000Z';
    expect(await ackAllAlerts(svc, { project: A, asOf }, op)).toEqual({ acknowledged: 3, projects: [{ id: A, acknowledged: 3 }] }); // 5 dòng A, 1 đã xem, 1 sau asOf
    expect(await owner.alert.findUniqueOrThrow({ where: { id: idOf(99) } })).toMatchObject({ acknowledgedAt: null });
    expect(await ackAllAlerts(svc, { project: A }, op)).toEqual({ acknowledged: 1, projects: [{ id: A, acknowledged: 1 }] });
    expect(await ackAllAlerts(svc, { project: A }, op)).toEqual({ acknowledged: 0, projects: [{ id: A, acknowledged: 0 }] });
    expect(await owner.auditLog.findMany({ where: { tenantId: A, action: 'alert.acknowledged_all' }, select: { metadata: true, actor: true }, orderBy: { id: 'asc' } })).toEqual([
      { metadata: { count: 3, asOf }, actor: op },
      { metadata: { count: 1 }, actor: op },
    ]);
    expect(await owner.alert.count({ where: { tenantId: A, state: 'OPEN' } })).toBe(5);
    expect((await alertSummary(svc)).perProject.find((p) => p.project.id === A)).toMatchObject({ unacked: 0 });
  });

  it('tuỳ chọn cảnh báo + ngôn ngữ: mutedProjects phải tồn tại; ghi qua IdentityRepository + auth_audit cùng transaction; /auth/me có locale', async () => {
    expect(await getAlertPreferences(svc, op)).toMatchObject({ emailEnabled: false, updatedAt: null });
    await expect(putAlertPreferences(svc, op, { mutedProjects: [randomUUID()] }, null)).rejects.toMatchObject({ status: 400 });
    const saved = await putAlertPreferences(svc, op, { emailEnabled: true, emailRules: ['destination.auth_rejected'], mutedProjects: [B] }, '10.0.0.1');
    expect(saved).toMatchObject({ emailEnabled: true, emailRules: ['destination.auth_rejected'], mutedProjects: [B] });
    expect(await getAlertPreferences(svc, op)).toMatchObject({ emailEnabled: true, mutedProjects: [B] });
    expect(await owner.authAudit.count({ where: { userId: op, action: 'alert_preferences.updated' } })).toBe(1);

    expect(await putUserLocale(svc, op, { locale: 'en' }, null)).toEqual({ locale: 'en', changed: true });
    expect(await putUserLocale(svc, op, { locale: 'en' }, null)).toEqual({ locale: 'en', changed: false });
    expect((await owner.user.findUniqueOrThrow({ where: { id: op } })).locale).toBe('en');
    expect(await owner.authAudit.count({ where: { userId: op, action: 'user.locale_changed' } })).toBe(1);
    // GET /auth/me trả locale đã lưu — web đồng bộ nút Ngôn ngữ ở máy khác
    const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });
    const auth = new AuthService(svc, new JwtService({}), cfg, new AuthRateLimiter(null));
    // CB4: `isOperator` cho console — chuông/trang Cảnh báo chỉ hiện (và chỉ gọi /alerts*) khi là operator.
    expect((await auth.me(op)).user).toMatchObject({ id: op, locale: 'en', isOperator: true });
  });
});
