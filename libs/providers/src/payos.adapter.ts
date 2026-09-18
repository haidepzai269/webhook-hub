import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { hmacSha256, timingSafeCompare } from '@hub/crypto';
import { ulid } from 'ulidx';

export class PayosAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'payos';

  /**
   * Tạo chuỗi chữ ký PayOS bằng cách sort key data và nối key=value&...
   */
  private sortAndStringifyData(data: Record<string, any>): string {
    const sortedKeys = Object.keys(data).sort();
    return sortedKeys
      .map((k) => {
        let v = data[k];
        if (v === null || v === undefined) {
          v = '';
        }
        return `${k}=${v}`;
      })
      .join('&');
  }

  async verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean> {
    const body = req.body;
    if (!body || !body.data || !body.signature) {
      return false;
    }

    const dataString = this.sortAndStringifyData(body.data);

    for (const secret of secrets) {
      const computed = hmacSha256(secret, dataString);
      if (timingSafeCompare(computed, body.signature)) {
        return true;
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
