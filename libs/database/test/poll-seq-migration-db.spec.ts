import { spawnSync } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma, testDbUrl } from './support/test-db';

/**
 * R2-4 (review vòng 2): migration `20261011050000_events_poll_seq` chạy bằng `prisma migrate deploy` THẬT trên DB ĐÃ CÓ
 * event (DB tạm): `poll_seq = seq` cho dòng cũ (cursor client đang giữ vẫn đúng), sequence tiếp sau max(seq) -> event
 * mới nhận cursor lớn hơn mọi cursor cũ.
 */
describeDb('Migration poll_seq trên DB có dữ liệu (R2-4)', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const owner = newTestPrisma('owner');
  const dbName = `pollseq_${randomUUID().slice(0, 8)}`;
  const url = (() => {
    // describe.skip (không có DB) vẫn chạy thân describe -> URL giữ chỗ để `npx jest` trần không vỡ suite; RUN_DB_TESTS=1 mà thiếu URL thì báo rõ.
    const u = new URL(testDbUrl('owner') ?? (process.env.RUN_DB_TESTS === '1' ? (() => { throw new Error('RUN_DB_TESTS=1 cần VERIFY_DB_OWNER_URL/DATABASE_URL'); })() : 'postgresql://skipped@localhost/skipped'));
    u.pathname = `/${dbName}`;
    return u.toString();
  })();
  let db: ReturnType<typeof newTestPrisma>;
  const deploy = () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'libs/database/prisma/schema.prisma'], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`migrate deploy exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  };

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    deploy();
    db = newTestPrisma('owner', url);
    // Đưa DB về trạng thái NGAY TRƯỚC migration poll_seq
    for (const q of [
      `DROP INDEX IF EXISTS "hub"."events_unassigned_poll_seq_idx"`,
      `DROP INDEX IF EXISTS "hub"."events_tenant_id_poll_seq_idx"`,
      `DROP INDEX IF EXISTS "hub"."events_poll_seq_key"`,
      `ALTER TABLE "hub"."events" DROP COLUMN "poll_seq"`,
      `DROP SEQUENCE "hub"."events_poll_seq"`,
      `DELETE FROM "_prisma_migrations" WHERE migration_name = '20261011050000_events_poll_seq'`,
    ]) await db.$executeRawUnsafe(q);
  }, 240_000);

  afterAll(async () => {
    await db?.$disconnect();
    await owner.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await owner.$disconnect();
  }, 60_000);

  it('R2-4: dòng cũ poll_seq = seq; event mới có cursor > max(seq); poll từ cursor cũ chỉ ra event mới', async () => {
    const tenant = randomUUID();
    for (let i = 0; i < 5; i++) {
      await db.$executeRawUnsafe(
        `INSERT INTO "hub"."events" (id, tenant_id, idempotency_key, correlation_id, type, source, data) VALUES ('old_${i}', '${tenant}', 'old:${i}', gen_random_uuid(), 'order.x', 'api', '{}')`,
      );
    }
    deploy(); // áp ĐÚNG migration poll_seq lên DB có dữ liệu
    const rows: { id: string; seq: bigint; poll_seq: bigint }[] = await db.$queryRawUnsafe(`SELECT id, seq, poll_seq FROM "hub"."events" ORDER BY seq`);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.poll_seq).toBe(r.seq);
    const maxOld = rows[rows.length - 1].seq;

    await db.$executeRawUnsafe(
      `INSERT INTO "hub"."events" (id, tenant_id, idempotency_key, correlation_id, type, source, data) VALUES ('new_1', '${tenant}', 'new:1', gen_random_uuid(), 'order.x', 'api', '{}')`,
    );
    const polled = await new TenantScopedRepository(db, tenant).pollEvents({ after: maxOld, limit: 100 });
    expect(polled.map((e) => e.id)).toEqual(['new_1']);
    expect(polled[0].cursor > maxOld).toBe(true);
  }, 240_000);
});
