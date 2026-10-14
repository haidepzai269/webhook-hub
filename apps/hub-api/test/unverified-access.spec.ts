import { HttpException } from '@nestjs/common';
import { ROLE_SCOPES } from '@hub/common';
import { ServiceResourcesController } from '../src/modules/service-api/service-resources.controller';
import { ApiController } from '../src/modules/api/api.controller';
import { ProjectsController } from '../src/modules/console/projects.controller';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';

/**
 * PK5 khoá 4 phủ polling / listen / replay (E4, ADR-206) + khoá 1 (cờ project, owner + audit). L0: controller THẬT, repo giả.
 * Phần SQL (`AND e.verified`, `accept_unverified` của replay hàng loạt) chạy trên Postgres thật ở `unverified-db.spec.ts` (CI).
 */
const PA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const errOf = async (p: Promise<unknown>) => {
  try {
    return { status: 200, body: (await p) as any };
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() as any };
    throw e;
  }
};

describe('[PK5] polling /v1/p/:project/events và sự kiện chưa xác thực', () => {
  function setup(scopes: string[]) {
    const pollEvents = jest.fn().mockResolvedValue([{ id: 'e1', cursor: 5n, verified: false }]);
    const prisma: any = { forTenant: jest.fn(() => ({ pollEvents })) };
    const ctrl = new ServiceResourcesController(prisma, {} as any);
    const req: any = { tenantId: PA, apiKey: { id: 'k', tenantId: PA, readTypes: [], scopes } };
    const res: any = { on: jest.fn() };
    return { pollEvents, call: (q: Record<string, string>) => errOf(ctrl.pollEvents(req, res, q)) };
  }

  it('[PK:T36] (phần a) key thường: repo KHÔNG nhận includeUnverified (SQL lọc `AND e.verified`); xin includeUnverified=true mà thiếu scope -> 403 missing_scope read:unverified', async () => {
    const s = setup(['read:events']);
    expect((await s.call({ after: '0' })).status).toBe(200);
    expect(s.pollEvents.mock.calls[0][0]).not.toHaveProperty('includeUnverified');
    const denied = await s.call({ after: '0', includeUnverified: 'true' });
    expect(denied).toMatchObject({ status: 403, body: { error: 'missing_scope', required: 'read:unverified' } });
    expect(s.pollEvents).toHaveBeenCalledTimes(1);
    expect((await s.call({ after: '0', includeUnverified: 'yes' })).status).toBe(422);
  });

  it('[PK:T36] (phần b) key có scope read:unverified + includeUnverified=true -> repo nhận includeUnverified, kết quả mang verified:false; không xin thì vẫn lọc', async () => {
    const s = setup(['read:events', 'read:unverified']);
    const r = await s.call({ after: '0', includeUnverified: 'true' });
    expect(r.status).toBe(200);
    expect(s.pollEvents.mock.calls[0][0]).toMatchObject({ includeUnverified: true });
    expect(r.body.events).toEqual([{ id: 'e1', cursor: '5', verified: false }]);
    await s.call({ after: '0' });
    expect(s.pollEvents.mock.calls.at(-1)[0]).not.toHaveProperty('includeUnverified');
  });
});

describe('[PK5] replay kiểm lại acceptUnverified LÚC replay (E4)', () => {
  const DELIVERY = '33333333-3333-3333-3333-333333333333';
  function setup(verified: boolean, acceptUnverified: boolean) {
    const repo = {
      findDeliveryById: jest.fn().mockResolvedValue({
        id: DELIVERY,
        tenantId: PA,
        status: 'DEAD',
        eventId: 'evt-1',
        subscriptionId: 'sub-1',
        attemptGeneration: 1,
        event: { id: 'evt-1', correlationId: 'c', verified },
        subscription: { isActive: true, acceptUnverified, destination: { id: 'd', isActive: true } },
      }),
      hasNewerGeneration: jest.fn().mockResolvedValue(false),
      createDelivery: jest.fn().mockResolvedValue({}),
    };
    const tx = { outbox: { create: jest.fn() }, auditLog: { create: jest.fn() } };
    const prisma: any = {
      forTenant: jest.fn((t: string, client?: any) => (client ? { ...repo, createAuditLog: (d: any) => client.auditLog.create({ data: { ...d, tenantId: t } }) } : repo)),
      tenantTx: (_t: any, fn: any) => fn(tx),
    };
    return { ctrl: new ApiController(prisma), repo, tx };
  }

  it('[PK:T36] (phần c) event chưa xác thực + subscription đã tắt acceptUnverified -> 409 unverified_not_accepted, 0 delivery, 0 outbox; bật -> replay được; event đã xác thực không bị ảnh hưởng', async () => {
    const off = setup(false, false);
    const r = await errOf(off.ctrl.replayDelivery(PA, 'admin', DELIVERY, {}));
    expect(r).toMatchObject({ status: 409, body: { error: 'unverified_not_accepted' } });
    expect(off.repo.createDelivery).not.toHaveBeenCalled();
    expect(off.tx.outbox.create).not.toHaveBeenCalled();
    const on = setup(false, true);
    expect((await on.ctrl.replayDelivery(PA, 'admin', DELIVERY, {})).generation).toBe(2);
    const verified = setup(true, false);
    expect((await verified.ctrl.replayDelivery(PA, 'admin', DELIVERY, {})).generation).toBe(2);
  });
});

