import * as net from 'net';
import { isLinkLocalIp, isPrivateIp } from '@hub/crypto';

/** Tên biến môi trường đang quyết định URL ingest — lời nhắc lỗi / DRIFTED phải gọi đúng biến này. */
export type IngestUrlVar = 'HUB_INGEST_PUBLIC_URL' | 'HUB_PUBLIC_URL';

/**
 * §9 SPEC-hub-sap (ADR-211): `HUB_INGEST_PUBLIC_URL` = URL provider gọi vào (`/hooks/*`), tách khỏi `HUB_PUBLIC_URL`
 * (API, console, connection string). Thiếu / chỉ khoảng trắng -> rơi về `HUB_PUBLIC_URL` y như trước khi tách.
 * Có giá trị mà không công khai -> KHÔNG rơi về (publicIngestBase trả null): cấu hình sai phải lộ ra, không âm thầm
 * đăng ký URL Render cho source mới.
 */
export function ingestPublicUrlVar(env: Record<string, string | undefined> = process.env): IngestUrlVar {
  return (env.HUB_INGEST_PUBLIC_URL ?? '').trim() ? 'HUB_INGEST_PUBLIC_URL' : 'HUB_PUBLIC_URL';
}

/**
 * KN2 (SPEC-ket-noi §4.4) + §9 (ADR-211): MỘT hàm duy nhất trả base URL ingest công khai — đăng ký PayOS/Stripe, so
 * DRIFTED `public_url_changed`, `publicHooksUrl()` (unverified/forwardUrl, provider ký trên URL), URL console cho dev copy.
 * Base = `HUB_INGEST_PUBLIC_URL`, thiếu thì `HUB_PUBLIC_URL`. Localhost / IP nội bộ / tên một nhãn (vd `hub-api` trong
 * docker) -> null (422 `public_url_required`, KHÔNG gọi provider).
 * Ngoài production, `CONNECTOR_INGEST_BASE_URL` thay hẳn (stack kiểm chứng: fake provider trong sink gọi `http://hub-api:4000`);
 * production có biến này -> app không khởi động (testOnlyConfigProblems). `connectorOverride: false` bỏ qua nó (URL hiện
 * cho người — tên trong mạng docker không mở được từ trình duyệt).
 *
 * LH3 (H4, ADR-217): `route: 'direct'` = base cho request GỌI THẲNG (không có chữ ký lưới hợp lệ) -> `HUB_PUBLIC_URL`, bỏ qua
 * `HUB_INGEST_PUBLIC_URL` (`publicHooksUrl` chọn theo đường vào). Mặc định `'ingest'`: URL đăng ký / hiện cho source MỚI.
 * Mọi chỗ dựng URL ingest phải đi qua hàm này.
 */
export function publicIngestBase(
  env: Record<string, string | undefined> = process.env,
  opts: { connectorOverride?: boolean; route?: 'ingest' | 'direct' } = {},
): string | null {
  const override = opts.connectorOverride === false || env.NODE_ENV === 'production' ? '' : (env.CONNECTOR_INGEST_BASE_URL ?? '').trim();
  if (override) return override.replace(/\/$/, '');
  const varName: IngestUrlVar = opts.route === 'direct' ? 'HUB_PUBLIC_URL' : ingestPublicUrlVar(env);
  const raw = (env[varName] ?? '').trim().replace(/\/$/, '');
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

/** URL ingest tuyệt đối của một source cho console hiện / dev copy; hub không có URL công khai -> null (web tự ghép). */
export function sourceIngestUrl(provider: string, sourceKey: string, env: Record<string, string | undefined> = process.env): string | null {
  const base = publicIngestBase(env, { connectorOverride: false });
  return base ? `${base}/hooks/${provider}/${sourceKey}` : null;
}
