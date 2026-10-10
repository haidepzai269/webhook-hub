import * as dns from 'dns';
import { promisify } from 'util';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';

const lookupAsync = promisify(dns.lookup);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts[0] === 0) return true; // 0.0.0.0/8
  if (parts[0] === 10) return true; // 10.0.0.0/8
  if (parts[0] === 127) return true; // 127.0.0.0/8
  if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
  if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // 100.64.0.0/10 (CGNAT)
  return false;
}

/** IPv6 -> 8 hextet số (mở `::`, đổi đuôi a.b.c.d nhúng thành 2 hextet). Sai định dạng -> null. */
export function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    if (!net.isIPv4(v4[1])) return null;
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

/**
 * Dải KHÔNG được gọi ra (ARCHITECTURE §7.3). MS-R1 (ADR-083): IPv6 được MỞ RA 8 hextet trước khi kiểm —
 * `::ffff:a.b.c.d` / `::ffff:7f00:1` (ánh xạ IPv4), `::a.b.c.d` (tương thích, cũ) -> kiểm như IPv4;
 * chặn `::`, `::1`, `64:ff9b::/96` (NAT64 — nhúng IPv4 bất kỳ), `fc00::/7`, `fe80::/10`. Không phân tích được -> chặn.
 */
export function isPrivateIp(ip: string): boolean {
  const raw = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(raw)) return isPrivateIpv4(raw);
  if (!net.isIPv6(raw)) return true;
  const h = expandIpv6(raw);
  if (!h) return true;
  const zeros5 = h.slice(0, 5).every((x) => x === 0);
  const toV4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  if (zeros5 && h[5] === 0xffff) return isPrivateIpv4(toV4(h[6], h[7])); // ::ffff:0:0/96
  if (zeros5 && h[5] === 0) {
    if (h[6] === 0 && h[7] <= 1) return true; // :: và ::1
    return true; // ::a.b.c.d (IPv4-compatible, đã bỏ) -> không bao giờ là đích hợp lệ
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return true; // 64:ff9b::/96
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

/**
 * S6 (ADR-076): link-local = metadata đám mây (169.254.169.254, fe80::/10). Chặn ở MỌI môi trường, kể cả
 * development và `allowPrivate` — sink/echo của dev nằm ở dải private thường (10/172/192), không ở đây.
 */
export function isLinkLocalIp(ip: string): boolean {
  const raw = ip.replace(/^\[|\]$/g, '');
  let v4 = net.isIPv4(raw) ? raw : null;
  const h = !v4 && net.isIPv6(raw) ? expandIpv6(raw) : null;
  if (h) {
    if ((h[0] & 0xffc0) === 0xfe80) return true;
    if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
      v4 = `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
    }
  }
  if (!v4) return false;
  const [a, b] = v4.split('.').map(Number);
  return a === 169 && b === 254;
}

export interface PinnedUrl {
  originalUrl: string;
  protocol: string;
  hostname: string;
  pinnedIp: string;
  port: number;
  pathname: string;
  search: string;
}

export async function validateAndPinUrl(rawUrl: string, allowPrivate = false): Promise<PinnedUrl> {
  const parsed = new URL(rawUrl);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Giao thức không được hỗ trợ: ${parsed.protocol}`);
  }

  // `new URL('http://[::1]/').hostname` = '[::1]' — bỏ ngoặc, không thì net.isIP() sai và rơi sang DNS (MS-R1).
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;

  let ip = hostname;
  if (!net.isIP(hostname)) {
    const lookupResult = await lookupAsync(hostname);
    ip = lookupResult.address;
  }

  if (isLinkLocalIp(ip)) {
    throw new Error(`SSRF Guard: Địa chỉ IP ${ip} thuộc dải link-local/metadata, luôn bị chặn`);
  }
  const isDev = process.env.NODE_ENV === 'development';
  if (!allowPrivate && !isDev && isPrivateIp(ip)) {
    throw new Error(`SSRF Guard: Địa chỉ IP ${ip} thuộc dải nội bộ/riêng tư bị chặn`);
  }

  return {
    originalUrl: rawUrl,
    protocol: parsed.protocol,
    hostname,
    pinnedIp: ip,
    port,
    pathname: parsed.pathname,
    search: parsed.search,
  };
}

export interface SsrfSafeAxiosConfig {
  /** URL gốc (giữ nguyên hostname) — dùng để axios request, KHÔNG thay bằng IP,
   * để Host header và TLS SNI vẫn đúng hostname/vhost của đích. */
  url: string;
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent;
}

/**
 * Kiểm SSRF (resolve DNS -> chặn dải IP nội bộ) rồi PIN đúng IP đã kiểm
 * bằng cách override `lookup` của http/https Agent — khi connect thật,
 * Node sẽ dùng thẳng IP đã pin thay vì tự resolve DNS lại lần nữa.
 * Đây là điểm chặn DNS rebinding (ARCHITECTURE.md §7.3): domain có thể trả
 * IP khác giữa lúc kiểm (ở trên) và lúc connect (network layer) nếu không pin.
 *
 * Host header / TLS SNI vẫn dùng hostname gốc (không đổi `url`) để server
 * đích (vd. nằm sau CDN/reverse-proxy dùng chung IP) route đúng vhost.
 */
export async function createSsrfSafeAxiosConfig(
  rawUrl: string,
  allowPrivate = false,
): Promise<SsrfSafeAxiosConfig> {
  const pinned = await validateAndPinUrl(rawUrl, allowPrivate);
  const pinnedFamily = net.isIPv6(pinned.pinnedIp) ? 6 : 4;

  // Chữ ký lookup của Node: (hostname, options, callback) — callback(err, address, family)
  // Bỏ qua `hostname`/`options` nhận vào, LUÔN trả về IP đã kiểm SSRF ở trên.
  // Node >= 20 (autoSelectFamily) gọi lookup với `{ all: true }` và đòi MẢNG [{address, family}];
  // trả chuỗi ở chế độ đó → socket báo "Invalid IP address: undefined" và mọi delivery fail.
  const pinnedLookup = (
    _hostname: string,
    options: dns.LookupOptions | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
    callback?: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    const cb = typeof options === 'function' ? options : callback;
    if (!cb) return;
    if (typeof options === 'object' && options?.all) {
      (cb as (err: null, addresses: dns.LookupAddress[]) => void)(null, [{ address: pinned.pinnedIp, family: pinnedFamily }]);
      return;
    }
    cb(null, pinned.pinnedIp, pinnedFamily);
  };

  const agentOptions = { lookup: pinnedLookup as unknown as typeof dns.lookup, keepAlive: false };

  return {
    url: pinned.originalUrl,
    httpAgent: pinned.protocol === 'http:' ? new http.Agent(agentOptions) : undefined,
    httpsAgent: pinned.protocol === 'https:' ? new https.Agent(agentOptions) : undefined,
  };
}
