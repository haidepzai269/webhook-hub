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
  return origins.length > 0 ? { origin: [...new Set(origins)], credentials: true, methods } : { origin: '*', credentials: false, methods };
}
