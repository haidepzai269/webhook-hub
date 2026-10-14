import * as http from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { runCli } from '../src/cli';
import { unwrapUnverified } from '../src/webhook';

/** PK5 (SPEC-provider-khac §7.2, E4, ADR-206): SDK phía đích — `unwrapUnverified` và nhãn của `hub listen`. */
const KEY = `hk_test_${randomBytes(32).toString('base64url')}`;
const HUB_URL = `hub://${KEY}@localhost:4000/cafe`;

describe('[PK5] unwrapUnverified', () => {
  it('[PK:T17] (phần d) rawBody đúng từng byte (form `a+b%20c`, byte nhị phân), headers chỉ chuỗi, url null khi nguồn không forwardUrl', () => {
    for (const body of [Buffer.from('a+b%20c=d'), Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a])]) {
      const u = unwrapUnverified({ verified: false, data: { raw: body.toString('base64'), contentType: 'application/x-www-form-urlencoded', headers: { 'x-sig': 'v', bad: 1 }, method: 'POST' } });
      expect(u.rawBody.equals(body)).toBe(true);
      expect(u.headers).toEqual({ 'x-sig': 'v' });
      expect(u.url).toBeNull();
      expect(u.contentType).toBe('application/x-www-form-urlencoded');
    }
    expect(unwrapUnverified({ verified: false, data: { raw: '', url: 'https://hub.example.com/hooks/generic/k?x=1' } }).url).toBe('https://hub.example.com/hooks/generic/k?x=1');
  });

  it('không dùng nhầm cho event đã xác thực / thiếu raw -> ném (không trả bytes rỗng như thể hợp lệ)', () => {
    expect(() => unwrapUnverified({ verified: true, data: { raw: 'e30=' } })).toThrow(/verified/);
    expect(() => unwrapUnverified({ data: { raw: 'e30=' } })).toThrow(/verified/);
    expect(() => unwrapUnverified({ verified: false, data: {} })).toThrow(/raw/);
  });
});

describe('[PK5] hub listen và sự kiện chưa xác thực', () => {
  function hub(scopes: string[]) {
    const ac = new AbortController();
    const urls: string[] = [];
    let served = false;
    const fetch = jest.fn(async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v1\/p\/[^/]+/, '');
      let body: unknown;
      if (path === '/me') body = { project: { slug: 'cafe', name: 'Cafe', environment: 'test' }, serviceName: 'svc', scopes };
      else if (u.searchParams.get('after') === 'latest') body = { events: [], nextCursor: '1' };
      else if (!served) {
        served = true;
        body = {
          events: [{ id: 'evt_U', cursor: '2', type: 'momo.ipn', source: 'generic', sourceId: 's', subject: null, data: { raw: 'e30=' }, normalized: false, verified: false, correlationId: 'c', occurredAt: '2026-10-14T00:00:00.000Z', receivedAt: '2026-10-14T00:00:00.000Z' }],
          nextCursor: '2',
        };
      } else {
        ac.abort();
        body = { events: [], nextCursor: '2' };
      }
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    });
    return { fetch, ac, urls };
  }

  it('[PK:T36] (phần d) key có scope read:unverified -> listen xin includeUnverified=true và in nhãn [unverified]; key thường không xin', async () => {
    const got: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks`;
    const h = hub(['read:events', 'read:unverified']);
    const lines: string[] = [];
    const code = await runCli(['listen', '--forward', local], {
      out: (s: string) => lines.push(s),
      err: (s: string) => lines.push(s),
      env: { HUB_URL, HUB_LISTEN_SECRET: `whsec_${randomBytes(24).toString('base64')}` },
      fetch: h.fetch as any,
      signal: h.ac.signal,
      sleep: async () => undefined,
    } as any);
    await new Promise<void>((r) => server.close(() => r()));
    expect(code).toBe(0);
    expect(h.urls.some((u) => u.includes('after=1') && u.includes('includeUnverified=true'))).toBe(true);
    expect(lines.join('\n')).toMatch(/momo\.ipn \[unverified\] {2}evt_U {2}→ 200/);
    expect(JSON.parse(got[0])).toMatchObject({ id: 'evt_U', verified: false });

    const plain = hub(['read:events']);
    await runCli(['listen', '--forward', local], {
      out: () => undefined,
      err: () => undefined,
      env: { HUB_URL, HUB_LISTEN_SECRET: `whsec_${randomBytes(24).toString('base64')}` },
      fetch: plain.fetch as any,
      signal: plain.ac.signal,
      sleep: async () => undefined,
    } as any);
    expect(plain.urls.some((u) => u.includes('includeUnverified'))).toBe(false);
  });
});
