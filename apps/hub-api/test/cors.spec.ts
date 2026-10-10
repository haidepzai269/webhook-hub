import { corsOptions } from '../src/cors';

/** MS-P2-6: không bao giờ `Access-Control-Allow-Origin: *` cùng `Allow-Credentials: true`. */
describe('CORS (MS-P2-6)', () => {
  it('MS-P2-6: không cấu hình -> origin *, KHÔNG credentials (dashboard dùng Bearer, không cookie)', () => {
    expect(corsOptions({})).toMatchObject({ origin: '*', credentials: false });
  });
  it('MS-P2-6: WEB_PUBLIC_URL / CORS_ORIGINS -> danh sách origin cụ thể, credentials được phép', () => {
    expect(corsOptions({ WEB_PUBLIC_URL: 'https://hub.example.com/', CORS_ORIGINS: 'http://localhost:3000, https://shop.example.com' })).toMatchObject({
      origin: ['https://hub.example.com', 'http://localhost:3000', 'https://shop.example.com'],
      credentials: true,
    });
  });
});
