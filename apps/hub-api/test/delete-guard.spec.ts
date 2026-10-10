import { ConflictException, NotFoundException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ApiController } from '../src/modules/api/api.controller';

/**
 * Review SPEC-2 #1 (ADR-054): xoá subscription/destination KHÔNG được kéo theo lịch sử gửi.
 * Repo THẬT trên Prisma giả trong bộ nhớ — kiểm đúng lớp đếm có scope tenant.
 */
describe('DELETE subscription/destination — chặn khi còn lịch sử (ADR-054)', () => {
  const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const DEST = '11111111-1111-1111-1111-111111111111';
  const DEST_EMPTY = '22222222-2222-2222-2222-222222222222';
  const SUB = '33333333-3333-3333-3333-333333333333';
  const SUB_EMPTY = '44444444-4444-4444-4444-444444444444';

  function build(opts: { deleteThrows?: unknown } = {}) {
    const db = {
      destinations: [
        { id: DEST, tenantId: T, name: 'd', type: 'webhook' },
        { id: DEST_EMPTY, tenantId: T, name: 'empty', type: 'webhook' },
      ],
      subscriptions: [
        { id: SUB, tenantId: T, destinationId: DEST, name: 's' },
        { id: SUB_EMPTY, tenantId: T, destinationId: DEST, name: 's-empty' },
      ],
      deliveries: [
        { id: 'dl-1', tenantId: T, subscriptionId: SUB, status: 'DEAD' },
        { id: 'dl-2', tenantId: T, subscriptionId: SUB, status: 'SUCCEEDED' },
        // tenant khác trỏ cùng id (dữ liệu bẩn) — không được đếm vào tenant T
        { id: 'dl-x', tenantId: OTHER, subscriptionId: SUB_EMPTY, status: 'DEAD' },
      ],
      audit: [] as any[],
    };
    const subOf = (id: string) => db.subscriptions.find((s) => s.id === id);
    const matchDelivery = (d: any, where: any) =>
      d.tenantId === where.tenantId &&
      (where.subscriptionId === undefined || d.subscriptionId === where.subscriptionId) &&
      (where.subscription?.destinationId === undefined || subOf(d.subscriptionId)?.destinationId === where.subscription.destinationId);
    const client: any = {
      destination: {
        findFirst: jest.fn(async ({ where }: any) => db.destinations.find((d) => d.id === where.id && d.tenantId === where.tenantId) ?? null),
        deleteMany: jest.fn(async ({ where }: any) => {
          if (opts.deleteThrows) throw opts.deleteThrows;
          const before = db.destinations.length;
          db.destinations = db.destinations.filter((d) => !(d.id === where.id && d.tenantId === where.tenantId));
          return { count: before - db.destinations.length };
        }),
      },
      subscription: {
        findFirst: jest.fn(async ({ where }: any) => db.subscriptions.find((s) => s.id === where.id && s.tenantId === where.tenantId) ?? null),
        count: jest.fn(async ({ where }: any) =>
          db.subscriptions.filter((s) => s.tenantId === where.tenantId && s.destinationId === where.destinationId).length,
        ),
        deleteMany: jest.fn(async ({ where }: any) => {
          if (opts.deleteThrows) throw opts.deleteThrows;
          const before = db.subscriptions.length;
          db.subscriptions = db.subscriptions.filter((s) => !(s.id === where.id && s.tenantId === where.tenantId));
          return { count: before - db.subscriptions.length };
        }),
      },
      delivery: { count: jest.fn(async ({ where }: any) => db.deliveries.filter((d) => matchDelivery(d, where)).length) },
      auditLog: { create: jest.fn(async ({ data }: any) => (db.audit.push(data), data)) },
    };
    const prisma: any = {
      forTenant: (tenantId: string, c?: any) => new TenantScopedRepository(c ?? client, tenantId),
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: async (fn: any) => fn(client),
    };
    return { controller: new ApiController(prisma), db, client };
  }

  it('subscription còn 2 delivery (có DEAD) -> 409 kèm deliveryCount + hướng dẫn tắt; KHÔNG xoá, KHÔNG audit', async () => {
    const { controller, db, client } = build();
    const err = await controller.deleteSubscription(T, 'admin', SUB).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = err.getResponse();
    expect(body).toMatchObject({ statusCode: 409, code: 'SUBSCRIPTION_HAS_DELIVERIES', deliveryCount: 2 });
    expect(body.message).toMatch(/isActive=false/);
    expect(client.subscription.deleteMany).not.toHaveBeenCalled();
    expect(db.subscriptions).toHaveLength(2);
    expect(db.deliveries).toHaveLength(3);
    expect(db.audit).toHaveLength(0);
  });

  it('subscription không có delivery (của tenant mình) -> xoá được + audit', async () => {
    const { controller, db } = build();
    await expect(controller.deleteSubscription(T, 'admin', SUB_EMPTY)).resolves.toEqual({ deleted: true, id: SUB_EMPTY });
    expect(db.subscriptions.map((s) => s.id)).toEqual([SUB]);
    expect(db.audit).toEqual([expect.objectContaining({ action: 'subscription.delete', entityId: SUB_EMPTY })]);
  });

  it('destination còn subscription -> 409 kèm subscriptionCount + deliveryCount; không xoá gì', async () => {
    const { controller, db, client } = build();
    const err = await controller.deleteDestination(T, 'admin', DEST).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'DESTINATION_IN_USE', subscriptionCount: 2, deliveryCount: 2 });
    expect(client.destination.deleteMany).not.toHaveBeenCalled();
    expect(db.destinations).toHaveLength(2);
  });

  it('destination không còn subscription -> xoá được', async () => {
    const { controller, db } = build();
    await expect(controller.deleteDestination(T, 'admin', DEST_EMPTY)).resolves.toEqual({ deleted: true, id: DEST_EMPTY });
    expect(db.destinations.map((d) => d.id)).toEqual([DEST]);
  });

  it('race: DB chặn bằng FK RESTRICT (P2003) -> 409, không phải 500', async () => {
    const { controller } = build({ deleteThrows: Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }) });
    await expect(controller.deleteDestination(T, 'admin', DEST_EMPTY)).rejects.toBeInstanceOf(ConflictException);
    await expect(controller.deleteSubscription(T, 'admin', SUB_EMPTY)).rejects.toBeInstanceOf(ConflictException);
  });

  it('tenant khác -> 404 (không lộ tồn tại)', async () => {
    const { controller } = build();
    await expect(controller.deleteSubscription(OTHER, 'admin', SUB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.deleteDestination(OTHER, 'admin', DEST)).rejects.toBeInstanceOf(NotFoundException);
  });
});
