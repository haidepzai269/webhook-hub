import { isIP } from 'net';

/**
 * `TRUST_PROXY` -> giá trị `app.set('trust proxy', …)` của Express (review EG1, nhánh feat/edge).
 * - trống / `0` / chỉ gồm dấu phân cách (`" , "`): không tin X-Forwarded-For (mặc định, như cũ).
 * - `1`: tin đúng một chặng (Render; hub-all + nginx) — như cũ.
 * - số khác: BỎ QUA như cũ (trước đây chỉ `=== '1'` có tác dụng) — không âm thầm tin nhiều chặng hơn.
 * - danh sách IP/CIDR cách nhau dấu phẩy/khoảng trắng (vd `10.250.250.6`): CHỈ tin đúng các địa chỉ đó — compose local cho
 *   service `edge` (nginx), để request gọi thẳng hub-api (k6, cổng 4000) không giả được IP bằng X-Forwarded-For.
 * Phần tử sai khuôn, hoặc dải QUÁ RỘNG (cùng luật docker/nginx/edge.js: IPv4 ngắn hơn /8, IPv6 ngắn hơn /16, gồm cả /0)
 * -> ném lỗi (main.ts thoát lúc khởi động). Đổi hành vi có chủ ý (ADR-176): trước đây giá trị lạ (`true`, `yes`) bị bỏ
 * qua im lặng, giờ hub-api không khởi động.
 * Review EG1 lượt 3 (TB-1): dạng IPv4-mapped IPv6 được QUY VỀ IPv4 trước khi áp luật — proxy-addr làm đúng như vậy
 * (`::ffff:0:0/96` = `0.0.0.0/0`), và một dải IPv6 chứa trọn ::ffff:0:0/96 (vd `::/16`) tin mọi peer IPv4.
 */
export function parseTrustProxy(raw: string | undefined): number | string[] | undefined {
  const v = (raw ?? '').trim();
  if (v === '' || /^\d+$/.test(v)) return v === '1' ? 1 : undefined;
  const items = v.split(/[\s,]+/).filter(Boolean);
  if (!items.length) return undefined;
  const bad = items.filter((i) => {
    const [addr, prefix, extra] = i.split('/');
    const fam = isIP(addr);
    if (!fam || extra !== undefined) return true;
    if (prefix === undefined) return false;
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (fam === 4 ? 32 : 128)) return true;
    const eff = effectivePrefix(addr, fam, Number(prefix));
    return eff === null || ('v4' in eff ? eff.v4 < 8 : eff.v6 < 16);
  });
  if (bad.length) throw new Error(`TRUST_PROXY: phần tử không phải IP/CIDR hợp lệ, hoặc dải quá rộng (IPv4 < /8, IPv6 < /16, kể cả dạng IPv4-mapped ::ffff:…): ${bad.join(', ')}`);
  return items;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const MAPPED_NET = BigInt(0xffff) << BigInt(32); // ::ffff:0:0/96

/** IPv6 (cả đuôi chấm `::ffff:1.2.3.4`) -> 128 bit. Cùng thuật toán với `ipv6Bits` của docker/nginx/edge.js. */
function ipv6Bits(addr: string): bigint | null {
  let a = addr;
  const dotted = /^(.*:)([^:]+\.[^:]+)$/.exec(a);
  if (dotted) {
    if (!IPV4.test(dotted[2])) return null;
    const o = dotted[2].split('.').map(Number);
    a = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x === '' ? [] : x.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const words = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (words.some((w) => !/^[0-9A-Fa-f]{1,4}$/.test(w))) return null;
  return words.reduce((acc, w) => (acc << BigInt(16)) | BigInt(parseInt(w, 16)), BigInt(0));
}

/** Prefix hiệu dụng (xem `effectivePrefix` của edge.js): IPv6 phủ trọn không gian mapped -> v4 /0; nằm trong -> v4 /(p-96). */
function effectivePrefix(addr: string, fam: number, p: number): { v4: number } | { v6: number } | null {
  if (fam === 4) return { v4: p };
  const bits = ipv6Bits(addr);
  if (bits === null) return null;
  const mask = (n: number) => (n === 0 ? BigInt(0) : ((BigInt(1) << BigInt(n)) - BigInt(1)) << BigInt(128 - n));
  if (p <= 96 && (bits & mask(p)) === (MAPPED_NET & mask(p))) return { v4: 0 };
  if (p > 96 && (bits & mask(96)) === MAPPED_NET) return { v4: p - 96 };
  return { v6: p };
}
