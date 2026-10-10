import { type NextRequest, NextResponse } from "next/server";

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,39}(%[0-9a-zA-Z]+)?$/;
const looksLikeIp = (s: string) => IPV4.test(s) || (s.includes(":") && IPV6.test(s));

/**
 * R-2 (ADR-110) + N-4 (ADR-123): `/api/*` và `/auth/*` được `rewrites` chuyển sang hub-api. Không có file này thì hub-api
 * thấy MỌI người dùng mang cùng một IP (IP của web / egress Vercel) → rate limit theo IP thành giới hạn chung.
 * - IP client: `x-real-ip`, không có thì phần tử ĐẦU của `x-forwarded-for`. Trên Vercel hai header này do Vercel GHI ĐÈ;
 *   chạy local/tự host (không có proxy đứng trước web) thì client tự đặt được — giới hạn theo EMAIL vẫn là lớp chính.
 * - Header gửi sang hub-api được VIẾT LẠI: `x-forwarded-for` = đúng một IP đã chọn (chuỗi client gửi không đi tiếp),
 *   `x-real-ip` và mọi `x-hub-*` client gửi bị xoá; gắn `x-hub-client-ip` + `x-hub-proxy-secret` (WEB_PROXY_SECRET, đọc
 *   lúc CHẠY, Node runtime). hub-api tin `x-hub-client-ip` chỉ khi secret khớp, và khi đó KHÔNG đọc XFF nữa.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const candidate = (request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  const ip = looksLikeIp(candidate) ? candidate : null;
  for (const h of ["x-hub-client-ip", "x-hub-proxy-secret", "x-real-ip", "x-forwarded-for"]) headers.delete(h);
  if (ip) headers.set("x-forwarded-for", ip);
  const secret = process.env.WEB_PROXY_SECRET;
  if (secret && ip) {
    headers.set("x-hub-client-ip", ip);
    headers.set("x-hub-proxy-secret", secret);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/api/:path*", "/auth/:path*"],
};
