jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});
jest.mock('../src/senders/http-limits', () => ({ ...jest.requireActual('../src/senders/http-limits'), postLimited: jest.fn() }));
jest.mock('@hub/crypto', () => ({ ...jest.requireActual('@hub/crypto'), createSsrfSafeAxiosConfig: jest.fn() }));

import { Prisma } from '@prisma/client';
import { CanonicalLogger, DEFAULT_SLOW_THRESHOLDS, formatTraceparent, parseTraceparent } from '@hub/common';
import { createSsrfSafeAxiosConfig } from '@hub/crypto';
import { ProviderRegistry } from '@hub/providers';
import { DeliveryConsumer } from '../src/consumers/delivery.consumer';
import { NormalizeConsumer } from '../src/consumers/normalize.consumer';
import { OutboxRelay } from '../src/scheduler/outbox.relay';
import { SenderRegistry } from '../src/senders/sender.registry';
import { WebhookSender } from '../src/senders/webhook.sender';
import { postLimited } from '../src/senders/http-limits';
import { DELIVERY_ID, TENANT_ID, buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg } from './delivery-fixtures';

/**
 * LOGGING.md §10 — test hợp đồng log phía hub-worker (relay, normalize, delivery): đúng `cause` ở từng đường, `queue_wait`
 * theo công thức, `traceparent` xuyên relay -> normalize -> delivery -> retry -> header gửi đích (cùng trace_id, span khác nhau).
 */
const TRACE = '3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7';
const SPAN0 = 'a1b2c3d4e5f60718';
const TP = formatTraceparent(TRACE, SPAN0);
const WHSEC = 'whsec_' + Buffer.from('test-signing-secret').toString('base64');

function capture(thresholds: Partial<typeof DEFAULT_SLOW_THRESHOLDS> = {}) {
  const lines: Array<{ level: string; obj: Record<string, any>; msg: string }> = [];
  const log: any = {};
  for (const l of ['debug', 'info', 'warn', 'error']) log[l] = (obj: any, msg: string) => lines.push({ level: l, obj, msg });
  const clock = { now: 5_000_000 };
  const canonical = new CanonicalLogger({ log, successSample: 1, dedupeWindowMs: 30_000, now: () => clock.now, thresholds: { ...DEFAULT_SLOW_THRESHOLDS, ...thresholds } });
  const only = (msg: string) => lines.filter((l) => l.msg === msg);
  return { canonical, lines, only, clock };
}

describe('OutboxRelay — đóng dấu thời điểm publish + ngữ cảnh trace (LOGGING.md §3.2, §4)', () => {
  function setup(rows: any[]) {
    const channel: any = { publish: jest.fn((_e: string, _r: string, _b: Buffer, _o: any, cb: (e?: Error) => void) => { cb(); return true; }) };
    const tx: any = { $queryRawUnsafe: jest.fn(async () => rows), $executeRaw: jest.fn(async () => 1) };
    const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    return { relay: new OutboxRelay(prisma), channel, tx };
  }

  it('publish kèm properties.timestamp (ms), header x-outbox-age-ms (từ age_s SELECT sẵn), traceparent; 0 truy vấn thêm', async () => {
    const rows = [{ id: 1n, topic: 'event.received', payload: { rawEventId: 'r', correlationId: 'c1', traceparent: TP, ingestedAt: 1 }, age_s: 0.25 }];
    const { relay, channel, tx } = setup(rows);
    const before = Date.now();
    await relay.relayBatch(channel);
    const [, , buf, opts] = channel.publish.mock.calls[0];
    expect(opts.timestamp).toBeGreaterThanOrEqual(before);
    expect(opts.timestamp).toBeLessThanOrEqual(Date.now());
    expect(opts.headers).toMatchObject({ 'x-correlation-id': 'c1', traceparent: TP, 'x-outbox-age-ms': 250 });
    expect(JSON.parse(buf.toString()).rawEventId).toBe('r');
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1); // đúng 1 SELECT + 1 UPDATE như cũ
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('delivery.*: body message vẫn đúng 7 khoá (traceparent/replayOf đi bằng HEADER, không vào body — S1-1); replay có x-replay-of', async () => {
    const payload = { deliveryId: 'd', tenantId: 't', attemptGeneration: 2, attemptCount: 0, correlationId: 'c1', destinationId: 'x', rateLimitRps: 0, traceparent: TP, replayOf: 'f'.repeat(32) };
    const { relay, channel } = setup([{ id: 1n, topic: 'delivery.replayed', payload, age_s: 0 }, { id: 2n, topic: 'delivery.requested', payload: { ...payload, replayOf: undefined }, age_s: 0 }]);
    await relay.relayBatch(channel);
    const [, , body1, o1] = channel.publish.mock.calls[0];
    expect(Object.keys(JSON.parse(body1.toString())).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'destinationId', 'rateLimitRps', 'tenantId']);
    expect(o1.headers).toMatchObject({ traceparent: TP, 'x-replay-of': 'f'.repeat(32) });
    const o2 = channel.publish.mock.calls[1][3];
    expect(o2.headers['x-replay-of']).toBeUndefined();
  });

  it('payload cũ (không traceparent) vẫn publish bình thường; lỗi confirm -> ném (rollback cả lô)', async () => {
    const { relay, channel } = setup([{ id: 1n, topic: 'event.received', payload: { correlationId: 'c' }, age_s: 1 }]);
    await expect(relay.relayBatch(channel)).resolves.toBe(1);
    expect(channel.publish.mock.calls[0][3].headers.traceparent).toBeUndefined();
    channel.publish.mockImplementationOnce((_e: string, _r: string, _b: Buffer, _o: any, cb: (e?: Error) => void) => { cb(new Error('nack')); return true; });
    await expect(relay.relayBatch(channel)).rejects.toThrow('nack');
  });
});

