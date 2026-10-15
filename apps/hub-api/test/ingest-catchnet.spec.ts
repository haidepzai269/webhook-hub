import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createHash, createHmac, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import Stripe from 'stripe';
import { PrismaService } from '@hub/database';
import { aesGcmEncrypt, generateWhsecSecret, swHeaders } from '@hub/crypto';
import { StripeAdapter } from '@hub/providers';
import { configureBodyParsers, installHooksPathGuard } from '../src/body-parsers';
import { installErrorHandling } from '../src/modules/errors/install';
import { IngestController } from '../src/modules/ingest/ingest.controller';
import { IngestService, publicHooksUrl } from '../src/modules/ingest/ingest.service';
import { PenaltyBox } from '../src/modules/ingest/penalty-box';
import { installPenaltyGate } from '../src/modules/ingest/penalty-gate';
import { PENALTY_BOX_PROVIDER } from '../src/modules/ingest/penalty-provider';
import { RedisService } from '../src/modules/redis/redis.service';
import { installHubOutcome } from '../src/modules/ingest/hub-outcome';
import { verifyCatchnetBody, verifyCatchnetHeaders } from '../src/modules/ingest/catchnet';

/**
 * LH3 (SPEC-hub-sap §5 + ĐÍNH CHÍNH H1/H3/H4/H5, ADR-217/221): hub nhận request đi qua lưới hứng (Cloudflare Worker).
 * App Nest THẬT, cùng thứ tự với main.ts (outcome -> guard /hooks -> cổng phạt -> body parser); IngestController +
 * IngestService THẬT; Prisma/Redis giả. Chữ ký lưới tính ĐỘC LẬP trong test (không import hàm ký của code), secret sinh lúc chạy.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeCrypto: typeof import('crypto') = require('crypto');

const MASTER = randomBytes(24).toString('hex');
const FWD = `fwd-${randomBytes(16).toString('hex')}`;
const FWD_OLD = `fwd-old-${randomBytes(16).toString('hex')}`;
const WHSEC = `whsec_${randomBytes(16).toString('hex')}`;
const GSECRET = `gen-${randomBytes(12).toString('hex')}`;
const SW_SECRET = generateWhsecSecret();
const RENDER = 'https://hub-api-xxxx.onrender.com';
const WORKERS = 'https://hub-hooks.webhookhub.workers.dev';
const TENANT = 'tenant-lh3';
const CF_IP = '198.51.100.10'; // "IP Cloudflare" — kết nối tới hub
const MIN = 60_000;
const DAY = 86_400_000;

const GEN = { scheme: 'hmac', header: 'x-sig', idempotency: { header: 'x-id' }, eventType: 'acme.event' };
const enc = (s: string) => [{ id: 'sec', secretEncrypted: aesGcmEncrypt(s, MASTER) }];
const SOURCES: Record<string, any> = {
  src_stripe: { id: 's-stripe', provider: 'stripe', secrets: enc(WHSEC) },
  src_gen: { id: 's-gen', provider: 'generic', verificationConfig: GEN, secrets: enc(GSECRET) },
  src_gen_503: { id: 's-503', provider: 'generic', verificationConfig: { ...GEN, ack: { rejectStatus: 503 } }, secrets: enc(GSECRET) },
  src_gen_hs: { id: 's-hs', provider: 'generic', verificationConfig: { ...GEN, handshake: { kind: 'query-echo', param: 'challenge' } }, secrets: enc(GSECRET) },
  src_gen_head: { id: 's-head', provider: 'generic', verificationConfig: { ...GEN, handshake: { kind: 'head-ok' } }, secrets: enc(GSECRET) },
  src_sw: { id: 's-sw', provider: 'generic', verificationConfig: { scheme: 'standard-webhooks', eventType: 'acme.event' }, secrets: enc(SW_SECRET) },
  src_unv: { id: 's-unv', provider: 'generic', verificationConfig: { scheme: 'unverified', eventType: 'acme.unv', forwardUrl: true }, allowUnverified: true, secrets: [] },
  src_unv_off: { id: 's-unv-off', provider: 'generic', verificationConfig: { scheme: 'unverified', eventType: 'acme.unv' }, allowUnverified: false, secrets: [] },
  src_full: { id: 's-full', provider: 'generic', verificationConfig: GEN, storageLevel: 'HARD_LOCKED', secrets: enc(GSECRET) },
  src_rl: { id: 's-rl', provider: 'generic', verificationConfig: GEN, secrets: enc(GSECRET) },
  src_dberr: { id: 's-dberr', provider: 'generic', verificationConfig: GEN, secrets: enc(GSECRET) },
  src_dup: { id: 's-dup', provider: 'generic', verificationConfig: GEN, secrets: enc(GSECRET) },
};

const created: any[] = [];
const tx = {
  rawEvent: {
    create: jest.fn(async ({ data }: any) => {
      if (data.sourceId === 's-dberr' && data.idempotencyKey && !String(data.idempotencyKey).startsWith('rejected_')) throw new Error('db down');
      created.push(data);
      return { id: `raw-${created.length}` };
    }),
  },
  outbox: { create: jest.fn() },
};
const fakePrisma: any = {
  findSourceBySourceKeyForIngest: jest.fn(async (key: string) => {
    if (key === 'src_boom') throw new Error('pool exhausted');
    const s = SOURCES[key];
    return s ? { tenantId: TENANT, isActive: true, archivedAt: null, ...s } : null;
  }),
  tenantTx: jest.fn((_t: string, fn: any) => fn(tx)),
  forTenant: () => ({ addIngestDuplicates: async () => undefined, addSourceTraffic: async () => undefined }),
};
const fakeRedis: any = {
  checkRateLimit: jest.fn(async (key: string) => !key.includes('s-rl')),
  getIdempotencyKey: jest.fn(async (key: string) => (key.includes('s-dup') ? 'raw-old' : null)),
  setIdempotencyKey: jest.fn(async () => undefined),
};

@Module({
  controllers: [IngestController],
  providers: [IngestService, PENALTY_BOX_PROVIDER, { provide: PrismaService, useValue: fakePrisma }, { provide: RedisService, useValue: fakeRedis }],
})
class CatchnetTestModule {}

const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');

type CnOpts = {
  method?: string;
  target: string;
  body?: Buffer | string;
  clientIp?: string;
  mode?: string;
  receivedAt?: number;
  id?: string;
  secret?: string;
  /** Chữ ký body tính trên bytes KHÁC (body bị đổi trên đường đi). */
  bodySignedOver?: Buffer | string;
  /** Giá trị header gửi đi khác giá trị đã ký (giả `received_at`). */
  sendReceivedAt?: number;
};

