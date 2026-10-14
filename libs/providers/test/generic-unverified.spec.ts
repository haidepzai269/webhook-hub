import { GenericAdapter, UNVERIFIED_MAX_BODY_BYTES, estimateUnverifiedEnvelopeBytes, validateGenericConfig, verdictOf } from '../src';
import { toWebhookBody } from '@hub/common';
import type { AdapterContext } from '../src';

/**
 * PK5 (SPEC-provider-khac §7 + E5/E6/E7/E14/E17/E18/E24, ADR-206): scheme `unverified` ("đích tự kiểm") ở tầng adapter —
 * kiểm config (khoá 3), verify trả `{ok, verified:false}` theo cờ project (khoá 1), khoá chống trùng theo nội dung (E7),
 * `data` khuôn cố định (E6/E18). Không literal secret: scheme này không có secret.
 */
const BASE = { scheme: 'unverified', eventType: 'momo.ipn' };
const a = new GenericAdapter();
const ctx = (vc: unknown, allowUnverified = true, extra: Partial<AdapterContext> = {}): AdapterContext => ({
  verificationConfig: vc,
  projectFlags: { allowUnverified },
  ...extra,
});
const req = (body: string | Buffer, o: { headers?: Record<string, unknown>; contentType?: string; parse?: boolean } = {}) => {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let parsed: unknown;
  if (o.parse !== false) {
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      parsed = undefined;
    }
  }
  return { provider: 'generic' as const, sourceKey: 'src_generic_u', headers: { ...(o.headers ?? {}) } as any, rawBody: raw, body: parsed, contentType: o.contentType ?? 'application/json', method: 'POST' as const, query: '' };
};

