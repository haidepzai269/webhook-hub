import { randomUUID } from 'crypto';
import { TenantScopedRepository } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * R-3 (review sau merge, ADR-095) trên Postgres THẬT với transaction GIỮ LÂU: event A INSERT trong transaction chưa
 * COMMIT (giữ ~4s, quá mọi cửa sổ lắng), event B INSERT + COMMIT ngay. Consumer poll -> thấy B, cursor vượt qua.
 * Sau khi A COMMIT, poll tiếp từ cursor PHẢI thấy A. Trước: cursor theo `seq` (cấp lúc INSERT) -> A mất vĩnh viễn.
 */
describeDb('Polling — cursor theo thứ tự COMMIT (R-3)', () => {
  const raw = newTestPrisma();
  const holder = newTestPrisma();
  const tenant = randomUUID();
  const run = randomUUID().slice(0, 8);
  const old = new Date(Date.now() - 60_000); // created_at cũ: cửa sổ lắng thời gian (nếu còn) không cứu được
  const data = (name: string) => ({
    id: `co_${run}_${name}`, tenantId: tenant, idempotencyKey: `co:${run}:${name}`, correlationId: randomUUID(),
    type: 'order.created', source: 'api', data: { name }, createdAt: old, receivedAt: old,
  });
  const repo = () => new TenantScopedRepository(raw, tenant);

  afterAll(async () => {
    await raw.event.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await holder.$disconnect();
  });

  it('R-3: transaction giữ 4s chèn A (seq nhỏ hơn), B commit trước -> poll thấy B; sau khi A commit, poll từ cursor của B VẪN thấy A', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const aInserted = new Promise<void>((r) => (inserted = r));
    const held = holder.$transaction(
      async (tx) => {
        await tx.event.create({ data: data('A') });
        inserted();
        await gate; // giữ transaction mở
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await aInserted;
    const b = await raw.event.create({ data: data('B') });
    const a = await raw.event.findFirst({ where: { id: `co_${run}_A` } });
    expect(a).toBeNull(); // A chưa commit: không thấy

    const first = await repo().pollEvents({ after: 0n, limit: 100 });
    expect(first.map((e) => e.id)).toEqual([b.id]);
    const cursor = first[first.length - 1].cursor;

    await new Promise((r) => setTimeout(r, 4000));
    release();
    await held;

    const next = await repo().pollEvents({ after: cursor, limit: 100 });
    expect(next.map((e) => e.id)).toEqual([`co_${run}_A`]);
    expect((await repo().pollEvents({ after: next[0].cursor, limit: 100 })).length).toBe(0);
  }, 60_000);
});
