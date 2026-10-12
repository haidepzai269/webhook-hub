import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createMailSender } from '@hub/common';
import { AuthService, REGISTER_ACCEPTED } from '../src/modules/auth/auth.service';
import { AuthRateLimiter } from '../src/modules/auth/rate-limit';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { EMAIL_FILTER_CHANNEL, EmailFilterService, keyOf, loadEmailFilterConfig } from '../src/modules/auth/email-filter.service';
import { dispatchRedisMessage, onRedisChannelAdded, registeredRedisChannels } from '../src/modules/redis/redis-channels';
import { apiRegistry } from '../src/modules/metrics/metrics';

/**
 * ADR-180 — Bloom filter gợi ý "email đã có tài khoản" (SPEC-email-cuckoo, đính chính: Bloom thay Cuckoo).
 * Filter là đường tắt (BB-2): âm tính không chạm DB, dương tính xác nhận bằng DB; `/auth/register` vẫn R-6.
 */

const cfg = { capacity: 1_000, errorRate: 0.001, rebuildMs: 0, batchSize: 2 };

/** Store giả: bảng users trong bộ nhớ, đếm truy vấn `findUserByEmail` (spy "có chạm DB không"). */
function fakeStore(emails: string[] = []) {
  const users = emails.map((email, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, email }));
  const calls = { findUserByEmail: 0, listUserEmailsAfter: [] as (string | null)[] };
  const idn = {
    findUserByEmail: async (email: string) => {
      calls.findUserByEmail++;
      return users.find((u) => u.email === email) ?? null;
    },
    listUserEmailsAfter: async (after: string | null, take: number) => {
      calls.listUserEmailsAfter.push(after);
      return users.filter((u) => after === null || u.id > after).slice(0, take);
    },
  };
  return { store: { identity: () => idn } as never, users, calls };
}

async function counter(result: string): Promise<number> {
  const m = await apiRegistry.getSingleMetric('hub_email_filter_checks_total')!.get();
  return m.values.find((v) => v.labels.result === result)?.value ?? 0;
}

