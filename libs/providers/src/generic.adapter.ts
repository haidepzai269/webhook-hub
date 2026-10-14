import { createHmac } from 'crypto';
import { HttpMethod, IngestResult, NormalizedEvent, ProviderType, RawWebhookRequest, parseProviderTime, validateCanonical } from '@hub/common';
import { bodyHashKey, swHeaderSet, swVerify, timingSafeCompare } from '@hub/crypto';
import { AdapterContext, Diagnosis, HandshakeOutcome, HandshakePhase, ProviderAdapter, StoredRawEvent, VerifyResult } from './provider.interface';
import { NormalizeContext, amountOf, envelope, str } from './normalize-helpers';
import {
  GenericConfig,
  HMAC_ALGOS,
  HandshakeConfig,
  HandshakeWhen,
  HmacAlgo,
  MappingValue,
  UNVERIFIED_MAX_BODY_BYTES,
  decodeHmacKey,
  hmacParams,
  isHmacScheme,
  isUnverifiedScheme,
  paymentTimeKey,
  validateGenericConfig,
} from './generic-config';
import { kvHasKey, presentedSignatures, templateRequiredHeaders, verifySignedTemplate, withinTolerance } from './signed-template';
import { IdempotencyKeyMissingError, MappingFieldMissingError } from './errors';

/**
 * S8 (SPEC §4.8, ADR-041 bậc 2): nguồn bên thứ ba mà hub CHƯA có adapter — service tự khai cách xác thực
 * (`hmac` [+ bí danh `hmac-sha256`] | `static-token` | `standard-webhooks`), nơi lấy khoá chống trùng và kiểu sự kiện,
 * lưu ở `sources.verification_config`. Thêm nguồn mới KHÔNG sửa lõi: lõi chỉ chuyển `ctx.verificationConfig` qua.
 * PK2 (ADR-203): `hmac` có tham số algo/encoding/prefix/keyEncoding; `static-token` có location header|basic|query.
 * PK3 (ADR-204): `signed-template` — HMAC trên template `{timestamp}`/`{body}`/`{id}` (S4: Stripe, Slack, Paddle, Box…).
 * E2: `ctx.verifyAt` (nếu có) là "bây giờ" khi kiểm độ lệch timestamp — verify bù theo giờ nhận (PK6).
 *
 * Mọi so sánh bí mật dùng timingSafeEqual; HMAC tính trên `rawBody` (bytes gốc), không bao giờ trên JSON đã parse.
 */
