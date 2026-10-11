// P1 (ADR-141): tạo link thanh toán PayOS THẬT (POST /v2/payment-requests) bằng fetch + crypto, không thêm SDK.
import { createHmac } from 'crypto';
import { timingSafeCompare } from '@hub/crypto';

export interface PayosConfig { clientId: string; apiKey: string; checksumKey: string; apiBase: string }
export interface PayosLinkInput { orderCode: number; amount: number; description: string; returnUrl: string; cancelUrl: string; expiredAt: number }
export interface PayosLink { checkoutUrl: string; qrCode: string; paymentLinkId: string }

/** Cùng kênh PayOS với source của hub. Base API tên riêng của Shop (KHÔNG dùng PAYOS_BASE_URL — SDK của hub đọc nó). */
export function payosConfig(env: NodeJS.ProcessEnv = process.env): PayosConfig | null {
  const { PAYOS_CLIENT_ID: clientId, PAYOS_API_KEY: apiKey, PAYOS_CHECKSUM_KEY: checksumKey } = env;
  if (!clientId || !apiKey || !checksumKey) return null;
  return { clientId, apiKey, checksumKey, apiBase: (env.SHOP_PAYOS_API_BASE || 'https://api-merchant.payos.vn').replace(/\/$/, '') };
}

/** Chữ ký request: HMAC-SHA256(checksumKey) trên `amount&cancelUrl&description&orderCode&returnUrl` (thứ tự a→z). */
export function signPaymentRequest(i: PayosLinkInput, key: string): string {
  const s = `amount=${i.amount}&cancelUrl=${i.cancelUrl}&description=${i.description}&orderCode=${i.orderCode}&returnUrl=${i.returnUrl}`;
  return createHmac('sha256', key).update(s).digest('hex');
}

/** Chữ ký response: khoá của `data` sắp a→z, `k=v&…`, null -> "". So bằng timingSafeEqual (ADR-058). */
export function verifyResponse(data: Record<string, unknown>, signature: unknown, key: string): boolean {
  const s = Object.keys(data).sort().filter((k) => data[k] !== undefined).map((k) => `${k}=${data[k] ?? ''}`).join('&');
  return typeof signature === 'string' && timingSafeCompare(createHmac('sha256', key).update(s).digest('hex'), signature);
}

export async function createPaymentLink(cfg: PayosConfig, i: PayosLinkInput, fetchFn: typeof fetch = fetch): Promise<PayosLink> {
  const res = await fetchFn(`${cfg.apiBase}/v2/payment-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': cfg.clientId, 'x-api-key': cfg.apiKey },
    body: JSON.stringify({ ...i, signature: signPaymentRequest(i, cfg.checksumKey) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.code !== '00' || !body?.data) throw new Error(`PayOS ${res.status} ${body?.code ?? ''} ${body?.desc ?? ''}`.trim());
  if (!verifyResponse(body.data, body.signature, cfg.checksumKey)) throw new Error('PayOS: chữ ký phản hồi sai');
  return { checkoutUrl: body.data.checkoutUrl, qrCode: body.data.qrCode, paymentLinkId: body.data.paymentLinkId };
}
