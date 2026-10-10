/**
 * Kiểm chống DNS rebinding cho createSsrfSafeAxiosConfig() (ARCHITECTURE.md §7.3).
 *
 * Kịch bản rebinding: domain trả IP public hợp lệ lúc validateAndPinUrl() kiểm,
 * nhưng nếu code KHÔNG pin IP mà để axios/Node tự resolve DNS lại lúc connect
 * thật, domain (đã "rebind") có thể trả về IP nội bộ/metadata lúc đó.
 * createSsrfSafeAxiosConfig() phải trả về một agent dùng thẳng IP đã kiểm ở
 * bước validate, không bao giờ gọi dns.lookup lần thứ hai.
 */

const lookupMock = jest.fn();

jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return {
    ...actual,
    lookup: (...args: any[]) => (lookupMock as any)(...args),
  };
});

import { createSsrfSafeAxiosConfig } from '../src';

function mockLookupOnce(address: string, family = 4) {
  lookupMock.mockImplementationOnce((_hostname: string, optionsOrCb: any, cb?: any) => {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    callback(null, { address, family });
  });
}

describe('SSRF Guard - chống DNS rebinding (pin IP)', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('pin đúng IP đã kiểm lúc validate; không resolve DNS lại lúc connect thật', async () => {
    // Lần kiểm đầu tiên (bên trong validateAndPinUrl): domain trả IP public hợp lệ
    mockLookupOnce('8.8.8.8');

    const config = await createSsrfSafeAxiosConfig('https://evil-rebind.example.com/webhook');
    expect(config.httpsAgent).toBeDefined();
    expect(lookupMock).toHaveBeenCalledTimes(1);

    // Giả lập rebinding: nếu có ai đó resolve DNS lại lúc "connect thật",
    // domain giờ trả IP nội bộ (AWS metadata) -> đây là điều PHẢI bị chặn.
    mockLookupOnce('169.254.169.254');

    // Lấy đúng hàm `lookup` mà httpsAgent sẽ dùng khi Node mở kết nối TCP thật
    const pinnedLookup = (config.httpsAgent as any).options.lookup as (...a: any[]) => void;

    const result: any = await new Promise((resolve, reject) => {
      pinnedLookup('evil-rebind.example.com', {}, (err: any, address: string, family: number) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });

    // Phải là IP đã pin từ lúc kiểm (8.8.8.8), KHÔNG phải IP "rebind" (169.254.169.254)
    expect(result).toEqual({ address: '8.8.8.8', family: 4 });
    // dns.lookup thật không được gọi thêm lần nào — lookup của agent không đụng DNS nữa
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('chặn ngay từ bước kiểm nếu domain resolve về IP nội bộ/riêng tư', async () => {
    mockLookupOnce('127.0.0.1');

    await expect(createSsrfSafeAxiosConfig('http://internal.example.com/hook')).rejects.toThrow(/SSRF Guard/);
  });

  it('chặn cả IPv6 nội bộ (dải fc00::/7, ::1)', async () => {
    mockLookupOnce('fc00::1', 6);

    await expect(createSsrfSafeAxiosConfig('http://internal-v6.example.com/hook')).rejects.toThrow(/SSRF Guard/);
  });

  it('lookup đã pin trả MẢNG khi Node gọi với { all: true } (autoSelectFamily, Node >= 20)', async () => {
    mockLookupOnce('8.8.8.8');
    const config = await createSsrfSafeAxiosConfig('https://public.example.com/hook');
    const pinnedLookup = (config.httpsAgent as any).options.lookup as (...a: any[]) => void;

    const addresses = await new Promise((resolve, reject) => {
      pinnedLookup('public.example.com', { all: true }, (err: any, addrs: unknown) => (err ? reject(err) : resolve(addrs)));
    });

    expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  it('kết nối TCP thật qua agent đã pin không còn lỗi "Invalid IP address"', async () => {
    const http = await import('http');
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    try {
      // Phải dùng HOSTNAME: URL là IP thì Node bỏ qua lookup và lỗi không lộ ra
      mockLookupOnce('127.0.0.1');
      const config = await createSsrfSafeAxiosConfig(`http://pinned.test:${port}/`, true);
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(config.url, { agent: config.httpAgent }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve(d));
          })
          .on('error', reject);
      });
      expect(body).toBe('ok');
    } finally {
      server.close();
    }
  });
});
