import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * R2-2 (ADR-098): DB nâng cấp từ trước R-1 — endpoint tạo qua /v1/p có `created_by_key_id = NULL` nên key của service
 * không thấy nó và `ensure` tạo endpoint THỨ HAI. Migration gán chủ theo audit `endpoint.create` (`actor = key:<id>`);
 * đích operator (actor khác) giữ NULL. Chạy chính file SQL hai lần (idempotent).
 */
describeDb('Backfill chủ endpoint từ audit (R2-2)', () => {
  const raw = newTestPrisma('owner');
  const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261011060000_endpoint_owner_from_audit/migration.sql'), 'utf8');
  const tenant = randomUUID();
  const run = randomUUID().slice(0, 8);
  const keyId = randomUUID();

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
  });

  it('R2-2: endpoint /v1/p cũ (audit actor key:<id>) -> created_by_key_id = id; đích operator giữ NULL', async () => {
    const byKey = await raw.destination.create({ data: { tenantId: tenant, name: `k-${run}`, type: 'webhook', configEncrypted: 'x' } });
    const byOp = await raw.destination.create({ data: { tenantId: tenant, name: `o-${run}`, type: 'webhook', configEncrypted: 'x' } });
    await raw.auditLog.createMany({
      data: [
        { tenantId: tenant, action: 'endpoint.create', entityType: 'destination', entityId: byKey.id, actor: `key:${keyId}` },
        { tenantId: tenant, action: 'destination.create', entityType: 'destination', entityId: byOp.id, actor: 'admin' },
      ],
    });
    await raw.$executeRawUnsafe(sql);
    await raw.$executeRawUnsafe(sql);
    expect((await raw.destination.findUnique({ where: { id: byKey.id } }))!.createdByKeyId).toBe(keyId);
    expect((await raw.destination.findUnique({ where: { id: byOp.id } }))!.createdByKeyId).toBeNull();
  });
});