/** Header lưới hứng theo H3: chữ ký đầu không có body, chữ ký body riêng. Tính độc lập với code. */
function cn(o: CnOpts): Record<string, string> {
  const id = o.id ?? `01JLH3${randomBytes(6).toString('hex').toUpperCase()}`;
  const at = o.receivedAt ?? Date.now();
  const ip = o.clientIp ?? '203.0.113.200';
  const mode = o.mode ?? 'forward';
  const method = o.method ?? 'POST';
  const secret = o.secret ?? FWD;
  const body = Buffer.from(o.bodySignedOver ?? o.body ?? '');
  return {
    'x-catchnet-id': id,
    'x-catchnet-received-at': String(o.sendReceivedAt ?? at),
    'x-catchnet-client-ip': ip,
    'x-catchnet-mode': mode,
    'x-catchnet-signature': `v1=${hmac(secret, `${id}.${at}.${ip}.${mode}.${method}.${o.target}`)}`,
    'x-catchnet-body-signature': `v1=${hmac(secret, `${id}.${sha256hex(body)}`)}`,
  };
}

const stripeSdk = new Stripe('sk_test_placeholder_lh3');
function stripeEvent(tsSec: number, id = `evt_${randomBytes(6).toString('hex')}`) {
  const body = JSON.stringify({ id, object: 'event', type: 'payment_intent.succeeded', created: tsSec, data: { object: { id: 'pi_1', amount: 1000, currency: 'usd' } } });
  const sig = stripeSdk.webhooks.generateTestHeaderString({ payload: body, secret: WHSEC, timestamp: tsSec });
  return { body, headers: { 'content-type': 'application/json', 'stripe-signature': sig } };
}

function genEvent(id = `e-${randomBytes(4).toString('hex')}`, secret = GSECRET) {
  const body = JSON.stringify({ id, hello: 'world' });
  return { body, headers: { 'content-type': 'application/json', 'x-id': id, 'x-sig': createHmac('sha256', secret).update(body).digest('hex') } };
}

let app: NestExpressApplication;
let base = '';
let box: PenaltyBox;
let svc: IngestService;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['MASTER_KEY', 'CATCHNET_FORWARD_SECRET', 'CATCHNET_RETENTION_DAYS', 'HUB_PUBLIC_URL', 'HUB_INGEST_PUBLIC_URL', 'CONNECTOR_INGEST_BASE_URL'];

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MASTER_KEY = MASTER;
  process.env.CATCHNET_FORWARD_SECRET = FWD;
  delete process.env.CATCHNET_RETENTION_DAYS;
  process.env.HUB_PUBLIC_URL = RENDER;
  process.env.HUB_INGEST_PUBLIC_URL = WORKERS;
  delete process.env.CONNECTOR_INGEST_BASE_URL;
  app = await NestFactory.create<NestExpressApplication>(CatchnetTestModule, { logger: false, rawBody: true });
  app.set('trust proxy', 1); // như TRUST_PROXY=1: X-Forwarded-For -> req.ip (IP kết nối)
  installErrorHandling(app);
  installHubOutcome(app);
  installHooksPathGuard(app);
  installPenaltyGate(app);
  configureBodyParsers(app);
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  box = app.get(PenaltyBox);
  svc = app.get(IngestService);
});
afterAll(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  created.length = 0;
  process.env.CATCHNET_FORWARD_SECRET = FWD;
  delete process.env.CATCHNET_RETENTION_DAYS;
});
afterEach(() => jest.restoreAllMocks());

