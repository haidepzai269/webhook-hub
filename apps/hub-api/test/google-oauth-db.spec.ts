import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MailMessage, MailSender } from '@hub/common';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthRateLimiter } from '../src/modules/auth/rate-limit';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { GoogleOAuthService, loadGoogleConfig } from '../src/modules/auth/google-oauth.service';
import { GithubOAuthService, loadGithubConfig } from '../src/modules/auth/github-oauth.service';
import { openOAuthCookie } from '../src/modules/auth/oauth-cookie';

/**
 * AU5b (ADR-127) trên Postgres THẬT, Google là fetch giả (ID token ký bằng khoá RSA sinh trong test):
 * ghép theo `sub`, email trùng đã/chưa xác minh (chiếm trước — N-1), sub khác -> mismatch, callback song song, gỡ liên kết.
 */
describeDb('Đăng nhập Google (Postgres + fetch giả, AU5b)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const env = {
    JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40),
    WEB_PUBLIC_URL: 'http://web.test', GOOGLE_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
  };
  const cfg = loadAuthConfig(env);
  const sent: MailMessage[] = [];
  const mail: MailSender = { send: async (m) => void sent.push(m) };
  const auth = new AuthService(svc, new JwtService({}), cfg, new AuthRateLimiter(null), undefined, mail);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const run = randomUUID().slice(0, 8);
  const ctx = { ip: '10.6.6.6', userAgent: 'jest' };
  const emails: string[] = [];

  let claims: Record<string, unknown> = {};
  const fetchImpl = (async (url: string, init: any) => {
    if (url.endsWith('/oauth2/v3/certs')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ keys: [{ kty: 'RSA', kid: 'k1', ...jwk }] }) };
    const nonce = new URLSearchParams(init.body).get('nonce_test');
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: env.GOOGLE_OAUTH_CLIENT_ID, iat: now, exp: now + 3600, email_verified: true, nonce, ...claims })).toString('base64url');
    return { ok: true, status: 200, json: async () => ({ id_token: `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}` }) };
  }) as unknown as typeof fetch;
  const google = new GoogleOAuthService(auth, svc, cfg, loadGoogleConfig(env), mail, ((url: string, init: any) => {
    // nonce của lượt đang chạy (đọc từ cookie) đi kèm body để fetch giả ký đúng — Google thật lấy từ request /auth.
    if (url.endsWith('/token')) init = { ...init, body: `${init.body}&nonce_test=${encodeURIComponent(currentNonce)}` };
    return fetchImpl(url as any, init);
  }) as typeof fetch);
  let currentNonce = '';
  const status = async (p: Promise<unknown>) => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof HttpException) return `${e.getStatus()} ${(e.getResponse() as any).error}`;
      throw e;
    }
  };
  async function signIn(sub: string, email: string, name = 'Google User') {
    claims = { sub, email, name };
    const s = google.start();
    const c = openOAuthCookie(cfg.oauthCookieSecret, s.cookie.value, 'google')!;
    currentNonce = c.nonce!;
    return google.callback({ code: 'code-1', state: c.state }, s.cookie.value, ctx) as Promise<any>;
  }

  afterAll(async () => {
    const users = await raw.user.findMany({ where: { email: { in: emails } } });
    const ids = users.map((u) => u.id);
    const projects = (await raw.projectMember.findMany({ where: { userId: { in: ids } } })).map((m) => m.tenantId);
    await raw.authAudit.deleteMany({ where: { userId: { in: ids } } });
    await raw.emailToken.deleteMany({ where: { email: { in: emails } } });
    await raw.user.deleteMany({ where: { id: { in: ids } } });
    await raw.auditLog.deleteMany({ where: { tenantId: { in: projects } } });
    await raw.project.deleteMany({ where: { id: { in: projects } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('[AU:GO5] email mới -> tạo user ĐÃ xác minh, không mật khẩu, google_sub = sub, project đầu tiên; lần sau theo SUB (kể cả Google đổi email); email trùng user đã xác minh -> gắn sub + mail; user đã gắn sub KHÁC -> google_account_mismatch', async () => {
    const email = `gg-moi-${run}@gmail.test`;
    emails.push(email);
    const r = await signIn(`sub-a-${run}`, email, 'An');
    expect(r.redirect).toBe('http://web.test/dashboard');
    expect(r.session?.accessToken).toBeTruthy();
    const u = await raw.user.findUniqueOrThrow({ where: { email } });
    expect(u).toMatchObject({ googleSub: `sub-a-${run}`, passwordHash: null });
    expect(u.emailVerifiedAt).not.toBeNull();
    expect(await raw.projectMember.count({ where: { userId: u.id, role: 'owner' } })).toBe(1);
    expect((await signIn(`sub-a-${run}`, `doi-email-${run}@gmail.test`)).redirect).toBe('http://web.test/dashboard');
    expect(await raw.user.count({ where: { email: `doi-email-${run}@gmail.test` } })).toBe(0); // KHÔNG khoá theo email

    const v = `gg-lienket-${run}@gmail.test`;
    emails.push(v);
    const vu = await raw.user.create({ data: { email: v, name: 'Bình', passwordHash: 'x', emailVerifiedAt: new Date() } });
    expect((await signIn(`sub-b-${run}`, v)).redirect).toBe('http://web.test/dashboard');
    expect((await raw.user.findUniqueOrThrow({ where: { id: vu.id } })).googleSub).toBe(`sub-b-${run}`);
    expect(await raw.authAudit.count({ where: { userId: vu.id, action: 'google.linked' } })).toBe(1);
    await new Promise((res) => setTimeout(res, 50));
    expect(sent.some((m) => m.to === v && /Google/.test(m.subject))).toBe(true);

    const r2 = await signIn(`sub-khac-${run}`, v);
    expect(r2).toEqual({ redirect: 'http://web.test/login?error=google_account_mismatch' });
    expect((await raw.user.findUniqueOrThrow({ where: { id: vu.id } })).googleSub).toBe(`sub-b-${run}`);
  });

  it('[AU:GO6] chiếm trước (N-1): kẻ xấu đăng ký email nạn nhân (mật khẩu A, tên Attacker, có phiên + key) -> nạn nhân đăng nhập Google: tài khoản được NHẬN — mật khẩu A bị xoá, phiên/key cũ thu hồi, tên = tên Google, đã xác minh, gắn sub', async () => {
    const email = `gg-nannhan-${run}@gmail.test`;
    emails.push(email);
    const atk = await auth.register({ email, name: 'Attacker', password: 'mat-khau-ke-xau-2026' }, ctx);
    await atk.done;
    const u = await raw.user.findUniqueOrThrow({ where: { email } });
    const pid = (await raw.projectMember.findFirstOrThrow({ where: { userId: u.id } })).tenantId;
    await raw.apiKey.create({ data: { tenantId: pid, serviceName: 'ke-xau', keyPrefix: 'hk_test_gg', keyHash: `gg-${run}`, scopes: ['read:events'] } });
    const old = await auth.issueSession(u.id, null, null, ctx);
    const r = await signIn(`sub-v-${run}`, email, 'Nạn Nhân');
    expect(r.redirect).toBe('http://web.test/dashboard');
    const after = await raw.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after).toMatchObject({ passwordHash: null, name: 'Nạn Nhân', googleSub: `sub-v-${run}` });
    expect(after.emailVerifiedAt).not.toBeNull();
    expect((await raw.authSession.findUniqueOrThrow({ where: { id: old.sessionId } })).revokedAt).not.toBeNull();
    expect(await raw.apiKey.count({ where: { tenantId: pid, revokedAt: null } })).toBe(0);
    expect(await status(auth.login({ email, password: 'mat-khau-ke-xau-2026' }, ctx))).toBe('401 invalid_credentials');
    expect(await raw.authAudit.count({ where: { userId: u.id, action: 'user.account_claimed' } })).toBe(1);
  });

  it('[AU:GO7] 3 callback Google SONG SONG cho cùng email mới (P2002 email/google_sub) -> cả 3 vào /dashboard, đúng MỘT user', async () => {
    const email = `gg-dongthoi-${run}@gmail.test`;
    emails.push(email);
    claims = { sub: `sub-c-${run}`, email, name: 'C' };
    const starts = [0, 1, 2].map(() => {
      const s = google.start();
      return { s, c: openOAuthCookie(cfg.oauthCookieSecret, s.cookie.value, 'google')! };
    });
    // cả 3 lượt dùng chung nonce giả lập bằng cách ký theo nonce của từng lượt tuần tự trong fetch -> dùng nonce chung
    const nonce = starts[0].c.nonce!;
    currentNonce = nonce;
    const sealed = starts.map(() => starts[0]);
    const rs = await Promise.all(sealed.map(({ s, c }) => status(google.callback({ code: 'c', state: c.state }, s.cookie.value, ctx))));
    expect(rs.map((r: any) => r.redirect)).toEqual(Array(3).fill('http://web.test/dashboard'));
    expect(await raw.user.count({ where: { email } })).toBe(1);
  });

  it('[AU:GO8] (phần b) gỡ liên kết: chỉ có Google -> 409 last_login_method; có mật khẩu hoặc GitHub -> gỡ được; GitHub gỡ được khi còn Google', async () => {
    const p = (u: any) => ({ kind: 'user', id: u.id, sessionId: randomUUID(), email: u.email }) as any;
    const onlyGoogle = await raw.user.findUniqueOrThrow({ where: { email: `gg-moi-${run}@gmail.test` } });
    expect(await status(google.unlink(p(onlyGoogle), ctx))).toBe('409 last_login_method');
    const both = await raw.user.update({ where: { id: onlyGoogle.id }, data: { githubId: `77${run.replace(/\D/g, '').slice(0, 6) || '1'}` } });
    const github = new GithubOAuthService(auth, svc, cfg, loadGithubConfig({}), mail);
    await github.unlink(p(both), ctx); // còn Google -> gỡ GitHub được
    expect((await raw.user.findUniqueOrThrow({ where: { id: both.id } })).githubId).toBeNull();
    const withPw = await raw.user.findUniqueOrThrow({ where: { email: `gg-lienket-${run}@gmail.test` } });
    await google.unlink(p(withPw), ctx);
    expect((await raw.user.findUniqueOrThrow({ where: { id: withPw.id } })).googleSub).toBeNull();
    expect(await raw.authAudit.count({ where: { userId: withPw.id, action: 'google.unlinked' } })).toBe(1);
  });
});
