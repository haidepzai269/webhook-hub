import { randomUUID } from 'crypto';
import { IdentityRepository, PrismaService } from '@hub/database';
import { sendTestAlertEmail, TEST_EMAIL_AUDIT_ACTION } from '../src/modules/alerts/alerts-api';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/** CB5: suất "Gửi email thử" đếm trên auth_audit ở Postgres — 6 request SONG SONG chỉ 3 lọt (khoá dòng users FOR UPDATE). */
describeDb('CB5 gửi email thử (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  let userId = '';

  beforeAll(async () => {
    const u = await new IdentityRepository(owner).createUser({ email: `cb5-test-${randomUUID().slice(0, 8)}@t.vn`, name: 'Op', passwordHash: null, isOperator: true, emailVerifiedAt: new Date() });
    userId = u.id;
  });

  afterAll(async () => {
    await owner.authAudit.deleteMany({ where: { userId } });
    await owner.user.deleteMany({ where: { id: userId } });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  it('6 request song song -> đúng 3 thư, 3 lần 429; 3 dòng auth_audit alert_preferences.test_email', async () => {
    const sent: string[] = [];
    const mail = { send: async (m: { to: string }) => void sent.push(m.to) };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => sendTestAlertEmail(svc as any, mail, userId, '10.0.0.1', 'https://hub.vn')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected').map((r: any) => r.reason.getStatus())).toEqual([429, 429, 429]);
    expect(sent).toHaveLength(3);
    expect(await owner.authAudit.count({ where: { userId, action: TEST_EMAIL_AUDIT_ACTION } })).toBe(3);
  });
});
