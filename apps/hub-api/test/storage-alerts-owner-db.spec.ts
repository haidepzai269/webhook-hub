import { randomUUID } from 'crypto';
import { ownerVisibleRules } from '@hub/common';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { alertSummaryFor, listAlertsFor } from '../src/modules/alerts/alerts-api';

/**
 * QT6 (SPEC-han-muc-dung-luong E3, ADR-190) trên Postgres THẬT (`hub_app`, RLS bật): escape hatch có tên
 * `ownerAlertsAcrossTenants` / `ownerAlertSummaryAcrossTenants` chỉ trả cảnh báo `project.storage_*` của project mà
 * CHÍNH user là owner — không luật CB, không project chỉ là developer, không project người khác.
 */
describeDb('QT6 cảnh báo dung lượng cho owner (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const A: string = randomUUID();
  const B: string = randomUUID();
  const C: string = randomUUID();
  const run = randomUUID().slice(0, 8);
  const users: string[] = [];
  let u = '';

  beforeAll(async () => {
    for (const [id, slug] of [[A, `qt6-a-${run}`], [B, `qt6-b-${run}`], [C, `qt6-c-${run}`]]) await owner.project.create({ data: { id, slug, name: slug } });
    u = (await owner.user.create({ data: { email: `qt6-own-${run}@t.vn`, name: 'Own' } })).id;
    users.push(u);
    await owner.projectMember.create({ data: { tenantId: A, userId: u, role: 'owner' } });
    await owner.projectMember.create({ data: { tenantId: B, userId: u, role: 'developer' } });
    const at = new Date('2092-01-01T00:00:00Z');
    const mk = (tenantId: string, rule: string, severity: 'critical' | 'warning') =>
      owner.alert.create({ data: { tenantId, rule, severity, subjectType: 'project', subjectId: tenantId, openedAt: at, lastSeenAt: at, facts: { level: 'LOCKED' } } });
    await mk(A, 'project.storage_locked', 'critical');
    await mk(A, 'delivery.dead_spike', 'critical'); // luật CB — owner không thấy
    await mk(B, 'project.storage_warn', 'warning'); // chỉ là developer ở B
    await mk(C, 'project.storage_critical', 'critical'); // không phải thành viên C
  }, 60_000);

  afterAll(async () => {
    await owner.alert.deleteMany({ where: { tenantId: { in: [A, B, C] } } });
    await owner.projectMember.deleteMany({ where: { userId: { in: users } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: { in: [A, B, C] } } });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  it('[QT:T34] (phần d) owner chỉ thấy project.storage_* của project mình là owner — danh sách + tóm tắt chuông', async () => {
    const rows = await svc.ownerAlertsAcrossTenants(u, ownerVisibleRules(), { dir: 'older', limit: 50 });
    expect(rows.map((r) => `${r.tenantId}:${r.rule}`)).toEqual([`${A}:project.storage_locked`]);
    const page = await listAlertsFor(svc, { userId: u, isOperator: false }, {});
    expect(page.items.filter((x) => [A, B, C].includes(x.project.id)).map((x) => x.rule)).toEqual(['project.storage_locked']);
    const sum = await alertSummaryFor(svc, { userId: u, isOperator: false });
    expect(sum.perProject.map((p) => p.project.id)).toEqual([A]);
    expect(sum.openBySeverity).toEqual({ critical: 1, warning: 0, info: 0 });
  });
});
