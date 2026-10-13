import { Prisma, PrismaClient } from '@prisma/client';
import { DEFAULT_EMAIL_RULES } from '@hub/common';

type Db = PrismaClient | Prisma.TransactionClient;

export type MemberRole = 'owner' | 'developer' | 'viewer';
export type TokenPurpose = 'verify_email' | 'reset_password' | 'invite';

export interface EmailTokenRow {
  id: string;
  purpose: TokenPurpose;
  email: string;
  userId: string | null;
  tenantId: string | null;
  role: MemberRole | null;
  invitedBy: string | null;
  expiresAt: Date;
}

export interface MembershipView {
  projectId: string;
  slug: string;
  name: string;
  environment: 'test' | 'live';
  role: MemberRole;
}

export type UserLocaleCode = 'vi' | 'en';

export interface AlertPreferencesInput {
  emailEnabled?: boolean;
  emailRules?: string[];
  emailOnResolve?: boolean;
  mutedProjects?: string[];
}

export interface AlertEmailRecipient {
  userId: string;
  email: string;
  locale: UserLocaleCode;
  emailRules: string[];
  emailOnResolve: boolean;
  mutedProjects: string[];
}

export interface SessionRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * SPEC-auth §5.1: chỗ DUY NHẤT chạm bảng danh tính (`users`, `project_members`, `auth_sessions`, `email_tokens`,
 * `auth_audit`, và tạo `projects` cho người dùng). Các bảng này được tra TRƯỚC khi biết tenant nên không đi qua
 * `TenantScopedRepository`; mọi truy vấn có tên rõ ràng ở đây (gate BB-5 chặn `prisma.user.` … ở nơi khác).
 * Truyền `tx` để chạy trong transaction của người gọi.
 */
export class IdentityRepository {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- users

  findUserByEmail(email: string) {
    return this.db.user.findUnique({ where: { email } });
  }

  findUserById(id: string) {
    return this.db.user.findUnique({ where: { id } });
  }

  /**
   * Bloom filter email (ADR-180): đọc email theo lô, keyset trên khoá chính `id` (không OFFSET — lô sau không chậm dần).
   * Chỉ trả `id` + `email`, không kéo mật khẩu băm ra khỏi DB.
   */
  listUserEmailsAfter(afterId: string | null, take: number) {
    return this.db.user.findMany({
      where: afterId ? { id: { gt: afterId } } : {},
      orderBy: { id: 'asc' },
      take,
      select: { id: true, email: true },
    });
  }

  createUser(data: { email: string; name: string; passwordHash: string | null; emailVerifiedAt?: Date | null; isOperator?: boolean; githubId?: string | null; googleSub?: string | null }) {
    return this.db.user.create({ data });
  }

  // ---------------------------------------------------------------- GitHub (SPEC-auth §5.10, AU5) — githubId = id SỐ, không login

  findUserByGithubId(githubId: string) {
    return this.db.user.findUnique({ where: { githubId } });
  }

  /** Chỉ liên kết khi user CHƯA có githubId (không đè liên kết cũ). 1 = đã liên kết. */
  async linkGithub(userId: string, githubId: string): Promise<number> {
    const r = await this.db.user.updateMany({ where: { id: userId, githubId: null }, data: { githubId } });
    return r.count;
  }

  /** AU5b (ADR-127): định danh Google = `sub` (ổn định), không phải email. */
  findUserByGoogleSub(googleSub: string) {
    return this.db.user.findUnique({ where: { googleSub } });
  }

  /** Gắn `sub` CHỈ khi user chưa gắn Google nào (0 = đã gắn tài khoản Google khác -> google_account_mismatch). */
  async linkGoogle(userId: string, googleSub: string): Promise<number> {
    const r = await this.db.user.updateMany({ where: { id: userId, googleSub: null }, data: { googleSub } });
    return r.count;
  }

  /**
   * GO-1 (ADR-128): gỡ Google bằng MỘT câu UPDATE có điều kiện "còn cách đăng nhập khác SAU khi gỡ" (mật khẩu hoặc
   * GitHub). Hai lệnh gỡ song song: lệnh sau chờ khoá dòng rồi tính lại WHERE trên bản mới (READ COMMITTED) -> 0 dòng.
   */
  async unlinkGoogle(userId: string): Promise<number> {
    const r = await this.db.user.updateMany({
      where: { id: userId, googleSub: { not: null }, OR: [{ passwordHash: { not: null } }, { githubId: { not: null } }] },
      data: { googleSub: null },
    });
    return r.count;
  }

