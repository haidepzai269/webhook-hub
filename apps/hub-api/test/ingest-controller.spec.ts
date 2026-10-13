import { RawWebhookRequest } from '@hub/common';
import { IngestController } from '../src/modules/ingest/ingest.controller';

/**
 * PK0 / E1 + E6 ở tầng controller (L0, không HTTP) — review PK0 TB-2, T-1. Qua HTTP thật, `fetch` luôn gửi
 * `Content-Length: 0` nên body-parser vẫn gán `rawBody = Buffer(0)` (truthy) và fallback `JSON.stringify` cũ không bao
 * giờ chạy. Request KHÔNG có header body (GET bắt tay của PK4) thì không parser nào chạy -> `req.rawBody` undefined:
 * controller phải ra Buffer rỗng, không phải `"{}"` dựng lại từ `req.body`.
 */
describe('[PK:T33] (phần b) IngestController — không có rawBody thì Buffer rỗng, query tách như router', () => {
  function call(req: Record<string, unknown>) {
    const seen: RawWebhookRequest[] = [];
    const svc = { ingestWebhook: jest.fn(async (r: RawWebhookRequest) => (seen.push(r), { status: 200, body: { ok: true } })) };
    const res: any = { set: jest.fn(), status: jest.fn(() => res), json: jest.fn(() => res) };
    const ctl = new IngestController(svc as any);
    const full = { method: 'POST', headers: {}, ip: '203.0.113.1', ...req };
    return ctl.handleWebhook('generic', 'src_k', full as any, res, {}).then(() => seen[0]);
  }

  it('req không có rawBody (không parser nào chạy) -> rawBody là Buffer rỗng, kể cả khi req.body có giá trị', async () => {
    for (const body of [undefined, {}, { a: 1 }]) {
      const r = await call({ url: '/hooks/generic/src_k', originalUrl: '/hooks/generic/src_k', body });
      expect(Buffer.isBuffer(r.rawBody)).toBe(true);
      expect(r.rawBody.length).toBe(0); // không phải "{}" / '{"a":1}'
    }
  });

  it('rawBody có thì giữ nguyên; body là Buffer (parser raw) -> adapter thấy undefined', async () => {
    const raw = Buffer.from('<x/>');
    const r = await call({ url: '/hooks/generic/src_k', originalUrl: '/hooks/generic/src_k', rawBody: raw, body: raw });
    expect(r.rawBody).toBe(raw);
    expect(r.body).toBeUndefined();
  });

  it('T-1: query tách bằng parseurl như router — `#frag` không lọt vào query; method viết hoa', async () => {
    const cases: [string, string][] = [
      ['/hooks/generic/src_k?a=1&b=%20x', 'a=1&b=%20x'],
      ['/hooks/generic/src_k?a=1#b', 'a=1'],
      ['/hooks/generic/src_k#x?tok=1', ''],
      ['/hooks/generic/src_k', ''],
      ['http://h.example/hooks/generic/src_k?z=1', 'z=1'],
    ];
    for (const [url, q] of cases) {
      const r = await call({ url, originalUrl: url, method: 'get' });
      expect([url, r.query, r.method]).toEqual([url, q, 'GET']);
    }
  });
});
