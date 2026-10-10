import { HttpException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';
import { parseSourceInput } from '../src/modules/service-api/source-input';

// Tự đủ: không dựa vào test khác trong cùng worker đặt MASTER_KEY (thứ tự jest không cố định).
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test-master-key-at-least-32-characters!!';

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

describe('GET /v1/p/:project/sources/:id/inspect (S9)', () => {
  const PA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SG = '55555555-5555-5555-5555-555555555555';
  const SP = '66666666-6666-6666-6666-666666666666';
  const CFG = { scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'transactionId' }, eventType: 'bank.transaction.received' };
  function build() {
    const sources: Record<string, any> = {
      [SG]: { id: SG, tenantId: PA, provider: 'generic', verificationConfig: CFG },
      [SP]: { id: SP, tenantId: PA, provider: 'sepay', verificationConfig: null },
    };
    const raws = [
      { id: 'r1', status: 'ACCEPTED', signatureValid: true, headers: { 'x-signature': 'SIGVAL_abc' }, body: { transactionId: 'T' }, bodyRaw: Buffer.from('{}'), receivedAt: new Date('2026-10-10T00:00:03Z') },
      { id: 'r2', status: 'REJECTED', signatureValid: false, headers: { 'x-sig': 'SIGVAL_abc' }, body: {}, bodyRaw: Buffer.from('{}'), receivedAt: new Date('2026-10-10T00:00:02Z') },
    ];
    const repo = {
      findSourceById: jest.fn(async (id: string) => sources[id] ?? null),
      findRecentRawEventsForSource: jest.fn(async () => raws),
    };
    const prisma: any = { forTenant: () => repo };
    const req: any = { tenantId: PA, apiKey: { id: 'k1', tenantId: PA } };
    return { ctrl: new ServiceResourcesController(prisma, {} as any), req, repo };
  }

  it('[MS:T9] (phần e) 10 raw mới nhất kèm chẩn đoán; KHÔNG có giá trị chữ ký; source khác project -> 404; since sai -> 422', async () => {
    const { ctrl, req, repo } = build();
    const r: any[] = await ctrl.inspectSource(req, SG, '2026-10-10T00:00:00Z');
    expect(repo.findRecentRawEventsForSource).toHaveBeenCalledWith(SG, new Date('2026-10-10T00:00:00Z'), 10);
    expect(r).toEqual([
      { id: 'r1', receivedAt: new Date('2026-10-10T00:00:03Z'), status: 'ACCEPTED', diagnosis: { ok: true, reason: 'ok' } },
      { id: 'r2', receivedAt: new Date('2026-10-10T00:00:02Z'), status: 'REJECTED', diagnosis: { ok: false, reason: 'missing_header', expectedHeader: 'x-signature', candidateHeaders: ['x-sig'] } },
    ]);
    expect(JSON.stringify(r)).not.toContain('SIGVAL');
    await expect(ctrl.inspectSource(req, '77777777-7777-7777-7777-777777777777', undefined)).rejects.toMatchObject({ status: 404 });
    await expect(ctrl.inspectSource(req, SG, 'hôm qua')).rejects.toMatchObject({ status: 422 });
  });

  it('S9: adapter không có diagnose (sepay) -> {ok: signatureValid}', async () => {
    const { ctrl, req } = build();
    const r: any[] = await ctrl.inspectSource(req, SP, undefined);
    expect(r.map((x) => x.diagnosis)).toEqual([{ ok: true }, { ok: false }]);
  });
});
