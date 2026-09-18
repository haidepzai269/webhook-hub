import * as dns from 'dns';
import { promisify } from 'util';
import * as net from 'net';

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
