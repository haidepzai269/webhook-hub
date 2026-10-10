import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * SPEC-auth §5.4: CSRF double-submit CÓ KÝ, gắn với session.
 * token = base64url(random16) + "." + base64url(HMAC_SHA256(CSRF_SECRET, sid + "." + random16))
 * Hợp lệ khi: header == cookie (so hằng thời gian) VÀ chữ ký đúng cho `sid` hiện tại — cookie bị "tossing"
 * từ subdomain khác hoặc lấy từ phiên khác đều trượt ở bước ký.
 */
export function issueCsrfToken(secret: string, sid: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${sign(secret, sid, nonce)}`;
}

export function verifyCsrfToken(secret: string, sid: string, cookie: string | undefined, header: string | undefined): boolean {
  if (typeof cookie !== 'string' || typeof header !== 'string' || !cookie || !header) return false;
  if (!safeEqual(cookie, header)) return false;
  const dot = cookie.indexOf('.');
  if (dot <= 0) return false;
  return safeEqual(cookie.slice(dot + 1), sign(secret, sid, cookie.slice(0, dot)));
}

function sign(secret: string, sid: string, nonce: string): string {
  return createHmac('sha256', secret).update(`${sid}.${nonce}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