describe('EmailFilterService (ADR-180)', () => {
  it('cấu hình: mặc định 100 000 / 10 phút; giá trị rác -> mặc định; 0 tắt dựng lại định kỳ', () => {
    expect(loadEmailFilterConfig({})).toMatchObject({ capacity: 100_000, errorRate: 0.001, rebuildMs: 600_000 });
    expect(loadEmailFilterConfig({ EMAIL_FILTER_CAPACITY: 'abc', EMAIL_FILTER_REBUILD_MS: '-1' })).toMatchObject({ capacity: 100_000, rebuildMs: 600_000 });
    expect(loadEmailFilterConfig({ EMAIL_FILTER_CAPACITY: '5000', EMAIL_FILTER_REBUILD_MS: '0' })).toMatchObject({ capacity: 5_000, rebuildMs: 0 });
  });

  it('dựng từ users theo lô keyset (id) — không OFFSET; chưa dựng xong -> đi DB (db_fallback)', async () => {
    const { store, calls } = fakeStore(['a@x.vn', 'b@x.vn', 'c@x.vn']);
    const f = new EmailFilterService(store, null, cfg);
    expect(f.ready).toBe(false);
    const before = await counter('db_fallback');
    expect(await f.isAvailable('a@x.vn')).toEqual({ available: false, result: 'db_fallback' });
    expect(await f.isAvailable('moi@x.vn')).toEqual({ available: true, result: 'db_fallback' });
    expect(await counter('db_fallback')).toBe(before + 2);

    await f.rebuild();
    expect(f.ready).toBe(true);
    expect(f.size).toBe(3);
    // batch 2: lô 1 (null) -> lô 2 sau id thứ 2 -> lô ngắn thì dừng
    expect(calls.listUserEmailsAfter).toEqual([null, '00000000-0000-0000-0000-000000000001']);
  });

  it('âm tính -> available:true, KHÔNG gọi DB; có -> DB xác nhận -> false', async () => {
    const { store, calls } = fakeStore(['co@x.vn']);
    const f = new EmailFilterService(store, null, cfg);
    await f.rebuild();
    calls.findUserByEmail = 0;
    expect(await f.isAvailable('moi-tinh@x.vn')).toEqual({ available: true, result: 'negative' });
    expect(calls.findUserByEmail).toBe(0);
    expect(await f.isAvailable('co@x.vn')).toEqual({ available: false, result: 'positive_confirmed' });
    expect(calls.findUserByEmail).toBe(1);
  });

  it('chuẩn hoá hoa/thường + khoảng trắng dùng chung normalizeEmail', async () => {
    const { store } = fakeStore(['an@x.vn']);
    const f = new EmailFilterService(store, null, cfg);
    await f.rebuild();
    expect(keyOf('  AN@X.VN ')).toBe(keyOf('an@x.vn'));
    expect((await f.isAvailable('  An@X.vn  ')).available).toBe(false);
  });

  it('dương tính giả (filter nói có, DB không có) -> DB -> available:true', async () => {
    const { store, calls } = fakeStore([]);
    const f = new EmailFilterService(store, null, cfg);
    await f.rebuild();
    // Thêm vào filter mà KHÔNG có trong DB = mô phỏng đúng một dương tính giả.
    f.recordCreated('ma@x.vn');
    calls.findUserByEmail = 0;
    expect(await f.isAvailable('ma@x.vn')).toEqual({ available: true, result: 'false_positive' });
    expect(calls.findUserByEmail).toBe(1);
  });

  it('vượt dung lượng -> degraded, mọi kiểm tra đi DB', async () => {
    const emails = Array.from({ length: 5 }, (_, i) => `u${i}@x.vn`);
    const { store, calls } = fakeStore(emails);
    const f = new EmailFilterService(store, null, { ...cfg, capacity: 4 });
    await f.rebuild();
    expect(f.degraded).toBe(true);
    calls.findUserByEmail = 0;
    expect(await f.isAvailable('chua-co@x.vn')).toEqual({ available: true, result: 'db_fallback' });
    expect(calls.findUserByEmail).toBe(1);
  });

  it('dựng lại vào bản MỚI rồi hoán đổi: email thêm trong lúc dựng không mất; DB lỗi -> giữ bản cũ', async () => {
    const { store, users } = fakeStore(['cu@x.vn']);
    const f = new EmailFilterService(store, null, cfg);
    await f.rebuild();
    // Lượt dựng chậm: chèn một user giữa chừng qua recordCreated (đi vào CẢ bản cũ lẫn bản đang dựng).
    const idn = (store as any).identity();
    const orig = idn.listUserEmailsAfter;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    idn.listUserEmailsAfter = async (a: string | null, t: number) => {
      await gate;
      return orig(a, t);
    };
    (store as any).identity = () => idn;
    const p = f.rebuild();
    expect(f.rebuild()).toBe(p); // không dựng chồng
    f.recordCreated('giua-chung@x.vn');
    users.push({ id: 'ffffffff-0000-0000-0000-000000000000', email: 'giua-chung@x.vn' });
    expect((await f.isAvailable('giua-chung@x.vn')).available).toBe(false); // bản cũ đã có
    release();
    await p;
    expect((await f.isAvailable('giua-chung@x.vn')).result).toBe('positive_confirmed'); // bản mới cũng có

    idn.listUserEmailsAfter = async () => {
      throw new Error('ECONNRESET');
    };
    await f.rebuild();
    expect(f.ready).toBe(true);
    expect((await f.isAvailable('cu@x.vn')).result).toBe('positive_confirmed');
  });

  it('pub/sub: recordCreated PUBLISH hash (không email thô); tin của instance khác áp add; tin của chính mình / sai khuôn bị bỏ', async () => {
    const published: [string, string][] = [];
    const pub = { publish: async (c: string, m: string) => void published.push([c, m]) };
    const a = new EmailFilterService(fakeStore([]).store, pub, cfg);
    const b = new EmailFilterService(fakeStore([]).store, null, cfg);
    await a.rebuild();
    await b.rebuild();
    a.recordCreated('Moi@X.vn');
    await new Promise((r) => setImmediate(r));
    expect(published).toHaveLength(1);
    const [channel, msg] = published[0];
    expect(channel).toBe(EMAIL_FILTER_CHANNEL);
    expect(msg).not.toContain('@');
    expect(JSON.parse(msg)).toMatchObject({ op: 'add', h: keyOf('moi@x.vn') });

    expect(b.size).toBe(0);
    b.handleMessage(msg);
    expect(b.size).toBe(1);
    expect((await b.isAvailable('moi@x.vn')).result).not.toBe('negative');

    a.handleMessage(msg); // tin vọng lại của chính a: đã thêm tại chỗ, không đếm lại
    expect(a.size).toBe(1);
    for (const bad of ['khong-phai-json', JSON.stringify({ op: 'remove', h: keyOf('x@y.vn') }), JSON.stringify({ op: 'add', h: 'moi@x.vn' })]) b.handleMessage(bad);
    expect(b.size).toBe(1);
  });

  it('PUBLISH lỗi (Redis chết) không ném — filter cục bộ vẫn chạy', async () => {
    const f = new EmailFilterService(fakeStore([]).store, { publish: async () => Promise.reject(new Error('ECONNREFUSED')) }, cfg);
    await f.rebuild();
    expect(() => f.recordCreated('x@y.vn')).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(f.size).toBe(1);
  });

  it('đăng ký kênh qua registry dùng chung (một connection subscriber); tin trên kênh tới đúng instance', async () => {
    const added: string[] = [];
    const off = onRedisChannelAdded((c) => added.push(c));
    const f = new EmailFilterService(fakeStore([]).store, null, cfg);
    f.onApplicationBootstrap();
    try {
      await f.rebuild();
      expect(registeredRedisChannels()).toContain(EMAIL_FILTER_CHANNEL);
      expect(added).toContain(EMAIL_FILTER_CHANNEL);
      expect(dispatchRedisMessage(EMAIL_FILTER_CHANNEL, JSON.stringify({ op: 'add', h: keyOf('k@x.vn'), from: 'khac' }))).toBe(true);
      expect(f.size).toBe(1);
    } finally {
      f.onModuleDestroy();
      off();
    }
    expect(registeredRedisChannels()).not.toContain(EMAIL_FILTER_CHANNEL);
  });
});

