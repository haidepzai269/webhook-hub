import { CanonicalLogger, buildCanonical, computeQueueWait, errInfo, setCanonicalObserver, CanonicalInput } from '../src/log-line';
import { DEFAULT_SLOW_THRESHOLDS, resolveLogSettings, resolveSlowThresholds, takeColdStart, resetColdStartForTest } from '../src/slow-thresholds';

const TRACE = '3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7';
const base = (o: Partial<CanonicalInput> = {}): CanonicalInput => ({ svc: 'hub-api', msg: 'ingest.done', outcome: 'accepted', traceId: TRACE, totalMs: 12, stageMs: { verify: 1, redis: 4, db_commit: 6 }, ...o });
const TH = DEFAULT_SLOW_THRESHOLDS;

function fake() {
  const lines: Array<{ level: string; obj: Record<string, any>; msg: string }> = [];
  const log: any = {};
  for (const l of ['debug', 'info', 'warn', 'error']) log[l] = (obj: any, msg: string) => lines.push({ level: l, obj, msg });
  return { log, lines };
}

describe('canonical log line — builder (LOGGING.md §3)', () => {
  it('dòng thành công bình thường: info, không cause/blame, đủ trường bắt buộc', () => {
    const b = buildCanonical(base({ sourceId: 'src_1', provider: 'github', httpStatus: 200 }), TH);
    expect(b.level).toBe('info');
    expect(b.record).toMatchObject({ svc: 'hub-api', trace_id: TRACE, outcome: 'accepted', total_ms: 12, http_status: 200, provider: 'github', source_id: 'src_1' });
    expect(b.record.cause).toBeUndefined();
    expect(b.record.blame).toBeUndefined();
    expect(b.record.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(b.record.stage_ms).toEqual({ verify: 1, redis: 4, db_commit: 6, other: 1 });
  });

  it('cause tường minh: kèm blame; lỗi hub = error, lỗi bên gửi = warn, duplicate = info', () => {
    expect(buildCanonical(base({ outcome: 'rejected', cause: 'wrong.signature' }), TH)).toMatchObject({ level: 'warn', record: { cause: 'wrong.signature', blame: 'provider' } });
    expect(buildCanonical(base({ outcome: 'unavailable', cause: 'fail.hub_db' }), TH)).toMatchObject({ level: 'error', record: { cause: 'fail.hub_db', blame: 'ha_tang' } });
    expect(buildCanonical(base({ outcome: 'duplicate', cause: 'wrong.duplicate' }), TH).level).toBe('info');
  });

  it('chậm do DB: db_commit chiếm >= 50% và total > SLOW_INGEST_MS -> slow.db (warn), vẫn outcome accepted', () => {
    const b = buildCanonical(base({ totalMs: 2043, stageMs: { verify: 1, redis: 4, db_commit: 1931 } }), TH);
    expect(b.record).toMatchObject({ cause: 'slow.db', blame: 'ha_tang' });
    expect(b.level).toBe('warn');
    expect(b.slowCause).toBe('slow.db');
  });

  it('ngưỡng lấy từ env: SLOW_INGEST_MS=5000 thì 2043ms không còn chậm', () => {
    const th = resolveSlowThresholds({ SLOW_INGEST_MS: '5000' });
    expect(buildCanonical(base({ totalMs: 2043, stageMs: { db_commit: 1931 } }), th).record.cause).toBeUndefined();
  });

  it('chậm do Redis; không chặng nào chiếm ưu thế -> slow.hub_cpu', () => {
    expect(buildCanonical(base({ totalMs: 900, stageMs: { redis: 800 } }), TH).record.cause).toBe('slow.redis');
    expect(buildCanonical(base({ totalMs: 900, stageMs: { redis: 100, db_commit: 100 } }), TH).record.cause).toBe('slow.hub_cpu');
  });

  it('lỗi thắng hoãn thắng chậm (phân xử §2.3); cold start thắng khi chậm ở request đầu', () => {
    expect(buildCanonical(base({ totalMs: 3000, stageMs: { db_commit: 2900 }, cause: 'wrong.signature', outcome: 'rejected' }), TH).record.cause).toBe('wrong.signature');
    expect(buildCanonical(base({ totalMs: 9000, stageMs: { db_commit: 8000 }, flags: { cold: true } }), TH).record.cause).toBe('slow.cold_start');
    expect(buildCanonical(base({ totalMs: 30, flags: { cold: true } }), TH).record.cause).toBeUndefined(); // nhanh thì không phải cold_start
  });

  it('delivery: queue_wait lớn -> slow.queue_wait dù đích nhanh (ví dụ (c) LOGGING.md §9)', () => {
    const b = buildCanonical(
      { svc: 'hub-worker', msg: 'delivery.attempt', outcome: 'ok', traceId: TRACE, totalMs: 14920, attempt: 1, stageMs: { outbox_lag: 310, queue_wait: 14380, deliver_prep: 22, dest_http: 181, db_persist: 27 } },
      TH,
    );
    expect(b.record).toMatchObject({ cause: 'slow.queue_wait', blame: 'hub', attempt: 1 });
  });

  it('delivery: dest_http > SLOW_DELIVERY_MS -> slow.destination', () => {
    const b = buildCanonical({ svc: 'hub-worker', msg: 'delivery.attempt', outcome: 'ok', traceId: TRACE, totalMs: 4000, stageMs: { dest_http: 3800, queue_wait: 5 } }, TH);
    expect(b.record.cause).toBe('slow.destination');
  });

  it('delivery thất bại còn retry: có status/err/destination_id/attempt/duration (lỗ hổng #2)', () => {
    const b = buildCanonical(
      { svc: 'hub-worker', msg: 'delivery.attempt', outcome: 'retry', traceId: TRACE, totalMs: 412, attempt: 2, destinationId: 'dst_93bc', deliveryId: 'd_77e0', httpStatus: 503, cause: 'fail.dest_5xx', stageMs: { queue_wait: 3, dest_http: 371 }, err: { class: 'HttpError', code: 'HTTP_5xx', msg: '503 Service Unavailable' }, extra: { next_queue: 'q.delivery.retry.1m' } },
      TH,
    );
    expect(b.record).toMatchObject({ cause: 'fail.dest_5xx', blame: 'dich', http_status: 503, destination_id: 'dst_93bc', attempt: 2, err: { class: 'HttpError', code: 'HTTP_5xx' }, next_queue: 'q.delivery.retry.1m' });
  });

  it('extra chỉ nhận khoá trong danh sách cho phép (không có đường nào để nhét body/secret vào dòng)', () => {
    const b = buildCanonical(base({ extra: { body_raw: 'SECRET-BODY', policy: 'penalty_ip', whsec: 'whsec_abc', next_queue: 'q.x'.repeat(100) } as any }), TH);
    expect(JSON.stringify(b.record)).not.toContain('SECRET-BODY');
    expect(JSON.stringify(b.record)).not.toContain('whsec_abc');
    expect(b.record.policy).toBe('penalty_ip');
    expect(String(b.record.next_queue).length).toBeLessThanOrEqual(120);
  });

  it('errInfo: {class, code, msg}; Prisma chỉ lấy code + model, KHÔNG message nguyên văn; msg qua scrub, cắt 200', () => {
    const prismaLike = Object.assign(new Error('Invalid `prisma.rawEvent.create()` invocation: Unique constraint failed on whsec_SECRETSECRET1234 acct 123456789012'), { name: 'PrismaClientKnownRequestError', code: 'P2024', meta: { modelName: 'RawEvent' } });
    const e = errInfo(prismaLike);
    expect(e).toEqual({ class: 'PrismaClientKnownRequestError', code: 'P2024', msg: 'P2024 RawEvent' });
    const net = Object.assign(new Error('connect ECONNRESET Bearer abcdefghijklmnop whsec_ABCDEFGH12345678 acct 123456789012 ' + 'x'.repeat(400)), { code: 'ECONNRESET' });
    const n = errInfo(net);
    expect(n.code).toBe('ECONNRESET');
    expect(n.msg.length).toBeLessThanOrEqual(200);
    expect(n.msg).not.toMatch(/whsec_ABCDEFGH|abcdefghijklmnop|123456789012/);
    expect(errInfo('plain string')).toMatchObject({ class: 'Error', msg: 'plain string' });
    expect(errInfo(null).code).toBe('UNKNOWN');
  });
});

describe('queue_wait (LOGGING.md §3.2)', () => {
  const N = 1_700_000_000_000;
  it('= now - max(published_ts, due_ts): chờ cố ý của tầng retry KHÔNG tính, chỉ phần quá hạn', () => {
    // retry tầng 1m: due = now - 120ms (TTL hết cách đây 120ms) -> chỉ 120ms là queue_wait dù published cách 60s
    expect(computeQueueWait({ nowMs: N, publishedTs: N - 60_000, dueTs: N - 120 })).toEqual({ ms: 120, clockSkew: false });
    expect(computeQueueWait({ nowMs: N, publishedTs: N - 14_380 })).toEqual({ ms: 14_380, clockSkew: false });
    expect(computeQueueWait({ nowMs: N })).toEqual({ ms: 0, clockSkew: false });
  });
  it('clamp >= 0; âm > 1s ghi cờ clock_skew; timestamp tính bằng giây được nhận ra', () => {
    expect(computeQueueWait({ nowMs: N, publishedTs: N + 500 })).toEqual({ ms: 0, clockSkew: false });
    expect(computeQueueWait({ nowMs: N, publishedTs: N + 5_000 })).toEqual({ ms: 0, clockSkew: true });
    expect(computeQueueWait({ nowMs: 1_700_000_005_000, publishedTs: 1_700_000_000 })).toEqual({ ms: 5000, clockSkew: false });
  });
});

describe('CanonicalLogger — lấy mẫu, gộp dòng lặp, metric (LOGGING.md §6)', () => {
  afterEach(() => setCanonicalObserver(null));

  it('thành công 1000 lần: ghi ≈ LOG_SUCCESS_SAMPLE nhưng observer (hub_log_events_total) đếm ĐỦ 1000; lỗi ghi 100%', () => {
    const { log, lines } = fake();
    const seen: string[] = [];
    setCanonicalObserver((b) => seen.push(`${b.record.msg}|${b.record.cause ?? ''}`));
    let i = 0;
    const lg = new CanonicalLogger({ log, successSample: 0.1, dedupeWindowMs: 30_000, random: () => (i++ % 10) / 10 + 0.001 });
    for (let k = 0; k < 1000; k++) lg.emit(base());
    expect(seen.length).toBe(1000);
    expect(lines.length).toBe(100);
    expect(lines[0].obj.sampled).toEqual({ rate: 0.1 });
    for (let k = 0; k < 50; k++) lg.emit(base({ outcome: 'unavailable', cause: 'fail.hub_db', sourceId: `s${k}` }));
    expect(lines.length).toBe(150); // lỗi hub: luôn ghi, không bị gộp
  });

  it('mẫu 1 (local) ghi hết, không gắn "sampled"', () => {
    const { log, lines } = fake();
    const lg = new CanonicalLogger({ log, successSample: 1, dedupeWindowMs: 30_000 });
    lg.emit(base());
    expect(lines).toHaveLength(1);
    expect(lines[0].obj.sampled).toBeUndefined();
  });

  it('bão lặp (wrong.*): ≤ 1 dòng / cửa sổ / (cause, source), dòng kế mang suppressed:n; LRU ≤ 1000 khoá', () => {
    const { log, lines } = fake();
    let now = 0;
    const lg = new CanonicalLogger({ log, successSample: 1, dedupeWindowMs: 30_000, now: () => now });
    for (let k = 0; k < 5; k++) lg.emit(base({ outcome: 'rejected', cause: 'wrong.policy_blocked', extra: { policy: 'penalty_pair' }, sourceId: 'src_1' }));
    expect(lines).toHaveLength(1);
    now = 31_000;
    lg.emit(base({ outcome: 'rejected', cause: 'wrong.policy_blocked', extra: { policy: 'penalty_pair' }, sourceId: 'src_1' }));
    expect(lines).toHaveLength(2);
    expect(lines[1].obj.sampled).toEqual({ suppressed: 4 });
    // nguồn khác không bị gộp chung
    lg.emit(base({ outcome: 'rejected', cause: 'wrong.policy_blocked', extra: { policy: 'penalty_pair' }, sourceId: 'src_2' }));
    expect(lines).toHaveLength(3);
    for (let k = 0; k < 3000; k++) lg.emit(base({ outcome: 'rejected', cause: 'wrong.signature', sourceId: `x${k}` }));
    expect(lg.dedupeSize()).toBeLessThanOrEqual(1000);
  });

  it('observer lỗi hoặc logger lỗi không bao giờ ném ra ngoài', () => {
    setCanonicalObserver(() => {
      throw new Error('boom');
    });
    const lg = new CanonicalLogger({ log: { info: () => { throw new Error('pino'); } } as any, successSample: 1, dedupeWindowMs: 1 });
    expect(() => lg.emit(base())).not.toThrow();
  });
});

describe('env: ngưỡng + lấy mẫu + cold start (Admin chốt 2026-10-18)', () => {
  it('mặc định: ingest 500ms, delivery 3s, queue_wait 5s; mẫu local 100%, deployed 10%', () => {
    expect(resolveSlowThresholds({})).toMatchObject({ ingestMs: 500, deliveryMs: 3000, queueWaitMs: 5000, normalizeMs: 1000, relayLagMs: 3000, coldStartWindowS: 60, eventLoopLagP99Ms: 200 });
    expect(resolveLogSettings({}).successSample).toBe(1);
    expect(resolveLogSettings({ RENDER: 'true' }).successSample).toBe(0.1);
    expect(resolveLogSettings({ DEPLOY_ENV: 'deployed' }).successSample).toBe(0.1);
    expect(resolveLogSettings({ DEPLOY_ENV: 'deployed', LOG_SUCCESS_SAMPLE: '0.5' }).successSample).toBe(0.5);
    expect(resolveLogSettings({ LOG_SUCCESS_SAMPLE: 'abc' }).successSample).toBe(1);
    expect(resolveSlowThresholds({ SLOW_INGEST_MS: '-5' }).ingestMs).toBe(500);
  });
  it('takeColdStart: chỉ request đầu tiên và chỉ khi tiến trình trẻ hơn cửa sổ', () => {
    resetColdStartForTest();
    expect(takeColdStart(60, 5)).toBe(true);
    expect(takeColdStart(60, 5)).toBe(false);
    resetColdStartForTest();
    expect(takeColdStart(60, 600)).toBe(false);
    resetColdStartForTest();
  });
});
