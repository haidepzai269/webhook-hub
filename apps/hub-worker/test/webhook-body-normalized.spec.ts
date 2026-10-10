jest.mock('@hub/crypto', () => ({
  ...jest.requireActual('@hub/crypto'),
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
}));

import * as http from 'http';
import { AddressInfo } from 'net';
import { swVerify } from '@hub/crypto';
import { WebhookSender } from '../src/senders/webhook.sender';

/** S3-2 (ADR-053/059): body gửi tới đích webhook mang cờ `normalized` (thiếu trên event cũ = true). */
describe('WebhookSender — body có `normalized`', () => {
  let server: http.Server;
  let base = '';
  const bodies: any[] = [];
  const reqs: { headers: http.IncomingHttpHeaders; raw: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        bodies.push(JSON.parse(s));
        reqs.push({ headers: req.headers, raw: s });
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it.each([
    [true, true],
    [false, false],
    [undefined, true],
  ])('event.normalized=%s -> body.normalized=%s', async (flag, expected) => {
    const event = { id: 'e1', type: 'payment.received', source: 'sepay', data: { amount: 1 }, normalized: flag } as any;
    const res = await new WebhookSender().send({ url: `${base}/hook` }, '', event, 'secret');
    expect(res.status).toBe(200);
    const body = bodies[bodies.length - 1];
    expect(body.normalized).toBe(expected);
  });

  it('S6 (ADR-040): header Standard Webhooks webhook-id = event.id, chữ ký verify được bằng secret; KHÔNG còn x-hub-*', async () => {
    const event = { id: 'evt_abc', type: 'order.created', source: 'api', data: {} } as any;
    for (let i = 0; i < 2; i++) await new WebhookSender().send({ url: `${base}/hook` }, '', event, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');
    const [a, b] = reqs.slice(-2);
    expect(a.headers['webhook-id']).toBe('evt_abc');
    expect(b.headers['webhook-id']).toBe('evt_abc'); // retry/replay giữ nguyên id
    expect(a.headers['webhook-signature']).toMatch(/^v1,/);
    expect(swVerify('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', a.headers as any, a.raw)).toBe(true);
    expect(Object.keys(a.headers).filter((h) => h.startsWith('x-hub-'))).toEqual([]);
  });

  it('S6: đích không có signingSecret -> vẫn gửi webhook-id/timestamp, không có webhook-signature', async () => {
    await new WebhookSender().send({ url: `${base}/hook` }, '', { id: 'evt_x', type: 't.a', source: 's', data: {} } as any);
    const last = reqs[reqs.length - 1];
    expect(last.headers['webhook-id']).toBe('evt_x');
    expect(last.headers['webhook-timestamp']).toMatch(/^\d+$/);
    expect(last.headers['webhook-signature']).toBeUndefined();
  });
});

