import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType, parseProviderTime } from '@hub/common';
import { bodyHashKey, timingSafeCompare } from '@hub/crypto';

function headerValue(req: RawWebhookRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.charAt(0).toUpperCase() + name.slice(1)];
  return Array.isArray(v) ? v[0] : v;
}
import { NormalizeContext, amountOf, envelope, fallbackTxnId, receivedTime, str } from './normalize-helpers';

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

  /**
   * S3-2 (ADR-053): `transferType` "in" (hoặc thiếu) -> `payment.received`, "out" -> `payment.sent`.
   * SePay không gửi thông tin người trả -> `counterparty = null`. Body gốc ở `data.raw`.
   */
  normalize(req: RawWebhookRequest, context: NormalizeContext): NormalizedEvent[] {
    const body = req.body || {};
    const isOut = body.transferType === 'out';
    const at = body.transactionDate ? parseProviderTime(body.transactionDate) : receivedTime(context);
    // SePay luôn gửi `id`; thiếu thì referenceCode, thiếu nữa thì hash body (không bao giờ null).
    const providerTxnId = str(body.id) ?? str(body.referenceCode) ?? fallbackTxnId(req.rawBody);

    const data: Record<string, unknown> = {
      amount: amountOf(body.transferAmount),
      currency: 'VND',
      method: 'bank_transfer',
      reference: str(body.referenceCode),
      memo: str(body.content),
      counterparty: null,
      account: { number: str(body.accountNumber), bank: str(body.gateway) },
      providerTxnId,
      raw: body,
    };
    data[isOut ? 'sentAt' : 'paidAt'] = at;

    return [
      envelope('sepay', context, {
        type: isOut ? 'payment.sent' : 'payment.received',
        subject: `payment:${providerTxnId}`,
        data,
        occurredAt: at,
        normalized: true,
      }),
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
