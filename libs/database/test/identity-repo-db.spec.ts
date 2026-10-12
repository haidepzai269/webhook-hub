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

  it('listUserEmailsAfter (ADR-180): keyset theo id tăng dần, đủ lô không trùng không sót, chỉ id + email', async () => {
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await idn.createUser({ email: `bf${i}-${run}@t.vn`, name: 'BF', passwordHash: 'khong-duoc-lo' });
      users.push(u.id);
      mine.push(u.id);
    }
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const rows = await idn.listUserEmailsAfter(after, 2);
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual(['email', 'id']);
        if (after) expect(r.id > after).toBe(true);
        seen.push(r.id);
      }
      if (rows.length < 2) break;
      after = rows[rows.length - 1].id;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(mine));
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

  it('AU2 dọn dẹp: deleteExpiredSessionsBatch(30) / deleteExpiredEmailTokensBatch(7) chỉ xoá dòng hết hạn QUÁ ngưỡng', async () => {
    const u = await idn.createUser({ email: `cl-${run}@t.vn`, name: 'C', passwordHash: null });
    users.push(u.id);
    const day = 86400_000;
    const ago = (d: number) => new Date(Date.now() - d * day);
    const hash = (c: string) => randomUUID().replace(/-/g, '').padEnd(64, c);
    const old = await idn.createSession({ userId: u.id, familyId: randomUUID(), tokenHash: hash('a'), idleExpiresAt: ago(31), absoluteExpiresAt: ago(10) });
    const recent = await idn.createSession({ userId: u.id, familyId: randomUUID(), tokenHash: hash('b'), idleExpiresAt: ago(29), absoluteExpiresAt: ago(29) });
    const email = `cl-${run}@t.vn`;
    const tOld = await idn.createEmailToken({ purpose: 'verify_email', email, userId: u.id, tokenHash: hash('c'), expiresAt: ago(8) });
    const tNew = await idn.createEmailToken({ purpose: 'verify_email', email, userId: u.id, tokenHash: hash('d'), expiresAt: ago(6) });
    await idn.deleteExpiredSessionsBatch(30, 1000);
    await idn.deleteExpiredEmailTokensBatch(7, 1000);
    expect(await db.authSession.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.authSession.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.emailToken.findUnique({ where: { id: tOld.id } })).toBeNull();
    expect(await db.emailToken.findUnique({ where: { id: tNew.id } })).not.toBeNull();
    // invalidateEmailTokens: token chưa dùng của email đó bị đánh dấu dùng; consume sau đó trả null
    expect(await idn.invalidateEmailTokens(email, 'verify_email', new Date())).toBe(1);
    expect(await idn.consumeEmailToken(tNew.tokenHash, 'verify_email', new Date())).toBeNull();
    await db.emailToken.deleteMany({ where: { email } });
  });
});
