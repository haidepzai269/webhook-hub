import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * MS-P2-5 (review pha 2, ADR-092): DB cũ có dữ liệu với tenant_id ≠ default không có dòng `projects` -> console không
 * thấy, không tạo key được. Migration backfill phải tạo project cho MỌI tenant_id còn thiếu (idempotent).
 */
describeDb('Backfill projects cho tenant cũ (MS-P2-5)', () => {
  const raw = newTestPrisma('owner');
  const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261011030000_backfill_projects_for_tenants/migration.sql'), 'utf8');
  const orphan = randomUUID();
  const run = randomUUID().slice(0, 8);

  afterAll(async () => {
    await raw.subscription.deleteMany({ where: { tenantId: orphan } });
    await raw.destination.deleteMany({ where: { tenantId: orphan } });
    await raw.source.deleteMany({ where: { tenantId: orphan } });
    await raw.project.deleteMany({ where: { id: orphan } });
    await raw.$disconnect();
  });

  it('MS-P2-5: tenant chỉ có source/destination (không có project) -> migration tạo project slug tenant-<id>; chạy lại vô hại', async () => {
    await raw.source.create({ data: { tenantId: orphan, provider: 'github', name: 'old', sourceKey: `bf_${run}` } });
    await raw.destination.create({ data: { tenantId: orphan, name: `d-${run}`, type: 'webhook', configEncrypted: 'x' } });
    expect(await raw.project.findUnique({ where: { id: orphan } })).toBeNull();
    await raw.$executeRawUnsafe(sql); // migration là MỘT câu lệnh
    await raw.$executeRawUnsafe(sql); // lần 2: idempotent
    const p = await raw.project.findUnique({ where: { id: orphan } });
    expect(p).toMatchObject({ slug: `tenant-${orphan.replace(/-/g, '')}`, environment: 'test' });
    expect(await raw.project.count({ where: { id: orphan } })).toBe(1);
  });
});
