import express from 'express';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { createHubClient } from '@hub/sdk';
import { HubLink, parseInput, publicView, resolveSettings, settingsRouter, ShopSettings, sourceKeysOf, testHub, type SettingsRow } from '../src/settings';
import { payosConfig } from '../src/payos';
import { bankQrUrl, readPayment } from '../src/payment';

/**
 * SK2 (SPEC-shop-ket-noi-project §4): cài đặt kết nối của Shop — lưu `shop.settings` (bí mật AES-256-GCM), DB thắng env,
 * route có mã quản trị, lưu xong dựng lại hub client + đăng ký lại endpoint. Store/hub/PayOS đều giả — không mạng thật.
 */
const SETTINGS_KEY = randomBytes(32).toString('base64');
const KEY_A = `hk_test_${'A'.repeat(39)}aaaa`;
const KEY_B = `hk_test_${'B'.repeat(39)}bbbb`;
const CS_A = `hubs://${KEY_A}@hub-a.example/proj-a`;
const CS_B = `hubs://${KEY_B}@hub-b.example/proj-b`;
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
  SHOP_ADMIN_TOKEN: 'admin-token-for-test',
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
  const call = async (method: string, path: string, body?: unknown, token: string | null = 'admin-token-for-test') => {
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
  const link = new HubLink(ensure, log, hub.make);
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
    const wrong = resolveSettings(mem.s.row, ENV, randomBytes(32).toString('base64'), log);
    expect(wrong.env.PAYOS_API_KEY).toBe(ENV.PAYOS_API_KEY);
    expect(wrong.sources.payosApiKey).toBe('env');
  });

  it('[SK:U1] GET /settings không trả bí mật (chỉ configured + 4 ký tự cuối); token sai -> 401; thiếu SHOP_ADMIN_TOKEN -> 404; sai 5 lần/phút -> 429', async () => {
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
      expect(readPayment(ev('id:old'), undefined, link.registration.trustedSourceIds)).toEqual({ skip: 'IGNORED' });
      expect(readPayment(ev('id:src_payos_b'), undefined, link.registration.trustedSourceIds)).toMatchObject({ amount: 5000 });
      expect(JSON.stringify(r.body)).not.toContain(KEY_B);
    } finally {
      await srv.close();
    }
  });

  it('[SK:U3] (phần b) đăng ký FAILED -> trả verificationFix; ensure cũ còn bay không ghi đè nguồn tin cậy mới', async () => {
    const { settings } = setup();
    let release: (v: string[]) => void = () => undefined;
    const ensure = jest
      .fn()
      .mockImplementationOnce(() => new Promise<string[]>((r) => (release = r)))
      .mockRejectedValueOnce(Object.assign(new Error('Endpoint chưa VERIFIED (challenge_timeout) — fix: Mở cổng 443 cho hub'), { code: 'endpoint_not_verified' }));
    const link = new HubLink(ensure, log, fakeHub().make);
    link.apply(ENV);
    const old = link.registration.ensureNow();
    const r = await link.reconnect(E({ ...ENV, HUB_URL: CS_B }));
    expect(r).toMatchObject({ status: 'FAILED', verificationFix: 'Mở cổng 443 cho hub' });
    release(['id:stale']);
    await old;
    expect(link.registration.trustedSourceIds).toEqual([]);
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

  it('[SK:U5] test-hub: key thiếu manage:endpoints -> 422 kèm fix; key thu hồi -> 401 kèm fix; thiếu manage:sources -> vẫn OK, sources=null + gợi ý', async () => {
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

  it('publicView: bí mật ngắn (< 12 ký tự) không lộ 4 ký tự cuối', () => {
    const v = publicView(resolveSettings(null, E({ PAYOS_API_KEY: 'short' }), null), true);
    expect(v.fields.payosApiKey).toEqual({ source: 'env', configured: true, last4: null });
  });
});