describe('NormalizeConsumer — normalize.done (LOGGING.md §3, §10)', () => {
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const rawEventId = '11111111-1111-1111-1111-111111111111';
  afterEach(() => jest.restoreAllMocks());

  function build(opts: { txError?: Error; processed?: boolean; rawMissing?: boolean } = {}) {
    const outboxRows: any[] = [];
    const tx = {
      event: { create: jest.fn(async ({ data }: any) => data) },
      subscription: { findMany: jest.fn().mockResolvedValue([{ id: 'sub-0', destination: { id: 'dest-0', name: 'Đích', type: 'webhook', verification: 'VERIFIED', rateLimitRps: 0 } }]) },
      delivery: { create: jest.fn(async ({ data }: any) => ({ ...data, id: 'del-1' })) },
      outbox: { create: jest.fn(async ({ data }: any) => outboxRows.push(data)) },
      processedMessage: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue({
        findRawEventById: jest.fn().mockResolvedValue(opts.rawMissing ? null : {
          id: rawEventId, headers: { 'x-github-event': 'push' },
          body: { ref: 'refs/heads/main', commits: [], repository: { name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r' }, sender: { login: 'u' } },
          bodyRaw: Buffer.from('{}'), contentType: 'application/json',
        }),
      }),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(opts.processed ? { consumer: 'normalize' } : null) },
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => { if (opts.txError) throw opts.txError; return fn(tx); }),
    };
    const consumer = new NormalizeConsumer(prisma);
    const cap = capture();
    consumer.canonical = cap.canonical;
    return { consumer, outboxRows, ...cap };
  }
  const msg = (headers: Record<string, unknown> = {}, timestamp?: number, payload: Record<string, unknown> = { rawEventId, sourceId: 'src-1', tenantId: TENANT, provider: 'github', correlationId: 'corr-1' }) =>
    ({ content: Buffer.from(JSON.stringify(payload)), properties: { headers: { 'x-correlation-id': 'corr-1', ...headers }, ...(timestamp ? { timestamp } : {}) } }) as any;

  it('trace_id xuyên: header traceparent -> dòng normalize.done CÙNG trace_id (span khác) -> payload outbox delivery.requested mang traceparent mới; queue_wait chậm -> slow.queue_wait', async () => {
    const t = build();
    await t.consumer.handleMessage(msg({ traceparent: TP, 'x-outbox-age-ms': 250 }, Date.now() - 14_000), buildChannel());
    const [{ level, obj }] = t.only('normalize.done');
    expect(level).toBe('warn');
    expect(obj).toMatchObject({ svc: 'hub-worker', outcome: 'ok', trace_id: TRACE, cause: 'slow.queue_wait', blame: 'hub', tenant_id: TENANT, source_id: 'src-1', raw_event_id: rawEventId, provider: 'github' });
    expect(obj.span_id).not.toBe(SPAN0);
    expect(obj.stage_ms.queue_wait).toBeGreaterThanOrEqual(13_900);
    expect(obj.stage_ms.outbox_lag).toBe(250);
    for (const k of ['adapter', 'db_read', 'db_write']) expect(typeof obj.stage_ms[k]).toBe('number');
    expect(obj.event_name).toBe('repo.push');
    const tp = parseTraceparent(t.outboxRows[0].payload.traceparent);
    expect(tp).toMatchObject({ traceId: TRACE, spanId: obj.span_id });
  });

  it('message không có ngữ cảnh (cũ / replay thủ công): không lỗi, trace mới + trace_origin orphan; correlationId UUID -> suy trace_id', async () => {
    const t = build();
    await t.consumer.handleMessage(msg(), buildChannel());
    expect(t.only('normalize.done')[0].obj).toMatchObject({ outcome: 'ok', trace_origin: 'orphan' });
    expect(t.only('normalize.done')[0].obj.cause).toBeUndefined();
    const t2 = build();
    await t2.consumer.handleMessage(msg({ 'x-correlation-id': '3f2a9c1e-5b7d-4a08-b6c1-d2e3f4a5b6c7' }), buildChannel());
    expect(t2.only('normalize.done')[0].obj.trace_id).toBe(TRACE);
  });

  it('adapter ra sai khuôn catalog -> wrong.schema_mismatch (error, DLQ) TÁCH khỏi adapter ném lỗi -> fail.hub_unknown', async () => {
    const bad = { id: 'e', tenantId: TENANT, type: 'payment.received', source: 'sepay', sourceId: 's', data: { amount: 1.5 }, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), correlationId: 'c', origin: 'webhook', normalized: true };
    jest.spyOn(ProviderRegistry, 'get').mockReturnValue({ normalize: () => [bad] } as any);
    const t = build();
    const ch = buildChannel();
    await t.consumer.handleMessage(msg(), ch);
    expect(ch.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(t.only('normalize.done')[0]).toMatchObject({ level: 'error', obj: { outcome: 'dead', cause: 'wrong.schema_mismatch', blame: 'provider' } });
    expect(JSON.stringify(t.lines)).not.toContain('1.5'); // giá trị dữ liệu không vào log, chỉ tên trường ở thông điệp

    jest.spyOn(ProviderRegistry, 'get').mockReturnValue({ normalize: () => { throw new TypeError('adapter vỡ'); } } as any);
    const t2 = build();
    await t2.consumer.handleMessage(msg(), buildChannel());
    expect(t2.only('normalize.done')[0].obj).toMatchObject({ outcome: 'dead', cause: 'fail.hub_unknown', blame: 'hub', err: { class: 'TypeError' } });
  });

  it('lỗi tạm hạ tầng (P2024) -> retry 30s, fail.hub_db + err.code; hết lượt -> dead', async () => {
    const e = new Prisma.PrismaClientKnownRequestError('pool SECRET-PARAM', { code: 'P2024', clientVersion: 't', meta: { modelName: 'Event' } });
    const t = build({ txError: e });
    const ch = buildChannel();
    await t.consumer.handleMessage(msg(), ch);
    expect(ch.sendToQueue).toHaveBeenCalled();
    expect(t.only('normalize.done')[0].obj).toMatchObject({ outcome: 'retry', cause: 'fail.hub_db', blame: 'ha_tang', err: { code: 'P2024', msg: 'P2024 Event' } });
    expect(JSON.stringify(t.lines)).not.toContain('SECRET-PARAM');
    const t2 = build({ txError: e });
    await t2.consumer.handleMessage(msg({ 'x-normalize-retry': 5 }), buildChannel());
    expect(t2.only('normalize.done')[0].obj).toMatchObject({ outcome: 'dead', cause: 'fail.hub_db' });
  });

  it('message hỏng (JSON) -> fail.poison_message; đã normalize trước đó -> skipped (không cause)', async () => {
    const t = build();
    const ch = buildChannel();
    await t.consumer.handleMessage({ content: Buffer.from('{không phải json'), properties: { headers: { 'x-correlation-id': 'corr-1' } } } as any, ch);
    expect(ch.nack).toHaveBeenCalled();
    expect(t.only('normalize.done')[0].obj).toMatchObject({ outcome: 'dead', cause: 'fail.poison_message', blame: 'hub' });
    const t2 = build({ processed: true });
    await t2.consumer.handleMessage(msg(), buildChannel());
    expect(t2.only('normalize.done')[0].obj).toMatchObject({ outcome: 'skipped' });
    expect(t2.only('normalize.done')[0].obj.cause).toBeUndefined();
  });
});

