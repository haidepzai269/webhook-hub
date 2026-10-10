import { BadRequestException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ApiController } from '../src/modules/api/api.controller';

/**
 * S2-3 (unit): replay hàng loạt — dryRun không ghi; chạy thật ghi N delivery + N outbox + 1 audit
 * trong MỘT transaction; lỗi giữa chừng -> không còn dòng nào (Prisma giả có rollback).
 */
describe('POST /api/v1/deliveries/replay-bulk (S2-3)', () => {
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const refs = Array.from({ length: 3 }, (_, i) => ({
    id: `0000000${i}-0000-0000-0000-00000000000${i}`,
    eventId: `evt-${i}`,
    subscriptionId: 'sub-1',
    attemptGeneration: 1,
    lastError: 'Hết 5 lần retry: 500',
    createdAt: new Date(),
    correlationId: `corr-${i}`,
    eventType: 'repo.push',
    destinationId: 'dest-1',
  }));

  /** Prisma giả: ghi vào "staged", chỉ COMMIT vào "db" khi callback transaction resolve. */
  function build(opts: { failOn?: 'audit' | 'outbox' } = {}) {
    const db = { deliveries: [] as any[], outbox: [] as any[], audit: [] as any[] };
    const rootRepo = { findDeadDeliveryRefs: jest.fn().mockResolvedValue(refs) };
    const prisma: any = {
      forTenant: jest.fn((tenantId: string, client?: any) => (client ? new TenantScopedRepository(client, tenantId) : rootRepo)),
      $transaction: jest.fn(async (fn: any) => {
        const staged = { deliveries: [] as any[], outbox: [] as any[], audit: [] as any[] };
        const tx = {
          delivery: {
            createMany: jest.fn(async ({ data }: any) => (staged.deliveries.push(...data), { count: data.length })),
            create: jest.fn(async ({ data }: any) => (staged.deliveries.push(data), data)),
          },
          outbox: {
            createMany: jest.fn(async ({ data }: any) => {
              if (opts.failOn === 'outbox') throw new Error('outbox lỗi giữa chừng');
              staged.outbox.push(...data);
              return { count: data.length };
            }),
            create: jest.fn(async ({ data }: any) => (staged.outbox.push(data), data)),
          },
          auditLog: {
            create: jest.fn(async ({ data }: any) => {
              if (opts.failOn === 'audit') throw new Error('audit lỗi giữa chừng');
              staged.audit.push(data);
              return data;
            }),
          },
        };
        const out = await fn(tx);
        db.deliveries.push(...staged.deliveries);
        db.outbox.push(...staged.outbox);
        db.audit.push(...staged.audit);
        return out;
      }),
    };
    return { controller: new ApiController(prisma), prisma, db, rootRepo };
  }

  it('dryRun -> trả count + sample, KHÔNG mở transaction, không ghi gì', async () => {
    const { controller, prisma, db } = build();
    const res: any = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true });
    expect(res).toMatchObject({ dryRun: true, count: 3 });
    expect(res.sample).toHaveLength(3);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.deliveries.length + db.outbox.length + db.audit.length).toBe(0);
  });

  it('chạy thật -> N delivery (generation+1) + N outbox delivery.replayed gọn + 1 audit, trong 1 transaction', async () => {
    const { controller, prisma, db } = build();
    const res: any = await controller.replayBulk(TENANT, 'admin', {
      reason: 'đích sống lại',
      dryRun: false,
      destinationId: '11111111-1111-1111-1111-111111111111',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.count).toBe(3);
    expect(db.deliveries).toHaveLength(3);
    expect(db.deliveries.every((d) => d.attemptGeneration === 2 && d.status === 'PENDING' && d.tenantId === TENANT)).toBe(true);
    expect(db.outbox).toHaveLength(3);
    for (const o of db.outbox) {
      expect(o.topic).toBe('delivery.replayed');
      expect(Object.keys(o.payload).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'tenantId']);
    }
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ tenantId: TENANT, action: 'delivery.replay_bulk', actor: 'admin', reason: 'đích sống lại' });
    expect(db.audit[0].metadata).toMatchObject({ count: 3, deliveryIds: refs.map((r) => r.id) });
    expect(db.audit[0].metadata.filter).toMatchObject({ destinationId: '11111111-1111-1111-1111-111111111111' });
    // Review SPEC-2 #9: entityId là id thật của lô (UUID, trả về cho client), không phải '3 deliveries'
    expect(db.audit[0].entityType).toBe('delivery_batch');
    expect(db.audit[0].entityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.audit[0].entityId).toBe(res.batchId);
    expect(db.audit[0].metadata.newDeliveryIds).toEqual(res.items.map((i: any) => i.newDeliveryId));
  });

  it.each(['audit', 'outbox'] as const)('lỗi giữa chừng (%s) -> rollback: không còn dòng nào', async (failOn) => {
    const { controller, db } = build({ failOn });
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: false })).rejects.toThrow();
    expect(db.deliveries.length + db.outbox.length + db.audit.length).toBe(0);
  });

  it('lý do bắt buộc ≥ 5 ký tự; bộ lọc sai định dạng -> 400', async () => {
    const { controller } = build();
    await expect(controller.replayBulk(TENANT, 'admin', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.replayBulk(TENANT, 'admin', { reason: ' abc ', dryRun: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'hợp lệ nhé', dryRun: true, destinationId: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'hợp lệ nhé', dryRun: true, from: 'không-phải-ngày' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('giới hạn 500 dòng được truyền xuống repo', async () => {
    const { controller, rootRepo } = build();
    await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true, errorContains: '500' });
    expect(rootRepo.findDeadDeliveryRefs).toHaveBeenCalledWith(expect.objectContaining({ errorContains: '500' }), 500);
  });

  // ---- Review SPEC-2 #2 (ADR-054): dryRun phải là boolean thật ----
  it.each([
    ['chuỗi "true"', 'true'],
    ['chuỗi "false"', 'false'],
    ['số 1', 1],
    ['null', null],
  ])('dryRun là %s -> 400, KHÔNG đọc/ghi gì', async (_n, dryRun) => {
    const { controller, prisma, rootRepo, db } = build();
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun })).rejects.toBeInstanceOf(BadRequestException);
    expect(rootRepo.findDeadDeliveryRefs).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.deliveries.length + db.outbox.length + db.audit.length).toBe(0);
  });

  it('thiếu dryRun -> 400 (phải ghi rõ true/false), không chạy thật', async () => {
    const { controller, prisma } = build();
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại' })).rejects.toThrow(/dryRun/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['from là số epoch', { from: 1760000000000 }],
    ['from là object', { from: { $gt: 1 } }],
    ['to không phải ISO', { to: '10/10/2026' }],
    ['from > to', { from: '2026-10-10T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    ['destinationId là số', { destinationId: 123 }],
    ['errorContains là mảng', { errorContains: ['500'] }],
  ])('%s -> 400', async (_n, extra) => {
    const { controller, rootRepo } = build();
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true, ...extra })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(rootRepo.findDeadDeliveryRefs).not.toHaveBeenCalled();
  });

  it('from/to ISO hợp lệ -> truyền xuống repo đúng Date', async () => {
    const { controller, rootRepo } = build();
    await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true, from: '2026-10-01', to: '2026-10-10T12:00:00+07:00' });
    const [filter] = rootRepo.findDeadDeliveryRefs.mock.calls[0];
    expect(filter.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(filter.to.toISOString()).toBe('2026-10-10T05:00:00.000Z');
  });
});
