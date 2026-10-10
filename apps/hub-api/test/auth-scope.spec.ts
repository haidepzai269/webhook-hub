import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ROLE_SCOPES, KEY_GRANTABLE_SCOPES } from '@hub/common';
import { ProjectScopeGuard } from '../src/modules/console/project-scope.guard';
import { REQUIRE_SCOPE_KEY, NO_PROJECT_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';
import { ApiController } from '../src/modules/api/api.controller';
import { ProjectsController } from '../src/modules/console/projects.controller';
import { FlowController } from '../src/modules/flow/flow.controller';
import { MembersController } from '../src/modules/console/members.controller';

/** SPEC-auth §2.2, §5.6, §6.1 (AU3): role = bó scope; mọi route /api/v1/* khai scope; thứ tự 401 → 404 → 403. */
const P = '391110c1-3a81-480a-93ab-e11de0be107a';
function makeGuard(role: 'owner' | 'developer' | 'viewer' | null, projectExists = true) {
  const audits: any[] = [];
  const prisma: any = {
    findProjectById: async (id: string) => (projectExists && id === P ? { id } : null),
    identity: () => ({ findMembershipRole: async () => role, listMemberships: async () => [] }),
    forTenant: (tenantId: string) => ({ createAuditLog: async (a: any) => void audits.push({ tenantId, ...a }) }),
  };
  return { guard: new ProjectScopeGuard(prisma, new Reflector()), audits };
}
const user = (over: Record<string, unknown> = {}) => ({ kind: 'user', id: 'u1', sessionId: 's', email: 'a@b.vn', name: 'A', isOperator: false, emailVerified: true, ...over });
function ctx(handlerScope: string | undefined, req: any) {
  const handler = () => undefined;
  if (handlerScope) Reflect.defineMetadata(REQUIRE_SCOPE_KEY, handlerScope, handler);
  return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => class {} } as any;
}
const run = async (p: Promise<unknown>) => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() as any };
    throw e;
  }
};

describe('ROLE_SCOPES (SPEC-auth §2.2) — MỘT hằng số cho guard, web, docs', () => {
  it('viewer chỉ đọc; developer thêm ghi; owner thêm members/project; key không bao giờ được manage:keys/members/project', () => {
    expect(ROLE_SCOPES.viewer).toEqual(['read:project', 'read:events']);
    expect(ROLE_SCOPES.developer).toEqual(['read:project', 'read:events', 'publish:events', 'manage:endpoints', 'manage:sources', 'replay:deliveries', 'manage:keys']);
    expect(ROLE_SCOPES.owner).toEqual([...ROLE_SCOPES.developer, 'manage:members', 'manage:project']);
    expect(KEY_GRANTABLE_SCOPES).toEqual(['publish:events', 'read:events', 'manage:endpoints', 'manage:sources']);
  });
});

describe('ProjectScopeGuard — membership + scope', () => {
  it('[AU:UA16] không phải thành viên vs project không tồn tại → CÙNG 404, CÙNG body', async () => {
    const notMember = await run(makeGuard(null).guard.canActivate(ctx('read:project', { query: { projectId: P }, params: {}, principal: user() })));
    const missing = await run(makeGuard('owner', false).guard.canActivate(ctx('read:project', { query: { projectId: P }, params: {}, principal: user() })));
    const garbage = await run(makeGuard('owner').guard.canActivate(ctx('read:project', { query: { projectId: "x' or 1=1" }, params: {}, principal: user() })));
    expect(notMember).toEqual({ status: 404, body: { error: 'not_found', message: 'Project không tồn tại' } });
    expect(missing).toEqual(notMember);
    expect(garbage).toEqual(notMember);
  });

  it('[AU:UA17] viewer gọi route manage:endpoints → 403 missing_scope {required}; developer thì qua; thiếu ?projectId= → 400 project_required', async () => {
    const r = await run(makeGuard('viewer').guard.canActivate(ctx('manage:endpoints', { query: { projectId: P }, params: {}, principal: user() })));
    expect(r).toEqual({ status: 403, body: { error: 'missing_scope', message: expect.any(String), required: 'manage:endpoints' } });
    const req: any = { query: { projectId: P }, params: {}, principal: user() };
    expect((await run(makeGuard('developer').guard.canActivate(ctx('manage:endpoints', req)))).status).toBe(200);
    expect(req.tenantId).toBe(P);
    expect(req.principal.scopes).toEqual(ROLE_SCOPES.developer);
    const none = await run(makeGuard('owner').guard.canActivate(ctx('read:project', { query: {}, params: {}, principal: user() })));
    expect(none).toEqual({ status: 400, body: expect.objectContaining({ error: 'project_required' }) });
  });

  it('`:projectId` trên path cũng đi qua cùng luật (route /api/v1/projects/:projectId/*)', async () => {
    const req: any = { query: {}, params: { projectId: P }, principal: user() };
    expect((await run(makeGuard('viewer').guard.canActivate(ctx('read:project', req)))).status).toBe(200);
    expect(req.tenantId).toBe(P);
  });

  it('[AU:UA21] operator vào project KHÔNG là thành viên → được (scope owner) và ghi audit_logs operator.access của project đó; thành viên thật thì không ghi', async () => {
    const { guard, audits } = makeGuard(null);
    const req: any = { method: 'GET', path: '/api/v1/events', query: { projectId: P }, params: {}, principal: user({ isOperator: true }) };
    expect((await run(guard.canActivate(ctx('manage:project', req)))).status).toBe(200);
    expect(req.principal.scopes).toEqual(ROLE_SCOPES.owner);
    expect(audits).toEqual([expect.objectContaining({ tenantId: P, action: 'operator.access', actor: 'u1', entityType: 'project', entityId: P })]);
    const member = makeGuard('viewer');
    await member.guard.canActivate(ctx('read:project', { query: { projectId: P }, params: {}, principal: user({ isOperator: true }) }));
    expect(member.audits).toEqual([]);
  });
});

describe('[AU:UA20] quét metadata: MỌI route /api/v1/* khai @RequireScope (hoặc @NoProjectScope có lý do)', () => {
  it('ApiController, ProjectsController, FlowController, MembersController', () => {
    const missing: string[] = [];
    for (const C of [ApiController, ProjectsController, FlowController, MembersController] as any[]) {
      const base = Reflect.getMetadata(PATH_METADATA, C);
      for (const name of Object.getOwnPropertyNames(C.prototype)) {
        const fn = C.prototype[name];
        if (name === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;
        const scope = Reflect.getMetadata(REQUIRE_SCOPE_KEY, fn) ?? Reflect.getMetadata(REQUIRE_SCOPE_KEY, C);
        const open = Reflect.getMetadata(NO_PROJECT_SCOPE_KEY, fn);
        if (!scope && !open) missing.push(`${base}/${Reflect.getMetadata(PATH_METADATA, fn)} (${C.name}.${name})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
