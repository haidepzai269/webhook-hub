import Stripe from 'stripe';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { bodyHashKey } from '@hub/crypto';

/**
 * `stripe.webhooks.constructEvent()` chỉ tính HMAC-SHA256 cục bộ trên rawBody +
 * header `Stripe-Signature` — KHÔNG gọi Stripe API. API key dưới đây vì vậy
 * không bao giờ được dùng thật, chỉ tồn tại để thỏa constructor của SDK.
 */
const stripeClient = new Stripe('sk_placeholder_webhook_verify_only');

export class StripeAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'stripe';

  /**
   * `secrets` là mảng signing secret (`whsec_...`) giải mã từ `source_secrets`
   * (hỗ trợ xoay secret — ARCHITECTURE.md). Thử lần lượt từng secret vì Stripe
   * chỉ chấp nhận đúng secret của endpoint tương ứng.
   */
  async verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean> {
    const sigHeader = req.headers['stripe-signature'] as string | undefined;
    if (!sigHeader) return false;

    for (const secret of secrets) {
      try {
        // Bắt buộc dùng rawBody (bytes), không phải req.body đã parse — CLAUDE.md.
        stripeClient.webhooks.constructEvent(req.rawBody, sigHeader, secret);
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

  normalize(
    req: RawWebhookRequest,
    context: {
      tenantId: string;
      sourceId: string;
      correlationId: string;
      rawEventId: string;
    },
  ): NormalizedEvent[] {
    const body = req.body || {};
    const object = body.data?.object || {};
    const now = new Date().toISOString();

    return [
      {
        id: `evt_${body.id || context.rawEventId}`,
        tenantId: context.tenantId,
        // Giữ nguyên type gốc của Stripe (vd "payment_intent.succeeded") — đã là
        // enum ổn định, không cần tầng ánh xạ riêng trong lõi hub (BB-1).
        type: body.type || 'stripe.unknown',
        source: 'stripe',
        sourceId: context.sourceId,
        subject: object.id ? `stripe:${object.id}` : undefined,
        data: object,
        occurredAt: body.created ? new Date(body.created * 1000).toISOString() : now,
        receivedAt: now,
        correlationId: context.correlationId,
        rawEventId: context.rawEventId,
        origin: 'webhook',
      },
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
