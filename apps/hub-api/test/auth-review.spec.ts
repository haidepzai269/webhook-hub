import { reqCtx } from '../src/modules/auth/auth.controller';
import { clientIp, proxySecretValid } from '../src/modules/auth/client-ip';

/** Sửa theo REVIEW-AUTH-2026-10-11 (mã AR:R-n). */
describe('R-2 — IP client qua proxy web (ADR-110)', () => {
  const SECRET = 'VERIFY_ONLY_web_proxy_secret_32_chars_min_xx';
  const WEB_IP = '172.18.0.9'; // IP socket = container web
  const viaWeb = (client: string, secret = SECRET) =>
    ({ ip: WEB_IP, headers: { 'x-hub-client-ip': client, 'x-hub-proxy-secret': secret } }) as any;

  const prev = process.env.WEB_PROXY_SECRET;
  beforeEach(() => (process.env.WEB_PROXY_SECRET = SECRET));
  afterAll(() => (prev === undefined ? delete process.env.WEB_PROXY_SECRET : (process.env.WEB_PROXY_SECRET = prev)));

  it('[AR:R-2] (phần a) hai client đi qua proxy web (secret đúng) -> reqCtx ra HAI IP khác nhau, không phải IP của web', () => {
    const a = reqCtx(viaWeb('203.0.113.7'));
    const b = reqCtx(viaWeb('198.51.100.20'));
    expect(a.ip).toBe('203.0.113.7');
    expect(b.ip).toBe('198.51.100.20');
  });

  it('[AR:R-2] (phần b) secret sai / thiếu / server chưa đặt secret / IP rác -> bỏ qua header, dùng IP socket', () => {
    expect(reqCtx(viaWeb('203.0.113.7', 'sai-secret')).ip).toBe(WEB_IP);
    expect(reqCtx({ ip: WEB_IP, headers: { 'x-hub-client-ip': '203.0.113.7' } } as any).ip).toBe(WEB_IP);
    delete process.env.WEB_PROXY_SECRET;
    expect(reqCtx(viaWeb('203.0.113.7')).ip).toBe(WEB_IP);
    process.env.WEB_PROXY_SECRET = SECRET;
    expect(clientIp(viaWeb('203.0.113.7'), '')).toBe(WEB_IP);
    expect(reqCtx(viaWeb('not-an-ip, 1.2.3.4')).ip).toBe(WEB_IP);
    expect(proxySecretValid(['a', 'b'], SECRET)).toBe(false);
    expect(proxySecretValid(SECRET + 'x', SECRET)).toBe(false);
  });
});
