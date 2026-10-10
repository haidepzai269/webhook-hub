import { inspect } from 'util';
import { swHeaders } from '@hub/crypto';
import { HubError, createHubClient, parseConnectionString } from '../src/client';
import { challengeResponse, verifyWebhook } from '../src/webhook';

/** S11 (SPEC §4.11): SDK Node — connection string, che key, publish/poll/ensure, verify phía nhận. */
const KEY = 'hk_live_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function fakeFetch(routes: Record<string, (body: any) => { status: number; body?: unknown }>) {
  const calls: { method: string; url: string; headers: any; body: any }[] = [];
  const fn = jest.fn(async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, headers: init.headers, body });
    const path = new URL(url).pathname.replace(/^\/v1\/p\/[^/]+/, '');
    const h = routes[`${init.method} ${path}`];
    const r = h ? h(body) : { status: 404, body: { error: 'not_found' } };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  });
  return { fn, calls };
}

describe('@hub/sdk (S11)', () => {
  it('[MS:U31] parse hubs://hk_live_abc@h.example.com/cafe -> baseUrl https, project cafe; hub:// -> http', () => {
    expect(parseConnectionString(`hubs://${KEY}@h.example.com/cafe`)).toEqual({ baseUrl: 'https://h.example.com', project: 'cafe', apiKey: KEY });
    expect(parseConnectionString(`hub://${KEY}@localhost:14000/default`).baseUrl).toBe('http://localhost:14000');
    expect(() => parseConnectionString('https://h.example.com/cafe')).toThrow(HubError);
    expect(() => parseConnectionString(`hubs://khongphaikey@h/cafe`)).toThrow(/hubs:\/\/hk_<env>_/);
  });

  it('[MS:U32] console.log / JSON.stringify / message lỗi KHÔNG chứa key thô', async () => {
    const { fn } = fakeFetch({ 'GET /me': () => ({ status: 401, body: { error: 'invalid_api_key' } }) });
    const c = createHubClient(`hubs://${KEY}@h.example.com/cafe`, { fetch: fn });
    expect(inspect(c)).not.toContain(KEY);
    expect(inspect(c)).toContain('hk_live_••••DEFG');
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(JSON.stringify({ c })).not.toContain(KEY);
    expect(Object.keys(c)).not.toContain('apiKey');
    const err: HubError = await c.me().catch((e) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err).toMatchObject({ status: 401, code: 'invalid_api_key' });
    expect(`${err.message} ${err.stack} ${inspect(err)}`).not.toContain(KEY);
    const net = createHubClient(`hubs://${KEY}@h.example.com/cafe`, { fetch: async () => { throw Object.assign(new Error(`fail Bearer ${KEY}`), { code: 'ECONNREFUSED' }); } });
    const e2: HubError = await net.me().catch((e) => e);
    expect(e2).toMatchObject({ status: 0, code: 'network_error' });
    expect(e2.message).not.toContain(KEY);
  });

  it('[MS:U33] challengeResponse({type:endpoint.verification, challenge:x}) -> {challenge:x}; body khác -> null', () => {
    expect(challengeResponse({ type: 'endpoint.verification', challenge: 'x' })).toEqual({ challenge: 'x' });
    expect(challengeResponse({ type: 'order.created', challenge: 'x' })).toBeNull();
    expect(challengeResponse(null)).toBeNull();
    expect(challengeResponse('x')).toBeNull();
  });

  it('S11: verifyWebhook của SDK khớp chữ ký hub ký (libs/crypto) — vector chuẩn và secret cũ utf8', () => {
    const body = '{"test": 2432232314}';
    const h = { 'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek', 'webhook-timestamp': '1614265330', 'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' };
    expect(verifyWebhook(body, h, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', { nowSec: 1614265330 })).toBe(true);
    expect(verifyWebhook(body + ' ', h, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', { nowSec: 1614265330 })).toBe(false);
    const legacy = swHeaders('hub_outbound_signing_secret_999', 'evt_1', '{}');
    expect(verifyWebhook(Buffer.from('{}'), legacy, 'hub_outbound_signing_secret_999')).toBe(true);
    expect(verifyWebhook('{}', {}, 'x')).toBe(false);
  });

  it('S11: publish / poll gửi đúng path, header Bearer, query', async () => {
    const { fn, calls } = fakeFetch({
      'POST /events': () => ({ status: 202, body: { eventId: null, rawEventId: 'r1', duplicate: false } }),
      'GET /events': () => ({ status: 200, body: { events: [], nextCursor: '5' } }),
    });
    const c = createHubClient(`hub://${KEY}@localhost:14000/cafe`, { fetch: fn });
    expect(await c.publish('order.created', { total: 1 }, { idempotencyKey: 'o1' })).toMatchObject({ rawEventId: 'r1' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://localhost:14000/v1/p/cafe/events', body: { type: 'order.created', data: { total: 1 }, idempotencyKey: 'o1' } });
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    await c.poll({ after: '5', types: ['order.*', 'payment.received'], status: 'failed', wait: 10 });
    expect(calls[1].url).toBe('http://localhost:14000/v1/p/cafe/events?after=5&types=order.*%2Cpayment.received&status=failed&wait=10');
  });

  it('S11: endpoints.ensure idempotent — chưa có: tạo + subscription; đã có VERIFIED + sub phủ: không tạo gì; FAILED sau verify -> HubError', async () => {
    const state: any = { endpoints: [], subs: [] };
    const routes = {
      'GET /endpoints': () => ({ status: 200, body: state.endpoints }),
      'POST /endpoints': (b: any) => {
        const e = { id: 'e1', name: b.name, url: b.url, verification: state.next ?? 'VERIFIED', verificationError: state.next ? 'http_500' : null };
        state.endpoints.push(e);
        return { status: 201, body: e };
      },
      'POST /endpoints/e1/verify': () => ({ status: 200, body: { verification: 'FAILED', verificationError: 'timeout' } }),
      'GET /subscriptions': () => ({ status: 200, body: state.subs }),
      'POST /subscriptions': (b: any) => {
        const s = { id: 's1', isActive: true, sourceIds: [], ...b };
        state.subs.push(s);
        return { status: 201, body: s };
      },
    };
    const { fn, calls } = fakeFetch(routes);
    const c = createHubClient(`hub://${KEY}@shop-hub/default`, { fetch: fn });
    const input = { name: 'shop', url: 'http://shop:4001/hub-webhook', eventTypes: ['payment.received'], signingSecret: 'hub_outbound_signing_secret_999' };
    const first = await c.endpoints.ensure(input);
    expect(first).toMatchObject({ created: true, endpoint: { id: 'e1' }, subscription: { id: 's1', eventTypes: ['payment.received'] } });
    expect(calls.find((x) => x.method === 'POST' && x.url.endsWith('/endpoints'))!.body).toMatchObject({ signingSecret: 'hub_outbound_signing_secret_999' });
    // Không kèm secret: endpoint VERIFIED + sub phủ -> chỉ 2 GET (có secret thì luôn /verify — xem MS-R4)
    const noSecret = { ...input, signingSecret: undefined };
    const n = calls.length;
    expect(await c.endpoints.ensure(noSecret)).toMatchObject({ created: false, subscription: { id: 's1' } });
    expect(calls.slice(n).map((x) => x.method)).toEqual(['GET', 'GET']);
    state.endpoints[0].verification = 'FAILED';
    await expect(c.endpoints.ensure(noSecret)).rejects.toMatchObject({ code: 'endpoint_not_verified' });
  });

  it('MS-R4: ensure gặp endpoint ĐÃ VERIFIED + có signingSecret -> vẫn /verify kèm secret (lộ lệch secret thay vì DEAD âm thầm)', async () => {
    const state: any = { endpoints: [{ id: 'e1', name: 'shop', url: 'http://shop:4001/hub-webhook', verification: 'VERIFIED', verificationError: null }], subs: [{ id: 's1', endpointId: 'e1', eventTypes: ['payment.received'], sourceIds: [], isActive: true }], verifyReply: { verification: 'FAILED', verificationError: 'http_401', secretRotated: false } };
    const { fn, calls } = fakeFetch({
      'GET /endpoints': () => ({ status: 200, body: state.endpoints }),
      'POST /endpoints/e1/verify': () => ({ status: 200, body: state.verifyReply }),
      'GET /subscriptions': () => ({ status: 200, body: state.subs }),
    });
    const c = createHubClient(`hub://${KEY}@h/default`, { fetch: fn });
    const input = { name: 'shop', url: 'http://shop:4001/hub-webhook', eventTypes: ['payment.received'], signingSecret: 'secret-moi-cua-shop-123' };
    await expect(c.endpoints.ensure(input)).rejects.toMatchObject({ code: 'endpoint_not_verified', message: expect.stringContaining('http_401') });
    expect(calls.find((x) => x.url.endsWith('/verify'))!.body).toEqual({ signingSecret: 'secret-moi-cua-shop-123' });
    state.verifyReply = { verification: 'VERIFIED', verificationError: null, secretRotated: true };
    await expect(c.endpoints.ensure(input)).resolves.toMatchObject({ created: false, endpoint: { verification: 'VERIFIED' } });
  });
});

