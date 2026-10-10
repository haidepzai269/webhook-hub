import { Response } from 'express';

/**
 * SPEC-auth §4, §5.4. Tiền tố `__Host-` buộc Secure + Path=/ + không Domain (chống ghi đè cookie từ subdomain).
 * localhost được Chrome/Firefox coi là secure context nên cookie Secure vẫn sống trên http://localhost (TA14).
 * Token KHÔNG bao giờ nằm trong body response.
 */
export const ACCESS_COOKIE = '__Host-hub_at';
export const REFRESH_COOKIE = '__Host-hub_rt';
export const CSRF_COOKIE = 'hub_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  accessMaxAgeS: number;
  refreshMaxAgeS: number;
}

export function setSessionCookies(res: Pick<Response, 'cookie'>, s: IssuedSession): void {
  const base = { secure: true, sameSite: 'lax' as const, path: '/' };
  res.cookie(ACCESS_COOKIE, s.accessToken, { ...base, httpOnly: true, maxAge: s.accessMaxAgeS * 1000 });
  res.cookie(REFRESH_COOKIE, s.refreshToken, { ...base, httpOnly: true, maxAge: s.refreshMaxAgeS * 1000 });
  // CSRF: web PHẢI đọc được (không HttpOnly) để chép vào header x-csrf-token.
  res.cookie(CSRF_COOKIE, s.csrfToken, { ...base, httpOnly: false, maxAge: s.refreshMaxAgeS * 1000 });
}

export function clearSessionCookies(res: Pick<Response, 'clearCookie'>): void {
  const base = { secure: true, sameSite: 'lax' as const, path: '/' };
  res.clearCookie(ACCESS_COOKIE, { ...base, httpOnly: true });
  res.clearCookie(REFRESH_COOKIE, { ...base, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...base });
}

export function readCookie(req: { cookies?: Record<string, string | undefined> }, name: string): string | undefined {
  const v = req.cookies?.[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Header có thể lặp (mảng) — lấy giá trị đầu. */
export function readHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const v = headers?.[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}
