import { type NextRequest, NextResponse } from "next/server";

/**
 * R-2 (review AU, ADR-110): `/api/*` và `/auth/*` được `rewrites` chuyển sang hub-api. Không có file này thì hub-api
 * thấy MỌI người dùng mang cùng một IP (IP của web / egress Vercel) → rate limit theo IP thành giới hạn chung.
 * Ở đây gắn IP thật của client vào `x-hub-client-ip` kèm `x-hub-proxy-secret` = WEB_PROXY_SECRET (đọc lúc CHẠY,
 * Node runtime). hub-api chỉ tin header khi secret khớp (timingSafeEqual).
 * IP client: `x-real-ip` / phần tử đầu `x-forwarded-for` — Vercel GHI ĐÈ hai header này nên không giả được;
 * local không có proxy phía trước nên client tự đặt được (chấp nhận, ghi ở ADR-110: khoá theo email vẫn là lớp chính).
 * Header `x-hub-*` do client tự gửi luôn bị xoá.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("x-hub-client-ip");
  headers.delete("x-hub-proxy-secret");
  const secret = process.env.WEB_PROXY_SECRET;
  const ip = request.headers.get("x-real-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (secret && ip) {
    headers.set("x-hub-client-ip", ip);
    headers.set("x-hub-proxy-secret", secret);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/api/:path*", "/auth/:path*"],
};
