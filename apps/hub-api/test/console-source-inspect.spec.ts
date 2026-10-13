import 'reflect-metadata';
import { ApiController } from '../src/modules/api/api.controller';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';
import * as inspectMod from '../src/modules/service-api/source-inspect';

/**
 * PK1 (SPEC-provider-khac §3.2, ADR-202): console có `GET /api/v1/sources/:id/inspect` cho tab "Lắng nghe". Dùng CHUNG
 * một hàm với `GET /v1/p/:project/sources/:id/inspect` (không chép) -> cùng khuôn; không bao giờ có giá trị header/body.
 */
describe('[PK:T4] GET /api/v1/sources/:id/inspect (console) = khuôn service API, không giá trị header/body', () => {
  const PA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SG = '55555555-5555-5555-5555-555555555555';
  const CFG = { scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'transactionId' }, eventType: 'bank.transaction.received' };

  function build() {
    const sources: Record<string, any> = { [SG]: { id: SG, tenantId: PA, provider: 'generic', verificationConfig: CFG } };
    const raws = [
      { id: 'r1', status: 'ACCEPTED', signatureValid: true, headers: { 'x-signature': 'SIGVAL_abc' }, body: { transactionId: 'BODYVAL_T' }, bodyRaw: Buffer.from('{"transactionId":"BODYVAL_T"}'), receivedAt: new Date('2026-10-10T00:00:03Z') },
      { id: 'r2', status: 'REJECTED', signatureValid: false, headers: { 'x-sig': 'SIGVAL_abc', 'x-token': 'TOKVAL' }, body: { a: 'BODYVAL' }, bodyRaw: Buffer.from('{}'), receivedAt: new Date('2026-10-10T00:00:02Z') },
    ];
    const tenants: string[] = [];
    const repo = {
      findSourceById: jest.fn(async (id: string) => sources[id] ?? null),
      findRecentRawEventsForInspect: jest.fn(async () => raws),
    };
    const prisma: any = { forTenant: (t: string) => (tenants.push(t), repo) };
    return {
      api: new ApiController(prisma),
      svc: new ServiceResourcesController(prisma, {} as any),
      req: { tenantId: PA, apiKey: { id: 'k1', tenantId: PA } } as any,
      repo,
      tenants,
    };
  }
  afterEach(() => jest.restoreAllMocks());

  it('cùng kết quả với service API (qua MỘT hàm dùng chung), scope như GET sources của console, repo theo tenant', async () => {
    const shared = jest.spyOn(inspectMod, 'inspectSourceRows');
    const { api, svc, req, tenants } = build();
    const fromConsole = await api.inspectSource(PA, SG, '2026-10-10T00:00:00Z');
    const fromService = await svc.inspectSource(req, SG, '2026-10-10T00:00:00Z');
    expect(fromConsole).toEqual(fromService);
    expect(shared).toHaveBeenCalledTimes(2);
    expect(tenants).toEqual([PA, PA]); // TenantScopedRepository của đúng project (BB-5)
    expect(fromConsole).toEqual([
      { id: 'r1', receivedAt: new Date('2026-10-10T00:00:03Z'), status: 'ACCEPTED', diagnosis: { ok: true, reason: 'ok' } },
      { id: 'r2', receivedAt: new Date('2026-10-10T00:00:02Z'), status: 'REJECTED', diagnosis: { ok: false, reason: 'missing_header', expectedHeader: 'x-signature', candidateHeaders: ['x-sig', 'x-token'] } },
    ]);
    expect(JSON.stringify(fromConsole)).not.toMatch(/SIGVAL|TOKVAL|BODYVAL|bodyRaw|headers/);
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, ApiController.prototype.inspectSource)).toBe('read:project');
  });

  it('review PK1 T-4: inspect gọi repo KHÔNG nạp body_raw; nguồn có mapping vẫn chẩn đoán ACCEPTED được khi dòng không có bodyRaw', async () => {
    const MAPPED = {
      scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'maGD' }, eventType: 'payment.received',
      mapping: { amount: 'soTien', currency: { const: 'VND' }, method: { const: 'bank_transfer' }, providerTxnId: 'maGD', paidAt: 'thoiGian' },
    };
    const repo = {
      findSourceById: jest.fn(async () => ({ id: SG, tenantId: PA, provider: 'generic', verificationConfig: MAPPED })),
      findRecentRawEventsForInspect: jest.fn(async () => [
        { id: 'a1', status: 'ACCEPTED', signatureValid: true, headers: {}, body: { maGD: 'GD1', thoiGian: '2026-10-10 09:00:00' }, receivedAt: new Date('2026-10-10T00:00:05Z') },
        { id: 'a2', status: 'ACCEPTED', signatureValid: true, headers: {}, body: { maGD: 'GD2', soTien: 5000, thoiGian: '2026-10-10 09:00:00' }, receivedAt: new Date('2026-10-10T00:00:04Z') },
      ]),
      findRecentRawEventsForSource: jest.fn(),
    };
    const api = new ApiController({ forTenant: () => repo } as any);
    const rows: any[] = await api.inspectSource(PA, SG, undefined);
    expect(repo.findRecentRawEventsForInspect).toHaveBeenCalledWith(SG, new Date(0), 10);
    expect(repo.findRecentRawEventsForSource).not.toHaveBeenCalled();
    expect(rows.map((r) => r.diagnosis)).toEqual([{ ok: false, reason: 'mapping_field_missing', field: 'soTien' }, { ok: true, reason: 'ok' }]);
  });

  it('id lạ / không thuộc project -> 404; since sai -> 422 (giống service API)', async () => {
    const { api } = build();
    await expect(api.inspectSource(PA, '77777777-7777-7777-7777-777777777777', undefined)).rejects.toMatchObject({ status: 404 });
    await expect(api.inspectSource(PA, 'khong-phai-uuid', undefined)).rejects.toMatchObject({ status: 404 });
    await expect(api.inspectSource(PA, SG, 'hôm qua')).rejects.toMatchObject({ status: 422 });
  });
});