  /** GO-1 (ADR-128): như `unlinkGoogle` — chỉ gỡ khi còn mật khẩu hoặc Google, trong CÙNG câu UPDATE. */
  async unlinkGithub(userId: string): Promise<number> {
    const r = await this.db.user.updateMany({
      where: { id: userId, githubId: { not: null }, OR: [{ passwordHash: { not: null } }, { googleSub: { not: null } }] },
      data: { githubId: null },
    });
    return r.count;
  }

  /**
   * Seed (SPEC-auth §5.1): operator từ env. Tạo nếu chưa có; đã có thì CHỈ bảo đảm `isOperator` + đã xác minh,
   * KHÔNG ghi đè mật khẩu (operator có thể đã đổi mật khẩu qua API — seed chạy mỗi lần khởi động).
   */
  async ensureOperator(data: { email: string; name: string; passwordHash: string }, now = new Date()) {
    const existing = await this.db.user.findUnique({ where: { email: data.email } });
    if (!existing) {
      return this.db.user.create({ data: { ...data, isOperator: true, emailVerifiedAt: now } });
    }
    if (existing.isOperator && existing.emailVerifiedAt) return existing;
    return this.db.user.update({
      where: { id: existing.id },
      data: { isOperator: true, emailVerifiedAt: existing.emailVerifiedAt ?? now },
    });
  }

  // ---------------------------------------------------------------- projects + membership

  isProjectSlugTaken(slug: string) {
    return this.db.project.findUnique({ where: { slug }, select: { id: true } }).then((p) => !!p);
  }

  createProject(data: { id: string; slug: string; name: string; environment: 'test' | 'live' }) {
    return this.db.project.create({ data });
  }

  /** Idempotent: đã là thành viên thì giữ nguyên role cũ (seed chạy lại vô hại). */
  ensureMembership(userId: string, projectId: string, role: MemberRole) {
    return this.db.projectMember.upsert({
      where: { tenantId_userId: { tenantId: projectId, userId } },
      update: {},
      create: { tenantId: projectId, userId, role },
    });
  }

