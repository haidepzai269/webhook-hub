import * as http from 'http';
import { AddressInfo } from 'net';
import { swVerify } from '@hub/crypto';
import { runCli } from '../src/cli';
import { verifyWebhook } from '../src/webhook';

/** DX3 (SPEC-dev-experience §4.3): `hub listen` — kéo bằng polling (A), đẩy vào localhost, ký Standard Webhooks. */
const KEY = 'hk_test_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const SECRET = 'whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0';
const HUB_URL = `hub://${KEY}@localhost:4000/cafe`;

const ev = (cursor: string, id: string) => ({
  id,
  cursor,
  type: 'payment.received',
  source: 'sepay',
  sourceId: 'src-1',
  subject: null,
  data: { amount: 50000 },
  normalized: true,
  correlationId: 'c',
  occurredAt: '2026-10-10T07:02:37.000Z',
  receivedAt: '2026-10-10T07:02:38.120Z',
});

/**
 * Hub giả: /me + /events. `batches` trả lần lượt cho mỗi lần poll (after ≠ latest); hết batch -> abort phiên
 * (giả Ctrl+C) và trả rỗng. Ghi lại mọi `after` đã poll để kiểm cursor tiến.
 */
function fakeHub(batches: any[][], opts: { scopes?: string[]; latest?: string; failFirst?: number } = {}) {
  const ac = new AbortController();
  const afters: string[] = [];
  let i = 0;
  let fails = opts.failFirst ?? 0;
  const fetch = jest.fn(async (url: string, init: any) => {
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1\/p\/[^/]+/, '');
    let status = 200;
    let body: unknown;
    if (path === '/me') body = { project: { slug: 'cafe', name: 'Cafe', environment: 'test' }, serviceName: 'cafe-svc', scopes: opts.scopes ?? ['read:events'] };
    else if (path === '/events') {
      const after = u.searchParams.get('after')!;
      if (after === 'latest') body = { events: [], nextCursor: opts.latest ?? '4' };
      else if (fails > 0) {
        fails--;
        status = 503;
        body = { error: 'internal_error' };
      } else {
        afters.push(after);
        const batch = batches[i++];
        if (!batch) {
          ac.abort();
          body = { events: [], nextCursor: after };
        } else body = { events: batch, nextCursor: batch.length ? batch[batch.length - 1].cursor : after };
      }
    } else {
      status = 404;
      body = { error: 'not_found' };
    }
    return { status, ok: status < 300, text: async () => JSON.stringify(body) };
  });
  return { fetch, ac, afters };
}

function io(hub: ReturnType<typeof fakeHub>, env: Record<string, string> = {}) {
  const lines: string[] = [];
  return {
    lines,
    io: {
      out: (s: string) => lines.push(s),
      err: (s: string) => lines.push(s),
      env: { HUB_URL, ...env },
      fetch: hub.fetch as any,
      signal: hub.ac.signal,
      sleep: (async (_ms: number) => undefined) as (ms: number) => Promise<void>,
    },
  };
}

