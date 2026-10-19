import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { aesGcmEncrypt } from '@hub/crypto';
import { CanonicalLogger, DEFAULT_SLOW_THRESHOLDS, MAX_INGEST_PAYLOAD_BYTES, parseTraceparent, traceIdOf } from '@hub/common';
import { IngestService, TraceNotifier } from '../src/modules/ingest/ingest.service';

/**
 * LOGGING.md §10 — test hợp đồng log (ingest): mỗi đường (kể cả TỪ CHỐI, trước đây KHÔNG có dòng log) phát đúng MỘT dòng
 * `ingest.done` với đúng `cause`; ngân sách Redis/DB không đổi; trace_id xuyên vào outbox. Bãi mìn secret: log-landmine.spec.ts.
 */
describe('ingest.done — canonical line theo từng đường (LOGGING.md §3, §10)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'gh-secret';
  const TENANT = 'tenant-a';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' } });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  interface Opts {
    source?: 'none' | 'inactive' | 'ok' | 'full' | 'otherProvider';
    rateOk?: boolean;
    dup?: 'redis' | 'pg';
    txError?: Error;
    txDelayMs?: number;
    blocked?: 'ip' | 'pair';
    thresholds?: Partial<typeof DEFAULT_SLOW_THRESHOLDS>;
  }

  function build(opts: Opts = {}) {
    const source: any = {
      id: 'src-1',
      tenantId: TENANT,
      provider: opts.source === 'otherProvider' ? 'stripe' : 'github',
      isActive: opts.source !== 'inactive',
      secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }],
      ...(opts.source === 'full' ? { storageLevel: 'HARD_LOCKED' } : {}),
    };
    const txRaw = { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) };
    const txOutbox = { create: jest.fn().mockResolvedValue({}) };
    const tx = { rawEvent: txRaw, outbox: txOutbox };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(opts.source === 'none' ? null : source),
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => {
        if (opts.txDelayMs) await new Promise((r) => setTimeout(r, opts.txDelayMs));
        if (opts.txError) throw opts.txError;
        if (opts.dup === 'pg') throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        return fn(tx);
      }),
      forTenant: () => ({ addIngestDuplicates: jest.fn(), addSourceTraffic: jest.fn(), findSourceById: jest.fn().mockResolvedValue({ ...source }) }),
    };
    const redis: any = {
      checkRateLimit: jest.fn().mockResolvedValue(opts.rateOk ?? true),
      getIdempotencyKey: jest.fn().mockResolvedValue(opts.dup === 'redis' ? 'raw-0' : null),
      setIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    };
    const notifier = { traceIngested: jest.fn() } as TraceNotifier & { traceIngested: jest.Mock };
    const penalty: any = {
      checkIp: () => (opts.blocked === 'ip' ? { blocked: true, retryAfterSec: 30 } : { blocked: false }),
      checkPair: () => (opts.blocked === 'pair' ? { blocked: true, retryAfterSec: 30 } : { blocked: false }),
      recordUnknownSource: jest.fn(),
      recordBadSignature: jest.fn(),
      markGood: jest.fn(),
      size: () => 0,
      goodSize: () => 0,
    };
    const svc = new IngestService(prisma, redis, notifier, penalty);
    const lines: Array<{ level: string; obj: Record<string, any>; msg: string }> = [];
    const log: any = {};
    for (const l of ['debug', 'info', 'warn', 'error']) log[l] = (obj: any, msg: string) => lines.push({ level: l, obj, msg });
    const clock = { now: 1_000_000 };
    svc.canonical = new CanonicalLogger({ log, successSample: 1, dedupeWindowMs: 30_000, now: () => clock.now, thresholds: { ...DEFAULT_SLOW_THRESHOLDS, ...(opts.thresholds ?? {}) } });
    const done = () => lines.filter((l) => l.msg === 'ingest.done');
    return { svc, prisma, redis, notifier, penalty, lines, done, clock, tx, txOutbox, txRaw };
  }

  const req = (signature: string, extra: Record<string, unknown> = {}): any => ({
    provider: 'github' as const,
    sourceKey: 'src_github_main',
    headers: { 'x-hub-signature-256': signature, 'x-github-delivery': 'd-1', 'x-github-event': 'push' },
    rawBody: Buffer.from(body),
    body: JSON.parse(body),
    contentType: 'application/json',
    ...extra,
  });
  const good = (extra: Record<string, unknown> = {}) => req('sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'), extra);
  const BAD_SIG = 'sha256=' + '0'.repeat(64);

  it('thành công: MỘT dòng info, outcome accepted, KHÔNG cause; có trace_id/span_id/stage_ms/total_ms/source/provider', async () => {
    const t = build();
    const res = await t.svc.ingestWebhook(good());
    expect(res.status).toBe(200);
    expect(t.done()).toHaveLength(1);
    const { level, obj } = t.done()[0];
    expect(level).toBe('info');
    expect(obj).toMatchObject({ svc: 'hub-api', outcome: 'accepted', http_status: 200, provider: 'github', source_id: 'src-1', tenant_id: TENANT, raw_event_id: 'raw-1' });
    expect(obj.cause).toBeUndefined();
    expect(obj.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(obj.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof obj.total_ms).toBe('number');
    for (const k of ['verify', 'redis', 'db_commit']) expect(typeof obj.stage_ms[k]).toBe('number');
  });

  it('chữ ký sai -> outcome rejected, cause wrong.signature (blame provider), 401, KHÔNG chứa chữ ký trong dòng', async () => {
    const t = build();
    const res = await t.svc.ingestWebhook(req(BAD_SIG));
    expect(res.status).toBe(401);
    expect(t.done()).toHaveLength(1);
    const { level, obj } = t.done()[0];
    expect(level).toBe('warn');
    expect(obj).toMatchObject({ outcome: 'rejected', cause: 'wrong.signature', blame: 'provider', http_status: 401, source_id: 'src-1' });
    expect(JSON.stringify(t.lines)).not.toContain(BAD_SIG);
    expect(JSON.stringify(t.lines)).not.toContain('0'.repeat(32));
  });

  it('nguồn lạ / đã tắt / lệch provider (404) -> wrong.unknown_source', async () => {
    for (const source of ['none', 'inactive', 'otherProvider'] as const) {
      const t = build({ source });
      const res = await t.svc.ingestWebhook(good());
      expect(res.status).toBe(404);
      expect(t.done()).toHaveLength(1);
      expect(t.done()[0].obj).toMatchObject({ outcome: 'rejected', cause: 'wrong.unknown_source', http_status: 404 });
    }
  });

  it('body > 1MB (413) và query > 8KB (414) -> wrong.payload_shape, có bytes', async () => {
    const t = build();
    const r1 = await t.svc.ingestWebhook(good({ rawBody: Buffer.alloc(MAX_INGEST_PAYLOAD_BYTES + 1, 97) }));
    expect(r1.status).toBe(413);
    expect(t.done()[0].obj).toMatchObject({ outcome: 'rejected', cause: 'wrong.payload_shape', http_status: 413, bytes: MAX_INGEST_PAYLOAD_BYTES + 1 });
    const r2 = await build().svc.ingestWebhook(good({ query: 'a='.padEnd(9000, 'x') }));
    expect(r2.status).toBe(414);
    const t3 = build();
    await t3.svc.ingestWebhook(good({ query: 'a='.padEnd(9000, 'x') }));
    expect(t3.done()[0].obj).toMatchObject({ cause: 'wrong.payload_shape', http_status: 414 });
  });

  it('hộp phạt chặn (IP và cặp) -> refused/wrong.policy_blocked policy penalty_*, 429; bão chỉ 1 dòng + suppressed (không 1 dòng/request)', async () => {
    const t = build({ blocked: 'ip' });
    for (let i = 0; i < 6; i++) {
      const res = await t.svc.ingestWebhook(good());
      expect(res.status).toBe(429);
    }
    expect(t.done()).toHaveLength(1);
    expect(t.done()[0].obj).toMatchObject({ outcome: 'refused', cause: 'wrong.policy_blocked', policy: 'penalty_ip', http_status: 429 });
    t.clock.now += 31_000;
    await t.svc.ingestWebhook(good());
    expect(t.done()).toHaveLength(2);
    expect(t.done()[1].obj.sampled).toEqual({ suppressed: 5 });
    const p = build({ blocked: 'pair' });
    await p.svc.ingestWebhook(good());
    expect(p.done()[0].obj).toMatchObject({ cause: 'wrong.policy_blocked', policy: 'penalty_pair' });
    expect(p.prisma.$transaction).not.toHaveBeenCalled(); // bị chặn: 0 DB
  });

  it('rate limit theo source (429) -> refused, wrong.policy_blocked policy rate_limit', async () => {
    const t = build({ rateOk: false });
    const res = await t.svc.ingestWebhook(good());
    expect(res.status).toBe(429);
    expect(t.done()[0].obj).toMatchObject({ outcome: 'refused', cause: 'wrong.policy_blocked', policy: 'rate_limit', http_status: 429 });
  });

  it('project đầy (507) -> refused, wrong.policy_blocked policy storage_full', async () => {
    const t = build({ source: 'full' });
    t.svc.storageLockEnabled = true;
    const res = await t.svc.ingestWebhook(good());
    expect(res.status).toBe(507);
    expect(t.done()[0].obj).toMatchObject({ outcome: 'refused', cause: 'wrong.policy_blocked', policy: 'storage_full', http_status: 507 });
  });

  it('trùng: Redis hit và UNIQUE PG -> outcome duplicate, wrong.duplicate (info), 0 lệnh Redis thêm', async () => {
    const baseline = build();
    await baseline.svc.ingestWebhook(good());
    const baseCalls = [baseline.redis.checkRateLimit, baseline.redis.getIdempotencyKey, baseline.redis.setIdempotencyKey].map((m) => m.mock.calls.length);
    expect(baseCalls).toEqual([1, 1, 1]);

    const r = build({ dup: 'redis' });
    await r.svc.ingestWebhook(good());
    expect(r.done()[0]).toMatchObject({ level: 'info', obj: { outcome: 'duplicate', cause: 'wrong.duplicate' } });
    expect([r.redis.checkRateLimit, r.redis.getIdempotencyKey, r.redis.setIdempotencyKey].map((m) => m.mock.calls.length)).toEqual([1, 1, 0]);

    const p = build({ dup: 'pg' });
    await p.svc.ingestWebhook(good());
    expect(p.done()[0].obj).toMatchObject({ outcome: 'duplicate', cause: 'wrong.duplicate' });
    expect([p.redis.checkRateLimit, p.redis.getIdempotencyKey, p.redis.setIdempotencyKey].map((m) => m.mock.calls.length)).toEqual([1, 1, 0]);
  });

  it('PG ném P2024 giữa tx -> fail.hub_db + err.code=P2024, HTTP 503 service_unavailable, outcome unavailable, KHÔNG SET NX Redis (BB-3)', async () => {
    const e = new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool. SECRET-PARAM-123456789', { code: 'P2024', clientVersion: 'test', meta: { modelName: 'RawEvent' } });
    const t = build({ txError: e });
    const res = await t.svc.ingestWebhook(good());
    expect(res.status).toBe(503);
    expect((res.body as any).error).toBe('service_unavailable');
    expect(res.outcome).toBe('unavailable');
    expect(t.redis.setIdempotencyKey).not.toHaveBeenCalled();
    const { level, obj } = t.done()[0];
    expect(level).toBe('error');
    expect(obj).toMatchObject({ outcome: 'unavailable', cause: 'fail.hub_db', blame: 'ha_tang', http_status: 503 });
    expect(obj.err).toEqual({ class: 'PrismaClientKnownRequestError', code: 'P2024', msg: 'P2024 RawEvent' });
    expect(JSON.stringify(t.lines)).not.toContain('SECRET-PARAM');
  });

  it('lỗi lạ (không phải hạ tầng) trong tx -> fail.hub_unknown (blame hub), 500 như cũ', async () => {
    const t = build({ txError: new TypeError('boom ngoài dự kiến') });
    const res = await t.svc.ingestWebhook(good());
    expect(res.status).toBe(500);
    expect(t.done()[0].obj).toMatchObject({ outcome: 'unavailable', cause: 'fail.hub_unknown', blame: 'hub', err: { class: 'TypeError' } });
  });

  it('đồng hồ DB chậm (vượt SLOW_INGEST_MS từ env/ngưỡng) -> slow.db (warn) dù vẫn accepted', async () => {
    const t = build({ txDelayMs: 80, thresholds: { ingestMs: 30 } });
    const res = await t.svc.ingestWebhook(good());
    expect(res.status).toBe(200);
    const { level, obj } = t.done()[0];
    expect(level).toBe('warn');
    expect(obj).toMatchObject({ outcome: 'accepted', cause: 'slow.db', blame: 'ha_tang' });
    expect(obj.stage_ms.db_commit).toBeGreaterThanOrEqual(70);
  });

  it('cold start: request đầu của tiến trình chậm -> slow.cold_start', async () => {
    const t = build({ txDelayMs: 80, thresholds: { ingestMs: 30 } });
    const res = await t.svc.ingestWebhook(good({ cold: true }));
    expect(res.status).toBe(200);
    expect(t.done()[0].obj).toMatchObject({ cause: 'slow.cold_start', blame: 'ha_tang' });
  });

  it('trace_id = correlationId bỏ "-" (cùng giá trị phát cho realtime) và traceparent + ingestedAt đi vào payload outbox JSON', async () => {
    const t = build();
    await t.svc.ingestWebhook(good());
    const notice = t.notifier.traceIngested.mock.calls[0][1];
    const traceId = traceIdOf(notice.correlationId);
    expect(traceId).toBe(t.done()[0].obj.trace_id);
    const payload = t.txOutbox.create.mock.calls[0][0].data.payload;
    expect(payload.correlationId).toBe(notice.correlationId);
    const tp = parseTraceparent(payload.traceparent);
    expect(tp).not.toBeNull();
    expect(tp!.traceId).toBe(traceId);
    expect(tp!.spanId).toBe(t.done()[0].obj.span_id);
    expect(typeof payload.ingestedAt).toBe('number');
  });

  describe('traceparent đến từ client (ADR-254): /hooks KHÔNG tin, /events (API key) có tin', () => {
    const CLIENT_TRACE = 'c0ffee00c0ffee00c0ffee00c0ffee00';
    const tp = (t: string) => `00-${t}-1111111111111111-01`;
    const hooksReq = (traceparent: string) => { const r = good(); r.headers.traceparent = traceparent; return r; };
    const evReq = (traceparent: string): any => ({ provider: 'api', sourceKey: 'api', headers: { traceparent }, rawBody: Buffer.from('{}'), body: { type: 'order.created', data: {}, idempotencyKey: 'k1' }, contentType: 'application/json' });

    it('(a) /hooks gửi traceparent hợp lệ: trace_id trong ingest.done và correlationId KHÁC trace_id của client; payload outbox cũng không mang nó', async () => {
      const t = build();
      await t.svc.ingestWebhook(hooksReq(tp(CLIENT_TRACE)));
      const notice = t.notifier.traceIngested.mock.calls[0][1];
      expect(t.done()[0].obj.trace_id).not.toBe(CLIENT_TRACE);
      expect(traceIdOf(notice.correlationId)).not.toBe(CLIENT_TRACE);
      expect(JSON.stringify(t.txOutbox.create.mock.calls[0][0].data.payload)).not.toContain(CLIENT_TRACE);
    });

    it('(b) /events traceparent hợp lệ: correlationId = trace_id của client, dòng log cùng trace_id', async () => {
      const t = build();
      const res = await t.svc.publishFromService(TENANT, 'src-1', evReq(tp(CLIENT_TRACE)));
      expect(res.status).toBeLessThan(300);
      expect(t.txOutbox.create.mock.calls[0][0].data.payload.correlationId).toBe('c0ffee00-c0ff-ee00-c0ff-ee00c0ffee00');
      expect(t.done()[0].obj.trace_id).toBe(CLIENT_TRACE);
    });

    it.each([['sai khuôn', 'rác'], ['trace_id toàn 0', tp('0'.repeat(32))], ['quá dài', 'x'.repeat(5000)], ['chữ hoa', tp('C0FFEE00C0FFEE00C0FFEE00C0FFEE00')]])('(c) /events traceparent %s: sinh trace mới, không ném', async (_n, bad) => {
      const t = build();
      const res = await t.svc.publishFromService(TENANT, 'src-1', evReq(bad));
      expect(res.status).toBeLessThan(300);
      expect(t.done()[0].obj.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(t.done()[0].obj.trace_id).not.toBe('0'.repeat(32));
    });
  });

  it('503 service_unavailable: requestId trong body = x-request-id hợp lệ (nếu có) hoặc correlationId; có Retry-After; dòng log mang request_id', async () => {
    const e = new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: 't' });
    const t = build({ txError: e });
    const r = good(); r.headers['x-request-id'] = 'nginx-req-id-12345';
    const res = await t.svc.ingestWebhook(r);
    expect(res.status).toBe(503);
    expect((res.body as any).requestId).toBe('nginx-req-id-12345');
    expect(res.headers).toMatchObject({ 'Retry-After': '5' });
    expect(t.done()[0].obj.request_id).toBe('nginx-req-id-12345');
    const t2 = build({ txError: e });
    const res2 = await t2.svc.ingestWebhook(good());
    expect(traceIdOf((res2.body as any).requestId)).toBe(t2.done()[0].obj.trace_id);
  });

  it('ngân sách: đường chấp nhận KHÔNG thêm lệnh Redis hay truy vấn DB nào để log/đo (1 nạp source + 1 transaction)', async () => {
    const t = build();
    await t.svc.ingestWebhook(good());
    expect(t.redis.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(t.redis.getIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(t.redis.setIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(t.prisma.findSourceBySourceKeyForIngest).toHaveBeenCalledTimes(1);
    expect(t.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('metric nối với log (§7): hub_log_events_total đếm ĐỦ kể cả dòng bị mẫu bỏ; hub_ingest_requests_total có nhãn cause; hub_stage_duration_seconds theo chặng', async () => {
    const { apiRegistry } = require('../src/modules/metrics/metrics');
    const t = build();
    t.svc.canonical = new CanonicalLogger({ log: { info: () => undefined, warn: () => undefined, error: () => undefined }, successSample: 0, dedupeWindowMs: 30_000 });
    const count = async (name: string, labels: Record<string, string>) => {
      const m = await apiRegistry.getSingleMetric(name).get();
      return m.values.filter((v: any) => Object.entries(labels).every(([k, val]) => v.labels[k] === val)).reduce((a: number, v: any) => a + v.value, 0);
    };
    const before = await count('hub_log_events_total', { msg: 'ingest.done', cause: '' });
    const beforeSig = await count('hub_ingest_requests_total', { outcome: 'REJECTED', cause: 'wrong.signature' });
    for (let i = 0; i < 7; i++) await t.svc.ingestWebhook(good());
    await t.svc.ingestWebhook(req(BAD_SIG));
    expect((await count('hub_log_events_total', { msg: 'ingest.done', cause: '' })) - before).toBe(7); // log ghi 0 dòng ok (mẫu 0) nhưng metric đủ 7
    expect((await count('hub_ingest_requests_total', { outcome: 'REJECTED', cause: 'wrong.signature' })) - beforeSig).toBe(1);
    const stages = await apiRegistry.getSingleMetric('hub_stage_duration_seconds').get();
    expect(stages.values.some((v: any) => v.metricName === 'hub_stage_duration_seconds_count' && v.labels.stage === 'db_commit' && v.value > 0)).toBe(true);
  });

  it('lấy mẫu thành công: LOG_SUCCESS_SAMPLE thấp bỏ dòng ok nhưng lỗi vẫn ghi đủ', async () => {
    const t = build();
    t.svc.canonical = new CanonicalLogger({ log: { info: () => t.lines.push({ level: 'info', obj: {}, msg: 'ingest.done' }), warn: (o: any, m: string) => t.lines.push({ level: 'warn', obj: o, msg: m }), error: () => undefined }, successSample: 0, dedupeWindowMs: 30_000 });
    await t.svc.ingestWebhook(good());
    expect(t.done()).toHaveLength(0);
    await t.svc.ingestWebhook(req(BAD_SIG));
    expect(t.done()).toHaveLength(1);
  });
});