  async listMemberships(userId: string): Promise<MembershipView[]> {
    const rows = await this.db.projectMember.findMany({
      where: { userId },
      include: { project: { select: { id: true, slug: true, name: true, environment: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ projectId: r.project.id, slug: r.project.slug, name: r.project.name, environment: r.project.environment, role: r.role }));
  }

  /**
   * R-3 (review AU, ADR-112): kiểm lại theo LÔ các socket đang mở — HAI truy vấn cho mọi socket của một instance.
   * Trả session còn sống (kèm userId, isOperator) và các cặp `userId:projectId` còn là thành viên.
   */
  async socketAccess(sessionIds: string[], pairs: { userId: string; projectId: string }[], now: Date) {
    const sessions = sessionIds.length
      ? await this.db.authSession.findMany({
          where: { id: { in: sessionIds }, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
          select: { id: true, userId: true, user: { select: { isOperator: true } } },
        })
      : [];
    const members = pairs.length
      ? await this.db.projectMember.findMany({
          where: { OR: pairs.map((p) => ({ userId: p.userId, tenantId: p.projectId })) },
          select: { userId: true, tenantId: true, role: true },
        })
      : [];
    return {
      live: new Map(sessions.map((s) => [s.id, { userId: s.userId, isOperator: s.user.isOperator }])),
      members: new Set(members.map((m) => `${m.userId}:${m.tenantId}`)),
      // QT6 (E3): cặp còn là OWNER — R-3 cho socket rời room `project:<id>:owners` khi mất vai trò owner.
      owners: new Set(members.filter((m) => m.role === 'owner').map((m) => `${m.userId}:${m.tenantId}`)),
    };
  }

  /**
   * R-14 (ADR-118): đếm project user đang là owner, sau khi khoá theo user trong transaction hiện tại (advisory xact
   * lock) — hai request tạo project song song không vượt trần.
   */
  async lockAndCountOwnedProjects(userId: string): Promise<number> {
    await this.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'project-create:' + userId}, 0))`;
    return this.db.projectMember.count({ where: { userId, role: 'owner' } });
  }

  /**
   * QT6 (§8, E3): owner của project cho email dung lượng — kèm email đã xác minh + công tắc tắt email 70/85
   * (`storage_warn_email`). Developer/viewer không bao giờ có ở đây.
   */
  async listProjectOwnersForStorageEmail(projectId: string): Promise<{ userId: string; emailVerified: boolean; storageWarnEmail: boolean }[]> {
    const rows = await this.db.projectMember.findMany({
      where: { tenantId: projectId, role: 'owner' },
      select: { userId: true, storageWarnEmail: true, user: { select: { emailVerifiedAt: true } } },
    });
    return rows.map((r) => ({ userId: r.userId, emailVerified: !!r.user.emailVerifiedAt, storageWarnEmail: r.storageWarnEmail }));
  }

  /** QT6/QT7: công tắc email dung lượng 70/85 của CHÍNH một thành viên (owner). Trả số dòng ghi (0 = không phải thành viên). */
  async setStorageWarnEmail(projectId: string, userId: string, on: boolean): Promise<number> {
    const r = await this.db.projectMember.updateMany({ where: { tenantId: projectId, userId }, data: { storageWarnEmail: on } });
    return r.count;
  }

  async findStorageWarnEmail(projectId: string, userId: string): Promise<boolean | null> {
    const m = await this.db.projectMember.findUnique({ where: { tenantId_userId: { tenantId: projectId, userId } }, select: { storageWarnEmail: true } });
    return m ? m.storageWarnEmail : null;
  }

  async findMembershipRole(userId: string, projectId: string): Promise<MemberRole | null> {
    const m = await this.db.projectMember.findUnique({ where: { tenantId_userId: { tenantId: projectId, userId } }, select: { role: true } });
    return m?.role ?? null;
  }

  // ---------------------------------------------------------------- thành viên + lời mời (SPEC-auth §5.11, AU4)

  /** Danh sách thành viên kèm email/tên — KHÔNG bao giờ trả hash mật khẩu hay githubId. */
  async listMembers(projectId: string) {
    const rows = await this.db.projectMember.findMany({
      where: { tenantId: projectId },
      include: { user: { select: { id: true, email: true, name: true, emailVerifiedAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ userId: r.user.id, email: r.user.email, name: r.user.name, emailVerified: !!r.user.emailVerifiedAt, role: r.role, createdAt: r.createdAt }));
  }

  /**
   * CHỈ gọi trong transaction: khoá MỌI dòng owner của project (`FOR UPDATE`) để hai thao tác đồng thời (hai owner
   * cùng hạ quyền nhau) không cùng thấy "còn owner khác" rồi để project mồ côi.
   */
  async lockOwners(projectId: string): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ userId: string }[]>`
      SELECT user_id AS "userId" FROM "hub"."project_members"
      WHERE tenant_id = ${projectId}::uuid AND role = 'owner'::"hub"."MemberRole" FOR UPDATE`;
    return rows.map((r) => r.userId);
  }

  async updateMemberRole(projectId: string, userId: string, role: MemberRole): Promise<number> {
    const r = await this.db.projectMember.updateMany({ where: { tenantId: projectId, userId }, data: { role } });
    return r.count;
  }

  async removeMember(projectId: string, userId: string): Promise<number> {
    const r = await this.db.projectMember.deleteMany({ where: { tenantId: projectId, userId } });
    return r.count;
  }

  /** Lời mời còn chờ (chưa dùng, chưa hết hạn) của MỘT project. Không trả token/hash. */
  listPendingInvites(projectId: string, at: Date) {
    return this.db.emailToken.findMany({
      where: { tenantId: projectId, purpose: 'invite', usedAt: null, expiresAt: { gt: at } },
      select: { id: true, email: true, role: true, invitedBy: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Mời lại cùng email vào CÙNG project: lời mời cũ chưa dùng bị vô hiệu (không đụng lời mời project khác). */
  async invalidateProjectInvites(projectId: string, email: string, at: Date): Promise<number> {
    const r = await this.db.emailToken.updateMany({ where: { tenantId: projectId, email, purpose: 'invite', usedAt: null }, data: { usedAt: at } });
    return r.count;
  }

  /** Thu hồi một lời mời CỦA project này (0 = không có / của project khác / đã dùng -> 404). */
  async revokeInvite(projectId: string, inviteId: string, at: Date): Promise<number> {
    const r = await this.db.emailToken.updateMany({ where: { id: inviteId, tenantId: projectId, purpose: 'invite', usedAt: null }, data: { usedAt: at } });
    return r.count;
  }

  /** Lời mời còn hiệu lực theo hash token — KHÔNG đốt (để kiểm email trước khi tiêu token, UA26). */
  peekInvite(tokenHash: string, at: Date) {
    return this.db.emailToken.findFirst({
      where: { tokenHash, purpose: 'invite', usedAt: null, expiresAt: { gt: at } },
      select: { id: true, email: true, tenantId: true, role: true, invitedBy: true },
    });
  }

  // ---------------------------------------------------------------- sessions (SPEC-auth §5.3)

  createSession(data: {
    userId: string;
    familyId: string;
    tokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  }) {
    return this.db.authSession.create({ data });
  }

  /** CHỈ gọi trong transaction: khoá dòng theo hash refresh token (`SELECT … FOR UPDATE`). */
  async lockSessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const rows = await this.db.$queryRaw<SessionRow[]>`
      SELECT id, user_id AS "userId", family_id AS "familyId", token_hash AS "tokenHash",
             rotated_at AS "rotatedAt", revoked_at AS "revokedAt",
             idle_expires_at AS "idleExpiresAt", absolute_expires_at AS "absoluteExpiresAt"
      FROM "hub"."auth_sessions" WHERE token_hash = ${tokenHash} FOR UPDATE`;
    return rows[0] ?? null;
  }

  markRotated(id: string, replacedById: string, at: Date) {
    return this.db.authSession.update({ where: { id }, data: { rotatedAt: at, replacedById } });
  }

  async revokeFamily(familyId: string, reason: string, at: Date): Promise<number> {
    const r = await this.db.authSession.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: at, revokeReason: reason } });
    return r.count;
  }

  /**
   * Thu hồi "một thiết bị" = cả family của session `sessionId`, CHỈ khi session đó thuộc `userId`
   * (0 = không có / của người khác -> 404). Thu hồi cả family vì dòng đã xoay vòng vẫn mang access token còn hạn.
   */
  async revokeOwnFamily(userId: string, sessionId: string, reason: string, at: Date): Promise<number> {
    const s = await this.db.authSession.findFirst({ where: { id: sessionId, userId }, select: { familyId: true } });
    if (!s) return 0;
    return this.revokeFamily(s.familyId, reason, at);
  }

  /** Thu hồi mọi session của user, trừ `exceptId` (đổi mật khẩu giữ phiên hiện tại). */
  async revokeUserSessions(userId: string, reason: string, at: Date, exceptId?: string): Promise<number> {
    const r = await this.db.authSession.updateMany({
      where: { userId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { revokedAt: at, revokeReason: reason },
    });
    return r.count;
  }

  /**
   * SessionGuard: MỘT truy vấn theo khoá chính — session còn sống (chưa thu hồi, chưa hết idle/absolute) kèm user.
   * Dòng đã `rotatedAt` vẫn sống cho tới khi access token của nó hết hạn (≤ 15 phút) — chỉ refresh token cũ bị cấm.
   */
  findLiveSessionWithUser(sessionId: string, now: Date) {
    return this.db.authSession.findFirst({
      where: { id: sessionId, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      include: { user: true },
    });
  }

  /** Thiết bị đang đăng nhập: mỗi family một dòng (dòng mới nhất chưa xoay vòng). */
  listLiveSessions(userId: string, now: Date) {
    return this.db.authSession.findMany({
      where: { userId, revokedAt: null, rotatedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      select: { id: true, familyId: true, userAgent: true, ip: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  findSessionById(id: string) {
    return this.db.authSession.findUnique({ where: { id }, select: { id: true, userId: true, familyId: true, revokedAt: true } });
  }

  // ---------------------------------------------------------------- mật khẩu + xác minh (SPEC-auth §5.2, AU2)

  /**
   * N-1 (review AU vòng 2, ADR-121): người chứng minh được hộp thư nhận tài khoản — xoá mọi thứ do người đặt mật khẩu
   * TRƯỚC đó để lại: tên hiển thị, githubId, lời mời họ gửi còn chờ, mọi token email chờ, mọi phiên. Trả id các project
   * mà user là thành viên DUY NHẤT (người gọi thu hồi key của chúng — key do người nắm tài khoản trước đó tạo).
   */
  async resetClaimedAccount(userId: string, email: string, name: string, reason: string, at: Date): Promise<string[]> {
    await this.db.user.update({ where: { id: userId }, data: { name, githubId: null, googleSub: null } });
    await this.db.emailToken.updateMany({ where: { invitedBy: userId, purpose: 'invite', usedAt: null }, data: { usedAt: at } });
    await this.db.emailToken.updateMany({ where: { email, purpose: { in: ['verify_email', 'reset_password'] }, usedAt: null }, data: { usedAt: at } });
    await this.revokeUserSessions(userId, reason, at);
    const mine = await this.db.projectMember.findMany({ where: { userId }, select: { tenantId: true } });
    const sole: string[] = [];
    for (const { tenantId } of mine) if ((await this.db.projectMember.count({ where: { tenantId } })) === 1) sole.push(tenantId);
    return sole;
  }

  setEmailVerified(userId: string, at: Date) {
    return this.db.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: at } });
  }

  /** `passwordHash = null`: bỏ mật khẩu đang chờ của người đăng ký trước (nhận tài khoản bằng Google, ADR-127). */
  updatePassword(userId: string, passwordHash: string | null, at: Date) {
    return this.db.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: at } });
  }

  // ---------------------------------------------------------------- token trong mail (SPEC-auth §5.9, AU2)

  createEmailToken(data: {
    purpose: TokenPurpose;
    email: string;
    userId?: string | null;
    tenantId?: string | null;
    role?: MemberRole | null;
    invitedBy?: string | null;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return this.db.emailToken.create({ data });
  }

  /** Gửi mail lại cho cùng mục đích: token cũ CHƯA dùng của email đó bị vô hiệu (đánh dấu used). */
  async invalidateEmailTokens(email: string, purpose: TokenPurpose, at: Date): Promise<number> {
    const r = await this.db.emailToken.updateMany({ where: { email, purpose, usedAt: null }, data: { usedAt: at } });
    return r.count;
  }

  /**
   * Dùng token MỘT lần: MỘT câu `UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING` — hai request song
   * song chỉ một dòng được cập nhật (UA14). Sai / hết hạn / đã dùng -> null (người gọi trả CÙNG một lỗi).
   */
  async consumeEmailToken(tokenHash: string, purpose: TokenPurpose, at: Date): Promise<EmailTokenRow | null> {
    const rows = await this.db.$queryRaw<EmailTokenRow[]>`
      UPDATE "hub"."email_tokens" SET used_at = ${at}
      WHERE token_hash = ${tokenHash} AND purpose = ${purpose}::"hub"."TokenPurpose" AND used_at IS NULL AND expires_at > ${at}
      RETURNING id, purpose::text AS purpose, email, user_id AS "userId", tenant_id AS "tenantId", role::text AS role,
                invited_by AS "invitedBy", expires_at AS "expiresAt"`;
    return rows[0] ?? null;
  }

  /** Email của token còn hiệu lực mà KHÔNG đốt (kiểm mật khẩu yếu trước khi tiêu token reset). */
  async peekEmailTokenEmail(tokenHash: string, purpose: TokenPurpose, at: Date): Promise<string | null> {
    const t = await this.db.emailToken.findFirst({ where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: at } }, select: { email: true } });
    return t?.email ?? null;
  }

  // ---------------------------------------------------------------- dọn dẹp (CleanupJob của hub-worker, §5.3)

  /** Xoá MỘT lô session hết hạn (idle hoặc tuyệt đối) quá `olderThanDays` ngày. */
  deleteExpiredSessionsBatch(olderThanDays: number, limit: number): Promise<number> {
    return this.db.$executeRaw`
      DELETE FROM "hub"."auth_sessions" WHERE id IN (
        SELECT id FROM "hub"."auth_sessions"
        WHERE LEAST(idle_expires_at, absolute_expires_at) < now() - make_interval(days => ${olderThanDays}::int)
        LIMIT ${limit})`;
  }

  /** Xoá MỘT lô token mail hết hạn quá `olderThanDays` ngày. */
  deleteExpiredEmailTokensBatch(olderThanDays: number, limit: number): Promise<number> {
    return this.db.$executeRaw`
      DELETE FROM "hub"."email_tokens" WHERE id IN (
        SELECT id FROM "hub"."email_tokens" WHERE expires_at < now() - make_interval(days => ${olderThanDays}::int) LIMIT ${limit})`;
  }

  // ---------------------------------------------------------------- audit cấp user (SPEC-auth §6.2)

  recordAuthAudit(data: { userId?: string | null; action: string; ip?: string | null; meta?: Record<string, unknown> }) {
    return this.db.authAudit.create({
      data: { userId: data.userId ?? null, action: data.action, ip: data.ip ?? null, meta: (data.meta ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  }

  listAuthAudit(userId: string, limit = 50) {
    return this.db.authAudit.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
  }

  // ---------------------------------------------------------------- cảnh báo (CB1, SPEC-canh-bao-nhan-dinh §3.2, ADR-166/166)
  // `alert_preferences` + `users.locale` gắn NGƯỜI DÙNG, không gắn tenant -> ở đây, không qua TenantScopedRepository.

  /** D3: ngôn ngữ console/email của người dùng (nút Ngôn ngữ gọi `PUT /me/locale`). 1 = đã ghi. */
  async setUserLocale(userId: string, locale: UserLocaleCode): Promise<number> {
    const r = await this.db.user.updateMany({ where: { id: userId }, data: { locale } });
    return r.count;
  }

  /** Tuỳ chọn cảnh báo; chưa lưu -> null (service hiểu là mặc định: tắt email). */
  findAlertPreferences(userId: string) {
    return this.db.alertPreference.findUnique({ where: { userId } });
  }

  /**
   * Ghi tuỳ chọn (một câu upsert). Dòng MỚI không truyền `emailRules` nhận `DEFAULT_EMAIL_RULES` (mọi luật critical, §3.2).
   * Kiểm "chỉ operator" là việc của route (403 khuôn lỗi) — repo không đoán quyền.
   * CB4/CB5 (review CB1): route PHẢI kiểm `emailRules` ⊆ `ALERT_RULE_CODES` (@hub/common) và mọi `mutedProjects` là
   * project đang tồn tại TRƯỚC khi gọi hàm này — repo ghi nguyên văn (mảng uuid không có khoá ngoại).
   */
  upsertAlertPreferences(userId: string, data: AlertPreferencesInput) {
    return this.db.alertPreference.upsert({
      where: { userId },
      create: { userId, ...data, emailRules: data.emailRules ?? [...DEFAULT_EMAIL_RULES] },
      update: data,
    });
  }

  /**
   * CB2: id mọi project cho job xuyên project (AlertEvaluator lặp rồi đánh giá TỪNG project qua TenantScopedRepository).
   * `projects` là bảng gốc (id = tenant_id), không mang dữ liệu nghiệp vụ. Thứ tự ổn định (created_at) để log dễ đọc.
   */
  async listProjectIds(): Promise<string[]> {
    const rows = await this.db.project.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => r.id);
  }

  /**
   * Người nhận email cảnh báo (§6): operator, email đã xác minh, đã bật email. Lọc `email_rules`/`muted_projects` theo
   * từng cảnh báo là việc của evaluator (hàm thuần) — ở đây chỉ trả dữ liệu của người dùng.
   */
  async listAlertEmailRecipients(): Promise<AlertEmailRecipient[]> {
    const rows = await this.db.alertPreference.findMany({
      where: { emailEnabled: true, user: { isOperator: true, emailVerifiedAt: { not: null } } },
      include: { user: { select: { email: true, locale: true } } },
    });
    return rows.map((r) => ({
      userId: r.userId,
      email: r.user.email,
      locale: r.user.locale,
      emailRules: r.emailRules,
      emailOnResolve: r.emailOnResolve,
      mutedProjects: r.mutedProjects,
    }));
  }

  /**
   * CB5: giữ một suất có hạn mức đếm trên `auth_audit` (vd "Gửi email thử" 3/giờ/người) — Postgres, không Redis (R1).
   * PHẢI chạy trong transaction của người gọi: khoá dòng `users` của người này (`FOR UPDATE`) để hai request song song
   * không cùng đọc "còn suất", đếm `action` từ `since`, còn suất thì ghi dòng audit ngay. Trả `{ ok, used, oldestAt }`.
   */
  async reserveAuditSlot(p: { userId: string; action: string; since: Date; max: number; ip?: string | null; meta?: Record<string, unknown> }) {
    await this.db.$queryRaw(Prisma.sql`SELECT id FROM hub.users WHERE id = ${p.userId}::uuid FOR UPDATE`);
    const recent = await this.db.authAudit.findMany({
      where: { userId: p.userId, action: p.action, createdAt: { gt: p.since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: p.max,
    });
    if (recent.length >= p.max) return { ok: false as const, used: recent.length, oldestAt: recent[0].createdAt };
    await this.recordAuthAudit({ userId: p.userId, action: p.action, ip: p.ip ?? null, meta: p.meta });
    return { ok: true as const, used: recent.length + 1, oldestAt: recent[0]?.createdAt ?? null };
  }

}
