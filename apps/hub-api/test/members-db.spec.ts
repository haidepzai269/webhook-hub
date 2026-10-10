import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { MailMessage, MailSender } from '@hub/common';
import { PrismaService } from '@hub/database';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { MembersService } from '../src/modules/auth/members.service';
import { parseCreateKey } from '../src/modules/console/projects.controller';

/** SPEC-auth §5.11 (AU4) trên Postgres THẬT: lời mời qua email, thành viên, quy tắc owner cuối cùng. */
describeDb('Thành viên + lời mời (Postgres, AU4)', () => {
  const raw = newTestPrisma('owner');
  const svc = new PrismaService();
  const sent: MailMessage[] = [];
  const mail: MailSender = { send: async (m) => void sent.push(m) };
  const members = new MembersService(svc, mail, { webPublicUrl: 'http://web.test' } as any);
  const run = randomUUID().slice(0, 8);
  const projectId = randomUUID();
  const users: Record<string, any> = {};
  const ctx = { ip: '10.4.4.4', userAgent: 'jest' };

  const principal = (u: any, over: Record<string, unknown> = {}) => ({
    kind: 'user', id: u.id, sessionId: randomUUID(), email: u.email, name: u.name, isOperator: false, emailVerified: !!u.emailVerifiedAt,
    tenantId: projectId, ...over,
  }) as any;
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      if (e instanceof HttpException) return `${e.getStatus()} ${(e.getResponse() as any).error}`;
      throw e;
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const lastToken = (to: string) => /token=([A-Za-z0-9_-]+)/.exec([...sent].reverse().find((m) => m.to === to)!.text)![1];

  beforeAll(async () => {
    await raw.project.create({ data: { id: projectId, slug: `mem-${run}`, name: `Mem ${run}` } });
    for (const [k, verified] of [['owner', true], ['dev', true], ['viewer', true], ['newbie', false], ['other', true]] as const) {
      users[k] = await raw.user.create({ data: { email: `${k}-${run}@mem.test`, name: k, emailVerifiedAt: verified ? new Date() : null } });
    }
    await raw.projectMember.createMany({
      data: [
        { tenantId: projectId, userId: users.owner.id, role: 'owner' },
        { tenantId: projectId, userId: users.dev.id, role: 'developer' },
      ],
    });
  });

  afterAll(async () => {
    await raw.emailToken.deleteMany({ where: { tenantId: projectId } });
    await raw.auditLog.deleteMany({ where: { tenantId: projectId } });
    await raw.project.delete({ where: { id: projectId } });
    await raw.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    await raw.$disconnect();
    await svc.$disconnect();
  });

  it('mời viewer: 201 + mail link /invite; đã là thành viên -> 409 already_member; người mời chưa xác minh -> 403 email_not_verified; audit member.invited', async () => {
    const owner = principal(users.owner);
    const inv = await members.invite(owner, projectId, { email: users.viewer.email.toUpperCase(), role: 'viewer' }, ctx);
    await settle();
    expect(inv).toMatchObject({ email: users.viewer.email, role: 'viewer' });
    expect([...sent].reverse().find((m) => m.to === users.viewer.email)!.text).toContain('http://web.test/invite?token=');
    expect(await status(members.invite(owner, projectId, { email: users.dev.email, role: 'viewer' }, ctx))).toBe('409 already_member');
    expect(await status(members.invite(principal(users.owner, { emailVerified: false }), projectId, { email: 'x@y.vn', role: 'viewer' }, ctx))).toBe('403 email_not_verified');
    expect(await raw.auditLog.count({ where: { tenantId: projectId, action: 'member.invited' } })).toBe(1);
    expect((await members.listInvitations(projectId)).map((i: any) => i.email)).toContain(users.viewer.email);
  });

  it('[AU:UA26] accept khi đang đăng nhập bằng email KHÁC -> 403 invite_email_mismatch, token KHÔNG bị đốt', async () => {
    const token = lastToken(users.viewer.email);
    expect(await status(members.acceptInvitation(principal(users.other), { token }, ctx))).toBe('403 invite_email_mismatch');
    expect(await raw.projectMember.count({ where: { tenantId: projectId, userId: users.other.id } })).toBe(0);
    expect(await status(members.acceptInvitation(principal(users.viewer), { token }, ctx))).toBe('ok');
    expect(await raw.projectMember.findUnique({ where: { tenantId_userId: { tenantId: projectId, userId: users.viewer.id } } })).toMatchObject({ role: 'viewer' });
    expect(await status(members.acceptInvitation(principal(users.viewer), { token }, ctx))).toBe('400 token_invalid');
    expect(await raw.auditLog.count({ where: { tenantId: projectId, action: 'member.joined' } })).toBe(1);
  });

  it('[AU:UA27] accept bởi user CHƯA xác minh, email trùng -> membership tạo + emailVerifiedAt được đặt', async () => {
    await members.invite(principal(users.owner), projectId, { email: users.newbie.email, role: 'developer' }, ctx);
    await settle();
    const r = await members.acceptInvitation(principal(users.newbie), { token: lastToken(users.newbie.email) }, ctx);
    expect(r.membership).toMatchObject({ projectId, role: 'developer' });
    expect((await raw.user.findUniqueOrThrow({ where: { id: users.newbie.id } })).emailVerifiedAt).not.toBeNull();
  });

  it('mời role owner: chỉ owner (developer không có manage:members nên vốn bị guard chặn); thu hồi lời mời -> 204 + audit, token chết', async () => {
    const inv = await members.invite(principal(users.owner), projectId, { email: `moi-owner-${run}@mem.test`, role: 'owner' }, ctx);
    await settle();
    const token = lastToken(`moi-owner-${run}@mem.test`);
    await members.revokeInvitation(principal(users.owner), projectId, inv.id, ctx);
    expect(await raw.auditLog.count({ where: { tenantId: projectId, action: 'invitation.revoked' } })).toBe(1);
    expect(await status(members.revokeInvitation(principal(users.owner), projectId, randomUUID(), ctx))).toBe('404 not_found');
    const stranger = await raw.user.create({ data: { email: `moi-owner-${run}@mem.test`, name: 's', emailVerifiedAt: new Date() } });
    users.stranger = stranger;
    expect(await status(members.acceptInvitation(principal(stranger), { token }, ctx))).toBe('400 token_invalid');
  });

  it('[AU:UA18] last_owner: xoá / hạ quyền / tự rời của owner CUỐI -> 409; có owner thứ hai thì được; chỉ owner gán được role owner', async () => {
    const owner = principal(users.owner, { scopes: ['manage:members'] });
    expect(await status(members.changeRole(owner, projectId, users.owner.id, { role: 'developer' }, ctx))).toBe('409 last_owner');
    expect(await status(members.removeMember(owner, projectId, users.owner.id, ctx))).toBe('409 last_owner');
    const devAsOwnerAttempt = principal(users.dev, { scopes: ['manage:members'] }); // giả sử role tuỳ biến có manage:members nhưng không phải owner
    expect(await status(members.changeRole(devAsOwnerAttempt, projectId, users.dev.id, { role: 'owner' }, ctx))).toBe('403 owner_required');
    expect(await status(members.changeRole(owner, projectId, users.dev.id, { role: 'owner' }, ctx))).toBe('ok');
    expect(await status(members.changeRole(owner, projectId, users.owner.id, { role: 'developer' }, ctx))).toBe('ok');
    const dev = principal(users.dev, { scopes: ['manage:members'] });
    expect(await status(members.removeMember(dev, projectId, users.dev.id, ctx))).toBe('409 last_owner'); // tự rời khi là owner duy nhất
    expect(await raw.auditLog.count({ where: { tenantId: projectId, action: 'member.role_changed' } })).toBe(2);
    expect(await status(members.removeMember(dev, projectId, users.viewer.id, ctx))).toBe('ok');
    expect(await raw.auditLog.count({ where: { tenantId: projectId, action: 'member.removed' } })).toBe(1);
    const list = await members.listMembers(projectId);
    expect(list.map((m: any) => [m.email, m.role]).sort()).toEqual(
      [[users.dev.email, 'owner'], [users.newbie.email, 'developer'], [users.owner.email, 'developer']].sort(),
    );
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|password_hash/);
  });

  it('thành viên không phải owner không tự rời được bằng route của người khác (không có manage:members) -> 403; tự rời chính mình -> được', async () => {
    const newbie = principal(users.newbie, { scopes: ['read:project'] });
    expect(await status(members.removeMember(newbie, projectId, users.owner.id, ctx))).toBe('403 missing_scope');
    expect(await status(members.removeMember(newbie, projectId, users.newbie.id, ctx))).toBe('ok');
  });

  it('[AR:R-13] (phần c) lời mời mất hiệu lực khi người mời bị hạ quyền trước lúc nhận -> 400 token_invalid (token không bị đốt); người còn quyền mời lại -> nhận được', async () => {
    const dev = principal(users.dev, { scopes: ['manage:members'] }); // dev đang là owner (test UA18)
    expect(await status(members.changeRole(dev, projectId, users.owner.id, { role: 'owner' }, ctx))).toBe('ok');
    const exOwner = principal(users.owner, { scopes: ['manage:members'] });
    expect(await status(members.invite(exOwner, projectId, { email: users.other.email, role: 'viewer' }, ctx))).toBe('ok');
    await settle();
    const token = lastToken(users.other.email);
    expect(await status(members.changeRole(dev, projectId, users.owner.id, { role: 'viewer' }, ctx))).toBe('ok');
    expect(await status(members.acceptInvitation(principal(users.other), { token }, ctx))).toBe('400 token_invalid');
    expect(await raw.projectMember.count({ where: { tenantId: projectId, userId: users.other.id } })).toBe(0);
    expect(await status(members.invite(dev, projectId, { email: users.other.email, role: 'viewer' }, ctx))).toBe('ok');
    await settle();
    expect(await status(members.acceptInvitation(principal(users.other), { token: lastToken(users.other.email) }, ctx))).toBe('ok');
  });
});

describe('[AU:UA19] tạo API key xin scope không được cấp cho máy -> 422 scope_not_grantable', () => {
  it('manage:keys / manage:members / manage:project / read:project / replay:deliveries -> scope_not_grantable; scope lạ -> validation_failed', () => {
    for (const s of ['manage:keys', 'manage:members', 'manage:project', 'read:project', 'replay:deliveries']) {
      expect(() => parseCreateKey({ serviceName: 'x', scopes: ['read:events', s] })).toThrow(
        expect.objectContaining({ status: 422, response: expect.objectContaining({ error: 'scope_not_grantable' }) }),
      );
    }
    expect(() => parseCreateKey({ serviceName: 'x', scopes: ['xoa:het'] })).toThrow(
      expect.objectContaining({ status: 422, response: expect.objectContaining({ error: 'validation_failed' }) }),
    );
  });
});
