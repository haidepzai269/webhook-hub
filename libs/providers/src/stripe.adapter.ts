import Stripe from 'stripe';
import { AdapterContext, ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType, parseProviderTime } from '@hub/common';
import { NormalizeContext, amountOf, envelope, fallbackTxnId, receivedTime, str } from './normalize-helpers';
import { bodyHashKey } from '@hub/crypto';
import { STRIPE_PAYMENT_TYPES } from './stripe-types';
import { stripeConnector } from './connectors/stripe.connector';

/**
 * `stripe.webhooks.constructEvent()` chỉ tính HMAC-SHA256 cục bộ trên rawBody +
 * header `Stripe-Signature` — KHÔNG gọi Stripe API. API key dưới đây vì vậy
 * không bao giờ được dùng thật, chỉ tồn tại để thỏa constructor của SDK.
 */
const stripeClient = new Stripe('sk_placeholder_webhook_verify_only');

export class StripeAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'stripe';
  /** KN4 (SPEC-ket-noi §5.2): hub tự tạo webhook endpoint ở Stripe; Stripe sinh secret ký. */
  readonly connector = stripeConnector;

  /**
   * `secrets` là mảng signing secret (`whsec_...`) giải mã từ `source_secrets`
   * (hỗ trợ xoay secret — ARCHITECTURE.md). Thử lần lượt từng secret vì Stripe
   * chỉ chấp nhận đúng secret của endpoint tương ứng.
   */
  async verify(req: RawWebhookRequest, secrets: string[], ctx?: AdapterContext): Promise<boolean> {
    const sigHeader = req.headers['stripe-signature'] as string | undefined;
    if (!sigHeader) return false;
    // LH3 (H3, ADR-217): `ctx.verifyAt` = giờ lưới hứng nhận request (đã ký, body khớp) -> "bây giờ" của cửa sổ 5 phút. Tham
    // số `receivedAt` (ms) của CHÍNH `constructEvent` (stripe 22.6.2, Webhooks.js `validateComputedSignature`) — cùng hàm,
    // ADR-174 giữ nguyên. verifyAt hỏng (NaN) -> fail-closed: SDK coi NaN là "không quá hạn" nên phải chặn ở đây.
    const receivedAt = ctx?.verifyAt ? ctx.verifyAt.getTime() : undefined;
    if (receivedAt !== undefined && !Number.isFinite(receivedAt)) return false;

    for (const secret of secrets) {
      try {
        // Bắt buộc dùng rawBody (bytes), không phải req.body đã parse — CLAUDE.md.
        stripeClient.webhooks.constructEvent(req.rawBody, sigHeader, secret, undefined, undefined, receivedAt);
        return true;
      } catch {
        // Sai secret hoặc lệch tolerance (mặc định 5 phút) — thử secret kế tiếp.
        continue;
      }
    }
    return false;
  }

  extractIdempotencyKey(req: RawWebhookRequest): string {
    // Stripe Event.id (evt_...) ổn định giữa các lần Stripe gửi lại — chính là
    // idempotency key khuyến nghị bởi tài liệu Stripe.
    const eventId = req.body?.id;
    // Dự phòng = hash body (S3-1). KHÔNG dùng header chữ ký: nó chứa timestamp, lần gửi lại khác.
    return eventId ? `stripe:${eventId}` : `stripe:no-id:${bodyHashKey(req.rawBody)}`;
  }

  extractSignature(req: RawWebhookRequest): string | null {
    const v = req.headers['stripe-signature'];
    const s = Array.isArray(v) ? v[0] : v;
    return s ? String(s) : null;
  }

  /**
   * S3-2 (ADR-053): 3 kiểu Stripe có trong catalog thanh toán; mọi kiểu khác -> `stripe.<type gốc>`,
   * `normalized:false`, `data = { raw }`. Stripe vốn tính tiền theo đơn vị nhỏ nhất (cent).
   */
  normalize(req: RawWebhookRequest, context: NormalizeContext): NormalizedEvent[] {
    const body = req.body || {};
    const object = body.data?.object || {};
    const occurredAt = typeof body.created === 'number' ? parseProviderTime(body.created) : undefined;
    const id = `evt_${body.id || context.rawEventId}`;
    const map = STRIPE_PAYMENT_TYPES[body.type as string];

    if (!map) {
      return [
        envelope('stripe', context, {
          id,
          type: `stripe.${body.type || 'unknown'}`,
          subject: object.id ? `stripe:${object.id}` : undefined,
          data: { raw: body },
          occurredAt,
          normalized: false,
        }),
      ];
    }

    const at = occurredAt ?? receivedTime(context);
    const methodType = object.payment_method_types?.[0] ?? object.payment_method_details?.type;
    const providerTxnId = str(object.id) ?? fallbackTxnId(req.rawBody);
    const data: Record<string, unknown> = {
      amount: amountOf(object[map.amountField]),
      currency: typeof object.currency === 'string' ? object.currency.toUpperCase() : object.currency,
      method: methodType === 'card' ? 'card' : 'other',
      reference: str(object.id),
      memo: str(object.description),
      counterparty: null,
      account: null,
      providerTxnId,
      raw: body,
    };
    data[map.timeKey] = at;
    if (map.type === 'payment.failed') data.reason = str(object.last_payment_error?.message);

    return [
      envelope('stripe', context, {
        id,
        type: map.type,
        subject: `payment:${providerTxnId}`,
        data,
        occurredAt: at,
        normalized: true,
      }),
    ];
  }

  buildAck(result: IngestResult): { status: number; body: unknown } {
    if (result.isDuplicate) {
      return { status: 200, body: { received: true, duplicate: true } };
    }
    if (!result.accepted) {
      return { status: result.status, body: { error: result.message || 'Signature verification failed' } };
    }
    // Stripe chỉ cần 2xx; không đọc body, nhưng echo received:true theo convention.
    return { status: 200, body: { received: true } };
  }
}
