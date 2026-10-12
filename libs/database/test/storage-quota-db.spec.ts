import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
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

  it('[QT:T7] (phần b) câu nạp source của ingest (escape hatch) và của publish (repo) trả nấc dung lượng JOIN cùng câu + keepLonger + secrets còn hiệu lực', async () => {
    const src = await owner.source.create({
      data: { tenantId: A, provider: 'github', name: 'k', sourceKey: `qt_k_${run}`, keepLonger: true, secrets: { create: [{ secretEncrypted: 'x' }, { secretEncrypted: 'old', validUntil: new Date(Date.now() - 1000) }] } },
    });
    await owner.$executeRaw`UPDATE hub.project_usage SET level = 'LOCKED' WHERE tenant_id = ${A}::uuid`;
    const viaIngest = await svc.findSourceBySourceKeyForIngest(`qt_k_${run}`);
    expect(viaIngest).toMatchObject({ id: src.id, tenantId: A, keepLonger: true, storageLevel: 'LOCKED', isActive: true, archivedAt: null });
    expect(viaIngest!.secrets.map((x) => x.secretEncrypted)).toEqual(['x']);
    const viaPublish = await svc.forTenant(A).findSourceById(src.id, { withStorageLevel: true });
    expect(viaPublish).toMatchObject({ id: src.id, keepLonger: true, storageLevel: 'LOCKED' });
    // project B chưa đo -> null (= OK); không thấy source của A
    expect(await svc.forTenant(B).findSourceById(src.id, { withStorageLevel: true })).toBeNull();
    expect(await svc.findSourceBySourceKeyForIngest(`khong_co_${run}`)).toBeNull();
    await owner.$executeRaw`UPDATE hub.project_usage SET level = 'OK' WHERE tenant_id = ${A}::uuid`;
    await owner.source.delete({ where: { id: src.id } });
  });

  it('[QT:T26] (phần b) project mới có sẵn policy mặc định (Rác delete 1 ngày, Thấp trim 3 ngày, Trung bình off) + project_usage; seed lại không nhân đôi', async () => {
    await svc.forTenant(A).seedStorageDefaults('test-again');
    const rows = await svc.forTenant(A).findStoragePolicies();
    expect(rows.map((r) => ({ importance: r.importance, action: r.action, afterDays: r.afterDays, trigger: r.trigger })).sort((a, b) => a.importance.localeCompare(b.importance))).toEqual(
      [...DEFAULT_STORAGE_POLICIES].map((p) => ({ ...p })).sort((a, b) => a.importance.localeCompare(b.importance)),
    );
    const usage = await svc.forTenant(A).findProjectUsage();
    expect(usage).toMatchObject({ level: 'OK', calibratedAt: null });
  });

  it('[QT:T26] (phần c) phần SEED của migration QT1 chạy trên project CÓ SẴN (tạo trước, chưa có policy): đủ 3 policy mặc định + project_usage + đúng 1 audit system:migration; chạy lại không nhân đôi (review L2)', async () => {
    // CI áp migration lên DB trống -> nhánh seed chưa từng chạy với dữ liệu. Ở đây: lấy NGUYÊN VĂN đoạn seed của
    // migration.sql, thu phạm vi về đúng project C (DB kiểm chứng dùng chung — không ghi audit cho project khác), chạy
    // như migration (rls_system on) trên project đã tồn tại TRƯỚC khi seed.
    const C = randomUUID();
    await owner.project.create({ data: { id: C, slug: `qt-c-${run}`, name: 'qt-c' } });
    try {
      expect(await svc.forTenant(C).findStoragePolicies()).toEqual([]); // trước seed: chưa có gì -> assertion dưới không tầm thường
      expect(await svc.forTenant(C).findProjectUsage()).toBeNull();
      const sql = readFileSync(join(__dirname, '../prisma/migrations/20261012100000_storage_quota/migration.sql'), 'utf8');
      const start = sql.indexOf('-- Q10 / QT:T26');
      const end = sql.indexOf("SELECT set_config('app.rls_system', '', false);");
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      let scoped = 0;
      const seed = sql
        .slice(start, end)
        .replace(/"hub"\."projects"( p\b)?/g, (_m, alias?: string) => {
          scoped++;
          return `(SELECT * FROM "hub"."projects" WHERE id = '${C}'::uuid) AS ${alias ? alias.trim() : 'scoped'}`;
        });
      expect(scoped).toBe(3); // policies + project_usage + audit — migration đổi số câu thì test phải được xem lại
      const statements = seed
        .split(/;\s*\n/)
        .map((st) => st.replace(/^\s*--.*$/gm, '').trim())
        .filter((st) => st.length > 0);
      expect(statements).toHaveLength(3);
      const runSeed = (only?: number) =>
        owner.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.rls_system', 'on', true)`;
          for (const [i, st] of statements.entries()) if (only === undefined || i < only) await tx.$executeRawUnsafe(st);
        });
      await runSeed();
      const policies = await svc.forTenant(C).findStoragePolicies();
      const norm = (xs: { importance: string; action: string; afterDays: number; trigger: string }[]) =>
        xs.map((r) => ({ importance: r.importance, action: r.action, afterDays: r.afterDays, trigger: r.trigger })).sort((a, b) => a.importance.localeCompare(b.importance));
      expect(norm(policies)).toEqual(norm([...DEFAULT_STORAGE_POLICIES]));
      expect(policies.every((p) => p.updatedBy === 'system:migration')).toBe(true);
      expect(await svc.forTenant(C).findProjectUsage()).toMatchObject({ level: 'OK', calibratedAt: null });
      expect(await owner.auditLog.count({ where: { tenantId: C, actor: 'system:migration', action: 'storage.policies.seeded' } })).toBe(1);
      // ON CONFLICT DO NOTHING: chạy lại hai câu policy + usage không nhân đôi
      await runSeed(2);
      expect(await svc.forTenant(C).findStoragePolicies()).toHaveLength(3);
    } finally {
      await owner.auditLog.deleteMany({ where: { tenantId: C } });
      await owner.project.deleteMany({ where: { id: C } });
    }
  });
});
