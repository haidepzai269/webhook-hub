import { BadRequestException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ApiController, parseEventTypes } from '../src/modules/api/api.controller';

/** S3-3: mẫu kiểu sự kiện của subscription phải đúng ngữ pháp, sai -> 400 (U19, `*` một mình hợp lệ). */
describe('subscription eventTypes — validate mẫu (S3-3)', () => {
  const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const DEST = '11111111-1111-1111-1111-111111111111';
  const SUB = '33333333-3333-3333-3333-333333333333';

  function build() {
    const client: any = {
      destination: { findFirst: jest.fn(async ({ where }: any) => (where.id === DEST ? { id: DEST, tenantId: T } : null)) },
      subscription: {
        create: jest.fn(async ({ data }: any) => ({ id: SUB, ...data })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findFirst: jest.fn(async () => ({ id: SUB })),
      },
      auditLog: { create: jest.fn(async ({ data }: any) => data) },
    };
    const prisma: any = {
      forTenant: (tenantId: string, c?: any) => new TenantScopedRepository(c ?? client, tenantId),
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: async (fn: any) => fn(client),
    };
    return { controller: new ApiController(prisma), client };
  }

  it.each(['*.paid', 'payment.*.x', 'Payment.*', 'payment.', ''])('POST mẫu %j -> 400, không tạo gì', async (bad) => {
    const { controller, client } = build();
    await expect(controller.createSubscription(T, 'admin', { destinationId: DEST, name: 'x', eventTypes: ['repo.push', bad] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.subscription.create).not.toHaveBeenCalled();
  });

  it('POST thiếu eventTypes / mảng rỗng -> 400', async () => {
    const { controller } = build();
    await expect(controller.createSubscription(T, 'admin', { destinationId: DEST, name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.createSubscription(T, 'admin', { destinationId: DEST, name: 'x', eventTypes: [] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST `*`, `payment.*`, `repo.push` -> tạo được (khử trùng lặp)', async () => {
    const { controller, client } = build();
    await controller.createSubscription(T, 'admin', { destinationId: DEST, name: 'x', eventTypes: ['*', 'payment.*', 'repo.push', 'payment.*'] });
    expect(client.subscription.create.mock.calls[0][0].data.eventTypes).toEqual(['*', 'payment.*', 'repo.push']);
  });

  it('PATCH mẫu sai -> 400, không cập nhật', async () => {
    const { controller, client } = build();
    await expect(controller.updateSubscription(T, 'admin', SUB, { eventTypes: ['Payment.*'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(client.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('parseEventTypes: thông báo nêu mẫu sai', () => {
    try {
      parseEventTypes(['ok.x', '*.paid']);
      throw new Error('không ném');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(e.getResponse())).toContain('*.paid');
    }
  });
});
