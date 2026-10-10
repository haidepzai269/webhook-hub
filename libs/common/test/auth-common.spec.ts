import { Writable } from 'stream';
import pino from 'pino';
import {
  COMMON_PASSWORDS,
  issueCsrfToken,
  isValidEmail,
  LOG_REDACT_OPTIONS,
  maskEmail,
  normalizeEmail,
  passwordProblem,
  scrubSecrets,
  verifyCsrfToken,
} from '@hub/common';

describe('auth thuần — email, mật khẩu (SPEC-auth §5.2)', () => {
  it('normalizeEmail trim + lowercase; isValidEmail chặn rỗng / thiếu @ / > 254', () => {
    expect(normalizeEmail('  An.Nguyen@Gmail.COM ')).toBe('an.nguyen@gmail.com');
    expect(isValidEmail('a@b.vn')).toBe(true);
    expect(isValidEmail('khong-co-a-cong')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@b.vn`)).toBe(false);
  });

  it('passwordProblem: 73 byte UTF-8 → too_long (không cắt ngầm); 72 byte thì không', () => {
    // "đ" = 2 byte UTF-8: 36 ký tự = 72 byte, 36 ký tự + "a" = 73 byte
    const at72 = 'đ'.repeat(36);
    expect(Buffer.byteLength(at72, 'utf8')).toBe(72);
    expect(passwordProblem(at72 + 'a', 'x@y.vn')?.error).toBe('password_too_long');
    expect(passwordProblem(at72, 'x@y.vn')).toBeNull();
  });

  it('passwordProblem: < 10 ký tự, trong danh sách phổ biến, hoặc chứa phần trước @ của email → weak', () => {
    expect(COMMON_PASSWORDS.size).toBe(1051);
    expect(COMMON_PASSWORDS.has("1234567890")).toBe(true);
    expect(passwordProblem('ngan-qua', 'x@y.vn')?.error).toBe('password_weak');
    expect(passwordProblem('Password', 'x@y.vn')?.error).toBe('password_weak');
    expect(passwordProblem('QwertyUiop', 'x@y.vn')?.error).toBe('password_weak'); // đủ 10 ký tự nhưng phổ biến
    expect(passwordProblem('xx-annguyen-2026', 'AnNguyen@gmail.com')?.error).toBe('password_weak');
    expect(passwordProblem('ca-phe-sua-da-2026', 'an@gmail.com')).toBeNull();
  });

  it('maskEmail giữ ký tự đầu + domain', () => {
    expect(maskEmail('nguyen@gmail.com')).toBe('n***@gmail.com');
    expect(maskEmail('khong-hop-le')).toBe('***');
  });
});

describe('CSRF double-submit có ký theo sid (SPEC-auth §5.4)', () => {
  const secret = 'csrf-secret-0123456789-0123456789-abc';
  it('token đúng sid + khớp cookie → hợp lệ; header khác cookie / ký cho sid khác / sửa chữ ký → không', () => {
    const t = issueCsrfToken(secret, 'sid-1');
    expect(verifyCsrfToken(secret, 'sid-1', t, t)).toBe(true);
    expect(verifyCsrfToken(secret, 'sid-1', t, undefined)).toBe(false);
    expect(verifyCsrfToken(secret, 'sid-1', t, issueCsrfToken(secret, 'sid-1'))).toBe(false);
    const other = issueCsrfToken(secret, 'sid-2');
    expect(verifyCsrfToken(secret, 'sid-1', other, other)).toBe(false);
    const forged = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
    expect(verifyCsrfToken(secret, 'sid-1', forged, forged)).toBe(false);
  });
});

describe('logger che bí mật', () => {
  const capture = () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
    return { log: pino({ redact: LOG_REDACT_OPTIONS, hooks: { logMethod: scrubSecretsHook } }, stream), lines };
  };
  // dùng đúng hook mà logger chính dùng
  function scrubSecretsHook(this: pino.Logger, args: unknown[], method: (...a: unknown[]) => void) {
    return method.apply(this, args.map((a) => (typeof a === 'string' ? scrubSecrets(a) : a)) as never);
  }

  it('[AU:UA22] password / refresh token / hk_live_ thô trong log bị che (khoá đối tượng lẫn chuỗi)', () => {
    const { log, lines } = capture();
    const key = 'hk_live_' + 'A'.repeat(43);
    log.info({ password: 'mat-khau-bi-mat', body: { currentPassword: 'cu-bi-mat', token: 'tok-bi-mat' } }, `gọi với ${key}`);
    log.warn(`cookie __Host-hub_rt=${'r'.repeat(43)}; hub_csrf=x`);
    const out = lines.join('\n');
    expect(out).not.toContain('mat-khau-bi-mat');
    expect(out).not.toContain('cu-bi-mat');
    expect(out).not.toContain('tok-bi-mat');
    expect(out).not.toContain(key);
    expect(out).not.toContain('r'.repeat(43));
    expect(out).toContain('hk_live_***');
  });
});
