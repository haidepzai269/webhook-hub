jest.mock('@hub/crypto', () => ({
  ...jest.requireActual('@hub/crypto'),
  // Server cục bộ 127.0.0.1: bỏ qua SSRF guard (đã có test riêng), giữ nguyên đường axios THẬT.
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
}));

import * as http from 'http';
import { AddressInfo } from 'net';
import { WebhookSender } from '../src/senders/webhook.sender';
import { TelegramSender } from '../src/senders/telegram.sender';
import { DiscordSender } from '../src/senders/discord.sender';
import { RESPONSE_READ_MAX_BYTES, readCapped } from '../src/senders/http-limits';
import { Readable } from 'stream';

/**
 * Review SPEC-2 #5 (hồi quy từ ADR-051, sửa ở ADR-054): maxContentLength 64KB từng biến 2xx body lớn
 * thành 500 -> retry -> GỬI TRÙNG. Server THẬT trả 2xx body 200KB -> sender phải báo 2xx.
 */
describe('Sender — phản hồi 2xx body lớn vẫn là thành công (server cục bộ thật)', () => {
  const BIG = 200 * 1024;
  let server: http.Server;
  let base = '';
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      req.resume();
      const status = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? 200);
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat(BIG));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const event = { id: 'e1', type: 't', source: 's', data: {} } as any;

  it.each([
    ['webhook', () => new WebhookSender().send({ url: `${base}/hook` }, 'c', event, 'secret')],
    ['telegram', () => new TelegramSender().send({ botToken: '1:mock', chatId: '-1', apiUrl: base }, 'c', event)],
    ['discord', () => new DiscordSender().send({ webhookUrl: `${base}/dc` }, 'c', event)],
  ])('%s: 200 + body 200KB -> status 200, không error, body cắt ≤ 2KB', async (_n, run) => {
    const before = hits;
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.error).toBeUndefined();
    expect(res.body.length).toBeLessThanOrEqual(2048);
    expect(hits).toBe(before + 1); // đúng MỘT request — không có lần gửi lại
  });

  it('500 + body 200KB -> status 500 thật (không phải lỗi giả do kích thước)', async () => {
    const res = await new WebhookSender().send({ url: `${base}/hook?status=500` }, 'c', event);
    expect(res.status).toBe(500);
    expect(res.error).toBe('Request failed with status code 500');
  });

  it('readCapped: chỉ giữ tối đa 64KB rồi huỷ stream', async () => {
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(8 * 1024, 97)); // 400KB
    const stream = Readable.from(chunks);
    const out = await readCapped(stream);
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBe(RESPONSE_READ_MAX_BYTES);
    expect(stream.destroyed).toBe(true);
  });
});
