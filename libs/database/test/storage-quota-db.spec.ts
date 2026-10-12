import { randomUUID } from 'crypto';
import { DEFAULT_STORAGE_POLICIES } from '@hub/common';
import { PrismaService } from '../src/prisma.service';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * QT1 (SPEC-han-muc-dung-luong §5.4, §7, ADR-182/186): bảng `project_usage` + `storage_policies` mang tenant_id + RLS FORCE.
 * Chạy bằng role `hub_app` (DATABASE_URL); fixture bằng owner.
 */
describeDb('QT1: project_usage + storage_policies (RLS, seed mặc định)', () => {
  const owner = newTestPrisma('owner');
  const app = newTestPrisma('app');
  const svc = new PrismaService();
  const A = randomUUID();
  const B = randomUUID();
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    for (const [id, slug] of [[A, `qt-a-${run}`], [B, `qt-b-${run}`]]) {
      await owner.project.create({ data: { id, slug, name: slug } });
      await svc.forTenant(id).seedStorageDefaults('test');
    }
  }, 60_000);

  afterAll(async () => {
    await owner.project.deleteMany({ where: { id: { in: [A, B] } } }); // CASCADE project_usage + storage_policies
    await owner.$disconnect();
    await app.$disconnect();
    await svc.$disconnect();
  });

  it('[QT:T13] RLS: project_usage, storage_policies của A không đọc/ghi được khi app.project_id = B; chưa đặt gì -> 0 dòng', async () => {
    expect(await app.projectUsage.count({ where: { tenantId: { in: [A, B] } } })).toBe(0);
    expect(await app.storagePolicy.count({ where: { tenantId: { in: [A, B] } } })).toBe(0);
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${B}, true)`;
      expect(await tx.projectUsage.findUnique({ where: { tenantId: A } })).toBeNull();
      expect(await tx.storagePolicy.count({ where: { tenantId: A } })).toBe(0);
      expect(await tx.storagePolicy.count({ where: { tenantId: B } })).toBe(3);
    });
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.project_id', ${B}, true)`;
        await tx.$executeRaw`UPDATE hub.project_usage SET level = 'LOCKED' WHERE tenant_id = ${A}::uuid`;
        await tx.storagePolicy.create({ data: { tenantId: A, importance: 'medium', action: 'trim', afterDays: 9 } });
      }),
    ).rejects.toThrow();
    expect((await svc.forTenant(A).findProjectUsage())?.level).toBe('OK');
  });

  it('[QT:T26] (phần b) project mới có sẵn policy mặc định (Rác delete 1 ngày, Thấp trim 3 ngày, Trung bình off) + project_usage; seed lại không nhân đôi', async () => {
    await svc.forTenant(A).seedStorageDefaults('test-again');
    const rows = await svc.forTenant(A).findStoragePolicies();
    expect(rows.map((r) => ({ importance: r.importance, action: r.action, afterDays: r.afterDays, trigger: r.trigger })).sort((a, b) => a.importance.localeCompare(b.importance))).toEqual(
      [...DEFAULT_STORAGE_POLICIES].map((p) => ({ ...p })).sort((a, b) => a.importance.localeCompare(b.importance)),
    );
    const usage = await svc.forTenant(A).findProjectUsage();
    expect(usage).toMatchObject({ level: 'OK', calibratedAt: null });
    // migration QT1 seed project CÓ SẴN kèm audit system:migration — kiểm trên project default (có trước migration trên hubv)
    const migrated = await owner.auditLog.count({ where: { actor: 'system:migration', action: 'storage.policies.seeded' } });
    const projectsWithPolicy = await owner.storagePolicy.groupBy({ by: ['tenantId'] });
    expect(projectsWithPolicy.length).toBeGreaterThanOrEqual(migrated);
  });
});
