import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma.service';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * SPEC-auth §5.12 (AU6) — "kể cả khi code của em quên lọc tenant, Postgres vẫn trả 0 dòng".
 * Chạy bằng role `hub_app` (DATABASE_URL); fixture dựng bằng owner (VERIFY_DB_OWNER_URL). Tiền đề SAI (chạy bằng
 * superuser / BYPASSRLS) thì test ĐỎ ngay — không bao giờ pass âm thầm (SPEC-verification §4.3, VT12).
 */
describeDb('RLS: Postgres tự chặn chéo project (hub_app, AU6)', () => {
  const owner = newTestPrisma('owner');
  const app = newTestPrisma('app');
  const svc = new PrismaService();
  const A = randomUUID();
  const B = randomUUID();
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    for (const [id, slug] of [[A, `rls-a-${run}`], [B, `rls-b-${run}`]]) {
      await owner.project.create({ data: { id, slug, name: slug } });
      for (let i = 0; i < 3; i++) {
        await owner.event.create({ data: { id: `RLS${run}${slug}${i}`, tenantId: id, idempotencyKey: `${slug}:${i}`, correlationId: randomUUID(), type: 't.rls', source: 'test', data: {} } });
      }
      const src = await owner.source.create({ data: { tenantId: id, provider: 'github', name: slug, sourceKey: `rls_${slug}` } });
      await owner.rawEvent.create({
        data: { sourceId: src.id, idempotencyKey: `raw:${slug}`, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), contentType: 'application/json', signatureValid: true, status: 'ACCEPTED' },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await owner.event.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.rawEvent.deleteMany({ where: { source: { tenantId: { in: [A, B] } } } });
    await owner.source.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.project.deleteMany({ where: { id: { in: [A, B] } } });
    await owner.$disconnect();
    await app.$disconnect();
    await svc.$disconnect();
  });

  it('[AU:TA12][BB:5] (phần a) tiền đề: hub_app KHÔNG superuser, KHÔNG BYPASSRLS; chưa set gì -> 0 dòng; set project A -> chỉ A; ghi tenant B khi đang là A -> lỗi RLS; prisma.event.findMany() bỏ qua repo -> []', async () => {
    const [who] = await app.$queryRaw<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ current_user: 'hub_app', rolsuper: false, rolbypassrls: false });

    // owner (bỏ qua RLS) thấy dữ liệu thật — để chắc "0 dòng" dưới đây không phải vì bảng rỗng
    expect(await owner.event.count({ where: { tenantId: { in: [A, B] } } })).toBe(6);

    // "code quên lọc tenant": gọi thẳng Prisma, KHÔNG qua repo, KHÔNG set_config -> Postgres trả 0
    expect(await app.event.findMany({ where: { tenantId: { in: [A, B] } } })).toEqual([]);
    expect(await app.rawEvent.count({ where: { idempotencyKey: { startsWith: 'raw:rls-' } } })).toBe(0);
    const [{ n }] = await app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM hub.events`;
    expect(Number(n)).toBe(0);

    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${A}, true)`;
      const rows = await tx.event.findMany({ where: { tenantId: { in: [A, B] } }, select: { tenantId: true } });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([A]));
      expect(await tx.rawEvent.count({ where: { idempotencyKey: { startsWith: 'raw:rls-' } } })).toBe(1); // bảng con theo bảng cha
    });

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.project_id', ${A}, true)`;
        await tx.event.create({ data: { id: `RLSX${run}`, tenantId: B, idempotencyKey: 'x', correlationId: randomUUID(), type: 't', source: 's', data: {} } });
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('[BB:5] (phần b) TenantScopedRepository tự đặt project cho MỌI truy vấn (client gốc lẫn trong transaction); systemTx là lối DUY NHẤT nhìn xuyên project', async () => {
    const repoA = svc.forTenant(A);
    const mine = await repoA.findEvents({ type: 't.rls' }, 50);
    expect(mine).toHaveLength(3);
    expect(mine.every((e) => e.tenantId === A)).toBe(true);
    const viaTx = await svc.$transaction(async (tx) => new TenantScopedRepository(tx, B).findEvents({ type: 't.rls' }, 50));
    expect(viaTx.map((e) => e.tenantId)).toEqual([B, B, B]);
    const all = await svc.systemTx('test: đếm xuyên project', (tx) => tx.event.count({ where: { tenantId: { in: [A, B] } } }));
    expect(all).toBe(6);
  });
});
