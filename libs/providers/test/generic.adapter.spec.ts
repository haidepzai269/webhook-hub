import { createHmac } from 'crypto';
import { swHeaders } from '@hub/crypto';
import { RawWebhookRequest, validateCanonical } from '@hub/common';
import { GenericAdapter } from '../src/generic.adapter';
import { validateGenericConfig } from '../src/generic-config';
import { IdempotencyKeyMissingError } from '../src/errors';

/** S8 (SPEC §4.8, §4.14.4): GenericAdapter — 3 mẫu xác thực, idempotency cấp một, mapping ra kiểu chuẩn. */
const a = new GenericAdapter();
const SECRET = 'bank_secret_123';
const ctx = { tenantId: 't', sourceId: 's', correlationId: 'c', rawEventId: 'r', receivedAt: '2026-10-10T00:00:00.000Z' };

function req(body: string, headers: Record<string, string> = {}): RawWebhookRequest {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }
  return { provider: 'generic', sourceKey: 'k', headers, rawBody: Buffer.from(body), body: parsed, contentType: 'application/json' };
}
const hmac = (secret: string, body: string, enc: 'hex' | 'base64' = 'hex') => createHmac('sha256', secret).update(body).digest(enc);
const cfg = (c: any) => {
  const r = validateGenericConfig(c);
  if (!r.ok) throw new Error(`config sai: ${(r as any).field}`);
  return { verificationConfig: (r as any).config };
};
const HMAC_HEX = cfg({ scheme: 'hmac-sha256', header: 'x-signature', encoding: 'hex', idempotency: { field: 'transactionId' }, eventType: 'bank.transaction.received' });
const BODY = '{"transactionId":"TX1","soTien":50000}';

describe('GenericAdapter — verify (S8)', () => {
  it('[MS:U7] hmac-sha256 hex, header đúng -> true', async () => {
    expect(await a.verify(req(BODY, { 'x-signature': hmac(SECRET, BODY) }), [SECRET], HMAC_HEX)).toBe(true);
  });

  it('[MS:U8] hmac base64 + prefix sha256= -> true; bỏ prefix -> false', async () => {
    const c = cfg({ scheme: 'hmac-sha256', header: 'x-sig', encoding: 'base64', prefix: 'sha256=', idempotency: { field: 'transactionId' }, eventType: 'bank.x' });
    expect(await a.verify(req(BODY, { 'x-sig': `sha256=${hmac(SECRET, BODY, 'base64')}` }), [SECRET], c)).toBe(true);
    expect(await a.verify(req(BODY, { 'x-sig': hmac(SECRET, BODY, 'base64') }), [SECRET], c)).toBe(false);
  });

  it('[MS:U9] hmac tính trên JSON parse rồi stringify lại (khác khoảng trắng) -> false (phải tính trên rawBody)', async () => {
    const spaced = '{ "transactionId": "TX1", "soTien": 50000 }';
    const sigOfReserialized = hmac(SECRET, JSON.stringify(JSON.parse(spaced)));
    expect(await a.verify(req(spaced, { 'x-signature': sigOfReserialized }), [SECRET], HMAC_HEX)).toBe(false);
    expect(await a.verify(req(spaced, { 'x-signature': hmac(SECRET, spaced) }), [SECRET], HMAC_HEX)).toBe(true);
  });

  it('[MS:U10] static-token đúng / sai 1 ký tự / thiếu header -> true / false / false', async () => {
    const c = cfg({ scheme: 'static-token', header: 'authorization', prefix: 'Bearer ', idempotency: { header: 'x-request-id' }, eventType: 'bank.x' });
    expect(await a.verify(req(BODY, { authorization: 'Bearer tok_abc' }), ['tok_abc'], c)).toBe(true);
    expect(await a.verify(req(BODY, { authorization: 'Bearer tok_abd' }), ['tok_abc'], c)).toBe(false);
    expect(await a.verify(req(BODY, {}), ['tok_abc'], c)).toBe(false);
  });

  it('[MS:U11] 2 secret (xoay secret), request ký bằng secret cũ -> true', async () => {
    expect(await a.verify(req(BODY, { 'x-signature': hmac('old_secret', BODY) }), ['new_secret', 'old_secret'], HMAC_HEX)).toBe(true);
  });

  it('S8: standard-webhooks verify bằng lib dùng chung; idempotency mặc định webhook-id', async () => {
    const c = cfg({ scheme: 'standard-webhooks', eventType: 'bank.x' });
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const r = req(BODY, swHeaders(secret, 'msg_1', BODY));
    expect(await a.verify(r, [secret], c)).toBe(true);
    expect(a.extractIdempotencyKey(r, c)).toBe('generic:msg_1');
    expect(await a.verify(req(BODY.replace('1', '2'), swHeaders(secret, 'msg_1', BODY)), [secret], c)).toBe(false);
  });

  it('[PK:T3] (phần c) standard-webhooks nhận bộ svix-*: verify qua; khoá chống trùng mặc định = svix-id; extractSignature = svix-signature; trộn bộ -> false', async () => {
    const c = cfg({ scheme: 'standard-webhooks', eventType: 'user.created' });
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const toSvix = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.replace(/^webhook-/, 'svix-'), v]));
    const h = toSvix(swHeaders(secret, 'msg_svix_1', BODY));
    const r = req(BODY, h);
    expect(await a.verify(r, [secret], c)).toBe(true);
    expect(a.extractIdempotencyKey(r, c)).toBe('generic:msg_svix_1');
    expect(a.extractSignature(r, c)).toBe(h['svix-signature']);
    const mixed = req(BODY, { 'webhook-id': 'msg_svix_1', 'svix-timestamp': h['svix-timestamp'], 'svix-signature': h['svix-signature'] });
    expect(await a.verify(mixed, [secret], c)).toBe(false);
  });

  it('S8: thiếu cấu hình -> verify false (không bao giờ nhận bừa)', async () => {
    expect(await a.verify(req(BODY, { 'x-signature': hmac(SECRET, BODY) }), [SECRET])).toBe(false);
  });
});

