import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Phía NHẬN webhook của service (SPEC §4.7, §4.11): verify Standard Webhooks bằng `crypto` của Node — SDK không
 * import code nào của hub (dev bên ngoài cài `@hub/sdk` là đủ). Cùng thuật toán với libs/crypto/standard-webhooks
 * (test đối chiếu vector chuẩn README standard-webhooks).
 */
export const WEBHOOK_TOLERANCE_SEC = 300;

function headerOf(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : undefined;
}

function secretKey(signingSecret: string): Buffer {
  return signingSecret.startsWith('whsec_') ? Buffer.from(signingSecret.slice(6), 'base64') : Buffer.from(signingSecret, 'utf8');
}

/**
 * DX3: ba header Standard Webhooks cho `body` (bytes sẽ gửi) — `hub listen` ký y như hub push thật
 * (cùng thuật toán libs/crypto `swHeaders`, test đối chiếu chéo).
 */
export function signWebhook(signingSecret: string, msgId: string, body: string | Buffer, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  const mac = createHmac('sha256', secretKey(signingSecret));
  mac.update(`${msgId}.${ts}.`);
  mac.update(body);
  return { 'webhook-id': msgId, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${mac.digest('base64')}` };
}

/**
 * `rawBody` là BYTES gốc của request (express: `express.json({ verify: (req, _res, buf) => req.rawBody = buf })`),
 * KHÔNG phải JSON.stringify của body đã parse. Thiếu header / lệch > 300s / sai chữ ký -> false.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  headers: Record<string, unknown>,
  signingSecret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  const id = headerOf(headers, 'webhook-id');
  const ts = headerOf(headers, 'webhook-timestamp');
  const sigs = headerOf(headers, 'webhook-signature');
  if (!id || !ts || !sigs || !/^\d{1,12}$/.test(ts) || !signingSecret) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > (opts.toleranceSec ?? WEBHOOK_TOLERANCE_SEC)) return false;
  const mac = createHmac('sha256', secretKey(signingSecret));
  mac.update(`${id}.${ts}.`);
  mac.update(rawBody);
  const expected = Buffer.from(`v1,${mac.digest('base64')}`);
  let ok = false;
  for (const s of sigs.split(' ')) {
    const b = Buffer.from(s);
    if (b.length === expected.length && timingSafeEqual(b, expected)) ok = true;
  }
  return ok;
}

/**
 * Hub gửi `{"type":"endpoint.verification","challenge":"..."}` khi tạo endpoint / `/verify` (SPEC §4.7). Trả
 * `{challenge}` để service echo lại (200 JSON), body khác -> null. Request challenge CŨNG phải qua verifyWebhook.
 */
export function challengeResponse(body: unknown): { challenge: string } | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as { type?: unknown; challenge?: unknown };
  return b.type === 'endpoint.verification' && typeof b.challenge === 'string' && b.challenge.length > 0 ? { challenge: b.challenge } : null;
}

/**
 * PK5 (SPEC-provider-khac §7.2, ADR-206): sự kiện từ nguồn `unverified` ("đích tự kiểm") — hub nhận bằng URL bí mật, giữ
 * nguyên bytes và KHÔNG xác thực (`event.verified === false`). Hàm này trả đúng thứ SDK của provider cần để verify:
 * `rawBody` = bytes gốc (giải base64 `data.raw`, đúng từng byte), `headers` = các header gốc đã khai `forwardHeaders` (giá
 * trị nguyên văn), `url` = URL công khai lúc nhận (chỉ khi nguồn bật `forwardUrl`; không thì null).
 * KHÔNG verify thay: đích phải tự kiểm chữ ký gốc (và chống trùng nghiệp vụ theo id của provider) TRƯỚC khi tin.
 * Kiểm hai lớp: `verifyWebhook` (chữ ký của hub) rồi chữ ký gốc của provider trên kết quả này.
 */
export interface UnwrappedUnverified {
  rawBody: Buffer;
  headers: Record<string, string>;
  url: string | null;
  contentType: string | null;
  method: string;
}

export function unwrapUnverified(event: { verified?: boolean; data?: unknown }): UnwrappedUnverified {
  if (event?.verified !== false) throw new Error('unwrapUnverified: event is not from an unverified source (verified !== false)');
  const d = event.data as Record<string, unknown> | null | undefined;
  if (d === null || typeof d !== 'object' || typeof d.raw !== 'string') throw new Error('unwrapUnverified: event.data.raw (base64) is missing');
  const headers: Record<string, string> = {};
  if (d.headers !== null && typeof d.headers === 'object' && !Array.isArray(d.headers)) {
    for (const [k, v] of Object.entries(d.headers as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v;
  }
  return {
    rawBody: Buffer.from(d.raw, 'base64'),
    headers,
    url: typeof d.url === 'string' ? d.url : null,
    contentType: typeof d.contentType === 'string' ? d.contentType : null,
    method: typeof d.method === 'string' ? d.method : 'POST',
  };
}
