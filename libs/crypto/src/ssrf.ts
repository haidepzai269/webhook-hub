import * as dns from 'dns';
import { promisify } from 'util';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';

const lookupAsync = promisify(dns.lookup);

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 169.254.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    // ::1 loopback
    if (ip === '::1') return true;
    // fc00::/7 unique local
    if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true;
    // fe80::/10 link local
    if (ip.toLowerCase().startsWith('fe8') || ip.toLowerCase().startsWith('fe9') || ip.toLowerCase().startsWith('fea') || ip.toLowerCase().startsWith('feb')) return true;
    return false;
  }

  return true;
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

  const hostname = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;

  let ip = hostname;
  if (!net.isIP(hostname)) {
    const lookupResult = await lookupAsync(hostname);
    ip = lookupResult.address;
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
