/**
 * MS-P2-6 (ADR-093): KHÔNG BAO GIỜ trả `Access-Control-Allow-Origin: *` cùng `Allow-Credentials: true` (trình duyệt từ
 * chối, và nếu đổi sang phản chiếu origin thì mọi site gọi được kèm cookie). Dashboard gửi JWT bằng header Bearer —
 * không cần credentials. Có `WEB_PUBLIC_URL` / `CORS_ORIGINS` (cách nhau dấu phẩy) -> chỉ các origin đó, cho credentials.
 */
export function corsOptions(env: Record<string, string | undefined> = process.env) {
  const origins = [env.WEB_PUBLIC_URL, ...(env.CORS_ORIGINS ?? '').split(',')]
    .map((o) => (o ?? '').trim().replace(/\/$/, ''))
    .filter(Boolean);
  const methods = 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS';
  // LOGGING.md §11.9c/d: trình duyệt cross-origin chỉ đọc được header đã khai ở đây. `x-request-id` để console gắn vào lỗi;
  // `x-hub-cold` để nhận ra cold start Render. KHÔNG mở rộng origin / credentials.
  const exposedHeaders = ['x-request-id', 'x-hub-cold'];
  return origins.length > 0
    ? { origin: [...new Set(origins)], credentials: true, methods, exposedHeaders }
    : { origin: '*', credentials: false, methods, exposedHeaders };
}
