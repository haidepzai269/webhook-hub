jest.mock('@hub/crypto', () => ({
  ...jest.requireActual('@hub/crypto'),
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
}));

import * as http from 'http';
import { AddressInfo } from 'net';
import { toWebhookBody } from '../src/webhook-body';
import { WebhookSender } from '../../../apps/hub-worker/src/senders/webhook.sender';
import { forwardEvent } from '../../hub-sdk/src/cli';

/**
 * UX9 (SPEC-dev-experience §4.3 luật Parity): cùng MỘT dòng `events` đi hai đường — push thật (`WebhookSender`, event
 * dựng từ DB như delivery.consumer) và `hub listen` (event nhận qua JSON của polling) — body phải bằng nhau từng byte.
 */
describe('[DX:UX9] toWebhookBody — WebhookSender và hub listen gửi body byte-identical', () => {
  let server: http.Server;
  let base = '';
  const raws: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        raws.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // Một dòng hub.events như Postgres trả (Date, subject null, data jsonb có tiếng Việt + số lớn).
  const row = {
    id: 'evt_01JABCDEF',
    tenantId: 't1',
    type: 'payment.received',
    source: 'sepay',
    sourceId: '9b5c0000-0000-4000-8000-000000000001',
    subject: null as string | null,
    data: { amount: 50000, currency: 'VND', memo: 'DH12 thanh toán “ngay”', raw: { id: 92704, big: 12345678901234 } },
    normalized: true,
    occurredAt: new Date('2026-10-10T07:02:37.000Z'),
    receivedAt: new Date('2026-10-10T07:02:38.120Z'),
    correlationId: 'c1',
  };

  it.each([
    ['subject null', null],
    ['subject có giá trị', 'payment:92704'],
  ])('%s', async (_n, subject) => {
    const r = { ...row, subject };
    // Đường 1 — worker: delivery.consumer.toNormalizedEvent (subject null -> undefined, Date -> ISO).
    const normalized = {
      id: r.id, tenantId: r.tenantId, type: r.type, source: r.source, sourceId: r.sourceId ?? '', subject: r.subject ?? undefined,
      data: r.data, occurredAt: r.occurredAt.toISOString(), receivedAt: r.receivedAt.toISOString(), correlationId: r.correlationId,
      origin: 'provider', normalized: r.normalized !== false,
    } as any;
    await new WebhookSender().send({ url: `${base}/hook` }, '', normalized, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');
    // Đường 2 — listen: event đi qua JSON của GET /v1/p/:project/events (cursor, correlationId, subject null giữ nguyên).
    const polled = JSON.parse(JSON.stringify({ ...r, cursor: '17' }));
    const out = await forwardEvent(`${base}/hook`, polled, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');
    expect(out.status).toBe(200);
    const [a, b] = raws.slice(-2);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    expect(a).toBe(toWebhookBody(polled));
  });

  it('renderedContent rỗng bị bỏ; có giá trị thì nằm cuối body', () => {
    expect(toWebhookBody({ ...row }, '')).not.toContain('renderedContent');
    expect(toWebhookBody({ ...row }, 'Nhận 50000')).toMatch(/,"renderedContent":"Nhận 50000"}$/);
  });
});