export class GenericAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'generic';

  async verify(req: RawWebhookRequest, secrets: string[], ctx?: AdapterContext): Promise<VerifyResult> {
    const c = configOf(ctx);
    if (!c) return false;
    if (isUnverifiedScheme(c)) return verifyUnverified(req, ctx);
    return verifyWith(c, req, secrets, ctx);
  }

  /**
   * PK5 (E6, ADR-206): `unverified` lưu `__hub_meta` lúc nhận — `method`, và `url` (URL công khai do LÕI dựng từ
   * `HUB_PUBLIC_URL`, không từ `Host`) CHỈ khi `forwardUrl` (E18: URL chứa sourceKey). Worker chỉ đọc lại.
   */
  storedMeta(req: RawWebhookRequest, ctx?: AdapterContext): Record<string, unknown> | null {
    const c = configOf(ctx);
    if (!c || !isUnverifiedScheme(c)) return null;
    return { method: req.method ?? 'POST', ...(c.forwardUrl ? { url: ctx?.publicUrl?.() ?? null } : {}) };
  }

  /**
   * PK4 (§6.2, E27): POST luôn được. GET CHỈ khi source khai `query-echo` VÀ request mang đúng MỘT tham số `param` — GET là
   * để bắt tay, không để nhận sự kiện (§15). HEAD CHỈ khi source khai `head-ok` (ADR-205 bổ sung, sửa E27: Intercom kiểm URL
   * bằng HEAD) — lõi trả 200 rỗng, không bao giờ verify/persist. Method khác -> false (lõi trả 405, không ghi DB, không phạt).
   */
  acceptsMethod(method: HttpMethod, ctx?: AdapterContext, req?: RawWebhookRequest): boolean {
    if (method === 'POST') return true;
    const h = configOf(ctx)?.handshake;
    if (method === 'HEAD') return h?.kind === 'head-ok';
    if (method !== 'GET') return false;
    return h?.kind === 'query-echo' && queryValues(req?.query, h.param).length === 1;
  }

  /**
   * PK4 (§6.1, E3/E9/E13/E27, ADR-205): bắt tay theo `handshake` của source. `before-verify` (2h): query/body/header-echo,
   * manual-url. `after-verify` (3h, lõi chỉ gọi khi verify QUA): hmac-echo — ký `plainToken` bằng đúng secret đã verify; và
   * body-echo / manual-url có `afterVerify: true` (review PK4 T-1: provider KÝ request bắt tay — Slack, Twitch — thì kẻ biết
   * sourceKey không giả được "Đã bắt tay ✓" hay cấy SubscribeURL).
   * Echo chỉ trả `^[\x21-\x7E]{1,256}$` dạng `text/plain; charset=utf-8` (E27), hoặc JSON `{<field>: echo}` khi `respond: 'json'`.
   */
  handshake(req: RawWebhookRequest, secrets: string[], ctx: AdapterContext | undefined, phase: HandshakePhase): HandshakeOutcome | null {
    const h = configOf(ctx)?.handshake;
    if (!h) return null;
    const method = req.method ?? 'POST';
    if (phase === 'after-verify') {
      if (method !== 'POST') return null;
      if (h.kind === 'hmac-echo') return whenMatches(h.when, req) ? hmacEcho(h, req, secrets, ctx) : null;
      return runsAfterVerify(h) ? this.postHandshake(h, req, ctx) : null;
    }
    if (h.kind === 'query-echo') {
      if (method !== 'GET') return null;
      const challenge = queryValues(req.query, h.param);
      if (challenge.length !== 1) return null;
      if (h.verifyTokenParam !== undefined) {
        // E13: token so khớp nằm ở `verifyTokenEnc` (AES-GCM), KHÔNG phải SourceSecret — không bao giờ thành khoá HMAC.
        const presented = queryValues(req.query, h.verifyTokenParam);
        const expected = h.verifyTokenEnc && ctx?.openSealed ? ctx.openSealed(h.verifyTokenEnc) : null;
        if (presented.length !== 1 || !expected || !timingSafeCompare(presented[0], expected)) return { kind: 'reject' };
      }
      return echoText(challenge[0], { kind: h.kind });
    }
    if (method !== 'POST' || runsAfterVerify(h)) return null;
    return this.postHandshake(h, req, ctx);
  }

  /** Bắt tay qua POST (header-echo, body-echo, manual-url) — pha do `handshake` quyết. hmac-echo/head-ok/query-echo -> null. */
  private postHandshake(h: HandshakeConfig, req: RawWebhookRequest, ctx: AdapterContext | undefined): HandshakeOutcome | null {
    if (h.kind === 'header-echo') {
      const v = headerOf(req, h.header);
      if (v === null) return null;
      // Review PK4 TB-2: request mang chữ ký của cấu hình là SỰ KIỆN (đi verify), không phải bắt tay — nhầm header bắt tay
      // (Asana `x-hook-signature` thay `x-hook-secret`) không được nuốt sự kiện thật (200 không COMMIT).
      if (this.extractSignature(req, ctx) !== null) return null;
      if (!ECHO_RE.test(v)) return { kind: 'invalid', message: `giá trị header ${h.header} ngoài tập ký tự cho phép (ASCII in được, ≤ 256)` };
      return { kind: 'respond', status: 200, body: null, headers: { [h.header]: v }, meta: { kind: h.kind } };
    }
    if (h.kind === 'body-echo') {
      if (!whenMatches(h.when, req)) return null;
      const v = bodyObject(req)?.[h.echo.field];
      if (typeof v !== 'string') return { kind: 'invalid', message: `body thiếu trường chuỗi ${h.echo.field} để trả lại` };
      return h.respond === 'json' ? echoJson(h.echo.field, v, { kind: h.kind }) : echoText(v, { kind: h.kind });
    }
    if (h.kind === 'manual-url') {
      if (!whenMatches(h.when, req)) return null;
      const url = bodyObject(req)?.[h.urlField];
      // Hub KHÔNG gọi URL lấy từ request (SSRF, §15) — chỉ lưu để console hiện cho dev tự bấm. Chỉ https, ≤ 1024 ký tự (review
      // PK4 T-2: dòng bắt tay chỉ lưu meta ≤ 1KB).
      const shown = typeof url === 'string' && url.length <= SUBSCRIBE_URL_MAX && /^https:\/\/[^\s]+$/.test(url) ? url : null;
      return { kind: 'respond', status: 200, body: null, meta: { kind: h.kind, subscribeUrl: shown } };
    }
    return null; // hmac-echo: chỉ sau verify (E3); head-ok: lõi tự trả HEAD
  }

  extractIdempotencyKey(req: RawWebhookRequest, ctx?: AdapterContext): string {
    const c = configOf(ctx);
    if (!c) throw new IdempotencyKeyMissingError('verificationConfig');
    const id = c.idempotency;
    // PK5 (E7): `unverified` — chưa ai verify mà chống trùng theo id của provider thì kẻ biết sourceKey gửi trước một body
    // giả mang id thật là NUỐT được sự kiện thật (DUPLICATE, 200, provider không gửi lại). Khoá luôn ghép băm bytes:
    // chỉ bản trùng ĐÚNG TỪNG BYTE mới là trùng. Không ngẫu nhiên. Đích tự chống trùng nghiệp vụ sau khi verify.
    if (isUnverifiedScheme(c) && !id) return `generic:${bodyHashKey(req.rawBody)}`;
    if (!id) throw new IdempotencyKeyMissingError('verificationConfig.idempotency');
    let v: unknown;
    if ('header' in id) v = headerOf(req, idempotencyHeader(c, req.headers));
    else v = isObj(req.body) ? req.body[id.field] : isUnverifiedScheme(c) ? bodyObject(req)?.[id.field] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
    if (typeof v !== 'string' || v.length === 0 || v.length > 200) {
      throw new IdempotencyKeyMissingError('header' in id ? `header ${id.header}` : `field ${id.field}`);
    }
    return isUnverifiedScheme(c) ? `generic:${v}:${bodyHashKey(req.rawBody)}` : `generic:${v}`;
  }

  /**
   * hmac: chữ ký (không phải bí mật); static-token: CHE (token là bí mật dùng chung — kể cả basic và query, PK2);
   * standard-webhooks: webhook-signature; signed-template (PK3): giá trị header chữ ký (kv: cả header `t=…,v1=…`;
   * nhiều header: header đầu tiên có mặt).
   */
  extractSignature(req: RawWebhookRequest, ctx?: AdapterContext): string | null {
    const c = configOf(ctx);
    if (!c) return null;
    // PK5: `unverified` không có chữ ký của hub — header chữ ký gốc (nếu có) đi trong `data.headers` (forwardHeaders).
    if (isUnverifiedScheme(c)) return null;
    if (isStandardWebhooks(c)) return headerOf(req, swHeaderSet(req.headers).signature); // PK1: webhook-* hoặc svix-*
    if (isStaticToken(c)) return presentedToken(c, req) ? '***' : null;
    if (isSignedTemplate(c)) {
      for (const h of templateRequiredHeaders(c).signature) {
        const v = headerOf(req, h);
        if (v !== null) return v;
      }
      return null;
    }
    return headerOf(req, c.header!);
  }

  /**
   * Header chứa token static phải được che TRƯỚC khi lưu raw_events (redactHeaders chỉ biết danh sách cố định).
   * PK2: basic -> `authorization` (đã có trong danh sách cố định, khai lại cho rõ). Token ở query KHÔNG nằm trong header:
   * lõi không lưu query ở đâu cả (raw_events chỉ có headers + body), log của hub không in URL (E6, `[PK:T7]`).
   * Review PK2 T-2: access log nginx dùng `$uri` (không query), NHƯNG error_log của nginx (cầu chì `limit_req`, upstream
   * timeout/502) in nguyên request line kèm query — token có thể lọt vào log nền tảng lúc đó. Nginx không che được query
   * trong error_log -> khuyên dùng tiêu đề hoặc Basic thay query khi provider cho phép (console nhắc, ADR-203).
   */
  sensitiveHeaders(ctx?: AdapterContext): string[] {
    const c = configOf(ctx);
    if (!c) return [];
    // PK4: header của `header-echo` (Asana X-Hook-Secret) mang bí mật -> che trước khi lưu dòng bắt tay.
    const echoed = c.handshake?.kind === 'header-echo' ? [c.handshake.header] : [];
    if (!isStaticToken(c)) return echoed;
    if (c.location === 'basic') return ['authorization', ...echoed];
    return [...(c.header ? [c.header] : []), ...echoed];
  }

  normalize(req: RawWebhookRequest, context: NormalizeContext): NormalizedEvent[] {
    const c = configOf(context);
    if (!c) throw new Error('GenericAdapter: source thiếu verificationConfig hợp lệ');
    const body = req.body;
    if (isUnverifiedScheme(c)) return [envelope('generic', context, { type: c.eventType, data: unverifiedData(c, req), normalized: false })];
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
      if (!id) return { ok: false, reason: 'missing_idempotency_key' };
      return 'header' in id
        ? { ok: false, reason: 'missing_idempotency_key', expectedHeader: idempotencyHeader(c, headers) }
        : { ok: false, reason: 'missing_idempotency_key', expectedField: id.field };
    }
    const candidates = (expectedHeader: string) =>
      Object.keys(headers)
        .map((h) => h.toLowerCase())
        .filter((h) => h !== expectedHeader && !h.startsWith('__') && CANDIDATE_HEADER_RE.test(h))
        .sort();
    if (c.scheme === 'standard-webhooks') {
      // PK1 (ADR-202): chẩn đoán theo bộ header ĐANG CÓ (webhook-* hoặc svix-*), không trộn.
      const set = swHeaderSet(headers);
      const missing = [set.id, set.timestamp, set.signature].find((h) => !has(h));
      if (missing) return { ok: false, reason: 'missing_header', expectedHeader: missing, candidateHeaders: candidates(missing) };
      const ts = Number(headers[set.timestamp]);
      const at = Math.floor(new Date(raw.receivedAt).getTime() / 1000);
      if (!Number.isFinite(ts) || Math.abs(at - ts) > 300) return { ok: false, reason: 'timestamp_out_of_range' };
      return { ok: false, reason: 'signature_mismatch', expectedHeader: set.signature };
    }
    if (isSignedTemplate(c)) return diagnoseTemplate(c, headers, raw, has, candidates);
    // PK5: `unverified` không bao giờ từ chối vì chữ ký (cờ project tắt / quá trần không ghi dòng nào).
    if (isUnverifiedScheme(c)) return { ok: false, reason: 'config_invalid' };
    // PK2: query không được lưu (che tuyệt đối) -> chỉ nói TÊN tham số, không phân biệt thiếu hay sai.
    if (isStaticToken(c) && c.location === 'query') return { ok: false, reason: 'token_mismatch', expectedQueryParam: c.param };
    const expected = isStaticToken(c) && c.location === 'basic' ? 'authorization' : c.header!;
    if (!has(expected)) return { ok: false, reason: 'missing_header', expectedHeader: expected, candidateHeaders: candidates(expected) };
    const reason = isStaticToken(c) ? 'token_mismatch' : 'signature_mismatch';
    return { ok: false, reason, expectedHeader: expected };
  }

  /** ACCEPTED có mapping: chạy lại ánh xạ + validator trên body đã lưu; báo TÊN trường body (không giá trị). */
  private diagnoseMapping(raw: StoredRawEvent, c: GenericConfig): Diagnosis {
    // Nhánh có mapping chỉ đọc `body` đã parse — inspect không nạp `body_raw` (review PK1 T-4) -> Buffer rỗng là đủ.
    const req = { provider: this.provider, sourceKey: '', headers: {}, rawBody: Buffer.from(raw.bodyRaw ?? []), body: raw.body } as RawWebhookRequest;
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

  /**
   * PK4 §6.3: `successStatus` (200|202|204; 204 không body) và `rejectStatus` (401|403|503) theo `ack` của source.
   * Lõi vẫn kẹp: từ chối chỉ nhận 401/403/503, không bao giờ 2xx.
   */
  buildAck(result: IngestResult, ctx?: AdapterContext): { status: number; body: unknown } {
    const ack = configOf(ctx)?.ack;
    if (result.accepted) {
      const status = ack?.successStatus ?? 200;
      if (status === 204) return { status, body: null };
      return { status, body: result.isDuplicate ? { ok: true, duplicate: true } : { ok: true } };
    }
    // DX1 §2.1 (ngoại lệ duy nhất ở /hooks): người đọc ack của nguồn tuỳ chỉnh là DEV đang cấu hình -> kèm `fix`.
    const status = result.status === 401 ? (ack?.rejectStatus ?? 401) : result.status;
    const fix = result.message === UNVERIFIED_DISABLED ? UNVERIFIED_DISABLED_FIX : genericAckFix(result.status);
    return { status, body: { ok: false, error: result.message ?? 'rejected', fix } };
  }
}

