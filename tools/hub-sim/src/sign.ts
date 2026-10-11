/**
 * VF3 (SPEC-verification §5.1): thuật toán ký của provider, VIẾT LẠI ĐỘC LẬP theo tài liệu công khai.
 * KHÔNG import gì từ apps/, libs/, @hub (gate `sim-independent`): hub tự ký rồi tự verify thì cùng sai một kiểu
 * vẫn xanh. Ở đây chỉ dùng `crypto` của Node.
 *
 *   PayOS   HMAC-SHA256(checksumKey, "k1=v1&k2=v2…") trên `data` đã sort key, null -> '', mảng -> JSON
 *           (https://payos.vn/docs/du-lieu-tra-ve/webhook/) — chữ ký nằm TRONG body (`signature`).
 *   SePay   không ký: header `Authorization: Apikey <key>` (https://docs.sepay.vn/tich-hop-webhooks.html).
 *   Stripe  `Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw>")>` (docs.stripe.com/webhooks/signature).
 *   GitHub  `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw)>` (docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries).
 *   Generic HMAC-SHA256(secret, raw) hex|base64 + tiền tố tuỳ chọn, header do source khai.
 *   Standard Webhooks  `webhook-signature: v1,<base64 HMAC-SHA256(base64decode(secret sau "whsec_"), "<id>.<ts>.<raw>")>`
 *           (https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
 */
import { createHmac, timingSafeEqual } from 'crypto';

const hmac = (key: string | Buffer, data: string | Buffer, enc: 'hex' | 'base64' = 'hex') => createHmac('sha256', key).update(data).digest(enc);

/** PayOS: chuỗi `k=v&…` từ `data` (sort key tăng dần, bỏ undefined, null/"null"/"undefined" -> '', mảng -> JSON các phần tử đã sort key). */
export function payosCanonicalString(data: Record<string, unknown>): string {
  const sortKeys = (o: any) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : o);
  return Object.keys(data)
    .sort()
    .filter((k) => data[k] !== undefined)
    .map((k) => {
      let v: unknown = data[k];
      if (Array.isArray(v)) v = JSON.stringify(v.map(sortKeys));
      if (v === null || v === 'null' || v === 'undefined') v = '';
      return `${k}=${v}`;
    })
    .join('&');
}

export function payosSignature(data: Record<string, unknown>, checksumKey: string): string {
  return hmac(checksumKey, payosCanonicalString(data));
}

export function sepayAuthorization(apiKey: string, prefix = 'Apikey '): string {
  return `${prefix}${apiKey}`;
}

export function stripeSignatureHeader(rawBody: Buffer, secret: string, t: number): string {
  return `t=${t},v1=${hmac(secret, Buffer.concat([Buffer.from(`${t}.`), rawBody]))}`;
}

export function githubSignature256(rawBody: Buffer, secret: string): string {
  return `sha256=${hmac(secret, rawBody)}`;
}

export function genericHmac(rawBody: Buffer, secret: string, encoding: 'hex' | 'base64' = 'hex', prefix = ''): string {
  return `${prefix}${hmac(secret, rawBody, encoding)}`;
}

/** Khoá Standard Webhooks: `whsec_<base64>` -> bytes; không có tiền tố thì coi cả chuỗi là base64. */
export function swKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
}

export function swSign(secret: string, id: string, ts: number, rawBody: Buffer): string {
  return `v1,${hmac(swKey(secret), Buffer.concat([Buffer.from(`${id}.${ts}.`), rawBody]), 'base64')}`;
}

export function swHeaders(secret: string, id: string, ts: number, rawBody: Buffer): Record<string, string> {
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': swSign(secret, id, ts, rawBody) };
}

/**
 * Verify Standard Webhooks phía NHẬN, độc lập với hub — để L2 kiểm chữ ký push của hub mà không dùng code của hub.
 * Header có thể mang nhiều chữ ký cách nhau dấu cách (xoay secret). Lệch thời gian > toleranceS -> false.
 */
export function swVerify(secret: string, headers: Record<string, string | undefined>, rawBody: Buffer, nowS = Math.floor(Date.now() / 1000), toleranceS = 300): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sigs = headers['webhook-signature'];
  if (!id || !sigs || !Number.isFinite(ts) || Math.abs(nowS - ts) > toleranceS) return false;
  const expected = Buffer.from(swSign(secret, id, ts, rawBody).slice(3));
  let ok = false;
  for (const part of sigs.split(' ')) {
    const [v, sig] = part.split(',', 2);
    if (v !== 'v1' || !sig) continue;
    const got = Buffer.from(sig);
    if (got.length === expected.length && timingSafeEqual(got, expected)) ok = true;
  }
  return ok;
}

/** Đổi đúng MỘT ký tự (ký tự cuối) của chữ ký — ca "ký sai 1 ký tự". Giữ độ dài và bảng chữ. */
export function tamperOneChar(sig: string): string {
  const last = sig[sig.length - 1];
  const repl = last === '0' ? '1' : last === 'A' ? 'B' : last === 'a' ? 'b' : last === '=' ? '=' : '0';
  if (last === '=') return tamperOneChar(sig.slice(0, -1)) + '=';
  return sig.slice(0, -1) + repl;
}
