import { CanonicalLogger, buildCanonical } from '../src/log-line';
import { GrowthWindow, emitGrowth, resolveGrowth, startGrowthTicker } from '../src/growth-window';
import { startEventLoopMonitor } from '../src/event-loop';

const TRACE = '3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7';
const ingest = (sourceId: string, outcome: 'accepted' | 'duplicate' = 'accepted') =>
  buildCanonical({ svc: 'hub-api', msg: 'ingest.done', outcome, traceId: TRACE, sourceId, tenantId: 't1', provider: 'payos', totalMs: 5 });
const delivery = (destinationId: string, outcome: 'ok' | 'retry' | 'dead', extra: Record<string, any> = {}, stage: Record<string, number> = {}) =>
  buildCanonical({ svc: 'hub-worker', msg: 'delivery.attempt', outcome, traceId: TRACE, destinationId, tenantId: 't1', totalMs: 5, stageMs: stage, ...extra });

describe('growth.window — tổng hợp theo cửa sổ 60s trong bộ nhớ (LOGGING.md §2.3, §9d)', () => {
  const S = { ...resolveGrowth({}), minCount: 100 };

  it('burst_source: vượt factor × đường nền; cửa sổ đầu chưa có nền thì cần vượt minCount × factor; có tỉ lệ trùng + hint', () => {
    const gw = new GrowthWindow(S);
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 180; i++) gw.observe(ingest('src_41ad'));
      expect(gw.flush().filter((g) => g.cause === 'growth.burst_source')).toHaveLength(0); // 180 < 5×100 và nền ≈180
    }
    for (let i = 0; i < 4600; i++) gw.observe(ingest('src_41ad', 'accepted'));
    for (let i = 0; i < 520; i++) gw.observe(ingest('src_41ad', 'duplicate'));
    const g = gw.flush().find((x) => x.cause === 'growth.burst_source')!;
    expect(g).toMatchObject({ sourceId: 'src_41ad', tenantId: 't1', provider: 'payos', windowS: 60, count: 5120 });
    expect(g.baselinePerMin).toBeGreaterThan(100);
    expect(g.factor).toBeGreaterThan(5);
  });

  it('dup_flood: tỉ lệ trùng >= ngưỡng với đủ lưu lượng; source ít lưu lượng không báo', () => {
    const gw = new GrowthWindow(S);
    for (let i = 0; i < 20; i++) gw.observe(ingest('src_small', 'duplicate'));
    for (let i = 0; i < 200; i++) gw.observe(ingest('src_dup', i % 10 === 0 ? 'accepted' : 'duplicate'));
    const sig = gw.flush();
    expect(sig.filter((s) => s.cause === 'growth.dup_flood').map((s) => s.sourceId)).toEqual(['src_dup']);
    expect(sig.find((s) => s.cause === 'growth.dup_flood')!.duplicateRatio).toBeCloseTo(0.9, 1);
  });

  it('retry_storm theo đích, dlq_swell kèm last_cause chiếm nhiều nhất; ok thuần không báo', () => {
    const gw = new GrowthWindow({ ...S, dlqMin: 5 });
    for (let i = 0; i < 150; i++) gw.observe(delivery('dst_bad', 'retry'));
    for (let i = 0; i < 300; i++) gw.observe(delivery('dst_good', 'ok'));
    for (let i = 0; i < 6; i++) gw.observe(delivery('dst_bad', 'dead', { cause: 'fail.exhausted', extra: { last_cause: 'fail.dest_5xx' } }));
    const sig = gw.flush();
    expect(sig.filter((s) => s.cause === 'growth.retry_storm').map((s) => s.destinationId)).toEqual(['dst_bad']);
    expect(sig.find((s) => s.cause === 'growth.dlq_swell')).toMatchObject({ count: 6, lastCause: 'fail.dest_5xx' });
  });

  it('backlog: chờ hàng đợi vượt ngưỡng chậm ở N cửa sổ LIÊN TIẾP; một cửa sổ lành làm gián đoạn', () => {
    const gw = new GrowthWindow({ ...S, backlogWindows: 3 }, 5000);
    const slow = () => gw.observe(delivery('d', 'ok', {}, { queue_wait: 9000 }));
    slow(); expect(gw.flush().some((s) => s.cause === 'growth.backlog')).toBe(false);
    slow(); expect(gw.flush().some((s) => s.cause === 'growth.backlog')).toBe(false);
    gw.observe(delivery('d', 'ok', {}, { queue_wait: 5 })); expect(gw.flush().some((s) => s.cause === 'growth.backlog')).toBe(false);
    slow(); gw.flush(); slow(); gw.flush(); slow();
    expect(gw.flush().some((s) => s.cause === 'growth.backlog')).toBe(true);
  });

  it('bộ nhớ có trần: số khoá không vượt maxKeys; flush xoá bộ đếm', () => {
    const gw = new GrowthWindow({ ...S, maxKeys: 50, minCount: 1 });
    for (let i = 0; i < 500; i++) gw.observe(ingest(`src_${i}`));
    expect((gw as any).bySource.size).toBe(50);
    gw.flush();
    expect((gw as any).bySource.size).toBe(0);
  });

  it('emitGrowth ghi dòng growth.window (warn) đúng khuôn §9(d); ticker gọi flush theo cửa sổ và dừng được', () => {
    const lines: any[] = [];
    const log: any = { info: (o: any, m: string) => lines.push({ level: 'info', o, m }), warn: (o: any, m: string) => lines.push({ level: 'warn', o, m }), error: () => undefined };
    const canonical = new CanonicalLogger({ log, successSample: 1, dedupeWindowMs: 1000 });
    emitGrowth(canonical, { cause: 'growth.burst_source', svc: 'hub-api', tenantId: 't1', sourceId: 'src_41ad', provider: 'payos', windowS: 60, count: 5120, baselinePerMin: 180, factor: 28.4, duplicateRatio: 0.91, hint: 'wrong.duplicate chiếm 91%: provider đang bắn lặp' });
    expect(lines[0]).toMatchObject({ level: 'warn', m: 'growth.window', o: { svc: 'hub-api', cause: 'growth.burst_source', blame: 'provider', source_id: 'src_41ad', window_s: 60, count: 5120, baseline_per_min: 180, factor: 28.4, duplicate_ratio: 0.91 } });

    jest.useFakeTimers();
    const gw = new GrowthWindow({ ...S, windowMs: 1000, minCount: 1 });
    const seen: string[] = [];
    const stop = startGrowthTicker(gw, canonical, (g) => seen.push(g.cause));
    for (let i = 0; i < 10; i++) gw.observe(ingest('src_x', 'duplicate'));
    jest.advanceTimersByTime(1000);
    expect(seen).toContain('growth.dup_flood');
    stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('event loop monitor: gọi onTick với p99 (ms) mỗi nhịp và dừng sạch', async () => {
    const seen: number[] = [];
    const stop = startEventLoopMonitor((ms) => seen.push(ms), 30, 5);
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
});
