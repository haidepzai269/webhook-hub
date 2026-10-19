import { resetColdStartForTest } from '@hub/common';
import { COLD_HEADER, coldStartMiddleware } from '../src/cold-start';
import { corsOptions } from '../src/cors';

/** Admin chốt 2026-10-18: header `x-hub-cold` cho phản hồi ĐẦU TIÊN sau khi tiến trình khởi động (không Redis/DB). */
describe('x-hub-cold + exposedHeaders (LOGGING.md §3.2, §11.9)', () => {
  const run = (url: string, method = 'GET') => {
    const headers: Record<string, string> = {};
    const req: any = { originalUrl: url, url, method };
    const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; } };
    const next = jest.fn();
    coldStartMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    return { headers, req };
  };

  beforeEach(() => resetColdStartForTest());
  afterAll(() => resetColdStartForTest());

  it('request thật đầu tiên (tiến trình trẻ) mang x-hub-cold: 1 và đặt cờ cho ingest; request sau thì không', () => {
    const first = run('/hooks/github/src_x', 'POST');
    expect(first.headers[COLD_HEADER]).toBe('1');
    expect(first.req.hubCold).toBe(true);
    const second = run('/hooks/github/src_x', 'POST');
    expect(second.headers[COLD_HEADER]).toBeUndefined();
    expect(second.req.hubCold).toBeUndefined();
  });

  it('health/metrics/preflight không tiêu tốn cờ (Render và monitoring gọi trước người dùng)', () => {
    for (const [u, m] of [['/health', 'GET'], ['/health/ready', 'GET'], ['/metrics', 'GET'], ['/api/v1/me', 'OPTIONS']] as const) {
      expect(run(u, m).headers[COLD_HEADER]).toBeUndefined();
    }
    expect(run('/api/v1/me').headers[COLD_HEADER]).toBe('1');
  });

  it('CORS lộ x-request-id và x-hub-cold, KHÔNG mở rộng origin/credentials', () => {
    expect(corsOptions({})).toMatchObject({ origin: '*', credentials: false, exposedHeaders: ['x-request-id', 'x-hub-cold'] });
    const o = corsOptions({ WEB_PUBLIC_URL: 'https://hub.example.com' });
    expect(o).toMatchObject({ origin: ['https://hub.example.com'], credentials: true, exposedHeaders: ['x-request-id', 'x-hub-cold'] });
  });
});