describe('[PK5] unverified — config (khoá 3, E14/E18/E24)', () => {
  it('[PK:T15] (phần a) eventType thuộc namespace chuẩn (payment.*, repo.*, hub.*) -> 422 field eventType; tên riêng thì được', () => {
    for (const t of ['payment.received', 'payment.refunded', 'repo.push', 'hub.project.cleanup_suggested']) {
      const r = validateGenericConfig({ ...BASE, eventType: t });
      expect([t, r.ok, (r as any).field]).toEqual([t, false, 'eventType']);
    }
    const ok = validateGenericConfig({ ...BASE, eventType: 'twilio.sms.received' });
    expect(ok).toEqual({ ok: true, config: { scheme: 'unverified', eventType: 'twilio.sms.received' } });
  });

  it('khuôn đầy đủ: forwardHeaders ≤ 10, viết thường, không trùng; cấm authorization/cookie/x-hub-*/set-cookie; forwardUrl boolean; idempotency tuỳ chọn', () => {
    const full = validateGenericConfig({
      ...BASE,
      forwardHeaders: ['x-twilio-signature', 'x-twilio-idempotency-token'],
      forwardUrl: true,
      idempotency: { field: 'transId' },
      ack: { successStatus: 204 },
    });
    expect(full).toEqual({
      ok: true,
      config: { scheme: 'unverified', eventType: 'momo.ipn', idempotency: { field: 'transId' }, forwardHeaders: ['x-twilio-signature', 'x-twilio-idempotency-token'], forwardUrl: true, ack: { successStatus: 204 } },
    });
    // forwardUrl:false không lưu (E18: url chỉ khi bật).
    expect((validateGenericConfig({ ...BASE, forwardUrl: false }) as any).config).toEqual({ scheme: 'unverified', eventType: 'momo.ipn' });
    const bad = (vc: Record<string, unknown>) => {
      const r = validateGenericConfig({ ...BASE, ...vc });
      return r.ok ? 'ok' : (r as any).field;
    };
    for (const h of ['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'x-hub-signature', 'x-hub-anything']) {
      expect([h, bad({ forwardHeaders: [h] })]).toEqual([h, 'forwardHeaders']);
    }
    expect(bad({ forwardHeaders: Array.from({ length: 11 }, (_, i) => `x-h${i}`) })).toBe('forwardHeaders');
    expect(bad({ forwardHeaders: ['X-Twilio-Signature'] })).toBe('forwardHeaders');
    expect(bad({ forwardHeaders: ['x-a', 'x-a'] })).toBe('forwardHeaders');
    expect(bad({ forwardHeaders: 'x-a' })).toBe('forwardHeaders');
    expect(bad({ forwardUrl: 'yes' })).toBe('forwardUrl');
    // Trường của scheme có verify / ánh xạ không có ở unverified.
    for (const f of ['header', 'encoding', 'prefix', 'algo', 'keyEncoding', 'template', 'signature', 'toleranceSec', 'mapping', 'timezone']) {
      expect([f, bad({ [f]: 'x' })]).toEqual([f, f]);
    }
  });

  it('bắt tay: không hmac-echo (không có secret để ký), không afterVerify (không có gì được verify); manual-url / head-ok thì được', () => {
    const hmacEcho = validateGenericConfig({ ...BASE, handshake: { kind: 'hmac-echo', when: { field: 'event', equals: 'x' }, tokenField: 'plainToken', macField: 'encryptedToken' } });
    expect((hmacEcho as any).field).toBe('handshake.kind');
    const after = validateGenericConfig({ ...BASE, handshake: { kind: 'body-echo', when: { field: 'type', equals: 'v' }, echo: { field: 'challenge' }, afterVerify: true } });
    expect((after as any).field).toBe('handshake.afterVerify');
    expect(validateGenericConfig({ ...BASE, handshake: { kind: 'head-ok' } }).ok).toBe(true);
    const sns = validateGenericConfig({ ...BASE, eventType: 'sns.notification', handshake: { kind: 'manual-url', when: { header: 'x-amz-sns-message-type', equals: 'SubscriptionConfirmation' }, urlField: 'SubscribeURL' } });
    expect(sns.ok).toBe(true);
  });
});

describe('[PK5] unverified — verify (khoá 1, E5/E14/E17)', () => {
  it('[PK:T14] (phần a) cờ project tắt / vắng -> từ chối KHÔNG vì chữ ký (refusal 401 source_unverified_disabled); bật -> {ok:true, verified:false}', async () => {
    const r = req('{"transId":"1"}');
    const off = verdictOf(await a.verify(r, [], ctx(BASE, false)));
    expect(off).toMatchObject({ ok: false, refusal: { status: 401, error: 'source_unverified_disabled' } });
    // Vắng projectFlags (renormalize, đối chiếu secret, inspect) = tắt — fail-closed.
    expect(verdictOf(await a.verify(r, [], { verificationConfig: BASE }))).toMatchObject({ ok: false, refusal: { error: 'source_unverified_disabled' } });
    expect(verdictOf(await a.verify(r, [], ctx(BASE, true)))).toEqual({ ok: true, verified: false });
    // Lõi ghép `rejectStatus` qua buildAck — 401 -> 403 nếu source khai; body có fix riêng (không phải câu chữ ký sai).
    const ack = a.buildAck({ accepted: false, status: 401, message: 'source_unverified_disabled' }, ctx({ ...BASE, ack: { rejectStatus: 403 } }));
    expect(ack.status).toBe(403);
    expect((ack.body as any).fix).toMatch(/Accept unverified sources/);
  });

  it('[PK:T38] (phần b) E17: body > 45KB (thử 60KB) -> refusal 413 unverified_body_too_large; đúng 45KB vẫn nhận', async () => {
    const big = Buffer.alloc(60 * 1024, 0x61);
    expect(verdictOf(await a.verify(req(big, { parse: false }), [], ctx(BASE)))).toMatchObject({ ok: false, refusal: { status: 413, error: 'unverified_body_too_large' } });
    const edge = Buffer.alloc(UNVERIFIED_MAX_BODY_BYTES, 0x61);
    expect(verdictOf(await a.verify(req(edge, { parse: false }), [], ctx(BASE)))).toEqual({ ok: true, verified: false });
  });

  it('verdictOf: boolean cũ -> {ok, verified:true}; object luôn đi qua verdictOf (không truthy nhầm)', () => {
    expect(verdictOf(true)).toEqual({ ok: true, verified: true });
    expect(verdictOf(false)).toEqual({ ok: false, verified: false });
    expect(verdictOf({ ok: false })).toEqual({ ok: false, verified: false });
    expect(verdictOf({ ok: true, verified: false })).toEqual({ ok: true, verified: false });
  });

  it('unverified không bao giờ "verify qua" theo nghĩa chữ ký: có secret lạc vào (DB hỏng) vẫn không thành khoá; diagnose không báo chữ ký sai', async () => {
    const stray = `stray-${process.pid}`;
    // verify vẫn chỉ theo cờ project, không theo secret.
    expect(verdictOf(await a.verify(req('{}'), [stray], ctx(BASE, false))).ok).toBe(false);
    expect(a.extractSignature(req('{}', { headers: { 'x-signature': 'abc' } }), ctx(BASE))).toBeNull();
    expect(a.sensitiveHeaders(ctx(BASE))).toEqual([]);
  });
});

describe('[PK5] unverified — khoá chống trùng theo nội dung (E7)', () => {
  it('[PK:T38] (phần a) hai body KHÁC nhau cùng transId -> hai khoá khác nhau; cùng bytes -> cùng khoá; không khai -> chỉ bodyHashKey; không ngẫu nhiên', () => {
    const vc = { ...BASE, idempotency: { field: 'transId' } };
    const real = req('{"transId":"T1","amount":50000,"signature":"real"}');
    const forged = req('{"transId":"T1","amount":1,"signature":"forged"}');
    const k1 = a.extractIdempotencyKey(real, ctx(vc));
    const k2 = a.extractIdempotencyKey(forged, ctx(vc));
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/^generic:T1:[0-9a-f]{32}$/);
    expect(a.extractIdempotencyKey(req('{"transId":"T1","amount":50000,"signature":"real"}'), ctx(vc))).toBe(k1);
    // Khác MỘT byte (khoảng trắng) là khác khoá — chỉ bản trùng đúng từng byte mới là trùng.
    expect(a.extractIdempotencyKey(req('{"transId":"T1", "amount":50000,"signature":"real"}'), ctx(vc))).not.toBe(k1);
    const plain = a.extractIdempotencyKey(req('a=1&b=2', { parse: false, contentType: 'application/x-www-form-urlencoded' }), ctx(BASE));
    expect(plain).toMatch(/^generic:[0-9a-f]{32}$/);
    expect(a.extractIdempotencyKey(req('a=1&b=2', { parse: false }), ctx(BASE))).toBe(plain);
    // Header: cùng luật ghép.
    const vh = { ...BASE, idempotency: { header: 'x-request-id' } };
    expect(a.extractIdempotencyKey(req('{"a":1}', { headers: { 'x-request-id': 'r1' } }), ctx(vh))).toMatch(/^generic:r1:[0-9a-f]{32}$/);
    // Khoá ≤ 255 (raw_events.idempotency_key VARCHAR(255)): giá trị ≤ 200 + ":" + 32 hex.
    const long = a.extractIdempotencyKey(req(JSON.stringify({ transId: 'x'.repeat(200) })), ctx(vc));
    expect(long.length).toBeLessThanOrEqual(255);
  });

  it('field khai mà body không phải JSON object -> vẫn đọc được JSON gửi kèm text/plain; thiếu hẳn -> IdempotencyKeyMissingError (422, không fallback ngẫu nhiên)', () => {
    const vc = { ...BASE, idempotency: { field: 'transId' } };
    const textPlain = req('{"transId":"T9"}', { parse: false, contentType: 'text/plain' });
    expect(a.extractIdempotencyKey(textPlain, ctx(vc))).toMatch(/^generic:T9:/);
    expect(() => a.extractIdempotencyKey(req('{"other":1}'), ctx(vc))).toThrow(/transId/);
  });
});

