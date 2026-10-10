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
  async function newUser(tag: string, verified = false) {
    const email = `${tag}-${run}@mail.test`;
    const r = await auth.register({ email, name: tag, password: PW }, ctx);
    await r.done; // R-6: tạo user + gửi mail chạy nền sau response
    await settle();
    const u = verified
      ? await raw.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } }) // R-6: chưa xác minh thì không login được
      : await raw.user.findUniqueOrThrow({ where: { email } });
    users.push(u.id);
    projects.push(...(await raw.projectMember.findMany({ where: { userId: u.id } })).map((m) => m.tenantId));
    // R-6: đăng ký không phát phiên; test cần phiên thì phát thẳng (luồng thật: link xác minh -> verifyEmail).
    const session = await auth.issueSession(u.id, null, null, ctx);
    return { email, id: u.id, session };
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
    expect(await status(auth.verifyEmail({ password: PW, token: tokenFrom(m) }, ctx))).toBe('ok');
    expect((await raw.user.findUniqueOrThrow({ where: { id: u.id } })).emailVerifiedAt).not.toBeNull();
    // dùng lại / sai / rỗng -> CÙNG 400 token_invalid
    for (const token of [tokenFrom(m), 'khong-phai-token', '']) {
      expect(await status(auth.verifyEmail({ password: PW, token }, ctx))).toBe('400 token_invalid');
    }
  });

  it('[AU:UA5] đăng ký email đã tồn tại (đã xác minh) → body GIỐNG HỆT email mới, không phiên, KHÔNG tạo user, mail "có người thử" gửi cho chủ email', async () => {
    const u = await newUser('dup');
    await raw.user.update({ where: { id: u.id }, data: { emailVerifiedAt: new Date() } });
    const before = await raw.user.count({ where: { email: u.email } });
    const fresh = await auth.register({ email: `dup-moi-${run}@mail.test`, name: 'Mới', password: PW }, ctx);
    const r = await auth.register({ email: u.email, name: 'Kẻ khác', password: PW + '-x' }, ctx);
    await Promise.all([r.done, fresh.done]);
    await settle();
    const freshUser = await raw.user.findUniqueOrThrow({ where: { email: `dup-moi-${run}@mail.test` } });
    users.push(freshUser.id);
    projects.push(...(await raw.projectMember.findMany({ where: { userId: freshUser.id } })).map((m) => m.tenantId));
    expect(r.body).toEqual(fresh.body); // R-6: một body cố định, không cookie (controller không đặt cookie)
    expect(Object.keys(r)).toEqual(['body', 'done']);
    expect(await raw.user.count({ where: { email: u.email } })).toBe(before);
    const m = lastMailTo(u.email);
    expect(m.subject).toMatch(/thử đăng ký/i);
    expect(m.text).not.toMatch(/token=/); // không kèm token nào
  });

  it('[AR:R-6] (phần a) chưa xác minh: đăng nhập ĐÚNG mật khẩu -> CÙNG 401 invalid_credentials; đăng ký lại = gửi lại link; link xác minh -> phiên + đăng nhập được', async () => {
    const u = await newUser('chuaxm');
    expect(await status(auth.login({ email: u.email, password: PW }, ctx))).toBe('401 invalid_credentials');
    expect(await status(auth.login({ email: u.email, password: PW + '-sai' }, ctx))).toBe('401 invalid_credentials');
    const first = tokenFrom(lastMailTo(u.email));
    store.clear();
    const again = await auth.register({ email: u.email, name: 'x', password: PW }, ctx);
    await again.done;
    await settle();
    const resent = tokenFrom(lastMailTo(u.email));
    expect(resent).not.toBe(first);
    expect(lastMailTo(u.email).text).toContain('/verify-email?token=');
    const v = await auth.verifyEmail({ password: PW, token: resent }, ctx);
    expect(v.session.accessToken).toBeTruthy();
    expect(v.body.user.emailVerified).toBe(true);
    expect(await status(auth.login({ email: u.email, password: PW }, ctx))).toBe('ok');
  });

  it('[AR:N-1] (phần a) chiếm trước: kẻ xấu đăng ký email nạn nhân (mật khẩu A, tên Attacker, có key cũ) -> nạn nhân đăng ký lại + bấm link: PHẢI đặt mật khẩu; A chết, V sống, tên/khoá/phiên/lời mời của kẻ xấu không còn', async () => {
    const email = `nannhan-${run}@mail.test`;
    const A = 'mat-khau-ke-xau-2026';
    const V = 'mat-khau-nan-nhan-2026';
    const atk = await auth.register({ email, name: 'Attacker', password: A }, ctx);
    await atk.done;
    await settle();
    const u = await raw.user.findUniqueOrThrow({ where: { email } });
    users.push(u.id);
    const pid = (await raw.projectMember.findFirstOrThrow({ where: { userId: u.id } })).tenantId;
    projects.push(pid);
    // trạng thái "cũ" kẻ xấu có thể để lại (trước R-6 user chưa xác minh vẫn đăng nhập được): key + phiên + lời mời
    await raw.apiKey.create({ data: { tenantId: pid, serviceName: 'ke-xau', keyPrefix: 'hk_test_xx', keyHash: `h-${run}`, scopes: ['read:events'] } });
    const atkSession = await auth.issueSession(u.id, null, null, ctx);
    await raw.emailToken.create({ data: { tokenHash: `inv-${run}`, purpose: 'invite', email: `ai-do-${run}@mail.test`, tenantId: pid, role: 'viewer', invitedBy: u.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    const firstLink = tokenFrom(lastMailTo(email));
    store.clear();
    const vic = await auth.register({ email, name: 'Victim', password: V }, ctx);
    await vic.done;
    await settle();
    const link = tokenFrom(lastMailTo(email));
    // bấm link mà không đặt mật khẩu -> 400 password_required, token KHÔNG bị đốt
    expect(await status(auth.verifyEmail({ token: link }, ctx))).toBe('400 password_required');
    const v = await auth.verifyEmail({ token: link, password: V, name: 'Victim' } as any, ctx);
    expect(v.session.accessToken).toBeTruthy();
    expect(v.body.user.name).toBe('Victim');
    expect(await status(auth.login({ email, password: A }, ctx))).toBe('401 invalid_credentials');
    expect(await status(auth.login({ email, password: V }, ctx))).toBe('ok');
    expect(await status(auth.verifyEmail({ token: firstLink, password: A } as any, ctx))).toBe('400 token_invalid');
    expect((await raw.authSession.findUniqueOrThrow({ where: { id: atkSession.sessionId } })).revokedAt).not.toBeNull();
    expect(await raw.apiKey.count({ where: { tenantId: pid, revokedAt: null } })).toBe(0);
    expect(await raw.emailToken.count({ where: { invitedBy: u.id, usedAt: null } })).toBe(0);
  });

  it('[AR:N-1] (phần b) tài khoản chưa xác minh nhận lại qua QUÊN MẬT KHẨU cũng xoá dấu vết: tên về phần trước @, key project riêng bị thu hồi, A chết', async () => {
    const email = `quen-${run}@mail.test`;
    const atk = await auth.register({ email, name: 'Attacker', password: 'mat-khau-ke-xau-2026' }, ctx);
    await atk.done;
    await settle();
    const u = await raw.user.findUniqueOrThrow({ where: { email } });
    users.push(u.id);
    const pid = (await raw.projectMember.findFirstOrThrow({ where: { userId: u.id } })).tenantId;
    projects.push(pid);
    await raw.apiKey.create({ data: { tenantId: pid, serviceName: 'ke-xau', keyPrefix: 'hk_test_yy', keyHash: `h2-${run}`, scopes: ['read:events'] } });
    store.clear();
    await auth.forgotPassword({ email }, ctx);
    await settle();
    await settle();
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(lastMailTo(email).text)![1];
    expect(await status(auth.resetPassword({ token, password: 'mat-khau-nan-nhan-2026' }, ctx))).toBe('ok');
    const after = await raw.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.name).toBe(`quen-${run}`);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await raw.apiKey.count({ where: { tenantId: pid, revokedAt: null } })).toBe(0);
    expect(await status(auth.login({ email, password: 'mat-khau-ke-xau-2026' }, ctx))).toBe('401 invalid_credentials');
  });

  it('[AU:UA14] token email dùng 2 lần SONG SONG → đúng MỘT lần thành công', async () => {
    const u = await newUser('race');
    const token = tokenFrom(lastMailTo(u.email));
    const results = await Promise.all(Array.from({ length: 5 }, () => status(auth.verifyEmail({ password: PW, token }, ctx))));
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
    expect(await status(auth.verifyEmail({ password: PW, token: oldToken }, ctx))).toBe('400 token_invalid');
    expect(await status(auth.resendVerification(p, ctx))).toBe('429 too_many_attempts');
    expect(await status(auth.verifyEmail({ password: PW, token: newToken }, ctx))).toBe('ok');
  });

  it('[AU:UA15] đặt lại mật khẩu qua email → MỌI session bị thu hồi; email không tồn tại cũng 202, không gửi gì', async () => {
    const u = await newUser('reset', true);
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
    const u = await newUser('change', true);
    const other = (await auth.login({ email: u.email, password: PW }, ctx)).session;
    const p = { kind: 'user', id: u.id, sessionId: u.session.sessionId, email: u.email } as any;
    expect(await status(auth.changePassword(p, { currentPassword: 'sai-mat-khau-2026', password: 'mat-khau-moi-2026' }, ctx))).toBe('401 invalid_credentials');
    expect(await status(auth.changePassword(p, { currentPassword: PW, password: '1234567890' }, ctx))).toBe('422 password_weak');
    expect(await status(auth.changePassword(p, { currentPassword: PW, password: 'mat-khau-moi-2026' }, ctx))).toBe('ok');
    expect((await raw.authSession.findUniqueOrThrow({ where: { id: u.session.sessionId } })).revokedAt).toBeNull();
    expect((await raw.authSession.findUniqueOrThrow({ where: { id: other.sessionId } })).revokeReason).toBe('password_changed');
  });
});
