import { beforeEach, describe, expect, it } from 'vitest';
import { hmacHex, sha256Hex } from '../src/sign';
import { CIRCUIT_MS, handleFetch, resetCircuit, runReplay, type Deps } from '../src/worker';
import type { Env } from '../src/config';
import { count, fakeD1, type FakeD1 } from './d1-fake';

const SECRET = 'lh2-test-forward-secret-0123456789abcdef';
const ADMIN = 'lh2-test-admin-token-0123456789abcdef-x';
const WORKER = 'https://hub-hooks.webhookhub.workers.dev';
const HUB = 'https://hub.test';
const T0 = 1_760_425_200_000;

type HubFn = (req: Request) => Response | 'timeout' | Promise<Response | 'timeout'>;

interface Rig {
  db: FakeD1;
  env: Env;
  deps: Deps;
  calls: Request[];
  bodies: Uint8Array[];
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  setHub(fn: HubFn): void;
  advance(ms: number): void;
  now(): number;
}

function rig(extra: Partial<Env> = {}): Rig {
  const db = fakeD1();
  let now = T0;
  let hubFn: HubFn = () => new Response('{"received":true}', { status: 200, headers: { 'x-hub-outcome': 'accepted' } });
  const calls: Request[] = [];
  const bodies: Uint8Array[] = [];
  const logs: Rig['logs'] = [];
  const deps: Deps = {
    now: () => now,
    log: (event, fields) => logs.push({ event, fields }),
    fetch: async (input, init) => {
      const req = new Request(input as string, init);
      calls.push(req);
      bodies.push(new Uint8Array(await req.clone().arrayBuffer()));
      const out = await hubFn(req);
      if (out === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return out;
    },
  };
  const env: Env = { DB: db, HUB_ORIGIN_URL: HUB, CATCHNET_FORWARD_SECRET: `${SECRET},${'o'.repeat(40)}`, CATCHNET_ADMIN_TOKEN: ADMIN, ...extra };
  return {
    db,
    env,
    deps,
    calls,
    bodies,
    logs,
    setHub: (fn) => (hubFn = fn),
    advance: (ms) => (now += ms),
    now: () => now,
  };
}

const admin = (r: Rig, method: string, path: string, body?: unknown, token = ADMIN) =>
  handleFetch(
    new Request(`${WORKER}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    r.env,
    r.deps,
  );

async function addSource(r: Rig, key: string, body: Record<string, unknown>) {
  const res = await admin(r, 'PUT', `/_admin/sources/${key}`, body);
  expect(res.status).toBe(200);
}

/** Bytes KHÔNG phải UTF-8 hợp lệ + CRLF: parse/stringify lại là lệch ngay. */
const RAW = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x20]);

function providerReq(path: string, init: { method?: string; body?: Uint8Array | string; headers?: Record<string, string> } = {}) {
  return new Request(`${WORKER}${path}`, {
    method: init.method ?? 'POST',
    body: init.body,
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.9',
      'cf-ray': '8abc-SIN',
      'x-real-ip': '203.0.113.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.9',
      'x-catchnet-mode': 'replay', // client tự đặt -> phải bị thay
      'x-catchnet-received-at': '1',
      'x-hub-outcome': 'accepted',
      'x-provider-signature': 'sig-abc',
      ...init.headers,
    },
  });
}

/** Kiểm header lưới của một request tới hub như hub-api làm (ADR-217). */
async function expectSigned(req: Request, body: Uint8Array, mode: 'forward' | 'replay') {
  const h = req.headers;
  const target = req.url.slice(HUB.length);
  expect(h.get('x-catchnet-mode')).toBe(mode);
  const s = `${h.get('x-catchnet-id')}.${h.get('x-catchnet-received-at')}.${h.get('x-catchnet-client-ip')}.${mode}.${req.method}.${target}`;
  expect(h.get('x-catchnet-signature')).toBe(`v1=${await hmacHex(SECRET, s)}`);
  expect(h.get('x-catchnet-body-signature')).toBe(`v1=${await hmacHex(SECRET, `${h.get('x-catchnet-id')}.${await sha256Hex(body)}`)}`);
  for (const n of ['x-catchnet-id', 'x-catchnet-received-at', 'x-catchnet-client-ip', 'x-catchnet-mode', 'x-catchnet-signature', 'x-catchnet-body-signature']) {
    expect(h.get(n)).not.toContain(','); // đúng MỘT giá trị
  }
}

const inboxRows = (r: Rig) => r.db.raw.prepare('SELECT * FROM inbox ORDER BY received_at').all() as Array<Record<string, unknown>>;

beforeEach(() => resetCircuit());

describe('LH2 ghi xuyên', () => {
  it('[LH:T4] (phần c) hub sống -> phản hồi hub đi qua nguyên vẹn (bỏ x-hub-outcome), D1 rỗng; request tới hub mang bytes gốc + header lưới đã ký', async () => {
    const r = rig();
    await addSource(r, 'src_momo', { provider: 'momo', ackStatus: 204 });
    r.setHub(() => new Response('{"received":true}', { status: 200, headers: { 'x-hub-outcome': 'accepted', 'x-request-id': 'req-1', 'set-cookie': 'a=b' } }));
    const res = await handleFetch(providerReq('/hooks/momo/src_momo', { body: RAW }), r.env, r.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"received":true}');
    expect(res.headers.get('x-hub-outcome')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-request-id')).toBe('req-1');
    expect(count(r.db, 'inbox')).toBe(0);

    expect(r.calls).toHaveLength(1);
    const sent = r.calls[0];
    expect(sent.url).toBe(`${HUB}/hooks/momo/src_momo`);
    expect([...r.bodies[0]]).toEqual([...RAW]);
    for (const n of ['cf-connecting-ip', 'cf-ray', 'x-real-ip', 'x-forwarded-proto', 'x-forwarded-for', 'x-hub-outcome']) expect(sent.headers.get(n)).toBeNull();
    expect(sent.headers.get('x-provider-signature')).toBe('sig-abc');
    expect(sent.headers.get('x-catchnet-client-ip')).toBe('203.0.113.9');
    expect(sent.headers.get('x-catchnet-received-at')).toBe(String(T0));
    await expectSigned(sent, RAW, 'forward');
  });

  it('[LH:T5] (phần a) hub chết (5xx không outcome) -> D1 đúng 1 dòng, body BẰNG TỪNG BYTE, header gốc đã lọc, provider nhận ack của source (MoMo 204)', async () => {
    const r = rig();
    await addSource(r, 'src_momo', { provider: 'momo', ackStatus: 204 });
    r.setHub(() => new Response('Bad Gateway', { status: 502 }));
    const res = await handleFetch(providerReq('/hooks/momo/src_momo?a=1', { body: RAW }), r.env, r.deps);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const rows = inboxRows(r);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect([...(row.body as Uint8Array)]).toEqual([...RAW]);
    expect(row.target).toBe('/hooks/momo/src_momo?a=1');
    expect(row.method).toBe('POST');
    expect(row.client_ip).toBe('203.0.113.9');
    expect(row.received_at).toBe(T0);
    expect(row.id).toBe(r.calls[0].headers.get('x-catchnet-id')); // cùng id với lần chuyển tiếp
    const headers = JSON.parse(String(row.headers_json));
    expect(headers['x-provider-signature']).toBe('sig-abc');
    expect(Object.keys(headers).filter((k) => /^(cf-|x-real-ip|x-forwarded-|x-catchnet-|x-hub-outcome|host$)/.test(k))).toEqual([]);
    expect(r.logs.map((l) => l.event)).toContain('catchnet_caught');
  });

  it('[LH:T5] (phần b) ack theo khuôn source: VNPay 200 + body RspCode 00 (content-type riêng); outcome unavailable cũng là hub vắng', async () => {
    const r = rig();
    const ack = '{"RspCode":"00","Message":"Confirm Success"}';
    await addSource(r, 'src_vnp', { provider: 'generic', ackStatus: 200, ackType: 'application/json; charset=utf-8', ackBody: ack });
    r.setHub(() => new Response('{}', { status: 503, headers: { 'x-hub-outcome': 'unavailable' } }));
    const res = await handleFetch(providerReq('/hooks/generic/src_vnp', { body: '{"x":1}' }), r.env, r.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe(ack);
    expect(count(r.db, 'inbox')).toBe(1);
  });

  it('[LH:T5] (phần c) timeout -> hứng; mạch "hub chết" mở 30s: request sau KHÔNG chờ hub, hứng luôn; hết 30s thì thử hub lại', async () => {
    const r = rig();
    await addSource(r, 'src_gh', { provider: 'github', ackStatus: 200, ackBody: '{"ok":true}' });
    r.setHub(() => 'timeout');
    expect((await handleFetch(providerReq('/hooks/github/src_gh', { body: 'a' }), r.env, r.deps)).status).toBe(200);
    expect(r.calls).toHaveLength(1);
    r.advance(CIRCUIT_MS - 1);
    expect((await handleFetch(providerReq('/hooks/github/src_gh', { body: 'b' }), r.env, r.deps)).status).toBe(200);
    expect(r.calls).toHaveLength(1); // mạch mở: không gọi hub
    expect(count(r.db, 'inbox')).toBe(2);
    r.advance(2);
    r.setHub(() => new Response('{"ok":true}', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    expect((await handleFetch(providerReq('/hooks/github/src_gh', { body: 'c' }), r.env, r.deps)).status).toBe(200);
    expect(r.calls).toHaveLength(2);
    expect(count(r.db, 'inbox')).toBe(2);
  });

  it('[LH:T6] ghi D1 lỗi -> 503, KHÔNG 2xx (BB-3)', async () => {
    const r = rig();
    await addSource(r, 'src_momo', { provider: 'momo', ackStatus: 204 });
    r.setHub(() => new Response('', { status: 503 }));
    r.db.failOn = /INSERT INTO inbox/;
    const res = await handleFetch(providerReq('/hooks/momo/src_momo', { body: RAW }), r.env, r.deps);
    expect(res.status).toBe(503);
    r.db.failOn = /FROM sources_sync/;
    expect((await handleFetch(providerReq('/hooks/momo/src_momo', { body: RAW }), r.env, r.deps)).status).toBe(503);
    r.db.failOn = null;
    expect(count(r.db, 'inbox')).toBe(0);
  });

  it('[LH:T7] (phần a) source không có trong sources_sync (hoặc provider lệch) + hub chết -> 503, D1 rỗng', async () => {
    const r = rig();
    await addSource(r, 'src_momo', { provider: 'momo', ackStatus: 204 });
    r.setHub(() => new Response('', { status: 502 }));
    expect((await handleFetch(providerReq('/hooks/momo/src_unknown', { body: 'x' }), r.env, r.deps)).status).toBe(503);
    expect((await handleFetch(providerReq('/hooks/stripe/src_momo', { body: 'x' }), r.env, r.deps)).status).toBe(503);
    expect((await handleFetch(providerReq('/hooks/momo/a/b', { body: 'x' }), r.env, r.deps)).status).toBe(503);
    expect(count(r.db, 'inbox')).toBe(0);
  });

  it('[LH:T7] (phần b) không có secret hợp lệ -> vẫn chuyển tiếp (không header lưới) nhưng KHÔNG hứng', async () => {
    const r = rig({ CATCHNET_FORWARD_SECRET: 'ngan' });
    await addSource(r, 'src_momo', { provider: 'momo', ackStatus: 204 });
    r.setHub(() => new Response('{"ok":true}', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    expect((await handleFetch(providerReq('/hooks/momo/src_momo', { body: 'x' }), r.env, r.deps)).status).toBe(200);
    expect(r.calls[0].headers.get('x-catchnet-signature')).toBeNull();
    r.setHub(() => new Response('', { status: 502 }));
    expect((await handleFetch(providerReq('/hooks/momo/src_momo', { body: 'x' }), r.env, r.deps)).status).toBe(503);
    expect(count(r.db, 'inbox')).toBe(0);
  });

  it('[LH:T18] (phần b) source rejectStatus 503 + chữ ký sai -> provider nhận 503 của hub (không x-hub-outcome), D1 rỗng', async () => {
    const r = rig();
    await addSource(r, 'src_gen', { provider: 'generic', ackStatus: 200, ackBody: '{"ok":true}' });
    r.setHub(() => new Response('{"error":"invalid_signature"}', { status: 503, headers: { 'x-hub-outcome': 'rejected', 'content-type': 'application/json' } }));
    const res = await handleFetch(providerReq('/hooks/generic/src_gen', { body: '{"forged":true}' }), r.env, r.deps);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"invalid_signature"}');
    expect(res.headers.get('x-hub-outcome')).toBeNull();
    expect(count(r.db, 'inbox')).toBe(0);
  });

  it('[LH:T9] (phần b) H6: GET/HEAD không hứng (catch_methods mặc định POST) -> 503; source khai GET (VNPay IPN) -> hứng, query thô giữ nguyên', async () => {
    const r = rig();
    await addSource(r, 'src_meta', { provider: 'generic', ackStatus: 200, ackBody: '{"ok":true}' });
    await addSource(r, 'src_vnp', { provider: 'generic', ackStatus: 200, ackBody: '{"RspCode":"00"}', catchMethods: ['GET'] });
    r.setHub(() => new Response('', { status: 502 }));
    const q = '/hooks/generic/src_meta?hub.mode=subscribe&hub.challenge=123';
    expect((await handleFetch(providerReq(q, { method: 'GET' }), r.env, r.deps)).status).toBe(503);
    expect((await handleFetch(providerReq('/hooks/generic/src_vnp', { method: 'HEAD' }), r.env, r.deps)).status).toBe(503);
    expect((await handleFetch(providerReq('/hooks/generic/src_vnp', { body: 'x' }), r.env, r.deps)).status).toBe(503); // POST không khai
    const vnp = '/hooks/generic/src_vnp?vnp_Amount=100000&vnp_OrderInfo=Thanh%20toan%2BDH1&vnp_SecureHash=ab';
    const res = await handleFetch(providerReq(vnp, { method: 'GET' }), r.env, r.deps);
    expect(res.status).toBe(200);
    expect(inboxRows(r).map((x) => [x.method, x.target])).toEqual([['GET', vnp]]);
  });

  it('[LH:T10] (phần a) trần CATCHNET_MAX_PER_KEY / CATCHNET_MAX_ROWS -> 503 + log catchnet_overflow; key khác vẫn hứng tới trần toàn bảng', async () => {
    const r = rig({ CATCHNET_MAX_PER_KEY: '2', CATCHNET_MAX_ROWS: '3' });
    await addSource(r, 'src_a', { provider: 'generic', ackStatus: 202 });
    await addSource(r, 'src_b', { provider: 'generic', ackStatus: 202 });
    r.setHub(() => new Response('', { status: 502 }));
    const hit = (k: string) => handleFetch(providerReq(`/hooks/generic/${k}`, { body: 'x' }), r.env, r.deps).then((x) => x.status);
    expect([await hit('src_a'), await hit('src_a'), await hit('src_a')]).toEqual([202, 202, 503]);
    expect(r.logs.filter((l) => l.event === 'catchnet_overflow')).toHaveLength(1);
    expect([await hit('src_b'), await hit('src_b')]).toEqual([202, 503]); // trần toàn bảng 3
    expect(count(r.db, 'inbox')).toBe(3);
    // Bộ đếm (trigger) giảm khi dòng rời hàng.
    r.db.raw.exec("DELETE FROM inbox WHERE source_key = 'src_a'");
    expect(await hit('src_b')).toBe(202);
  });

  it('[LH:T10] (phần b) body > 1MB -> 413, không gọi hub, không hứng', async () => {
    const r = rig();
    await addSource(r, 'src_a', { provider: 'generic', ackStatus: 200 });
    const res = await handleFetch(providerReq('/hooks/generic/src_a', { body: new Uint8Array(1024 * 1024 + 1) }), r.env, r.deps);
    expect(res.status).toBe(413);
    expect(r.calls).toHaveLength(0);
  });
});

describe('LH2 phát lại (cron)', () => {
  async function seed(r: Rig, n: number, key = 'src_s', provider = 'stripe') {
    await addSource(r, key, { provider, ackStatus: 200, ackBody: '{"received":true}' });
    r.setHub(() => new Response('', { status: 502 }));
    for (let i = 0; i < n; i++) {
      r.advance(1);
      expect((await handleFetch(providerReq(`/hooks/${provider}/${key}?n=${i}`, { body: `{"i":${i}}` }), r.env, r.deps)).status).toBe(200);
    }
    r.calls.length = 0;
    r.bodies.length = 0;
  }

  it('[LH:T8] (phần c) 200 duplicate -> xoá; 401 rejected -> inbox_dead; 503 -> next_at lùi 1m; 429 + Retry-After -> next_at ≥ Retry-After, dòng còn nguyên', async () => {
    const r = rig();
    await seed(r, 4);
    const replies = [
      new Response('{"received":true}', { status: 200, headers: { 'x-hub-outcome': 'duplicate' } }),
      new Response('{"error":"invalid_signature"}', { status: 401, headers: { 'x-hub-outcome': 'rejected' } }),
      new Response('{"error":"rate_limited"}', { status: 429, headers: { 'x-hub-outcome': 'refused', 'retry-after': '600' } }),
      new Response('', { status: 503 }),
    ];
    r.setHub((req) => replies[Number(new URL(req.url).searchParams.get('n'))]);
    const ids = inboxRows(r).map((x) => String(x.id));
    const out = await runReplay(r.env, r.deps);
    expect(out.sent).toBe(4);
    const now = r.now();
    const left = Object.fromEntries(inboxRows(r).map((x) => [String(x.id), x]));
    expect(left[ids[0]]).toBeUndefined();
    expect(left[ids[1]]).toBeUndefined();
    expect(left[ids[2]]).toMatchObject({ attempts: 1, last_status: 429, next_at: now + 600_000 });
    expect(left[ids[3]]).toMatchObject({ attempts: 1, last_status: 503, next_at: now + 60_000 });
    const dead = r.db.raw.prepare('SELECT id, reason, attempts, last_status FROM inbox_dead').all();
    expect(dead).toEqual([{ id: ids[1], reason: 'rejected', attempts: 1, last_status: 401 }]);
    // Phát lại: cùng id / giờ nhận / IP gốc, mode=replay, bytes gốc, ký đúng target.
    for (let i = 0; i < r.calls.length; i++) {
      const c = r.calls[i];
      const n = Number(new URL(c.url).searchParams.get('n'));
      expect(c.headers.get('x-catchnet-id')).toBe(ids[n]);
      expect(c.headers.get('x-catchnet-received-at')).toBe(String(T0 + n + 1));
      expect(c.headers.get('x-catchnet-client-ip')).toBe('203.0.113.9');
      expect(new TextDecoder().decode(r.bodies[i])).toBe(`{"i":${n}}`);
      await expectSigned(c, r.bodies[i], 'replay');
    }
    // Lượt sau chưa tới hạn -> không gửi gì.
    expect((await runReplay(r.env, r.deps)).sent).toBe(0);
  });

  it('[LH:T8] (phần d) nhịp 25/lượt; hub vắng -> DỪNG lô (dòng chưa gửi giữ nguyên), không dội hub đang chết', async () => {
    const r = rig();
    await seed(r, 30);
    r.setHub(() => new Response('ok', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    expect((await runReplay(r.env, r.deps)).sent).toBe(25);
    expect(count(r.db, 'inbox')).toBe(5);
    await seed(r, 12, 'src_t', 'generic');
    r.setHub(() => 'timeout');
    const out = await runReplay(r.env, r.deps);
    expect(out).toEqual({ sent: 5, stopped: true }); // một nhóm song song rồi dừng
    expect(count(r.db, 'inbox')).toBe(17);
    expect(r.db.raw.prepare('SELECT COUNT(*) AS n FROM inbox WHERE attempts = 1').get()).toEqual({ n: 5 });
  });

  it('[LH:T8] (phần e) 4xx không outcome (431 của Node) retry có hạn rồi dead; 404 dead ngay; quá hạn giữ -> dead expired; inbox_dead dọn sau 7 ngày', async () => {
    const r = rig();
    await seed(r, 2);
    r.setHub((req) => (new URL(req.url).searchParams.get('n') === '0' ? new Response('', { status: 431 }) : new Response('', { status: 404, headers: { 'x-hub-outcome': 'rejected' } })));
    await runReplay(r.env, r.deps);
    expect(r.db.raw.prepare('SELECT reason FROM inbox_dead').all()).toEqual([{ reason: 'not_found' }]);
    r.advance(60_000);
    await runReplay(r.env, r.deps);
    r.advance(120_000);
    await runReplay(r.env, r.deps);
    expect(r.db.raw.prepare('SELECT reason, attempts FROM inbox_dead ORDER BY dead_at').all()).toEqual([
      { reason: 'not_found' },
      { reason: 'client_error', attempts: 3 },
    ].map((x) => ({ attempts: 1, ...x })));
    // Quá hạn giữ: không gửi nữa.
    await seed(r, 1);
    r.advance(7 * 86_400_000 + 1);
    const before = r.calls.length;
    await runReplay(r.env, r.deps);
    expect(r.calls.length).toBe(before);
    expect(r.db.raw.prepare("SELECT COUNT(*) AS n FROM inbox_dead WHERE reason = 'expired'").get()).toEqual({ n: 1 });
    // Dọn hàng chết > 7 ngày ở lượt đầu giờ.
    r.advance(7 * 86_400_000 + 1);
    const top = Math.ceil(r.now() / 3_600_000) * 3_600_000;
    await runReplay(r.env, r.deps, top);
    expect(count(r.db, 'inbox_dead')).toBe(0);
  });

  it('[LH:T9] (phần c) VNPay GET phát lại đúng method + query thô, không body', async () => {
    const r = rig();
    await addSource(r, 'src_vnp', { provider: 'generic', ackStatus: 200, ackBody: '{"RspCode":"00"}', catchMethods: ['GET'] });
    r.setHub(() => new Response('', { status: 502 }));
    const vnp = '/hooks/generic/src_vnp?vnp_Amount=100000&vnp_OrderInfo=Thanh%20toan%2BDH1&vnp_SecureHash=ab';
    await handleFetch(providerReq(vnp, { method: 'GET' }), r.env, r.deps);
    r.calls.length = 0;
    r.bodies.length = 0;
    r.setHub(() => new Response('{"RspCode":"00"}', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    await runReplay(r.env, r.deps);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].method).toBe('GET');
    expect(r.calls[0].url).toBe(HUB + vnp);
    expect(r.bodies[0].byteLength).toBe(0);
    await expectSigned(r.calls[0], r.bodies[0], 'replay');
    expect(count(r.db, 'inbox')).toBe(0);
  });
});

describe('LH2 đồng bộ sources_sync (/_admin, §4.5)', () => {
  it('[LH:T7] (phần c) token sai -> 401; thiếu token cấu hình -> 503; ack không phải 2xx / HEAD trong catchMethods -> 422; resync final dọn key cũ', async () => {
    const r = rig();
    expect((await admin(r, 'PUT', '/_admin/sources/src_a', { provider: 'x', ackStatus: 200 }, `${ADMIN}x`)).status).toBe(401);
    expect((await admin(rig({ CATCHNET_ADMIN_TOKEN: 'ngan' }), 'GET', '/_admin/stats')).status).toBe(503);
    expect((await admin(r, 'PUT', '/_admin/sources/src_a', { provider: 'x', ackStatus: 400 })).status).toBe(422);
    expect((await admin(r, 'PUT', '/_admin/sources/src_a', { provider: 'x', ackStatus: 200, catchMethods: ['HEAD'] })).status).toBe(422);
    expect((await admin(r, 'PUT', '/_admin/sources/bad.key', { provider: 'x', ackStatus: 200 })).status).toBe(422);
    await addSource(r, 'src_old', { provider: 'x', ackStatus: 200 });
    r.advance(1000);
    const page1 = await admin(r, 'POST', '/_admin/sources/resync', { syncId: 'sync1', sources: [{ key: 'src_a', provider: 'x', ackStatus: 204 }] });
    expect(page1.status).toBe(200);
    r.advance(10);
    await addSource(r, 'src_live', { provider: 'x', ackStatus: 200 }); // PUT lẻ trong lúc resync -> giữ
    const fin = await admin(r, 'POST', '/_admin/sources/resync', { syncId: 'sync1', sources: [{ key: 'src_b', provider: 'y', ackStatus: 200 }], final: true });
    expect(await fin.json()).toEqual({ upserted: 1, removed: 1 });
    const keys = r.db.raw.prepare('SELECT source_key FROM sources_sync ORDER BY source_key').all().map((x) => (x as { source_key: string }).source_key);
    expect(keys).toEqual(['src_a', 'src_b', 'src_live']);
    expect(await (await admin(r, 'DELETE', '/_admin/sources/src_b')).json()).toEqual({ deleted: true });
    expect(await (await admin(r, 'GET', '/_admin/stats')).json()).toEqual({ pending: 0, dead: 0, sources: 2 });
  });
});
