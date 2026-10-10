import * as http from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';
import { createSsrfSafeAxiosConfig } from '../src';

/**
 * S1-7 / BB09 P0-2: test cũ chỉ đi qua `http.get`. Lỗi `{ all: true }` (Node ≥ 20 autoSelectFamily)
 * chỉ lộ ra khi đi qua axios — đúng đường sender thật dùng. Test này gửi THẬT qua TCP tới server cục bộ.
 */
describe('SSRF guard đi qua axios thật (S1-7)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('[AF:#3] createSsrfSafeAxiosConfig(url, true) + axios.post tới server cục bộ -> 200, Host giữ hostname gốc', async () => {
    const url = `http://localhost:${port}/hook`;
    const cfg = await createSsrfSafeAxiosConfig(url, true);
    const res = await axios.post(cfg.url, { a: 1 }, { httpAgent: cfg.httpAgent, httpsAgent: cfg.httpsAgent, timeout: 3000, maxRedirects: 0 });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true, host: `localhost:${port}` });
  });

  it('không cho phép dải riêng (allowPrivate=false, ngoài development) -> chặn trước khi gửi', async () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    try {
      await expect(createSsrfSafeAxiosConfig(`http://127.0.0.1:${port}/hook`)).rejects.toThrow(/SSRF Guard/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
  });
});
