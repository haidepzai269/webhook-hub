import { createHash, randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthRateLimiter } from '../src/modules/auth/rate-limit';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { EmailFilterService } from '../src/modules/auth/email-filter.service';

/**
 * ADR-180 trên Postgres THẬT (role hub_app): filter dựng từ hub.users, user tạo qua transaction thật vào filter SAU
 * COMMIT, `/auth/email-check` đúng cả hai chiều; review TB-1: N request bị chặn chỉ ghi MỘT dòng auth_audit.
 */
describeDb('Gợi ý email + audit rate limit (Postgres)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });
  const run = randomUUID().slice(0, 8);
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  const users: string[] = [];
  const projects: string[] = [];
  const hashes: string[] = [];

  const filter = new EmailFilterService(svc, null, { capacity: 100_000, errorRate: 0.001, rebuildMs: 0, batchSize: 500 });
  /** Limiter bộ nhớ RIÊNG cho mỗi test (không dính bộ đếm của test khác / trần toàn cục). */
  const makeAuth = () => new AuthService(svc, new JwtService({}), cfg, new AuthRateLimiter(null), () => new Date(), undefined, filter);
  const status = async (p: Promise<unknown>) => {
    try {
      return { status: 200, value: await p };
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), value: e.getResponse() };
      throw e;
    }
  };
  const rateLimitedRows = (emailHash: string, scope: string) =>
    raw.authAudit.count({ where: { action: 'auth.rate_limited', AND: [{ meta: { path: ['emailHash'], equals: emailHash } }, { meta: { path: ['scope'], equals: scope } }] } });

  afterAll(async () => {
    for (const h of hashes) await raw.authAudit.deleteMany({ where: { action: 'auth.rate_limited', meta: { path: ['emailHash'], equals: h } } });
    await raw.authAudit.deleteMany({ where: { userId: { in: users } } });
    await raw.user.deleteMany({ where: { id: { in: users } } });
    await raw.auditLog.deleteMany({ where: { tenantId: { in: projects } } });
    await raw.project.deleteMany({ where: { id: { in: projects } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('dựng từ hub.users (keyset, hub_app + RLS) rồi user mới qua transaction thật vào filter sau COMMIT', async () => {
    const auth = makeAuth();
    const existing = `bf-cu-${run}@test.vn`;
    const a = await auth.createUserWithFirstProject({ email: existing, name: 'Cũ', passwordHash: null, emailVerifiedAt: new Date() }, { ip: null, userAgent: null });
    users.push(a.userId);
    projects.push(a.projectId);

    await filter.rebuild();
    expect(filter.ready).toBe(true);
    expect(filter.size).toBeGreaterThanOrEqual(1);
    expect(await status(auth.emailCheck({ email: existing.toUpperCase() }, { ip: '10.9.0.1', userAgent: null }))).toEqual({ status: 200, value: { available: false } });

    const fresh = `bf-moi-${run}@test.vn`;
    const neg = await filter.isAvailable(fresh);
    expect(neg).toEqual({ available: true, result: 'negative' });

    const b = await auth.createUserWithFirstProject({ email: fresh, name: 'Mới', passwordHash: null, emailVerifiedAt: new Date() }, { ip: null, userAgent: null });
    users.push(b.userId);
    projects.push(b.projectId);
    expect(await filter.isAvailable(fresh)).toEqual({ available: false, result: 'positive_confirmed' });
  });

  it('TB-1: 30 lượt email-check từ một IP -> 10 lượt 429 nhưng CHỈ 1 dòng auth_audit (lần vượt trần đầu tiên)', async () => {
    const auth = makeAuth();
    const email = `bf-do-${run}@test.vn`;
    hashes.push(sha(email));
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) codes.push((await status(auth.emailCheck({ email }, { ip: '10.9.0.2', userAgent: null }))).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(20);
    expect(codes.filter((c) => c === 429)).toHaveLength(10);
    expect(await rateLimitedRows(sha(email), 'emailCheckIp')).toBe(1);
  });

  it('TB-1: login sai liên tục (khoá theo email) và register theo IP cũng chỉ 1 dòng audit mỗi khoá/cửa sổ', async () => {
    const auth = makeAuth();
    const email = `bf-login-${run}@test.vn`;
    hashes.push(sha(email));
    for (let i = 0; i < 9; i++) await status(auth.login({ email, password: 'sai-mat-khau-2026' }, { ip: `10.9.1.${i}`, userAgent: null }));
    expect(await rateLimitedRows(sha(email), 'login_email')).toBe(1);

    const reg = `bf-reg-${run}@test.vn`;
    hashes.push(sha(reg));
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      // Lượt được nhận: chờ việc nền (tạo user / gửi mail) xong rồi mới bắn lượt sau, để afterAll dọn được user.
      const r = await status(auth.register({ email: reg, name: 'Reg', password: 'ca-phe-sua-da-2026' }, { ip: '10.9.0.3', userAgent: null }));
      if (r.status === 200) await (r.value as { done: Promise<void> }).done;
      codes.push(r.status);
    }
    expect(codes.filter((c) => c === 429)).toHaveLength(3); // trần 5/giờ/IP
    expect(await rateLimitedRows(sha(reg), 'registerIp')).toBe(1);
    const u = await raw.user.findUnique({ where: { email: reg } });
    if (u) {
      users.push(u.id);
      projects.push(...(await raw.projectMember.findMany({ where: { userId: u.id } })).map((m) => m.tenantId));
    }
  }, 60_000);
});
