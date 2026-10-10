import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'crypto';
import { MembershipView, PrismaService, TenantScopedRepository } from '@hub/database';
import { createMailSender, mailTemplates, isValidEmail, issueCsrfToken, logger, MAIL_SENDER, MailSender, maskEmail, normalizeEmail, passwordProblem, verifyCsrfToken } from '@hub/common';
import { AUTH_CONFIG, AuthConfig } from './auth-config';
import { AUTH_CLOCK } from './session.guard';
import { AuthRateLimiter } from './rate-limit';
import { hashPassword, verifyPassword } from './password-hasher';
import { newOpaqueToken, sha256Hex, signAccessToken } from './tokens';
import { IssuedSession } from './cookies';
import { authError, TooManyAttempts } from './auth-errors';
import { UserPrincipal } from '../service-api/principal';
import { notifyAccessRevoked } from '../realtime/access-revocation';

export interface ReqCtx {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthBody {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  memberships: { projectId: string; slug: string; name: string; environment: 'test' | 'live'; role: string }[];
}

type AuthStore = Pick<PrismaService, 'identity' | '$transaction'>;

/** Token mail (SPEC-auth §5.9): xác minh 24 giờ, đặt lại mật khẩu 1 giờ. */
const VERIFY_TTL_MS = 24 * 3600_000;
const RESET_TTL_MS = 3600_000;

/** Cửa sổ chấp nhận hai tab cùng refresh (SPEC-auth §5.3 bước 4). */
export const REFRESH_RACE_WINDOW_MS = 5_000;

const LIMITS = {
  loginIp: { limit: 20, windowS: 15 * 60 },
  loginEmailFailures: { limit: 5, windowS: 15 * 60 },
  registerIp: { limit: 5, windowS: 60 * 60 },
  refreshIp: { limit: 60, windowS: 60 },
};

/** Bỏ dấu tiếng Việt, kebab — slug project đầu tiên (SPEC-auth §5.8). */
export function slugFromName(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return s.length >= 3 ? s : `project-${s}`.replace(/-+$/, '');
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * SPEC-auth §5.2, §5.3, §5.8: đăng ký, đăng nhập, xoay vòng refresh, đăng xuất, thiết bị.
 * Token chỉ đi ra qua `IssuedSession` (controller đặt cookie), KHÔNG bao giờ nằm trong body.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly store: AuthStore,
    private readonly jwt: JwtService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    private readonly limiter: AuthRateLimiter,
    @Optional() @Inject(AUTH_CLOCK) private readonly now: () => Date = () => new Date(),
    @Optional() @Inject(MAIL_SENDER) private readonly mail: MailSender = createMailSender({ MAIL_DRIVER: 'log' }),
  ) {}


  // ------------------------------------------------------------------ đăng ký (§5.8)

  async register(input: { email?: unknown; password?: unknown; name?: unknown }, ctx: ReqCtx): Promise<{ body: AuthBody; session: IssuedSession | null }> {
    const email = normalizeEmail(typeof input?.email === 'string' ? input.email : '');
    const name = str(input?.name, 100);
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!isValidEmail(email)) throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', { field: 'email', message: 'Email không hợp lệ' });
    if (!name) throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', { field: 'name', message: 'name là chuỗi 1–100 ký tự' });
    const problem = passwordProblem(password, email);
    if (problem) throw authError(HttpStatus.UNPROCESSABLE_ENTITY, problem.error, { field: 'password', message: problem.message });

    await this.limit('registerIp', `rl:reg:ip:${ctx.ip ?? 'unknown'}`, email);

    const passwordHash = await hashPassword(password);
    const existing = await this.store.identity().findUserByEmail(email);
    if (existing) {
      // §5.2: KHÔNG lộ email nào đã có tài khoản — 201 cùng hình dạng, không cookie, không tạo gì.
      // AU2 gửi mail "có người vừa thử đăng ký bằng email của bạn" cho chủ email.
      await this.audit(existing.id, 'user.register_attempt_existing', ctx.ip);
      this.sendLater(existing.email, mailTemplates.registerAttempt(this.webLink('/forgot-password')));
      return { body: this.decoyBody(email, name), session: null };
    }