/** Gợi ý sửa cho dev cấu hình nguồn tuỳ chỉnh — chỉ theo status, KHÔNG chứa giá trị header/secret/body. */
export function genericAckFix(status: number): string {
  if (status === 401) {
    return 'Signature/token did not verify. Check the source verificationConfig (scheme, header, encoding) and the secret; HMAC is computed over the raw body bytes. Use the source listening mode (console → Sources → Inspect) to see the diagnosis.';
  }
  if (status === 422) return 'No idempotency key: configure "idempotency" (a body field or header that is unique per event) on the source.';
  if (status === 413) return 'Body too large: send at most 1MB per request.';
  if (status === 429) return 'Rate limited: slow down and retry later.';
  if (status === 404) return 'Unknown or disabled source: check the webhook URL (/hooks/generic/<sourceKey>) in the console.';
  return 'See docs/ERRORS.md and the source listening mode in the console.';
}

/**
 * PK1 (ADR-202): khoá chống trùng mặc định của standard-webhooks là `webhook-id` = "id của bộ header đang dùng" —
 * request Svix mang `svix-id` (cùng ngữ nghĩa message id). Header khoá tự khai khác thì giữ nguyên.
 */
function idempotencyHeader(c: GenericConfig, headers: Record<string, unknown>): string {
  const h = (c.idempotency as { header: string } | undefined)?.header ?? '';
  return isStandardWebhooks(c) && h === 'webhook-id' ? swHeaderSet(headers).id : h;
}
/**
 * PK3: chẩn đoán `signed-template` theo thứ tự verify: thiếu header chữ ký -> thiếu timestamp -> lệch giờ (so với
 * `received_at` của dòng, không phải "bây giờ" — dòng cũ không tự thành lệch) -> thiếu id -> sai chữ ký.
 */