describe('[PK5] unverified — data khuôn cố định (E6/E18)', () => {
  const nctx = (vc: unknown) => ({ tenantId: 't', sourceId: 's', correlationId: 'c', rawEventId: 'r', receivedAt: '2026-10-14T00:00:00.000Z', verificationConfig: vc });

  it('[PK:T17] (phần a) data.raw giải base64 ra ĐÚNG từng byte (form `a+b%20c`, byte không phải UTF-8); headers chỉ forwardHeaders có mặt', () => {
    const vc = { ...BASE, forwardHeaders: ['x-twilio-signature', 'x-missing'] };
    for (const body of [Buffer.from('a+b%20c=d%2Be&x=1'), Buffer.from([0xff, 0x00, 0xfe, 0x7b, 0x0a]), Buffer.alloc(0)]) {
      const stored = { ...req(body, { parse: false, contentType: 'application/x-www-form-urlencoded', headers: { 'x-twilio-signature': 'sig==', 'x-other': 'no', __hub_meta: { method: 'POST' } } }) };
      const [evt] = a.normalize(stored, nctx(vc));
      expect(evt.type).toBe('momo.ipn');
      expect(evt.normalized).toBe(false);
      expect(Buffer.from(evt.data.raw, 'base64').equals(body)).toBe(true);
      expect(evt.data).toEqual({ raw: body.toString('base64'), contentType: 'application/x-www-form-urlencoded', headers: { 'x-twilio-signature': 'sig==' }, method: 'POST' });
      expect(evt.data).not.toHaveProperty('url');
    }
  });

  it('[PK:T17] (phần b) url CHỈ khi forwardUrl, lấy từ __hub_meta.url đã lưu lúc nhận (worker không đọc env); storedMeta dựng url từ ctx.publicUrl, không từ Host', () => {
    const vc = { ...BASE, forwardUrl: true };
    const publicUrl = jest.fn(() => 'https://hub.example.com/hooks/generic/src_generic_u?x=1');
    const incoming = req('{}', { headers: { host: 'evil.com' } });
    expect(a.storedMeta(incoming, ctx(vc, true, { publicUrl }))).toEqual({ method: 'POST', url: 'https://hub.example.com/hooks/generic/src_generic_u?x=1' });
    // forwardUrl tắt -> không lưu url, không gọi publicUrl (URL chứa sourceKey — E18).
    publicUrl.mockClear();
    expect(a.storedMeta(incoming, ctx(BASE, true, { publicUrl }))).toEqual({ method: 'POST' });
    expect(publicUrl).not.toHaveBeenCalled();
    // Không có URL công khai -> url null (đích biết là không verify được bằng URL).
    expect(a.storedMeta(incoming, ctx(vc, true, { publicUrl: () => null }))).toEqual({ method: 'POST', url: null });
    // Scheme khác: không meta.
    expect(a.storedMeta(incoming, ctx({ scheme: 'hmac', header: 'x-sig', idempotency: { header: 'x-id' }, eventType: 'a.b' }))).toBeNull();
    // normalize đọc url đã lưu; env đổi không ảnh hưởng.
    const stored = req('{}', { headers: { host: 'evil.com', __hub_meta: { method: 'POST', url: 'https://hub.example.com/hooks/generic/src_generic_u?x=1' } } });
    process.env.HUB_PUBLIC_URL = 'https://other.example.com';
    const [evt] = a.normalize(stored, nctx(vc));
    delete process.env.HUB_PUBLIC_URL;
    expect(evt.data.url).toBe('https://hub.example.com/hooks/generic/src_generic_u?x=1');
    const [noUrl] = a.normalize(stored, nctx(BASE));
    expect(noUrl.data).not.toHaveProperty('url');
  });
});