async function call(target: string, o: { method?: string; body?: string | Buffer; headers?: Record<string, string>; ip?: string } = {}) {
  const res = await fetch(`${base}${target}`, {
    method: o.method ?? 'POST',
    headers: { 'x-forwarded-for': o.ip ?? CF_IP, ...(o.headers ?? {}) },
    body: o.method === 'GET' || o.method === 'HEAD' ? undefined : ((o.body ?? '') as any),
  });
  const text = await res.text();
  return { status: res.status, outcome: res.headers.get('x-hub-outcome'), text };
}

describe('[LH:T12] Stripe phát lại sau 20 phút: receivedAt của lưới (đã ký) làm "bây giờ" khi verify', () => {
  const T = () => Date.now() - 20 * MIN;

  it('chữ ký lưới + chữ ký body đúng, received_at = T -> 200 accepted; gọi thẳng (không lưới) -> 401', async () => {
    const t = T();
    const e = stripeEvent(Math.floor(t / 1000));
    const target = '/hooks/stripe/src_stripe';
    const ok = await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t }) } });
    // Spec ghi 202; ack Stripe của hub là 200 (adapter không khai successStatus) — lệch ghi §16.
    expect([ok.status, ok.outcome]).toEqual([200, 'accepted']);
    const direct = await call(target, { body: e.body, headers: e.headers });
    expect([direct.status, direct.outcome]).toEqual([401, 'rejected']);
  });

  it('received_at giả (giá trị gửi khác giá trị đã ký) / secret khác -> bỏ qua cả bộ header -> 401 (verify theo giờ thật)', async () => {
    const t = T();
    const target = '/hooks/stripe/src_stripe';
    const e = stripeEvent(Math.floor(t / 1000));
    const forged = await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: Date.now(), sendReceivedAt: t }) } });
    expect([forged.status, forged.outcome]).toEqual([401, 'rejected']);
    const e2 = stripeEvent(Math.floor(t / 1000));
    const wrongKey = await call(target, { body: e2.body, headers: { ...e2.headers, ...cn({ target, body: e2.body, receivedAt: t, secret: `x-${FWD}` }) } });
    expect(wrongKey.status).toBe(401);
  });

  it('chữ ký đầu đúng nhưng chữ ký body lệch -> KHÔNG dùng received_at (verify theo Date.now) -> 401', async () => {
    const t = T();
    const target = '/hooks/stripe/src_stripe';
    const e = stripeEvent(Math.floor(t / 1000));
    const r = await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t, bodySignedOver: `${e.body} ` }) } });
    expect([r.status, r.outcome]).toEqual([401, 'rejected']);
  });

  it('received_at quá CATCHNET_RETENTION_DAYS (mặc định 7) -> bỏ qua header -> 401; đặt 10 ngày -> nhận', async () => {
    const t = Date.now() - 8 * DAY;
    const target = '/hooks/stripe/src_stripe';
    const e = stripeEvent(Math.floor(t / 1000));
    const h = { ...e.headers, ...cn({ target, body: e.body, receivedAt: t }) };
    expect((await call(target, { body: e.body, headers: h })).status).toBe(401);
    // T-3: CATCHNET_RETENTION_DAYS bị kẹp ≤ EVENT_RETENTION_DAYS (mặc định 7) — 10 ngày mà retention 7 vẫn 401.
    process.env.CATCHNET_RETENTION_DAYS = '10';
    expect((await call(target, { body: e.body, headers: h })).status).toBe(401);
    const prevRet = process.env.EVENT_RETENTION_DAYS;
    process.env.EVENT_RETENTION_DAYS = '30';
    try {
      expect((await call(target, { body: e.body, headers: h })).status).toBe(200);
    } finally {
      if (prevRet === undefined) delete process.env.EVENT_RETENTION_DAYS;
      else process.env.EVENT_RETENTION_DAYS = prevRet;
    }
    delete process.env.CATCHNET_RETENTION_DAYS;
  });

  it('T-2: received_at ở TƯƠNG LAI chỉ được lệch đồng hồ ≤ 5 phút (không phải tới hạn 7 ngày)', async () => {
    const target = '/hooks/generic/src_gen';
    const last = () => created[created.length - 1];
    let e = genEvent();
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: Date.now() + 6 * MIN }) } });
    expect(last().via).toBeUndefined(); // +6 phút -> bỏ cả bộ header
    e = genEvent();
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: Date.now() + 2 * DAY }) } });
    expect(last().via).toBeUndefined();
    e = genEvent();
    const soon = Date.now() + 1 * MIN;
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: soon }) } });
    expect([last().via, last().receivedAt?.getTime()]).toEqual(['catchnet-forward', soon]);
  });

  it('T-6: secret < 32 ký tự bị bỏ (lưới tắt nếu không còn giá trị nào); giá trị thứ ba trở đi bị bỏ', async () => {
    const SHORT = 'ngan-qua-31-ky-tu-0123456789abc';
    expect(SHORT.length).toBe(31);
    const t = T();
    const target = '/hooks/stripe/src_stripe';
    process.env.CATCHNET_FORWARD_SECRET = SHORT;
    const e = stripeEvent(Math.floor(t / 1000));
    expect((await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t, secret: SHORT }) } })).status).toBe(401);
    process.env.CATCHNET_FORWARD_SECRET = `${FWD},${FWD_OLD},${FWD}-thu-ba`;
    const e2 = stripeEvent(Math.floor(t / 1000));
    expect((await call(target, { body: e2.body, headers: { ...e2.headers, ...cn({ target, body: e2.body, receivedAt: t, secret: `${FWD}-thu-ba` }) } })).status).toBe(401);
  });

  it('xoay khoá: CATCHNET_FORWARD_SECRET="mới,cũ" — Worker còn ký bằng khoá cũ vẫn được; không đặt biến -> tắt hẳn', async () => {
    const t = T();
    const target = '/hooks/stripe/src_stripe';
    process.env.CATCHNET_FORWARD_SECRET = `${FWD}, ${FWD_OLD}`;
    const e = stripeEvent(Math.floor(t / 1000));
    expect((await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t, secret: FWD_OLD }) } })).status).toBe(200);
    delete process.env.CATCHNET_FORWARD_SECRET;
    const e2 = stripeEvent(Math.floor(t / 1000));
    expect((await call(target, { body: e2.body, headers: { ...e2.headers, ...cn({ target, body: e2.body, receivedAt: t }) } })).status).toBe(401);
  });

  it('so chữ ký lưới bằng crypto.timingSafeEqual (đủ cả chữ ký đầu lẫn body; mỗi secret một lần, không dừng sớm)', () => {
    const spy = jest.spyOn(nodeCrypto, 'timingSafeEqual');
    const env = { CATCHNET_FORWARD_SECRET: `${FWD},${FWD_OLD}` };
    const target = '/hooks/generic/src_gen';
    const body = '{"a":1}';
    const h = cn({ target, body, secret: FWD });
    spy.mockClear();
    const ing = verifyCatchnetHeaders({ method: 'POST', target, headers: h }, env);
    expect(ing).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2); // khớp secret đầu vẫn so tiếp secret thứ hai
    spy.mockClear();
    expect(verifyCatchnetBody(ing!, h, Buffer.from(body), env)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('T-7: header sai khuôn -> bỏ cả bộ: header lặp, received_at âm/rỗng/16 chữ số, IP sai, mode lạ, target tuyệt đối, chữ ký hoa', () => {
    const env = { CATCHNET_FORWARD_SECRET: FWD };
    const target = '/hooks/generic/src_gen';
    const ok = cn({ target, body: '' });
    expect(verifyCatchnetHeaders({ method: 'POST', target, headers: ok }, env)).not.toBeNull();
    const bad = (patch: Record<string, string | string[]>, t = target) => verifyCatchnetHeaders({ method: 'POST', target: t, headers: { ...ok, ...patch } }, env);
    // Node nối header lặp thành "a, b"; mảng (set-cookie kiểu) cũng không nhận.
    expect(bad({ 'x-catchnet-signature': `${ok['x-catchnet-signature']}, ${ok['x-catchnet-signature']}` })).toBeNull();
    expect(bad({ 'x-catchnet-client-ip': [ok['x-catchnet-client-ip'], '1.1.1.1'] })).toBeNull();
    for (const at of ['-1', '', '1234567890123456', '1e12', ' 1760425200000']) expect(bad({ 'x-catchnet-received-at': at })).toBeNull();
    for (const ip of ['999.1.1.1', 'localhost', '1.2.3.4.forward', '']) expect(bad(cn({ target, body: '', clientIp: ip }))).toBeNull();
    expect(bad(cn({ target, body: '', mode: 'FORWARD' }))).toBeNull();
    expect(bad({ 'x-catchnet-id': 'có.dấu.chấm' })).toBeNull();
    const abs = `http://evil.example${target}`;
    expect(bad(cn({ target: abs, body: '' }), abs)).toBeNull();
    expect(bad({ 'x-catchnet-signature': ok['x-catchnet-signature'].toUpperCase().replace('V1=', 'v1=') })).toBeNull();
  });

  it('T-7: test vector CỐ ĐỊNH (libs/crypto/test/fixtures/catchnet-vectors.json, LH2 Worker dùng chung) khớp từng byte', () => {
    const vec = JSON.parse(readFileSync(join(__dirname, '../../../libs/crypto/test/fixtures/catchnet-vectors.json'), 'utf8'));
    const env = { CATCHNET_FORWARD_SECRET: vec.secret };
    expect(vec.cases.length).toBeGreaterThanOrEqual(3);
    for (const v of vec.cases) {
      // Chuỗi ký và hex tính độc lập phải bằng giá trị đã ghi cứng (vector không tự trôi).
      expect(`${v.id}.${v.receivedAt}.${v.clientIp}.${v.mode}.${v.method}.${v.target}`).toBe(v.signingString);
      expect(`v1=${hmac(vec.secret, v.signingString)}`).toBe(v.signature);
      const headers = {
        'x-catchnet-id': v.id, 'x-catchnet-received-at': v.receivedAt, 'x-catchnet-client-ip': v.clientIp, 'x-catchnet-mode': v.mode,
        'x-catchnet-signature': v.signature, 'x-catchnet-body-signature': v.bodySignature,
      };
      const ing = verifyCatchnetHeaders({ method: v.method, target: v.target, headers }, env, Number(v.receivedAt) + 1000);
      expect([v.name, ing]).toEqual([v.name, { id: v.id, receivedAtMs: Number(v.receivedAt), clientIp: v.clientIp, mode: v.mode }]);
      expect(verifyCatchnetBody(ing!, headers, Buffer.from(v.bodyUtf8, 'utf8'), env)).toBe(true);
    }
  });

  it('StripeAdapter: verifyAt hỏng (Invalid Date) -> fail-closed (SDK coi NaN là "không quá hạn")', async () => {
    const e = stripeEvent(Math.floor(Date.now() / 1000));
    const adapter = new StripeAdapter();
    const r = { provider: 'stripe' as const, sourceKey: 'k', headers: e.headers, rawBody: Buffer.from(e.body), body: JSON.parse(e.body) };
    expect(await adapter.verify(r, [WHSEC])).toBe(true);
    expect(await adapter.verify(r, [WHSEC], { verifyAt: new Date(NaN) })).toBe(false);
    const old = stripeEvent(Math.floor(Date.now() / 1000) - 3600);
    const ro = { ...r, headers: old.headers, rawBody: Buffer.from(old.body), body: JSON.parse(old.body) };
    expect(await adapter.verify(ro, [WHSEC])).toBe(false);
    expect(await adapter.verify(ro, [WHSEC], { verifyAt: new Date(Date.now() - 3600_000) })).toBe(true);
  });

  it('Standard Webhooks (generic, swVerify nowSec) cũng dùng received_at của lưới', async () => {
    const t = T();
    const target = '/hooks/generic/src_sw';
    const body = JSON.stringify({ type: 'acme.event', data: { n: 1 } });
    const h = { 'content-type': 'application/json', ...swHeaders(SW_SECRET, `msg_${randomBytes(4).toString('hex')}`, body, Math.floor(t / 1000)) };
    expect((await call(target, { body, headers: h })).status).toBe(401);
    const r = await call(target, { body, headers: { ...h, ...cn({ target, body, receivedAt: t }) } });
    expect([r.status, r.outcome]).toEqual([200, 'accepted']);
  });
});