function diagnoseTemplate(
  c: GenericConfig,
  headers: Record<string, unknown>,
  raw: StoredRawEvent,
  has: (h: string) => boolean,
  candidates: (expected: string) => string[],
): Diagnosis {
  const req = templateRequiredHeaders(c);
  if (!req.signature.some(has)) return { ok: false, reason: 'missing_header', expectedHeader: req.signature[0], candidateHeaders: candidates(req.signature[0]) };
  const presented = presentedSignatures(c, headers);
  if (c.toleranceSec !== undefined) {
    if (req.timestamp !== null && !has(req.timestamp)) return { ok: false, reason: 'missing_header', expectedHeader: req.timestamp, candidateHeaders: candidates(req.timestamp) };
    // Review PK3 T-6: dạng kv thiếu hẳn khoá timestamp -> nói tên khoá thiếu (không phải "lệch giờ").
    const kvTs = 'kv' in c.signature! ? c.signature.kv.timestamp : undefined;
    if (kvTs !== undefined && !kvHasKey(c, headers, kvTs)) return { ok: false, reason: 'missing_kv_key', expectedHeader: req.signature[0], expectedKvKey: kvTs };
    if (!withinTolerance(c, presented.timestamp, new Date(raw.receivedAt).getTime() / 1000)) return { ok: false, reason: 'timestamp_out_of_range', expectedHeader: req.timestamp ?? req.signature[0] };
  }
  if (req.id !== null && !has(req.id)) return { ok: false, reason: 'missing_header', expectedHeader: req.id, candidateHeaders: candidates(req.id) };
  return { ok: false, reason: 'signature_mismatch', expectedHeader: req.signature[0] };
}

