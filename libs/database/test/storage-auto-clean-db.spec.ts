import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma.service';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * QT5 (SPEC-han-muc-dung-luong §5.4 + E2, ADR-184/186) trên Postgres THẬT: escape hatch đọc policy dọn tự động xuyên project,
 * retention trừ byte giải phóng vào project_usage trong CÙNG câu xoá, policy Cao/Giữ bị CHECK của DB chặn.
 */
describeDb('QT5: dọn tự động + retention có kế toán byte (Postgres)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const A = randomUUID();
  const run = randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  let sourceId = '';

  beforeAll(async () => {
    await owner.project.create({ data: { id: A, slug: `qt5-${run}`, name: 'qt5' } });
    sourceId = (await owner.source.create({ data: { tenantId: A, provider: 'github', name: 'qt5', sourceKey: `qt5_${run}` } })).id;
    await svc.forTenant(A).seedStorageDefaults('test');
  }, 60_000);

  afterAll(async () => {
    await owner.event.deleteMany({ where: { tenantId: A } });
    await owner.rawEvent.deleteMany({ where: { source: { tenantId: A } } });
    await owner.auditLog.deleteMany({ where: { tenantId: A } });
    await owner.source.deleteMany({ where: { tenantId: A } });
    await owner.project.deleteMany({ where: { id: A } });
    await owner.$disconnect();
    await svc.$disconnect();
  });

  it('[QT:T18] (phần c) escape hatch chỉ trả policy action <> off (mặc định Q10: Rác delete 1 ngày + Thấp trim 3 ngày); Cao/Giữ không ghi được vào bảng (CHECK)', async () => {
    const [t] = await svc.storageAutoCleanTargetsAcrossTenants([A]);
    expect(t.tenantId).toBe(A);
    expect(t.policies).toEqual([
      { importance: 'junk', action: 'delete', afterDays: 1, trigger: 'always' },
      { importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' },
    ]);
    await expect(owner.storagePolicy.create({ data: { tenantId: A, importance: 'high', action: 'delete', afterDays: 1 } })).rejects.toBeTruthy();
    await expect(owner.storagePolicy.create({ data: { tenantId: A, importance: 'keep', action: 'delete', afterDays: 1 } })).rejects.toBeTruthy();
    await svc.forTenant(A).upsertStoragePolicies([{ importance: 'medium', action: 'trim', afterDays: 7, trigger: 'above_85' }], 'owner-1');
    const [t2] = await svc.storageAutoCleanTargetsAcrossTenants([A]);
    expect(t2.policies.map((p) => p.importance)).toEqual(['junk', 'low', 'medium']);
  });

  it('[QT:T33] (phần e) retention: xoá events + mẫu REJECTED quá hạn VÀ cộng byte giải phóng vào freed_since_calibration / trừ used_bytes trong CÙNG câu', async () => {
    const old = new Date(Date.now() - 400 * DAY); // cũ hơn mọi retention của DB dùng chung
    await owner.projectUsage.update({ where: { tenantId: A }, data: { usedBytes: 10_000_000n, freedSinceCalibration: 0n } });
    await owner.event.create({ data: { id: `qt5_${run}`, tenantId: A, sourceId, idempotencyKey: `qt5:${run}`, correlationId: randomUUID(), type: 'order.x', source: 'github', data: { blob: 'q'.repeat(20_000) }, receivedAt: old } });
    await owner.rawEvent.create({ data: { sourceId, idempotencyKey: `qt5r:${run}`, headers: {}, body: {}, bodyRaw: Buffer.alloc(3000, 1), signatureValid: false, status: 'REJECTED', receivedAt: old } });
    let freedA = 0;
    for (;;) {
      const r = await svc.deleteExpiredEventsBatchAccounted(399 * 86_400, 1000);
      freedA += r.freed.filter((f) => f.tenantId === A).reduce((x, f) => x + f.bytes, 0);
      if (r.deleted < 1000) break;
    }
    for (;;) {
      const r = await svc.deleteExpiredRejectedBatchAccounted(399 * 86_400, 1000);
      freedA += r.freed.filter((f) => f.tenantId === A).reduce((x, f) => x + f.bytes, 0);
      if (r.deleted < 1000) break;
    }
    expect(freedA).toBeGreaterThan(3000);
    expect(await owner.event.count({ where: { tenantId: A } })).toBe(0);
    const u = await owner.projectUsage.findUnique({ where: { tenantId: A } });
    expect(Number(u!.freedSinceCalibration)).toBe(freedA);
    expect(Number(u!.usedBytes)).toBe(10_000_000 - freedA);
    // tính lại nấc NGAY sau retention
    await owner.projectUsage.update({ where: { tenantId: A }, data: { level: 'LOCKED' } });
    const c = await svc.forTenant(A).recomputeStorageLevel(100_000_000);
    expect(c).toMatchObject({ from: 'LOCKED', to: 'OK' });
  });
});
