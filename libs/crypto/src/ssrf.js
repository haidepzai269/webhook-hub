"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPrivateIp = isPrivateIp;
exports.validateAndPinUrl = validateAndPinUrl;
const dns = require("dns");
const util_1 = require("util");
const net = require("net");
const lookupAsync = (0, util_1.promisify)(dns.lookup);
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        if (parts[0] === 0)
            return true;
        if (parts[0] === 10)
            return true;
        if (parts[0] === 127)
            return true;
        if (parts[0] === 169 && parts[1] === 254)
            return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
            return true;
        if (parts[0] === 192 && parts[1] === 168)
            return true;
        return false;
    }
    if (net.isIPv6(ip)) {
        if (ip === '::1')
            return true;
        if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd'))
            return true;
        if (ip.toLowerCase().startsWith('fe8') || ip.toLowerCase().startsWith('fe9') || ip.toLowerCase().startsWith('fea') || ip.toLowerCase().startsWith('feb'))
            return true;
        return false;
    }
    return true;
}
async function validateAndPinUrl(rawUrl, allowPrivate = false) {
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
//# sourceMappingURL=ssrf.js.map