import * as bcrypt from 'bcryptjs';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { issueCsrfToken } from '@hub/common';
import { BCRYPT_COST, bcryptImpl, hashPassword, verifyPassword } from '../src/modules/auth/password-hasher';
import { AuthRateLimiter, RateLimitRedis } from '../src/modules/auth/rate-limit';
import { authSecretProblems, loadAuthConfig } from '../src/modules/auth/auth-config';
import { signAccessToken } from '../src/modules/auth/tokens';
import { SessionGuard } from '../src/modules/auth/session.guard';
import { AuthService } from '../src/modules/auth/auth.service';

const ENV = {
  JWT_SECRET: 'j'.repeat(40),
  CSRF_SECRET: 'c'.repeat(40),
  SOCKET_TICKET_SECRET: 's'.repeat(40),
  OAUTH_COOKIE_SECRET: 'o'.repeat(40),
};
const cfg = loadAuthConfig(ENV);
const jwt = new JwtService({});

async function status(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
    return { status: 200, body: null };
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
}

describe('cấu hình bí mật auth (SPEC-auth §7)', () => {
  it('mỗi secret ≥ 32 ký tự và KHÁC nhau', () => {
    expect(authSecretProblems(ENV)).toEqual([]);
    expect(authSecretProblems({ ...ENV, CSRF_SECRET: 'ngan' })).toEqual([expect.stringContaining('CSRF_SECRET')]);
    expect(authSecretProblems({ ...ENV, SOCKET_TICKET_SECRET: ENV.JWT_SECRET })).toEqual([expect.stringContaining('khác nhau')]);
  });
});

describe('băm mật khẩu', () => {
  it('[AU:UA1] bcrypt cost 12; verify đúng/sai; hash null vẫn chạy compare với hash giả', async () => {
    const h = await hashPassword('ca-phe-sua-da-2026');
    expect(BCRYPT_COST).toBe(12);
    expect(bcrypt.getRounds(h)).toBe(12);
    expect(await verifyPassword('ca-phe-sua-da-2026', h)).toBe(true);
    expect(await verifyPassword('sai-mat-khau-2026', h)).toBe(false);
    expect(await verifyPassword('ca-phe-sua-da-2026', null)).toBe(false);
  }, 20_000);
});

describe('rate limit auth (SPEC-auth §5.5)', () => {
  /** Redis giả có Lua tối thiểu: đếm + TTL theo đồng hồ giả. */
  function fakeRedis(clock: { now: number }): RateLimitRedis & { calls: number } {
    const store = new Map<string, { n: number; exp: number }>();
    return {
      calls: 0,
      async eval(script: string, _n: number, key: string, windowS?: number) {
        this.calls++;
        const cur = store.get(key);
        const live = cur && cur.exp > clock.now ? cur : undefined;
        if (script.includes('INCR')) {
          const next = live ? { n: live.n + 1, exp: live.exp } : { n: 1, exp: clock.now + Number(windowS) * 1000 };
          store.set(key, next);
          return [next.n, Math.ceil((next.exp - clock.now) / 1000)];
        }
        return [live?.n ?? 0, live ? Math.ceil((live.exp - clock.now) / 1000) : -2];
      },
    };
  }

  it('[AU:UA12] (phần a) 5 lần sai cho một email → lần 6 bị 429 kèm Retry-After, kể cả email không tồn tại', async () => {
    const clock = { now: 1_000_000 };
    const rl = new AuthRateLimiter(fakeRedis(clock), () => clock.now);
    const key = 'rl:login:em:khong-ton-tai';
    for (let i = 0; i < 5; i++) {
      expect((await rl.peek(key, 5)).allowed).toBe(true);
      await rl.hit(key, 5, 900);
    }
    const sixth = await rl.peek(key, 5);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterS).toBeGreaterThan(0);
    expect(sixth.retryAfterS).toBeLessThanOrEqual(900);
    clock.now += 901_000;
    expect((await rl.peek(key, 5)).allowed).toBe(true);
  });

  it('[AU:UA13] Redis ném lỗi → chuyển sang bộ đếm trong bộ nhớ, request vẫn chạy, vẫn chặn khi vượt', async () => {
    const broken: RateLimitRedis = { eval: async () => Promise.reject(new Error('ECONNREFUSED')) };
    const clock = { now: 5_000 };
    const rl = new AuthRateLimiter(broken, () => clock.now);
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await rl.hit('rl:reg:ip:1.2.3.4', 2, 3600)).allowed);
    expect(results).toEqual([true, true, false]);
  });
});

