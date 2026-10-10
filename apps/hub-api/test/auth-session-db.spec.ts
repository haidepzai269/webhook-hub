import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthRateLimiter, RateLimitRedis } from '../src/modules/auth/rate-limit';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { SessionGuard } from '../src/modules/auth/session.guard';

/**
 * SPEC-auth §5.3 trên Postgres THẬT: refresh xoay vòng trong một transaction `FOR UPDATE`, phát hiện dùng lại,
 * cửa sổ 5 giây cho hai tab, SessionGuard kiểm DB (thu hồi có hiệu lực ngay dù access token còn hạn).
 */
describeDb('Phiên đăng nhập — refresh xoay vòng (Postgres)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });
  const jwt = new JwtService({});
  const noRedis: RateLimitRedis = { eval: async (s: string) => (s.includes('INCR') ? [1, 60] : [0, -2]) };
  const clock = { now: new Date('2026-10-11T08:00:00Z').getTime() };
  const auth = new AuthService(svc, jwt, cfg, new AuthRateLimiter(noRedis), () => new Date(clock.now));
  const guard = new SessionGuard(svc, jwt, cfg, () => new Date(clock.now));
  const run = randomUUID().slice(0, 8);
  const email = `phien-${run}@test.vn`;
  const ctx = { ip: '10.1.1.1', userAgent: 'jest' };
  let userId = '';
  const projectIds: string[] = [];

  const httpStatus = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), error: (e.getResponse() as any).error };
      throw e;
    }
  };
  const guardCtx = (access: string) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ method: 'GET', headers: {}, cookies: { '__Host-hub_at': access } }) }) }) as never;

  beforeAll(async () => {
    const r = await auth.register({ email, name: 'Phiên Test', password: 'ca-phe-sua-da-2026' }, ctx);
    await r.done; // R-6: tạo user chạy nền sau response
    // R-6: chưa xác minh thì không đăng nhập được — test phiên đặt thẳng emailVerifiedAt (luồng link: auth-mail-db).
    const u = await raw.user.update({ where: { email }, data: { emailVerifiedAt: new Date(clock.now) } });
    userId = u.id;
    projectIds.push(...(await raw.projectMember.findMany({ where: { userId } })).map((m) => m.tenantId));
  }, 60_000);

  afterAll(async () => {
    await raw.authAudit.deleteMany({ where: { userId } });
    await raw.user.deleteMany({ where: { id: userId } }); // CASCADE: members + sessions
    await raw.auditLog.deleteMany({ where: { tenantId: { in: projectIds } } });
    await raw.project.deleteMany({ where: { id: { in: projectIds } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  const login = () => auth.login({ email, password: 'ca-phe-sua-da-2026' }, ctx).then((r) => r.session!);

  it('đăng ký tạo user + project đầu tiên + membership owner trong một transaction', async () => {
    const members = await raw.projectMember.findMany({ where: { userId } });
    expect(members).toEqual([expect.objectContaining({ role: 'owner', tenantId: projectIds[0] })]);
    expect(await raw.auditLog.count({ where: { tenantId: projectIds[0], action: 'project.created' } })).toBe(1);
  });

  it('[AU:UA7] refresh hợp lệ: dòng cũ rotatedAt + replacedById, dòng mới cùng familyId, absoluteExpiresAt giữ nguyên', async () => {
    const s1 = await login();
    clock.now += 60_000;
    const s2 = await auth.refresh(s1.refreshToken, s1.csrfToken, s1.csrfToken, ctx);
    const old = await raw.authSession.findUniqueOrThrow({ where: { id: s1.sessionId } });
    const neu = await raw.authSession.findUniqueOrThrow({ where: { id: s2.sessionId } });
    expect(old.rotatedAt).not.toBeNull();
    expect(old.replacedById).toBe(neu.id);
    expect(neu.familyId).toBe(old.familyId);
    expect(neu.absoluteExpiresAt.getTime()).toBe(old.absoluteExpiresAt.getTime());
    expect(neu.idleExpiresAt.getTime()).toBe(clock.now + 7 * 86400_000);
    expect(s2.refreshToken).not.toBe(s1.refreshToken);
  });

  it('[AU:UA8] refresh token cũ dùng lại sau 6 giây → thu hồi CẢ family + auth_audit session.reuse_detected', async () => {
    const s1 = await login();
    const s2 = await auth.refresh(s1.refreshToken, s1.csrfToken, s1.csrfToken, ctx);
    clock.now += 6_000;
    expect(await httpStatus(auth.refresh(s1.refreshToken, s1.csrfToken, s1.csrfToken, ctx))).toEqual({ status: 401, error: 'session_expired' });
    const fam = (await raw.authSession.findUniqueOrThrow({ where: { id: s1.sessionId } })).familyId;
    const rows = await raw.authSession.findMany({ where: { familyId: fam } });
    expect(rows.every((r) => r.revokedAt && r.revokeReason === 'reuse_detected')).toBe(true);
    // token MỚI của family cũng chết
    expect(await httpStatus(auth.refresh(s2.refreshToken, s2.csrfToken, s2.csrfToken, ctx))).toEqual({ status: 401, error: 'session_expired' });
    expect(await raw.authAudit.count({ where: { userId, action: 'session.reuse_detected' } })).toBeGreaterThanOrEqual(1);
  });

  it('[AU:UA9] dùng lại sau 2 giây (hai tab cùng refresh) → 401 refresh_race, family KHÔNG bị thu hồi', async () => {
    const s1 = await login();
    const s2 = await auth.refresh(s1.refreshToken, s1.csrfToken, s1.csrfToken, ctx);
    clock.now += 2_000;
    expect(await httpStatus(auth.refresh(s1.refreshToken, s1.csrfToken, s1.csrfToken, ctx))).toEqual({ status: 401, error: 'refresh_race' });
    const neu = await raw.authSession.findUniqueOrThrow({ where: { id: s2.sessionId } });
    expect(neu.revokedAt).toBeNull();
    expect(await httpStatus(auth.refresh(s2.refreshToken, s2.csrfToken, s2.csrfToken, ctx))).toBe(200);
  });

  it('[AU:UA10] session đã thu hồi (logout-all) + access JWT còn hạn → SessionGuard 401', async () => {
    const a = await login();
    const b = await login();
    expect(await guard.canActivate(guardCtx(b.accessToken))).toBe(true);
    await auth.logoutAll({ kind: 'user', id: userId, sessionId: a.sessionId } as never, ctx);
    expect(await httpStatus(guard.canActivate(guardCtx(b.accessToken)))).toEqual({ status: 401, error: 'session_expired' });
  });

  it('refresh không có CSRF khớp → 403 csrf_failed, không xoay vòng', async () => {
    const s = await login();
    expect(await httpStatus(auth.refresh(s.refreshToken, s.csrfToken, undefined, ctx))).toEqual({ status: 403, error: 'csrf_failed' });
    expect((await raw.authSession.findUniqueOrThrow({ where: { id: s.sessionId } })).rotatedAt).toBeNull();
  });
});