describe('GenericAdapter — idempotency + config (S8)', () => {
  it('[MS:U12] idempotency {field:"transactionId"}, body thiếu trường -> IdempotencyKeyMissingError', () => {
    expect(a.extractIdempotencyKey(req(BODY), HMAC_HEX)).toBe('generic:TX1');
    expect(() => a.extractIdempotencyKey(req('{"soTien":1}'), HMAC_HEX)).toThrow(IdempotencyKeyMissingError);
    expect(() => a.extractIdempotencyKey(req('{"transactionId":""}'), HMAC_HEX)).toThrow(IdempotencyKeyMissingError);
    expect(() => a.extractIdempotencyKey(req('{"transactionId":{"x":1}}'), HMAC_HEX)).toThrow(IdempotencyKeyMissingError);
    expect(a.extractIdempotencyKey(req('{"transactionId":42}'), HMAC_HEX)).toBe('generic:42');
  });

  it('[MS:U13] idempotency {field:"a.b"} lúc validate config -> lỗi có tên trường', () => {
    expect(validateGenericConfig({ scheme: 'hmac-sha256', header: 'x-s', idempotency: { field: 'a.b' }, eventType: 'bank.x' })).toEqual(
      expect.objectContaining({ ok: false, field: 'idempotency.field' }),
    );
  });

  it('S8: validate config — các ca sai -> đúng tên trường', () => {
    const bad = (c: any) => (validateGenericConfig(c) as any).field;
    expect(bad(undefined)).toBe('verificationConfig');
    expect(bad({ scheme: 'md5', eventType: 'bank.x' })).toBe('scheme');
    expect(bad({ scheme: 'hmac-sha256', idempotency: { field: 'x' }, eventType: 'bank.x' })).toBe('header');
    expect(bad({ scheme: 'hmac-sha256', header: 'X-Sig', idempotency: { field: 'x' }, eventType: 'bank.x' })).toBe('header');
    expect(bad({ scheme: 'hmac-sha256', header: 'x-s', encoding: 'b64', idempotency: { field: 'x' }, eventType: 'bank.x' })).toBe('encoding');
    expect(bad({ scheme: 'hmac-sha256', header: 'x-s', idempotency: { field: 'x', header: 'y' }, eventType: 'bank.x' })).toBe('idempotency');
    expect(bad({ scheme: 'hmac-sha256', header: 'x-s', eventType: 'bank.x' })).toBe('idempotency');
    expect(bad({ scheme: 'hmac-sha256', header: 'x-s', idempotency: { field: 'x' }, eventType: 'Bank' })).toBe('eventType');
    expect(bad({ scheme: 'standard-webhooks', header: 'x', eventType: 'bank.x' })).toBe('header');
  });

  it('S8: extractSignature — hmac trả chữ ký (không phải bí mật); static-token che; standard-webhooks trả webhook-signature', () => {
    expect(a.extractSignature(req(BODY, { 'x-signature': 'abc' }), HMAC_HEX)).toBe('abc');
    const st = cfg({ scheme: 'static-token', header: 'x-token', idempotency: { field: 'transactionId' }, eventType: 'bank.x' });
    expect(a.extractSignature(req(BODY, { 'x-token': 'tok_secret' }), st)).toBe('***');
    expect(a.sensitiveHeaders(st)).toEqual(['x-token']);
    expect(a.sensitiveHeaders(HMAC_HEX)).toEqual([]);
  });
});

