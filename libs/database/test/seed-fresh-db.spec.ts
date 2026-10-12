import { spawnSync } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { describeDb, newTestPrisma, testDbUrl } from './support/test-db';

/**
 * MS-P2-2 (review pha 2, ADR-088) trên Postgres THẬT, DB RỖNG: chạy đúng `prisma migrate deploy` + `seed.ts` như
 * container lúc khởi động (tiến trình con, DB tạm riêng). Hồi quy cũ: seed demo chạy TRƯỚC kiểm "đã seed" (đếm source
 * TOÀN DB) -> project default không có source/đích/subscription -> smoke 404 ngay sau `verify:reset`.
 */
describeDb('Seed trên DB rỗng (MS-P2-2)', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const owner = newTestPrisma('owner');
  const dbName = `seedfresh_${randomUUID().slice(0, 8)}`;
  // describe.skip (không có DB) vẫn chạy thân describe -> URL giữ chỗ để `npx jest` trần không vỡ suite.
  const base = new URL(testDbUrl('owner') ?? 'postgresql://skipped@localhost/skipped');
  const freshUrl = (() => {
    const u = new URL(base.toString());
    u.pathname = `/${dbName}`;
    return u.toString();
  })();
  let fresh: ReturnType<typeof newTestPrisma>;

  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: freshUrl, DIRECT_URL: freshUrl, SEED_DEMO_PROJECTS: 'true', RUN_DB_TESTS: '', ...extraEnv },
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`${args.join(' ')} exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    run([path.join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'libs/database/prisma/schema.prisma']);
  }, 180_000);

  afterAll(async () => {
    await fresh?.$disconnect();
    await owner.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await owner.$disconnect();
  }, 60_000);

  it('MS-P2-2: seed lần đầu tạo ĐỦ thế giới default (3 source, đích, subscription) VÀ demo cafe/bookstore; chạy lại không nhân đôi', async () => {
    const seed = [path.join(ROOT, 'node_modules/ts-node/dist/bin.js'), '-r', 'tsconfig-paths/register', '--transpile-only', '-P', 'tsconfig.json', 'libs/database/src/seed.ts'];
    const DEFAULT = '00000000-0000-0000-0000-000000000001';
    fresh = newTestPrisma('owner', freshUrl);
    // R-7: default đã có một source KHÁC (vd source `api` của key publish:events) trước khi seed -> seed default vẫn chạy
    await fresh.source.create({ data: { tenantId: DEFAULT, provider: 'api', name: 'pre', sourceKey: 'api_preexisting' } });
    run(seed);
    run(seed); // idempotent
    const keys = (await fresh.source.findMany({ where: { tenantId: DEFAULT }, select: { sourceKey: true } })).map((s: any) => s.sourceKey).sort();
    expect(keys).toEqual(['api_preexisting', 'src_github_main', 'src_payos_main', 'src_sepay_main']);
    expect(await fresh.destination.count({ where: { tenantId: DEFAULT } })).toBe(2);
    expect(await fresh.subscription.count({ where: { tenantId: DEFAULT } })).toBe(2);
    expect((await fresh.project.findMany({ select: { slug: true } })).map((p: any) => p.slug).sort()).toEqual(['bookstore', 'cafe', 'default']);
    expect(await fresh.source.count({ where: { sourceKey: { in: ['src_sepay_cafe', 'src_payos_bookstore'] } } })).toBe(2);
  }, 240_000);
});
