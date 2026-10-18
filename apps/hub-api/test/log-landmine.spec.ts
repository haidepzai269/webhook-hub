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
});