/** Tên header "trông như" mang bằng chứng xác thực — chỉ để gợi ý trong chẩn đoán, không bao giờ kèm giá trị. */
const CANDIDATE_HEADER_RE = /sig|token|auth|hmac|key/;
const isStandardWebhooks = (c: GenericConfig) => c.scheme === 'standard-webhooks';
const isStaticToken = (c: GenericConfig) => c.scheme === 'static-token';
const isSignedTemplate = (c: GenericConfig) => c.scheme === 'signed-template';

/**
 * PK2: `sha256=abc` -> ['sha256','abc']; thuật toán ngoài `HMAC_ALGOS` (md5=, sha384=) -> null (trượt, không ném).
 * Review PK2 T-3: còn phải nằm trong `allowed` (`algos` của config, mặc định sha256 + sha512) — sha1 chỉ khi khai rõ.
 */
const ALGO_PREFIX_RE = /^([a-z0-9]{1,16})=([\s\S]*)$/;
function splitAlgoPrefix(v: string, allowed: readonly HmacAlgo[]): { algo: HmacAlgo; presented: string } | null {
  const m = ALGO_PREFIX_RE.exec(v);
  if (!m || !HMAC_ALGOS.includes(m[1] as HmacAlgo) || !allowed.includes(m[1] as HmacAlgo)) return null;
  return { algo: m[1] as HmacAlgo, presented: m[2] };
}