describe('GenericAdapter — normalize (S8, S14 mapping)', () => {
  it('[MS:U14] body không phải JSON -> data={raw:"..."}, normalized:false, type=eventType', () => {
    const [e] = a.normalize(req('soTien=50000&ma=TX1'), { ...ctx, ...HMAC_HEX });
    expect(e).toMatchObject({ type: 'bank.transaction.received', source: 'generic', normalized: false, data: { raw: 'soTien=50000&ma=TX1' } });
    const [j] = a.normalize(req(BODY), { ...ctx, ...HMAC_HEX });
    expect(j.data).toEqual({ raw: { transactionId: 'TX1', soTien: 50000 } });
  });

  const MAP = {
    scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'maGD' }, eventType: 'payment.received',
    mapping: { amount: 'soTien', currency: { const: 'VND' }, method: { const: 'bank_transfer' }, reference: 'maGD', memo: 'noiDung', providerTxnId: 'maGD', paidAt: 'thoiGian' },
    timezone: '+07:00',
  };

  it('[MS:U46] mapping -> payment.received normalized:true, amount=50000, paidAt +07:00 -> UTC, counterparty null, raw=body, qua validator', () => {
    const body = { soTien: 50000, maGD: 'GD1', noiDung: 'DH123 tt', thoiGian: '2026-10-10 09:00:00' };
    const [e] = a.normalize(req(JSON.stringify(body)), { ...ctx, ...cfg(MAP) });
    expect(e).toMatchObject({ type: 'payment.received', normalized: true, subject: 'payment:GD1' });
    expect(e.data).toMatchObject({ amount: 50000, currency: 'VND', method: 'bank_transfer', reference: 'GD1', memo: 'DH123 tt', providerTxnId: 'GD1', paidAt: '2026-10-10T02:00:00.000Z', counterparty: null, account: null, raw: body });
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('[MS:U47] validate: payment.received không mapping / mapping thiếu amount / mapping với bank.x / giá trị "a.b" -> lỗi có tên trường', () => {
    const f = (c: any) => (validateGenericConfig(c) as any).field;
    expect(f({ ...MAP, mapping: undefined })).toBe('mapping');
    const { amount: _a, ...noAmount } = MAP.mapping;
    expect(f({ ...MAP, mapping: noAmount })).toBe('mapping.amount');
    expect(f({ ...MAP, eventType: 'bank.x' })).toBe('mapping');
    expect(f({ ...MAP, mapping: { ...MAP.mapping, memo: 'a.b' } })).toBe('mapping.memo');
    expect(f({ ...MAP, eventType: 'repo.push' })).toBe('mapping');
    expect(f({ ...MAP, mapping: { ...MAP.mapping, raw: 'x' } })).toBe('mapping.raw');
    expect(f({ ...MAP, timezone: '7' })).toBe('timezone');
  });

  it('[MS:U48] (phần a) soTien "50.000" -> validator từ chối amount; thiếu soTien -> lỗi nêu tên trường, không giá trị', () => {
    const [e] = a.normalize(req(JSON.stringify({ soTien: '50.000', maGD: 'GD1', thoiGian: '2026-10-10 09:00:00' })), { ...ctx, ...cfg(MAP) });
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: false, field: 'amount' });
    expect(() => a.normalize(req(JSON.stringify({ maGD: 'GD1', thoiGian: '2026-10-10 09:00:00' })), { ...ctx, ...cfg(MAP) })).toThrow(/mapping_field_missing: soTien/);
  });

  it('S8: buildAck — 200 {ok:true} / trùng {ok:true,duplicate:true} / lỗi {ok:false,error}', () => {
    expect(a.buildAck({ accepted: true, status: 200, rawEventId: 'r', idempotencyKey: 'k', isDuplicate: false })).toEqual({ status: 200, body: { ok: true } });
    expect(a.buildAck({ accepted: true, status: 200, idempotencyKey: 'k', isDuplicate: true })).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(a.buildAck({ accepted: false, status: 401, message: 'sai chữ ký' } as any)).toEqual({
      status: 401,
      body: { ok: false, error: 'sai chữ ký', fix: expect.stringMatching(/verificationConfig/) },
    });
  });

  it('[DX:UX6] (phần d) DX1 §2.1: lỗi của nguồn tuỳ chỉnh kèm `fix` cho dev (401 chữ ký, 422 idempotency) — không chứa secret', () => {
    const r401 = a.buildAck({ accepted: false, status: 401, message: 'x' } as any) as any;
    expect(r401.body.fix).toMatch(/raw body bytes/);
    const r422 = a.buildAck({ accepted: false, status: 422, message: 'missing_idempotency_key' } as any) as any;
    expect(r422.body.fix).toMatch(/idempotency/);
  });
});

