import { bodyHashKey } from '@hub/crypto';
import {
  EMPTY_BODY_ERROR,
  EmptyBodyIdempotencyError,
  GenericAdapter,
  IdempotencyKeyMissingError,
  PATH_MAX_DEPTH,
  idempotencyPathProblem,
  readIdempotencyPath,
  validateGenericConfig,
} from '../src';
import type { AdapterContext } from '../src';
import { CATALOG, entryProblems } from '../src/catalog/catalog';
import { acceptanceA, readCatalogSources } from '../src/catalog/catalog-files';
import { CatalogEntry } from '../src/catalog/types';

/**
 * PK10 (SPEC-provider-khac E31, ADR-230): khoá chống trùng `{path}` (id lồng ≤ 3 cấp, tên trường thuần) và `{bodyHash: true}`
 * (băm bytes body). Không literal secret: các ca chỉ gọi `extractIdempotencyKey` (không verify).
 */
const a = new GenericAdapter();
const ctx = (vc: unknown): AdapterContext => ({ verificationConfig: vc, projectFlags: { allowUnverified: true } });
const req = (body: string | Buffer, headers: Record<string, string> = {}) => {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
  } catch {
    parsed = undefined;
  }
  return { provider: 'generic' as const, sourceKey: 'src_generic_x', headers: headers as any, rawBody: raw, body: parsed, contentType: 'application/json', method: 'POST' as const, query: '' };
};
const HMAC = { scheme: 'hmac', header: 'x-acme-signature', algo: 'sha256', encoding: 'hex', eventType: 'acme.event' };
const cfg = (idempotency: unknown, base: Record<string, unknown> = HMAC) => ({ ...base, idempotency });
const field = (vc: unknown) => (validateGenericConfig(vc) as { field?: string }).field;

describe('[PK:T40] (phần a) validator: idempotency.path (≤ 3 cấp, tên trường thuần) và bodyHash', () => {
  it('path 1–3 cấp, mỗi cấp ^[A-Za-z0-9_-]{1,64}$ -> nhận, lưu nguyên văn', () => {
    for (const p of ['id', 'data.id', 'webhook_metadata.event.id', 'event-data.x_1.Id', `${'a'.repeat(64)}.b`]) {
      const r = validateGenericConfig(cfg({ path: p }));
      expect([p, r.ok && r.config.idempotency]).toEqual([p, { path: p }]);
    }
  });

  it(`path sai khuôn -> 422 field idempotency.path: > ${PATH_MAX_DEPTH} cấp, chỉ số mảng, biểu thức, cấp rỗng, nguyên mẫu, không phải chuỗi`, () => {
    const badPaths: unknown[] = [
      'a.b.c.d', // 4 cấp (đột biến "vượt 3 cấp")
      'data[0].id',
      'data.0x[1]',
      '$.data.id',
      'data.*',
      'data..id',
      '.id',
      'id.',
      '',
      'data id',
      'data.ïd',
      `${'a'.repeat(65)}.id`,
      '__proto__.polluted',
      'a.constructor',
      'prototype',
      42,
      null,
      ['data', 'id'],
    ];
    for (const p of badPaths) expect([p, field(cfg({ path: p }))]).toEqual([p, 'idempotency.path']);
    expect(idempotencyPathProblem('a.b.c.d')).toMatch(/tối đa 3 cấp/);
  });

  it('bodyHash: true nhận ở hmac, hmac-sha256, static-token (header/basic/query), signed-template, unverified; standard-webhooks -> 422 (luôn có webhook-id)', () => {
    const schemes: Record<string, unknown>[] = [
      HMAC,
      { scheme: 'hmac-sha256', header: 'x-sig', eventType: 'acme.event' },
      { scheme: 'static-token', header: 'x-token', eventType: 'acme.event' },
      { scheme: 'static-token', location: 'basic', eventType: 'acme.event' },
      { scheme: 'static-token', location: 'query', param: 'token', eventType: 'acme.event' },
      { scheme: 'signed-template', template: '{timestamp}.{body}', algo: 'sha256', encoding: 'hex', signature: { headers: ['x-sig'] }, timestampHeader: 'x-ts', toleranceSec: 300, eventType: 'acme.event' },
      { scheme: 'unverified', eventType: 'acme.event' },
    ];
    for (const s of schemes) {
      const r = validateGenericConfig(cfg({ bodyHash: true }, s));
      expect([s.scheme, r.ok && r.config.idempotency]).toEqual([s.scheme, { bodyHash: true }]);
    }
    expect(field({ scheme: 'standard-webhooks', idempotency: { bodyHash: true }, eventType: 'acme.event' })).toBe('idempotency.bodyHash');
    // path vẫn dùng được với standard-webhooks (id lồng trong body đã ký).
    expect(validateGenericConfig({ scheme: 'standard-webhooks', idempotency: { path: 'data.id' }, eventType: 'acme.event' }).ok).toBe(true);
  });

  it('bodyHash khác true, hai dạng cùng lúc, dạng lạ -> 422 field idempotency(.bodyHash)', () => {
    for (const v of [false, 'true', 1, null]) expect([v, field(cfg({ bodyHash: v }))]).toEqual([v, 'idempotency.bodyHash']);
    expect(field(cfg({ bodyHash: true, field: 'id' }))).toBe('idempotency');
    expect(field(cfg({ path: 'data.id', header: 'x-id' }))).toBe('idempotency');
    expect(field(cfg({ jsonPath: '$.id' }))).toBe('idempotency');
  });

  it('tương thích ngược: {header}/{field} giữ khuôn và thông điệp cũ; field vẫn chỉ CẤP MỘT (không dấu chấm)', () => {
    expect(validateGenericConfig(cfg({ field: 'transId' }))).toMatchObject({ ok: true, config: { idempotency: { field: 'transId' } } });
    expect(validateGenericConfig(cfg({ header: 'x-event-id' }))).toMatchObject({ ok: true, config: { idempotency: { header: 'x-event-id' } } });
    expect(field(cfg({ field: 'data.id' }))).toBe('idempotency.field');
  });

  it('bắt tay: when.field trùng cấp đầu của path (mọi sự kiện đều mang) -> 422 handshake.when.field', () => {
    const hs = { kind: 'body-echo', when: { field: 'data', equals: 'url_verification' }, echo: { field: 'challenge' } };
    expect(field({ ...cfg({ path: 'data.id' }), handshake: hs })).toBe('handshake.when.field');
    expect(validateGenericConfig({ ...cfg({ path: 'data.id' }), handshake: { ...hs, when: { field: 'type', equals: 'url_verification' } } }).ok).toBe(true);
  });
});

