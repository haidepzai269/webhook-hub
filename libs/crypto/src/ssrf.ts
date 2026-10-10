import * as dns from 'dns';
import { promisify } from 'util';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';

const lookupAsync = promisify(dns.lookup);

/**
 * MS-P2-4 (ADR-091): ALLOWLIST — chỉ IPv4 "global unicast" đi ra được. Mọi dải đặc biệt của IANA bị chặn:
 * 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16,
 * 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 (multicast), 240/4 (dành riêng, gồm 255.255.255.255).
 */
const V4_BLOCKED: [number, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([ip, bits]) => [v4ToInt(ip as string), bits as number]);

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n * 256 + Number(o)) >>> 0, 0);
}

function isPrivateIpv4(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([net, bits]) => (n >>> (32 - bits)) === (net >>> (32 - bits)));
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

const hx = (h: number[], i: number) => `${h[i] >> 8}.${h[i] & 255}.${h[i + 1] >> 8}.${h[i + 1] & 255}`;

/** IPv4 nhúng trong IPv6: ánh xạ `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002:AABB:CCDD::/48`. */
function embeddedV4(h: number[]): string | null {
  const zeros5 = h.slice(0, 5).every((x) => x === 0);
  if (zeros5 && h[5] === 0xffff) return hx(h, 6);
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return hx(h, 6);
  if (h[0] === 0x2002) return hx(h, 1);
  return null;
}

/**
 * Dải KHÔNG được gọi ra (ARCHITECTURE §7.3). MS-P2-4 (ADR-091) — ALLOWLIST: IPv6 chỉ cho `2000::/3` (global unicast)
 * TRỪ `2001::/23` (Teredo, ORCHID…), `2001:db8::/32` (tài liệu) và `2002::/16` (6to4 — nhúng IPv4 bất kỳ); `::ffff:a.b.c.d`
 * kiểm như IPv4. Mọi thứ khác (::, ::1, NAT64 64:ff9b::/96 và 64:ff9b:1::/48, ::ffff:0:a.b.c.d, fc00::/7, fe80::/10,
 * ff00::/8, 100::/64…) bị chặn. Không phân tích được -> chặn.
 */
export function isPrivateIp(ip: string): boolean {
  const raw = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(raw)) return isPrivateIpv4(raw);
  if (!net.isIPv6(raw)) return true;
  const h = expandIpv6(raw);
  if (!h) return true;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPrivateIpv4(hx(h, 6));
  if ((h[0] & 0xe000) !== 0x2000) return true; // ngoài 2000::/3
  if ((h[0] === 0x2001 && (h[1] < 0x0200 || h[1] === 0x0db8)) || h[0] === 0x2002) return true; // 2001::/23, 2001:db8::/32, 2002::/16
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
    // MS-P2-4: cả link-local giấu trong ánh xạ / NAT64 / 6to4 (development vẫn cho dải private thường).
    v4 = embeddedV4(h) ?? (h.slice(0, 6).every((x) => x === 0) ? hx(h, 6) : null);
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
