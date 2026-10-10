import { HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { MemberRole, PrismaService, TenantScopedRepository } from '@hub/database';
import { isMemberRole, isValidEmail, logger, MAIL_SENDER, MailSender, mailTemplates, maskEmail, normalizeEmail } from '@hub/common';
import { AUTH_CONFIG, AuthConfig } from './auth-config';
import { AUTH_CLOCK } from './session.guard';
import { authError } from './auth-errors';
import { newOpaqueToken, sha256Hex } from './tokens';
import { ReqCtx } from './auth.service';
import { UserPrincipal } from '../service-api/principal';

/** Lời mời sống 7 ngày (SPEC-auth §5.9). */
const INVITE_TTL_MS = 7 * 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function http(status: HttpStatus, error: string, message: string): HttpException {
  return new HttpException({ error, message }, status);
}

/**
 * SPEC-auth §5.11 (AU4): mời qua email + quản lý thành viên. Phạm vi project + scope đã được `ProjectScopeGuard`
 * kiểm TRƯỚC (route `/api/v1/projects/:projectId/*`); service chỉ còn các luật riêng:
 *   - người mời phải đã xác minh email (403 email_not_verified); mời/gán role owner chỉ owner (403 owner_required);
 *   - KHÔNG BAO GIỜ để project mất owner cuối cùng (409 last_owner) — khoá các dòng owner bằng `FOR UPDATE`;
 *   - accept: email đăng nhập phải TRÙNG email được mời (403 invite_email_mismatch, token không bị đốt).
 * Mọi thao tác ghi `audit_logs` của project (`member.*`, `invitation.revoked`).
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Optional() @Inject(AUTH_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------ lời mời

  async invite(p: UserPrincipal, projectId: string, body: { email?: unknown; role?: unknown }, ctx: ReqCtx) {
    if (!p.emailVerified) throw http(HttpStatus.FORBIDDEN, 'email_not_verified', 'Xác minh email trước khi mời thành viên');
    const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '');
    if (!isValidEmail(email)) throw new HttpException({ error: 'validation_failed', field: 'email', message: 'Email không hợp lệ' }, HttpStatus.UNPROCESSABLE_ENTITY);
    const role = body?.role;
    if (!isMemberRole(role)) throw new HttpException({ error: 'validation_failed', field: 'role', message: "role là 'owner' | 'developer' | 'viewer'" }, HttpStatus.UNPROCESSABLE_ENTITY);
    if (role === 'owner') await this.assertOwner(p, projectId);

    const idn = this.prisma.identity();
    const existing = await idn.findUserByEmail(email);
    if (existing && (await idn.findMembershipRole(existing.id, projectId))) {
      throw http(HttpStatus.CONFLICT, 'already_member', 'Email này đã là thành viên project');
    }
    const project = await this.prisma.findProjectById(projectId);
    const token = newOpaqueToken();
    const now = this.now();
    const created = await this.prisma.$transaction(async (tx) => {
      const t = this.prisma.identity(tx);
      await t.invalidateProjectInvites(projectId, email, now);
      const row = await t.createEmailToken({
        purpose: 'invite',
        email,
        tenantId: projectId,
        role,
        invitedBy: p.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      });
      await new TenantScopedRepository(tx, projectId).createAuditLog({
        action: 'member.invited',
        entityType: 'invitation',
        entityId: row.id,
        actor: p.id,
        metadata: { email: maskEmail(email), role },
      });
      return row;
    });
    // Mail SAU COMMIT, không chặn response; lỗi chỉ log (người mời có thể mời lại).
    const link = `${this.cfg.webPublicUrl || 'http://localhost:3000'}/invite?token=${token}`;
    void this.mail
      .send({ to: email, ...mailTemplates.invite(link, project?.name ?? '', role, p.name || maskEmail(p.email)) })
      .catch((err) => logger.warn({ err: (err as Error).message, to: maskEmail(email) }, 'Gửi mail mời thất bại'));
    return { id: created.id, email, role, expiresAt: created.expiresAt };
  }

  listInvitations(projectId: string) {
    return this.prisma.identity().listPendingInvites(projectId, this.now());
  }

  async revokeInvitation(p: UserPrincipal, projectId: string, inviteId: string, _ctx: ReqCtx): Promise<void> {
    const n = UUID_RE.test(inviteId) ? await this.prisma.identity().revokeInvite(projectId, inviteId, this.now()) : 0;
    if (n === 0) throw http(HttpStatus.NOT_FOUND, 'not_found', 'Lời mời không tồn tại');
    await this.prisma.forTenant(projectId).createAuditLog({ action: 'invitation.revoked', entityType: 'invitation', entityId: inviteId, actor: p.id });
  }

  /**
   * `POST /auth/invitations/accept {token}`. Kiểm email TRƯỚC khi đốt token (peek): bấm nhầm bằng tài khoản khác
   * không làm mất lời mời. Bấm link trong mail = chứng minh sở hữu email -> đặt emailVerifiedAt nếu chưa có (UA27).
   */
  async acceptInvitation(p: UserPrincipal, body: { token?: unknown }, _ctx: ReqCtx) {
    const raw = typeof body?.token === 'string' ? body.token : '';
    if (!raw || raw.length > 128) throw authError(HttpStatus.BAD_REQUEST, 'token_invalid');
    const hash = sha256Hex(raw);
    const now = this.now();
    const idn = this.prisma.identity();
    const peek = await idn.peekInvite(hash, now);
    if (!peek?.tenantId || !peek.role) throw authError(HttpStatus.BAD_REQUEST, 'token_invalid');
    const me = await idn.findUserById(p.id);
    if (!me) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    if (normalizeEmail(me.email) !== normalizeEmail(peek.email)) {
      throw http(HttpStatus.FORBIDDEN, 'invite_email_mismatch', 'Lời mời gửi cho email khác — đăng nhập đúng tài khoản được mời');
    }
    const projectId = peek.tenantId;
    const role = peek.role as MemberRole;
    await this.prisma.$transaction(async (tx) => {
      const t = this.prisma.identity(tx);
      const used = await t.consumeEmailToken(hash, 'invite', now);
      if (!used) throw authError(HttpStatus.BAD_REQUEST, 'token_invalid');
      await t.ensureMembership(me.id, projectId, role);
      await t.setEmailVerified(me.id, now);
      await new TenantScopedRepository(tx, projectId).createAuditLog({ action: 'member.joined', entityType: 'member', entityId: me.id, actor: me.id, metadata: { role } });
    });
    const project = await this.prisma.findProjectById(projectId);
    const finalRole = await idn.findMembershipRole(me.id, projectId);
    return { membership: { projectId, slug: project?.slug, name: project?.name, role: finalRole } };
  }

  // ------------------------------------------------------------------ thành viên

  listMembers(projectId: string) {
    return this.prisma.identity().listMembers(projectId);
  }

  /** `PATCH …/members/:userId {role}`: chỉ owner gán/thu role owner; không hạ owner cuối. */
  async changeRole(p: UserPrincipal, projectId: string, userId: string, body: { role?: unknown }, _ctx: ReqCtx): Promise<void> {
    const role = body?.role;
    if (!isMemberRole(role)) throw new HttpException({ error: 'validation_failed', field: 'role', message: "role là 'owner' | 'developer' | 'viewer'" }, HttpStatus.UNPROCESSABLE_ENTITY);
    await this.prisma.$transaction(async (tx) => {
      const t = this.prisma.identity(tx);
      const owners = await t.lockOwners(projectId);
      const current = await t.findMembershipRole(userId, projectId);
      if (!current) throw http(HttpStatus.NOT_FOUND, 'not_found', 'Thành viên không tồn tại');
      if ((role === 'owner' || current === 'owner') && !(await this.isOwner(p, projectId, owners))) {
        throw http(HttpStatus.FORBIDDEN, 'owner_required', 'Chỉ owner gán hoặc thu role owner');
      }
      if (current === 'owner' && role !== 'owner' && owners.length <= 1) {
        throw http(HttpStatus.CONFLICT, 'last_owner', 'Không hạ quyền owner cuối cùng của project');
      }
      if (current === role) return;
      await t.updateMemberRole(projectId, userId, role);
      await new TenantScopedRepository(tx, projectId).createAuditLog({
        action: 'member.role_changed',
        entityType: 'member',
        entityId: userId,
        actor: p.id,
        metadata: { from: current, to: role },
      });
    });
  }

  /**
   * `DELETE …/members/:userId`. Xoá người khác cần `manage:members`; TỰ RỜI thì thành viên nào cũng được. Owner cuối
   * (kể cả tự rời) -> 409. Phiên KHÔNG bị thu hồi: request kế tiếp vào project này -> 404 (§5.3).
   */
  async removeMember(p: UserPrincipal, projectId: string, userId: string, _ctx: ReqCtx): Promise<void> {
    const self = userId === p.id;
    if (!self && !(p.scopes ?? []).includes('manage:members')) {
      throw new HttpException({ error: 'missing_scope', message: 'Role hiện tại không có quyền manage:members', required: 'manage:members' }, HttpStatus.FORBIDDEN);
    }
    await this.prisma.$transaction(async (tx) => {
      const t = this.prisma.identity(tx);
      const owners = await t.lockOwners(projectId);
      const current = await t.findMembershipRole(userId, projectId);
      if (!current) throw http(HttpStatus.NOT_FOUND, 'not_found', 'Thành viên không tồn tại');
      if (current === 'owner' && !self && !(await this.isOwner(p, projectId, owners))) {
        throw http(HttpStatus.FORBIDDEN, 'owner_required', 'Chỉ owner xoá được owner khác');
      }
      if (current === 'owner' && owners.length <= 1) throw http(HttpStatus.CONFLICT, 'last_owner', 'Project phải còn ít nhất một owner');
      await t.removeMember(projectId, userId);
      await new TenantScopedRepository(tx, projectId).createAuditLog({
        action: 'member.removed',
        entityType: 'member',
        entityId: userId,
        actor: p.id,
        metadata: { role: current, self },
      });
    });
  }

  private async isOwner(p: UserPrincipal, projectId: string, owners?: string[]): Promise<boolean> {
    if (owners ? owners.includes(p.id) : (await this.prisma.identity().findMembershipRole(p.id, projectId)) === 'owner') return true;
    // Operator không là thành viên = owner (ADR-056); operator là thành viên thì theo role thật.
    return p.isOperator && !(await this.prisma.identity().findMembershipRole(p.id, projectId));
  }

  private async assertOwner(p: UserPrincipal, projectId: string): Promise<void> {
    if (!(await this.isOwner(p, projectId))) throw http(HttpStatus.FORBIDDEN, 'owner_required', 'Chỉ owner mời được role owner');
  }
}
