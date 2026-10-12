import { HttpException } from '@nestjs/common';
import { DEFAULT_SOURCE_LIMIT_PER_PROJECT, resolveSourceLimitPerProject } from '@hub/common';
import { TenantScopedRepository } from '@hub/database';
import { assertSourceLimit, isOperatorRequest } from '../src/modules/console/source-limit';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';

/** QT9 (SPEC-han-muc-dung-luong §10, Q11): trần source chưa lưu trữ mỗi project. */
describe('QT9 — SOURCE_LIMIT_PER_PROJECT', () => {
  const err = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof HttpException ? { status: e.getStatus(), body: e.getResponse() as any } : Promise.reject(e)));

  it('[QT:T27] (phần a) source thứ 21 -> 409 source_limit (limit=20); 19 -> qua; operator miễn (không khoá, không đếm); env đổi được trần', async () => {
    expect(DEFAULT_SOURCE_LIMIT_PER_PROJECT).toBe(20);
    expect(resolveSourceLimitPerProject(undefined)).toBe(20);
    expect(resolveSourceLimitPerProject('5')).toBe(5);
    expect(resolveSourceLimitPerProject('0')).toBe(20);
    expect(resolveSourceLimitPerProject('abc')).toBe(20);

    const repo = (n: number) => ({ lockAndCountActiveSources: jest.fn(async () => n) }) as any;
    await expect(assertSourceLimit(repo(19), false, 20)).resolves.toBeUndefined();
    const e = await err(assertSourceLimit(repo(20), false, 20));
    expect(e).toEqual({ status: 409, body: expect.objectContaining({ error: 'source_limit', limit: 20 }) });
    const op = repo(500);
    await expect(assertSourceLimit(op, true, 20)).resolves.toBeUndefined();
    expect(op.lockAndCountActiveSources).not.toHaveBeenCalled();

    expect(isOperatorRequest({ principal: { kind: 'user', isOperator: true } } as any)).toBe(true);
    expect(isOperatorRequest({ principal: { kind: 'user', isOperator: false } } as any)).toBe(false);
    expect(isOperatorRequest({ principal: { kind: 'key', isOperator: true } } as any)).toBe(false); // API key không bao giờ miễn
    expect(isOperatorRequest(undefined)).toBe(false);
  });

  it('[QT:T27] (phần c) /v1/p/:project/sources: đủ 20 source chưa lưu trữ -> 409 source_limit, không tạo; source đã lưu trữ không tính; khoá + đếm chạy TRONG transaction tạo', async () => {
    const T = '00000000-0000-0000-0000-0000000000c1';
    const sources: any[] = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, tenantId: T, archivedAt: i === 0 ? new Date() : null }));
    const order: string[] = [];
    const client: any = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        if (strings.join('?').includes('pg_advisory_xact_lock')) order.push('lock');
        return 0;
      }),
      source: {
        count: jest.fn(async ({ where }: any) => (order.push('count'), sources.filter((s) => s.tenantId === where.tenantId && s.archivedAt === null && where.archivedAt === null).length)),
        create: jest.fn(async ({ data }: any) => {
          order.push('create');
          const { secrets: _s, ...rest } = data;
          const row = { id: `new-${sources.length}`, createdAt: new Date(0), ...rest, archivedAt: null, secrets: [] };
          sources.push(row);
          return row;
        }),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    const prisma: any = {
      forTenant: (t: string, c?: any) => new TenantScopedRepository(c ?? client, t),
      tenantTx: async (_t: string, fn: any) => (order.push('tx'), fn(client)),
      $transaction: async (fn: any) => fn(client),
    };
    process.env.MASTER_KEY = 'test-master-key-at-least-32-characters!!';
    const ctrl = new ServiceResourcesController(prisma, {} as any);
    const req: any = { tenantId: T, apiKey: { id: 'k1', tenantId: T } };
    const body = { provider: 'github', name: 'x', secret: 's'.repeat(24) };
    // 19 chưa lưu trữ (1 đã lưu trữ không tính) -> qua, thành 20
    await ctrl.createSource(req, body);
    expect(order.slice(0, 4)).toEqual(['tx', 'lock', 'count', 'create']);
    // 20 -> 409, không tạo thêm
    const e = await err(ctrl.createSource(req, body));
    expect(e).toEqual({ status: 409, body: expect.objectContaining({ error: 'source_limit', limit: 20 }) });
    expect(client.source.create).toHaveBeenCalledTimes(1);
  });
});
