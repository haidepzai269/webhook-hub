import { createHash, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

/**
 * R-2 (review AU, ADR-110): console đi qua proxy của web (Next `rewrites`) -> `req.ip` của hub-api là IP của web
 * (local: container web; deployed: egress Vercel) => rate limit theo IP thành giới hạn CHUNG cho mọi người.
 * Web (`apps/web/src/proxy.ts`) gửi IP thật của client trong `x-hub-client-ip` kèm `x-hub-proxy-secret`.
 * hub-api CHỈ tin header đó khi secret khớp (so `timingSafeEqual` trên sha256 — cùng độ dài); thiếu/sai -> IP socket.
 * Không đặt `WEB_PROXY_SECRET` -> tắt hẳn (hành vi cũ).
 */
export const CLIENT_IP_HEADER = 'x-hub-client-ip';
export const PROXY_SECRET_HEADER = 'x-hub-proxy-secret';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function proxySecretValid(given: unknown, secret: string | undefined): boolean {
  if (!secret || typeof given !== 'string' || given.length === 0) return false;
  return timingSafeEqual(digest(given), digest(secret));
}

interface IpRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export function clientIp(req: IpRequest, secret: string | undefined = process.env.WEB_PROXY_SECRET): string | null {
  const h = req.headers ?? {};
  if (proxySecretValid(h[PROXY_SECRET_HEADER], secret)) {
    // N-4 (ADR-123): request đã qua proxy web -> CHỈ tin x-hub-client-ip. Thiếu/rác thì null (bucket "unknown"),
    // KHÔNG lùi về req.ip — với TRUST_PROXY=1 req.ip đọc X-Forwarded-For, thứ client có thể đã đặt.
    const fwd = h[CLIENT_IP_HEADER];
    const ip = typeof fwd === 'string' ? fwd.trim() : '';
    return isIP(ip) ? ip : null;
  }
  return req.ip ?? null;
}
