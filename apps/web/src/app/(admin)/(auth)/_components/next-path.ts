/**
 * R-5 + N-2 (review AU, ADR-122): `?next=` sau đăng nhập/đăng ký (vd quay lại `/invite`) CHỈ được là đường nội bộ.
 * Kiểm tiền tố là không đủ: parser URL (WHATWG) bỏ tab/newline nên `/\t/evil.com` thành `//evil.com`. Cách làm:
 * từ chối ký tự điều khiển (< 0x20, 0x7f) và `\`, bắt buộc MỘT dấu `/` ở đầu, rồi PHÂN GIẢI bằng `new URL(raw, origin)`
 * và đòi cùng origin — trả lại đúng pathname + search + hash đã phân giải.
 */
export function safeNext(
  raw: string | null | undefined,
  fallback = "/dashboard/flow",
  origin: string = typeof window !== "undefined" ? window.location.origin : "http://localhost",
): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: chặn đúng ký tự điều khiển
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  let u: URL;
  try {
    u = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (u.origin !== new URL(origin).origin || !u.pathname.startsWith("/") || u.pathname.startsWith("//")) return fallback;
  return u.pathname + u.search + u.hash;
}
