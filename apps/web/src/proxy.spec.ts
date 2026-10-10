import { NextRequest } from 'next/server';
import { proxy } from './proxy';

/** N-4 (review AU vòng 2, ADR-123): proxy web viết lại header IP trước khi chuyển sang hub-api. */
describe('proxy.ts — IP client gửi sang hub-api', () => {
  const prev = process.env.WEB_PROXY_SECRET;
  beforeAll(() => (process.env.WEB_PROXY_SECRET = 'S'.repeat(40)));
  afterAll(() => (prev === undefined ? delete process.env.WEB_PROXY_SECRET : (process.env.WEB_PROXY_SECRET = prev)));
  const forwarded = (h: Record<string, string>) => {
    const res = proxy(new NextRequest('http://web.test/auth/login', { method: 'POST', headers: h }));
    const out = new Map<string, string>();
    // NextResponse.next({request:{headers}}) ghi header "x-middleware-request-<tên>" cho tầng rewrite
    res.headers.forEach((v, k) => {
      if (k.startsWith('x-middleware-request-')) out.set(k.slice('x-middleware-request-'.length), v);
    });
    return out;
  };

  it('[AR:N-4] (phần a) XFF/x-real-ip/x-hub-* do client gửi KHÔNG tới hub-api nguyên vẹn: XFF bị ghi đè bằng ĐÚNG một IP đã chọn, x-real-ip bị xoá, x-hub-* giả bị thay', () => {
    const h = forwarded({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-real-ip': '203.0.113.7', 'x-hub-client-ip': '1.2.3.4', 'x-hub-proxy-secret': 'gia' });
    expect(h.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(h.has('x-real-ip')).toBe(false);
    expect(h.get('x-hub-client-ip')).toBe('203.0.113.7');
    expect(h.get('x-hub-proxy-secret')).toBe('S'.repeat(40));
  });

  it('[AR:N-4] (phần b) IP rác -> không gửi x-hub-client-ip, XFF bị xoá', () => {
    const h = forwarded({ 'x-forwarded-for': 'khong-phai-ip' });
    expect(h.has('x-hub-client-ip')).toBe(false);
    expect(h.has('x-forwarded-for')).toBe(false);
  });
});
