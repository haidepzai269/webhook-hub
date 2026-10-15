/**
 * LH2 — lọc header (SPEC-hub-sap §4.1, §16 LH-S).
 * - Lưu D1 / chuyển tiếp: header GỐC của provider, bỏ những gì Cloudflare/hop tự thêm (`cf-*`, `x-real-ip`,
 *   `x-forwarded-*`, `cdn-loop`, hop-by-hop, `host`, `content-length`) và mọi `x-catchnet-*` / `x-hub-outcome` do client
 *   tự đặt (Worker đặt lại bộ đã ký — không cho giả).
 * - Trả về provider: chỉ danh sách header an toàn của phản hồi hub; KHÔNG bao giờ chuyển `x-hub-outcome` (H1).
 */
const DROP_EXACT = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
  'x-real-ip',
  'cdn-loop',
  'accept-encoding', // fetch của Worker tự xử lý nén; giữ thì body phản hồi có thể bị giải nén mà header vẫn báo nén
  'x-hub-outcome',
]);
const DROP_PREFIX = ['cf-', 'x-forwarded-', 'x-catchnet-'];

export function keepRequestHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (DROP_EXACT.has(n)) return false;
  return !DROP_PREFIX.some((p) => n.startsWith(p));
}

/** Header gốc để lưu D1 (JSON object, tên chữ thường — Cloudflare đã viết thường từ trước, §16 LH-S). */
export function storableHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    if (keepRequestHeader(name)) out[name.toLowerCase()] = value;
  });
  return out;
}

const PASS_RESPONSE = new Set(['content-type', 'retry-after', 'x-request-id', 'www-authenticate', 'allow', 'cache-control']);

/** Phản hồi của hub -> provider: status + body nguyên vẹn, header an toàn. */
export async function passThrough(res: Response): Promise<Response> {
  const headers = new Headers();
  res.headers.forEach((value, name) => {
    if (PASS_RESPONSE.has(name.toLowerCase())) headers.set(name, value);
  });
  const noBody = res.status === 204 || res.status === 205 || res.status === 304;
  const body = noBody ? null : await res.arrayBuffer();
  return new Response(body, { status: res.status, headers });
}