describe('[LH:T13] IP cho hộp phạt chỉ lấy từ header lưới ĐÃ KÝ', () => {
  it('x-catchnet-client-ip của IP đang bị ban mà thiếu/sai chữ ký -> cổng phạt dùng IP kết nối (sạch) -> không 429', async () => {
    const BANNED = '203.0.113.66';
    for (let i = 0; i < 20; i++) box.recordUnknownSource(BANNED);
    const target = '/hooks/generic/src_gen';
    const e = genEvent();
    const forged = { ...cn({ target, body: e.body, clientIp: BANNED }), 'x-catchnet-signature': `v1=${'0'.repeat(64)}` };
    const r = await call(target, { body: e.body, headers: { ...e.headers, ...forged } });
    expect([r.status, r.outcome]).toEqual([200, 'accepted']);
    const noSig = { ...cn({ target, body: e.body, clientIp: BANNED }) };
    delete (noSig as any)['x-catchnet-signature'];
    const e2 = genEvent();
    expect((await call(target, { body: e2.body, headers: { ...e2.headers, ...noSig } })).status).toBe(200);
    // Ký đúng -> IP đã ký là IP của hộp phạt -> 429 ngay ở cổng (trước body parser).
    const e3 = genEvent();
    const signed = await call(target, { body: e3.body, headers: { ...e3.headers, ...cn({ target, body: e3.body, clientIp: BANNED }) } });
    expect([signed.status, signed.outcome]).toEqual([429, 'refused']);
  });

  it('F7: IP Cloudflare (kết nối) bị ban, request ký đúng với IP client sạch -> đi qua; không có lưới -> 429', async () => {
    const CF_BANNED = '198.51.100.99';
    for (let i = 0; i < 20; i++) box.recordUnknownSource(CF_BANNED);
    const target = '/hooks/generic/src_gen';
    const e = genEvent();
    const r = await call(target, { ip: CF_BANNED, body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, clientIp: '203.0.113.5' }) } });
    expect([r.status, r.outcome]).toEqual([200, 'accepted']);
    const e2 = genEvent();
    expect((await call(target, { ip: CF_BANNED, body: e2.body, headers: e2.headers })).status).toBe(429);
  });

  it('chấm điểm (404 sourceKey lạ) ghi cho IP đã ký, không cho IP Cloudflare; sai chữ ký -> ghi cho IP kết nối', async () => {
    const spy = jest.spyOn(svc.penalty, 'recordUnknownSource');
    const target = '/hooks/generic/khong_co_lh3';
    const r = await call(target, { body: '{}', headers: { 'content-type': 'application/json', ...cn({ target, body: '{}', clientIp: '203.0.113.31' }) } });
    expect([r.status, r.outcome]).toEqual([404, 'rejected']);
    expect(spy).toHaveBeenLastCalledWith('203.0.113.31');
    await call(target, { body: '{}', headers: { 'content-type': 'application/json', ...cn({ target, body: '{}', clientIp: '203.0.113.31', secret: 'sai' }) } });
    expect(spy).toHaveBeenLastCalledWith(CF_IP);
    // REVIEW-LH3 T-1: chữ ký đầu đúng (chép lại) nhưng body lệch -> ingest chấm điểm theo IP KẾT NỐI, không đóng khung IP đã ký.
    await call(target, { body: '{}', headers: { 'content-type': 'application/json', ...cn({ target, body: '{}', clientIp: '203.0.113.31', bodySignedOver: 'body-khac' }) } });
    expect(spy).toHaveBeenLastCalledWith(CF_IP);
  });

  it('T-1: chữ ký đầu chép lại + body khác, chữ ký provider sai -> recordBadSignature theo IP kết nối; header lưu không có x-catchnet-* (trừ id)', async () => {
    const bad = jest.spyOn(svc.penalty, 'recordBadSignature');
    const target = '/hooks/generic/src_gen';
    const e = genEvent(undefined, 'sai');
    const h = { ...e.headers, ...cn({ target, body: e.body, clientIp: '203.0.113.44', bodySignedOver: 'body-goc-cua-provider' }) };
    expect((await call(target, { body: e.body, headers: h })).status).toBe(401);
    expect(bad).toHaveBeenLastCalledWith(CF_IP, 'src_gen', expect.anything());
    const row = created[created.length - 1];
    expect([row.status, row.via]).toEqual(['REJECTED', undefined]);
    // Bản lưu: không còn chữ ký / IP / giờ / mode của lưới; còn id để nối với dòng D1.
    const ok = genEvent();
    await call(target, { body: ok.body, headers: { ...ok.headers, ...cn({ target, body: ok.body, clientIp: '203.0.113.45' }) } });
    const stored = Object.keys(created[created.length - 1].headers).filter((k) => k.startsWith('x-catchnet-'));
    expect(stored).toEqual(['x-catchnet-id']);
  });
});

