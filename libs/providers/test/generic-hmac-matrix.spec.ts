import { createHash, createHmac } from 'crypto';
import { RawWebhookRequest } from '@hub/common';
import { GenericAdapter } from '../src/generic.adapter';
import { ALGO_IN_PREFIX, HmacAlgo, KeyEncoding, decodeHmacKey, hmacParams, secretProblem, validateGenericConfig } from '../src/generic-config';

/**
 * PK2 (SPEC-provider-khac §4, ADR-203): `hmac` là THAM SỐ của một thuật toán — algo × encoding × prefix × keyEncoding.
 * Vector tự tính bằng node crypto ngay trong test (không chép chuỗi trông như secret): khoá = sha256 của một nhãn cố định.
 */
const a = new GenericAdapter();
const BODY = '{"transId":"TX-PK2","amount":50000}';
const ALGOS: HmacAlgo[] = ['sha1', 'sha256', 'sha512'];
const ENCODINGS = ['hex', 'base64'] as const;
const KEY_ENCODINGS: KeyEncoding[] = ['utf8', 'hex', 'base64'];
const PREFIXES = [undefined, 'v1=', ALGO_IN_PREFIX] as const;

/** Byte khoá cố định + cách viết secret tương ứng (utf8 dùng chuỗi ASCII cố định). */
const KEY_BYTES = createHash('sha256').update('pk-t6-matrix-key').digest();
const UTF8_SECRET = `pk-t6-${'utf8'.repeat(3)}`;
function secretFor(enc: KeyEncoding): { secret: string; key: Buffer } {
  if (enc === 'utf8') return { secret: UTF8_SECRET, key: Buffer.from(UTF8_SECRET, 'utf8') };
  return { secret: KEY_BYTES.toString(enc), key: KEY_BYTES };
}

function req(body: string, headers: Record<string, string>): RawWebhookRequest {
  return { provider: 'generic', sourceKey: 'k', headers, rawBody: Buffer.from(body), body: JSON.parse(body), contentType: 'application/json' };
}
function ctxOf(c: Record<string, unknown>) {
  const r = validateGenericConfig({ header: 'x-sig', idempotency: { field: 'transId' }, eventType: 'acme.paid', ...c });
  if (!r.ok) throw new Error(`config sai: ${(r as { field: string }).field}`);
  return { verificationConfig: (r as { config: unknown }).config };
}
/** Sửa đúng 1 byte của chuỗi (ký tự đầu đổi sang ký tự khác cùng bảng chữ). */
const flip = (s: string, i = 0) => s.slice(0, i) + (s[i] === 'a' ? 'b' : 'a') + s.slice(i + 1);

