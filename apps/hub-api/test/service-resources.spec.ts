import { HttpException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';

/**
 * S5 (SPEC §4.3B, §4.6): endpoint + subscription cho service qua `/v1/p/:project`. Repo THẬT trên Prisma giả
 * trong bộ nhớ — kiểm đúng lớp lọc project. Lỗi theo bảng `/v1/p`: 422 có tên trường, tài nguyên khác project 404.
 */
describe('Service API — endpoint + subscription (S5)', () => {
  const PA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const PB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const EA = '11111111-1111-1111-1111-111111111111';
  const EB = '22222222-2222-2222-2222-222222222222';
  const SA = '33333333-3333-3333-3333-333333333333';
  const SB = '44444444-4444-4444-4444-444444444444';

  function build() {
    const destinations: any[] = [
      { id: EA, tenantId: PA, name: 'A', type: 'webhook', configEncrypted: 'enc', signingSecretEncrypted: 'enc', verification: 'VERIFIED' },
      { id: EB, tenantId: PB, name: 'B', type: 'webhook', configEncrypted: 'enc', signingSecretEncrypted: null, verification: 'VERIFIED' },
    ];
    const sources = [
      { id: SA, tenantId: PA },
      { id: SB, tenantId: PB },
    ];
    const subs: any[] = [];
    const audits: any[] = [];
    const match = (row: any, where: any) =>
      Object.entries(where).every(([k, v]: [string, any]) =>
        v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v,
      );
    const client: any = {
      destination: {
        findFirst: jest.fn(async ({ where }: any) => destinations.find((d) => match(d, where)) ?? null),
        findMany: jest.fn(async ({ where }: any) => destinations.filter((d) => match(d, where))),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `dest-${destinations.length}`, createdAt: new Date(0), ...data };
          destinations.push(row);
          return row;
        }),
      },
      source: { findMany: jest.fn(async ({ where }: any) => sources.filter((s) => match(s, where))) },
      subscription: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `sub-${subs.length}`, createdAt: new Date(0), ...data };
          subs.push(row);
          return { ...row, destination: destinations.find((d) => d.id === data.destinationId) };
        }),
        findMany: jest.fn(async ({ where }: any) => subs.filter((s) => s.tenantId === where.tenantId)),
      },
      auditLog: { create: jest.fn(async ({ data }: any) => audits.push(data)) },
    };
    const prisma: any = {
      forTenant: (tenantId: string, c?: any) => new TenantScopedRepository(c ?? client, tenantId),
      $transaction: async (fn: any) => fn(client),
    };
    const req = (tenantId: string) => ({ tenantId, apiKey: { id: 'key-1', tenantId, serviceName: 'cafe-be' } }) as any;
    return { controller: new ServiceResourcesController(prisma), destinations, subs, audits, req };
  }

  async function status(p: Promise<unknown>): Promise<{ status: number; body: any }> {
    try {
      await p;
      return { status: 0, body: null };
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
      throw e;
    }
  }

  it('[MS:T5] (phần a) subscription trỏ endpoint của project khác -> 404 not_found, không tạo gì', async () => {
    const { controller, subs, req } = build();
    const r = await status(controller.createSubscription(req(PA), { endpointId: EB, name: 'x', eventTypes: ['order.*'] }));
    expect(r).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(subs).toHaveLength(0);
  });

  it('[MS:T5] (phần b) sourceIds có id không thuộc project -> 422 unknown_source kèm ids', async () => {
    const { controller, subs, req } = build();
    const r = await status(controller.createSubscription(req(PA), { endpointId: EA, name: 'x', eventTypes: ['order.*'], sourceIds: [SA, SB] }));
    expect(r).toEqual({ status: 422, body: { error: 'unknown_source', ids: [SB] } });
    expect(subs).toHaveLength(0);
  });

  it('[MS:U19] (phần b) eventTypes sai ngữ pháp (*.paid, payment.*.x, Payment.*) -> 422 field eventTypes; `*` hợp lệ (X1)', async () => {
    const { controller, req } = build();
    for (const bad of ['*.paid', 'payment.*.x', 'Payment.*']) {
      const r = await status(controller.createSubscription(req(PA), { endpointId: EA, name: 'x', eventTypes: [bad] }));
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: 'validation_failed', field: 'eventTypes' });
    }
    const ok = await controller.createSubscription(req(PA), { endpointId: EA, name: 'all', eventTypes: ['*'] });
    expect(ok).toMatchObject({ endpointId: EA, eventTypes: ['*'], sourceIds: [] });
  });

  it('[MS:T5] (phần c) tạo subscription hợp lệ -> trả endpointId/sourceIds, ghi audit subscription.create với actor là key', async () => {
    const { controller, subs, audits, req } = build();
    const created = await controller.createSubscription(req(PA), { endpointId: EA, name: 'orders', eventTypes: ['order.*'], sourceIds: [SA] });
    expect(created).toMatchObject({ name: 'orders', endpointId: EA, eventTypes: ['order.*'], sourceIds: [SA], isActive: true });
    expect(subs[0]).toMatchObject({ tenantId: PA, destinationId: EA, sourceIds: [SA] });
    expect(audits[0]).toMatchObject({ action: 'subscription.create', actor: 'key:key-1', tenantId: PA });
  });

  it('S5: tạo endpoint -> PENDING, url lưu mã hoá, response không có config/secret mã hoá', async () => {
    const { controller, destinations, req } = build();
    const created: any = await controller.createEndpoint(req(PA), { name: 'echo', url: 'https://example.com/hook' });
    expect(created).toMatchObject({ name: 'echo', url: 'https://example.com/hook', verification: 'PENDING' });
    expect(JSON.stringify(created)).not.toMatch(/Encrypted|configEncrypted/);
    const row = destinations.find((d) => d.id === created.id);
    expect(row).toMatchObject({ tenantId: PA, type: 'webhook', verification: 'PENDING' });
    expect(row.configEncrypted).not.toContain('example.com');
  });

  it('S5: url không phải http(s) / thiếu name -> 422 có tên trường', async () => {
    const { controller, req } = build();
    expect((await status(controller.createEndpoint(req(PA), { name: 'x', url: 'ftp://a/b' }))).body).toMatchObject({ field: 'url' });
    expect((await status(controller.createEndpoint(req(PA), { name: 'x', url: 'không phải url' }))).body).toMatchObject({ field: 'url' });
    expect((await status(controller.createEndpoint(req(PA), { url: 'https://a.b/c' }))).body).toMatchObject({ field: 'name' });
  });

  it('S5: GET endpoints chỉ thấy webhook của project mình, không lộ secret', async () => {
    const { controller, req } = build();
    const list: any[] = await controller.listEndpoints(req(PA));
    expect(list.map((e) => e.id)).toEqual([EA]);
    expect(JSON.stringify(list)).not.toMatch(/Encrypted/);
  });
});
