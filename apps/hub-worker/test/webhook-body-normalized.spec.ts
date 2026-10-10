jest.mock('@hub/crypto', () => ({
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
  hmacSha256: jest.fn(() => 'sig'),
}));

import * as http from 'http';
import { AddressInfo } from 'net';
import { WebhookSender } from '../src/senders/webhook.sender';

/** S3-2 (ADR-053/059): body gửi tới đích webhook mang cờ `normalized` (thiếu trên event cũ = true). */
describe('WebhookSender — body có `normalized`', () => {
  let server: http.Server;
  let base = '';
  const bodies: any[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        bodies.push(JSON.parse(s));
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
});
