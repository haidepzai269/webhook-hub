import { PayOS } from '@payos/node';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType, parseProviderTime } from '@hub/common';
import { NormalizeContext, amountOf, envelope, fallbackTxnId, receivedTime, str } from './normalize-helpers';
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

  /**
   * S3-2 (ADR-053): ra kiểu chuẩn `payment.received` / `payment.failed` theo catalog
   * (`libs/common/src/canonical/payment.ts`). `orderCode` là từ vựng của PayOS -> chỉ còn trong
   * `data.raw` (BB-1); mã đơn của service nằm trong `memo` (description), service tự tìm.
   */
  normalize(req: RawWebhookRequest, context: NormalizeContext): NormalizedEvent[] {
    const body = req.body || {};
    const d = body.data || {};
    const ok = body.code === '00' && body.success !== false;
    const type = ok ? 'payment.received' : 'payment.failed';
    const at = d.transactionDateTime ? parseProviderTime(d.transactionDateTime) : receivedTime(context);
    const providerTxnId = str(d.paymentLinkId) ?? str(d.reference) ?? fallbackTxnId(req.rawBody);
    const cp = { name: str(d.counterAccountName), accountNumber: str(d.counterAccountNumber), bank: str(d.counterAccountBankName) };

    const data: Record<string, unknown> = {
      amount: amountOf(d.amount),
      currency: str(d.currency) ?? 'VND',
      method: 'payment_link',
      reference: str(d.reference),
      memo: str(d.description),
      counterparty: cp.name || cp.accountNumber || cp.bank ? cp : null,
      account: { number: str(d.accountNumber), bank: null },
      providerTxnId,
      raw: body,
    };
    if (ok) data.paidAt = at;
    else {
      data.failedAt = at;
      data.reason = str(body.desc) ?? str(d.desc);
    }

    return [
      envelope('payos', context, {
        type,
        subject: `payment:${providerTxnId}`,
        data,
        occurredAt: at,
        normalized: true,
      }),
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
