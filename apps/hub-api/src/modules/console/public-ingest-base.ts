import * as net from 'net';
import { isLinkLocalIp, isPrivateIp } from '@hub/crypto';

/**
 * KN2 (SPEC-ket-noi §4.4): URL công khai mà provider gọi vào. `HUB_PUBLIC_URL` là localhost / IP nội bộ / tên một nhãn
 * (vd `hub-api` trong docker) -> null (422 `public_url_required`, KHÔNG gọi provider).
 * Ngoài production, `CONNECTOR_INGEST_BASE_URL` thay hẳn (stack kiểm chứng: fake provider trong sink gọi `http://hub-api:4000`);
 * production có biến này -> app không khởi động (testOnlyConfigProblems).
 */
export function publicIngestBase(env: Record<string, string | undefined> = process.env): string | null {
  const override = env.NODE_ENV === 'production' ? '' : (env.CONNECTOR_INGEST_BASE_URL ?? '').trim();
  if (override) return override.replace(/\/$/, '');
  const raw = (env.HUB_PUBLIC_URL ?? '').trim().replace(/\/$/, '');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) return null;
  if (net.isIP(host)) return isPrivateIp(host) || isLinkLocalIp(host) ? null : raw;
  if (!host.includes('.')) return null;
  return raw;
}
