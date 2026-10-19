/**
 * Đọc cấu hình Sentry web từ env (ADR-264). `NEXT_PUBLIC_*` phải được tham chiếu NGUYÊN VĂN `process.env.NEXT_PUBLIC_X` ở nơi
 * gọi (Next chỉ inline dạng đó) — nên hàm này nhận object thường, không đọc `process.env` trực tiếp.
 * Không DSN -> `null` -> không init, không nạp SDK.
 */
export interface WebSentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate: number;
}

export interface WebSentryEnv {
  NEXT_PUBLIC_SENTRY_DSN?: string;
  NEXT_PUBLIC_SENTRY_ENVIRONMENT?: string;
  NEXT_PUBLIC_SENTRY_RELEASE?: string;
  NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE?: string;
}

/** Mặc định web vitals: 0.1 khi deployed, 0 ở local (LOGGING.md §11.9c). */
export const DEFAULT_TRACES_SAMPLE_RATE_DEPLOYED = 0.1;

export function readWebSentryConfig(env: WebSentryEnv): WebSentryConfig | null {
  const dsn = (env.NEXT_PUBLIC_SENTRY_DSN ?? "").trim();
  if (!dsn) return null;
  const environment = (env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "").trim() || "local";
  const raw = (env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "").trim();
  const n = Number(raw);
  const tracesSampleRate = raw !== "" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : environment === "local" ? 0 : DEFAULT_TRACES_SAMPLE_RATE_DEPLOYED;
  return { dsn, environment, release: (env.NEXT_PUBLIC_SENTRY_RELEASE ?? "").trim() || undefined, tracesSampleRate };
}

/**
 * Quyền riêng tư của SDK. `@sentry/*` 11.x đã bỏ `sendDefaultPii` (không còn trong kiểu lẫn mã) — tương đương là
 * `dataCollection`: tắt IP/user, cookie, header, body, query. Test khoá để nâng SDK không âm thầm bật lại.
 */
export const PRIVACY_OPTIONS = {
  dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [] as never[], urlQueryParams: false },
} as const;
