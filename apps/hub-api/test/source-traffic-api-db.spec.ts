import { randomUUID } from 'crypto';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { ProjectScopeGuard } from '../src/modules/console/project-scope.guard';
import { TrafficController } from '../src/modules/traffic/traffic.controller';
import { getSourceTraffic } from '../src/modules/traffic/traffic-api';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * EG5 (SPEC-chong-qua-tai §6, ADR-181) trên Postgres THẬT, code chạy bằng `hub_app` (RLS bật): quyền `traffic:read`
 * (owner + operator, không developer/viewer) và phạm vi project của `GET …/sources/:id/traffic`.
 */
describeDb('EG5 API lưu lượng (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const [A, B] = [randomUUID(), randomUUID()];
  const users: Record<'own' | 'dev' | 'view' | 'op' | 'outsider', string> = { own: '', dev: '', view: '', op: '', outsider: '' };
  let srcA = '';
  const principal = (id: string, isOperator = false) => ({ kind: 'user', id, sessionId: randomUUID(), email: `${id}@t.vn`, name: 'T', isOperator, emailVerified: true });

  beforeAll(async () => {
    for (const id of [A, B]) await owner.project.create({ data: { id, slug: `eg5-${run}-${id.slice(0, 6)}`, name: `eg5 ${run}` } });
    for (const k of Object.keys(users) as (keyof typeof users)[]) {
      users[k] = (await owner.user.create({ data: { email: `eg5-${k}-${run}@t.vn`, name: k, isOperator: k === 'op' } })).id;
    }
    await owner.projectMember.createMany({
      data: [
        { tenantId: A, userId: users.own, role: 'owner' },
        { tenantId: A, userId: users.dev, role: 'developer' },
        { tenantId: A, userId: users.view, role: 'viewer' },
        { tenantId: B, userId: users.outsider, role: 'owner' },
      ],
    });
    srcA = (await owner.source.create({ data: { tenantId: A, provider: 'github', name: `eg5-${run}`, sourceKey: `eg5-${run}` } })).id;
  }, 60_000);

  afterAll(async () => {
    await owner.auditLog.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.source.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.projectMember.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await owner.project.deleteMany({ where: { id: { in: [A, B] } } });
    await owner.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  it('[EG:T14] developer/viewer 403, owner + operator 200, tenant khác 404 (RLS); 404 do sourceKey lạ không xuất hiện trong dữ liệu của tenant nào', async () => {
    // Dữ liệu: ingest thật (prisma thật, Redis giả) — 3 request ký sai vào source A + 2 request vào sourceKey lạ.
    const redis: any = { checkRateLimit: jest.fn().mockResolvedValue(true), getIdempotencyKey: jest.fn().mockResolvedValue(null), setIdempotencyKey: jest.fn() };
    const ingest = new IngestService(svc, redis);
    const body = JSON.stringify({ zen: 'x' });
    const hit = (sourceKey: string, ip: string) =>
      ingest.ingestWebhook({ provider: 'github', sourceKey, ip, headers: { 'x-hub-signature-256': 'sha256=00', 'x-github-delivery': randomUUID(), 'x-github-event': 'ping' }, rawBody: Buffer.from(body), body: JSON.parse(body), contentType: 'application/json' });
    for (let i = 0; i < 3; i++) expect((await hit(`eg5-${run}`, '203.0.113.7')).status).toBe(401);
    for (let i = 0; i < 2; i++) expect((await hit(`khong-co-${run}`, '198.51.100.66')).status).toBe(404);
    await ingest.traffic.flush();
    const rows = await owner.sourceTrafficMinutely.findMany({ where: { sourceId: srcA } });
    expect(rows.map((r) => [r.tenantId, r.outcome, r.count])).toEqual([[A, 'REJECTED', 3]]);
    // sourceKey lạ: không thuộc tenant nào -> không có dòng nào mang IP của nó, ở BẤT KỲ tenant nào
    expect(await owner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM hub.source_traffic_minutely t, jsonb_array_elements(t.top_ips) e WHERE e->>'ip' = '198.51.100.66'`).toEqual([{ n: 0 }]);

    const guard = new ProjectScopeGuard(svc);
    const ctx = (r: any) => ({ switchToHttp: () => ({ getRequest: () => r }), getHandler: () => TrafficController.prototype.get, getClass: () => TrafficController }) as any;
    const enter = (p: any, projectId: string) => guard.canActivate(ctx({ principal: p, params: { projectId, sourceId: srcA }, query: {}, method: 'GET', path: '/x' }));

    for (const k of ['dev', 'view'] as const) {
      await expect(enter(principal(users[k]), A)).rejects.toMatchObject({ status: 403, response: { error: 'missing_scope', required: 'traffic:read' } });
    }
    await expect(enter(principal(users.own), A)).resolves.toBe(true);
    await expect(enter(principal(users.op, true), A)).resolves.toBe(true); // operator không là thành viên = owner (viaOperator)
    await expect(enter(principal(users.outsider), A)).rejects.toMatchObject({ status: 404 }); // không phải thành viên A

    const now = new Date();
    const res = await getSourceTraffic(svc, A, srcA, { range: '1h' }, () => [{ ip: '203.0.113.7', remainingSec: 420 }], now);
    expect(res.buckets).toHaveLength(60);
    expect(res.buckets.reduce((s, b) => s + b.REJECTED, 0)).toBe(3);
    expect(res.topIps).toEqual([{ ip: '203.0.113.7', count: 3, rejected: 3, lastSeen: expect.any(String) }]);
    expect(res.insight).toMatchObject({ code: 'I-traffic', facts: { total: 3, rejected: 3, state: 'normal' } }); // < 20 request: chưa kết luận
    expect(res.blockedNow).toEqual([{ ip: '203.0.113.7', remainingSec: 420 }]);
    // owner của B gọi với source của A dưới project B -> 404 (RLS + forTenant), không lộ dữ liệu
    await expect(getSourceTraffic(svc, B, srcA, { range: '1h' }, () => [])).rejects.toMatchObject({ status: 404 });
    await expect(getSourceTraffic(svc, A, srcA, { range: '2h' }, () => [])).rejects.toMatchObject({ status: 400 });
    // 24h / 7d gộp cột 5 phút / 1 giờ
    expect((await getSourceTraffic(svc, A, srcA, { range: '24h' }, () => [], now)).buckets).toHaveLength(288);
    expect((await getSourceTraffic(svc, A, srcA, { range: '7d' }, () => [], now)).buckets).toHaveLength(168);
  });
});