describe('[PK:T6] hmac ma trận algo × encoding × prefix × keyEncoding', () => {
  const cases: { algo: HmacAlgo; encoding: 'hex' | 'base64'; prefix: string | undefined; keyEncoding: KeyEncoding }[] = [];
  for (const algo of ALGOS) for (const encoding of ENCODINGS) for (const prefix of PREFIXES) for (const keyEncoding of KEY_ENCODINGS) cases.push({ algo, encoding, prefix, keyEncoding });

  it('đủ 54 tổ hợp', () => expect(cases).toHaveLength(54));

  it.each(cases)('%o: ký đúng -> true; sửa 1 byte body -> false; sửa 1 ký tự chữ ký -> false', async ({ algo, encoding, prefix, keyEncoding }) => {
    const { secret, key } = secretFor(keyEncoding);
    const sig = createHmac(algo, key).update(BODY).digest(encoding);
    const algoInPrefix = prefix === ALGO_IN_PREFIX;
    const header = algoInPrefix ? `${algo}=${sig}` : `${prefix ?? ''}${sig}`;
    // prefix "<algo>=" -> không khai algo (đọc từ chữ ký); sha1 phải khai rõ trong `algos` (review PK2 T-3); còn lại khai algo.
    const inPrefix = algoInPrefix ? (algo === 'sha1' ? { algos: ['sha1'] } : {}) : { algo };
    const ctx = ctxOf({ scheme: 'hmac', encoding, keyEncoding, ...(prefix ? { prefix } : {}), ...inPrefix });
    expect(await a.verify(req(BODY, { 'x-sig': header }), [secret], ctx)).toBe(true);
    expect(await a.verify(req(BODY.replace('50000', '50001'), { 'x-sig': header }), [secret], ctx)).toBe(false);
    const sigStart = header.length - sig.length;
    expect(await a.verify(req(BODY, { 'x-sig': flip(header, sigStart + 3) }), [secret], ctx)).toBe(false);
    // Thiếu tiền tố (khi có) -> false; khoá viết sai cách (utf8 của chuỗi hex/base64) -> false.
    if (prefix) expect(await a.verify(req(BODY, { 'x-sig': sig }), [secret], ctx)).toBe(false);
    if (keyEncoding !== 'utf8') {
      const wrongKey = ctxOf({ scheme: 'hmac', encoding, keyEncoding: 'utf8', ...(prefix ? { prefix } : {}), ...inPrefix });
      expect(await a.verify(req(BODY, { 'x-sig': header }), [secret], wrongKey)).toBe(false);
    }
  });

  it('prefix "<algo>=": thuật toán lạ (md5=, sha384=), thiếu "=", viết hoa -> false, KHÔNG ném', async () => {
    const ctx = ctxOf({ scheme: 'hmac', prefix: ALGO_IN_PREFIX });
    const { secret, key } = secretFor('utf8');
    const md5 = createHmac('md5', key).update(BODY).digest('hex');
    const sha384 = createHmac('sha384', key).update(BODY).digest('hex');
    const sha256 = createHmac('sha256', key).update(BODY).digest('hex');
    for (const h of [`md5=${md5}`, `sha384=${sha384}`, sha256, `SHA256=${sha256}`, `sha256:${sha256}`, '=', '']) {
      await expect(a.verify(req(BODY, { 'x-sig': h }), [secret], ctx)).resolves.toBe(false);
    }
    expect(await a.verify(req(BODY, { 'x-sig': `sha256=${sha256}` }), [secret], ctx)).toBe(true);
  });

  it('keyEncoding hex/base64 thật sự giải mã: secret hex của "Jefe" ký giống hệt secret utf8 "Jefe"', async () => {
    const sig = createHmac('sha256', 'Jefe').update(BODY).digest('hex');
    const hexKey = Buffer.from('Jefe').toString('hex');
    const b64Key = Buffer.from('Jefe').toString('base64');
    expect(await a.verify(req(BODY, { 'x-sig': sig }), [hexKey], ctxOf({ scheme: 'hmac', keyEncoding: 'hex' }))).toBe(true);
    expect(await a.verify(req(BODY, { 'x-sig': sig }), [b64Key], ctxOf({ scheme: 'hmac', keyEncoding: 'base64' }))).toBe(true);
    expect(await a.verify(req(BODY, { 'x-sig': sig }), [hexKey], ctxOf({ scheme: 'hmac' }))).toBe(false);
  });

  it('secret không giải mã được theo keyEncoding -> bỏ qua secret đó (không giải mã lỏng), secret khác vẫn khớp', async () => {
    expect(decodeHmacKey('abc', 'hex')).toBeNull(); // lẻ
    expect(decodeHmacKey('zz', 'hex')).toBeNull();
    expect(decodeHmacKey('ab!d', 'base64')).toBeNull();
    expect(decodeHmacKey('', 'utf8')).toBeNull();
    const { secret, key } = secretFor('hex');
    const sig = createHmac('sha256', key).update(BODY).digest('hex');
    const ctx = ctxOf({ scheme: 'hmac', keyEncoding: 'hex' });
    // `Buffer.from(x, 'hex')` sẽ cắt ở ký tự lạ -> "secret+rác" thành cùng khoá; ở đây phải bị loại.
    expect(await a.verify(req(BODY, { 'x-sig': sig }), [`${secret}zz`], ctx)).toBe(false);
    expect(await a.verify(req(BODY, { 'x-sig': sig }), [`${secret}zz`, secret], ctx)).toBe(true);
  });
});

