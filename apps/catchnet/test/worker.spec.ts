import { beforeEach, describe, expect, it } from 'vitest';
import { hmacHex, sha256Hex } from '../src/sign';
import { CIRCUIT_MS, handleFetch, LEASE_MS, resetCircuit, runReplay, safeHookTarget, type Deps } from '../src/worker';
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
  it('[LH:T5] (phần d) TB-1: mạch đang mở + source KHÔNG hứng được (chưa sync / GET bắt tay) -> vẫn chuyển tiếp, nhận phản hồi của hub (không 503)', async () => {
    const r = rig();
    await addSource(r, 'src_gh', { provider: 'github', ackStatus: 200, ackBody: '{"ok":true}' });
    r.setHub(() => 'timeout');
    await handleFetch(providerReq('/hooks/github/src_gh', { body: 'a' }), r.env, r.deps); // mở mạch
    r.advance(1000);
    r.setHub(() => new Response('{"received":true}', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    const calls = r.calls.length;
    // Key chưa có trong sources_sync.
    const res = await handleFetch(providerReq('/hooks/github/src_unsynced', { body: 'b' }), r.env, r.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"received":true}');
    // GET bắt tay (Meta hub.challenge) của source chỉ hứng POST.
    r.setHub(() => new Response('123', { status: 200, headers: { 'x-hub-outcome': 'handshake' } }));
    const hs = await handleFetch(providerReq('/hooks/github/src_gh?hub.challenge=123', { method: 'GET' }), r.env, r.deps);
    expect([hs.status, await hs.text()]).toEqual([200, '123']);
    expect(r.calls.length).toBe(calls + 2);
    // Source hứng được thì vẫn đi đường mạch: ghi D1, không gọi hub.
    expect((await handleFetch(providerReq('/hooks/github/src_gh', { body: 'c' }), r.env, r.deps)).status).toBe(200);
    expect(r.calls.length).toBe(calls + 2);
    expect(count(r.db, 'inbox')).toBe(2);
  });

  it('[LH:T10] (phần c) TB-2: trần BYTE theo key + toàn D1 (tính cả inbox_dead) và trần số lần hứng/ngày -> 503 + catchnet_overflow', async () => {
    const MB = 1024 * 1024;
    const r = rig({ CATCHNET_MAX_KEY_BYTES: String(2 * MB), CATCHNET_MAX_BYTES: String(3 * MB), CATCHNET_MAX_PER_DAY: '6' });
    await addSource(r, 'src_a', { provider: 'generic', ackStatus: 202 });
    await addSource(r, 'src_b', { provider: 'generic', ackStatus: 202 });
    r.setHub(() => new Response('', { status: 502 }));
    const hit = (k: string, n: number) =>
      handleFetch(providerReq(`/hooks/generic/${k}`, { body: new Uint8Array(n) }), r.env, r.deps).then((x) => x.status);
    const big = 900 * 1024;
    expect([await hit('src_a', big), await hit('src_a', big), await hit('src_a', big)]).toEqual([202, 202, 503]); // > 2 MB/key
    expect(await hit('src_b', big)).toBe(202); // tổng 2,7 MB
    expect(await hit('src_b', big)).toBe(503); // > 3 MB toàn D1
    // inbox_dead chiếm chung trần dung lượng.
    r.db.raw.exec("INSERT INTO inbox_dead SELECT id || 'x', source_key, provider, method, target, headers_json, body, client_ip, received_at, 0, NULL, NULL, 'rejected', 0 FROM inbox LIMIT 1");
    r.db.raw.exec("DELETE FROM inbox WHERE source_key = 'src_b'");
    expect(await hit('src_b', 10)).toBe(202); // 1,8 MB inbox + 0,9 MB dead + 10 B
    expect(await hit('src_b', big)).toBe(503);
    // Trần ngày: đã hứng 4 lần hôm nay (trigger không giảm khi xoá) -> còn 2.
    r.db.raw.exec('DELETE FROM inbox; DELETE FROM inbox_dead;');
    expect([await hit('src_b', 1), await hit('src_b', 1), await hit('src_b', 1)]).toEqual([202, 202, 503]);
    r.advance(86_400_000); // sang ngày UTC mới
    expect(await hit('src_b', 1)).toBe(202);
    expect(r.logs.filter((l) => l.event === 'catchnet_overflow').length).toBe(4);
  });

  it('[LH:T10] (phần d) L2: target thoát khỏi /hooks/ (.., %2e, %2f, \) -> 404, không chuyển tiếp, không hứng', async () => {
    const r = rig();
    for (const p of ['/hooks/%2e%2e/api/v1/x', '/hooks/%2E%2E/%2E%2E/auth', '/hooks/../api/v1/x', '/hooks/github%2f..%2f..%2fapi', '/hooks/a\..\api']) {
      const res = await handleFetch(new Request(`${WORKER}${p}`, { method: 'POST', body: 'x' }), r.env, r.deps);
      // new Request đã gộp ".." thô -> path rời /hooks: handleFetch không vào nhánh hooks (404); bản mã hoá -> safeHookTarget 404.
      expect(res.status).toBe(404);
    }
    // workerd có thể giữ %2e%2e thô trong request.url (Node/WHATWG gộp sẵn) -> kiểm thẳng hàm chặn trên chuỗi thô.
    for (const t of ['/hooks/%2e%2e/api/v1/x', '/hooks/github/%2E%2E/x', '/hooks/a/..', '/hooks/a%2fb/c', '/hooks/a%5c..', '/api/v1/x', '/HOOKSX/a']) {
      expect({ t, ok: safeHookTarget(t, HUB) }).toEqual({ t, ok: false });
    }
    for (const t of ['/hooks/github/src_gh', '/hooks/github/src_gh?', '/hooks/generic/k?a=b%20c&x=%2e%2e']) {
      expect({ t, ok: safeHookTarget(t, HUB) }).toEqual({ t, ok: true }); // %2e trong QUERY không sao
    }
    expect(r.calls).toHaveLength(0);
    expect(count(r.db, 'inbox')).toBe(0);
  });

  it('[LH:T10] (phần e) L7: body chunked (không content-length) > 1MB -> 413 khi đọc vượt trần, không gọi hub', async () => {
    const r = rig();
    const chunk = new Uint8Array(256 * 1024);
    let sentChunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sentChunks++ < 8) c.enqueue(chunk);
        else c.close();
      },
    });
    const req = new Request(`${WORKER}/hooks/generic/src_a`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    expect((await handleFetch(req, r.env, r.deps)).status).toBe(413);
    expect(sentChunks).toBeLessThanOrEqual(6); // dừng đọc ngay khi vượt 1MB, không đọc trọn 2MB
    expect(r.calls).toHaveLength(0);
  });
  it('[LH:T10] (phần f) TB-2a: trần byte tính body + header + target (UTF-8) — body rỗng, header lớn vẫn chạm trần', async () => {
    const r = rig({ CATCHNET_MAX_KEY_BYTES: String(1024 * 1024) }); // trần nhỏ nhất được phép (kẹp ≥ 1 MB)
    await addSource(r, 'src_h', { provider: 'generic', ackStatus: 202 });
    r.setHub(() => new Response('', { status: 502 }));
    const fat = { 'x-pad': 'é'.repeat(7000) }; // 14000 byte UTF-8 (7000 ký tự) — dưới trần hứng 16 KB
    const hit = () => handleFetch(providerReq('/hooks/generic/src_h', { headers: fat }), r.env, r.deps).then((x) => x.status);
    const got: number[] = [];
    for (let i = 0; i < 80; i++) got.push(await hit());
    // 1 MB / (14000 B header + target + khung JSON) ≈ 74 dòng; đếm theo KÝ TỰ (7000) thì lọt cả 80.
    expect(got.indexOf(503)).toBe(74);
    expect(got.slice(74).every((x) => x === 503)).toBe(true);
    const c = r.db.raw.prepare("SELECT n, bytes FROM inbox_count WHERE k = 'src_h'").get() as { n: number; bytes: number };
    expect(c.n).toBe(74);
    expect(c.bytes).toBeGreaterThan(74 * 14000);
    expect(c.bytes).toBeLessThanOrEqual(1024 * 1024); // đếm theo BYTE, không theo ký tự
    const sum = r.db.raw.prepare('SELECT SUM(length(body) + length(CAST(headers_json AS BLOB)) + length(CAST(target AS BLOB))) AS b FROM inbox').get() as { b: number };
    expect(c.bytes).toBe(sum.b); // trigger khớp công thức của insertCaught
  });

  it('[LH:T10] (phần g) TB-2a: header > 16 KB hoặc target > 4 KB -> không hứng (hub vắng: 503, D1 rỗng) nhưng vẫn chuyển tiếp khi hub sống', async () => {
    const r = rig();
    await addSource(r, 'src_h', { provider: 'generic', ackStatus: 202 });
    const big = { 'x-pad': 'a'.repeat(17 * 1024) };
    const longQ = '/hooks/generic/src_h?q=' + 'b'.repeat(4100);
    r.setHub(() => new Response('{"ok":true}', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    expect((await handleFetch(providerReq('/hooks/generic/src_h', { body: 'x', headers: big }), r.env, r.deps)).status).toBe(200);
    expect((await handleFetch(providerReq(longQ, { body: 'x' }), r.env, r.deps)).status).toBe(200);
    r.setHub(() => new Response('', { status: 502 }));
    expect((await handleFetch(providerReq('/hooks/generic/src_h', { body: 'x', headers: big }), r.env, r.deps)).status).toBe(503);
    expect((await handleFetch(providerReq(longQ, { body: 'x' }), r.env, r.deps)).status).toBe(503);
    expect(count(r.db, 'inbox')).toBe(0);
    expect(r.logs.filter((l) => l.event === 'catchnet_not_caught')).toHaveLength(2);
  });

  it('[LH:T10] (phần h) TB-2a: dòng ở inbox_dead vẫn giữ trần của key (không "giải phóng" key bằng cách để hub từ chối) tới khi bị dọn', async () => {
    const r = rig({ CATCHNET_MAX_PER_KEY: '2' });
    await addSource(r, 'src_d', { provider: 'generic', ackStatus: 202 });
    r.setHub(() => new Response('', { status: 502 }));
    const hit = () => handleFetch(providerReq('/hooks/generic/src_d', { body: 'rác' }), r.env, r.deps).then((x) => x.status);
    expect([await hit(), await hit()]).toEqual([202, 202]);
    r.setHub(() => new Response('{"error":"invalid_signature"}', { status: 401, headers: { 'x-hub-outcome': 'rejected' } }));
    await runReplay(r.env, r.deps);
    expect([count(r.db, 'inbox'), count(r.db, 'inbox_dead')]).toEqual([0, 2]);
    r.setHub(() => new Response('', { status: 502 }));
    expect(await hit()).toBe(503); // key vẫn đầy
    // N5: dòng đếm '#dead' bị xoá tay -> lần chuyển dead sau tự tạo lại (UPSERT), không âm thầm bỏ qua.
    r.db.raw.exec("DELETE FROM inbox_count WHERE k = '#dead'");
    r.advance(7 * 86_400_000 + 1);
    await runReplay(r.env, r.deps, Math.ceil(r.now() / 3_600_000) * 3_600_000); // lượt đầu giờ dọn hàng chết
    expect(count(r.db, 'inbox_dead')).toBe(0);
    expect(await hit()).toBe(202);
  });

  it('[LH:T10] (phần i) N4: /HOOKS/… (hoa) -> 404, không chuyển tiếp (nginx + HOOK_RE chỉ nhận chữ thường)', async () => {
    const r = rig();
    for (const p of ['/HOOKS/github/k', '/Hooks/github/k']) {
      expect((await handleFetch(new Request(WORKER + p, { method: 'POST', body: 'x' }), r.env, r.deps)).status).toBe(404);
    }
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

  it('[LH:T8] (phần d) ≤ 10 dòng/lượt (ngân sách 50 truy vấn D1/subrequest); hub vắng -> DỪNG lô, dòng chưa gửi đã được lease lùi 5 phút', async () => {
    const r = rig();
    await seed(r, 30);
    r.setHub(() => new Response('ok', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    expect((await runReplay(r.env, r.deps)).sent).toBe(10);
    expect(count(r.db, 'inbox')).toBe(20);
    r.setHub(() => 'timeout');
    const out = await runReplay(r.env, r.deps);
    expect(out).toEqual({ sent: 5, stopped: true }); // một nhóm song song rồi dừng
    expect(count(r.db, 'inbox')).toBe(20);
    expect(r.db.raw.prepare('SELECT COUNT(*) AS n FROM inbox WHERE attempts = 1').get()).toEqual({ n: 5 });
    // 5 dòng chưa gửi của lô: lease next_at = now + 5m, attempts giữ 0.
    expect(r.db.raw.prepare('SELECT COUNT(*) AS n FROM inbox WHERE attempts = 0 AND next_at = ?').get(r.now() + LEASE_MS)).toEqual({ n: 5 });
  });

  it('[LH:T8] (phần f) TB-3: lượt cron chết giữa chừng (ghi kết quả lỗi) -> lô đã lease, lượt sau gửi dòng KHÁC chứ không kẹt đầu hàng', async () => {
    const r = rig();
    await seed(r, 12);
    const firstTen = (r.db.raw.prepare('SELECT id FROM inbox ORDER BY next_at LIMIT 10').all() as Array<{ id: string }>).map((x) => x.id);
    r.setHub(() => new Response('ok', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    r.db.failOn = /DELETE FROM inbox WHERE id|UPDATE inbox SET attempts/; // mọi ghi kết quả đều chết
    await runReplay(r.env, r.deps);
    r.db.failOn = null;
    expect(count(r.db, 'inbox')).toBe(12);
    r.calls.length = 0;
    r.advance(1000);
    await runReplay(r.env, r.deps);
    const sentIds = r.calls.map((c) => c.headers.get('x-catchnet-id'));
    expect(sentIds).toHaveLength(2);
    for (const id of sentIds) expect(firstTen).not.toContain(id);
    // Hết lease thì lô cũ được thử lại.
    r.advance(LEASE_MS);
    r.calls.length = 0;
    await runReplay(r.env, r.deps);
    expect(r.calls).toHaveLength(10);
    expect(count(r.db, 'inbox')).toBe(0);
  });

  it('[LH:T8] (phần g) TB-3: lô cắt theo tổng byte ≤ 2 MB (body nạp từng dòng), luôn gửi ≥ 1 dòng', async () => {
    const r = rig();
    await addSource(r, 'src_big', { provider: 'generic', ackStatus: 200 });
    r.setHub(() => new Response('', { status: 502 }));
    for (let i = 0; i < 4; i++) {
      r.advance(1);
      expect((await handleFetch(providerReq('/hooks/generic/src_big', { body: new Uint8Array(900 * 1024) }), r.env, r.deps)).status).toBe(200);
    }
    r.calls.length = 0;
    r.setHub(() => new Response('ok', { status: 200, headers: { 'x-hub-outcome': 'accepted' } }));
    expect((await runReplay(r.env, r.deps)).sent).toBe(2);
    expect(count(r.db, 'inbox')).toBe(2);
  });

  it('[LH:T8] (phần h) L3: 2xx KHÔNG x-hub-outcome (HUB_ORIGIN_URL trỏ nhầm) -> không xoá, retry + log catchnet_misconfigured', async () => {
    const r = rig();
    await seed(r, 1);
    r.setHub(() => new Response('<html>maintenance</html>', { status: 200 }));
    await runReplay(r.env, r.deps);
    expect(inboxRows(r)).toEqual([expect.objectContaining({ attempts: 1, last_status: 200, last_error: '2xx_without_x-hub-outcome' })]);
    expect(r.logs.some((l) => l.event === 'catchnet_misconfigured')).toBe(true);
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
  it('[LH:T8] (phần i) N3: dòng quá hạn chuyển inbox_dead bằng SQL TRƯỚC khi nạp body — nạp body lỗi cũng không giữ nó ở đầu hàng', async () => {
    const r = rig();
    await seed(r, 1);
    r.advance(7 * 86_400_000 + 1);
    r.db.failOn = /^SELECT id, source_key[\s\S]*FROM inbox WHERE id = \?/; // loadRow chết
    r.calls.length = 0;
    await runReplay(r.env, r.deps);
    r.db.failOn = null;
    expect(r.calls).toHaveLength(0);
    expect(r.db.raw.prepare('SELECT reason FROM inbox_dead').all()).toEqual([{ reason: 'expired' }]);
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
    expect(await (await admin(r, 'GET', '/_admin/stats')).json()).toEqual({ pending: 0, pendingBytes: 0, dead: 0, deadBytes: 0, sources: 2, caughtToday: 0 });
    // L7: % hỏng trong key -> 422, không 503.
    expect((await admin(r, 'PUT', '/_admin/sources/%E0%A4%A', { provider: 'x', ackStatus: 200 })).status).toBe(422);
    // L6: lượt resync RỖNG + final -> dọn mọi key cũ hơn lượt đó.
    r.advance(10);
    expect(await (await admin(r, 'POST', '/_admin/sources/resync', { syncId: 'sync2', sources: [], final: true })).json()).toEqual({ upserted: 0, removed: 2 });
  });
});
