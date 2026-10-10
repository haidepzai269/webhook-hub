import { PayOS } from '@payos/node';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { ulid } from 'ulidx';

export class PayosAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'payos';

  /**
   * Dùng SDK chính chủ PayOS (`@payos/node`) thay vì tự sort+nối key=value&...
   * bằng tay: cách PayOS ký (canonicalize data trước khi HMAC) không đơn giản
   * như HMAC-trên-raw-bytes của GitHub/Stripe — dễ sai với key null/số/thứ tự
   * sort — nên để chính PayOS xử lý phần canonicalization thay vì tự đoán lại.
   */
  async verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean> {
    const body = req.body;
    if (!body || !body.data || !body.signature) {
      return false;
    }

    for (const checksumKey of secrets) {
      try {
        // Constructor `PayOS` đòi `clientId`/`apiKey` non-empty dù `webhooks.verify()`
        // KHÔNG bao giờ gọi API (chỉ tính HMAC cục bộ bằng checksumKey) — 2 giá trị
        // dưới đây không bao giờ dùng thật, chỉ để thoả điều kiện constructor.
        const payos = new PayOS({
          clientId: 'placeholder_webhook_verify_only',
          apiKey: 'placeholder_webhook_verify_only',
          checksumKey,
        });
        await payos.webhooks.verify(body);
        return true;
      } catch {
        // Sai checksumKey (thử secret kế tiếp, hỗ trợ xoay secret) hoặc chữ ký
        // không hợp lệ (WebhookError) -> coi như không khớp.
        continue;
      }
    }
    return false;
  }

  extractIdempotencyKey(req: RawWebhookRequest): string {
    const data = req.body?.data || {};
    const orderCode = data.orderCode || 'unknown';
    const reference = data.reference || data.paymentLinkId || ulid();
    return `payos:${orderCode}:${reference}`;
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
