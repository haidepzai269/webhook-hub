import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { bodyHashKey, timingSafeCompare } from '@hub/crypto';

function headerValue(req: RawWebhookRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.charAt(0).toUpperCase() + name.slice(1)];
  return Array.isArray(v) ? v[0] : v;
}
import { ulid } from 'ulidx';

export class SepayAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'sepay';

  /**
   * SePay KHÔNG ký nội dung; đây là API key dùng chung, gửi trong header
   * `Authorization: Apikey <key>` (S3-1). Bắt buộc đúng dạng: chữ `Apikey` không phân biệt
   * hoa thường, nhưng thiếu tiền tố -> false. So key bằng `timingSafeCompare`.
   */
  async verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean> {
    const authHeader = headerValue(req, 'authorization');
    if (!authHeader) return false;

    const m = /^apikey[ ]+(\S+)\s*$/i.exec(authHeader);
    if (!m) return false;
    const providedKey = m[1];

    let matched = false;
    for (const secret of secrets) {
      if (timingSafeCompare(secret, providedKey)) matched = true;
    }
    return matched;
  }

  extractIdempotencyKey(req: RawWebhookRequest): string {
    // Dự phòng = hash body (S3-1): không bao giờ ngẫu nhiên, SePay gửi lại vẫn ra cùng khoá.
    const id = req.body?.id || req.body?.referenceCode || bodyHashKey(req.rawBody);
    return `sepay:${id}`;
  }

  /** Bằng chứng là API key dùng chung -> chỉ lưu scheme, KHÔNG BAO GIỜ lưu key (ADR-051). */
  extractSignature(req: RawWebhookRequest): string | null {
    const authHeader = headerValue(req, 'authorization');
    if (!authHeader) return null;
    return /^apikey /i.test(authHeader) ? 'Apikey ***' : '***';
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
    const now = new Date().toISOString();
    const isTransferIn = body.transferType === 'in' || !body.transferType;
    const eventType = isTransferIn ? 'bank.transfer.received' : 'bank.transfer.sent';

    return [
      {
        id: `evt_${ulid()}`,
        tenantId: context.tenantId,
        type: eventType,
        source: 'sepay',
        sourceId: context.sourceId,
        subject: `bank:${body.accountNumber || 'account'}:${body.code || body.id}`,
        data: {
          id: body.id,
          gateway: body.gateway,
          transactionDate: body.transactionDate,
          accountNumber: body.accountNumber,
          code: body.code,
          content: body.content,
          transferType: body.transferType,
          transferAmount: Number(body.transferAmount || 0),
          accumulated: Number(body.accumulated || 0),
          referenceCode: body.referenceCode,
          description: body.description,
        },
        occurredAt: body.transactionDate || now,
        receivedAt: now,
        correlationId: context.correlationId,
        rawEventId: context.rawEventId,
        origin: 'webhook',
      },
    ];
  }

  buildAck(result: IngestResult): { status: number; body: unknown } {
    if (result.isDuplicate) {
      return { status: 200, body: { success: true, message: 'Duplicate transaction skipped' } };
    }
    if (!result.accepted) {
      return { status: result.status, body: { success: false, message: result.message } };
    }
    return { status: 200, body: { success: true } };
  }
}