describe('[LH:T18] (phía hub) rejectStatus 503 + chữ ký sai -> 503 mang x-hub-outcome: rejected (Worker không coi là hub vắng)', () => {
  it('gọi thẳng và qua lưới đều 503 rejected', async () => {
    const target = '/hooks/generic/src_gen_503';
    const e = genEvent(undefined, 'sai-secret');
    const direct = await call(target, { body: e.body, headers: e.headers });
    expect([direct.status, direct.outcome]).toEqual([503, 'rejected']);
    const via = await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body }) } });
    expect([via.status, via.outcome]).toEqual([503, 'rejected']);
  });
});

describe('[LH:T19] URL công khai theo đường request đi vào (H4, nợ REVIEW-LH-URL L1)', () => {
  it('forwardUrl: qua lưới (ký đúng) -> HUB_INGEST_PUBLIC_URL; gọi thẳng / header lưới sai chữ ký -> HUB_PUBLIC_URL', async () => {
    const target = '/hooks/generic/src_unv?a=1';
    const body = JSON.stringify({ n: randomBytes(4).toString('hex') });
    const metaUrl = () => created[created.length - 1]?.headers?.__hub_meta?.url;
    const via = await call(target, { body, headers: { 'content-type': 'application/json', ...cn({ target, body }) } });
    expect([via.status, via.outcome]).toEqual([200, 'accepted']);
    expect(metaUrl()).toBe(`${WORKERS}/hooks/generic/src_unv?a=1`);
    const body2 = JSON.stringify({ n: randomBytes(4).toString('hex') });
    await call(target, { body: body2, headers: { 'content-type': 'application/json' } });
    expect(metaUrl()).toBe(`${RENDER}/hooks/generic/src_unv?a=1`);
    const body3 = JSON.stringify({ n: randomBytes(4).toString('hex') });
    await call(target, { body: body3, headers: { 'content-type': 'application/json', ...cn({ target, body: body3, secret: 'sai' }) } });
    expect(metaUrl()).toBe(`${RENDER}/hooks/generic/src_unv?a=1`);
  });

  it('publicHooksUrl: mặc định = gọi thẳng (HUB_PUBLIC_URL); "catchnet" -> base ingest; thiếu HUB_INGEST_PUBLIC_URL -> cả hai là HUB_PUBLIC_URL', () => {
    const env = { HUB_PUBLIC_URL: RENDER, HUB_INGEST_PUBLIC_URL: WORKERS };
    const r = { provider: 'generic' as const, sourceKey: 'k', query: '' };
    expect(publicHooksUrl(r, env)).toBe(`${RENDER}/hooks/generic/k`);
    expect(publicHooksUrl(r, env, 'direct')).toBe(`${RENDER}/hooks/generic/k`);
    expect(publicHooksUrl(r, env, 'catchnet')).toBe(`${WORKERS}/hooks/generic/k`);
    expect(publicHooksUrl(r, { HUB_PUBLIC_URL: RENDER }, 'catchnet')).toBe(`${RENDER}/hooks/generic/k`);
    expect(publicHooksUrl(r, { HUB_PUBLIC_URL: 'http://localhost:4000', HUB_INGEST_PUBLIC_URL: WORKERS }, 'direct')).toBeNull();
  });
});