/**
 * PK2 (ADR-203): HMAC(algo, key(secret, keyEncoding), rawBody) mã hoá `encoding`, so bằng timingSafeEqual với phần sau
 * tiền tố. sha1 vẫn so constant-time. Secret giải mã hỏng -> bỏ qua secret đó (không nhận bừa, không ném).
 */
function verifyMac(c: GenericConfig, req: RawWebhookRequest, secrets: string[]): boolean {
  const p = hmacParams(c);
  const raw = headerOf(req, c.header!);
  if (raw === null) return false;
  let algo: HmacAlgo;
  let presented: string | null;
  if (p.algo) {
    algo = p.algo;
    presented = stripPrefix(raw, p.prefix);
  } else {
    const split = splitAlgoPrefix(raw, p.algos ?? []);
    if (!split) return false;
    ({ algo, presented } = split);
  }
  if (presented === null) return false;
  let ok = false;
  for (const secret of secrets) {
    const key = decodeHmacKey(secret, p.keyEncoding);
    if (!key) continue;
    const expected = createHmac(algo, key).update(req.rawBody).digest(p.encoding);
    // Không dừng sớm: thời gian không lộ secret nào khớp.
    if (timingSafeCompare(presented, expected)) ok = true;
  }
  return ok;
}

/**
 * PK2: token request trình ra, theo `location`. header: giá trị header (bỏ prefix). basic: phần sau `Basic ` của
 * Authorization (so với base64 của "user:pass" — so chuỗi đã mã hoá, không giải mã lỏng). query: tham số `param` của
 * chuỗi query thô (E6, URLSearchParams); xuất hiện khác đúng 1 lần -> null (không đoán bản nào là thật).
 */
function presentedToken(c: GenericConfig, req: RawWebhookRequest): string | null {
  if (c.location === 'query') {
    const all = new URLSearchParams(req.query ?? '').getAll(c.param!);
    return all.length === 1 && all[0].length > 0 ? all[0] : null;
  }
  if (c.location === 'basic') {
    const m = /^Basic +([A-Za-z0-9+/=]+)$/i.exec(headerOf(req, 'authorization') ?? '');
    return m ? m[1] : null;
  }
  return stripPrefix(headerOf(req, c.header!), c.prefix);
}

/** Giá trị ĐÚNG của token: chính secret, hoặc base64("user:pass") với basic. */
function expectedToken(c: GenericConfig, secret: string): string {
  return c.location === 'basic' ? Buffer.from(secret, 'utf8').toString('base64') : secret;
}

function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Verify ĐỒNG BỘ (không I/O) theo config đã kiểm — `verify` bọc lại; hmac-echo (PK4) gọi cho từng secret để ký bằng đúng
 * secret đã verify request bắt tay.
 */
function verifyWith(c: GenericConfig, req: RawWebhookRequest, secrets: string[], ctx?: AdapterContext): boolean {
  // PK5: `unverified` không bao giờ "verify qua" theo nghĩa chữ ký (hmac-echo, đối chiếu secret) — fail-closed.
  if (secrets.length === 0 || isUnverifiedScheme(c)) return false;
  const nowMs = ctx?.verifyAt ? ctx.verifyAt.getTime() : Date.now();
  // Review PK3 T-2: `verifyAt` không hợp lệ (Invalid Date -> NaN) thì không có "bây giờ" để kiểm độ lệch -> fail-closed.
  if (!Number.isFinite(nowMs)) return false;
  if (c.scheme === 'standard-webhooks') {
    const opts = { nowSec: Math.floor(nowMs / 1000) };
    return secrets.some((s) => swVerify(s, req.headers, req.rawBody, opts));
  }
  if (isSignedTemplate(c)) return verifySignedTemplate(c, req, secrets, nowMs);
  if (isHmacScheme(c)) return verifyMac(c, req, secrets);
  const presented = presentedToken(c, req);
  if (presented === null) return false;
  let ok = false;
  for (const secret of secrets) {
    // Không dừng sớm: thời gian không lộ secret nào khớp.
    if (timingSafeCompare(presented, expectedToken(c, secret))) ok = true;
  }
  return ok;
}

