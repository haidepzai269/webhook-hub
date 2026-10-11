// Lỗi production (2026-10-12): trình duyệt tự điền email + mật khẩu đăng nhập của operator vào ô "Client ID"/"Api Key" của
// form Kết nối PayOS — bấm Kết nối là gửi mật khẩu operator sang PayOS. Mọi ô credential đi qua đây.

/**
 * Thuộc tính cho ô credential: tên/id riêng (không `username`/`email`/`password`) + `new-password` cho ô bí mật để trình
 * quản lý mật khẩu không khớp với form đăng nhập đã lưu.
 */
export function credentialInputAttrs(scope: string, field: string, secret: boolean) {
  const slug = `${scope}-${field}`
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  return {
    id: slug,
    name: slug,
    type: secret ? "password" : "text",
    autoComplete: secret ? "new-password" : "off",
    autoCapitalize: "off",
    autoCorrect: "off",
    spellCheck: false,
    "data-1p-ignore": true,
    "data-lpignore": "true",
  } as const;
}

/** Khoá/ID của provider không bao giờ chứa "@" — có thì gần như chắc là email bị tự điền. */
export function credentialError(label: string, value: string): string | null {
  return value.includes("@") ? `Đây có vẻ là email, không phải ${label}` : null;
}
