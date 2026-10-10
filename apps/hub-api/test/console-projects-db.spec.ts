import { randomUUID } from 'crypto';
import { DEFAULT_TENANT_ID, PrismaService } from '@hub/database';
import { hashApiKey } from '@hub/common';
import { ProjectsController, parseCreateKey } from '../src/modules/console/projects.controller';
import { ProjectScopeGuard } from '../src/modules/console/project-scope.guard';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * S2 (SPEC §4.3A) trên Postgres THẬT: project + API key ở console admin; `?projectId=` đọc ở MỘT chỗ (X2).
 */
describeDb('console: project + API key (Postgres, S2)', () => {
  const raw = newTestPrisma();
  const svc = new PrismaService();
  const ctrl = new ProjectsController(svc);
  const run = randomUUID().slice(0, 6);
  const created: string[] = [];

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId: { in: created } } });
    await raw.project.deleteMany({ where: { id: { in: created } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('tạo project 201, trùng slug -> 409, slug sai -> 422; audit project.created', async () => {
    const p = await ctrl.create('admin', { slug: `cafe-${run}`, name: 'Cafe', environment: 'test' });
    created.push(p.id);
    expect(p).toMatchObject({ slug: `cafe-${run}`, environment: 'test' });
    await expect(ctrl.create('admin', { slug: `cafe-${run}`, name: 'x' })).rejects.toMatchObject({ status: 409 });
    await expect(ctrl.create('admin', { slug: 'A!', name: 'x' })).rejects.toMatchObject({ status: 422 });
    expect(await raw.auditLog.count({ where: { tenantId: p.id, action: 'project.created' } })).toBe(1);
    expect((await ctrl.list()).some((x) => x.id === p.id)).toBe(true);
  });

  it('tạo key: key hk_<env>_ chỉ trả MỘT lần, DB chỉ có sha256; danh sách không có key/keyHash; audit api_key.created', async () => {
    const p = await ctrl.create('admin', { slug: `book-${run}`, name: 'Book', environment: 'live' });
    created.push(p.id);
    const k = await ctrl.createKey('admin', p.id, { serviceName: 'book-be', scopes: ['read:events', 'manage:endpoints'] });
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
  });

  it('key không scope / scope lạ -> 422; project không tồn tại -> 404', async () => {
    expect(() => parseCreateKey({ serviceName: 'rong', scopes: [] })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => parseCreateKey({ serviceName: 'x', scopes: ['manage:keys'] })).toThrow(expect.objectContaining({ status: 422 }));
    await expect(ctrl.createKey('admin', randomUUID(), { serviceName: 'x', scopes: ['read:events'] })).rejects.toMatchObject({ status: 404 });
  });

  it('revoke: 204 hai lần (idempotent), audit api_key.revoked đúng MỘT lần; key project khác -> 404', async () => {
    const p = await ctrl.create('admin', { slug: `rev-${run}`, name: 'Rev' });
    created.push(p.id);
    const k = await ctrl.createKey('admin', p.id, { serviceName: 'svc', scopes: ['read:events'] });
    await ctrl.revokeKey('admin', p.id, k.id);
    await ctrl.revokeKey('admin', p.id, k.id);
    expect((await raw.apiKey.findUniqueOrThrow({ where: { id: k.id } })).revokedAt).not.toBeNull();
    expect(await raw.auditLog.count({ where: { tenantId: p.id, action: 'api_key.revoked' } })).toBe(1);
    await expect(ctrl.revokeKey('admin', DEFAULT_TENANT_ID, k.id)).rejects.toMatchObject({ status: 404 });
  });

  it('ProjectScopeGuard: không ?projectId -> giữ tenant JWT; projectId tồn tại -> đổi tenant; lạ -> 404', async () => {
    const guard = new ProjectScopeGuard(svc);
    const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;
    const r1: any = { query: {}, tenantId: DEFAULT_TENANT_ID };
    await guard.canActivate(ctx(r1));
    expect(r1.tenantId).toBe(DEFAULT_TENANT_ID);
    const r2: any = { query: { projectId: created[0] }, tenantId: DEFAULT_TENANT_ID };
    await guard.canActivate(ctx(r2));
    expect(r2.tenantId).toBe(created[0]);
    await expect(guard.canActivate(ctx({ query: { projectId: randomUUID() }, tenantId: DEFAULT_TENANT_ID }))).rejects.toMatchObject({ status: 404 });
    await expect(guard.canActivate(ctx({ query: { projectId: 'abc' }, tenantId: DEFAULT_TENANT_ID }))).rejects.toMatchObject({ status: 404 });
  });
});
