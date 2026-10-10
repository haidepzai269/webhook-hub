import { PayOS } from '@payos/node';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { ulid } from 'ulidx';
import { bodyHashKey, timingSafeCompare } from '@hub/crypto';

/**
 * Chỉ dùng phần `crypto` của SDK (tính chữ ký cục bộ, không gọi API). Constructor đòi
 * clientId/apiKey non-empty nên điền giá trị giả; checksumKey truyền theo từng lần gọi.
 */
const payosCrypto = new PayOS({
  clientId: 'placeholder_signature_only',
  apiKey: 'placeholder_signature_only',
  checksumKey: 'placeholder_signature_only',
}).crypto;

export class PayosAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'payos';

  /**
   * S3-1: chữ ký TÍNH bằng SDK chính chủ (`crypto.createSignatureFromObj` — sort key, bỏ null,
   * nối `k=v&...` rồi HMAC-SHA256), nhưng phép SO SÁNH là của ta (`timingSafeCompare` ->
   * `crypto.timingSafeEqual`). Không dùng `payos.webhooks.verify()` vì SDK so bằng `!==`
   * (`webhook.js:53`) — rò thời gian (CLAUDE.md: mọi so sánh chữ ký dùng timingSafeEqual).
   */
  async verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean> {
    const body = req.body;
    if (!body || typeof body.data !== 'object' || body.data === null || typeof body.signature !== 'string') {
      return false;
    }

    let matched = false;
    for (const checksumKey of secrets) {
      let expected: string | null = null;
      try {
        expected = await payosCrypto.createSignatureFromObj(body.data, checksumKey);
      } catch {
        expected = null;
      }
      // Không `return` sớm: thử đủ mọi secret (xoay secret) với cùng một kiểu so sánh.
      if (expected && timingSafeCompare(expected, body.signature)) matched = true;
    }
    return matched;
  }

  extractIdempotencyKey(req: RawWebhookRequest): string {
    const data = req.body?.data || {};
    const orderCode = data.orderCode || 'unknown';
    // Dự phòng = hash body (S3-1): PayOS gửi lại thì body y hệt -> khoá y hệt. Không bao giờ ngẫu nhiên.
    const reference = data.reference || data.paymentLinkId || bodyHashKey(req.rawBody);
    return `payos:${orderCode}:${reference}`;
  }

  extractSignature(req: RawWebhookRequest): string | null {
    const sig = req.body?.signature;
    return typeof sig === 'string' && sig ? sig : null;
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
    const data = req.body?.data || {};
    const now = new Date().toISOString();

    return [
      {
        id: `evt_${ulid()}`,
        tenantId: context.tenantId,
        type: 'payment.succeeded',
        source: 'payos',
        sourceId: context.sourceId,
        subject: `order:${data.orderCode}`,
        data: {
          orderCode: String(data.orderCode),
          amount: Number(data.amount || 0),
          currency: data.currency || 'VND',
          reference: data.reference,
          description: data.description,
          transactionDateTime: data.transactionDateTime,
          paymentLinkId: data.paymentLinkId,
        },
        occurredAt: data.transactionDateTime || now,
        receivedAt: now,
        correlationId: context.correlationId,
        rawEventId: context.rawEventId,
        origin: 'webhook',
      },
    ];
  }

  buildAck(result: IngestResult): { status: number; body: unknown } {
    if (result.isDuplicate) {
      return { status: 200, body: { code: '00', desc: 'success duplicate ignored', data: null } };
    }
    if (!result.accepted) {
      return { status: result.status, body: { code: '01', desc: result.message || 'error', data: null } };
    }
    return { status: 200, body: { code: '00', desc: 'success', data: null } };
  }
}
