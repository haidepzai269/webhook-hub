/**
 * Cửa báo lỗi cho mã giao diện (global-error, error boundary, ...). Không import SDK tĩnh: không DSN thì
 * `process.env.NEXT_PUBLIC_SENTRY_DSN` là hằng rỗng lúc build -> nhánh chết, `import()` không tạo chunk -> no-op, 0 byte SDK.
 */
export function reportClientError(err: unknown): void {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  void import("./init.client").then((m) => m.captureClientError(err)).catch(() => undefined);
}
