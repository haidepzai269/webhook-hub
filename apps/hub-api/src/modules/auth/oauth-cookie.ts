import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Cookie `__Host-hub_oauth` dùng chung cho GitHub (AU5) và Google (AU5b, ADR-127): state + PKCE verifier (+ nonce,
 * `next` của Google) ký HMAC bằng OAUTH_COOKIE_SECRET, sống 10 phút. Có trường `p` (provider): cookie của luồng này
 * không mở được ở callback của luồng kia.
 */
export const OAUTH_COOKIE = '__Host-hub_oauth';
export const OAUTH_TTL_MS = 10 * 60_000;
export const OAUTH_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: OAUTH_TTL_MS } as const;

export interface OAuthCookie {
  p: 'github' | 'google';
  state: string;
  verifier: string;
  exp: number;
  nonce?: string;
  next?: string;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function sealOAuthCookie(secret: string, c: OAuthCookie): string {
  const body = Buffer.from(JSON.stringify(c)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function openOAuthCookie(secret: string, v: string | undefined, provider: OAuthCookie['p'], now = Date.now()): OAuthCookie | null {
  if (typeof v !== 'string' || !v.includes('.')) return null;
  const [body, sig] = v.split('.', 2);
  if (!safeEqual(sig, createHmac('sha256', secret).update(body).digest('base64url'))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthCookie;
    return c.p === provider && typeof c.state === 'string' && typeof c.verifier === 'string' && c.exp > now ? c : null;
  } catch {
    return null;
  }
}

/**
 * `?next=` phía server (cùng luật với web `safeNext`, N-2/ADR-122): chỉ đường nội bộ — không ký tự điều khiển, không `\`,
 * đúng một `/` ở đầu, phân giải theo origin của web phải cùng origin. Sai -> undefined (về /dashboard).
 */
export function safeNextPath(raw: unknown, webOrigin: string): string | undefined {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 512) return undefined;
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || ch === '\\') return undefined;
  }
  try {
    const base = new URL(webOrigin);
    const u = new URL(raw, base);
    if (u.origin !== base.origin || u.pathname.startsWith('//')) return undefined;
    return u.pathname + u.search + u.hash;
  } catch {
    return undefined;
  }
}