// ───────────────────────── PK4: bắt tay (SPEC-provider-khac §6, ADR-205) ─────────────────────────

/** E27: giá trị echo — ASCII in được, 1–256 ký tự (không khoảng trắng, không CR/LF -> không chèn header); trả text/plain + nosniff. */
type MacEcho = Extract<HandshakeConfig, { kind: 'hmac-echo' }>;
/** Review PK4 T-1: body-echo / manual-url có `afterVerify: true` chạy ở pha after-verify (provider ký request bắt tay). */
const runsAfterVerify = (h: HandshakeConfig): boolean => (h.kind === 'body-echo' || h.kind === 'manual-url') && h.afterVerify === true;
/** Review PK4 T-2: link SubscribeURL lưu trong meta dòng bắt tay — dòng chỉ giữ meta ≤ 1KB. */
export const SUBSCRIBE_URL_MAX = 1024;
const ECHO_RE = /^[\x21-\x7E]{1,256}$/;
/** E3: plainToken của hmac-echo — không `:`/`{`/`.` nên không bao giờ trùng khuôn chuỗi ký sự kiện (`v0:{ts}:{body}`). */
export const HMAC_ECHO_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Mọi giá trị của tham số `name` trong chuỗi query thô (E6). */
function queryValues(query: string | undefined, name: string): string[] {
  return new URLSearchParams(query ?? '').getAll(name);
}