describe('[PK:T40] (phần b) adapter: khoá theo path / bodyHash — tất định, không ngẫu nhiên', () => {
  it('path: đọc id lồng -> generic:<id>; số -> chuỗi; 3 cấp', () => {
    expect(a.extractIdempotencyKey(req('{"data":{"id":"EVT1"}}'), ctx(cfg({ path: 'data.id' })))).toBe('generic:EVT1');
    expect(a.extractIdempotencyKey(req('{"data":{"id":42}}'), ctx(cfg({ path: 'data.id' })))).toBe('generic:42');
    const heroku = '{"id":"d4","webhook_metadata":{"attempt":{"id":"at1"},"event":{"id":"d472"}}}';
    expect(a.extractIdempotencyKey(req(heroku), ctx(cfg({ path: 'webhook_metadata.event.id' })))).toBe('generic:d472');
  });

  it('path thiếu giá trị (vắng / mảng / object / rỗng / quá dài) -> băm bytes body generic:body:<bodyHashKey>, cùng bytes cùng khoá', () => {
    const c = ctx(cfg({ path: 'data.id' }));
    for (const b of ['{"data":{}}', '{"data":[{"id":"x"}]}', '{"data":{"id":{"v":1}}}', '{"data":{"id":""}}', `{"data":{"id":"${'x'.repeat(201)}"}}`, '{"other":1}', 'not json']) {
      expect([b, a.extractIdempotencyKey(req(b), c)]).toEqual([b, `generic:body:${bodyHashKey(Buffer.from(b))}`]);
      expect(a.extractIdempotencyKey(req(b), c)).toBe(a.extractIdempotencyKey(req(b), c));
    }
  });

  it('readIdempotencyPath: chỉ thuộc tính riêng của object thường — không đọc nguyên mẫu, không đi qua mảng', () => {
    expect(readIdempotencyPath({ a: { b: 'x' } }, 'a.b')).toBe('x');
    expect(readIdempotencyPath({ a: [{ b: 'x' }] }, 'a.b')).toBeUndefined();
    expect(readIdempotencyPath({}, 'toString')).toBeUndefined();
    expect(readIdempotencyPath({ a: {} }, 'a.hasOwnProperty')).toBeUndefined();
    expect(readIdempotencyPath(JSON.parse('{"__proto__":{"id":"p"}}'), '__proto__.id')).toBe('p'); // khoá riêng thật, không phải nguyên mẫu
    expect(readIdempotencyPath(null, 'a')).toBeUndefined();
  });

  it('bodyHash: cùng bytes -> cùng khoá; khác 1 byte -> khoá khác; khoá = generic:body:bodyHashKey(rawBody) (không ngẫu nhiên)', () => {
    const c = ctx(cfg({ bodyHash: true }));
    const b1 = '{"event":"order_created","total":1199}';
    const b2 = '{"event":"order_created","total":1198}';
    const k1 = a.extractIdempotencyKey(req(b1), c);
    expect(k1).toBe(`generic:body:${bodyHashKey(Buffer.from(b1))}`);
    expect(a.extractIdempotencyKey(req(b1), c)).toBe(k1);
    expect(a.extractIdempotencyKey(req(b2), c)).not.toBe(k1);
    // Header id (không được ký) không đổi được khoá bodyHash.
    expect(a.extractIdempotencyKey(req(b1, { 'x-event-id': 'other' }), c)).toBe(k1);
  });

  it('bodyHash / path với body RỖNG -> EmptyBodyIdempotencyError (code empty_body, là IdempotencyKeyMissingError để lõi trả 422)', () => {
    for (const id of [{ bodyHash: true }, { path: 'data.id' }]) {
      let err: unknown;
      try {
        a.extractIdempotencyKey(req(''), ctx(cfg(id)));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EmptyBodyIdempotencyError);
      expect(err).toBeInstanceOf(IdempotencyKeyMissingError);
      expect((err as EmptyBodyIdempotencyError).code).toBe('empty_body');
    }
    expect(new IdempotencyKeyMissingError('x').code).toBe('missing_idempotency_key');
  });

  it('unverified: bodyHash = như vắng (E7 giữ nguyên, kể cả body rỗng); path ghép băm như field; path thiếu -> chỉ băm', () => {
    const U = { scheme: 'unverified', eventType: 'acme.event' };
    for (const b of ['{"x":1}', '']) {
      const none = a.extractIdempotencyKey(req(b), ctx(U));
      expect(none).toBe(`generic:${bodyHashKey(Buffer.from(b))}`);
      expect(a.extractIdempotencyKey(req(b), ctx(cfg({ bodyHash: true }, U)))).toBe(none);
    }
    const b = '{"data":{"id":"T1"}}';
    expect(a.extractIdempotencyKey(req(b), ctx(cfg({ path: 'data.id' }, U)))).toBe(`generic:T1:${bodyHashKey(Buffer.from(b))}`);
    expect(a.extractIdempotencyKey(req('{"a":1}'), ctx(cfg({ path: 'data.id' }, U)))).toBe(`generic:${bodyHashKey(Buffer.from('{"a":1}'))}`);
  });

  it('tương thích ngược: khoá của source hiện có KHÔNG đổi (field, header, standard-webhooks, unverified + field)', () => {
    expect(a.extractIdempotencyKey(req('{"transId":"TX1"}'), ctx(cfg({ field: 'transId' })))).toBe('generic:TX1');
    expect(a.extractIdempotencyKey(req('{}', { 'x-event-id': 'E1' }), ctx(cfg({ header: 'x-event-id' })))).toBe('generic:E1');
    expect(a.extractIdempotencyKey(req('{}', { 'webhook-id': 'msg_1' }), ctx({ scheme: 'standard-webhooks', eventType: 'acme.event' }))).toBe('generic:msg_1');
    const b = '{"transId":"T1"}';
    expect(a.extractIdempotencyKey(req(b), ctx({ scheme: 'unverified', idempotency: { field: 'transId' }, eventType: 'acme.event' }))).toBe(
      `generic:T1:${bodyHashKey(Buffer.from(b))}`,
    );
    expect(() => a.extractIdempotencyKey(req('{}'), ctx(cfg({ field: 'transId' })))).toThrow(IdempotencyKeyMissingError);
  });

  it('chẩn đoán + ack: REJECTED ký đúng của nguồn bodyHash/path -> reason empty_body; ack 422 empty_body có fix riêng', () => {
    const stored = { status: 'REJECTED', signatureValid: true, headers: {}, body: null, receivedAt: new Date() };
    expect(a.diagnose(stored, ctx(cfg({ bodyHash: true })))).toEqual({ ok: false, reason: 'empty_body' });
    expect(a.diagnose(stored, ctx(cfg({ path: 'data.id' })))).toEqual({ ok: false, reason: 'empty_body' });
    expect(a.diagnose(stored, ctx(cfg({ field: 'transId' })))).toEqual({ ok: false, reason: 'missing_idempotency_key', expectedField: 'transId' });
    const ack = a.buildAck({ accepted: false, status: 422, message: EMPTY_BODY_ERROR } as any, ctx(cfg({ bodyHash: true }))) as any;
    expect(ack).toEqual({ status: 422, body: { ok: false, error: 'empty_body', fix: expect.stringMatching(/Empty body/) } });
  });
});

