/**
 * LH2 — ký header lưới hứng, CÙNG khuôn hub-api kiểm (`apps/hub-api/src/modules/ingest/catchnet.ts`, ADR-217).
 * Vector cố định dùng chung: `libs/crypto/test/fixtures/catchnet-vectors.json` (REVIEW-LH3 T-7).
 *
 *   x-catchnet-signature:      v1=hex(HMAC-SHA256(secret, id.received_at.client_ip.mode.METHOD.target))
 *   x-catchnet-body-signature: v1=hex(HMAC-SHA256(secret, id.hex(sha256(body))))
 *
 * `target` = path + query THÔ, ĐÚNG chuỗi nằm trên dòng request mà `fetch` gửi tới hub (xem `requestTarget`).
 */
export type CatchnetMode = 'forward' | 'replay';

export const CATCHNET_HEADER_NAMES = [
  'x-catchnet-id',
  'x-catchnet-received-at',
  'x-catchnet-client-ip',
  'x-catchnet-mode',
  'x-catchnet-signature',
  'x-catchnet-body-signature',
] as const;

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export interface SignInput {
  id: string;
  receivedAt: number;
  clientIp: string;
  mode: CatchnetMode;
  method: string;
  target: string;
  body: ArrayBuffer | Uint8Array;
}

export function signingString(i: Omit<SignInput, 'body'>): string {
  return `${i.id}.${i.receivedAt}.${i.clientIp}.${i.mode}.${i.method.toUpperCase()}.${i.target}`;
}

/** Bộ header lưới — mỗi header ĐÚNG một giá trị (hub bỏ cả bộ nếu header lặp). */
export async function catchnetHeaders(secret: string, i: SignInput): Promise<Record<string, string>> {
  const bodyHash = await sha256Hex(i.body);
  return {
    'x-catchnet-id': i.id,
    'x-catchnet-received-at': String(i.receivedAt),
    'x-catchnet-client-ip': i.clientIp,
    'x-catchnet-mode': i.mode,
    'x-catchnet-signature': `v1=${await hmacHex(secret, signingString(i))}`,
    'x-catchnet-body-signature': `v1=${await hmacHex(secret, `${i.id}.${bodyHash}`)}`,
  };
}

/**
 * URL đưa vào `fetch` + target ký. Ghép origin hub với target thô của provider rồi để WHATWG URL chuẩn hoá MỘT lần
 * (giống hệt `fetch` sẽ làm), lấy target từ `href` — `href` giữ `?` đứng một mình, `pathname + search` thì không
 * (REVIEW-LH3 T-7). Ký đúng chuỗi này thì dòng request hub nhận khớp chữ ký.
 */
export function requestTarget(hubOrigin: string, rawTarget: string): { url: string; target: string } {
  if (!rawTarget.startsWith('/')) throw new Error('target phải bắt đầu bằng /');
  const href = new URL(hubOrigin + rawTarget).href;
  if (!href.startsWith(`${hubOrigin}/`)) throw new Error('target đổi origin'); // không thành open proxy
  return { url: href, target: href.slice(hubOrigin.length) };
}

/**
 * Target thô từ `request.url` của Worker: cắt scheme + host bằng thao tác chuỗi (KHÔNG `new URL().pathname+search`),
 * giữ `?` đứng một mình và percent-encoding y nguyên. Bỏ fragment (không bao giờ lên dòng request).
 */
export function rawTargetOf(requestUrl: string): string {
  const afterScheme = requestUrl.indexOf('://');
  const slash = requestUrl.indexOf('/', afterScheme < 0 ? 0 : afterScheme + 3);
  let t = slash < 0 ? '/' : requestUrl.slice(slash);
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  return t;
}

/**
 * So hằng thời gian. Workers có `crypto.subtle.timingSafeEqual` (non-standard, ném lỗi khi lệch độ dài -> kiểm độ dài
 * trước). Môi trường không có (Node khi test L0) -> vòng XOR không dừng sớm.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.byteLength; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