// ----------------------------------------------------------------------------------------- endpoint + đường tạo user

const authCfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });
const ctx = { ip: '203.0.113.7', userAgent: 'jest' };

async function status(p: Promise<unknown>): Promise<{ status: number; body: any; value?: any }> {
  try {
    return { status: 200, body: null, value: await p };
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
}

/** Store đủ cho register + createUserWithFirstProject; `failTx` mô phỏng transaction rollback. */
function authStore(existing: string[], opts: { failTx?: boolean } = {}) {
  const users = existing.map((email, i) => ({ id: `u-${i}`, email, name: 'Cũ', passwordHash: 'h', emailVerifiedAt: new Date(), isOperator: false }));
  const order: string[] = [];
  const idn: any = {
    findUserByEmail: async (email: string) => users.find((u) => u.email === email) ?? null,
    listUserEmailsAfter: async (after: string | null) => (after ? [] : users.map(({ id, email }) => ({ id, email }))),
    recordAuthAudit: async () => undefined,
    isProjectSlugTaken: async () => false,
    createUser: async (d: any) => ({ id: `u-${users.length}`, ...d }),
    createProject: async () => undefined,
    ensureMembership: async () => undefined,
    invalidateEmailTokens: async () => undefined,
    createEmailToken: async () => undefined,
  };
  const tx = { $executeRaw: async () => 0, auditLog: { create: async () => ({}) } };
  const store = {
    identity: () => idn,
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      order.push('tx:begin');
      const r = await fn(tx);
      if (opts.failTx) {
        order.push('tx:rollback');
        throw new Error('serialization failure');
      }
      order.push('tx:commit');
      return r;
    },
  };
  return { store, order };
}

function makeAuth(store: unknown, filter: unknown, limiter = new AuthRateLimiter(null)) {
  return new AuthService(store as never, new JwtService({}), authCfg, limiter, () => new Date(), createMailSender({ MAIL_DRIVER: 'log' }), filter as never);
}

