import { createHmac } from 'crypto';
import { IngestResult, NormalizedEvent, ProviderType, RawWebhookRequest, parseProviderTime, validateCanonical } from '@hub/common';
import { swVerify, timingSafeCompare } from '@hub/crypto';
import { AdapterContext, Diagnosis, ProviderAdapter, StoredRawEvent } from './provider.interface';
import { NormalizeContext, amountOf, envelope, str } from './normalize-helpers';
import { GenericConfig, MappingValue, paymentTimeKey, validateGenericConfig } from './generic-config';
import { IdempotencyKeyMissingError, MappingFieldMissingError } from './errors';

/**
 * S8 (SPEC §4.8, ADR-041 bậc 2): nguồn bên thứ ba mà hub CHƯA có adapter — service tự khai cách xác thực
 * (`hmac-sha256` | `static-token` | `standard-webhooks`), nơi lấy khoá chống trùng và kiểu sự kiện, lưu ở
 * `sources.verification_config`. Thêm nguồn mới KHÔNG sửa lõi: lõi chỉ chuyển `ctx.verificationConfig` qua.
 *
 * Mọi so sánh bí mật dùng timingSafeEqual; HMAC tính trên `rawBody` (bytes gốc), không bao giờ trên JSON đã parse.
 */
export class GenericAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'generic';

  async verify(req: RawWebhookRequest, secrets: string[], ctx?: AdapterContext): Promise<boolean> {
    const c = configOf(ctx);
    if (!c || secrets.length === 0) return false;
    if (c.scheme === 'standard-webhooks') return secrets.some((s) => swVerify(s, req.headers, req.rawBody));
    const presented = stripPrefix(headerOf(req, c.header!), c.prefix);
    if (presented === null) return false;
    let ok = false;
    for (const secret of secrets) {
      const expected = c.scheme === 'hmac-sha256' ? createHmac('sha256', secret).update(req.rawBody).digest(c.encoding ?? 'hex') : secret;
      // Không dừng sớm: thời gian không lộ secret nào khớp.
      if (timingSafeCompare(presented, expected)) ok = true;
    }
    return ok;
  }

  extractIdempotencyKey(req: RawWebhookRequest, ctx?: AdapterContext): string {
    const c = configOf(ctx);
    if (!c) throw new IdempotencyKeyMissingError('verificationConfig');
    const id = c.idempotency;
    let v: unknown;
    if ('header' in id) v = headerOf(req, id.header);
    else v = isObj(req.body) ? req.body[id.field] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
    if (typeof v !== 'string' || v.length === 0 || v.length > 200) {
      throw new IdempotencyKeyMissingError('header' in id ? `header ${id.header}` : `field ${id.field}`);
    }
    return `generic:${v}`;
  }

  /** hmac: chữ ký (không phải bí mật); static-token: CHE (token là bí mật dùng chung); standard-webhooks: webhook-signature. */
  extractSignature(req: RawWebhookRequest, ctx?: AdapterContext): string | null {
    const c = configOf(ctx);
    if (!c) return null;
    if (c.scheme === 'standard-webhooks') return headerOf(req, 'webhook-signature');
    const v = headerOf(req, c.header!);
    if (v === null) return null;
    return c.scheme === 'static-token' ? '***' : v;
  }

  /** Header chứa token static phải được che TRƯỚC khi lưu raw_events (redactHeaders chỉ biết danh sách cố định). */
  sensitiveHeaders(ctx?: AdapterContext): string[] {
    const c = configOf(ctx);
    return c?.scheme === 'static-token' && c.header ? [c.header] : [];
  }

  normalize(req: RawWebhookRequest, context: NormalizeContext): NormalizedEvent[] {
    const c = configOf(context);
    if (!c) throw new Error('GenericAdapter: source thiếu verificationConfig hợp lệ');
    const body = req.body;
    if (!c.mapping) {
      // Luật 3 §4.14.1: kiểu chưa ánh xạ -> data = { raw }, normalized:false.
      const raw = isObj(body) || Array.isArray(body) ? body : req.rawBody.toString('utf8');
      return [envelope('generic', context, { type: c.eventType, data: { raw }, normalized: false })];
    }
    if (!isObj(body)) throw new MappingFieldMissingError('body');
    const pick = (key: string, required: boolean): unknown => {
      const m: MappingValue | undefined = c.mapping![key];
      if (m === undefined) return null;
      if (typeof m === 'object') return m.const;
      const v = body[m];
      if (v === undefined || v === null || v === '') {
        if (required) throw new MappingFieldMissingError(m);
        return null;
      }
      return v;
    };
    const timeKey = paymentTimeKey(c.eventType)!;
    const providerTxnId = str(pick('providerTxnId', true));
    const rawTime = pick(timeKey, true) as string | number;
    let at: string;
    try {
      at = parseProviderTime(rawTime, c.timezone ?? '+07:00');
    } catch {
      // Sai định dạng thời gian = lỗi vĩnh viễn, nêu TÊN trường (không giá trị).
      throw new MappingFieldMissingError(c.mapping[timeKey] as string);
    }
    const data: Record<string, unknown> = {
      amount: amountOf(pick('amount', true)),
      currency: pick('currency', true),
      method: pick('method', true),
      reference: str(pick('reference', false)),
      memo: str(pick('memo', false)),
      counterparty: null,
      account: null,
      providerTxnId,
      raw: body,
      [timeKey]: at,
    };
    if (c.eventType === 'payment.failed') data.reason = str(pick('reason', false));
    return [
      envelope('generic', context, {
        type: c.eventType,
        subject: providerTxnId ? `payment:${providerTxnId}` : undefined,
        data,
        occurredAt: at,
        normalized: true,
      }),
    ];
  }

  /**
   * S9 (SPEC §4.8, §4.14.4): chẩn đoán raw_event ĐÃ LƯU cho chế độ lắng nghe — không cần secret, không bao giờ
   * trả giá trị (chỉ tên header/trường). REJECTED + signature_valid=true = chữ ký đúng nhưng thiếu khoá chống trùng.
   */
  diagnose(raw: StoredRawEvent, ctx?: AdapterContext): Diagnosis {
    const c = configOf(ctx);
    if (!c) return { ok: false, reason: 'config_invalid' };
    const headers = isObj(raw.headers) ? raw.headers : {};
    const has = (h: string) => typeof headers[h] === 'string' || Array.isArray(headers[h]);
    if (raw.status === 'ACCEPTED') return c.mapping ? this.diagnoseMapping(raw, c) : { ok: true, reason: 'ok' };
    if (raw.signatureValid) {
      const id = c.idempotency;
      return 'header' in id
        ? { ok: false, reason: 'missing_idempotency_key', expectedHeader: id.header }
        : { ok: false, reason: 'missing_idempotency_key', expectedField: id.field };
    }
    const candidates = (expected: string) =>
      Object.keys(headers)
        .map((h) => h.toLowerCase())
        .filter((h) => h !== expected && !h.startsWith('__') && /sig|token|auth|hmac|key/.test(h))
        .sort();
    if (c.scheme === 'standard-webhooks') {
      const missing = ['webhook-id', 'webhook-timestamp', 'webhook-signature'].find((h) => !has(h));
      if (missing) return { ok: false, reason: 'missing_header', expectedHeader: missing, candidateHeaders: candidates(missing) };
      const ts = Number(headers['webhook-timestamp']);
      const at = Math.floor(new Date(raw.receivedAt).getTime() / 1000);
      if (!Number.isFinite(ts) || Math.abs(at - ts) > 300) return { ok: false, reason: 'timestamp_out_of_range' };
      return { ok: false, reason: 'signature_mismatch', expectedHeader: 'webhook-signature' };
    }
    const expected = c.header!;
    if (!has(expected)) return { ok: false, reason: 'missing_header', expectedHeader: expected, candidateHeaders: candidates(expected) };
    return { ok: false, reason: c.scheme === 'static-token' ? 'token_mismatch' : 'signature_mismatch', expectedHeader: expected };
  }

  /** ACCEPTED có mapping: chạy lại ánh xạ + validator trên body đã lưu; báo TÊN trường body (không giá trị). */
  private diagnoseMapping(raw: StoredRawEvent, c: GenericConfig): Diagnosis {
    const req = { provider: this.provider, sourceKey: '', headers: {}, rawBody: Buffer.from(raw.bodyRaw), body: raw.body } as RawWebhookRequest;
    let data: unknown;
    try {
      data = this.normalize(req, { tenantId: '', sourceId: '', correlationId: '', rawEventId: '', verificationConfig: c })[0].data;
    } catch (e) {
      if (e instanceof MappingFieldMissingError) return { ok: false, reason: 'mapping_field_missing', field: e.field };
      return { ok: false, reason: 'mapping_field_invalid' };
    }
    const r = validateCanonical(c.eventType, data);
    if (r.ok) return { ok: true, reason: 'ok' };
    const key = (r as { field: string }).field;
    const m = c.mapping?.[key];
    return { ok: false, reason: 'mapping_field_invalid', field: typeof m === 'string' ? m : key };
  }

  buildAck(result: IngestResult): { status: number; body: unknown } {
    if (result.isDuplicate) return { status: 200, body: { ok: true, duplicate: true } };
    if (!result.accepted) return { status: result.status, body: { ok: false, error: result.message ?? 'rejected' } };
    return { status: 200, body: { ok: true } };
  }
}

function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Config đã lưu được kiểm LẠI mỗi lần dùng: dữ liệu DB hỏng không bao giờ làm verify "nhận bừa". */
function configOf(ctx?: AdapterContext): GenericConfig | null {
  if (!ctx || ctx.verificationConfig === undefined || ctx.verificationConfig === null) return null;
  const r = validateGenericConfig(ctx.verificationConfig);
  return r.ok ? (r as { config: GenericConfig }).config : null;
}

function headerOf(req: RawWebhookRequest, name: string): string | null {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

function stripPrefix(v: string | null, prefix?: string): string | null {
  if (v === null) return null;
  if (!prefix) return v;
  return v.startsWith(prefix) ? v.slice(prefix.length) : null;
}
