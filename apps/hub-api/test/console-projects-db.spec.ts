import { randomUUID } from 'crypto';
import { DEFAULT_TENANT_ID, PrismaService } from '@hub/database';
import { hashApiKey } from '@hub/common';
import { ProjectsController, parseCreateKey } from '../src/modules/console/projects.controller';
import { ProjectScopeGuard } from '../src/modules/console/project-scope.guard';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';
/** R-8: guard đóng mặc định — handler giả phải khai scope như route thật. */
const readProjectHandler = () => undefined;
Reflect.defineMetadata(REQUIRE_SCOPE_KEY, 'read:project', readProjectHandler);

/**
 * S2 (SPEC §4.3A) + AU1 trên Postgres THẬT: project + API key ở console; `?projectId=` đọc ở MỘT chỗ (X2) và từ
 * AU1 kiểm MEMBERSHIP — user chỉ thấy/đụng project mình là thành viên; operator thấy mọi project (ADR-056).
 */
describeDb('console: project + API key theo membership (Postgres, S2 + AU1)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const ctrl = new ProjectsController(svc);
  const run = randomUUID().slice(0, 6);
  const created: string[] = [];
  const users: string[] = [];
  const principal = (id: string, isOperator = false) => ({ kind: 'user', id, sessionId: randomUUID(), email: `${id}@t.vn`, name: 'T', isOperator, emailVerified: true });
  let alice: any;
  let bob: any;
  let op: any;
  const req = (p: any, query: Record<string, unknown> = {}) => ({ principal: p, query }) as any;

  beforeAll(async () => {
    for (const [name, isOp] of [['alice', false], ['bob', false], ['op', true]] as const) {
      const u = await raw.user.create({ data: { email: `${name}-${run}@t.vn`, name, isOperator: isOp } });
      users.push(u.id);
    }
    [alice, bob, op] = [principal(users[0]), principal(users[1]), principal(users[2], true)];
  });

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId: { in: created } } });
    await raw.project.deleteMany({ where: { id: { in: created } } });
    await raw.user.deleteMany({ where: { id: { in: users } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('tạo project 201 (người tạo là owner), trùng slug -> 409, slug sai -> 422; audit project.created; list theo membership', async () => {
    const p = await ctrl.create(req(alice), alice.id, { slug: `cafe-${run}`, name: 'Cafe', environment: 'test' });
    created.push(p.id);
    expect(p).toMatchObject({ slug: `cafe-${run}`, environment: 'test' });
    expect(await raw.projectMember.findUnique({ where: { tenantId_userId: { tenantId: p.id, userId: alice.id } } })).toMatchObject({ role: 'owner' });
    await expect(ctrl.create(req(alice), alice.id, { slug: `cafe-${run}`, name: 'x' })).rejects.toMatchObject({ status: 409 });
    await expect(ctrl.create(req(alice), alice.id, { slug: 'A!', name: 'x' })).rejects.toMatchObject({ status: 422 });
    expect(await raw.auditLog.count({ where: { tenantId: p.id, action: 'project.created' } })).toBe(1);
    expect((await ctrl.list(req(alice))).map((x: any) => x.id)).toContain(p.id);
    expect((await ctrl.list(req(bob))).map((x: any) => x.id)).not.toContain(p.id); // IDOR: bob không thấy
    expect((await ctrl.list(req(op))).some((x: any) => x.id === p.id && x.role === 'owner')).toBe(true); // operator thấy hết
  });

  it('tạo key: key hk_<env>_ chỉ trả MỘT lần, DB chỉ có sha256; danh sách không có key/keyHash; audit api_key.created', async () => {
    const p = await ctrl.create(req(alice), alice.id, { slug: `book-${run}`, name: 'Book', environment: 'live' });
    created.push(p.id);
    const k = await ctrl.createKey(req(alice), alice.id, p.id, { serviceName: 'book-be', scopes: ['read:events', 'manage:endpoints'] });
    expect(k.key).toMatch(/^hk_live_[A-Za-z0-9_-]{43}$/);
    expect(k.connectionString).toMatch(new RegExp(`^hubs?://hk_live_[^@]+@[^/]+/book-${run}$`));
    const row = await raw.apiKey.findUniqueOrThrow({ where: { id: k.id } });
    expect(row.keyHash).toBe(hashApiKey(k.key));
    expect(JSON.stringify(row)).not.toContain(k.key);
    const list = await ctrl.listKeys(p.id);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('key');
    expect(list[0]).not.toHaveProperty('keyHash');
    expect(await raw.auditLog.count({ where: { tenantId: p.id, action: 'api_key.created' } })).toBe(1);
    // người ngoài project: ProjectScopeGuard (đọc :projectId trên path) trả cùng 404 như project không tồn tại
    const guard = new ProjectScopeGuard(svc);
    const gctx = (r: any) => ({ switchToHttp: () => ({ getRequest: () => r }), getHandler: () => ctrl.listKeys, getClass: () => ProjectsController }) as any;
    await expect(guard.canActivate(gctx({ params: { projectId: p.id }, query: {}, principal: bob }))).rejects.toMatchObject({ status: 404 });
  });

  it('key không scope / scope lạ -> 422; project không tồn tại -> 404', async () => {
    expect(() => parseCreateKey({ serviceName: 'rong', scopes: [] })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => parseCreateKey({ serviceName: 'x', scopes: ['manage:keys'] })).toThrow(expect.objectContaining({ status: 422 }));
    await expect(ctrl.createKey(req(alice), alice.id, randomUUID(), { serviceName: 'x', scopes: ['read:events'] })).rejects.toMatchObject({ status: 404 });

  });

  it('[AR:R-14] trần project: user CHƯA xác minh tạo 5 project SONG SONG -> đúng 3 thành công, còn lại 403 project_limit; operator không giới hạn', async () => {
    const u = await raw.user.create({ data: { email: `dave-${run}@t.vn`, name: 'dave' } });
    users.push(u.id);
    const dave = { ...principal(u.id), emailVerified: false };
    const rs = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => ctrl.create(req(dave), dave.id, { slug: `dave${i}-${run}`, name: `D${i}` })));
    for (const r of rs) if (r.status === 'fulfilled') created.push((r.value as any).id);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of rs) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 403, response: expect.objectContaining({ error: 'project_limit', limit: 3 }) });
    const opRs = await Promise.all(Array.from({ length: 4 }, (_, i) => ctrl.create(req(op), op.id, { slug: `opx${i}-${run}`, name: `O${i}` })));
    created.push(...opRs.map((p: any) => p.id));
  });

  it('[AU:UA28] user CHƯA xác minh email: tạo project live / key hk_live_ -> 403 email_not_verified; hk_test_ thì được ngay', async () => {
    const carol = principal(users[0]);
    carol.emailVerified = false;
    await expect(ctrl.create(req(carol), carol.id, { slug: `live-${run}`, name: 'Live', environment: 'live' })).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ error: 'email_not_verified' }),
    });
    const t = await ctrl.create(req(carol), carol.id, { slug: `test-${run}`, name: 'Test', environment: 'test' });
    created.push(t.id);
    const k = await ctrl.createKey(req(carol), carol.id, t.id, { serviceName: 'svc', scopes: ['read:events'] });
    expect(k.key).toMatch(/^hk_test_/);
    // project live (do người đã xác minh tạo) mà thành viên chưa xác minh tạo key -> 403
    const live = await ctrl.create(req(alice), alice.id, { slug: `live2-${run}`, name: 'Live2', environment: 'live' });
    created.push(live.id);
    await expect(ctrl.createKey(req(carol), carol.id, live.id, { serviceName: 'svc', scopes: ['read:events'] })).rejects.toMatchObject({ status: 403 });
    expect((await ctrl.createKey(req(alice), alice.id, live.id, { serviceName: 'svc', scopes: ['read:events'] })).key).toMatch(/^hk_live_/);
  });

  it('revoke: 204 hai lần (idempotent), audit api_key.revoked đúng MỘT lần; key project khác -> 404', async () => {
    const p = await ctrl.create(req(alice), alice.id, { slug: `rev-${run}`, name: 'Rev' });
    created.push(p.id);
    const k = await ctrl.createKey(req(alice), alice.id, p.id, { serviceName: 'svc', scopes: ['read:events'] });
    await ctrl.revokeKey(alice.id, p.id, k.id);
    await ctrl.revokeKey(alice.id, p.id, k.id);
    expect((await raw.apiKey.findUniqueOrThrow({ where: { id: k.id } })).revokedAt).not.toBeNull();
    expect(await raw.auditLog.count({ where: { tenantId: p.id, action: 'api_key.revoked' } })).toBe(1);
    await expect(ctrl.revokeKey(op.id, DEFAULT_TENANT_ID, k.id)).rejects.toMatchObject({ status: 404 });
  });

  it('ProjectScopeGuard: không ?projectId -> 400 project_required (AU3); thành viên -> vào; không là thành viên / lạ / sai định dạng -> CÙNG 404; operator vào mọi project', async () => {
    const guard = new ProjectScopeGuard(svc);
    const ctx = (r: any) => ({ switchToHttp: () => ({ getRequest: () => r }), getHandler: () => readProjectHandler, getClass: () => class {} }) as any;
    await expect(guard.canActivate(ctx(req(alice)))).rejects.toMatchObject({ status: 400 });
    const r2 = req(alice, { projectId: created[1] });
    await guard.canActivate(ctx(r2));
    expect(r2.tenantId).toBe(created[1]);
    const bodies: string[] = [];
    for (const projectId of [created[0], randomUUID(), 'abc']) {
      const e = await guard.canActivate(ctx(req(bob, { projectId }))).catch((x) => x);
      expect(e.getStatus()).toBe(404);
      bodies.push(JSON.stringify(e.getResponse()));
    }
    expect(new Set(bodies).size).toBe(1);
    const r3 = req(op, { projectId: created[0] });
    await guard.canActivate(ctx(r3));
    expect(r3.tenantId).toBe(created[0]);
  });
});
