import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MailMessage, MailSender } from '@hub/common';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthRateLimiter, RateLimitRedis } from '../src/modules/auth/rate-limit';
import { loadAuthConfig } from '../src/modules/auth/auth-config';

/**
 * SPEC-auth §5.2, §5.3, §5.9 trên Postgres THẬT (AU2): token email dùng MỘT lần, đăng ký trùng không lộ,
 * đặt lại mật khẩu thu hồi mọi phiên, đổi mật khẩu giữ phiên hiện tại.
 */
describeDb('Email token + mật khẩu (Postgres, AU2)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const cfg = loadAuthConfig({
    JWT_SECRET: 'j'.repeat(40),
    CSRF_SECRET: 'c'.repeat(40),
    SOCKET_TICKET_SECRET: 's'.repeat(40),
    OAUTH_COOKIE_SECRET: 'o'.repeat(40),
    WEB_PUBLIC_URL: 'http://web.test',
  });
  const store = new Map<string, number>();
  const memRedis: RateLimitRedis = {
    eval: async (script: string, _n: number, key: string) => {
      if (script.includes('INCR')) store.set(String(key), (store.get(String(key)) ?? 0) + 1);
      return [store.get(String(key)) ?? 0, 60];
    },
  };
  const sent: MailMessage[] = [];
  const mail: MailSender = { send: async (m) => void sent.push(m) };
  const auth = new AuthService(svc, new JwtService({}), cfg, new AuthRateLimiter(memRedis), undefined, mail);
  const run = randomUUID().slice(0, 8);
  const ctx = { ip: '10.2.2.2', userAgent: 'jest' };
  const PW = 'ca-phe-sua-da-2026';
  const users: string[] = [];
  const projects: string[] = [];

  const tokenFrom = (m: MailMessage) => /token=([A-Za-z0-9_-]+)/.exec(m.text)![1];
  const lastMailTo = (to: string) => [...sent].reverse().find((m) => m.to === to)!;
  const settle = () => new Promise((r) => setTimeout(r, 50)); // mail gửi SAU COMMIT, không chờ (fire-and-forget)
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      if (e instanceof HttpException) return `${e.getStatus()} ${(e.getResponse() as any).error}`;
      throw e;
    }
  };
  async function newUser(tag: string) {
    const email = `${tag}-${run}@mail.test`;
    const r = await auth.register({ email, name: tag, password: PW }, ctx);
    users.push(r.body.user.id);
    projects.push(...r.body.memberships.map((m: any) => m.projectId));
    await settle();
    return { email, id: r.body.user.id as string, session: r.session! };
  }

  afterAll(async () => {
    await raw.authAudit.deleteMany({ where: { userId: { in: users } } });
    await raw.emailToken.deleteMany({ where: { email: { contains: run } } });
    await raw.user.deleteMany({ where: { id: { in: users } } });
    await raw.auditLog.deleteMany({ where: { tenantId: { in: projects } } });
    await raw.project.deleteMany({ where: { id: { in: projects } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('đăng ký gửi mail xác minh SAU COMMIT; link trỏ WEB_PUBLIC_URL/verify-email; DB chỉ giữ sha256', async () => {
    const u = await newUser('verify');
    const m = lastMailTo(u.email);
    expect(m.text).toContain('http://web.test/verify-email?token=');
    const row = await raw.emailToken.findFirstOrThrow({ where: { email: u.email, purpose: 'verify_email' } });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).not.toBe(tokenFrom(m));
    expect(await status(auth.verifyEmail({ token: tokenFrom(m) }, ctx))).toBe('ok');
    expect((await raw.user.findUniqueOrThrow({ where: { id: u.id } })).emailVerifiedAt).not.toBeNull();
    // dùng lại / sai / rỗng -> CÙNG 400 token_invalid
    for (const token of [tokenFrom(m), 'khong-phai-token', '']) {
      expect(await status(auth.verifyEmail({ token }, ctx))).toBe('400 token_invalid');
    }
  });

  it('[AU:UA5] đăng ký email đã tồn tại → 201 cùng hình dạng, KHÔNG tạo user, mail "có người thử" gửi cho chủ email', async () => {
    const u = await newUser('dup');
    const before = await raw.user.count({ where: { email: u.email } });
    const r = await auth.register({ email: u.email, name: 'Kẻ khác', password: PW + '-x' }, ctx);
    await settle();
    expect(Object.keys(r.body)).toEqual(['user', 'memberships']);
    expect(Object.keys(r.body.user)).toEqual(['id', 'email', 'name', 'emailVerified']);
    expect(r.session).toBeNull();
    expect(await raw.user.count({ where: { email: u.email } })).toBe(before);
    const m = lastMailTo(u.email);
    expect(m.subject).toMatch(/thử đăng ký/i);
    expect(m.text).not.toMatch(/token=/); // không kèm token nào
  });

  it('[AU:UA14] token email dùng 2 lần SONG SONG → đúng MỘT lần thành công', async () => {
    const u = await newUser('race');
    const token = tokenFrom(lastMailTo(u.email));
    const results = await Promise.all(Array.from({ length: 5 }, () => status(auth.verifyEmail({ token }, ctx))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === '400 token_invalid')).toHaveLength(4);
  });

  it('gửi lại xác minh: token cũ chưa dùng bị vô hiệu; quá 1 lần/phút -> 429', async () => {
    const u = await newUser('resend');
    const oldToken = tokenFrom(lastMailTo(u.email));
    store.clear();
    const p = { kind: 'user', id: u.id, sessionId: u.session.sessionId, email: u.email } as any;
    expect(await status(auth.resendVerification(p, ctx))).toBe('ok');
    await settle();
    const newToken = tokenFrom(lastMailTo(u.email));
    expect(newToken).not.toBe(oldToken);
    expect(await status(auth.verifyEmail({ token: oldToken }, ctx))).toBe('400 token_invalid');
    expect(await status(auth.resendVerification(p, ctx))).toBe('429 too_many_attempts');
    expect(await status(auth.verifyEmail({ token: newToken }, ctx))).toBe('ok');
  });

  it('[AU:UA15] đặt lại mật khẩu qua email → MỌI session bị thu hồi; email không tồn tại cũng 202, không gửi gì', async () => {
    const u = await newUser('reset');
    const s2 = (await auth.login({ email: u.email, password: PW }, ctx)).session;
    store.clear();
    const n = sent.length;
    expect(await status(auth.forgotPassword({ email: `khong-co-${run}@mail.test` }, ctx))).toBe('ok');
    await settle();
    expect(sent.length).toBe(n);
    expect(await status(auth.forgotPassword({ email: u.email.toUpperCase() }, ctx))).toBe('ok');
    await settle();
    const m = lastMailTo(u.email);
    expect(m.text).toContain('http://web.test/reset-password?token=');
    expect(await status(auth.resetPassword({ token: tokenFrom(m), password: 'mat-khau-moi-2026' }, ctx))).toBe('ok');
    const live = await raw.authSession.count({ where: { userId: u.id, revokedAt: null } });
    expect(live).toBe(0);
    expect(await raw.authSession.count({ where: { id: { in: [u.session.sessionId, s2.sessionId] }, revokeReason: 'password_reset' } })).toBe(2);
    expect(await status(auth.login({ email: u.email, password: PW }, ctx))).toBe('401 invalid_credentials');
    expect(await status(auth.login({ email: u.email, password: 'mat-khau-moi-2026' }, ctx))).toBe('ok');
    expect(await status(auth.resetPassword({ token: tokenFrom(m), password: 'mat-khau-khac-2026' }, ctx))).toBe('400 token_invalid');
  });

  it('đổi mật khẩu: sai mật khẩu hiện tại -> 401; đúng -> mọi session KHÁC bị thu hồi, phiên hiện tại giữ', async () => {
    const u = await newUser('change');
    const other = (await auth.login({ email: u.email, password: PW }, ctx)).session;
    const p = { kind: 'user', id: u.id, sessionId: u.session.sessionId, email: u.email } as any;
    expect(await status(auth.changePassword(p, { currentPassword: 'sai-mat-khau-2026', password: 'mat-khau-moi-2026' }, ctx))).toBe('401 invalid_credentials');
    expect(await status(auth.changePassword(p, { currentPassword: PW, password: '1234567890' }, ctx))).toBe('422 password_weak');
    expect(await status(auth.changePassword(p, { currentPassword: PW, password: 'mat-khau-moi-2026' }, ctx))).toBe('ok');
    expect((await raw.authSession.findUniqueOrThrow({ where: { id: u.session.sessionId } })).revokedAt).toBeNull();
    expect((await raw.authSession.findUniqueOrThrow({ where: { id: other.sessionId } })).revokeReason).toBe('password_changed');
  });
});