describe('DeliveryConsumer — delivery.attempt (LOGGING.md §3, §10)', () => {
  afterEach(() => jest.restoreAllMocks());

  function buildFakePrisma(opts: { row?: any; infraError?: Error } = {}) {
    const row = opts.row === undefined ? buildDeliveryRow() : opts.row;
    const tx = {
      deliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
      delivery: { findFirst: jest.fn().mockResolvedValue({ id: DELIVERY_ID, tenantId: TENANT_ID }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processedMessage: { create: jest.fn().mockResolvedValue({}) },
    };
    const repo = {
      findDeliveryForSend: jest.fn(async () => { if (opts.infraError) throw opts.infraError; return row; }),
      claimForSend: jest.fn().mockResolvedValue(1),
      updateDeliveryStatus: jest.fn().mockResolvedValue({}),
      deferDelivery: jest.fn().mockResolvedValue(1),
      getDeliveryLeaseState: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', attemptGeneration: 1, attemptCount: 1 }),
    };
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue(repo),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    return { prisma, repo };
  }

  function setup(send: jest.Mock, opts: { circuit?: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; cb?: any; thresholds?: Partial<typeof DEFAULT_SLOW_THRESHOLDS>; row?: any; infraError?: Error } = {}) {
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send } as any);
    const { prisma, repo } = buildFakePrisma(opts);
    const consumer = new DeliveryConsumer(prisma, opts.cb ?? buildFakeCircuitBreaker(opts.circuit ?? 'CLOSED'));
    const cap = capture(opts.thresholds);
    consumer.canonical = cap.canonical;
    return { consumer, repo, ...cap, channel: buildChannel() };
  }
  const amqp = (body: unknown, headers: Record<string, unknown> = {}, timestamp?: number) =>
    ({ content: Buffer.from(JSON.stringify(body)), properties: { headers: { 'x-correlation-id': 'corr-1', traceparent: TP, ...headers }, ...(timestamp ? { timestamp } : {}) } }) as any;
  const ok = (ms = 12) => jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: ms });
  const fail = (r: { status: number; error?: string }) => jest.fn().mockResolvedValue({ status: r.status, error: r.error, body: 'đích trả body bí mật MINEBODY', durationMs: 40 });

  it('thành công: outcome ok (info), đủ attempt/destination_id/event_name/http_status/chặng; sender nhận traceparent CÙNG trace_id (span = span của dòng)', async () => {
    const send = ok(12);
    const t = setup(send);
    await t.consumer.handleMessage(amqp(buildSlimMsg()), t.channel);
    expect(t.channel.ack).toHaveBeenCalledTimes(1);
    const [{ level, obj }] = t.only('delivery.attempt');
    expect(level).toBe('info');
    expect(obj).toMatchObject({ svc: 'hub-worker', outcome: 'ok', trace_id: TRACE, attempt: 1, destination_id: 'dest-1', delivery_id: DELIVERY_ID, tenant_id: TENANT_ID, event_name: 'payment.received', http_status: 200 });
    expect(obj.cause).toBeUndefined();
    expect(obj.stage_ms.dest_http).toBe(12);
    for (const k of ['deliver_prep', 'db_persist']) expect(typeof obj.stage_ms[k]).toBe('number');
    expect(obj.span_id).not.toBe(SPAN0);
    const ctx = send.mock.calls[0][4];
    expect(parseTraceparent(ctx.traceparent)).toMatchObject({ traceId: TRACE, spanId: obj.span_id });
  });

  it.each([
    ['đích 500', { status: 500, error: 'Request failed with status code 500' }, 'fail.dest_5xx', 'HTTP_5xx'],
    ['timeout', { status: 500, error: 'timeout tổng 5000ms (AbortSignal)' }, 'fail.dest_timeout', 'TIMEOUT'],
    ['ECONNREFUSED', { status: 500, error: 'connect ECONNREFUSED 10.0.0.1:443' }, 'fail.dest_network', 'ECONNREFUSED'],
    ['429', { status: 429, error: 'Request failed with status code 429' }, 'fail.dest_overload', 'HTTP_429'],
  ])('lần thất bại còn retry (%s): ghi status/err/durationMs/attempt/destination_id (lỗ hổng #2) và cause %s', async (_n, res, cause, code) => {
    const t = setup(fail(res));
    await t.consumer.handleMessage(amqp(buildSlimMsg()), t.channel);
    const [{ level, obj }] = t.only('delivery.attempt');
    expect(level).toBe('warn');
    expect(obj).toMatchObject({ outcome: 'retry', cause, attempt: 1, destination_id: 'dest-1', http_status: res.status, trace_id: TRACE, err: { code } });
    expect(obj.stage_ms.dest_http).toBe(40);
    expect(obj.next_queue).toMatch(/^q\.delivery\.retry\./);
    expect(JSON.stringify(t.lines)).not.toContain('MINEBODY'); // body phản hồi của đích không vào log
  });

  it('4xx cấu hình (400) -> dead ngay, wrong.config_dest_4xx; lần thứ 6 thất bại -> dead, fail.exhausted kèm last_cause', async () => {
    const t = setup(fail({ status: 400, error: 'Request failed with status code 400' }));
    await t.consumer.handleMessage(amqp(buildSlimMsg()), t.channel);
    expect(t.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'dead', cause: 'wrong.config_dest_4xx', blame: 'khach', http_status: 400 });
    const t2 = setup(fail({ status: 503 }));
    await t2.consumer.handleMessage(amqp(buildSlimMsg({ attemptCount: 5 })), t2.channel);
    expect(t2.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'dead', cause: 'fail.exhausted', attempt: 6, last_cause: 'fail.dest_5xx' });
  });

  it('queue_wait: timestamp AMQP cũ 9s -> slow.queue_wait dù đích nhanh; retry tầng 1m (x-due-at vừa hết hạn) KHÔNG tính chờ cố ý', async () => {
    const t = setup(ok(10));
    await t.consumer.handleMessage(amqp(buildSlimMsg(), { 'x-outbox-age-ms': 100 }, Date.now() - 9_000), t.channel);
    expect(t.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'ok', cause: 'slow.queue_wait', blame: 'hub' });
    expect(t.only('delivery.attempt')[0].obj.stage_ms.queue_wait).toBeGreaterThanOrEqual(8_900);

    const t2 = setup(ok(10));
    await t2.consumer.handleMessage(amqp(buildSlimMsg({ attemptCount: 1 }), { 'x-due-at': Date.now() - 120 }, Date.now() - 60_000), t2.channel);
    const o = t2.only('delivery.attempt')[0].obj;
    expect(o.cause).toBeUndefined();
    expect(o.stage_ms.queue_wait).toBeLessThan(2_000);
  });

  it('metric nối với log (§7): hub_deliveries_total có nhãn cause; hub_log_events_total, hub_slow_total, hub_queue_wait_seconds đếm đủ', async () => {
    const { workerRegistry } = require('../src/metrics');
    const sum = async (name: string, pred: (l: Record<string, string>, metricName: string) => boolean) => {
      const m = await workerRegistry.getSingleMetric(name).get();
      return m.values.filter((v: any) => pred(v.labels, v.metricName)).reduce((a: number, v: any) => a + v.value, 0);
    };
    const t = setup(fail({ status: 503, error: 'x' }));
    const b0 = await sum('hub_deliveries_total', (l) => l.status === 'RETRYING' && l.cause === 'fail.dest_5xx');
    const l0 = await sum('hub_log_events_total', (l) => l.msg === 'delivery.attempt' && l.cause === 'fail.dest_5xx');
    await t.consumer.handleMessage(amqp(buildSlimMsg()), t.channel);
    expect((await sum('hub_deliveries_total', (l) => l.status === 'RETRYING' && l.cause === 'fail.dest_5xx')) - b0).toBe(1);
    expect((await sum('hub_log_events_total', (l) => l.msg === 'delivery.attempt' && l.cause === 'fail.dest_5xx')) - l0).toBe(1);
    const s0 = await sum('hub_slow_total', (l) => l.cause === 'slow.queue_wait');
    const q0 = await sum('hub_queue_wait_seconds', (l, n) => l.queue === 'q.delivery.main' && n === 'hub_queue_wait_seconds_count');
    const t2 = setup(ok(5));
    await t2.consumer.handleMessage(amqp(buildSlimMsg(), {}, Date.now() - 9_000), t2.channel);
    expect((await sum('hub_slow_total', (l) => l.cause === 'slow.queue_wait')) - s0).toBe(1);
    expect((await sum('hub_queue_wait_seconds', (l, n) => l.queue === 'q.delivery.main' && n === 'hub_queue_wait_seconds_count')) - q0).toBe(1);
  });

  it('replay = trace MỚI có link: header x-replay-of -> dòng có replay_of trỏ trace gốc, trace_id là trace mới', async () => {
    const NEW_TRACE = 'b'.repeat(32);
    const t = setup(ok());
    await t.consumer.handleMessage(amqp(buildSlimMsg({ attemptGeneration: 2 }), { traceparent: formatTraceparent(NEW_TRACE, SPAN0), 'x-replay-of': TRACE }), t.channel);
    expect(t.only('delivery.attempt')[0].obj).toMatchObject({ trace_id: NEW_TRACE, replay_of: TRACE, outcome: 'ok' });
  });

  it('đích chậm (dest_http > SLOW_DELIVERY_MS) -> slow.destination (warn) dù thành công', async () => {
    const t = setup(ok(4_000));
    await t.consumer.handleMessage(amqp(buildSlimMsg()), t.channel);
    expect(t.only('delivery.attempt')[0]).toMatchObject({ level: 'warn', obj: { outcome: 'ok', cause: 'slow.destination', blame: 'dich' } });
  });

  it('retry giữ trace: bản republish mang traceparent CÙNG trace_id, x-due-at ≈ now + TTL tầng, bỏ x-outbox-age-ms; body vẫn 7 khoá', async () => {
    const t = setup(fail({ status: 502 }));
    const before = Date.now();
    await t.consumer.handleMessage(amqp(buildSlimMsg(), { 'x-outbox-age-ms': 77 }), t.channel);
    const [queue, buf, opts] = t.channel.sendToQueue.mock.calls[0];
    expect(queue).toMatch(/^q\.delivery\.retry\./);
    expect(parseTraceparent(opts.headers.traceparent)).toMatchObject({ traceId: TRACE });
    expect(opts.headers['x-due-at']).toBeGreaterThan(before);
    expect(opts.headers['x-outbox-age-ms']).toBeUndefined();
    expect(Object.keys(JSON.parse(buf.toString())).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'destinationId', 'rateLimitRps', 'tenantId']);
  });

  it('circuit OPEN (gate trước khi nạp DB) -> deferred, slow.deferred_circuit, defer_ms có giá trị, vẫn mang trace', async () => {
    const cb = buildFakeCircuitBreaker('OPEN');
    cb.getState = jest.fn().mockResolvedValue({ state: 'OPEN', failures: 5, openPttlMs: 50_000 });
    const t = setup(ok(), { cb });
    await t.consumer.handleMessage(amqp(buildSlimMsg({ destinationId: 'dest-1', rateLimitRps: 0 })), t.channel);
    const [{ obj }] = t.only('delivery.attempt');
    expect(obj).toMatchObject({ outcome: 'deferred', cause: 'slow.deferred_circuit', blame: 'dich', destination_id: 'dest-1', trace_id: TRACE });
    expect(obj.defer_ms).toBeGreaterThan(0);
    expect(parseTraceparent(t.channel.sendToQueue.mock.calls[0][2].headers.traceparent)!.traceId).toBe(TRACE);
  });

  it('throttle / ramp -> deferred slow.deferred_throttle; backpressure spill -> slow.deferred_backpressure; đều có defer_ms', async () => {
    const cb = buildFakeCircuitBreaker('CLOSED');
    cb.getState = jest.fn().mockResolvedValue({ state: 'CLOSED', failures: 0, throttleAllowed: false });
    const t = setup(ok(), { cb });
    await t.consumer.handleMessage(amqp(buildSlimMsg({ destinationId: 'dest-1', rateLimitRps: 5 })), t.channel);
    expect(t.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'deferred', cause: 'slow.deferred_throttle', blame: 'khach' });
    expect(t.only('delivery.attempt')[0].obj.defer_ms).toBeGreaterThan(0);

    const t2 = setup(ok());
    t2.consumer.spill(amqp(buildSlimMsg()), t2.channel);
    expect(t2.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'deferred', cause: 'slow.deferred_backpressure', blame: 'hub', trace_id: TRACE });
    expect(t2.only('delivery.attempt')[0].obj.defer_ms).toBeGreaterThan(0);
  });

  it('lỗi hạ tầng hub (P2024 khi nạp delivery) -> deferred fail.hub_db (error, err.code); lỗi lạ -> fail.hub_unknown; lần thứ 5 -> dead', async () => {
    const e = new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: 't' });
    const t = setup(ok(), { infraError: e });
    await t.consumer.handleMessage(amqp(buildSlimMsg()), t.channel);
    expect(t.only('delivery.attempt')[0]).toMatchObject({ level: 'error', obj: { outcome: 'deferred', cause: 'fail.hub_db', blame: 'ha_tang', err: { code: 'P2024' } } });
    const t2 = setup(ok(), { infraError: new TypeError('lạ') });
    await t2.consumer.handleMessage(amqp(buildSlimMsg()), t2.channel);
    expect(t2.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'deferred', cause: 'fail.hub_unknown' });
    const t3 = setup(ok(), { infraError: new TypeError('lạ') });
    await t3.consumer.handleMessage(amqp(buildSlimMsg(), { 'x-unknown-errors': 4 }), t3.channel);
    expect(t3.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'dead', cause: 'fail.hub_unknown' });
  });

  it('message hỏng -> dead, fail.poison_message (bản sao DLQ như cũ); delivery không tồn tại / đích lưu trữ -> skipped', async () => {
    const t = setup(ok());
    await t.consumer.handleMessage({ content: Buffer.from('rác'), properties: { headers: { 'x-correlation-id': 'corr-1' } } } as any, t.channel);
    expect(t.channel.publish).toHaveBeenCalled();
    expect(t.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'dead', cause: 'fail.poison_message', blame: 'hub' });
    const t2 = setup(ok(), { row: null });
    await t2.consumer.handleMessage(amqp(buildSlimMsg()), t2.channel);
    expect(t2.only('delivery.attempt')[0].obj).toMatchObject({ outcome: 'skipped' });
  });

  it('bãi mìn: sender trả lỗi chứa secret/URL có token/số tài khoản -> dòng log không lộ (err.msg đã scrub, chỉ host)', async () => {
    const t = setup(fail({ status: 500, error: 'connect ECONNREFUSED https://hooks.example.com/path/whsec_MINEMINEMINE123456?token=MINETOKEN9999 acct 9704123456789012 Bearer MINEBEARER12345678 via https://alice:MINEPA55W0RD@dest.example.com/hook?token=abc' }));
    await t.consumer.handleMessage(amqp(buildSlimMsg()), t.channel);
    const out = JSON.stringify(t.lines);
    for (const m of ['whsec_MINE', 'MINETOKEN', '9704123456789012', 'MINEBEARER', '/path/', 'MINEPA55W0RD', 'alice']) expect(out).not.toContain(m);
    expect(out).toContain('hooks.example.com');
  });
});

