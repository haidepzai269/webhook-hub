/**
 * Next 16: chạy trước khi app tương tác. Sentry (ADR-264) chỉ được nạp khi có `NEXT_PUBLIC_SENTRY_DSN` (inline lúc build):
 * không DSN -> nhánh dưới là mã chết, SDK không vào bundle, không handler toàn cục nào được gắn.
 */
type SentryClient = typeof import("./lib/sentry/init.client");
let sentry: Promise<SentryClient | null> | null = null;

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  sentry = import("./lib/sentry/init.client")
    .then((m) => {
      m.initSentryClient();
      return m;
    })
    .catch(() => null);
}

export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse"): void {
  void sentry?.then((m) => m?.onRouterTransitionStart(url, navigationType));
}