describe('[LH:T20] raw_events.via + received_at theo chữ ký lưới (H5)', () => {
  it('forward -> catchnet-forward, replay -> catchnet-replay, sai chữ ký / không có -> via vắng; received_at = giờ Worker CHỈ khi body khớp', async () => {
    const target = '/hooks/generic/src_gen';
    const t = Date.now() - 3 * MIN;
    const last = () => created[created.length - 1];
    let e = genEvent();
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t, mode: 'forward' }) } });
    expect([last().via, last().receivedAt?.getTime()]).toEqual(['catchnet-forward', t]);
    e = genEvent();
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t, mode: 'replay' }) } });
    expect([last().via, last().receivedAt?.getTime()]).toEqual(['catchnet-replay', t]);
    e = genEvent();
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t, bodySignedOver: 'khac' }) } });
    // REVIEW-LH3 T-1 (lệch H3, ADR-217): body lệch -> ingest coi như gọi thẳng (không via, không received_at).
    expect([last().via, last().receivedAt]).toEqual([undefined, undefined]);
    e = genEvent();
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, receivedAt: t, secret: 'sai' }) } });
    expect([last().via, last().receivedAt]).toEqual([undefined, undefined]);
    e = genEvent();
    await call(target, { body: e.body, headers: e.headers });
    expect([last().via, last().receivedAt]).toEqual([undefined, undefined]);
    // mode lạ không nằm trong {forward, replay} -> cả bộ header bị bỏ qua.
    e = genEvent();
    await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, mode: 'catchnet' }) } });
    expect(last().via).toBeUndefined();
    // Dòng REJECTED (chữ ký provider sai) qua lưới cũng mang via.
    e = genEvent(undefined, 'sai');
    expect((await call(target, { body: e.body, headers: { ...e.headers, ...cn({ target, body: e.body, mode: 'replay' }) } })).status).toBe(401);
    expect([last().status, last().via]).toEqual(['REJECTED', 'catchnet-replay']);
  });

  it('migration chỉ thêm cột via (text NULL) + CHECK hai giá trị; schema Prisma có via', () => {
    const dir = join(__dirname, '../../../libs/database/prisma');
    const sql = readFileSync(join(dir, 'migrations/20261014150000_raw_events_via/migration.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE "hub"\."raw_events" ADD COLUMN "via" TEXT/);
    expect(sql).toMatch(/CHECK \("via" IN \('catchnet-forward', 'catchnet-replay'\)\)/);
    const statements = sql
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i); // không DML
    expect(statements).not.toMatch(/CREATE TYPE|ALTER TYPE/i); // không enum (ADD VALUE không rollback được)
    expect(readFileSync(join(dir, 'schema.prisma'), 'utf8')).toMatch(/via\s+String\?\s+@map\("via"\)/);
  });
});

