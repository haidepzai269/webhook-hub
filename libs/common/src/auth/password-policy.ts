import { COMMON_PASSWORDS } from './common-passwords';

/**
 * SPEC-auth §5.2. Thuần (không bcrypt) để web, hub-api, seed và test dùng chung một luật.
 */
export const PASSWORD_MIN_CHARS = 10;
/** bcrypt chỉ đọc 72 byte đầu: dài hơn là 422, không bao giờ cắt ngầm. */
export const PASSWORD_MAX_BYTES = 72;
export const EMAIL_MAX_LENGTH = 254;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Regex đơn giản có chủ đích (không cố bao hết RFC 5322): local@domain.tld, không khoảng trắng. */
export function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export type PasswordError = 'password_too_long' | 'password_weak';

export function passwordProblem(password: string, email: string): { error: PasswordError; message: string } | null {
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return { error: 'password_too_long', message: `Mật khẩu tối đa ${PASSWORD_MAX_BYTES} byte UTF-8 (chữ có dấu tính 2–3 byte)` };
  }
  if ([...password].length < PASSWORD_MIN_CHARS) {
    return { error: 'password_weak', message: `Mật khẩu tối thiểu ${PASSWORD_MIN_CHARS} ký tự` };
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return { error: 'password_weak', message: 'Mật khẩu nằm trong danh sách mật khẩu phổ biến' };
  }
  const local = normalizeEmail(email).split('@')[0] ?? '';
  if (local.length >= 3 && lower.includes(local)) {
    return { error: 'password_weak', message: 'Mật khẩu không được chứa phần trước @ của email' };
  }
  return null;
}

/** Email trong log/audit: `n***@gmail.com`. Không phải email hợp lệ -> `***`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
