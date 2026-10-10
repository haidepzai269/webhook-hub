import { createHash, randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MailMessage, MailSender, testOnlyConfigProblems } from '@hub/common';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { AuthService } from '../src/modules/auth/auth.service';
import { AuthRateLimiter } from '../src/modules/auth/rate-limit';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { GithubOAuthService, loadGithubConfig } from '../src/modules/auth/github-oauth.service';

/**
 * SPEC-auth §5.10 (AU5) trên Postgres THẬT, GitHub là fetch giả (DINH-CHINH-AUTH §4 #9; fake-github là VF4):
 * state + PKCE trong cookie ký HMAC, ghép tài khoản an toàn, operator không đăng nhập bằng GitHub, gỡ liên kết.
 */
describeDb('Đăng nhập GitHub (Postgres + fetch giả, AU5)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const env = {
    JWT_SECRET: 'j'.repeat(40),
    CSRF_SECRET: 'c'.repeat(40),
    SOCKET_TICKET_SECRET: 's'.repeat(40),
    OAUTH_COOKIE_SECRET: 'o'.repeat(40),
    WEB_PUBLIC_URL: 'http://web.test',
    GITHUB_OAUTH_CLIENT_ID: 'gh-client',
    GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
    GITHUB_OAUTH_BASE_URL: 'http://fake-github.test',
  };
  const cfg = loadAuthConfig(env);
  const sent: MailMessage[] = [];
  const mail: MailSender = { send: async (m) => void sent.push(m) };
  const auth = new AuthService(svc, new JwtService({}), cfg, new AuthRateLimiter(null), undefined, mail);
  const run = randomUUID().slice(0, 8);
  const ctx = { ip: '10.5.5.5', userAgent: 'jest' };
  const createdEmails: string[] = [];

  /** GitHub giả: ghi lại request, trả user/emails theo kịch bản. */
  let ghUser = { id: 1000, login: 'octo', name: 'Octo' };
  let ghEmails: { email: string; primary: boolean; verified: boolean }[] = [];
  const calls: { url: string; init: any }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.endsWith('/login/oauth/access_token')) return json({ access_token: 'gho_FAKE', token_type: 'bearer' });
    if (url.endsWith('/user')) return json(ghUser);
    if (url.endsWith('/user/emails')) return json(ghEmails);
    return json({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
  const gh = new GithubOAuthService(auth, svc, cfg, loadGithubConfig(env), mail, fakeFetch);

  const status = async (p: Promise<unknown>) => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof HttpException) return `${e.getStatus()} ${(e.getResponse() as any).error}`;
      throw e;
    }
  };
  /** Chạy trọn vòng: /auth/github -> (GitHub chuyển về) callback với đúng state + cookie. */
  async function roundTrip(email: string, opts: { verified?: boolean; id?: number } = {}) {
    ghUser = { id: opts.id ?? Math.floor(Math.random() * 1e9), login: 'octo', name: 'Octo' };
    ghEmails = [{ email, primary: true, verified: opts.verified ?? true }];
    const start = gh.start();
    const state = new URL(start.redirectUrl).searchParams.get('state')!;
    return gh.callback({ code: 'code-1', state }, start.cookie.value, ctx);
  }

  afterAll(async () => {
    const users = await raw.user.findMany({ where: { email: { in: createdEmails } } });
    const ids = users.map((u) => u.id);
    const projects = (await raw.projectMember.findMany({ where: { userId: { in: ids } } })).map((m) => m.tenantId);
    await raw.authAudit.deleteMany({ where: { userId: { in: ids } } });
    await raw.user.deleteMany({ where: { id: { in: ids } } });
    await raw.auditLog.deleteMany({ where: { tenantId: { in: projects } } });
    await raw.project.deleteMany({ where: { id: { in: projects } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('/auth/github: redirect tới GitHub với scope read:user user:email, state, PKCE S256; cookie __Host-hub_oauth HttpOnly 10 phút, ký HMAC', () => {
    const s = gh.start();
    const u = new URL(s.redirectUrl);
    expect(`${u.origin}${u.pathname}`).toBe('http://fake-github.test/login/oauth/authorize');
    expect(u.searchParams.get('scope')).toBe('read:user user:email');
    expect(u.searchParams.get('redirect_uri')).toBe('http://web.test/auth/github/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.cookie).toMatchObject({ name: '__Host-hub_oauth', options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600_000 } });
    expect(s.cookie.value).not.toContain(u.searchParams.get('code_challenge')!); // verifier không lộ ra URL
  });

  it('[AU:UA23] callback: state khác cookie / cookie bị sửa / thiếu cookie -> 400 oauth_state_mismatch, không gọi GitHub', async () => {
    const s = gh.start();
    const before = calls.length;
    expect(await status(gh.callback({ code: 'c', state: 'state-khac' }, s.cookie.value, ctx))).toBe('400 oauth_state_mismatch');
    const state = new URL(s.redirectUrl).searchParams.get('state')!;
    const tampered = s.cookie.value.slice(0, -2) + (s.cookie.value.endsWith('A') ? 'BB' : 'AA');
    expect(await status(gh.callback({ code: 'c', state }, tampered, ctx))).toBe('400 oauth_state_mismatch');
    expect(await status(gh.callback({ code: 'c', state }, undefined, ctx))).toBe('400 oauth_state_mismatch');
    expect(calls.length).toBe(before);
  });

  it('PKCE: đổi code gửi kèm code_verifier khớp code_challenge; access token GitHub không được lưu', async () => {
    const email = `pkce-${run}@gh.test`;
    createdEmails.push(email);
    ghUser = { id: 4242, login: 'p', name: 'P' };
    ghEmails = [{ email, primary: true, verified: true }];
    const s = gh.start();
    const u = new URL(s.redirectUrl);
    await gh.callback({ code: 'c', state: u.searchParams.get('state')! }, s.cookie.value, ctx);
    const tok = calls.find((c) => c.url.endsWith('/login/oauth/access_token'))!;
    const body = JSON.parse(tok.init.body);
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(u.searchParams.get('code_challenge'));
    expect(body).toMatchObject({ client_id: 'gh-client', client_secret: 'gh-secret', code: 'c', redirect_uri: 'http://web.test/auth/github/callback' });
    const row = await raw.user.findUniqueOrThrow({ where: { email } });
    expect(JSON.stringify(row)).not.toContain('gho_FAKE');
  });

  it('email mới -> tạo user đã xác minh (không mật khẩu) + project đầu tiên -> /onboarding; lần sau theo githubId -> /dashboard', async () => {
    const email = `moi-${run}@gh.test`;
    createdEmails.push(email);
    const r: any = await roundTrip(email, { id: 77001 });
    expect(r.redirect).toBe('http://web.test/onboarding');
    expect(r.session?.accessToken).toBeTruthy();
    const u = await raw.user.findUniqueOrThrow({ where: { email } });
    expect(u).toMatchObject({ githubId: '77001', passwordHash: null });
    expect(u.emailVerifiedAt).not.toBeNull();
    expect(await raw.projectMember.count({ where: { userId: u.id, role: 'owner' } })).toBe(1);
    ghEmails = [{ email: `doi-email-${run}@gh.test`, primary: true, verified: true }]; // GitHub đổi email: vẫn nhận theo id
    const s = gh.start();
    const again: any = await gh.callback({ code: 'c', state: new URL(s.redirectUrl).searchParams.get('state')! }, s.cookie.value, ctx);
    expect(again.redirect).toBe('http://web.test/dashboard');
  });

  it('GitHub không có email primary + verified -> /login?error=github_email_unverified, không tạo gì', async () => {
    const email = `chua-xm-${run}@gh.test`;
    const r: any = await roundTrip(email, { verified: false });
    expect(r).toEqual({ redirect: 'http://web.test/login?error=github_email_unverified' });
    expect(await raw.user.count({ where: { email } })).toBe(0);
  });

  it('[AU:UA24] email trùng user CHƯA xác minh -> KHÔNG liên kết, /login?error=email_exists_unverified', async () => {
    const email = `chiem-${run}@gh.test`;
    createdEmails.push(email);
    const victim = await raw.user.create({ data: { email, name: 'Người đăng ký trước', passwordHash: 'x' } });
    const r: any = await roundTrip(email);
    expect(r).toEqual({ redirect: 'http://web.test/login?error=email_exists_unverified' });
    expect((await raw.user.findUniqueOrThrow({ where: { id: victim.id } })).githubId).toBeNull();
  });

  it('[AU:UA25] email trùng user ĐÃ xác minh -> liên kết githubId, auth_audit github.linked, mail báo', async () => {
    const email = `lienket-${run}@gh.test`;
    createdEmails.push(email);
    const u = await raw.user.create({ data: { email, name: 'An', passwordHash: 'x', emailVerifiedAt: new Date() } });
    const r: any = await roundTrip(email, { id: 88001 });
    expect(r.redirect).toBe('http://web.test/dashboard');
    expect((await raw.user.findUniqueOrThrow({ where: { id: u.id } })).githubId).toBe('88001');
    expect(await raw.authAudit.count({ where: { userId: u.id, action: 'github.linked' } })).toBe(1);
    await new Promise((res) => setTimeout(res, 50));
    expect(sent.some((m) => m.to === email && /GitHub/.test(m.subject))).toBe(true);
  });

  it('operator không đăng nhập bằng GitHub (kể cả email trùng) -> /login?error=operator_github_forbidden', async () => {
    const email = `op-${run}@gh.test`;
    createdEmails.push(email);
    await raw.user.create({ data: { email, name: 'Op', passwordHash: 'x', emailVerifiedAt: new Date(), isOperator: true } });
    expect(await roundTrip(email)).toEqual({ redirect: 'http://web.test/login?error=operator_github_forbidden' });
  });

  it('unlink: chưa có mật khẩu -> 409 last_login_method; có mật khẩu -> gỡ + audit github.unlinked', async () => {
    const onlyGh = await raw.user.findUniqueOrThrow({ where: { email: `moi-${run}@gh.test` } });
    const p = (u: any) => ({ kind: 'user', id: u.id, sessionId: randomUUID(), email: u.email } as any);
    expect(await status(gh.unlink(p(onlyGh), ctx))).toBe('409 last_login_method');
    const linked = await raw.user.findUniqueOrThrow({ where: { email: `lienket-${run}@gh.test` } });
    await gh.unlink(p(linked), ctx);
    expect((await raw.user.findUniqueOrThrow({ where: { id: linked.id } })).githubId).toBeNull();
    expect(await raw.authAudit.count({ where: { userId: linked.id, action: 'github.unlinked' } })).toBe(1);
  });

  it('production: GITHUB_OAUTH_BASE_URL khác https://github.com -> app thoát lúc khởi động', () => {
    expect(testOnlyConfigProblems({ NODE_ENV: 'production', GITHUB_OAUTH_BASE_URL: 'http://fake-github:8080' })).toEqual([expect.stringContaining('GITHUB_OAUTH_BASE_URL')]);
    expect(testOnlyConfigProblems({ NODE_ENV: 'production', GITHUB_OAUTH_BASE_URL: 'https://github.com' })).toEqual([]);
    expect(testOnlyConfigProblems({ NODE_ENV: 'development', GITHUB_OAUTH_BASE_URL: 'http://fake-github:8080' })).toEqual([]);
  });
});
