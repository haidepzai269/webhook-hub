import { createHash, generateKeyPairSync, KeyObject, sign } from 'crypto';
import { HttpException } from '@nestjs/common';
import { GoogleJwks, verifyGoogleIdToken } from '../src/modules/auth/google-id-token';
import { GoogleOAuthService, loadGoogleConfig } from '../src/modules/auth/google-oauth.service';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { openOAuthCookie, sealOAuthCookie, safeNextPath } from '../src/modules/auth/oauth-cookie';
import { testOnlyConfigProblems } from '@hub/common';

/** AU5b (ADR-127): ID token Google + luồng OAuth — HTTP luôn GIẢ (khoá RSA sinh trong test), không gọi Google thật. */
const CLIENT = 'cid-123.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const nowS = Math.floor(NOW / 1000);

function rsa() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) as { n: string; e: string } };
}
const K1 = rsa();
const K2 = rsa();
const KEVIL = rsa();

function idToken(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) {
  const h = Buffer.from(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), opts.key ?? K1.privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}
const good = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com', aud: CLIENT, sub: '1098765', email: 'an@gmail.com', email_verified: true, name: 'An Nguyễn',
  iat: nowS - 10, exp: nowS + 3600, nonce: 'n-1', ...over,
});

function jwksServer(sets: { kid: string; jwk: { n: string; e: string } }[][]) {
  let i = 0;
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n++;
    const keys = sets[Math.min(i++, sets.length - 1)].map((k) => ({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: k.kid, ...k.jwk }));
    return { ok: true, status: 200, headers: new Headers({ 'cache-control': 'public, max-age=3600' }), json: async () => ({ keys }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('ID token Google (ADR-127)', () => {
  const verify = (tok: string, nonce = 'n-1', jwks = new GoogleJwks('https://jwks', jwksServer([[{ kid: 'k1', jwk: K1.jwk }]]).fetchImpl, () => NOW)) =>
    verifyGoogleIdToken(tok, { jwks, clientId: CLIENT, nonce, now: () => NOW }).then(
      (c) => c,
      (e: Error & { reason?: string }) => `ERR:${e.reason}`,
    );

  it('[AU:GO1] hợp lệ -> sub/email/email_verified/name; sai chữ ký, sai aud, sai iss, hết hạn, nonce lệch, alg khác, rác -> từ chối', async () => {
    expect(await verify(idToken(good()))).toEqual({ sub: '1098765', email: 'an@gmail.com', emailVerified: true, name: 'An Nguyễn' });
    expect(await verify(idToken(good({ iss: 'accounts.google.com' })))).toMatchObject({ sub: '1098765' });
    expect(await verify(idToken(good(), { key: KEVIL.privateKey }))).toBe('ERR:signature');
    expect(await verify(idToken(good({ aud: 'client-khac' })))).toBe('ERR:aud');
    expect(await verify(idToken(good({ aud: [CLIENT, 'x'], azp: 'x' })))).toBe('ERR:aud');
    expect(await verify(idToken(good({ iss: 'https://evil.example' })))).toBe('ERR:iss');
    expect(await verify(idToken(good({ exp: nowS - 120 })))).toBe('ERR:expired');
    expect(await verify(idToken(good({ iat: nowS + 600 })))).toBe('ERR:iat_future');
    expect(await verify(idToken(good()), 'nonce-khac')).toBe('ERR:nonce');
    expect(await verify(idToken(good({ nonce: undefined })))).toBe('ERR:nonce');
    expect(await verify(idToken(good(), { alg: 'HS256' }))).toBe('ERR:alg');
    expect(await verify('a.b')).toBe('ERR:malformed');
    const [h, , s] = idToken(good()).split('.');
    const forged = Buffer.from(JSON.stringify(good({ sub: 'ke-xau' }))).toString('base64url');
    expect(await verify(`${h}.${forged}.${s}`)).toBe('ERR:signature');
  });

  it('[AU:GO2] JWKS: cache theo max-age; kid mới (Google xoay khoá) -> tải lại MỘT lần; kid rác lặp lại không làm bão gọi Google', async () => {
    const srv = jwksServer([[{ kid: 'k1', jwk: K1.jwk }], [{ kid: 'k1', jwk: K1.jwk }, { kid: 'k2', jwk: K2.jwk }]]);
    let t = NOW;
    const jwks = new GoogleJwks('https://jwks', srv.fetchImpl, () => t);
    const v = (tok: string) => verifyGoogleIdToken(tok, { jwks, clientId: CLIENT, nonce: 'n-1', now: () => t });
    await v(idToken(good()));
    await v(idToken(good()));
    expect(srv.calls.n).toBe(1);
    t += 31_000;
    await expect(v(idToken(good(), { key: K2.privateKey, kid: 'k2' }))).resolves.toMatchObject({ sub: '1098765' });
    expect(srv.calls.n).toBe(2);
    for (let i = 0; i < 5; i++) await expect(v(idToken(good(), { kid: 'rac' }))).rejects.toMatchObject({ reason: 'kid_unknown' });
    expect(srv.calls.n).toBe(2); // trong 30 s không tải lại
  });
});

describe('Review AU5b GO-3', () => {
  it('[AR:GO-3] azp có mặt thì PHẢI bằng client id, kể cả khi aud là chuỗi đúng; claim hd được trả ra', async () => {
    const jwks = new GoogleJwks('https://jwks', jwksServer([[{ kid: 'k1', jwk: K1.jwk }]]).fetchImpl, () => NOW);
    const v = (claims: Record<string, unknown>) =>
      verifyGoogleIdToken(idToken(claims), { jwks, clientId: CLIENT, nonce: 'n-1', now: () => NOW }).then((c) => c, (e: any) => `ERR:${e.reason}`);
    expect(await v(good({ azp: 'client-khac' }))).toBe('ERR:aud');
    expect(await v(good({ azp: CLIENT, hd: 'cong-ty.vn' }))).toMatchObject({ sub: '1098765', hd: 'cong-ty.vn' });
  });
});

describe('Luồng OAuth Google (ADR-127)', () => {
  const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40), WEB_PUBLIC_URL: 'http://web.test' });
  const gcfg = loadGoogleConfig({ GOOGLE_OAUTH_CLIENT_ID: CLIENT, GOOGLE_OAUTH_CLIENT_SECRET: 'sec' });
  function make(token: (body: URLSearchParams) => { status: number; body: unknown }) {
    const seen: URLSearchParams[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ keys: [{ kty: 'RSA', kid: 'k1', alg: 'RS256', ...K1.jwk }] }) };
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(init.body);
        seen.push(body);
        const r = token(body);
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      }
      throw new Error(`URL lạ ${url}`);
    }) as unknown as typeof fetch;
    const matched: any[] = [];
    const svc = new GoogleOAuthService({} as any, {} as any, cfg, gcfg, { send: async () => undefined } as any, fetchImpl, () => NOW);
    (svc as any).match = async (p: any, next: any) => (matched.push({ p, next }), { redirect: `http://web.test${next ?? '/dashboard'}` });
    return { svc, seen, matched };
  }
  const ctx = { ip: null, userAgent: null };
  const st = async (p: Promise<unknown>) => p.then((r) => r, (e) => (e instanceof HttpException ? `${e.getStatus()} ${(e.getResponse() as any).error}` : Promise.reject(e)));

  it('[AU:GO3] start(): code + PKCE S256 + state + nonce, scope `openid email profile`, prompt=select_account; cookie ký HMAC mang provider google + next AN TOÀN; chưa cấu hình -> 503', () => {
    const { svc } = make(() => ({ status: 500, body: {} }));
    const s = svc.start('/invite?x=1');
    const u = new URL(s.redirectUrl);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT, response_type: 'code', scope: 'openid email profile', prompt: 'select_account', code_challenge_method: 'S256',
      redirect_uri: 'http://web.test/auth/google/callback',
    });
    const c = openOAuthCookie(cfg.oauthCookieSecret, s.cookie.value, 'google', NOW)!;
    expect(c.next).toBe('/invite?x=1');
    expect(u.searchParams.get('state')).toBe(c.state);
    expect(u.searchParams.get('nonce')).toBe(c.nonce);
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(c.verifier).digest('base64url'));
    expect(openOAuthCookie(cfg.oauthCookieSecret, s.cookie.value, 'github', NOW)).toBeNull(); // không dùng chéo luồng GitHub
    expect(s.cookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
    for (const bad of ['//evil.com', '/%09/evil.com'.replace('%09', '\t'), 'https://evil.com', '/\\evil.com'.replace('\\\\', '\\')]) {
      expect(openOAuthCookie(cfg.oauthCookieSecret, svc.start(bad).cookie.value, 'google', NOW)!.next).toBeUndefined();
    }
    expect(safeNextPath('/dashboard/events?x=1', 'http://web.test')).toBe('/dashboard/events?x=1');
    const off = new GoogleOAuthService({} as any, {} as any, cfg, loadGoogleConfig({}), {} as any);
    expect(() => off.start()).toThrow(HttpException);
  });

  it('[AU:GO4] callback: state lệch / cookie GitHub / cookie sửa -> 400; từ chối ở Google -> google_denied; ID token sai (nonce khác) -> google_failed; email chưa xác minh -> google_email_unverified; đúng -> PKCE verifier gửi kèm', async () => {
    const tok = (claims: Record<string, unknown>) => () => ({ status: 200, body: { id_token: idToken(claims), access_token: 'ya29.bo-di' } });
    const flow = (claims: Record<string, unknown>, mutate?: (c: any) => any) => {
      const m = make(tok(claims));
      const s = m.svc.start();
      const c = openOAuthCookie(cfg.oauthCookieSecret, s.cookie.value, 'google', NOW)!;
      const claimsWithNonce = { ...claims, nonce: claims.nonce ?? c.nonce };
      (m as any).svc = new GoogleOAuthService({} as any, {} as any, cfg, gcfg, { send: async () => undefined } as any, ((url: string, init: any) =>
        url.includes('token') ? (m.seen.push(new URLSearchParams(init.body)), Promise.resolve({ ok: true, status: 200, json: async () => ({ id_token: idToken(claimsWithNonce) }) }))
        : Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({ keys: [{ kty: 'RSA', kid: 'k1', ...K1.jwk }] }) })) as any, () => NOW);
      (m.svc as any).match = async (p: any) => (m.matched.push(p), { redirect: 'ok' });
      const cookie = mutate ? mutate(s.cookie.value) : s.cookie.value;
      return { m, state: c.state, cookie, verifier: c.verifier };
    };
    let f = flow(good({ nonce: undefined }));
    expect(await st(f.m.svc.callback({ code: 'c', state: 'khac' }, f.cookie, ctx))).toBe('400 oauth_state_mismatch');
    const ghCookie = sealOAuthCookie(cfg.oauthCookieSecret, { p: 'github', state: f.state, verifier: 'v', exp: NOW + 60_000 });
    expect(await st(f.m.svc.callback({ code: 'c', state: f.state }, ghCookie, ctx))).toBe('400 oauth_state_mismatch');
    expect(await st(f.m.svc.callback({ code: 'c', state: f.state }, f.cookie.slice(0, -2) + 'xx', ctx))).toBe('400 oauth_state_mismatch');
    expect(await f.m.svc.callback({ state: f.state, error: 'access_denied' }, f.cookie, ctx)).toEqual({ redirect: 'http://web.test/login?error=google_denied' });
    f = flow(good({ nonce: 'nonce-cua-luot-khac' }));
    expect(await f.m.svc.callback({ code: 'c', state: f.state }, f.cookie, ctx)).toEqual({ redirect: 'http://web.test/login?error=google_failed' });
    f = flow(good({ nonce: undefined, email_verified: false }));
    expect(await f.m.svc.callback({ code: 'c', state: f.state }, f.cookie, ctx)).toEqual({ redirect: 'http://web.test/login?error=google_email_unverified' });
    f = flow(good({ nonce: undefined }));
    expect(await f.m.svc.callback({ code: 'c', state: f.state }, f.cookie, ctx)).toEqual({ redirect: 'ok' });
    expect(f.m.matched[0]).toMatchObject({ sub: '1098765', email: 'an@gmail.com', emailVerified: true });
    expect(f.m.seen.at(-1)!.get('code_verifier')).toBe(f.verifier);
    expect(f.m.seen.at(-1)!.get('grant_type')).toBe('authorization_code');
  });

  it('[AU:GO8] (phần a) fake-google CHỈ ngoài production: production bỏ qua GOOGLE_OAUTH_FAKE_BASE_URL và test-only-config làm app thoát', () => {
    expect(loadGoogleConfig({ GOOGLE_OAUTH_FAKE_BASE_URL: 'http://sink:4100/fake-google' }).tokenUrl).toBe('http://sink:4100/fake-google/token');
    const prod = loadGoogleConfig({ NODE_ENV: 'production', GOOGLE_OAUTH_FAKE_BASE_URL: 'http://sink:4100/fake-google' });
    expect([prod.authUrl, prod.tokenUrl, prod.jwksUrl]).toEqual([
      'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs',
    ]);
    expect(testOnlyConfigProblems({ NODE_ENV: 'production', GOOGLE_OAUTH_FAKE_BASE_URL: 'http://x' }).join()).toMatch(/GOOGLE_OAUTH_FAKE_BASE_URL/);
  });
});
