import { randomUUID } from 'crypto';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { ProjectsController } from '../src/modules/console/projects.controller';

/**
 * ADR-235 trên Postgres THẬT (`hub_app`, RLS bật): escape hatch `memberProjectStatsAcrossTenants(userId)` chỉ trả số đếm
 * của project mà CHÍNH user là thành viên (JOIN project_members), đếm đúng từng chỉ số, và không bao giờ lộ project người
 * khác — kể cả khi project đó có đủ mọi loại dữ liệu. Fixture dựng bằng owner; code được test chạy bằng `hub_app`.
 */
describeDb('ADR-235 số đếm thẻ "Tất cả dự án" (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const [A, B, C]: string[] = [randomUUID(), randomUUID(), randomUUID()];
  const projects: string[] = [A, B, C];
  const users: string[] = [];
  let u = '';
  let v = '';
  let seq = 0;

  const source = (tenantId: string, archived = false) =>
    owner.source.create({
      data: { tenantId, provider: 'github', name: `ps-${run}-${++seq}`, sourceKey: `ps-${run}-${++seq}`, ...(archived ? { isActive: false, archivedAt: new Date() } : {}) },
    });

  async function flow(tenantId: string, o: { circuit?: 'OPEN' | 'HALF_OPEN'; archived?: boolean } = {}) {
    const dest = await owner.destination.create({
      data: {
        tenantId,
        name: `ps-${run}-${++seq}`,
        type: 'webhook',
        configEncrypted: 'x',
        ...(o.circuit ? { circuitState: o.circuit } : {}),
        ...(o.archived ? { isActive: false, archivedAt: new Date() } : {}),
      },
    });
    const sub = await owner.subscription.create({ data: { tenantId, destinationId: dest.id, name: `ps-${run}-${seq}`, eventTypes: ['t.ps'] } });
    return sub.id;
  }

  const event = (tenantId: string, agoMs = 0) =>
    owner.event.create({
      data: {
        id: `PS${run}${++seq}`.slice(0, 36),
        tenantId,
        idempotencyKey: `ps:${run}:${seq}`,
        correlationId: randomUUID(),
        type: 't.ps',
        source: 'test',
        data: {},
        receivedAt: new Date(Date.now() - agoMs),
      },
    });

  async function delivery(tenantId: string, subId: string, o: { status: 'DEAD' | 'SUCCEEDED'; http?: (number | null)[]; attemptAgoMs?: number; eventId?: string; generation?: number }) {
    const eventId = o.eventId ?? (await event(tenantId)).id;
    const d = await owner.delivery.create({ data: { tenantId, eventId, subscriptionId: subId, attemptGeneration: o.generation ?? 1, status: o.status, attemptCount: 1 } });
    let n = 0;
    for (const status of o.http ?? []) {
      await owner.deliveryAttempt.create({
        data: { deliveryId: d.id, attemptNo: ++n, responseStatus: status, error: status === null ? 'ECONNREFUSED' : null, createdAt: new Date(Date.now() - (o.attemptAgoMs ?? 60_000)) },
      });
    }
    return { eventId };
  }

  beforeAll(async () => {
    for (const id of projects) await owner.project.create({ data: { id, slug: `ps-${run}-${id.slice(0, 6)}`, name: `ps ${run}` } });
    u = (await owner.user.create({ data: { email: `ps-u-${run}@t.vn`, name: 'U' } })).id;
    v = (await owner.user.create({ data: { email: `ps-v-${run}@t.vn`, name: 'V' } })).id;
    users.push(u, v);
    await owner.projectMember.create({ data: { tenantId: A, userId: u, role: 'owner' } });
    await owner.projectMember.create({ data: { tenantId: A, userId: v, role: 'developer' } });
    await owner.projectMember.create({ data: { tenantId: B, userId: u, role: 'viewer' } });
    await owner.projectMember.create({ data: { tenantId: C, userId: v, role: 'owner' } }); // u KHÔNG là thành viên C

    // A: 2 source còn dùng + 1 lưu trữ; 2 đích còn dùng (1 circuit OPEN) + 1 lưu trữ (circuit OPEN nhưng không tính)
    await source(A);
    await source(A);
    await source(A, true);
    const aOk = await flow(A);
    const aOpen = await flow(A, { circuit: 'OPEN' });
    await flow(A, { circuit: 'OPEN', archived: true });
    await event(A, 2 * 86_400_000); // ngoài cửa sổ 24h
    await delivery(A, aOk, { status: 'SUCCEEDED', http: [500, 200] }); // 1 lần gửi lỗi trong 24h
    await delivery(A, aOpen, { status: 'DEAD', http: [null, 404] }); // DLQ + 2 lỗi (mất kết nối, 404)
    await delivery(A, aOpen, { status: 'DEAD', http: [503], attemptAgoMs: 2 * 86_400_000 }); // DLQ, lỗi cũ không tính
    const replayed = await delivery(A, aOpen, { status: 'DEAD' });
    await delivery(A, aOpen, { status: 'SUCCEEDED', eventId: replayed.eventId, generation: 2 }); // đã replay -> rời DLQ
    // A: nấc dung lượng + cảnh báo
    await owner.$executeRaw`INSERT INTO hub.project_usage (tenant_id, level) VALUES (${A}::uuid, 'LOCKED') ON CONFLICT (tenant_id) DO UPDATE SET level = 'LOCKED'`;
    const at = new Date();
    const alert = (tenantId: string, severity: 'critical' | 'warning' | 'info', state: 'OPEN' | 'RESOLVED' = 'OPEN') =>
      owner.alert.create({ data: { tenantId, rule: `t.ps.${++seq}`, severity, subjectType: 'project', subjectId: tenantId, state, openedAt: at, lastSeenAt: at } });
    await alert(A, 'critical');
    await alert(A, 'info');
    await alert(A, 'warning', 'RESOLVED');

    // C (của người khác): đủ mọi thứ — không bao giờ được lộ sang u
    await source(C);
    const cSub = await flow(C, { circuit: 'OPEN' });
    for (let i = 0; i < 3; i++) await delivery(C, cSub, { status: 'DEAD', http: [500] });
    await alert(C, 'critical');
  }, 120_000);

  afterAll(async () => {
    await owner.alert.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.delivery.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.event.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.subscription.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.destination.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.source.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.projectMember.deleteMany({ where: { userId: { in: users } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: { in: projects } } }); // cascade project_usage
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  it('u chỉ thấy A và B (thành viên), không thấy C; số đếm của A đúng từng chỉ số', async () => {
    const rows = (await svc.memberProjectStatsAcrossTenants(u)).filter((r) => projects.includes(r.tenantId));
    expect(rows.map((r) => r.tenantId).sort()).toEqual([A, B].sort());
    const a = rows.find((r) => r.tenantId === A)!;
    expect(a).toMatchObject({
      sources: 2,
      endpoints: 2,
      members: 2,
      events24h: 4, // 4 event mới (bản replay dùng lại event cũ); event nhận 2 ngày trước không tính
      failedAttempts24h: 3, // 500, null(mất kết nối), 404 — 503 cũ 2 ngày không tính; 200 không tính
      dlq: 2, // DEAD chưa replay; bản DEAD đã có generation 2 rời DLQ
      circuitOpen: 1, // đích lưu trữ không tính
      storageLevel: 'LOCKED',
      openAlerts: { critical: 1, warning: 0, info: 1 },
    });
    expect(a.createdAt).toBeInstanceOf(Date);
    const b = rows.find((r) => r.tenantId === B)!;
    expect(b).toMatchObject({ sources: 0, endpoints: 0, members: 1, events24h: 0, failedAttempts24h: 0, dlq: 0, circuitOpen: 0, openAlerts: { critical: 0, warning: 0, info: 0 } });
  });

  it('v (thành viên A + C) thấy số của C; u không bao giờ thấy — kể cả qua controller include=stats', async () => {
    const vRows = (await svc.memberProjectStatsAcrossTenants(v)).filter((r) => projects.includes(r.tenantId));
    expect(vRows.map((r) => r.tenantId).sort()).toEqual([A, C].sort());
    expect(vRows.find((r) => r.tenantId === C)).toMatchObject({ dlq: 3, circuitOpen: 1, failedAttempts24h: 3 });

    const out: any[] = await new ProjectsController(svc).list({ principal: { kind: 'user', id: u, isOperator: false } } as any, 'stats');
    const ids = out.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([A, B]));
    expect(ids).not.toContain(C);
    expect(out.find((p) => p.id === A).stats).toMatchObject({ dlq: 2, storageLevel: 'LOCKED' });
  });

  it('user không là thành viên dự án nào -> rỗng', async () => {
    expect(await svc.memberProjectStatsAcrossTenants(randomUUID())).toEqual([]);
  });
});