describe('WebhookSender — traceparent ra đích (LOGGING.md §4)', () => {
  it('thêm header traceparent (W3C, vô hại) vào request, KHÔNG nằm trong chuỗi ký; không có ngữ cảnh -> không thêm', async () => {
    (createSsrfSafeAxiosConfig as jest.Mock).mockResolvedValue({ url: 'https://x.example.com/h', httpAgent: {}, httpsAgent: {} });
    (postLimited as jest.Mock).mockResolvedValue({ status: 200, body: '', truncated: false });
    const evt: any = { id: 'evt-1', type: 'payment.received', source: 'payos', sourceId: 's', tenantId: 't', data: {}, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), correlationId: 'c', origin: 'webhook' };
    const sender = new WebhookSender();
    await sender.send({ url: 'https://x.example.com/h' }, 'r', evt, WHSEC, { traceparent: TP });
    const withTp = (postLimited as jest.Mock).mock.calls[0][2].headers;
    expect(withTp.traceparent).toBe(TP);
    expect(withTp['webhook-signature']).toMatch(/^v1,/);
    // chữ ký không phụ thuộc traceparent: gửi lại không ngữ cảnh với cùng timestamp -> chỉ khác header, không khác cách ký
    await sender.send({ url: 'https://x.example.com/h' }, 'r', evt, WHSEC);
    const without = (postLimited as jest.Mock).mock.calls[1][2].headers;
    expect(without.traceparent).toBeUndefined();
    expect(without['webhook-id']).toBe(withTp['webhook-id']);
  });
});