describe('[PK5] review — T-1 bắt tay, T-3 ước lượng phong bì, TB-1 chẩn đoán', () => {
  it('[PK:T14] (phần i) T-1: handshake() của nguồn unverified trả null khi cờ project tắt/vắng (lõi đi verify -> từ chối); bật thì echo', () => {
    const hs = { ...BASE, handshake: { kind: 'body-echo', when: { field: 'type', equals: 'v' }, echo: { field: 'challenge' } } };
    const r = req('{"type":"v","challenge":"c1"}');
    expect(a.handshake(r, [], ctx(hs, false), 'before-verify')).toBeNull();
    expect(a.handshake(r, [], { verificationConfig: hs }, 'before-verify')).toBeNull();
    expect(a.handshake(r, [], ctx(hs, true), 'before-verify')).toMatchObject({ kind: 'respond' });
  });

  it('[PK:T38] (phần f) T-3: ước lượng không bao giờ thấp hơn phong bì thật (toWebhookBody) — có url + header gửi kèm', () => {
    const vc = { ...BASE, forwardUrl: true, forwardHeaders: ['x-sig', 'x-ts'] };
    for (const size of [0, 1, 1000, 30_000, UNVERIFIED_MAX_BODY_BYTES]) {
      const body = Buffer.alloc(size, 0x22); // `"` — JSON thoát không ảnh hưởng base64, nhưng thử trường hợp xấu cho header
      const BS = String.fromCharCode(92); // `\` — ký tự JSON phải thoát (×2)
      const query = `a=${'%22'.repeat(500)}&b=${BS.repeat(200)}`;
      const headers = { 'x-sig': `"${BS}`.repeat(300), 'x-ts': '1700000000' };
      const url = `https://hub.example.com/hooks/generic/${'k'.repeat(40)}?${query}`;
      const r = { ...req(body, { parse: false, headers: { ...headers, __hub_meta: { method: 'POST', url } } }), query };
      const [evt] = a.normalize(r, { tenantId: 't', sourceId: '00000000-0000-4000-8000-000000000000', correlationId: 'c', rawEventId: 'r', verificationConfig: vc });
      const actual = Buffer.byteLength(toWebhookBody({ ...evt, id: '01JAAAAAAAAAAAAAAAAAAAAAAA', verified: false }));
      const est = estimateUnverifiedEnvelopeBytes({ bodyBytes: size, query, forwardHeaders: headers });
      expect([size, est >= actual]).toEqual([size, true]);
    }
  });

  it('[PK:T38] (phần g) REVIEW-PK5-R2 T-c: content-type dài (bên gửi kiểm soát) được tính vào ước lượng — body sát trần vẫn không thấp hơn thật', async () => {
    const vc = { ...BASE, forwardUrl: false, forwardHeaders: [] };
    const BS = String.fromCharCode(92);
    const contentType = `application/json; x=${`"${BS}`.repeat(600)}`; // ~2,4KB sau khi thoát JSON
    const size = UNVERIFIED_MAX_BODY_BYTES;
    const r = req(Buffer.alloc(size, 0x41), { parse: false, contentType });
    const [evt] = a.normalize(r, { tenantId: 't', sourceId: '00000000-0000-4000-8000-000000000000', correlationId: 'c', rawEventId: 'r', verificationConfig: vc });
    const actual = Buffer.byteLength(toWebhookBody({ ...evt, id: '01JAAAAAAAAAAAAAAAAAAAAAAA', verified: false }));
    expect(estimateUnverifiedEnvelopeBytes({ bodyBytes: size, query: null, forwardHeaders: {}, contentType })).toBeGreaterThanOrEqual(actual);
    // Adapter dùng đúng ước lượng đó: content-type dài đẩy phong bì quá 64KB -> 413 thay vì ACK rồi DEAD.
    const huge = `text/plain; x=${'"'.repeat(32 * 1024)}`; // ~64KB sau khi thoát JSON
    const v = verdictOf(await a.verify(req(Buffer.alloc(1000, 0x41), { parse: false, contentType: huge }), [], ctx(vc)));
    expect(v).toMatchObject({ ok: false, refusal: { status: 413, error: 'unverified_body_too_large' } });
  });

  it('[PK:T16] (phần j) TB-1: diagnose ACCEPTED của nguồn unverified = reason "unverified" (không bao giờ "ok"/"hợp lệ")', () => {
    const stored = { status: 'ACCEPTED', signatureValid: true, headers: {}, body: {}, receivedAt: new Date() };
    expect(a.diagnose(stored, ctx(BASE))).toEqual({ ok: true, reason: 'unverified' });
  });
});