/** Body dạng object: đã parse (JSON/form) hoặc tự parse bytes gốc (SNS gửi JSON với `text/plain`, E1). */
function bodyObject(req: RawWebhookRequest): Record<string, unknown> | null {
  if (isObj(req.body)) return req.body;
  if (req.rawBody.length === 0 || req.rawBody.length > 1024 * 1024 || req.rawBody[0] !== 0x7b) return null;
  try {
    const v = JSON.parse(req.rawBody.toString('utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** `when` — một cặp hằng (E16): trường cấp một của body hoặc header bằng đúng giá trị khai. Giá trị không bí mật. */
function whenMatches(w: HandshakeWhen, req: RawWebhookRequest): boolean {
  const v = 'header' in w ? headerOf(req, w.header) : bodyObject(req)?.[w.field];
  return typeof v === 'string' && v === w.equals;
}

/** ADR-205 bổ sung: `respond: 'json'` (monday) — `{<field>: v}` application/json, CÙNG tập ký tự ECHO_RE; khoá là tên trường đã khai. */
function echoJson(field: string, v: string, meta: Record<string, unknown>): HandshakeOutcome {
  if (!ECHO_RE.test(v)) return { kind: 'invalid', message: 'giá trị cần trả lại ngoài tập ký tự cho phép (ASCII in được, 1–256 ký tự)' };
  return { kind: 'respond', status: 200, body: { [field]: v }, contentType: 'application/json', headers: { 'X-Content-Type-Options': 'nosniff' }, meta };
}

function echoText(v: string, meta: Record<string, unknown>): HandshakeOutcome {
  if (!ECHO_RE.test(v)) return { kind: 'invalid', message: 'giá trị cần trả lại ngoài tập ký tự cho phép (ASCII in được, 1–256 ký tự)' };
  return {
    kind: 'respond',
    status: 200,
    body: v,
    contentType: 'text/plain; charset=utf-8',
    headers: { 'X-Content-Type-Options': 'nosniff' },
    meta,
  };
}

/**
 * E3: Zoom `endpoint.url_validation`. Lõi chỉ gọi khi request ĐÃ verify qua theo scheme của source, nên kẻ biết sourceKey
 * không xin được chữ ký. plainToken khoá bằng regex (không `:`/`{`) -> không trùng khuôn chuỗi ký của sự kiện.
 * Ký bằng secret ĐÃ verify request này (xoay khoá: secret mới và cũ cùng hiệu lực, chọn đúng cái provider đang dùng).
 */
function hmacEcho(h: MacEcho, req: RawWebhookRequest, secrets: string[], ctx: AdapterContext | undefined): HandshakeOutcome {
  const b = bodyObject(req);
  const holder = h.tokenParent !== undefined ? b?.[h.tokenParent] : b;
  const token = isObj(holder) ? holder[h.tokenField] : undefined;
  if (typeof token !== 'string' || !HMAC_ECHO_TOKEN_RE.test(token)) {
    return { kind: 'invalid', message: `${h.tokenField} phải khớp ^[A-Za-z0-9_-]{1,128}$` };
  }
  const c = configOf(ctx)!;
  const key = secrets.find((s) => verifyWith(c, req, [s], ctx));
  if (key === undefined) return { kind: 'reject' };
  const mac = createHmac('sha256', Buffer.from(key, 'utf8')).update(token, 'utf8').digest('hex');
  return { kind: 'respond', status: 200, body: { [h.tokenField]: token, [h.macField]: mac }, contentType: 'application/json', meta: { kind: h.kind } };
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

// ───────────────────────── PK5: unverified — "đích tự kiểm" (SPEC-provider-khac §7, ADR-206) ─────────────────────────

/** Mã lỗi khi project chưa bật nhận nguồn chưa xác thực (khoá 1, E14). */
export const UNVERIFIED_DISABLED = 'source_unverified_disabled';
const UNVERIFIED_DISABLED_FIX =
  'This project does not accept unverified sources. A project owner turns on "Accept unverified sources" in the console (Project settings), or change this source to a scheme the hub verifies.';
/** E17: body của source `unverified` quá trần gửi. */
export const UNVERIFIED_TOO_LARGE = 'unverified_body_too_large';
const UNVERIFIED_TOO_LARGE_FIX = `Unverified sources accept at most ${UNVERIFIED_MAX_BODY_BYTES / 1024}KB per request (the raw body is forwarded base64-encoded and must fit the 64KB delivery limit). Ask the provider for smaller payloads, or use a scheme the hub verifies.`;

/**
 * PK5 (khoá 1, E14, E17): cờ project tắt -> từ chối KHÔNG phải vì chữ ký sai (lõi không lưu mẫu, không phạt — kẻ biết
 * sourceKey không làm bẩn cảnh báo, provider thật không bị khoá IP). Bật -> nhận, `verified: false`. Body > 45KB -> 413.
 */
function verifyUnverified(req: RawWebhookRequest, ctx?: AdapterContext): VerifyResult {
  if (ctx?.projectFlags?.allowUnverified !== true) return { ok: false, refusal: { status: 401, error: UNVERIFIED_DISABLED, fix: UNVERIFIED_DISABLED_FIX } };
  if (req.rawBody.length > UNVERIFIED_MAX_BODY_BYTES) return { ok: false, refusal: { status: 413, error: UNVERIFIED_TOO_LARGE, fix: UNVERIFIED_TOO_LARGE_FIX } };
  return { ok: true, verified: false };
}

/** Khoá meta lõi gắn vào `headers` đã lưu (cùng khoá với mẫu REJECTED, `rejected-sample.ts`). */
const HUB_META_KEY = '__hub_meta';

/**
 * PK5 (§7.2, E6/E18): `data` khuôn CỐ ĐỊNH của event chưa xác thực — đích đưa thẳng vào SDK của provider:
 * `raw` = base64 bytes gốc (đúng từng byte, kể cả form `a+b%20c`), `contentType`, `headers` = đúng các `forwardHeaders` có mặt
 * (giá trị nguyên văn), `url` CHỈ khi `forwardUrl` (giá trị lõi đã lưu lúc nhận — không đọc env ở worker), `method`.
 */
function unverifiedData(c: GenericConfig, req: RawWebhookRequest): Record<string, unknown> {
  const metaRaw = (req.headers as Record<string, unknown>)?.[HUB_META_KEY];
  const meta = isObj(metaRaw) ? metaRaw : {};
  const headers: Record<string, string> = {};
  for (const h of c.forwardHeaders ?? []) {
    const v = headerOf(req, h);
    if (v !== null) headers[h] = v;
  }
  return {
    raw: req.rawBody.toString('base64'),
    contentType: req.contentType ?? null,
    headers,
    ...(c.forwardUrl ? { url: typeof meta.url === 'string' ? meta.url : null } : {}),
    method: typeof meta.method === 'string' ? meta.method : 'POST',
  };
}
