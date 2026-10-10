/**
 * SPEC-auth §4 + §9 (AU1): web PROXY `/api/*` và `/auth/*` sang hub-api để cookie phiên là cookie first-party của
 * chính domain web (web ở Vercel, API ở Render là KHÁC site — cookie bên thứ ba bị Safari ITP / Chrome chặn).
 * KHÔNG proxy `/hooks/*` và `/v1/p/*`: provider và service gọi thẳng API.
 * `HUB_API_INTERNAL_URL` được đọc LÚC BUILD (Next tính rewrites khi build) — compose truyền build arg; Vercel đặt env.
 */
const hubApi = (process.env.HUB_API_INTERNAL_URL || process.env.NEXT_PUBLIC_HUB_API_URL || "http://localhost:4000").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${hubApi}/api/:path*` },
      { source: "/auth/:path*", destination: `${hubApi}/auth/:path*` },
    ];
  },
  async headers() {
    // Trang nhận token qua URL (AU2/AU4): không để token rò qua Referer.
    return ["/verify-email", "/reset-password", "/invite"].map((source) => ({
      source,
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    }));
  },
};

export default nextConfig;