describe('[PK5] scope read:unverified (owner cấp) + cờ project (owner, audit)', () => {
  it('read:unverified: chỉ bó owner; key cấp được nhưng người tạo phải tự có scope (developer -> 403, owner -> được, audit api_key.created ghi scopes)', async () => {
    expect(ROLE_SCOPES.owner).toContain('read:unverified');
    expect(ROLE_SCOPES.developer).not.toContain('read:unverified');
    const audits: any[] = [];
    const created: any[] = [];
    const prisma: any = {
      findProjectById: async () => ({ id: PA, slug: 'cafe', environment: 'test' }),
      tenantTx: async (_t: string, fn: any) =>
        fn({
          apiKey: { create: async ({ data }: any) => (created.push(data), { ...data, createdAt: new Date() }) },
          auditLog: { create: async ({ data }: any) => audits.push(data) },
          source: { create: async ({ data }: any) => ({ id: 'src', ...data }), count: async () => 0 },
          $executeRaw: async () => 0,
          $queryRaw: async () => [],
        }),
    };
    const ctrl = new ProjectsController(prisma);
    const principal = (role: 'owner' | 'developer') => ({ kind: 'user', id: 'u1', isOperator: false, emailVerified: true, scopes: [...ROLE_SCOPES[role]] });
    const dev = await errOf(ctrl.createKey({ principal: principal('developer') } as any, 'user:u1', PA, { serviceName: 'svc', scopes: ['read:events', 'read:unverified'] }));
    expect(dev).toMatchObject({ status: 403, body: { error: 'missing_scope', required: 'read:unverified' } });
    expect(created).toHaveLength(0);
    const own: any = await ctrl.createKey({ principal: principal('owner') } as any, 'user:u1', PA, { serviceName: 'svc', scopes: ['read:events', 'read:unverified'] });
    expect(own.scopes).toEqual(['read:events', 'read:unverified']);
    expect(audits.find((a) => a.action === 'api_key.created')?.metadata).toMatchObject({ scopes: ['read:events', 'read:unverified'] });
  });

  it('[PK:T14] (phần d) PUT /projects/:id/unverified-sources: scope manage:project (chỉ owner), body {allowUnverifiedSources: boolean}, ghi + audit CÙNG tx', async () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, ProjectsController.prototype.setUnverifiedSources)).toBe('manage:project');
    expect(ROLE_SCOPES.developer).not.toContain('manage:project');
    const writes: any[] = [];
    const audits: any[] = [];
    const tx = { marker: 'tx' };
    const prisma: any = {
      findProjectById: async () => ({ id: PA, allowUnverifiedSources: false }),
      setProjectAllowUnverified: async (id: string, v: boolean, client: any) => writes.push({ id, v, client }),
      forTenant: (_t: string, client: any) => ({ createAuditLog: async (a: any) => audits.push({ ...a, client }) }),
      tenantTx: async (_t: string, fn: any) => fn(tx),
    };
    const ctrl = new ProjectsController(prisma);
    expect(await ctrl.setUnverifiedSources('user:u1', PA, { allowUnverifiedSources: true })).toEqual({ id: PA, allowUnverifiedSources: true });
    expect(writes).toEqual([{ id: PA, v: true, client: tx }]);
    expect(audits).toEqual([expect.objectContaining({ action: 'project.unverified_sources_changed', metadata: { before: false, after: true }, client: tx })]);
    for (const body of [{}, { allowUnverifiedSources: 'true' }, { allowUnverifiedSources: true, extra: 1 }]) {
      expect((await errOf(ctrl.setUnverifiedSources('user:u1', PA, body))).status).toBe(422);
    }
  });
});