describe('SessionGuard — access token + CSRF', () => {
  const user = { id: 'u-1', email: 'a@b.vn', name: 'A', isOperator: false, emailVerifiedAt: null };
  const store = {
    identity: () => ({
      findLiveSessionWithUser: async (sid: string) => (sid === 'sid-1' ? { id: 'sid-1', userId: 'u-1', user } : null),
    }),
  };
  const guard = new SessionGuard(store as never, jwt, cfg);
  const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;
  const req = (token: string | undefined, method = 'GET', extra: Record<string, unknown> = {}) => ({
    method,
    cookies: token ? { '__Host-hub_at': token, ...((extra.cookies as object) ?? {}) } : {},
    headers: (extra.headers as object) ?? {},
  });
  const good = () => signAccessToken(jwt, cfg, { userId: 'u-1', sessionId: 'sid-1' });

  it('token hợp lệ + session sống → principal user', async () => {
    const r: any = req(good());
    expect(await guard.canActivate(ctx(r))).toBe(true);
    expect(r.principal).toMatchObject({ kind: 'user', id: 'u-1', sessionId: 'sid-1' });
  });

  it('[AU:UA6] alg:none / sai aud / sai iss / hết hạn / thiếu cookie → 401', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: 'u-1', sid: 'sid-1', iss: 'webhook-hub', aud: 'console', iat: now, exp: now + 600 };
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    const wrongAud = jwt.sign({ sub: 'u-1', sid: 'sid-1' }, { secret: ENV.JWT_SECRET, algorithm: 'HS256', issuer: 'webhook-hub', audience: 'socket', expiresIn: 600 });
    const wrongIss = jwt.sign({ sub: 'u-1', sid: 'sid-1' }, { secret: ENV.JWT_SECRET, algorithm: 'HS256', issuer: 'evil', audience: 'console', expiresIn: 600 });
    const expired = jwt.sign({ ...claims, iat: now - 1000, exp: now - 10 }, { secret: ENV.JWT_SECRET, algorithm: 'HS256' });
    const wrongKey = jwt.sign({ sub: 'u-1', sid: 'sid-1' }, { secret: 'x'.repeat(40), algorithm: 'HS256', issuer: 'webhook-hub', audience: 'console', expiresIn: 600 });
    for (const t of [none, wrongAud, wrongIss, expired, wrongKey, undefined]) {
      expect((await status(guard.canActivate(ctx(req(t))))).status).toBe(401);
    }
  });

  it('[AU:UA11] POST thiếu x-csrf-token / chữ ký sai / ký cho sid khác → 403 csrf_failed; đúng → qua', async () => {
    const t = good();
    const csrf = issueCsrfToken(ENV.CSRF_SECRET, 'sid-1');
    const other = issueCsrfToken(ENV.CSRF_SECRET, 'sid-2');
    const forged = csrf.slice(0, -3) + 'AAA';
    const cases = [
      { cookies: { hub_csrf: csrf }, headers: {} },
      { cookies: { hub_csrf: forged }, headers: { 'x-csrf-token': forged } },
      { cookies: { hub_csrf: other }, headers: { 'x-csrf-token': other } },
    ];
    for (const c of cases) {
      const r = await status(guard.canActivate(ctx(req(t, 'POST', c))));
      expect(r).toEqual({ status: 403, body: expect.objectContaining({ error: 'csrf_failed' }) });
    }
    expect(await guard.canActivate(ctx(req(t, 'POST', { cookies: { hub_csrf: csrf }, headers: { 'x-csrf-token': csrf } })))).toBe(true);
  });
});