describe('POST /auth/email-check (ADR-180)', () => {
  it('email mới -> available:true, không gọi DB; email đã có -> false; dương tính giả -> DB -> true', async () => {
    const { store, calls } = fakeStore(['co@x.vn']);
    const f = new EmailFilterService(store, null, cfg);
    await f.rebuild();
    const auth = makeAuth({ identity: () => (store as any).identity() }, f);
    calls.findUserByEmail = 0;
    expect((await status(auth.emailCheck({ email: 'moi@x.vn' }, ctx))).value).toEqual({ available: true });
    expect(calls.findUserByEmail).toBe(0);
    expect((await status(auth.emailCheck({ email: ' CO@x.vn' }, ctx))).value).toEqual({ available: false });
    const fp = { recordCreated: jest.fn(), isAvailable: jest.fn(async () => ({ available: true, result: 'false_positive' })) };
    expect((await status(makeAuth({ identity: () => (store as any).identity() }, fp).emailCheck({ email: 'ma@x.vn' }, ctx))).value).toEqual({
      available: true,
    });
  });

  it('sai định dạng -> 400 bad_request (field email), không đếm rate limit', async () => {
    const limiter = new AuthRateLimiter(null);
    const hit = jest.spyOn(limiter, 'hit');
    const auth = makeAuth(fakeStore([]).store, null, limiter);
    for (const email of ['', 'khong-co-a-cong', 'a@b', 42]) {
      const r = await status(auth.emailCheck({ email } as never, ctx));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'bad_request', field: 'email' });
    }
    expect(hit).not.toHaveBeenCalled();
  });

  it('quá 20 lần/phút/IP -> 429 kèm retryAfterS; trần toàn cục 600/phút chặn cả khi đổi IP', async () => {
    const f = new EmailFilterService(fakeStore([]).store, null, cfg);
    await f.rebuild();
    const auth = makeAuth({ identity: () => ({ recordAuthAudit: async () => undefined }) }, f);
    for (let i = 0; i < 20; i++) expect((await status(auth.emailCheck({ email: `a${i}@x.vn` }, ctx))).status).toBe(200);
    const r = await status(auth.emailCheck({ email: 'a21@x.vn' }, ctx));
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'too_many_attempts' });

    // Trần toàn cục: 600 lượt rải trên 30 IP (mỗi IP 20) -> lượt 601 từ IP mới vẫn 429.
    const auth2 = makeAuth({ identity: () => ({ recordAuthAudit: async () => undefined }) }, f);
    for (let i = 0; i < 600; i++) {
      const s = await status(auth2.emailCheck({ email: `b${i}@x.vn` }, { ip: `198.51.100.${Math.floor(i / 20)}`, userAgent: null }));
      expect(s.status).toBe(200);
    }
    expect((await status(auth2.emailCheck({ email: 'c@x.vn' }, { ip: '192.0.2.250', userAgent: null }))).status).toBe(429);
  });
});

describe('TB-1: audit rate limit chỉ ở lần vượt trần ĐẦU TIÊN mỗi cửa sổ', () => {
  function auditingStore() {
    const audits: { action: string; meta?: any }[] = [];
    const idn = {
      recordAuthAudit: async (a: { action: string; meta?: any }) => void audits.push(a),
      findUserByEmail: async () => null,
    };
    return { store: { identity: () => idn }, audits };
  }

  it('email-check: 50 lượt từ một IP -> 30 lượt 429, đúng 1 dòng audit', async () => {
    const { store, audits } = auditingStore();
    const auth = makeAuth(store, null);
    const codes: number[] = [];
    for (let i = 0; i < 50; i++) codes.push((await status(auth.emailCheck({ email: `x${i}@x.vn` }, ctx))).status);
    expect(codes.filter((c) => c === 429)).toHaveLength(30);
    expect(audits.filter((a) => a.action === 'auth.rate_limited')).toEqual([expect.objectContaining({ meta: expect.objectContaining({ scope: 'emailCheckIp' }) })]);
  });

  it('cửa sổ mới -> lần vượt trần đầu tiên của cửa sổ đó lại được audit', async () => {
    const { store, audits } = auditingStore();
    const clock = { now: 1_000_000 };
    const auth = makeAuth(store, null, new AuthRateLimiter(null, () => clock.now));
    for (let i = 0; i < 25; i++) await status(auth.emailCheck({ email: 'a@x.vn' }, ctx));
    clock.now += 61_000;
    for (let i = 0; i < 25; i++) await status(auth.emailCheck({ email: 'a@x.vn' }, ctx));
    expect(audits.filter((a) => a.action === 'auth.rate_limited')).toHaveLength(2);
  });

  it('login (IP + khoá email) và mail (quên mật khẩu) cũng chỉ 1 dòng mỗi khoá', async () => {
    const { store, audits } = auditingStore();
    const auth = makeAuth(store, null);
    for (let i = 0; i < 12; i++) await status(auth.login({ email: 'n@x.vn', password: 'sai-mat-khau-2026' }, { ip: `192.0.2.${i}`, userAgent: null }));
    for (let i = 0; i < 6; i++) await status(auth.forgotPassword({ email: 'q@x.vn' }, ctx));
    const scopes = audits.filter((a) => a.action === 'auth.rate_limited').map((a) => a.meta.scope);
    expect(scopes).toEqual(['login_email', 'mail_reset_password']);
  }, 30_000);
});