describe('[PK:T41] danh mục: mục bodyHash phải có bodyHashReason kèm nguồn; mục mới qua bài A', () => {
  const sources = readCatalogSources();
  const base = (): CatalogEntry => JSON.parse(JSON.stringify(CATALOG.find((e) => e.id === 'typeform')!));
  const withBodyHash = (mut: (e: any) => void = () => undefined) => {
    const e: any = base();
    e.handler.config.idempotency = { bodyHash: true };
    e.bodyHashReason = `Tài liệu không có id sự kiện; gửi lại giữ nguyên body (${e.sources[0]}).`;
    mut(e);
    return entryProblems(e).join(' | ');
  };

  it('bodyHash có bodyHashReason trích URL trong sources -> hợp lệ', () => {
    expect(withBodyHash()).toBe('');
  });

  it('bỏ bodyHashReason / lý do rỗng / không trích URL / URL ngoài sources -> lỗi; cả trong alternatives', () => {
    expect(withBodyHash((e) => delete e.bodyHashReason)).toContain('bodyHashReason');
    expect(withBodyHash((e) => (e.bodyHashReason = '   '))).toContain('bodyHashReason');
    expect(withBodyHash((e) => (e.bodyHashReason = 'Không có id, gửi lại giữ nguyên body theo tài liệu.'))).toContain('URL có trong sources');
    expect(withBodyHash((e) => (e.bodyHashReason = 'Không có id, gửi lại giữ nguyên body (https://example.com/khac).'))).toContain('URL có trong sources');
    const alt = base() as any;
    alt.handler.alternatives = [{ note: 'không id', config: { ...alt.handler.config, idempotency: { bodyHash: true } } }];
    expect(entryProblems(alt).join(' | ')).toContain('alternatives[0].config dùng idempotency.bodyHash');
  });

  it('bodyHash với body luôn rỗng (khuôn empty, vd google-drive) -> lỗi; bodyHashReason mà không dùng bodyHash -> lỗi', () => {
    expect(withBodyHash((e) => (e.fingerprint.body = { format: 'empty', required: [], optional: [] }))).toContain('body luôn rỗng');
    const e: any = base();
    e.bodyHashReason = `x (${e.sources[0]}) đủ dài để qua độ dài`;
    expect(entryProblems(e).join(' | ')).toContain('bodyHashReason chỉ dùng khi');
  });

  it('danh mục thật: mọi mục dùng bodyHash có bodyHashReason hợp lệ; mục path dùng ≤ 3 cấp; bài A xanh cho mục PK10', () => {
    expect(sources.problems).toEqual([]);
    const configs = (e: CatalogEntry) => ('config' in e.handler ? [e.handler.config, ...(e.handler.alternatives ?? []).map((x) => x.config)] : []);
    for (const e of CATALOG) {
      for (const c of configs(e)) {
        const id = (c as any).idempotency;
        if (id?.bodyHash) expect([e.id, typeof e.bodyHashReason]).toEqual([e.id, 'string']);
        if (id?.path) expect([e.id, idempotencyPathProblem(id.path)]).toEqual([e.id, null]);
      }
    }
    // Mục PK10 đã đối chiếu tài liệu (2026-10-14): path (heroku, pipedrive) + field nay đã xác minh (circleci, squarespace, checkout-com).
    const PK10_IDS = ['checkout-com', 'circleci', 'heroku', 'pipedrive', 'squarespace'];
    for (const id of PK10_IDS) expect([id, CATALOG.some((e) => e.id === id), sources.pending.some((p) => p.id === id)]).toEqual([id, true, false]);
    expect(CATALOG.find((e) => e.id === 'heroku')!.handler).toMatchObject({ config: { idempotency: { path: 'webhook_metadata.event.id' } } });
    expect(CATALOG.find((e) => e.id === 'pipedrive')!.handler).toMatchObject({ config: { idempotency: { path: 'meta.id' } } });
    const pk10 = CATALOG.filter((e) => configs(e).some((c: any) => c.idempotency?.path || c.idempotency?.bodyHash) || PK10_IDS.includes(e.id));
    expect(pk10.length).toBeGreaterThanOrEqual(PK10_IDS.length);
    const rows = acceptanceA(CATALOG, sources.fixtures).filter((r) => pk10.some((e) => e.id === r.entryId));
    expect(rows.length).toBeGreaterThanOrEqual(pk10.length);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });
});
