import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { assertSourceLimit } from '../src/modules/console/source-limit';

/** QT9 (SPEC-han-muc-dung-luong §10, Q11) trên Postgres THẬT (hub_app): khoá đếm trong transaction như R-14 (ADR-118). */
describeDb('QT9 trần source/project (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const A = randomUUID();
  let seq = 0;

  beforeAll(async () => {
    await owner.project.create({ data: { id: A, slug: `qt9-${run}`, name: 'qt9' } });
    for (let i = 0; i < 19; i++) await owner.source.create({ data: { tenantId: A, provider: 'github', name: `qt9-${i}`, sourceKey: `qt9_${run}_${++seq}` } });
    // đã lưu trữ: KHÔNG tính vào trần
    await owner.source.create({ data: { tenantId: A, provider: 'github', name: 'qt9-arch', sourceKey: `qt9_${run}_${++seq}`, isActive: false, archivedAt: new Date() } });
  }, 60_000);

  afterAll(async () => {
    await owner.project.deleteMany({ where: { id: A } });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  const create = () =>
    svc.tenantTx(A, async (tx) => {
      const repo = svc.forTenant(A, tx);
      await assertSourceLimit(repo, false, 20);
      await new Promise((r) => setTimeout(r, 50)); // nới cửa sổ tranh chấp
      return repo.createSource({ provider: 'github', name: 'qt9-new', sourceKey: `qt9_${run}_${++seq}`, isActive: true });
    });

  it('[QT:T27] (phần b) đang 19 (+1 đã lưu trữ): hai request tạo SONG SONG chỉ một cái qua, cái kia 409 source_limit; operator vẫn tạo được', async () => {
    const results = await Promise.allSettled([create(), create()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(HttpException);
    expect((bad[0].reason as HttpException).getResponse()).toMatchObject({ error: 'source_limit', limit: 20 });
    expect(await owner.source.count({ where: { tenantId: A, archivedAt: null } })).toBe(20);
    await svc.tenantTx(A, async (tx) => {
      const repo = svc.forTenant(A, tx);
      await assertSourceLimit(repo, true, 20);
      await repo.createSource({ provider: 'github', name: 'qt9-op', sourceKey: `qt9_${run}_${++seq}`, isActive: true });
    });
    expect(await owner.source.count({ where: { tenantId: A, archivedAt: null } })).toBe(21);
  });
});
