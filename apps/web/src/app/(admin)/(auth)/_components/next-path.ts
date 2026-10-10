/**
 * R-5: `?next=` sau đăng nhập/đăng ký (vd quay lại `/invite`). CHỈ đường dẫn nội bộ bắt đầu bằng một "/" —
 * chặn open redirect (`//evil.com`, `/\evil.com`, `https://…`).
 */
export function safeNext(raw: string | null | undefined, fallback = "/dashboard/flow"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