describe('PK2: config hmac / bí danh hmac-sha256 / static-token location', () => {
  const bad = (c: Record<string, unknown>) => (validateGenericConfig({ idempotency: { field: 'x' }, eventType: 'acme.x', ...c }) as { field?: string }).field;
  const ok = (c: Record<string, unknown>) => {
    const r = validateGenericConfig({ idempotency: { field: 'x' }, eventType: 'acme.x', ...c });
    if (!r.ok) throw new Error(`config sai: ${(r as { field: string }).field}`);
    return (r as { config: any }).config;
  };

  it('bí danh hmac-sha256: khuôn lưu KHÔNG đổi (không thêm algo/keyEncoding), đọc ra {algo:sha256, keyEncoding:utf8}; prefix luôn tĩnh', () => {
    const old = ok({ scheme: 'hmac-sha256', header: 'x-s', prefix: 'sha256=' });
    expect(old).toEqual({ scheme: 'hmac-sha256', header: 'x-s', encoding: 'hex', prefix: 'sha256=', idempotency: { field: 'x' }, eventType: 'acme.x' });
    expect(hmacParams(old)).toEqual({ algo: 'sha256', encoding: 'hex', keyEncoding: 'utf8', prefix: 'sha256=' });
    // "<algo>=" với bí danh là chuỗi tĩnh như trước PK2 (không đổi nghĩa source cũ).
    expect(hmacParams(ok({ scheme: 'hmac-sha256', header: 'x-s', prefix: ALGO_IN_PREFIX }))).toMatchObject({ algo: 'sha256', prefix: ALGO_IN_PREFIX });
    expect(bad({ scheme: 'hmac-sha256', header: 'x-s', algo: 'sha512' })).toBe('algo');
    expect(bad({ scheme: 'hmac-sha256', header: 'x-s', keyEncoding: 'hex' })).toBe('keyEncoding');
  });

  it('bí danh hmac-sha256 verify y như trước: sha256, khoá utf8, prefix tĩnh', async () => {
    const c = { verificationConfig: ok({ scheme: 'hmac-sha256', header: 'x-s', encoding: 'base64', prefix: 'sha256=' }) };
    const sig = createHmac('sha256', 'bank_secret_123').update(BODY).digest('base64');
    expect(await a.verify(req(BODY, { 'x-s': `sha256=${sig}` }), ['bank_secret_123'], c)).toBe(true);
    expect(await a.verify(req(BODY, { 'x-s': sig }), ['bank_secret_123'], c)).toBe(false);
  });

  it('hmac: mặc định algo sha256 + hex + utf8; "<algo>=" không lưu algo; sai luật -> đúng tên trường', () => {
    expect(ok({ scheme: 'hmac', header: 'x-s' })).toEqual({ scheme: 'hmac', header: 'x-s', encoding: 'hex', algo: 'sha256', keyEncoding: 'utf8', idempotency: { field: 'x' }, eventType: 'acme.x' });
    expect(ok({ scheme: 'hmac', header: 'x-s', prefix: ALGO_IN_PREFIX })).not.toHaveProperty('algo');
    expect(bad({ scheme: 'hmac', header: 'x-s', algo: 'md5' })).toBe('algo');
    expect(bad({ scheme: 'hmac', header: 'x-s', algo: 'sha256', prefix: ALGO_IN_PREFIX })).toBe('algo');
    expect(bad({ scheme: 'hmac', header: 'x-s', keyEncoding: 'whsec' })).toBe('keyEncoding');
    expect(bad({ scheme: 'hmac', header: 'x-s', prefix: 'x'.repeat(33) })).toBe('prefix'); // E15: ≤ 32
    expect(ok({ scheme: 'hmac', header: 'x-s', prefix: 'x'.repeat(32) }).prefix).toHaveLength(32);
    expect(bad({ scheme: 'hmac' })).toBe('header');
    expect(bad({ scheme: 'static-token', header: 'x-t', algo: 'sha1' })).toBe('algo');
    expect(bad({ scheme: 'standard-webhooks', keyEncoding: 'hex' })).toBe('keyEncoding');
    expect(bad({ scheme: 'hmac', header: 'x-s', location: 'query', param: 't' })).toBe('location');
  });

  it('static-token location: basic/query không có header/prefix/encoding; query bắt buộc param; header giữ khuôn cũ', () => {
    expect(ok({ scheme: 'static-token', header: 'x-t' })).toEqual({ scheme: 'static-token', header: 'x-t', idempotency: { field: 'x' }, eventType: 'acme.x' });
    expect(ok({ scheme: 'static-token', location: 'header', header: 'x-t' })).not.toHaveProperty('location');
    expect(ok({ scheme: 'static-token', location: 'basic' })).toMatchObject({ location: 'basic' });
    expect(ok({ scheme: 'static-token', location: 'query', param: 'api_key' })).toMatchObject({ location: 'query', param: 'api_key' });
    expect(bad({ scheme: 'static-token', location: 'basic', header: 'authorization' })).toBe('header');
    expect(bad({ scheme: 'static-token', location: 'basic', prefix: 'Basic ' })).toBe('prefix');
    expect(bad({ scheme: 'static-token', location: 'query' })).toBe('param');
    expect(bad({ scheme: 'static-token', location: 'query', param: 'a b' })).toBe('param');
    expect(bad({ scheme: 'static-token', location: 'cookie' })).toBe('location');
    expect(bad({ scheme: 'static-token', header: 'x-t', param: 't' })).toBe('param');
  });

  it('secretProblem: keyEncoding hex/base64 phải giải mã được; basic phải "user:pass"', () => {
    expect(secretProblem(ok({ scheme: 'hmac', header: 'x-s', keyEncoding: 'hex' }), 'not-hex-at-all')).toMatch(/keyEncoding/);
    expect(secretProblem(ok({ scheme: 'hmac', header: 'x-s', keyEncoding: 'hex' }), KEY_BYTES.toString('hex'))).toBeNull();
    expect(secretProblem(ok({ scheme: 'static-token', location: 'basic' }), 'onlyuser')).toMatch(/user:pass/);
    expect(secretProblem(ok({ scheme: 'static-token', location: 'basic' }), 'hub:pass-123')).toBeNull();
    expect(secretProblem(ok({ scheme: 'hmac-sha256', header: 'x-s' }), 'anything-utf8')).toBeNull();
  });

  it('basic: so cả cặp user:pass qua Authorization: Basic; sai pass / sai user / thiếu -> false; signature che', async () => {
    const c = { verificationConfig: ok({ scheme: 'static-token', location: 'basic' }) };
    const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
    expect(await a.verify(req(BODY, { authorization: basic('hub:pass-123') }), ['hub:pass-123'], c)).toBe(true);
    expect(await a.verify(req(BODY, { authorization: basic('hub:pass-124') }), ['hub:pass-123'], c)).toBe(false);
    expect(await a.verify(req(BODY, { authorization: basic('bot:pass-123') }), ['hub:pass-123'], c)).toBe(false);
    expect(await a.verify(req(BODY, { authorization: `Bearer ${Buffer.from('hub:pass-123').toString('base64')}` }), ['hub:pass-123'], c)).toBe(false);
    expect(await a.verify(req(BODY, {}), ['hub:pass-123'], c)).toBe(false);
    expect(a.extractSignature(req(BODY, { authorization: basic('hub:pass-123') }), c)).toBe('***');
    expect(a.sensitiveHeaders(c)).toEqual(['authorization']);
  });
});

