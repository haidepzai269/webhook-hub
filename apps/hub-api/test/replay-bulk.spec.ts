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
    rateLimitRps: 4,
  }));

  /** Prisma giả: ghi vào "staged", chỉ COMMIT vào "db" khi callback transaction resolve. */
  function build(opts: { failOn?: 'audit' | 'outbox'; goneIds?: string[] } = {}) {
    const txQueries: any[] = [];
    // Lý do cho id bị loại: thuộc tenant, DEAD, đã có generation mới hơn.
    const skippedRows = (opts.goneIds ?? []).map((id) => ({ id, dead: true, superseded: true, replayable: true }));
    const db = { deliveries: [] as any[], outbox: [] as any[], audit: [] as any[] };
    const rootRepo = { findDeadDeliveryRefs: jest.fn().mockResolvedValue(refs) };
    const prisma: any = {
      forTenant: jest.fn((tenantId: string, client?: any) => (client ? new TenantScopedRepository(client, tenantId) : rootRepo)),
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => {
        const staged = { deliveries: [] as any[], outbox: [] as any[], audit: [] as any[] };
        const tx = {
          // ADR-163: chạy thật kiểm lại từng id trong tx (findDeadDeliveryRefs + findReplaySkipReasons).
          $queryRaw: jest.fn(async (q: any) => {
            txQueries.push(q);
            if (String(q.sql).includes('AS replayable')) return skippedRows;
            return refs.filter((r) => !opts.goneIds?.includes(r.id));
          }),
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
    return { controller: new ApiController(prisma), prisma, db, rootRepo, txQueries };
  }

  it('dryRun -> trả count + sample, KHÔNG mở transaction, không ghi gì', async () => {
    const { controller, prisma, db } = build();
    const res: any = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true });
    expect(res).toMatchObject({ dryRun: true, count: 3 });
    expect(res.sample).toHaveLength(3);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.deliveries.length + db.outbox.length + db.audit.length).toBe(0);
  });

  it('[AF:#28][BP:T5] (phần f) chạy thật -> N delivery (generation+1) + N outbox delivery.replayed gọn + 1 audit, trong 1 transaction', async () => {
    const { controller, prisma, db } = build();
    const res: any = await controller.replayBulk(TENANT, 'admin', {
      reason: 'đích sống lại',
      dryRun: false,
      ids: refs.map((r) => r.id),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.count).toBe(3);
    expect(db.deliveries).toHaveLength(3);
    expect(db.deliveries.every((d) => d.attemptGeneration === 2 && d.status === 'PENDING' && d.tenantId === TENANT)).toBe(true);
    expect(db.outbox).toHaveLength(3);
    for (const o of db.outbox) {
      expect(o.topic).toBe('delivery.replayed');
      expect(Object.keys(o.payload).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'destinationId', 'rateLimitRps', 'tenantId']);
      expect(o.payload).toMatchObject({ destinationId: 'dest-1', rateLimitRps: 4 });
    }
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ tenantId: TENANT, action: 'delivery.replay_bulk', actor: 'admin', reason: 'đích sống lại' });
    expect(db.audit[0].metadata).toMatchObject({ count: 3, deliveryIds: refs.map((r) => r.id) });
    // TB2: chạy thật không mang bộ lọc (chỉ ids) -> audit không ghi `filter` toàn null.
    expect(db.audit[0].metadata.filter).toBeUndefined();
    // Review SPEC-2 #9: entityId là id thật của lô (UUID, trả về cho client), không phải '3 deliveries'
    expect(db.audit[0].entityType).toBe('delivery_batch');
    expect(db.audit[0].entityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.audit[0].entityId).toBe(res.batchId);
    expect(db.audit[0].metadata.newDeliveryIds).toEqual(res.items.map((i: any) => i.newDeliveryId));
  });

  it.each(['audit', 'outbox'] as const)('lỗi giữa chừng (%s) -> rollback: không còn dòng nào', async (failOn) => {
    const { controller, db } = build({ failOn });
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: false, ids: refs.map((r) => r.id) })).rejects.toThrow();
    expect(db.deliveries.length + db.outbox.length + db.audit.length).toBe(0);
  });

  it('lý do bắt buộc ≥ 5 ký tự; bộ lọc sai định dạng -> 400', async () => {
    const { controller } = build();
    await expect(controller.replayBulk(TENANT, 'admin', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.replayBulk(TENANT, 'admin', { reason: ' abc ', dryRun: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'hợp lệ nhé', dryRun: true, destinationId: 'x' })).rejects.toMatchObject({
      status: 400,
      response: { error: 'bad_request', field: 'destinationId' },
    });
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'hợp lệ nhé', dryRun: true, from: 'không-phải-ngày' })).rejects.toMatchObject({
      status: 400,
      response: { error: 'bad_request', field: 'from' },
    });
  });

  it('giới hạn 500 dòng được truyền xuống repo', async () => {
    const { controller, rootRepo } = build();
    await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true, errorContains: '500' });
    // 501 = trần 500 + 1 để biết chắc có bị cắt không.
    expect(rootRepo.findDeadDeliveryRefs).toHaveBeenCalledWith(expect.objectContaining({ errorContains: '500' }), 501);
  });

  // ---- ADR-163 (M1): chạy thật = ĐÚNG tập đã xem trước ----
  it('xem trước trả ids (≤500); truncated chỉ khi thật sự có dòng thứ 501', async () => {
    const { controller, rootRepo } = build();
    const res: any = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true });
    expect(res.ids).toEqual(refs.map((r) => r.id));
    expect(res.truncated).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => ({ ...refs[0], id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` }));
    rootRepo.findDeadDeliveryRefs.mockResolvedValueOnce(many);
    const cut: any = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true });
    expect([cut.count, cut.ids.length, cut.truncated]).toEqual([500, 500, true]);
    rootRepo.findDeadDeliveryRefs.mockResolvedValueOnce(many.slice(0, 500));
    const exact: any = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true });
    expect(exact.truncated).toBe(false);
  });

  it('chạy thật thiếu / sai ids -> 400 field ids; xem trước kèm ids -> 400', async () => {
    const { controller, prisma } = build();
    for (const ids of [undefined, [], ['x'], 'abc', Array.from({ length: 501 }, () => refs[0].id)]) {
      const e = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: false, ids }).catch((x) => x);
      expect([e.getStatus(), e.getResponse().field]).toEqual([400, 'ids']);
    }
    const e = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true, ids: [refs[0].id] }).catch((x) => x);
    expect([e.getStatus(), e.getResponse().field]).toEqual([400, 'ids']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('chạy thật kiểm lại TRONG tx theo ids + replayableOnly; id đã đổi trạng thái bị bỏ kèm lý do', async () => {
    const gone = refs[1].id;
    const { controller, db, txQueries } = build({ goneIds: [gone] });
    const res: any = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: false, ids: refs.map((r) => r.id) });
    expect(res.count).toBe(2);
    expect(res.items.map((i: any) => i.deliveryId)).not.toContain(gone);
    expect(res.skipped).toEqual({ count: 1, byReason: { already_replayed: 1 }, items: [{ id: gone, reason: 'already_replayed' }] });
    expect(db.deliveries).toHaveLength(2);
    expect(db.audit[0].metadata).toMatchObject({ requested: 3, count: 2, skipped: [{ id: gone, reason: 'already_replayed' }] });
    const sel = txQueries[0];
    expect(sel.sql).toMatch(/d\.id = ANY\(\?::uuid\[\]\)/);
    expect(sel.sql).toMatch(/dst\.archived_at IS NULL AND dst\.is_active/); // replayableOnly (ADR-161) dùng chung
    expect(sel.values[0]).toBe(TENANT);
  });

  it.each(['destinationId', 'from', 'errorKind', 'errorContains'])('TB2: chạy thật kèm bộ lọc %s -> 400 (không nhận rồi lờ đi)', async (k) => {
    const { controller, prisma } = build();
    const val = { destinationId: '11111111-1111-1111-1111-111111111111', from: '2026-10-01T00:00:00Z', errorKind: 'http_4xx', errorContains: '500' }[k];
    const e = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: false, ids: [refs[0].id], [k]: val }).catch((x) => x);
    expect([e.getStatus(), e.getResponse().field]).toEqual([400, k]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Thấp 3: mọi id đều bị bỏ qua -> không delivery/outbox nhưng VẪN 1 audit (requested, skipped, count 0)', async () => {
    const all = refs.map((r) => r.id);
    const { controller, db } = build({ goneIds: all });
    const res: any = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: false, ids: all });
    expect(res.count).toBe(0);
    expect(res.skipped.count).toBe(3);
    expect(db.deliveries.length + db.outbox.length).toBe(0);
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0].metadata).toMatchObject({ count: 0, requested: 3 });
    expect(db.audit[0].metadata.skipped).toHaveLength(3);
    expect(db.audit[0].entityId).toBe(res.batchId);
  });

  it('errorKind lạ -> 400 bad_request field errorKind', async () => {
    const { controller } = build();
    const e = await controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true, errorKind: 'http_5xx' }).catch((x) => x);
    expect([e.getStatus(), e.getResponse().error, e.getResponse().field]).toEqual([400, 'bad_request', 'errorKind']);
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
    ['from là số epoch', { from: 1760000000000 }, 'from'],
    ['from là object', { from: { $gt: 1 } }, 'from'],
    ['to không phải ISO', { to: '10/10/2026' }, 'to'],
    ['from > to', { from: '2026-10-10T00:00:00Z', to: '2026-10-01T00:00:00Z' }, 'from'],
    ['destinationId là số', { destinationId: 123 }, 'destinationId'],
    ['errorContains là mảng', { errorContains: ['500'] }, 'errorContains'],
  ])('%s -> 400 (field)', async (_n, extra, field) => {
    const { controller, rootRepo } = build();
    await expect(controller.replayBulk(TENANT, 'admin', { reason: 'đích sống lại', dryRun: true, ...extra })).rejects.toMatchObject({
      status: 400,
      response: { error: 'bad_request', field },
    });
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