describe('đường tạo user -> filter SAU COMMIT (ADR-180)', () => {
  it('đăng ký mật khẩu: email vào filter + PUBLISH sau commit', async () => {
    const { store, order } = authStore([]);
    const published: string[] = [];
    const f = new EmailFilterService(store as never, { publish: async (_c, m) => void published.push(m) }, cfg);
    await f.rebuild();
    const spy = jest.spyOn(f, 'recordCreated').mockImplementation(function (this: EmailFilterService, email: string) {
      order.push('filter:add');
      return EmailFilterService.prototype.recordCreated.call(this, email);
    });
    const auth = makeAuth(store, f);
    const r = await auth.register({ email: 'Moi@X.vn', name: 'Mới', password: 'ca-phe-sua-da-2026' }, ctx);
    await r.done;
    expect(spy).toHaveBeenCalledWith('moi@x.vn');
    expect(order).toEqual(['tx:begin', 'tx:commit', 'filter:add', 'tx:begin', 'tx:commit']); // tx sau = token mail
    await new Promise((res) => setImmediate(res));
    expect(published).toHaveLength(1);
    expect((await f.isAvailable('moi@x.vn')).result).not.toBe('negative');
  }, 20_000);

  it('GitHub / Google cùng đi qua createUserWithFirstProject -> vào filter', async () => {
    const { store } = authStore([]);
    const f = { recordCreated: jest.fn(), isAvailable: jest.fn() };
    const auth = makeAuth(store, f);
    await auth.createUserWithFirstProject({ email: 'gh@x.vn', name: 'GH', passwordHash: null, emailVerifiedAt: new Date(), githubId: '1' }, ctx);
    await auth.createUserWithFirstProject({ email: 'gg@x.vn', name: 'GG', passwordHash: null, emailVerifiedAt: new Date(), googleSub: 's' }, ctx);
    expect(f.recordCreated.mock.calls).toEqual([['gh@x.vn'], ['gg@x.vn']]);
  });

  it('transaction lỗi -> KHÔNG thêm vào filter', async () => {
    const { store } = authStore([], { failTx: true });
    const f = { recordCreated: jest.fn(), isAvailable: jest.fn() };
    await expect(makeAuth(store, f).createUserWithFirstProject({ email: 'x@x.vn', name: 'X', passwordHash: null, emailVerifiedAt: null }, ctx)).rejects.toThrow(
      'serialization failure',
    );
    expect(f.recordCreated).not.toHaveBeenCalled();
  });

  it('hồi quy R-6: register trả body GIỐNG HỆT cho email mới và email đã có', async () => {
    const f = { recordCreated: jest.fn(), isAvailable: jest.fn() };
    const a = await makeAuth(authStore(['co@x.vn']).store, f).register({ email: 'co@x.vn', name: 'A', password: 'ca-phe-sua-da-2026' }, ctx);
    const b = await makeAuth(authStore([]).store, f).register({ email: 'moi@x.vn', name: 'B', password: 'ca-phe-sua-da-2026' }, ctx);
    await Promise.all([a.done, b.done]);
    expect(a.body).toEqual(REGISTER_ACCEPTED);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  }, 20_000);
});
