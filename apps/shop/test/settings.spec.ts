import express from 'express';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { createHubClient } from '@hub/sdk';
import { aesGcmEncrypt } from '@hub/crypto';
import { HubLink, hubHostAllowed, parseInput, publicView, resolveSettings, settingsRouter, ShopSettings, sourceKeysOf, testHub, type SettingsRow } from '../src/settings';
import { payosConfig } from '../src/payos';
import { bankQrUrl, orderCodesIn, readPayment } from '../src/payment';

/**
 * SK2 (SPEC-shop-ket-noi-project §4): cài đặt kết nối của Shop — lưu `shop.settings` (bí mật AES-256-GCM), DB thắng env,
 * route có mã quản trị, lưu xong dựng lại hub client + đăng ký lại endpoint. Store/hub/PayOS đều giả — không mạng thật.
 */
const SETTINGS_KEY = randomBytes(32).toString('base64');
const KEY_A = `hk_test_${'A'.repeat(39)}aaaa`;
const KEY_B = `hk_test_${'B'.repeat(39)}bbbb`;
const CS_A = `hubs://${KEY_A}@hub-a.example/proj-a`;
const CS_B = `hubs://${KEY_B}@hub-b.example/proj-b`;
const TOKEN = 'admin-token-for-test-0123456789'; // M-2: ≥ 24 ký tự
const SECRETS = { payosClientId: 'cid-0123456789-SECRET', payosApiKey: 'apikey-0123456789-SECRET', payosChecksumKey: 'checksum-0123456789-SECRET' };
const E = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
const ENV = E({
  HUB_URL: CS_A,
  SHOP_PAYMENT_SOURCE_KEYS: 'src_payos_main,src_sepay_main',
  PAYOS_CLIENT_ID: 'env-cid-xxxxxxxx',
  PAYOS_API_KEY: 'env-apikey-xxxxxxxx',
  PAYOS_CHECKSUM_KEY: 'env-checksum-xxxxxxxx',
  SHOP_BANK_CODE: 'MB',
  SHOP_BANK_ACCOUNT: '0000',
  SHOP_ADMIN_TOKEN: TOKEN,
  SHOP_ALLOWED_HUB_HOSTS: 'hub-b.example',
  SHOP_SETTINGS_KEY: SETTINGS_KEY,
});

function memStore(initial: SettingsRow | null = null) {
  const s = { row: initial, saves: 0 };
  return {
    s,
    store: {
      load: async () => s.row,
      save: async (data: Partial<SettingsRow>) => {
        s.saves++;
        s.row = { ...(s.row ?? ({ paymentSourceKeys: [] } as unknown as SettingsRow)), ...data, updatedAt: new Date() } as SettingsRow;
      },
    },
  };
}

/** Hub giả: `/me`, `/sources` theo key; ghi lại lời gọi. */
function fakeHub(opts: { scopes?: string[]; sources403?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: any) => {
    const key = String(init?.headers?.authorization ?? '').slice(7);
    calls.push(`${init?.method ?? 'GET'} ${url} ${key.slice(-4)}`);
    const reply = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
    if (opts.status) return reply(opts.status, { error: 'invalid_api_key' });
    if (url.endsWith('/me')) return reply(200, { project: { slug: 'proj-b', name: 'B', environment: 'test' }, serviceName: 'shop', scopes: opts.scopes ?? ['manage:endpoints', 'read:events'] });
    if (url.endsWith('/sources')) {
      if (opts.sources403) return reply(403, { error: 'missing_scope', required: 'manage:sources' });
      return reply(200, [{ id: 'S1', name: 'PayOS của tôi', provider: 'payos', sourceKey: 'src_payos_b', webhookUrl: '/hooks/payos/src_payos_b', isActive: true, verificationConfig: null }]);
    }
    return reply(404, { error: 'not_found' });
  };
  return { calls, make: (cs: string) => createHubClient(cs, { fetch }) };
}