function localServer(handler: (req: http.IncomingMessage, raw: string, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

describe('[DX] hub listen', () => {
  it('[DX:UX10] forward 1 event: header Standard Webhooks, verifyWebhook(body, headers, secret) = true; webhook-id = event.id', async () => {
    const got: { headers: http.IncomingHttpHeaders; raw: string }[] = [];
    const local = await localServer((req, raw, res) => {
      got.push({ headers: req.headers, raw });
      res.writeHead(200).end('ok');
    });
    const hub = fakeHub([[ev('5', 'evt_A')]]);
    const t = io(hub, { HUB_LISTEN_SECRET: SECRET });
    const code = await runCli(['listen', '--forward', local.url], t.io);
    await local.close();
    expect(code).toBe(0);
    expect(got).toHaveLength(1);
    expect(got[0].headers['webhook-id']).toBe('evt_A');
    expect(got[0].headers['content-type']).toMatch(/application\/json/);
    expect(verifyWebhook(got[0].raw, got[0].headers as any, SECRET)).toBe(true);
    expect(swVerify(SECRET, got[0].headers as any, got[0].raw)).toBe(true); // cùng thuật toán với hub
    expect(JSON.parse(got[0].raw)).toMatchObject({ id: 'evt_A', type: 'payment.received', data: { amount: 50000 } });
    expect(JSON.parse(got[0].raw)).not.toHaveProperty('cursor');
    const text = t.lines.join('\n');
    expect(text).toContain('Connected to project "cafe" as service "cafe-svc" (key hk_test_••••DEFG)');
    expect(text).toMatch(/\d\d:\d\d:\d\d {2}payment\.received {2}evt_A {2}→ 200 \(\d+ ms\)/);
    expect(text).toContain('Forwarded 1 events (0 failed). Last cursor: 5. Resume with --from 5');
    // --from latest (mặc định): hỏi latest trước rồi poll từ đó, long-poll 20s.
    expect(hub.afters[0]).toBe('4');
    const pollUrl = hub.fetch.mock.calls.map((c) => c[0]).find((u: string) => u.includes('after=4'));
    expect(pollUrl).toContain('wait=20');
  });

  it('[DX:UX12] local trả 500 cho event 1 -> in dòng lỗi (kèm body), event 2 vẫn forward, cursor tiến qua cả hai', async () => {
    let n = 0;
    const local = await localServer((_req, _raw, res) => {
      n++;
      if (n === 1) res.writeHead(500).end('boom: handler crashed');
      else res.writeHead(200).end('ok');
    });
    const hub = fakeHub([[ev('5', 'evt_1'), ev('6', 'evt_2')], [ev('7', 'evt_3')]]);
    const t = io(hub, { HUB_LISTEN_SECRET: SECRET });
    const code = await runCli(['listen', '--forward', local.url, '--from', '4'], t.io);
    await local.close();
    expect(code).toBe(0);
    expect(n).toBe(3);
    const text = t.lines.join('\n');
    expect(text).toMatch(/evt_1 {2}→ 500 \(\d+ ms\) boom: handler crashed/);
    expect(text).toMatch(/evt_2 {2}→ 200/);
    expect(hub.afters).toEqual(['4', '6', '7']); // --from 4 dùng thẳng; không retry event 1
    expect(text).toContain('Forwarded 3 events (1 failed). Last cursor: 7');
  });

  it('[DX:UX13] local không chạy (ECONNREFUSED) -> "is your app running?", tiến trình KHÔNG thoát, vẫn poll tiếp', async () => {
    const dead = await localServer((_r, _b, res) => res.end());
    await dead.close(); // cổng vừa đóng -> ECONNREFUSED
    const hub = fakeHub([[ev('5', 'evt_1')], [ev('6', 'evt_2')]]);
    const t = io(hub, { HUB_LISTEN_SECRET: SECRET });
    const code = await runCli(['listen', '--forward', dead.url, '--from', '4'], t.io);
    expect(code).toBe(0);
    const text = t.lines.join('\n');
    expect(text).toContain(`Cannot reach ${dead.url} — is your app running?`);
    expect(hub.afters).toEqual(['4', '5', '6']);
    expect(text).toContain('Forwarded 2 events (2 failed)');
  });

  it('[DX:UX14] --forward https://evil.example.com/x không có --allow-remote -> thoát ≠ 0 kèm hướng dẫn; có cờ thì chạy', async () => {
    const hub = fakeHub([]);
    const t = io(hub);
    const code = await runCli(['listen', '--forward', 'https://evil.example.com/x'], t.io);
    expect(code).not.toBe(0);
    expect(t.lines.join('\n')).toMatch(/--allow-remote/);
    expect(hub.fetch).not.toHaveBeenCalled(); // từ chối TRƯỚC khi gọi hub

    const hub2 = fakeHub([]);
    const t2 = io(hub2);
    expect(await runCli(['listen', '--forward', 'https://evil.example.com/x', '--allow-remote'], t2.io)).toBe(0);
    for (const ok of ['http://localhost:3000/w', 'http://[::1]:3000/w', 'http://host.docker.internal:3000/w']) {
      const h = fakeHub([]);
      expect(await runCli(['listen', '--forward', ok], io(h).io)).toBe(0);
    }
  });

  it('[DX:UX15] toàn bộ stdout/stderr của một phiên (kể cả lỗi) KHÔNG chứa key thô', async () => {
    const local = await localServer((_req, _raw, res) => res.writeHead(401).end('bad sig'));
    const hub = fakeHub([[ev('5', 'evt_1')]], { failFirst: 1 });
    const t = io(hub); // không có secret -> CLI tự sinh và in một lần
    const code = await runCli(['listen', '--forward', local.url, '--url', HUB_URL], t.io);
    await local.close();
    expect(code).toBe(0);
    const text = t.lines.join('\n');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(8)); // cả phần sau tiền tố
    expect(text).toMatch(/Your local signing secret: whsec_[A-Za-z0-9+/=]{32} \(set HUB_LISTEN_SECRET to keep it stable\)/);
    expect(text).toMatch(/hub unavailable \(HTTP 503\).*retrying in 1s/);
  });

  it('thiếu HUB_URL và --url -> mã 2 kèm hướng dẫn; thiếu scope read:events -> in fix, mã 1', async () => {
    const hub = fakeHub([]);
    const t = io(hub);
    t.io.env = {} as any;
    expect(await runCli(['listen', '--forward', 'http://localhost:3000/w'], t.io)).toBe(2);
    expect(t.lines.join('\n')).toMatch(/HUB_URL/);

    const h2 = fakeHub([], { scopes: ['publish:events'] });
    const t2 = io(h2);
    expect(await runCli(['listen', '--forward', 'http://localhost:3000/w'], t2.io)).toBe(1);
    expect(t2.lines.join('\n')).toMatch(/read:events/);
  });

  it('backoff khi hub 5xx: 1s → 2s → 5s (trần), không thoát', async () => {
    const hub = fakeHub([], { failFirst: 4 });
    const sleeps: number[] = [];
    const t = io(hub, { HUB_LISTEN_SECRET: SECRET });
    t.io.sleep = async (ms: number) => void sleeps.push(ms);
    expect(await runCli(['listen', '--forward', 'http://localhost:3000/w', '--from', '0'], t.io)).toBe(0);
    expect(sleeps).toEqual([1000, 2000, 5000, 5000]);
  });
});
