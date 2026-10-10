import { randomUUID } from 'crypto';
import { IdentityRepository } from '../src/identity.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/** SPEC-auth §5.1: mỗi hàm của IdentityRepository có test — phần chưa được auth-session-db / console-projects-db phủ. */
describeDb('IdentityRepository (Postgres)', () => {
  const db = newTestPrisma('app');
  const idn = new IdentityRepository(db);
  const run = randomUUID().slice(0, 8);
  const users: string[] = [];
  const projects: string[] = [];
  const now = new Date();
  const later = new Date(now.getTime() + 86400_000);

  afterAll(async () => {
    await db.authAudit.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.project.deleteMany({ where: { id: { in: projects } } });
    await db.$disconnect();
  });

  it('ensureOperator: tạo nếu chưa có; lần sau KHÔNG ghi đè mật khẩu, chỉ bảo đảm isOperator + đã xác minh', async () => {
    const email = `op-${run}@t.vn`;
    const a = await idn.ensureOperator({ email, name: 'Op', passwordHash: 'hash-1' });
    users.push(a.id);
    expect(a).toMatchObject({ isOperator: true, passwordHash: 'hash-1' });
    expect(a.emailVerifiedAt).not.toBeNull();
    const b = await idn.ensureOperator({ email, name: 'Op', passwordHash: 'hash-2' });
    expect(b.id).toBe(a.id);
    expect((await idn.findUserByEmail(email))?.passwordHash).toBe('hash-1');
  });

  it('isProjectSlugTaken + ensureMembership idempotent (giữ role cũ) + listMemberships + findMembershipRole', async () => {
    const u = await idn.createUser({ email: `m-${run}@t.vn`, name: 'M', passwordHash: null });
    users.push(u.id);
    const pid = randomUUID();
    projects.push(pid);
    await idn.createProject({ id: pid, slug: `slug-${run}`, name: 'P', environment: 'test' });
    expect(await idn.isProjectSlugTaken(`slug-${run}`)).toBe(true);
    expect(await idn.isProjectSlugTaken(`khong-co-${run}`)).toBe(false);
    await idn.ensureMembership(u.id, pid, 'developer');
    await idn.ensureMembership(u.id, pid, 'owner');
    expect(await idn.findMembershipRole(u.id, pid)).toBe('developer');
    expect(await idn.listMemberships(u.id)).toEqual([{ projectId: pid, slug: `slug-${run}`, name: 'P', environment: 'test', role: 'developer' }]);
    expect(await idn.findMembershipRole(u.id, randomUUID())).toBeNull();
  });

  it('listLiveSessions (dòng mới nhất mỗi family) · revokeOwnFamily chỉ của chính mình · findSessionById · listAuthAudit', async () => {
    const u = await idn.createUser({ email: `s-${run}@t.vn`, name: 'S', passwordHash: null });
    const other = await idn.createUser({ email: `o-${run}@t.vn`, name: 'O', passwordHash: null });
    users.push(u.id, other.id);
    const fam = randomUUID();
    const s1 = await idn.createSession({ userId: u.id, familyId: fam, tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), idleExpiresAt: later, absoluteExpiresAt: later });
    const s2 = await idn.createSession({ userId: u.id, familyId: fam, tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '1'), idleExpiresAt: later, absoluteExpiresAt: later });
    await idn.markRotated(s1.id, s2.id, now);
    expect((await idn.listLiveSessions(u.id, now)).map((r) => r.id)).toEqual([s2.id]);
    expect(await idn.findSessionById(s1.id)).toMatchObject({ familyId: fam, userId: u.id });
    expect(await idn.revokeOwnFamily(other.id, s2.id, 'logout', now)).toBe(0);
    expect(await idn.revokeOwnFamily(u.id, s1.id, 'logout', now)).toBe(2);
    expect(await idn.findLiveSessionWithUser(s2.id, now)).toBeNull();
    await idn.recordAuthAudit({ userId: u.id, action: 'test.a', meta: { x: 1 } });
    expect((await idn.listAuthAudit(u.id)).map((a) => a.action)).toEqual(['test.a']);
  });
});
