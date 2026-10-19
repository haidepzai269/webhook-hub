import { NotFoundException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ApiController } from '../src/modules/api/api.controller';

/**
 * S1-5 (BB-5): tenant A không được tạo subscription trỏ vào destination của tenant B.
 * Repo THẬT (TenantScopedRepository) chạy trên một Prisma giả giữ dữ liệu trong bộ nhớ —
 * kiểm đúng lớp lọc tenant, không mock mất chính thứ cần kiểm.
 */
describe('POST /api/v1/subscriptions — đích phải cùng tenant (S1-5)', () => {
  const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const DEST_A = '11111111-1111-1111-1111-111111111111';
  const DEST_B = '22222222-2222-2222-2222-222222222222';

  function build() {
    const destinations = [
      { id: DEST_A, tenantId: TENANT_A, name: 'A' },
      { id: DEST_B, tenantId: TENANT_B, name: 'B' },
    ];
    const created: any[] = [];
    const client: any = {
      destination: {
        findFirst: jest.fn(async ({ where }: any) =>
          destinations.find((d) => d.id === where.id && d.tenantId === where.tenantId) ?? null,
        ),
      },
      subscription: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return { id: 'sub-new', ...data };
        }),
      },
    };
    client.auditLog = { create: jest.fn(async ({ data }: any) => data) };
    const prisma: any = {
      forTenant: (tenantId: string, c?: any) => new TenantScopedRepository(c ?? client, tenantId),
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: async (fn: any) => fn(client),
    };
    return { controller: new ApiController(prisma), client, created };
  }

  it('[AF:#34] tenant A + destinationId của tenant B -> 404, không có dòng nào được tạo', async () => {
    const { controller, client, created } = build();
    await expect(
      controller.createSubscription(TENANT_A, 'admin', { destinationId: DEST_B, name: 'x', eventTypes: ['a.b'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.createSubscription(TENANT_A, 'admin', { destinationId: DEST_B, name: 'x', eventTypes: ['a.b'] }),
    ).rejects.toThrow('Destination không tồn tại');
    expect(client.subscription.create).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('destinationId không phải UUID / thiếu -> 404, không chạm DB', async () => {
    const { controller, client } = build();
    await expect(controller.createSubscription(TENANT_A, 'admin', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.createSubscription(TENANT_A, 'admin', { destinationId: "x' OR 1=1", name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(client.destination.findFirst).not.toHaveBeenCalled();
    expect(client.subscription.create).not.toHaveBeenCalled();
  });

  it.each([
    ['thiếu name', { destinationId: DEST_A, eventTypes: ['a.b'] }, 'name'],
    ['name không phải chuỗi', { destinationId: DEST_A, name: 5, eventTypes: ['a.b'] }, 'name'],
    ['name rỗng', { destinationId: DEST_A, name: '   ', eventTypes: ['a.b'] }, 'name'],
    ['name > 255 ký tự', { destinationId: DEST_A, name: 'x'.repeat(256), eventTypes: ['a.b'] }, 'name'],
    ['template sai kiểu', { destinationId: DEST_A, name: 'ok', eventTypes: ['a.b'], template: 7 }, 'template'],
  ])('%s -> 400 bad_request (không phải 500 PrismaClientValidationError), không chạm DB', async (_t, body, field) => {
    const { controller, client } = build();
    const err: any = await controller.createSubscription(TENANT_A, 'admin', body as any).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ error: 'bad_request', field });
    expect(client.destination.findFirst).not.toHaveBeenCalled();
    expect(client.subscription.create).not.toHaveBeenCalled();
  });

  it('đích cùng tenant -> tạo được, tenantId lấy từ token', async () => {
    const { controller, created } = build();
    await controller.createSubscription(TENANT_A, 'admin', { destinationId: DEST_A, name: 'ok', eventTypes: ['a.b'] });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenantId: TENANT_A, destinationId: DEST_A });
  });
});

describe('POST /api/v1/destinations — thiếu name -> 400 (cùng lỗi với subscriptions)', () => {
  it.each([[undefined], [''], [7]])('name=%p -> 400 bad_request, không chạm DB', async (name) => {
    const client: any = { destination: { create: jest.fn() } };
    const prisma: any = { forTenant: () => new TenantScopedRepository(client, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') };
    const controller = new ApiController(prisma);
    const err: any = await controller.createDestination('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin', { type: 'discord', name } as any).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ error: 'bad_request', field: 'name' });
    expect(client.destination.create).not.toHaveBeenCalled();
  });
});