    const created = await this.createUserWithFirstProject({ email, name, passwordHash, emailVerifiedAt: null }, ctx);
    // §5.8: mail xác minh gửi SAU COMMIT, không chờ gửi xong (giống BB-3: không làm việc ra ngoài trước khi dữ liệu chắc).
    // Gửi lỗi -> log, user bấm "gửi lại"; KHÔNG rollback đăng ký.
    void this.sendVerification(created.userId, email, name).catch((err) =>
      logger.warn({ err: (err as Error).message, to: maskEmail(email) }, 'Gửi mail xác minh thất bại (user có thể gửi lại)'),
    );
    const session = await this.issueSession(created.userId, null, null, ctx);
    return { body: await this.body(created.userId), session };
  }

  /** User + project đầu tiên + membership owner + audit trong MỘT transaction; trùng slug -> thêm hậu tố, thử lại. Dùng chung với GitHub OAuth. */
  async createUserWithFirstProject(
    data: { email: string; name: string; passwordHash: string | null; emailVerifiedAt: Date | null; githubId?: string | null },
    ctx: ReqCtx,
  ): Promise<{ userId: string; projectId: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.store.$transaction(async (tx) => {
          const idn = this.store.identity(tx);
          let slug = slugFromName(data.name);
          if (attempt > 0 || (await idn.isProjectSlugTaken(slug))) slug = `${slug.slice(0, 50)}-${randomBytes(2).toString('hex')}`;
          const user = await idn.createUser(data);
          const projectId = randomUUID();
          await idn.createProject({ id: projectId, slug, name: `${data.name}'s project`.slice(0, 255), environment: 'test' });
          await idn.ensureMembership(user.id, projectId, 'owner');
          await new TenantScopedRepository(tx, projectId).createAuditLog({
            action: 'project.created',
            entityType: 'project',
            entityId: projectId,
            actor: user.id,
            metadata: { slug, via: 'register', by: maskEmail(data.email) },
          });
          await idn.recordAuthAudit({ userId: user.id, action: 'user.registered', ip: ctx.ip });
          return { userId: user.id, projectId };
        });
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e;
        // P2002 trên email = đăng ký đồng thời cùng email: trả hình dạng giống hệt nhánh "đã tồn tại".
        // R-12: trùng email HOẶC githubId (callback GitHub đồng thời) -> ném cho người gọi xử lý, không thử slug khác.
        if (/email|github/i.test(String((e as { meta?: { target?: unknown } }).meta?.target ?? ''))) throw e;
      }
    }
    throw new Error('Không tạo được slug project duy nhất sau 3 lần');
  }

  private decoyBody(email: string, name: string): AuthBody {
    return {
      user: { id: randomUUID(), email, name, emailVerified: false },
      memberships: [{ projectId: randomUUID(), slug: slugFromName(name), name: `${name}'s project`, environment: 'test', role: 'owner' }],
    };
  }

  // ------------------------------------------------------------------ đăng nhập (§5.2, §5.3)

  async login(input: { email?: unknown; password?: unknown }, ctx: ReqCtx): Promise<{ body: AuthBody; session: IssuedSession }> {
    const email = normalizeEmail(typeof input?.email === 'string' ? input.email : '');
    const password = typeof input?.password === 'string' ? input.password : '';
    const emailKey = `rl:login:em:${sha256Hex(email)}`;

    await this.limit('loginIp', `rl:login:ip:${ctx.ip ?? 'unknown'}`, email);
    // R-1 (review AU, ADR-109): ĐẾM TRƯỚC khi so mật khẩu bằng một INCR nguyên tử — N request song song nhận số thứ tự
    // 1..N, chỉ 5 lượt đầu tới bcrypt. (Trước: đọc rồi mới tăng sau khi sai -> 18 request song song lọt cả 18.)
    const lock = await this.limiter.hit(emailKey, LIMITS.loginEmailFailures.limit, LIMITS.loginEmailFailures.windowS);
    if (!lock.allowed) {
      await this.audit(null, 'auth.rate_limited', ctx.ip, { scope: 'login_email', emailHash: sha256Hex(email) });
      throw new TooManyAttempts(lock.retryAfterS);
    }

    const user = email ? await this.store.identity().findUserByEmail(email) : null;
    // Luôn chạy bcrypt.compare (hash giả khi không có user / user chỉ có GitHub) — cùng thời gian, cùng body.
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) {
      await this.audit(user?.id ?? null, 'auth.login_failed', ctx.ip, { emailHash: sha256Hex(email) });
      throw authError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
    }
    await this.limiter.release(emailKey); // đúng mật khẩu: lượt này không phải "lần sai"

    const session = await this.issueSession(user.id, null, null, ctx);
    await this.audit(user.id, 'auth.login_succeeded', ctx.ip);
    return { body: await this.body(user.id), session };
  }

  // ------------------------------------------------------------------ refresh xoay vòng (§5.3)

  async refresh(refreshToken: string | undefined, csrfCookie: string | undefined, csrfHeader: string | undefined, ctx: ReqCtx): Promise<IssuedSession> {
    await this.limit('refreshIp', `rl:refresh:ip:${ctx.ip ?? 'unknown'}`, '');
    if (!refreshToken) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    const now = this.now();

    // MỘT transaction: khoá dòng (FOR UPDATE) -> kiểm -> xoay vòng. Nhánh lỗi TRẢ VỀ (không ném) để việc thu hồi
    // family khi phát hiện dùng lại vẫn được COMMIT; lượt refresh đồng thời thứ hai chờ khoá rồi thấy rotatedAt.
    type Outcome = { kind: 'ok'; issued: IssuedSession } | { kind: 'error'; status: HttpStatus; error: string };
    let reusedBy: string | null = null; // R-3: family bị thu hồi -> ngắt socket của user SAU commit
    const outcome: Outcome = await this.store.$transaction(async (tx) => {
      const idn = this.store.identity(tx);
      const row = await idn.lockSessionByTokenHash(sha256Hex(refreshToken));
      if (!row) return { kind: 'error', status: HttpStatus.UNAUTHORIZED, error: 'session_expired' };
      if (!verifyCsrfToken(this.cfg.csrfSecret, row.id, csrfCookie, csrfHeader)) return { kind: 'error', status: HttpStatus.FORBIDDEN, error: 'csrf_failed' };
      if (row.revokedAt) return { kind: 'error', status: HttpStatus.UNAUTHORIZED, error: 'session_expired' };
      if (row.rotatedAt) {
        if (now.getTime() - row.rotatedAt.getTime() <= REFRESH_RACE_WINDOW_MS) {
          return { kind: 'error', status: HttpStatus.UNAUTHORIZED, error: 'refresh_race' };
        }
        // Token cũ bị dùng lại: dấu hiệu bị đánh cắp -> thu hồi cả family (§5.3 bước 4).
        await idn.revokeFamily(row.familyId, 'reuse_detected', now);
        reusedBy = row.userId;
        await idn.recordAuthAudit({ userId: row.userId, action: 'session.reuse_detected', ip: ctx.ip, meta: { familyId: row.familyId } });
        logger.warn({ userId: row.userId, familyId: row.familyId }, 'Refresh token bị dùng lại -> thu hồi cả family');
        return { kind: 'error', status: HttpStatus.UNAUTHORIZED, error: 'session_expired' };
      }
      if (row.idleExpiresAt <= now || row.absoluteExpiresAt <= now) return { kind: 'error', status: HttpStatus.UNAUTHORIZED, error: 'session_expired' };
      const issued = await this.issueSession(row.userId, row.familyId, row.absoluteExpiresAt, ctx, tx);
      await idn.markRotated(row.id, issued.sessionId, now);
      return { kind: 'ok', issued };
    });
    if (reusedBy) notifyAccessRevoked(reusedBy);
    if (outcome.kind === 'error') throw authError(outcome.status, outcome.error);
    return outcome.issued;
  }

  // ------------------------------------------------------------------ đăng xuất, thiết bị (§5.3)

  async logout(p: UserPrincipal, ctx: ReqCtx): Promise<void> {
    await this.store.identity().revokeOwnFamily(p.id, p.sessionId, 'logout', this.now());
    notifyAccessRevoked(p.id);
    await this.audit(p.id, 'session.revoked', ctx.ip, { reason: 'logout' });
  }

  async logoutAll(p: UserPrincipal, ctx: ReqCtx): Promise<void> {
    await this.store.identity().revokeUserSessions(p.id, 'logout_all', this.now());
    notifyAccessRevoked(p.id);
    await this.audit(p.id, 'session.revoked', ctx.ip, { reason: 'logout_all' });
  }

  async listSessions(p: UserPrincipal) {
    const now = this.now();
    const current = await this.store.identity().findSessionById(p.sessionId);
    const rows = await this.store.identity().listLiveSessions(p.id, now);
    return rows.map((r) => ({ id: r.id, userAgent: r.userAgent, ip: r.ip, createdAt: r.createdAt, current: r.familyId === current?.familyId }));
  }

  /** Thu hồi một thiết bị của CHÍNH mình; của người khác / không có -> 404. */
  async revokeSession(p: UserPrincipal, sessionId: string, ctx: ReqCtx): Promise<void> {
    const n = /^[0-9a-f-]{36}$/i.test(sessionId) ? await this.store.identity().revokeOwnFamily(p.id, sessionId, 'logout', this.now()) : 0;
    if (n === 0) throw authError(HttpStatus.NOT_FOUND, 'not_found');
    notifyAccessRevoked(p.id);
    await this.audit(p.id, 'session.revoked', ctx.ip, { reason: 'device' });
  }

  async me(userId: string): Promise<AuthBody> {
    return this.body(userId);
  }

  // ------------------------------------------------------------------ email + mật khẩu (§5.2, §5.9 — AU2)

  /** `POST /auth/verify-email {token}` — sai / hết hạn / đã dùng: CÙNG 400 `token_invalid`. */
  async verifyEmail(input: { token?: unknown }, ctx: ReqCtx): Promise<void> {
    const row = await this.consume(input?.token, 'verify_email');
    if (!row?.userId) throw authError(HttpStatus.BAD_REQUEST, 'token_invalid');
    await this.store.identity().setEmailVerified(row.userId, this.now());
    await this.audit(row.userId, 'user.email_verified', ctx.ip);
  }

  /** `POST /auth/resend-verification` — luôn 202 (đã xác minh thì không gửi gì); 1 lần/phút, 5 lần/ngày theo email. */
  async resendVerification(p: UserPrincipal, ctx: ReqCtx): Promise<void> {
    const user = await this.store.identity().findUserById(p.id);
    if (!user) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    await this.mailLimit('verify_email', user.email);
    if (user.emailVerifiedAt) return;
    await this.sendVerification(user.id, user.email, user.name);
    await this.audit(user.id, 'user.verification_resent', ctx.ip);
  }

  /** `POST /auth/forgot-password {email}` — LUÔN 202 cùng body, dù email có hay không (không dò được tài khoản). */
  async forgotPassword(input: { email?: unknown }, ctx: ReqCtx): Promise<void> {
    const email = normalizeEmail(typeof input?.email === 'string' ? input.email : '');
    if (!isValidEmail(email)) return;
    await this.mailLimit('reset_password', email);
    const user = await this.store.identity().findUserByEmail(email);
    await this.audit(user?.id ?? null, 'password.reset_requested', ctx.ip, { emailHash: sha256Hex(email) });
    if (!user) return;
    const token = await this.newEmailToken('reset_password', user.email, user.id, RESET_TTL_MS);
    this.sendLater(user.email, mailTemplates.resetPassword(this.webLink(`/reset-password?token=${token}`), user.name));
  }

  /** `POST /auth/reset-password {token, password}` — đổi mật khẩu + thu hồi MỌI session (§5.3). */
  async resetPassword(input: { token?: unknown; password?: unknown }, ctx: ReqCtx): Promise<void> {
    const password = typeof input?.password === 'string' ? input.password : '';
    const raw = typeof input?.token === 'string' ? input.token : '';
    // Kiểm mật khẩu TRƯỚC khi đốt token: mật khẩu yếu thì người dùng sửa và thử lại được bằng cùng link.
    const preview = raw && raw.length <= 128 ? await this.store.identity().peekEmailTokenEmail(sha256Hex(raw), 'reset_password', this.now()) : null;
    if (preview) this.assertPassword(password, preview);
    const row = await this.consume(raw, 'reset_password');
    if (!row?.userId) throw authError(HttpStatus.BAD_REQUEST, 'token_invalid');
    this.assertPassword(password, row.email);
    const now = this.now();
    const passwordHash = await hashPassword(password);
    await this.store.$transaction(async (tx) => {
      const idn = this.store.identity(tx);
      await idn.updatePassword(row.userId!, passwordHash, now);
      await idn.revokeUserSessions(row.userId!, 'password_reset', now);
      // Bấm link trong mail đã chứng minh sở hữu email.
      await idn.setEmailVerified(row.userId!, now);
    });
    notifyAccessRevoked(row.userId);
    await this.audit(row.userId, 'password.reset', ctx.ip);
  }

  /** `POST /auth/change-password` — đúng mật khẩu hiện tại; thu hồi mọi session TRỪ phiên hiện tại (§5.3). */
  async changePassword(p: UserPrincipal, input: { currentPassword?: unknown; password?: unknown }, ctx: ReqCtx): Promise<void> {
    const user = await this.store.identity().findUserById(p.id);
    if (!user) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    const current = typeof input?.currentPassword === 'string' ? input.currentPassword : '';
    if (!(await verifyPassword(current, user.passwordHash))) throw authError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
    const password = typeof input?.password === 'string' ? input.password : '';
    this.assertPassword(password, user.email);
    const now = this.now();
    const passwordHash = await hashPassword(password);
    await this.store.$transaction(async (tx) => {
      const idn = this.store.identity(tx);
      await idn.updatePassword(user.id, passwordHash, now);
      await idn.revokeUserSessions(user.id, 'password_changed', now, p.sessionId);
    });
    notifyAccessRevoked(user.id);
    await this.audit(user.id, 'password.changed', ctx.ip);
  }

  private assertPassword(password: string, email: string): void {
    const problem = passwordProblem(password, email);
    if (problem) throw authError(HttpStatus.UNPROCESSABLE_ENTITY, problem.error, { field: 'password', message: problem.message });
  }

  private async sendVerification(userId: string, email: string, name: string): Promise<void> {
    const token = await this.newEmailToken('verify_email', email, userId, VERIFY_TTL_MS);
    await this.mail.send({ to: email, ...mailTemplates.verifyEmail(this.webLink(`/verify-email?token=${token}`), name) });
  }

  /** Token 32 byte base64url; DB chỉ giữ sha256. Token cũ chưa dùng CÙNG mục đích của email đó bị vô hiệu (§5.9). */
  private async newEmailToken(purpose: 'verify_email' | 'reset_password', email: string, userId: string, ttlMs: number): Promise<string> {
    const token = newOpaqueToken();
    const now = this.now();
    await this.store.$transaction(async (tx) => {
      const idn = this.store.identity(tx);
      await idn.invalidateEmailTokens(email, purpose, now);
      await idn.createEmailToken({ purpose, email, userId, tokenHash: sha256Hex(token), expiresAt: new Date(now.getTime() + ttlMs) });
    });
    return token;
  }

  private consume(token: unknown, purpose: 'verify_email' | 'reset_password') {
    if (typeof token !== 'string' || !token || token.length > 128) return Promise.resolve(null);
    return this.store.identity().consumeEmailToken(sha256Hex(token), purpose, this.now());
  }

  /** §5.5: forgot-password / resend-verification theo email: 1 / phút VÀ 5 / ngày. Body giống nhau dù email có hay không. */
  private async mailLimit(purpose: string, email: string): Promise<void> {
    const h = sha256Hex(email);
    for (const [suffix, limit, windowS] of [['m', 1, 60], ['d', 5, 86_400]] as const) {
      const d = await this.limiter.hit(`rl:mail:${purpose}:${suffix}:${h}`, limit, windowS);
      if (!d.allowed) {
        await this.audit(null, 'auth.rate_limited', null, { scope: `mail_${purpose}`, emailHash: h });
        throw new TooManyAttempts(d.retryAfterS);
      }
    }
  }

  private webLink(pathAndQuery: string): string {
    return `${this.cfg.webPublicUrl || 'http://localhost:3000'}${pathAndQuery}`;
  }

  /** Gửi thư không chặn response; lỗi chỉ log (không lộ ra client có/không có tài khoản). */
  private sendLater(to: string, t: { subject: string; html: string; text: string }): void {
    void this.mail.send({ to, ...t }).catch((err) => logger.warn({ err: (err as Error).message, to: maskEmail(to) }, 'Gửi mail thất bại'));
  }

  // ------------------------------------------------------------------ nội bộ

  /** Phát session mới (đăng nhập: family mới, absolute = now+30d; refresh: giữ family + absolute). */
  async issueSession(
    userId: string,
    familyId: string | null,
    absoluteExpiresAt: Date | null,
    ctx: ReqCtx,
    tx?: Parameters<Parameters<AuthStore['$transaction']>[0]>[0],
  ): Promise<IssuedSession> {
    const now = this.now();
    const refreshToken = newOpaqueToken();
    const idleExpiresAt = new Date(now.getTime() + this.cfg.refreshIdleDays * 86400_000);
    const absolute = absoluteExpiresAt ?? new Date(now.getTime() + this.cfg.refreshAbsoluteDays * 86400_000);
    const row = await this.store.identity(tx).createSession({
      userId,
      familyId: familyId ?? randomUUID(),
      tokenHash: sha256Hex(refreshToken),
      idleExpiresAt: idleExpiresAt < absolute ? idleExpiresAt : absolute,
      absoluteExpiresAt: absolute,
      userAgent: ctx.userAgent?.slice(0, 255) ?? null,
      ip: ctx.ip?.slice(0, 45) ?? null,
    });
    return {
      sessionId: row.id,
      accessToken: signAccessToken(this.jwt, this.cfg, { userId, sessionId: row.id }),
      refreshToken,
      csrfToken: issueCsrfToken(this.cfg.csrfSecret, row.id),
      accessMaxAgeS: this.cfg.accessTtlS,
      refreshMaxAgeS: Math.max(1, Math.floor((Math.min(idleExpiresAt.getTime(), absolute.getTime()) - now.getTime()) / 1000)),
    };
  }

  private async body(userId: string): Promise<AuthBody> {
    const idn = this.store.identity();
    const user = await idn.findUserById(userId);
    if (!user) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    const memberships: MembershipView[] = await idn.listMemberships(userId);
    return {
      user: { id: user.id, email: user.email, name: user.name, emailVerified: !!user.emailVerifiedAt },
      memberships: memberships.map((m) => ({ projectId: m.projectId, slug: m.slug, name: m.name, environment: m.environment, role: m.role })),
    };
  }

  private async limit(kind: keyof typeof LIMITS, key: string, email: string): Promise<void> {
    const { limit, windowS } = LIMITS[kind];
    const d = await this.limiter.hit(key, limit, windowS);
    if (!d.allowed) {
      await this.audit(null, 'auth.rate_limited', null, { scope: kind, ...(email ? { emailHash: sha256Hex(email) } : {}) });
      throw new TooManyAttempts(d.retryAfterS);
    }
  }

  private async audit(userId: string | null, action: string, ip: string | null, meta?: Record<string, unknown>): Promise<void> {
    try {
      await this.store.identity().recordAuthAudit({ userId, action, ip, meta });
    } catch (err) {
      logger.warn({ err: (err as Error).message, action }, 'Không ghi được auth_audit (bỏ qua)');
    }
  }
}
