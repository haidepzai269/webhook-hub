import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSink } = require('../../tools/verify-sink/sink.js');

/** KN2 (SPEC-ket-noi §4.6): PayOS/Stripe giả trong sink — CI không gọi provider thật. */
describe('[KN2] verify-sink fake providers', () => {
  let sink: http.Server;
  let recv: http.Server;
  let base = '';
  let recvUrl = '';
  let recvStatus = 200;
  const got: any[] = [];
  const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeAll(async () => {
    sink = createSink({ env: { FAKE_PAYOS_CLIENT_ID: 'cid', FAKE_PAYOS_API_KEY: 'akey', FAKE_PAYOS_CHECKSUM_KEY: 'ck' } });
    recv = http.createServer((req, res) => {
      const c: Buffer[] = [];
      req.on('data', (x) => c.push(x));
      req.on('end', () => {
        got.push(JSON.parse(Buffer.concat(c).toString('utf8')));
        res.writeHead(recvStatus).end('{}');
      });
    });
    base = await listen(sink);
    recvUrl = `${await listen(recv)}/hooks/payos/src_x`;
  });
  afterAll(async () => {
    await new Promise((r) => sink.close(r));
    await new Promise((r) => recv.close(r));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('PayOS confirm-webhook: sai key -> 401; đúng -> bắn request kiểm tra CÓ CHỮ KÝ vào webhookUrl rồi trả accountName/accountNumber; ingest ≠200 -> lỗi', async () => {
    expect((await post('/_fake/payos/confirm-webhook', { webhookUrl: recvUrl }, { 'x-client-id': 'cid', 'x-api-key': 'wrong' })).status).toBe(401);
    const ok = await post('/_fake/payos/confirm-webhook', { webhookUrl: recvUrl }, { 'x-client-id': 'cid', 'x-api-key': 'akey' });
    expect(await ok.json()).toMatchObject({ code: '00', data: { webhookUrl: recvUrl, accountName: 'CAFE TEST', accountNumber: '0001234' } });
    const test = got.at(-1);
    const s = Object.keys(test.data).sort().map((k) => `${k}=${test.data[k] ?? ''}`).join('&');
    expect(test.signature).toBe(crypto.createHmac('sha256', 'ck').update(s).digest('hex'));
    recvStatus = 401;
    const bad = await post('/_fake/payos/confirm-webhook', { webhookUrl: recvUrl }, { 'x-client-id': 'cid', 'x-api-key': 'akey' });
    expect(bad.status).toBe(400);
    recvStatus = 200;
    const logged = await (await fetch(`${base}/_requests?path=/_fake/payos/confirm-webhook`)).json();
    expect(logged.at(-1).headers['x-client-id']).toBe('cid');
  });

  it('Stripe webhook_endpoints: tạo -> {id we_test…, secret whsec_test…}; GET; DELETE -> deleted; key sai -> 401', async () => {
    const h = { authorization: 'Bearer rk_test_abc', 'content-type': 'application/x-www-form-urlencoded' };
    const c = await fetch(`${base}/_fake/stripe/v1/webhook_endpoints`, { method: 'POST', headers: h, body: 'url=https%3A%2F%2Fhub.example.com%2Fhooks%2Fstripe%2Fk&enabled_events[]=payment_intent.succeeded' });
    const ep = await c.json();
    expect(ep).toMatchObject({ id: expect.stringMatching(/^we_test/), secret: expect.stringMatching(/^whsec_test/), url: 'https://hub.example.com/hooks/stripe/k', enabled_events: ['payment_intent.succeeded'] });
    expect(await (await fetch(`${base}/_fake/stripe/v1/webhook_endpoints/${ep.id}`, { headers: h })).json()).toMatchObject({ id: ep.id, url: ep.url });
    expect(await (await fetch(`${base}/_fake/stripe/v1/webhook_endpoints/${ep.id}`, { method: 'DELETE', headers: h })).json()).toMatchObject({ deleted: true });
    expect((await fetch(`${base}/_fake/stripe/v1/webhook_endpoints/${ep.id}`, { headers: h })).status).toBe(404);
    expect((await fetch(`${base}/_fake/stripe/v1/webhook_endpoints`, { method: 'POST', headers: { ...h, authorization: 'Bearer sk_live_x' }, body: '' })).status).toBe(401);
  });
});
