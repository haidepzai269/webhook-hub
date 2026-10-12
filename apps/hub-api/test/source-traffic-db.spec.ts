import { randomUUID } from 'crypto';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { TrafficRecorder } from '../src/modules/ingest/traffic-recorder';

/**
 * EG4 (SPEC-chong-qua-tai §5, ADR-179) trên Postgres THẬT: ghi bằng `hub_app` (RLS, forTenant), fixture bằng owner.
 */
describeDb('EG4 lưu lượng theo source (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const [A, B] = [randomUUID(), randomUUID()];
  const projects = [A, B];
  let seq = 0;

  beforeAll(async () => {
    for (const id of projects) await owner.project.create({ data: { id, slug: `eg4-${run}-${id.slice(0, 6)}`, name: `eg4 ${run}` } });
  }, 60_000);

  afterAll(async () => {
    await owner.source.deleteMany({ where: { tenantId: { in: projects } } }); // cascade source_traffic_minutely
    await owner.project.deleteMany({ where: { id: { in: projects } } });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  const source = (tenantId: string) =>
    owner.source.create({ data: { tenantId, provider: 'github', name: `eg4-${run}-${++seq}`, sourceKey: `eg4-${run}-${++seq}` } });
  const sink = (t: string, rows: any[]) => svc.forTenant(t).addSourceTraffic(rows);

  it('[EG:T13] hai instance cùng upsert một (tenant, source, minute, outcome) -> count là TỔNG, top_ips gộp còn 5; DB lỗi -> bộ đệm giữ có trần 10 phút, ingest không chậm', async () => {
    const src = await source(A);
    const now = Date.UTC(2026, 9, 12, 8, 30, 15);
    const clock = () => now;
    const i1 = new TrafficRecorder(sink, { flushMs: 0, clock });
    const i2 = new TrafficRecorder(sink, { flushMs: 0, clock });
    for (let i = 0; i < 7; i++) i1.record(A, src.id, 'REJECTED', '203.0.113.7');
    for (let i = 0; i < 3; i++) i1.record(A, src.id, 'REJECTED', `198.51.100.${i}`);
    for (let i = 0; i < 4; i++) i2.record(A, src.id, 'REJECTED', '203.0.113.7');
    for (let i = 0; i < 5; i++) i2.record(A, src.id, 'REJECTED', `192.0.2.${i}`);
    i2.record(A, src.id, 'ACCEPTED', '140.82.115.1');
    // hai instance ghi đồng thời
    await Promise.all([i1.flush(), i2.flush()]);
    expect(i1.pendingCount() + i2.pendingCount()).toBe(0);

    const rows = await owner.sourceTrafficMinutely.findMany({ where: { tenantId: A, sourceId: src.id }, orderBy: { outcome: 'asc' } });
    expect(rows.map((r) => [r.outcome, r.count, r.minute.toISOString()])).toEqual([
      ['ACCEPTED', 1, '2026-10-12T08:30:00.000Z'],
      ['REJECTED', 19, '2026-10-12T08:30:00.000Z'],
    ]);
    const top = rows[1].topIps as { ip: string; count: number }[];
    expect(top).toHaveLength(5);
    expect(top[0]).toEqual({ ip: '203.0.113.7', count: 11 });

    // BB-5: project B không ghi được lưu lượng cho source của A (FK ghép + RLS) — recorder bỏ dòng hỏng, không kẹt
    const wrong = new TrafficRecorder(sink, { flushMs: 0, clock });
    wrong.record(B, src.id, 'ACCEPTED');
    await wrong.flush();
    expect(wrong.pendingCount()).toBe(0);
    expect(await owner.sourceTrafficMinutely.count({ where: { tenantId: B } })).toBe(0);

    // DB lỗi: record() không I/O (không chậm đi), bộ đệm giữ lại; quá 10 phút thì bỏ phần cũ + đếm dropped
    let t = now;
    let dropped = 0;
    const down = new TrafficRecorder(async () => Promise.reject(new Error('ECONNREFUSED')), { flushMs: 0, clock: () => t, onDropped: (n) => (dropped += n) });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) down.record(A, src.id, 'ACCEPTED', `10.0.${i >> 8}.${i & 255}`);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(500);
    await down.flush();
    expect(down.pendingCount()).toBe(10_000); // giữ lại cho lượt sau
    t += 5 * 60_000;
    down.record(A, src.id, 'ACCEPTED');
    await down.flush();
    expect(down.pendingCount()).toBe(10_001);
    t += 6 * 60_000; // ô đầu đã quá 10 phút
    await down.flush();
    expect(dropped).toBe(10_000);
    expect(down.pendingCount()).toBe(1);
  });
});