describe('AuthService — đăng ký / đăng nhập (store giả, không DB)', () => {
  const noRedis: RateLimitRedis = { eval: async (s: string) => (s.includes('INCR') ? [1, 900] : [0, -2]) };
  const makeService = (users: Record<string, any> = {}) => {
    const store: any = {
      identity: () => ({
        findUserByEmail: async (e: string) => users[e] ?? null,
        recordAuthAudit: async () => undefined,
      }),
    };
    return new AuthService(store, jwt, cfg, new AuthRateLimiter(noRedis));
  };
  const ctx = { ip: '10.0.0.1', userAgent: 'jest' };

  it('[AU:UA2] mật khẩu 73 byte (tiếng Việt có dấu) → 422 password_too_long', async () => {
    const r = await status(makeService().register({ email: 'a@b.vn', name: 'An', password: 'đ'.repeat(36) + 'a' }, ctx));
    expect(r).toEqual({ status: 422, body: expect.objectContaining({ error: 'password_too_long' }) });
  });

  it('[AU:UA3] mật khẩu phổ biến / chứa phần trước @ của email → 422 password_weak', async () => {
    for (const password of ['1234567890', 'QwertyUiop', 'toi-la-annguyen-2026']) {
      const r = await status(makeService().register({ email: 'annguyen@gmail.com', name: 'An', password }, ctx));
      expect(r).toEqual({ status: 422, body: expect.objectContaining({ error: 'password_weak' }) });
    }
  });

  it('[AU:UA12] (phần b) R-1: 18 lần sai SONG SONG cho một email -> đúng 5 lượt tới bcrypt (401), 13 lượt 429 — đếm trước khi so', async () => {
    const counts = new Map<string, number>();
    const atomic: RateLimitRedis = {
      // Redis đơn luồng: INCR nguyên tử. Fake này cũng nguyên tử (JS đơn luồng, tăng ngay khi gọi).
      eval: async (script: string, _n: number, key: string) => {
        if (script.includes('DECR')) counts.set(String(key), Math.max(0, (counts.get(String(key)) ?? 0) - 1));
        else if (script.includes('INCR')) counts.set(String(key), (counts.get(String(key)) ?? 0) + 1);
        return [counts.get(String(key)) ?? 0, 900];
      },
    };
    const store: any = { identity: () => ({ findUserByEmail: async () => null, recordAuthAudit: async () => undefined }) };
    const svc = new AuthService(store, jwt, cfg, new AuthRateLimiter(atomic));
    const results = await Promise.all(Array.from({ length: 18 }, () => status(svc.login({ email: 'nannhan@b.vn', password: 'doan-mo-2026' }, { ip: null, userAgent: null }))));
    const by = results.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    expect(by).toEqual({ 401: 5, 429: 13 });
  }, 30_000);

  it('[AU:UA4] login email không tồn tại → 401 CÙNG body với sai mật khẩu; bcrypt.compare vẫn được gọi', async () => {
    const hash = await hashPassword('dung-mat-khau-2026');
    const svc = makeService({ 'co@b.vn': { id: 'u1', email: 'co@b.vn', passwordHash: hash } });
    const spy = jest.spyOn(bcryptImpl, 'compare');
    const missing = await status(svc.login({ email: 'khong@b.vn', password: 'bat-ky-mat-khau' }, ctx));
    const callsAfterMissing = spy.mock.calls.length;
    const wrong = await status(svc.login({ email: 'co@b.vn', password: 'sai-mat-khau-2026' }, ctx));
    expect(callsAfterMissing).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(missing).toEqual(wrong);
    expect(missing).toEqual({ status: 401, body: { error: 'invalid_credentials', message: expect.any(String) } });
    spy.mockRestore();
  }, 20_000);
});
