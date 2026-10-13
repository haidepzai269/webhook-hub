import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Standard Webhooks (https://www.standardwebhooks.com, SPEC §4.7, ADR-040) — bản của hub: WebhookSender, challenge và
 * GenericAdapter (S8). SDK (`libs/hub-sdk/src/webhook.ts`) và Shop có bản RIÊNG, chỉ đọc `webhook-*`: bộ `svix-*` (PK1,
 * ADR-202) chỉ mở ở phía NHẬN của hub (nguồn generic), phía nhận push của service không nới thêm (review PK1 T-8).
 *
 *   sign = "v1," + base64( HMAC_SHA256(secretBytes, `${msgId}.${ts}.${body}`) )
 *   secretBytes = secret bắt đầu "whsec_" ? base64decode(phần sau) : utf8(secret)   // tương thích secret cũ
 */
export const SW_TOLERANCE_SEC = 300;

function secretBytes(secret: string): Buffer {
  return secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
}

export function swSign(secret: string, msgId: string, ts: number, body: string | Buffer): string {
  const mac = createHmac('sha256', secretBytes(secret));
  mac.update(`${msgId}.${ts}.`);
  mac.update(body);
  return `v1,${mac.digest('base64')}`;
}

/** Ba header gửi đi (chữ thường — HTTP không phân biệt hoa thường). */
export function swHeaders(secret: string, msgId: string, body: string | Buffer, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  return { 'webhook-id': msgId, 'webhook-timestamp': String(ts), 'webhook-signature': swSign(secret, msgId, ts, body) };
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : undefined;
}

export interface SwHeaderNames {
  id: string;
  timestamp: string;
  signature: string;
}
const SW_STANDARD: SwHeaderNames = { id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature' };
/** PK1 (ADR-202): Svix (Clerk, Resend…) — cùng thuật toán, cùng secret `whsec_`, chỉ khác tên header. */
const SW_SVIX: SwHeaderNames = { id: 'svix-id', timestamp: 'svix-timestamp', signature: 'svix-signature' };

/**
 * PK1 (ADR-202): bộ header ĐANG DÙNG của request. Có bất kỳ header `webhook-*` nào -> bộ chuẩn; không có mà có `svix-*`
 * -> bộ Svix; không có gì -> bộ chuẩn (chẩn đoán báo theo bộ chuẩn). Ba header luôn lấy từ CÙNG một bộ — trộn
 * (`webhook-id` + `svix-signature`) thì bộ chuẩn thiếu header -> verify false.
 */
export function swHeaderSet(headers: Record<string, unknown>): SwHeaderNames {
  const has = (n: string) => header(headers, n) !== undefined;
  if ([SW_STANDARD.id, SW_STANDARD.timestamp, SW_STANDARD.signature].some(has)) return SW_STANDARD;
  if ([SW_SVIX.id, SW_SVIX.timestamp, SW_SVIX.signature].some(has)) return SW_SVIX;
  return SW_STANDARD;
}

/**
 * Bộ header theo `swHeaderSet` (webhook-* hoặc svix-*, không trộn). Thiếu 1 trong 3 header -> false; |now - ts| > tolerance -> false; header chữ ký có thể chứa nhiều chữ ký
 * cách nhau bằng dấu cách ("v1,a v1,b"), khớp MỘT là đủ, so bằng timingSafeEqual. `rawBody` là BYTES gốc.
 */
export function swVerify(
  secret: string,
  headers: Record<string, unknown>,
  rawBody: string | Buffer,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  const set = swHeaderSet(headers);
  const id = header(headers, set.id);
  const tsRaw = header(headers, set.timestamp);
  const sigs = header(headers, set.signature);
  if (!id || !tsRaw || !sigs || !/^\d{1,12}$/.test(tsRaw)) return false;
  const ts = Number(tsRaw);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSec ?? SW_TOLERANCE_SEC)) return false;
  const expected = Buffer.from(swSign(secret, id, ts, rawBody));
  let ok = false;
  for (const s of sigs.split(' ')) {
    const b = Buffer.from(s);
    // Không dừng sớm: so hết các chữ ký để thời gian không lộ vị trí khớp.
    if (b.length === expected.length && timingSafeEqual(b, expected)) ok = true;
  }
  return ok;
}

/** Secret do hub sinh khi endpoint không truyền `signingSecret`: `whsec_` + base64(24 byte ngẫu nhiên). */
export function generateWhsecSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}
