import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hashApiKey } from '@hub/common';
import { ApiKeyGuard, LAST_USED_WRITE_INTERVAL_MS } from '../src/modules/service-api/api-key.guard';
import { NO_PROJECT_SCOPE_KEY, REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';

/**
 * S3 (SPEC §4.3B bảng lỗi): ApiKeyGuard theo ĐÚNG thứ tự 401 → 404 → 403. Không chạm Redis (X9).
 */
const PA = '11111111-1111-1111-1111-111111111111';
const KEY_A = 'hk_test_' + 'a'.repeat(43);
const KEY_REVOKED = 'hk_test_' + 'r'.repeat(43);

function setup(requiredScope?: string, noProjectScope?: string) {
  const rows: Record<string, any> = {
    [hashApiKey(KEY_A)]: {
      id: 'key-a',
      tenantId: PA,
      serviceName: 'cafe-be',
      scopes: ['read:events'],
      readTypes: [],
      sourceId: null,
      revokedAt: null,
      project: { id: PA, slug: 'cafe', name: 'Cafe', environment: 'test' },
    },
    [hashApiKey(KEY_REVOKED)]: {
      id: 'key-r',
      tenantId: PA,
      serviceName: 'old',
      scopes: ['read:events'],
      readTypes: [],
      sourceId: null,
      revokedAt: new Date(),
      project: { id: PA, slug: 'cafe', name: 'Cafe', environment: 'test' },
    },
  };
  const touch = jest.fn().mockResolvedValue(1);
  const prisma: any = {
    findApiKeyByHash: jest.fn(async (h: string) => rows[h] ?? null),
    forTenant: jest.fn(() => ({ touchApiKeyLastUsed: touch })),
  };
  const reflector = { getAllAndOverride: jest.fn((k: string) => (k === REQUIRE_SCOPE_KEY ? requiredScope : k === NO_PROJECT_SCOPE_KEY ? noProjectScope : undefined)) } as unknown as Reflector;
  const guard = new ApiKeyGuard(prisma, reflector);
  const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null }) as any;
  const call = async (req: any): Promise<{ status: number; body: unknown } | boolean> => {
    try {
      return await guard.canActivate(ctx(req));
    } catch (e) {
      if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
      throw e;
    }
  };
  return { call, prisma, touch };
}

const req = (project: string, auth?: string) => ({ params: { project }, headers: auth ? { authorization: auth } : {} });

describe('ApiKeyGuard (S3, SPEC §4.3B)', () => {
  it('[MS:U20] key hợp lệ, project đúng -> qua; request.tenantId = project; principal {kind:key}', async () => {
    const { call } = setup('read:events');
    const r: any = req('cafe', `Bearer ${KEY_A}`);
    expect(await call(r)).toBe(true);
    expect(r.tenantId).toBe(PA);
    expect(r.principal).toEqual({ kind: 'key', id: 'key-a', tenantId: PA, scopes: ['read:events'], serviceName: 'cafe-be' });
    expect(r.apiKey.project.slug).toBe('cafe');
  });

  it('[MS:U21] key đã revoke -> 401 invalid_api_key (cùng body với key sai / thiếu header)', async () => {
    const { call } = setup();
    const revoked = await call(req('cafe', `Bearer ${KEY_REVOKED}`));
    expect(revoked).toEqual({ status: 401, body: { error: 'invalid_api_key' } });
    expect(await call(req('cafe', 'Bearer hk_test_sai'))).toEqual(revoked);
    expect(await call(req('cafe'))).toEqual(revoked);
    expect(await call(req('cafe', `Basic ${KEY_A}`))).toEqual(revoked);
  });

  it('[MS:U22] key project A gọi path project B có tồn tại vs không tồn tại -> cả hai 404, body GIỐNG HỆT', async () => {
    const { call, prisma } = setup();
    const exists = await call(req('bookstore', `Bearer ${KEY_A}`));
    const missing = await call(req('khongtontai', `Bearer ${KEY_A}`));
    expect(exists).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(JSON.stringify(missing)).toBe(JSON.stringify(exists));
    // Không tra project theo slug: không có đường nào phân biệt "tồn tại" với "không tồn tại"
    expect(Object.keys(prisma)).not.toContain('findProjectBySlug');
  });

  it('[MS:U23] thiếu scope -> 403 {error:missing_scope, required}', async () => {
    const { call } = setup('publish:events');
    expect(await call(req('cafe', `Bearer ${KEY_A}`))).toEqual({ status: 403, body: { error: 'missing_scope', required: 'publish:events' } });
  });

  it('thứ tự kiểm: key sai trên path project lạ -> 401 (không lộ 404 trước khi xác thực)', async () => {
    const { call } = setup('publish:events');
    expect(await call(req('khongtontai', 'Bearer hk_test_sai'))).toMatchObject({ status: 401 });
  });

  it('lastUsedAt ghi tối đa 1 lần / phút / key (so trong bộ nhớ, không Redis)', async () => {
    const { call, touch } = setup('read:events');
    const t0 = Date.now();
    const spy = jest.spyOn(Date, 'now');
    spy.mockReturnValue(t0);
    await call(req('cafe', `Bearer ${KEY_A}`));
    await call(req('cafe', `Bearer ${KEY_A}`));
    expect(touch).toHaveBeenCalledTimes(1);
    spy.mockReturnValue(t0 + LAST_USED_WRITE_INTERVAL_MS + 1);
    await call(req('cafe', `Bearer ${KEY_A}`));
    expect(touch).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('[AR:R-8] (phần b) route /v1/p không khai @RequireScope và không @NoProjectScope -> 500 scope_not_declared; có @NoProjectScope (vd /me) -> qua', async () => {
    expect(await setup().call(req('cafe', `Bearer ${KEY_A}`))).toEqual({ status: 500, body: expect.objectContaining({ error: 'scope_not_declared' }) });
    expect(await setup(undefined, 'me').call(req('cafe', `Bearer ${KEY_A}`))).toBe(true);
  });
});