describe('GenericAdapter — diagnose (S9, chế độ lắng nghe)', () => {
  const stored = (o: Partial<{ status: string; signatureValid: boolean; headers: any; body: any; bodyRaw: Buffer; receivedAt: Date }>) => ({
    status: 'REJECTED', signatureValid: false, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), receivedAt: new Date('2026-10-10T00:00:00Z'), ...o,
  });

  it('[MS:U15] header gửi là x-sig, config chờ x-signature -> missing_header, candidateHeaders có x-sig, KHÔNG có giá trị', () => {
    const d = a.diagnose(stored({ headers: { 'x-sig': 'deadbeefSIGVALUE', 'content-type': 'application/json', __hub_meta: { truncated: false } } }), HMAC_HEX);
    expect(d).toEqual({ ok: false, reason: 'missing_header', expectedHeader: 'x-signature', candidateHeaders: ['x-sig'] });
    expect(JSON.stringify(d)).not.toContain('deadbeef');
  });

  it('S9: header đúng tên nhưng sai -> signature_mismatch (hmac) / token_mismatch (static-token); thiếu khoá -> missing_idempotency_key; ok', () => {
    expect(a.diagnose(stored({ headers: { 'x-signature': 'x' } }), HMAC_HEX)).toEqual({ ok: false, reason: 'signature_mismatch', expectedHeader: 'x-signature' });
    const st = cfg({ scheme: 'static-token', header: 'x-token', idempotency: { field: 'id' }, eventType: 'bank.x' });
    expect(a.diagnose(stored({ headers: { 'x-token': '***' } }), st)).toEqual({ ok: false, reason: 'token_mismatch', expectedHeader: 'x-token' });
    expect(a.diagnose(stored({ signatureValid: true }), HMAC_HEX)).toEqual({ ok: false, reason: 'missing_idempotency_key', expectedField: 'transactionId' });
    expect(a.diagnose(stored({ status: 'ACCEPTED', signatureValid: true, body: { transactionId: 'T' } }), HMAC_HEX)).toEqual({ ok: true, reason: 'ok' });
  });

  it('S9: standard-webhooks — thiếu header -> missing_header; timestamp lệch > 300s so với lúc nhận -> timestamp_out_of_range', () => {
    const sw = cfg({ scheme: 'standard-webhooks', eventType: 'bank.x' });
    expect(a.diagnose(stored({ headers: { 'webhook-id': 'm', 'x-signature': 'v1,abc' } }), sw)).toMatchObject({ ok: false, reason: 'missing_header', expectedHeader: 'webhook-timestamp', candidateHeaders: ['x-signature'] });
    const ts = String(Math.floor(new Date('2026-10-10T00:00:00Z').getTime() / 1000) - 400);
    expect(a.diagnose(stored({ headers: { 'webhook-id': 'm', 'webhook-timestamp': ts, 'webhook-signature': 'v1,x' } }), sw)).toEqual({ ok: false, reason: 'timestamp_out_of_range' });
  });

  it('[PK:T3] (phần d) diagnose standard-webhooks theo bộ đang có: svix thiếu svix-timestamp -> missing_header svix-timestamp; timestamp lệch đọc svix-timestamp', () => {
    const sw = cfg({ scheme: 'standard-webhooks', eventType: 'bank.x' });
    expect(a.diagnose(stored({ headers: { 'svix-id': 'm', 'svix-signature': 'v1,x' } }), sw)).toMatchObject({ ok: false, reason: 'missing_header', expectedHeader: 'svix-timestamp' });
    const at = Math.floor(new Date('2026-10-10T00:00:00Z').getTime() / 1000);
    expect(a.diagnose(stored({ headers: { 'svix-id': 'm', 'svix-timestamp': String(at - 400), 'svix-signature': 'v1,x' } }), sw)).toEqual({ ok: false, reason: 'timestamp_out_of_range' });
    expect(a.diagnose(stored({ headers: { 'svix-id': 'm', 'svix-timestamp': String(at), 'svix-signature': 'v1,x' } }), sw)).toEqual({ ok: false, reason: 'signature_mismatch', expectedHeader: 'svix-signature' });
    expect(a.diagnose(stored({ signatureValid: true, headers: { 'svix-timestamp': String(at) } }), sw)).toEqual({ ok: false, reason: 'missing_idempotency_key', expectedHeader: 'svix-id' });
    // không có bộ nào -> báo theo bộ chuẩn webhook-*
    expect(a.diagnose(stored({ headers: {} }), sw)).toMatchObject({ ok: false, reason: 'missing_header', expectedHeader: 'webhook-id' });
  });

  it('[MS:U48] (phần b) ACCEPTED mà body thiếu soTien -> mapping_field_missing field "soTien", không giá trị; "50.000" -> mapping_field_invalid', () => {
    const MAPC = cfg({
      scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'maGD' }, eventType: 'payment.received',
      mapping: { amount: 'soTien', currency: { const: 'VND' }, method: { const: 'bank_transfer' }, providerTxnId: 'maGD', paidAt: 'thoiGian' },
    });
    const body = { maGD: 'GD1', thoiGian: '2026-10-10 09:00:00' };
    const d = a.diagnose(stored({ status: 'ACCEPTED', signatureValid: true, body, bodyRaw: Buffer.from(JSON.stringify(body)) }), MAPC);
    expect(d).toEqual({ ok: false, reason: 'mapping_field_missing', field: 'soTien' });
    const b2 = { ...body, soTien: '50.000' };
    expect(a.diagnose(stored({ status: 'ACCEPTED', signatureValid: true, body: b2, bodyRaw: Buffer.from(JSON.stringify(b2)) }), MAPC)).toEqual({ ok: false, reason: 'mapping_field_invalid', field: 'soTien' });
  });
});
