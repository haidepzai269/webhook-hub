import { randomUUID } from 'crypto';
import { computeUsedBytes } from '@hub/common';
import { PrismaService } from '../src/prisma.service';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * QT2 (SPEC-han-muc-dung-luong ĐÍNH CHÍNH E2, ADR-183) trên Postgres thật (role hub_app): cột `bytes` của bảng traffic cộng
 * dồn đúng khi nhiều instance cùng ghi; hiệu chỉnh quét thật + truy vấn gộp của job cập nhật nấc.
 */
describeDb('QT2: đo cộng dồn + hiệu chỉnh (Postgres)', () => {
  const owner = newTestPrisma('owner');
  const svc1 = new PrismaService();
  const svc2 = new PrismaService();
  const A = randomUUID();
  const run = randomUUID().slice(0, 8);
  let sourceId = '';

  beforeAll(async () => {
    await owner.project.create({ data: { id: A, slug: `qt2-${run}`, name: 'qt2' } });
    const s = await owner.source.create({ data: { tenantId: A, provider: 'github', name: 'qt2', sourceKey: `qt2_${run}` } });
    sourceId = s.id;
    await owner.rawEvent.create({
      data: { sourceId, idempotencyKey: `qt2:${run}`, headers: {}, body: {}, bodyRaw: Buffer.alloc(100_000, 120), contentType: 'application/json', signatureValid: true, status: 'ACCEPTED' },
    });
    await owner.event.create({ data: { id: `QT2${run}`, tenantId: A, sourceId, idempotencyKey: `qt2e:${run}`, correlationId: randomUUID(), type: 't.qt2', source: 'github', data: { blob: 'y'.repeat(20_000) } } });
  }, 60_000);

  afterAll(async () => {
    await owner.event.deleteMany({ where: { tenantId: A } });
    await owner.project.deleteMany({ where: { id: A } }); // CASCADE sources, raw_events, traffic, project_usage
    await owner.$disconnect();
    await svc1.$disconnect();
    await svc2.$disconnect();
  });

  it('[QT:T31] (phần b) hai instance cùng upsert một ô (tenant, source, minute, outcome) -> bytes là TỔNG', async () => {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000);
    const row = (bytes: number) => ({ sourceId, minute, outcome: 'ACCEPTED' as const, count: 1, bytes, topIps: [] });
    await Promise.all([svc1.forTenant(A).addSourceTraffic([row(300)]), svc2.forTenant(A).addSourceTraffic([row(700)])]);
    const [r] = await owner.$queryRaw<{ count: number; bytes: bigint }[]>`
      SELECT count, bytes FROM hub.source_traffic_minutely WHERE tenant_id = ${A}::uuid AND minute = ${minute}`;
    expect({ count: r.count, bytes: Number(r.bytes) }).toEqual({ count: 2, bytes: 1000 });
  });

  it('[QT:T32] (phần d) hiệu chỉnh đặt lại mốc (freed = 0, used = số quét); truy vấn gộp chỉ cộng traffic SAU phút mốc; công thức ra đúng used', async () => {
    const repo = svc1.forTenant(A);
    const m = await repo.measureStorage();
    expect(m.bodyRawBytes).toBe(100_000);
    expect(m.totalBytes).toBeGreaterThan(100_000); // + events.data (+ audit nếu có)
    expect(m.bySource[sourceId]).toBeGreaterThan(100_000);
    await owner.$executeRaw`UPDATE hub.project_usage SET freed_since_calibration = 999 WHERE tenant_id = ${A}::uuid`;
    await repo.saveStorageCalibration({ calibratedBytes: m.totalBytes, bloatFactor: 2, bySource: m.bySource, level: 'OK' });
    const u = await repo.findProjectUsage();
    expect(Number(u!.usedBytes)).toBe(m.totalBytes);
    expect(Number(u!.freedSinceCalibration)).toBe(0);
    expect(u!.calibratedAt).toBeInstanceOf(Date);

    // traffic ở phút chứa mốc: thuộc về lần quét (không cộng); phút sau mốc: cộng
    const calMinute = new Date(Math.floor(u!.calibratedAt!.getTime() / 60_000) * 60_000);
    const later = new Date(calMinute.getTime() + 120_000);
    await repo.addSourceTraffic([{ sourceId, minute: calMinute, outcome: 'ACCEPTED', count: 1, bytes: 5_000, topIps: [] }]);
    await repo.addSourceTraffic([{ sourceId, minute: later, outcome: 'ACCEPTED', count: 1, bytes: 400, topIps: [] }]);
    await owner.$executeRaw`UPDATE hub.project_usage SET freed_since_calibration = 100 WHERE tenant_id = ${A}::uuid`;
    const [row] = await svc1.storageLevelTickAcrossTenants([A]);
    expect(row.trafficBytesSinceCalibration).toBe(400);
    expect(computeUsedBytes(row)).toBe(m.totalBytes + 2 * 400 - 100);

    // mốc quá cũ (hoặc chưa có) -> nằm trong danh sách hiệu chỉnh
    expect(await svc1.storageProjectsDueForCalibrationAcrossTenants(new Date(Date.now() + 60_000), 10, [A])).toEqual([A]);
    expect(await svc1.storageProjectsDueForCalibrationAcrossTenants(new Date(Date.now() - 3_600_000), 10, [A])).toEqual([]);
  });

  it('[QT:T32] (phần g) ghi nấc compare-and-set theo mốc đã đọc (đủ µs): hiệu chỉnh xen giữa -> 0 dòng, số quét giữ nguyên; measureStorage chạy được trong tenantTx có statement_timeout (review L1+M2)', async () => {
    const repo = svc1.forTenant(A);
    const [before] = await svc1.storageLevelTickAcrossTenants([A]);
    expect(before.calibratedAtToken).toEqual(expect.any(String));
    // không ai xen giữa -> token đọc ra khớp lại đúng (text -> timestamptz không mất µs)
    expect(await repo.updateStorageUsage({ usedBytes: before.usedBytes, level: before.level, calibratedAtToken: before.calibratedAtToken })).toBe(1);
    // hiệu chỉnh ghi mốc mới giữa lúc job nấc đọc và ghi
    const m = await svc2.tenantTx(A, (tx) => svc2.forTenant(A, tx).measureStorage({ statementTimeoutMs: 30_000 }), { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 5)); // now() chắc chắn khác mốc cũ
    await svc2.forTenant(A).saveStorageCalibration({ calibratedBytes: m.totalBytes, bloatFactor: 2, bySource: m.bySource, level: 'OK' });
    expect(await repo.updateStorageUsage({ usedBytes: 1, level: 'HARD_LOCKED', calibratedAtToken: before.calibratedAtToken })).toBe(0);
    const u = await repo.findProjectUsage();
    expect({ used: Number(u!.usedBytes), level: u!.level }).toEqual({ used: m.totalBytes, level: 'OK' });
    // statement_timeout cục bộ chỉ sống trong transaction đó: phiên khác không bị ảnh hưởng
    await svc2.tenantTx(A, async (tx) => {
      await svc2.forTenant(A, tx).measureStorage({ statementTimeoutMs: 1234 });
      const [{ v }] = await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('statement_timeout') AS v`;
      expect(v).toBe('1234ms');
    });
  });
});
