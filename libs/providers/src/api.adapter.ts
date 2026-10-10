import { createHash } from 'crypto';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { NormalizeContext, envelope } from './normalize-helpers';

/** `raw_events.idempotency_key` là VARCHAR(255): `api:` + khoá ≤ 251 ký tự giữ nguyên, dài hơn thì băm (tất định). */
const MAX_PLAIN_KEY = 255 - 'api:'.length;

/**
 * S4 (SPEC §4.4): nguồn `api` = sự kiện do service TỰ phát qua `POST /v1/p/:project/events`.
 *
 * - `verify()` LUÔN false: `/hooks/api/<sourceKey>` không bao giờ nhận được gì từ ngoài. Xác thực của đường
 *   `/events` do `ApiKeyGuard` lo (key có scope `publish:events`, source gắn với key).
 * - `normalize()`: type/data/subject do service khai báo; `normalized: true` vì đó là hợp đồng của chính
 *   service (luật 2b §4.14.1). Kiểu dành riêng (`payment.*`, `repo.*`) đã qua validator ở controller (422).
 */
export class ApiAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'api';

  async verify(_req: RawWebhookRequest, _secrets: string[]): Promise<boolean> {
    return false;
  }

  extractIdempotencyKey(req: RawWebhookRequest): string {
    const k = String(req.body?.idempotencyKey ?? '');
    if (k.length <= MAX_PLAIN_KEY) return `api:${k}`;
    return `api:sha256:${createHash('sha256').update(k, 'utf8').digest('hex')}`;
  }

  /** Không có chữ ký: bằng chứng là API key (đã băm trong DB), không lưu gì vào signature_header. */
  extractSignature(_req: RawWebhookRequest): string | null {
    return null;
  }

  normalize(req: RawWebhookRequest, context: NormalizeContext): NormalizedEvent[] {
    const body = req.body || {};
    return [
      envelope('api', context, {
        type: String(body.type),
        subject: typeof body.subject === 'string' ? body.subject : undefined,
        data: body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {},
        normalized: true,
      }),
    ];
  }

  buildAck(result: IngestResult): { status: number; body: unknown } {
    if (result.isDuplicate) return { status: 200, body: { duplicate: true } };
    if (!result.accepted) return { status: result.status, body: { error: result.message ?? 'rejected' } };
    return { status: 202, body: { eventId: null, rawEventId: result.rawEventId, duplicate: false } };
  }
}
