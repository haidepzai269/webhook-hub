import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * LOGGING.md §5 + §10 "an toàn" — BÃI MÌN. Request chứa `whsec_…`, API key, số tài khoản, header chữ ký, Authorization, body
 * thật; lỗi hạ tầng mang chuỗi bí mật trong message. QUÉT TOÀN BỘ output log (logger THẬT của hub — cùng redact/scrub —
 * ghi vào bộ nhớ; không phải mock của canonical) -> không chuỗi mìn nào được xuất hiện.
 */
// Sink ở globalThis: factory chạy lúc import (trước khi các const của file khởi tạo) — tránh TDZ nếu có module ghi log lúc nạp.
const sinkOf = (): string[] => ((globalThis as any).__landmineSink ??= []);
jest.mock('@hub/common', () => {
  const actual = jest.requireActual('@hub/common');
  const sink = ((globalThis as any).__landmineSink ??= []) as string[];
  return { ...actual, logger: actual.createLogger({ write: (s: string) => { sink.push(s); } }) };
});
const mockSink = sinkOf();

describe('log — bãi mìn secret (LOGGING.md §5)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'gh-secret';
  const WHSEC = 'whsec_MINEMINEMINE1234567890abcdef';
  const APIKEY = 'hk_live_MINEKEYMINEKEY1234567890';
  const ACCT = '9704123456789012';
  const BEARER = 'Bearer MINEBEARERTOKEN1234567890abc';
  const HEARTBEAT = 'https://hc-ping.com/MINE-heartbeat-uuid-0000';
  const BODY_MARK = 'MINEBODYMARKER-NOT-IN-LOGS';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' }, secret: WHSEC, accountNumber: ACCT, note: BODY_MARK, key: APIKEY });
  const MINES = [WHSEC, APIKEY, ACCT, 'MINEBEARERTOKEN', 'MINE-heartbeat-uuid', BODY_MARK, 'MINEDESTSECRET'];

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
    process.env.HEARTBEAT_URL = HEARTBEAT;
  });
  beforeEach(() => {
    mockSink.length = 0;
  });

  function build(txError?: Error) {
    const source: any = { id: 'src-1', tenantId: 't', provider: 'github', isActive: true, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] };
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) }, outbox: { create: jest.fn().mockResolvedValue({}) } };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      tenantTx(_t: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => { if (txError) throw txError; return fn(tx); }),
      forTenant: () => ({ addIngestDuplicates: jest.fn(), addSourceTraffic: jest.fn() }),
    };
    const redis: any = { checkRateLimit: jest.fn().mockResolvedValue(true), getIdempotencyKey: jest.fn().mockResolvedValue(null), setIdempotencyKey: jest.fn() };
    const penalty: any = { checkIp: () => ({ blocked: false }), checkPair: () => ({ blocked: false }), recordUnknownSource: jest.fn(), recordBadSignature: jest.fn(), markGood: jest.fn(), size: () => 0, goodSize: () => 0 };
    return new IngestService(prisma, redis, undefined, penalty);
  }
  const req = (signature: string, over: Record<string, unknown> = {}): any => ({
    provider: 'github' as const,
    sourceKey: 'src_github_main',
    headers: { 'x-hub-signature-256': signature, 'x-github-delivery': 'd-1', 'x-github-event': 'push', authorization: BEARER, 'x-api-key': APIKEY, 'stripe-signature': 't=1,v1=MINESTRIPESIG' },
    rawBody: Buffer.from(body),
    body: JSON.parse(body),
    contentType: 'application/json',
    ...over,
  });
  const good = () => req('sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'));

  function assertClean() {
    const out = mockSink.join('');
    expect(out.length).toBeGreaterThan(100); // có log thật để quét (không phải quét chuỗi rỗng)
    for (const m of [...MINES, 'MINESTRIPESIG']) expect(out).not.toContain(m);
    expect(out).not.toMatch(/sha256=[0-9a-f]{20,}/);
    expect(out).not.toContain('0'.repeat(40));
  }

  it('thành công + chữ ký sai + 413 + hộp phạt không để lộ secret/body/chữ ký/số tài khoản/Authorization/HEARTBEAT_URL', async () => {
    const svc = build();
    await svc.ingestWebhook(good());
    await svc.ingestWebhook(req('sha256=' + '0'.repeat(64)));
    await svc.ingestWebhook(good());
    await svc.ingestWebhook({ ...good(), rawBody: Buffer.alloc(1024 * 1024 + 1, 97) });
    assertClean();
    expect(mockSink.some((l) => l.includes('"msg":"ingest.done"'))).toBe(true);
  });

  it('lỗi hạ tầng mà message chứa secret/số tài khoản: dòng lỗi chỉ có class + code + msg đã scrub', async () => {
    const svc = build(Object.assign(new Error(`connect failed ${WHSEC} acct ${ACCT} ${APIKEY} ${BEARER} ${HEARTBEAT}`), { code: 'ECONNRESET' }));
    await svc.ingestWebhook(good());
    assertClean();
    const line = mockSink.map((l) => JSON.parse(l)).find((l) => l.msg === 'ingest.done');
    expect(line.cause).toBe('fail.hub_db');
    expect(line.err.code).toBe('ECONNRESET');
  });

  it('đường storeRejected (chữ ký sai + ghi mẫu REJECTED lỗi, message lỗi mang secret): không lộ qua log.error', async () => {
    const svc = build(Object.assign(new Error(`insert failed body=${BODY_MARK} ${WHSEC} acct ${ACCT} ${APIKEY} ${BEARER} ${HEARTBEAT}`), { code: 'P2010', name: 'PrismaClientKnownRequestError', meta: { modelName: 'RawEvent' } }));
    await svc.ingestWebhook(req('sha256=' + '0'.repeat(64)));
    assertClean();
    const line = mockSink.map((l) => JSON.parse(l)).find((l) => l.msg === 'Lỗi khi lưu rejected raw_event');
    expect(line.err).toEqual({ class: 'PrismaClientKnownRequestError', code: 'P2010', msg: 'P2010 RawEvent' }); // Prisma: chỉ code + model, không message nguyên văn
  });

  it('object lồng nhau / mảng: logger scrub đệ quy chuỗi (whsec_, Bearer, hk_live_) ở mọi cấp, kể cả khoá không nằm trong SECRET_KEYS', () => {
    const { logger } = require('@hub/common');
    logger.info({ a: { b: [`x ${BEARER}`, { c: `k=${WHSEC}`, d: { e: [APIKEY] } }] }, plain: `auth ${APIKEY}` }, 'nested');
    const out = mockSink.join('');
    expect(out).toContain('nested');
    for (const m of [WHSEC, APIKEY, 'MINEBEARERTOKEN']) expect(out).not.toContain(m);
  });

  it('mọi dòng log là JSON hợp lệ có svc khi đã setServiceName', async () => {
    const { setServiceName } = jest.requireActual('@hub/common');
    setServiceName('hub-api');
    const svc = build();
    await svc.ingestWebhook(good());
    const parsed = mockSink.map((l) => JSON.parse(l));
    expect(parsed.length).toBeGreaterThan(0);
    for (const l of parsed) expect(l.svc).toBe('hub-api');
  });

  describe('scrubDeep — lưới an toàn (review 2A lần 2: N-1, N-2)', () => {
    const lg = () => (jest.requireMock('@hub/common') as any).logger;
    const KEY = 'hk_live_MINEKEYMINEKEY1234567890';

    it('Error thô { err }: message + stack không còn key thô, vẫn còn message đã che và class', () => {
      lg().error({ err: new Error(`boom ${KEY} tail`) }, 'x');
      const out = mockSink.join('');
      expect(out).not.toContain('MINEKEYMINEKEY');
      const rec = JSON.parse(mockSink[0]);
      expect(rec.err.message).toContain('boom');
      expect(rec.err.class).toBe('Error');
      expect(typeof rec.err.stack).toBe('string');
    });

    it('object sâu 10 cấp, secret ở đáy: không lọt, phần vượt trần là nhãn', () => {
      let o: any = { leaf: KEY };
      for (let i = 0; i < 10; i++) o = { next: o };
      lg().info({ deep: o }, 'x');
      const out = mockSink.join('');
      expect(out).not.toContain('MINEKEYMINEKEY');
      expect(out).toContain('[deep]');
    });

    it('instance class tự định nghĩa có field secret: được duyệt và scrub', () => {
      class Holder { constructor(public token: string, public note: string) {} }
      lg().info({ h: new Holder('x', `k=${KEY}`) }, 'x');
      expect(mockSink.join('')).not.toContain('MINEKEYMINEKEY');
    });

    it('Buffer lớn thành nhãn, không thành mảng số; Date giữ ISO', () => {
      lg().info({ b: Buffer.alloc(5000, 1), d: new Date('2026-01-02T03:04:05.000Z') }, 'x');
      const rec = JSON.parse(mockSink[0]);
      expect(rec.b).toBe('[Buffer 5000 bytes]');
      expect(rec.d).toBe('2026-01-02T03:04:05.000Z');
      expect(mockSink.join('').length).toBeLessThan(1000);
    });

    it('lỗi kiểu Prisma giữ code (+ meta đã scrub), không rò message/stack có tham số', () => {
      class PrismaClientKnownRequestError extends Error { code = 'P2024'; meta = { modelName: 'Event', target: `x ${KEY}` }; }
      lg().error({ err: new PrismaClientKnownRequestError(`Invalid invocation where: ${KEY}`) }, 'x');
      const out = mockSink.join('');
      expect(out).not.toContain('MINEKEYMINEKEY');
      const rec = JSON.parse(mockSink[0]);
      expect(rec.err.code).toBe('P2024');
      expect(rec.err.class).toBe('PrismaClientKnownRequestError');
      expect(rec.err.meta.modelName).toBe('Event');
    });

    it('logging không bao giờ ném: getter ném, Proxy trap ném, Proxy đã revoke, Error có getter message ném', () => {
      const getter = { get boom(): string { throw new Error('getter'); }, ok: `k=${KEY}` };
      const trap = new Proxy({}, { ownKeys() { throw new Error('trap'); }, get() { throw new Error('trap'); } });
      const rev = Proxy.revocable({}, {});
      rev.revoke();
      const badErr = new Error('m');
      Object.defineProperty(badErr, 'message', { get() { throw new Error('msg'); } });
      expect(() => lg().info({ getter, trap, rev: rev.proxy, badErr }, 'x')).not.toThrow();
      const out = mockSink.join('');
      expect(out).toContain('[unserializable]');
      expect(out).not.toContain('MINEKEYMINEKEY');
    });

    it('class/code của lỗi và khoá object cũng được scrub (không lọt tiền tố hk_live_)', () => {
      const e: any = new Error('m');
      e.code = KEY;
      class Foo extends Error { constructor() { super('m'); this.name = KEY; } }
      lg().error({ e1: e, e2: new Foo(), [KEY]: 1, a: { [KEY]: 2 } }, 'x');
      expect(mockSink.join('')).not.toContain('MINEKEY');
    });

    it('Error.cause được giữ (đã scrub); cause vòng không treo', () => {
      const root: any = new Error(`ECONNRESET ${KEY}`);
      root.code = 'ECONNRESET';
      const top: any = new Error('fetch failed', { cause: root });
      lg().error({ err: top }, 'x');
      const rec = JSON.parse(mockSink[0]);
      expect(rec.err.causedBy.code).toBe('ECONNRESET');
      expect(mockSink.join('')).not.toContain('MINEKEYMINEKEY');
      mockSink.length = 0;
      const a: any = new Error('a');
      const b: any = new Error('b', { cause: a });
      a.cause = b;
      expect(() => lg().error({ err: a }, 'x')).not.toThrow();
      expect(mockSink.join('')).toContain('[deep]');
    });

    it('logger.child({ tok: KEY }): bindings được scrub', () => {
      lg().child({ tok: `t=${KEY}` }).info('x');
      const out = mockSink.join('');
      expect(out).not.toContain('MINEKEYMINEKEY');
      expect(JSON.parse(mockSink[0]).pid).toBeDefined();
    });

    it('child của child (cấp 3): bindings() và dòng log giữ đủ trường, secret ở mọi cấp bị che', () => {
      const l1 = lg().child({ correlationId: 'c1', t1: `a=${KEY}` });
      const l2 = l1.child({ deliveryId: 'd1' });
      const l3 = l2.child({ x3: `b=${KEY}` });
      expect(l2.bindings()).toMatchObject({ correlationId: 'c1', deliveryId: 'd1' });
      expect(l3.bindings()).toMatchObject({ correlationId: 'c1', deliveryId: 'd1' });
      l3.info('x');
      const rec = JSON.parse(mockSink[0]);
      expect(rec.correlationId).toBe('c1');
      expect(rec.deliveryId).toBe('d1');
      expect(rec.x3).toBeDefined();
      expect(mockSink.join('')).not.toContain('MINEKEYMINEKEY');
    });

    it('đối số format object (`m %j`) và setBindings được scrub', () => {
      lg().info('m %j', { k: KEY });
      const c = lg().child({ a: 1 });
      c.setBindings({ tok: KEY });
      c.info('y');
      expect(mockSink.join('')).not.toContain('MINEKEYMINEKEY');
    });

    it('không ném với `%s` + object có toString/valueOf là hàm; getter ném ở vị trí 1 cũng không ném', () => {
      expect(() => lg().info('m %s', { toString() { return 'x'; }, valueOf() { return 1; } })).not.toThrow();
      expect(JSON.parse(mockSink[0]).msg).toContain('m ');
      expect(() => lg().info({ get boom(): string { throw new Error('g'); } }, 'x')).not.toThrow();
    });

    it('Error là đối số ĐẦU: msg không chứa key thô, err vẫn có class/stack', () => {
      lg().error(new Error(`x ${KEY}`));
      const rec = JSON.parse(mockSink[0]);
      expect(mockSink.join('')).not.toContain('MINEKEYMINEKEY');
      expect(rec.msg).toContain('x ');
      expect(rec.err.class).toBe('Error');
      mockSink.length = 0;
      lg().error(new Error(`y ${KEY}`), 'mô tả');
      expect(JSON.parse(mockSink[0]).msg).toBe('mô tả');
      expect(mockSink.join('')).not.toContain('MINEKEYMINEKEY');
    });

    it('`log.info("m %s", err)` ra `Error: boom` đã scrub, không phải [object Object]', () => {
      lg().info('m %s', new Error(`boom ${KEY}`));
      const rec = JSON.parse(mockSink[0]);
      expect(rec.msg).toMatch(/^m Error: boom /);
      expect(mockSink.join('')).not.toContain('MINEKEYMINEKEY');
    });

    it('trần: mảng 61 phần tử (secret ở vị trí 61) và object 201 khoá (secret ở khoá 201) không lọt, có dấu cắt', () => {
      const arr = Array.from({ length: 60 }, () => 'a');
      arr.push(KEY);
      const obj: Record<string, string> = {};
      for (let i = 0; i < 200; i++) obj[`k${i}`] = 'v';
      obj.k200 = KEY;
      lg().info({ arr, obj }, 'x');
      const out = mockSink.join('');
      expect(out).not.toContain('MINEKEYMINEKEY');
      expect(out).toContain('[truncated 1]');
      expect(out).toContain('__truncated');
      const rec = JSON.parse(mockSink[0]);
      expect(rec.arr).toHaveLength(61);
      expect(rec.arr[60]).toBe('[truncated 1]');
      expect(Object.keys(rec.obj)).toHaveLength(201); // 200 khoá + __truncated
    });
  });
});
