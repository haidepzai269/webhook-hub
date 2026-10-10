import { HttpException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';
import { parseSourceInput } from '../src/modules/service-api/source-input';

/** S8 (SPEC §4.3B, §4.8): service tự tạo source (GenericAdapter); kiểm cấu hình lúc tạo, 422 có tên trường. */
describe('POST/GET /v1/p/:project/sources (S8)', () => {
  const PA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const GOOD = { scheme: 'hmac-sha256', header: 'x-signature', encoding: 'hex', idempotency: { field: 'transactionId' }, eventType: 'bank.transaction.received' };

  function build() {
    const sources: any[] = [];
    const audits: any[] = [];
    const client: any = {
      source: {
        create: jest.fn(async ({ data }: any) => {
          const { secrets, ...rest } = data;
          const row = { id: `src-${sources.length}`, createdAt: new Date(0), ...rest, secrets: [secrets.create] };
          sources.push(row);
          return row;
        }),
        findMany: jest.fn(async ({ where }: any) => sources.filter((s) => s.tenantId === where.tenantId)),
      },
      auditLog: { create: jest.fn(async ({ data }: any) => audits.push(data)) },
    };
    const prisma: any = {
      forTenant: (t: string, c?: any) => new TenantScopedRepository(c ?? client, t),
      $transaction: async (fn: any) => fn(client),
    };
    const req: any = { tenantId: PA, apiKey: { id: 'k1', tenantId: PA } };
    return { ctrl: new ServiceResourcesController(prisma, {} as any), req, sources, audits };
  }
  async function status(p: Promise<unknown>) {
    try {
      return { status: 201, body: await p };
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() as any };
      throw e;
    }
  }

  it('[MS:T9] (phần a) tạo source generic hợp lệ -> {id, webhookUrl=/hooks/generic/<sourceKey>}, secret mã hoá, audit source.create', async () => {
    const { ctrl, req, sources, audits } = build();
    const r: any = (await status(ctrl.createSource(req, { provider: 'generic', name: 'AB Bank (giả)', secret: 'bank_secret_123', verificationConfig: GOOD }))).body;
    expect(r.webhookUrl).toBe(`/hooks/generic/${sources[0].sourceKey}`);
    expect(r.id).toBe(sources[0].id);
    expect(sources[0]).toMatchObject({ tenantId: PA, provider: 'generic', isActive: true, verificationConfig: GOOD });
    expect(JSON.stringify(sources[0].secrets)).not.toContain('bank_secret_123');
    expect(JSON.stringify(r)).not.toMatch(/bank_secret_123|secretEncrypted/);
    expect(audits[0]).toMatchObject({ action: 'source.create', actor: 'key:k1' });
    const list: any[] = await ctrl.listSources(req);
    expect(list[0]).toMatchObject({ id: r.id, provider: 'generic', webhookUrl: r.webhookUrl });
    expect(JSON.stringify(list)).not.toMatch(/secret/i);
  });

  it('[MS:T9] (phần b) generic thiếu verificationConfig / idempotency.field "a.b" / provider=api / provider lạ / secret thiếu -> 422 có tên trường', async () => {
    const { ctrl, req, sources } = build();
    const f = async (b: any) => (await status(ctrl.createSource(req, b))).body;
    expect(await f({ provider: 'generic', name: 'x', secret: 'sssssssss' })).toMatchObject({ error: 'validation_failed', field: 'verificationConfig' });
    expect(await f({ provider: 'generic', name: 'x', secret: 'sssssssss', verificationConfig: { ...GOOD, idempotency: { field: 'a.b' } } })).toMatchObject({ field: 'verificationConfig.idempotency.field' });
    expect(await f({ provider: 'api', name: 'x', secret: 'sssssssss' })).toMatchObject({ field: 'provider' });
    expect(await f({ provider: 'zalo', name: 'x', secret: 'sssssssss' })).toMatchObject({ field: 'provider' });
    expect(await f({ provider: 'generic', name: 'x', verificationConfig: GOOD })).toMatchObject({ field: 'secret' });
    expect(await f({ provider: 'sepay', name: 'x', secret: 'sssssssss', verificationConfig: GOOD })).toMatchObject({ field: 'verificationConfig' });
    expect(sources).toHaveLength(0);
  });

  it('S8: parseSourceInput dùng chung console — sepay không cần config', () => {
    expect(parseSourceInput({ provider: 'sepay', name: 'SePay', secret: 'apikey_123456' })).toEqual({ provider: 'sepay', name: 'SePay', secret: 'apikey_123456', verificationConfig: undefined });
  });
});