async function serve(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise<import('http').Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token !== null ? { 'x-shop-admin-token': token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, text: '' };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function setup(env: NodeJS.ProcessEnv = ENV, row: SettingsRow | null = null) {
  const mem = memStore(row);
  const settings = new ShopSettings(mem.store, env, log);
  const ensure = jest.fn(async (client: any, keys: string[]) => (client.project === 'proj-b' ? keys.map((k) => `id:${k}`) : ['id:old']));
  const hub = fakeHub();
  const link = new HubLink(ensure, log, env, hub.make);
  return { mem, settings, ensure, link, hub };
}

describe('Shop — cài đặt kết nối (SK2)', () => {
  it('[SK:U2] (phần a) chưa lưu gì -> env y như trước (HUB_URL, nguồn tin cậy, PayOS, VietQR); nguồn = env/none', () => {
    const r = resolveSettings(null, ENV, SETTINGS_KEY);
    for (const k of ['HUB_URL', 'SHOP_PAYMENT_SOURCE_KEYS', 'PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY', 'SHOP_BANK_CODE', 'SHOP_BANK_ACCOUNT', 'SHOP_BANK_ACCOUNT_NAME']) {
      expect(r.env[k]).toBe(ENV[k]);
    }
    expect(payosConfig(r.env)).toEqual(payosConfig(ENV));
    expect(bankQrUrl(r.env, 5000, 'DH1234567')).toBe(bankQrUrl(ENV, 5000, 'DH1234567'));
    expect(sourceKeysOf(r.env)).toEqual(['src_payos_main', 'src_sepay_main']);
    expect(sourceKeysOf(E({}))).toEqual(['src_payos_main', 'src_sepay_main']); // mặc định cũ khi env cũng trống
    expect(r.sources).toMatchObject({ hubConnectionUrl: 'env', payosApiKey: 'env', bankAccountName: 'none' });
    // Không có SHOP_SETTINGS_KEY (bản deploy hiện tại) -> cũng y như env
    expect(resolveSettings(null, E({ ...ENV, SHOP_SETTINGS_KEY: undefined }), null).env.HUB_URL).toBe(CS_A);
  });

  it('[SK:U2] (phần b) DB có giá trị thì thắng env, từng trường; trường DB trống vẫn lấy env', async () => {
    const { settings } = setup();
    await settings.save(parseInput({ hubConnectionUrl: CS_B, paymentSourceKeys: ['src_payos_b'], payosApiKey: SECRETS.payosApiKey }) as any);
    const r = await settings.get();
    expect(r.env.HUB_URL).toBe(CS_B);
    expect(sourceKeysOf(r.env)).toEqual(['src_payos_b']);
    expect(r.env.PAYOS_API_KEY).toBe(SECRETS.payosApiKey);
    expect(r.env.PAYOS_CLIENT_ID).toBe(ENV.PAYOS_CLIENT_ID); // không gửi -> giữ env
    expect(r.sources).toMatchObject({ hubConnectionUrl: 'db', paymentSourceKeys: 'db', payosApiKey: 'db', payosClientId: 'env' });
  });

  it('[SK:U4] (phần a) cột bí mật lưu ciphertext AES-256-GCM, không chứa plaintext; sai khoá -> không giải được, rơi về env', async () => {
    const { settings, mem } = setup();
    await settings.save(parseInput({ hubConnectionUrl: CS_B, ...SECRETS }) as any);
    const raw = JSON.stringify(mem.s.row);
    for (const v of [CS_B, KEY_B, ...Object.values(SECRETS)]) expect(raw).not.toContain(v);
    expect(mem.s.row!.payosApiKey).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const wrong = resolveSettings(mem.s.row, ENV, randomBytes(32).toString('base64'));
    expect(wrong.env.PAYOS_API_KEY).toBe(ENV.PAYOS_API_KEY);
    expect(wrong.sources.payosApiKey).toBe('env');
  });

  it('[SK:U1] (phần a) GET /settings không trả bí mật (chỉ configured + 4 ký tự cuối); token sai -> 401; thiếu SHOP_ADMIN_TOKEN -> 404; sai 5 lần/phút -> 429', async () => {
    const { settings, link } = setup();
    await settings.save(parseInput({ hubConnectionUrl: CS_B, ...SECRETS }) as any);
    const srv = await serve(settingsRouter({ settings, link, env: ENV, log }));
    try {
      const ok = await srv.call('GET', '/settings');
      expect(ok.status).toBe(200);
      const json = JSON.stringify(ok.body);
      for (const v of [KEY_B, ...Object.values(SECRETS)]) expect(json).not.toContain(v);
      expect(ok.body.fields.payosApiKey).toEqual({ source: 'db', configured: true, last4: 'CRET' });
      expect(ok.body.fields.hubConnectionUrl).toMatchObject({ source: 'db', configured: true, last4: 'bbbb', project: 'proj-b', host: 'hub-b.example' });
      expect(ok.body.fields.bankCode).toEqual({ source: 'env', value: 'MB' });
      expect((await srv.call('GET', '/settings', undefined, 'sai')).status).toBe(401);
      expect((await srv.call('GET', '/settings', undefined, null)).status).toBe(401);
      for (let i = 0; i < 3; i++) await srv.call('GET', '/settings', undefined, 'sai');
      expect((await srv.call('GET', '/settings')).status).toBe(429); // đã sai 5 lần: khoá cả token đúng trong 1 phút
    } finally {
      await srv.close();
    }
    const off = await serve(settingsRouter({ settings, link, env: E({ ...ENV, SHOP_ADMIN_TOKEN: '' }), log }));
    try {
      expect((await off.call('GET', '/settings')).status).toBe(404);
      expect((await off.call('PUT', '/settings', { bankCode: 'X' })).status).toBe(404);
    } finally {
      await off.close();
    }
  });

  it('[SK:U3] (phần a) PUT đổi HUB_URL -> client mới, ensure chạy lại với payment_source_keys mới NGAY; webhook từ source cũ không còn được tin', async () => {
    const { settings, link, ensure } = setup();
    link.apply((await settings.get()).env);
    expect(await link.registration.ensureNow()).toBe(true);
    expect(link.registration.trustedSourceIds).toEqual(['id:old']);
    const srv = await serve(settingsRouter({ settings, link, env: ENV, log }));
    try {
      const r = await srv.call('PUT', '/settings', { hubConnectionUrl: CS_B, paymentSourceKeys: ['src_payos_b'] });
      expect(r.status).toBe(200);
      expect(r.body.registration).toMatchObject({ status: 'VERIFIED' });
      expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({ project: 'proj-b' }), ['src_payos_b']);
      expect(link.client?.project).toBe('proj-b');
      expect(link.registration.trustedSourceIds).toEqual(['id:src_payos_b']);
      const ev = (sourceId: string) => ({ type: 'payment.received', source: 'payos', sourceId, data: { currency: 'VND', amount: 5000, memo: 'DH1234567' } });
      expect(readPayment(ev('id:old'), undefined, link.registration.trustedSourceIds)).toEqual({ skip: 'UNTRUSTED' });
      expect(readPayment(ev('id:src_payos_b'), undefined, link.registration.trustedSourceIds)).toMatchObject({ amount: 5000 });
      expect(JSON.stringify(r.body)).not.toContain(KEY_B);
    } finally {
      await srv.close();
    }
  });

  it('[SK:U3] (phần b) H-1: đăng ký FAILED -> KHÔNG lưu gì, cấu hình cũ vẫn chạy (webhook nguồn cũ vẫn được ghi nhận), trả FAILED + verificationFix', async () => {
    const { settings, mem } = setup();
    const ensure = jest.fn(async (client: any) => {
      if (client.project === 'proj-b') throw Object.assign(new Error('Endpoint chưa VERIFIED (challenge_timeout) — fix: Mở cổng 443 cho hub'), { code: 'endpoint_not_verified' });
      return ['id:old'];
    });
    const live = new HubLink(ensure, log, ENV, fakeHub().make);
    live.apply((await settings.get()).env);
    expect(await live.registration.ensureNow()).toBe(true);
    const srv = await serve(settingsRouter({ settings, link: live, env: ENV, log }));
    try {
      const r = await srv.call('PUT', '/settings', { hubConnectionUrl: CS_B, paymentSourceKeys: ['src_payos_b'], payosApiKey: SECRETS.payosApiKey });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ saved: [], registration: { status: 'FAILED', verificationFix: 'Mở cổng 443 cho hub' } });
      expect(mem.s.saves).toBe(0); // không ghi DB
      expect(mem.s.row).toBeNull();
      expect(live.client?.project).toBe('proj-a'); // link cũ giữ nguyên
      expect(live.registration.trustedSourceIds).toEqual(['id:old']);
      const ev = { type: 'payment.received', source: 'payos', sourceId: 'id:old', data: { currency: 'VND', amount: 5000, memo: 'DH1234567' } };
      expect(readPayment(ev, undefined, live.registration.trustedSourceIds)).toMatchObject({ amount: 5000, orderCodes: ['DH1234567'] });
      expect((await settings.get()).env.HUB_URL).toBe(CS_A);
      expect((await settings.get()).env.PAYOS_API_KEY).toBe(ENV.PAYOS_API_KEY);
      expect(JSON.stringify(r.body)).not.toContain(KEY_B);
      expect(JSON.stringify(r.body)).not.toContain(SECRETS.payosApiKey);
    } finally {
      await srv.close();
    }
  });

  it('[SK:U3] (phần c) ensure cũ còn bay không ghi đè nguồn tin cậy mới sau khi thay link', async () => {
    let release: (v: string[]) => void = () => undefined;
    const ensure = jest.fn().mockImplementationOnce(() => new Promise<string[]>((r) => (release = r))).mockResolvedValueOnce(['id:new']);
    const link = new HubLink(ensure, log, ENV, fakeHub().make);
    link.apply(ENV);
    const old = link.registration.ensureNow();
    expect(await link.reconnect(E({ ...ENV, HUB_URL: CS_B }))).toMatchObject({ status: 'VERIFIED', project: 'proj-b' });
    release(['id:stale']);
    await old;
    expect(link.registration.trustedSourceIds).toEqual(['id:new']);
  });

  it('[SK:U3] (phần d) L-6: hai PUT đồng thời chạy tuần tự — PUT sau chờ PUT trước xong, trạng thái cuối = PUT sau', async () => {
    const { settings, mem } = setup();
    let release: () => void = () => undefined;
    const ensure = jest
      .fn()
      .mockImplementationOnce((_c: any, keys: string[]) => new Promise<string[]>((r) => (release = () => r(keys.map((k) => `id:${k}`)))))
      .mockImplementation(async (_c: any, keys: string[]) => keys.map((k) => `id:${k}`));
    const link = new HubLink(ensure, log, ENV, fakeHub().make);
    link.apply(ENV);
    const srv = await serve(settingsRouter({ settings, link, env: ENV, log }));
    try {
      const a = srv.call('PUT', '/settings', { hubConnectionUrl: CS_B, paymentSourceKeys: ['src_first'] });
      await new Promise((r) => setTimeout(r, 50));
      const b = srv.call('PUT', '/settings', { paymentSourceKeys: ['src_second'] });
      await new Promise((r) => setTimeout(r, 50));
      expect(ensure).toHaveBeenCalledTimes(1); // B chưa chạy khi A còn giữ khoá
      release();
      expect((await a).status).toBe(200);
      expect((await b).status).toBe(200);
      expect(mem.s.saves).toBe(2);
      expect(link.client?.project).toBe('proj-b'); // B giữ HUB_URL của A (đã lưu), chỉ đổi nguồn
      expect(link.registration.trustedSourceIds).toEqual(['id:src_second']);
    } finally {
      await srv.close();
    }
  });

  it('[SK:U1] (phần b) M-2: SHOP_ADMIN_TOKEN < 24 ký tự -> coi như chưa đặt (404) + log cảnh báo', async () => {
    const { settings, link } = setup();
    const warn = jest.fn();
    const short = E({ ...ENV, SHOP_ADMIN_TOKEN: 'short-token' });
    const srv = await serve(settingsRouter({ settings, link, env: short, log: { ...log, warn } }));
    try {
      expect((await srv.call('GET', '/settings', undefined, 'short-token')).status).toBe(404);
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('24'));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('short-token');
    } finally {
      await srv.close();
    }
  });

  it('[SK:U5] (phần a) M-2: host hub chỉ được là host của HUB_URL env hoặc SHOP_ALLOWED_HUB_HOSTS; host lạ -> 422 kèm fix, KHÔNG gửi HUB_SIGNING_SECRET (không ensure)', async () => {
    const EVIL = `hubs://${KEY_B}@evil.example/proj-b`;
    expect(hubHostAllowed(CS_A, ENV)).toBe(true); // host của HUB_URL env
    expect(hubHostAllowed(CS_B, ENV)).toBe(true); // allowlist
    expect(hubHostAllowed(EVIL, ENV)).toBe(false);
    expect(hubHostAllowed(CS_B, E({ HUB_URL: CS_A }))).toBe(false);
    expect(hubHostAllowed('https://HUB-B.example', ENV)).toBe(true);
    expect(hubHostAllowed('', E({}))).toBe(false);
    const { settings, mem, link, ensure, hub } = setup();
    link.apply(ENV);
    const srv = await serve(settingsRouter({ settings, link, env: ENV, log }));
    try {
      const t = await srv.call('POST', '/settings/test-hub', { hubConnectionUrl: EVIL });
      expect(t.status).toBe(422);
      expect(t.body.fix).toContain('SHOP_ALLOWED_HUB_HOSTS');
      expect(hub.calls).toEqual([]); // không gọi host lạ
      const p = await srv.call('PUT', '/settings', { hubConnectionUrl: EVIL });
      expect(p.status).toBe(422);
      expect(p.body).toMatchObject({ field: 'hubConnectionUrl', fix: expect.stringContaining('SHOP_ALLOWED_HUB_HOSTS') });
      expect(mem.s.saves).toBe(0);
      expect(ensure).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
    // Dòng DB cũ (lưu trước khi có allowlist) trỏ host lạ -> link không bao giờ gọi ensure (mang HUB_SIGNING_SECRET) tới đó
    const guarded = new HubLink(ensure, log, ENV, fakeHub().make);
    guarded.apply(E({ ...ENV, HUB_URL: EVIL }));
    expect(await guarded.registration.ensureNow()).toBe(false);
    expect(guarded.registration.lastError).toContain('SHOP_ALLOWED_HUB_HOSTS');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('[SK:U2] (phần c) M-3: dòng có mà KHÔNG giải mã được -> env cho MỌI trường (kể cả payment_source_keys không mã hoá), không lai; log lỗi một lần', async () => {
    const other = randomBytes(32).toString('base64');
    const row = { hubConnectionUrl: aesGcmEncrypt(CS_B, other), paymentSourceKeys: ['src_payos_b'], payosClientId: null, payosApiKey: aesGcmEncrypt('x-SECRET-xxxx', other), payosChecksumKey: null, bankCode: 'VCB', bankAccount: null, bankAccountName: null, updatedAt: new Date() } as SettingsRow;
    const r = resolveSettings(row, ENV, SETTINGS_KEY);
    expect(r.env.HUB_URL).toBe(CS_A);
    expect(sourceKeysOf(r.env)).toEqual(['src_payos_main', 'src_sepay_main']);
    expect(r.env.SHOP_BANK_CODE).toBe('MB');
    expect(Object.values(r.sources).every((s) => s !== 'db')).toBe(true);
    const error = jest.fn();
    const s = new ShopSettings(memStore(row).store, ENV, { ...log, error });
    await s.get();
    await s.reload();
    expect(error).toHaveBeenCalledTimes(1);
    // Dòng đọc được: DB thắng mọi trường đã đặt, env chỉ cho trường chưa từng đặt
    const ok = resolveSettings({ ...row, hubConnectionUrl: aesGcmEncrypt(CS_B, SETTINGS_KEY), payosApiKey: null }, ENV, SETTINGS_KEY);
    expect([ok.env.HUB_URL, sourceKeysOf(ok.env), ok.env.SHOP_BANK_CODE, ok.env.PAYOS_API_KEY]).toEqual([CS_B, ['src_payos_b'], 'VCB', ENV.PAYOS_API_KEY]);
  });

  it('[SK:U2] (phần d) L-1/M-3: DB lỗi khi đọc -> env (degraded), cache tạm (không truy vấn lỗi mỗi request); DB hồi -> reload + sync link về cấu hình DB', async () => {
    const { mem } = setup();
    let down = true;
    let loads = 0;
    const store = {
      load: async () => {
        loads++;
        if (down) throw new Error('ECONNREFUSED');
        return mem.s.row;
      },
      save: mem.store.save,
    };
    const error = jest.fn();
    const s = new ShopSettings(store, ENV, { ...log, error });
    const r1 = await s.get();
    expect(r1).toMatchObject({ degraded: true });
    expect(r1.env.HUB_URL).toBe(CS_A);
    await s.get();
    expect(loads).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(s.degraded).toBe(true);
    expect(await s.reload()).toBeNull(); // vẫn lỗi: giữ bản đang dùng
    down = false;
    await new ShopSettings(mem.store, ENV, log).save(parseInput({ hubConnectionUrl: CS_B, paymentSourceKeys: ['src_payos_b'] }) as any);
    const ensure = jest.fn(async (_c: any, keys: string[]) => keys.map((k) => `id:${k}`));
    const link = new HubLink(ensure, log, ENV, fakeHub().make);
    link.apply(r1.env);
    const r2 = await s.reload();
    expect(r2?.env.HUB_URL).toBe(CS_B);
    expect(s.degraded).toBe(false);
    expect((await s.get()).env.HUB_URL).toBe(CS_B);
    expect(link.sync(r2!.env)).toBe(true);
    expect(link.client?.project).toBe('proj-b');
    expect(link.sync(r2!.env)).toBe(false); // không đổi -> không dựng lại
    await new Promise((r) => setImmediate(r));
    expect(link.registration.trustedSourceIds).toEqual(['id:src_payos_b']);
  });

  it('M-1: webhook từ source không tin cậy -> UNTRUSTED (main log warn kèm sourceId + mã đơn ứng viên)', () => {
    const ev = { type: 'payment.received', source: 'payos', sourceId: 'id:old', data: { currency: 'VND', amount: 5000, memo: 'CK DH1234567', reference: 'x' } };
    expect(readPayment(ev, undefined, ['id:new'])).toEqual({ skip: 'UNTRUSTED' });
    expect(orderCodesIn(ev.data)).toEqual(['DH1234567']);
    expect(orderCodesIn(undefined)).toEqual([]);
  });

  it('PUT: chỉ ghi trường được gửi; trống thì giữ; sai dạng -> 400 có tên trường; thiếu SHOP_SETTINGS_KEY -> 503', async () => {
    expect(parseInput({ hubConnectionUrl: 'postgres://x' })).toMatchObject({ error: expect.any(String), field: 'hubConnectionUrl' });
    expect(parseInput({ paymentSourceKeys: ['ok_1', 'bad key'] })).toMatchObject({ field: 'paymentSourceKeys' });
    expect(parseInput({ bankCode: '', payosApiKey: '   ', bankAccount: '123' })).toEqual({ bankAccount: '123' });
    expect(parseInput({ clear: ['payosApiKey', 'nope'] })).toEqual({ payosApiKey: null });
    const { settings, link } = setup(E({ ...ENV, SHOP_SETTINGS_KEY: '' }));
    const srv = await serve(settingsRouter({ settings, link, env: E({ ...ENV, SHOP_SETTINGS_KEY: '' }), log }));
    try {
      expect((await srv.call('PUT', '/settings', { bankCode: 'VCB' })).status).toBe(503);
    } finally {
      await srv.close();
    }
  });

  it('[SK:U5] (phần b) test-hub: key thiếu manage:endpoints -> 422 kèm fix; key thu hồi -> 401 kèm fix; thiếu manage:sources -> vẫn OK, sources=null + gợi ý', async () => {
    const noScope = await testHub(CS_B, fakeHub({ scopes: ['read:events'] }).make);
    expect(noScope).toMatchObject({ status: 422, body: { error: expect.stringContaining('manage:endpoints'), fix: expect.any(String) } });
    const revoked = await testHub(CS_B, fakeHub({ status: 401 }).make);
    expect(revoked).toMatchObject({ status: 401, body: { fix: expect.stringContaining('API key') } });
    const bad = await testHub('hubs://not-a-key@x/y', fakeHub().make);
    expect(bad).toMatchObject({ status: 400, body: { fix: expect.any(String) } });
    const ok = await testHub(CS_B, fakeHub().make);
    expect(ok).toMatchObject({ status: 200, body: { project: { slug: 'proj-b' }, serviceName: 'shop', sources: [{ sourceKey: 'src_payos_b', provider: 'payos', name: 'PayOS của tôi' }] } });
    const no403 = await testHub(CS_B, fakeHub({ sources403: true }).make);
    expect(no403).toMatchObject({ status: 200, body: { sources: null, sourcesFix: expect.stringContaining('manage:sources') } });
    expect(JSON.stringify([noScope, revoked, ok, no403])).not.toContain(KEY_B);
  });

  it('[SK:U3] (phần f) N-5: vòng đồng bộ 60s (resync) lỗi -> bắt + log, KHÔNG để promise reject không ai bắt (tiến trình Shop không chết); khoá vẫn chạy tiếp', async () => {
    const error = jest.fn();
    const link = new HubLink(jest.fn(), { ...log, error }, ENV, () => { throw new Error('HUB_URL sai dạng'); });
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(link.resync({ reload: async () => ({ env: E({ HUB_URL: 'hubs://broken' }) }) as any })).resolves.toBeUndefined();
      await expect(link.resync({ reload: async () => Promise.reject(new Error('db down')) })).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(2);
      expect(error.mock.calls[0][0]).toMatchObject({ err: 'HUB_URL sai dạng' });
      expect(await link.lock(async () => 'next')).toBe('next');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('[SK:U3] (phần g) N-1: ensure cấu hình mới VERIFIED nhưng ghi DB lỗi -> ensure lại NGAY trên link cũ (hub bật lại sub cũ), 500 kèm fix, Shop giữ cấu hình cũ', async () => {
    const { settings, mem, link, ensure } = setup();
    mem.store.save = async () => { throw new Error('db down'); };
    link.apply((await settings.get()).env);
    expect(await link.registration.ensureNow()).toBe(true);
    const srv = await serve(settingsRouter({ settings, link, env: ENV, log }));
    try {
      const r = await srv.call('PUT', '/settings', { hubConnectionUrl: CS_B, paymentSourceKeys: ['src_payos_b'] });
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ registration: { status: 'COMMIT_FAILED', restored: true }, fix: expect.stringContaining('Lưu lại') });
      expect(ensure).toHaveBeenCalledTimes(3); // cũ (boot) -> mới (proj-b) -> cũ lại (khôi phục)
      expect(ensure).toHaveBeenLastCalledWith(expect.objectContaining({ project: 'proj-a' }), ['src_payos_main', 'src_sepay_main']);
      expect(link.client?.project).toBe('proj-a');
      expect(link.registration.trustedSourceIds).toEqual(['id:old']);
      expect(mem.s.row).toBeNull();
      expect((await settings.get()).env.HUB_URL).toBe(CS_A);
      expect(JSON.stringify(r.body)).not.toContain(KEY_B);
    } finally {
      await srv.close();
    }
  });

  it('[SK:U5] (phần c) N-3: production -> connection string hub:// (http thường) bị từ chối 422 + fix "dùng hubs://"; HUB_URL env http chỉ cảnh báo', async () => {
    const PROD = E({ ...ENV, NODE_ENV: 'production' });
    const HTTP_B = `hub://${KEY_B}@hub-b.example/proj-b`;
    const { settings, mem, link, ensure, hub } = setup(PROD);
    link.apply(PROD);
    const srv = await serve(settingsRouter({ settings, link, env: PROD, log }));
    try {
      for (const [m, path] of [['POST', '/settings/test-hub'], ['PUT', '/settings']]) {
        const r = await srv.call(m, path, { hubConnectionUrl: HTTP_B });
        expect(r.status).toBe(422);
        expect(r.body).toMatchObject({ field: 'hubConnectionUrl', fix: expect.stringContaining('hubs://') });
      }
      expect([mem.s.saves, ensure.mock.calls.length, hub.calls.length]).toEqual([0, 0, 0]);
    } finally {
      await srv.close();
    }
    const warn = jest.fn();
    settingsRouter({ settings, link, env: E({ ...PROD, HUB_URL: `hub://${KEY_A}@hub-a.example/proj-a` }), log: { ...log, warn } });
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('hubs://'));
    expect(parseInput({ hubConnectionUrl: HTTP_B })).toMatchObject({ hubConnectionUrl: HTTP_B }); // ngoài production: như cũ
  });

  it('publicView: bí mật ngắn (< 12 ký tự) không lộ 4 ký tự cuối', () => {
    const v = publicView(resolveSettings(null, E({ PAYOS_API_KEY: 'short' }), null), true);
    expect(v.fields.payosApiKey).toEqual({ source: 'env', configured: true, last4: null });
  });
});