describe('review PK2: T-3 algos của "<algo>=", T-4 base64 khứ hồi, T-5 token query không cần mã hoá URL', () => {
  const ok = (c: Record<string, unknown>) => {
    const r = validateGenericConfig({ header: 'x-sig', idempotency: { field: 'x' }, eventType: 'acme.x', ...c });
    if (!r.ok) throw new Error(`config sai: ${(r as { field: string }).field}`);
    return (r as { config: any }).config;
  };
  const field = (c: Record<string, unknown>) => (validateGenericConfig({ header: 'x-sig', idempotency: { field: 'x' }, eventType: 'acme.x', ...c }) as { field?: string }).field;
  const { secret, key } = secretFor('utf8');
  const signed = (algo: HmacAlgo) => `${algo}=${createHmac(algo, key).update(BODY).digest('hex')}`;

  it('T-3: "<algo>=" không khai algos (gồm config đã lưu trước bản này) -> chỉ sha256 + sha512; sha1 bị từ chối dù ký đúng', async () => {
    const ctx = { verificationConfig: ok({ scheme: 'hmac', prefix: ALGO_IN_PREFIX }) };
    expect(await a.verify(req(BODY, { 'x-sig': signed('sha256') }), [secret], ctx)).toBe(true);
    expect(await a.verify(req(BODY, { 'x-sig': signed('sha512') }), [secret], ctx)).toBe(true);
    expect(await a.verify(req(BODY, { 'x-sig': signed('sha1') }), [secret], ctx)).toBe(false);
    expect(hmacParams(ctx.verificationConfig)).toMatchObject({ algo: null, algos: ['sha256', 'sha512'] });
  });

  it('T-3: algos khai rõ -> đúng tập đó (WebSub có sha1; chỉ sha256 thì sha512 cũng bị từ chối); algos sai luật -> 422 algos', async () => {
    const websub = { verificationConfig: ok({ scheme: 'hmac', prefix: ALGO_IN_PREFIX, algos: ['sha1', 'sha256', 'sha512'] }) };
    for (const algo of ['sha1', 'sha256', 'sha512'] as HmacAlgo[]) expect(await a.verify(req(BODY, { 'x-sig': signed(algo) }), [secret], websub)).toBe(true);
    const only256 = { verificationConfig: ok({ scheme: 'hmac', prefix: ALGO_IN_PREFIX, algos: ['sha256'] }) };
    expect(await a.verify(req(BODY, { 'x-sig': signed('sha512') }), [secret], only256)).toBe(false);
    expect(only256.verificationConfig.algos).toEqual(['sha256']);
    expect(field({ scheme: 'hmac', algos: ['sha256'] })).toBe('algos'); // không phải "<algo>="
    expect(field({ scheme: 'hmac-sha256', prefix: ALGO_IN_PREFIX, algos: ['sha256'] })).toBe('algos'); // bí danh cũ
    expect(field({ scheme: 'hmac', prefix: ALGO_IN_PREFIX, algos: [] })).toBe('algos');
    expect(field({ scheme: 'hmac', prefix: ALGO_IN_PREFIX, algos: ['md5'] })).toBe('algos');
    expect(field({ scheme: 'hmac', prefix: ALGO_IN_PREFIX, algos: ['sha1', 'sha1'] })).toBe('algos');
    expect(field({ scheme: 'hmac', prefix: ALGO_IN_PREFIX, algos: 'sha1' })).toBe('algos');
  });

  it('T-4: base64 phải khứ hồi — bit thừa khác 0 ("AB==", "AB") bị từ chối, cách viết chuẩn (có/không padding) thì nhận', () => {
    expect(decodeHmacKey('AA==', 'base64')).toEqual(Buffer.from([0]));
    expect(decodeHmacKey('AA', 'base64')).toEqual(Buffer.from([0]));
    expect(decodeHmacKey('AB==', 'base64')).toBeNull();
    expect(decodeHmacKey('AB', 'base64')).toBeNull();
    expect(decodeHmacKey('AAB=', 'base64')).toBeNull();
    expect(decodeHmacKey(KEY_BYTES.toString('base64'), 'base64')).toEqual(KEY_BYTES);
    expect(decodeHmacKey(KEY_BYTES.toString('base64').replace(/=+$/, ''), 'base64')).toEqual(KEY_BYTES);
  });

  it('T-5: static-token location query -> secret chỉ gồm [A-Za-z0-9._~-] (422 secret); header/basic không bị luật này', () => {
    const q = ok({ scheme: 'static-token', header: undefined, location: 'query', param: 'token' });
    for (const bad of ['abc+def/ghi=', 'a b', 'a&b=c', 'a#b', 'a%20b', 'khoá-có-dấu']) expect([bad, secretProblem(q, bad)]).toEqual([bad, expect.stringMatching(/query/)]);
    for (const good of ['tok-123456', 'A.b_c~d-9']) expect(secretProblem(q, good)).toBeNull();
    expect(secretProblem(ok({ scheme: 'static-token' }), 'abc+def/ghi=')).toBeNull();
    // Vì sao: URLSearchParams giải mã "+" thành dấu cách — token có "+" sẽ không bao giờ khớp.
    expect(new URLSearchParams('token=abc+def').get('token')).toBe('abc def');
  });
});
