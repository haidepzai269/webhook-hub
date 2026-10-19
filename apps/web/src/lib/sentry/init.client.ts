import * as Sentry from "@sentry/nextjs";

import { createGate, eventFingerprintKey } from "./gate";
import { PRIVACY_OPTIONS, type WebSentryConfig, type WebSentryEnv, readWebSentryConfig } from "./config";
import { scrubBreadcrumb, scrubWebEvent } from "./scrub";

/**
 * LOGGING.md §11.9 (ADR-264) — NƠI DUY NHẤT trong apps/web import `@sentry/nextjs` và gọi `captureException`
 * (test `single-door.spec.ts` khoá). Chỉ được nạp bằng `import()` có điều kiện (instrumentation-client.ts, report.ts) khi
 * có `NEXT_PUBLIC_SENTRY_DSN` -> không DSN thì SDK không vào bundle.
 *
 * Session Replay TẮT (không `replayIntegration`, không `replaysSessionSampleRate`); không `tunnelRoute`; `PRIVACY_OPTIONS` (thay `sendDefaultPii:false` đã bị SDK 11 bỏ).
 */
let started = false;

/** Đọc env NGUYÊN VĂN để Next inline `NEXT_PUBLIC_*` vào bundle. */
export function envFromBuild(): WebSentryEnv {
  return {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  };
}

export function initSentryClient(cfg: WebSentryConfig | null = readWebSentryConfig(envFromBuild()), opts: { transport?: any } = {}): boolean {
  if (started) return true;
  if (!cfg) return false;
  const gate = createGate({ maxPerMin: 10, dedupeMs: 300_000 });
  try {
    Sentry.init({
      dsn: cfg.dsn,
      environment: cfg.environment,
      release: cfg.release,
      ...PRIVACY_OPTIONS,
      maxBreadcrumbs: 20,
      maxValueLength: 300,
      sendClientReports: false,
      tracesSampleRate: cfg.tracesSampleRate,
      // Chỉ đính sentry-trace/baggage vào lời gọi API cùng origin (proxy /api, /auth) — không gửi ra bên thứ ba.
      tracePropagationTargets: [/^\/api\//, /^\/auth\//],
      integrations: (defaults) => [
        ...defaults.filter((i) => i.name !== "HttpContext" && i.name !== "Breadcrumbs"),
        // Chỉ breadcrumb điều hướng: không console/fetch/xhr/dom (có thể mang payload).
        Sentry.breadcrumbsIntegration({ fetch: false, xhr: false, dom: false, history: true, sentry: false }),
      ],
      beforeBreadcrumb: (b) => scrubBreadcrumb(b),
      beforeSend: (event, hint) => {
        const clean = scrubWebEvent(event, hint?.originalException);
        return clean && gate.allow(eventFingerprintKey(clean)) ? clean : null;
      },
      beforeSendTransaction: (event) => scrubWebEvent(event),
      ...(opts.transport ? { transport: opts.transport } : {}),
    });
    started = true;
    return true;
  } catch {
    return false;
  }
}

/** Một cửa: mọi nơi khác gọi `reportClientError` (report.ts) -> hàm này. Không bao giờ ném. */
export function captureClientError(err: unknown): void {
  try {
    initSentryClient();
    Sentry.captureException(err);
  } catch {
    /* Sentry hỏng không được làm hỏng trang */
  }
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
