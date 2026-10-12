/**
 * ADR-180: gợi ý "email đã có tài khoản" ở /register dẫn sang /login hoặc /forgot-password MANG THEO email đã gõ.
 * Chuyển qua sessionStorage (một lần, đọc xong xoá), KHÔNG qua query string: cùng lý do `/auth/email-check` dùng POST —
 * email không nằm trong URL, lịch sử trình duyệt hay access log. Storage bị chặn -> chỉ mất phần điền sẵn.
 */
const KEY = "hub.auth.prefill-email";

export function rememberEmailPrefill(email: string): void {
  try {
    window.sessionStorage.setItem(KEY, email);
  } catch {
    // chế độ riêng tư / chặn storage: bỏ qua
  }
}

export function takeEmailPrefill(): string | null {
  try {
    const v = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return null;
  }
}