describe('[LH:T21] x-hub-outcome trên MỌI nhánh trả lời của /hooks/* (H1, ADR-221)', () => {
  it('accepted / duplicate / handshake (GET query-echo, HEAD head-ok)', async () => {
    const e = genEvent();
    expect(await call('/hooks/generic/src_gen', { body: e.body, headers: e.headers }).then((r) => [r.status, r.outcome])).toEqual([200, 'accepted']);
    const d = genEvent();
    expect(await call('/hooks/generic/src_dup', { body: d.body, headers: d.headers }).then((r) => [r.status, r.outcome])).toEqual([200, 'duplicate']);
    expect(await call('/hooks/generic/src_gen_hs?challenge=abc', { method: 'GET' }).then((r) => [r.status, r.outcome, r.text])).toEqual([200, 'handshake', 'abc']);
    expect(await call('/hooks/generic/src_gen_head', { method: 'HEAD' }).then((r) => [r.status, r.outcome])).toEqual([200, 'handshake']);
  });

  it('rejected: 401 chữ ký, 404 source lạ, 404 /HOOKS, 400 JSON hỏng, 413, 405, 422 thiếu khoá, 400 provider lạ', async () => {
    const bad = genEvent(undefined, 'sai');
    expect(await call('/hooks/generic/src_gen', { body: bad.body, headers: bad.headers }).then((r) => [r.status, r.outcome])).toEqual([401, 'rejected']);
    expect(await call('/hooks/generic/khong_co_t21', { body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([404, 'rejected']);
    expect(await call('/HOOKS/generic/src_gen', { body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([404, 'rejected']);
    expect(await call('/hooks/stripe/src_stripe', { body: '{hỏng', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([400, 'rejected']);
    expect(await call(`/hooks/generic/src_gen?q=${'a'.repeat(9000)}`, { body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([414, 'rejected']);
    const big = Buffer.alloc(1024 * 1024 + 10, 0x61);
    expect(await call('/hooks/generic/src_gen', { body: big, headers: { 'content-type': 'application/octet-stream' } }).then((r) => [r.status, r.outcome])).toEqual([413, 'rejected']);
    expect(await call('/hooks/generic/src_gen', { method: 'GET' }).then((r) => [r.status, r.outcome])).toEqual([405, 'rejected']);
    const body = JSON.stringify({ x: 1 });
    const noId = { 'content-type': 'application/json', 'x-sig': createHmac('sha256', GSECRET).update(body).digest('hex') };
    expect(await call('/hooks/generic/src_gen', { body, headers: noId }).then((r) => [r.status, r.outcome])).toEqual([422, 'rejected']);
    expect(await call('/hooks/khong-co-provider/src_gen', { body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([400, 'rejected']);
  });

  it('refused: 429 cổng phạt, 429 rate limit, 507 project đầy, 401 cờ unverified tắt', async () => {
    const BAN = '203.0.113.88';
    for (let i = 0; i < 20; i++) box.recordUnknownSource(BAN);
    expect(await call('/hooks/generic/src_gen', { ip: BAN, body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([429, 'refused']);
    const e = genEvent();
    expect(await call('/hooks/generic/src_rl', { body: e.body, headers: e.headers }).then((r) => [r.status, r.outcome])).toEqual([429, 'refused']);
    svc.storageLockEnabled = true;
    try {
      const f = genEvent();
      expect(await call('/hooks/generic/src_full', { body: f.body, headers: f.headers }).then((r) => [r.status, r.outcome])).toEqual([507, 'refused']);
    } finally {
      svc.storageLockEnabled = false;
    }
    expect(await call('/hooks/generic/src_unv_off', { body: '{"a":1}', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([401, 'refused']);
  });

  it('lỗi tạm thời: transaction lỗi (500) và exception khi nạp source (500) -> unavailable, KHÔNG phải outcome khác', async () => {
    const e = genEvent();
    expect(await call('/hooks/generic/src_dberr', { body: e.body, headers: e.headers }).then((r) => [r.status, r.outcome])).toEqual([500, 'unavailable']);
    expect(await call('/hooks/generic/src_boom', { body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => [r.status, r.outcome])).toEqual([500, 'unavailable']);
  });

  it('T-7: header KHÔNG lọt ra route ngoài /hooks; OPTIONS (preflight) cố ý không mang outcome', async () => {
    for (const p of ['/api/v1/khong-co', '/health', '/hooksx/a/b', '/v1/p/x/events']) {
      const r = await call(p, { body: '{}', headers: { 'content-type': 'application/json' } });
      expect([p, r.outcome]).toEqual([p, null]);
    }
    expect((await call('/hooks/generic/src_gen', { method: 'OPTIONS' })).outcome).toBeNull();
  });

  it('main.ts cài header outcome TRƯỚC guard /hooks và cổng phạt (không nhánh nào trả trước khi có lưới đỡ)', () => {
    const src = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');
    const at = (s: string) => src.indexOf(s);
    expect(at('installHubOutcome(app)')).toBeGreaterThan(0);
    expect(at('installHubOutcome(app)')).toBeLessThan(at('installHooksPathGuard(app)'));
    expect(at('installHubOutcome(app)')).toBeLessThan(at('installPenaltyGate(app)'));
  });
});
