/**
 * SPEC-auth §4 + §9 (AU1): web PROXY `/api/*` và `/auth/*` sang hub-api để cookie phiên là cookie first-party của
 * chính domain web (web ở Vercel, API ở Render là KHÁC site — cookie bên thứ ba bị Safari ITP / Chrome chặn).
 * KHÔNG proxy `/hooks/*` và `/v1/p/*`: provider và service gọi thẳng API.
 * `HUB_API_INTERNAL_URL` được đọc LÚC BUILD (Next tính rewrites khi build) — compose truyền build arg; Vercel đặt env.
 */
const hubApi = (process.env.HUB_API_INTERNAL_URL || process.env.NEXT_PUBLIC_HUB_API_URL || "http://localhost:4000").replace(/\/$/, "");

/**
 * Sentry web (LOGGING.md §11.9, ADR-264). `NEXT_PUBLIC_SENTRY_DSN` trống = KHÔNG bọc `withSentryConfig`, không nạp SDK lúc build.
 * Release: SENTRY_RELEASE, rồi VERCEL_GIT_COMMIT_SHA. Environment: SENTRY_ENVIRONMENT, rồi 'deployed' trên Vercel, ngược lại 'local'.
 */
const sentryDsn = (process.env.NEXT_PUBLIC_SENTRY_DSN || "").trim();
const sentryAuthToken = (process.env.SENTRY_AUTH_TOKEN || "").trim();
const sentryRelease = (process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || "").trim();
const sentryEnvironment = (process.env.SENTRY_ENVIRONMENT || (process.env.VERCEL ? "deployed" : "local")).trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Chỉ inline giá trị không bí mật vào bundle trình duyệt (DSN trình duyệt vốn public; token upload KHÔNG nằm ở đây).
  // DSN PHẢI có mặt ở đây (kể cả rỗng): Next chỉ inline biến đã định nghĩa; biến vắng thì `process.env.X` còn nguyên lúc chạy
  // và nhánh `if (process.env.NEXT_PUBLIC_SENTRY_DSN)` KHÔNG bị loại -> SDK lọt vào bundle (đo ở lần build đầu: ~255 KB / ~80 KB gzip).
  env: {
    NEXT_PUBLIC_SENTRY_DSN: sentryDsn,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: sentryEnvironment,
    NEXT_PUBLIC_SENTRY_RELEASE: sentryRelease,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE_WEB || "",
  },
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

async function withOptionalSentry(config) {
  if (!sentryDsn) return config;
  const { withSentryConfig } = (await import("@sentry/nextjs/config")).default ?? (await import("@sentry/nextjs/config"));
  return withSentryConfig(config, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT_WEB || process.env.SENTRY_PROJECT,
    authToken: sentryAuthToken || undefined,
    release: sentryRelease ? { name: sentryRelease } : undefined,
    silent: true,
    telemetry: false,
    // Không token -> không upload và KHÔNG sinh source map; có token -> upload rồi XOÁ khỏi build (không lộ công khai).
    sourcemaps: { disable: !sentryAuthToken, deleteSourcemapsAfterUpload: true },
  });
}

export default withOptionalSentry(nextConfig);
