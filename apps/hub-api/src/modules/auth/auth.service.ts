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
import { EmailFilterService } from './email-filter.service';

export interface ReqCtx {
  ip: string | null;
  userAgent: string | null;
}

/** R-6: body DUY NHẤT của `POST /auth/register` — giống hệt nhau dù email mới hay đã có. */
export const REGISTER_ACCEPTED = { ok: true, message: 'Kiểm tra email để kích hoạt tài khoản' } as const;

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
  // GO-4 (ADR-128): mỗi callback OAuth hợp lệ làm hub-api POST tới token endpoint của nhà cung cấp -> chặn khuếch đại.
  oauthCallbackIp: { limit: 20, windowS: 60 },
  // ADR-180: `/auth/email-check` là oracle dò email -> trần theo IP VÀ trần toàn cục (dò hàng loạt từ nhiều IP).
  emailCheckIp: { limit: 20, windowS: 60 },
  emailCheckGlobal: { limit: 600, windowS: 60 },
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

/**
 * ADR-180 (review TB-1): audit `auth.rate_limited` CHỈ ở lần vượt trần ĐẦU TIÊN của cửa sổ (`count === limit + 1`).
 * Các lần bị chặn sau đó chỉ ném 429 — nếu không, một IP bắn 5k req/s = 5k INSERT/s vào auth_audit (khuếch đại ghi DB).
 * Một dòng audit / khoá / cửa sổ vẫn đủ để thấy "ai đang bị chặn, từ lúc nào".
 */
function firstOverflow(d: { count: number }, limit: number): boolean {
  return d.count === limit + 1;
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
    // ADR-180: vắng (test dựng tay) -> không gợi ý từ filter, `/auth/email-check` hỏi thẳng DB.
    @Optional() @Inject(EmailFilterService) private readonly emailFilter: Pick<EmailFilterService, 'recordCreated' | 'isAvailable'> | null = null,
  ) {}


  // ------------------------------------------------------------------ đăng ký (§5.8)

  /**
   * R-6 (review AU, ADR-120): đăng ký KHÔNG đăng nhập. Mọi email hợp lệ -> CÙNG 201 `REGISTER_ACCEPTED`, không cookie,
   * cùng thời gian (băm mật khẩu ở cả hai nhánh, tạo user + gửi mail chạy NỀN). Email mới -> mail xác minh (link đăng
   * nhập luôn); email đã có + chưa xác minh -> gửi lại link xác minh; đã xác minh -> mail "có người thử đăng ký".
   * `created` chỉ để test chờ việc nền — controller không bao giờ trả nó ra ngoài.
   */
  async register(input: { email?: unknown; password?: unknown; name?: unknown }, ctx: ReqCtx): Promise<{ body: typeof REGISTER_ACCEPTED; done: Promise<void> }> {
    const email = normalizeEmail(typeof input?.email === 'string' ? input.email : '');
    const name = str(input?.name, 100);
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!isValidEmail(email)) throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', { field: 'email', message: 'Email không hợp lệ' });
    if (!name) throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', { field: 'name', message: 'name là chuỗi 1–100 ký tự' });
    const problem = passwordProblem(password, email);
    if (problem) throw authError(HttpStatus.UNPROCESSABLE_ENTITY, problem.error, { field: 'password', message: problem.message });

    await this.limit('registerIp', `rl:reg:ip:${ctx.ip ?? 'unknown'}`, email);

    const passwordHash = await hashPassword(password);
    // Việc phụ thuộc "email đã có chưa" chạy SAU response: không lộ qua body, cookie hay thời gian (§5.2).
    const done = this.registerInBackground(email, name, passwordHash, ctx).catch((err) =>
      logger.warn({ err: (err as Error).message, to: maskEmail(email) }, 'Đăng ký nền thất bại (người dùng đăng ký lại = gửi lại link)'),
    );
    return { body: REGISTER_ACCEPTED, done };
  }

  private async registerInBackground(email: string, name: string, passwordHash: string, ctx: ReqCtx): Promise<void> {
    const existing = await this.store.identity().findUserByEmail(email);
    if (existing) {
      await this.audit(existing.id, 'user.register_attempt_existing', ctx.ip);
      // Chưa xác minh (và có mật khẩu): đăng ký lại = xin lại link xác minh (người đăng ký trước có thể là chính họ).
      if (!existing.emailVerifiedAt && existing.passwordHash) {
        try {
          await this.mailLimit('verify_email', existing.email);
        } catch {
          return; // quá hạn mức gửi lại -> im lặng (response đã trả)
        }
        await this.sendVerification(existing.id, existing.email, existing.name);
        return;
      }
      this.sendLater(existing.email, mailTemplates.registerAttempt(this.webLink('/forgot-password')));
      return;
    }
    let created: { userId: string };
    try {
      created = await this.createUserWithFirstProject({ email, name, passwordHash, emailVerifiedAt: null }, ctx);
    } catch (e) {
      // Đăng ký đồng thời cùng email: lượt kia đã tạo user và đã gửi mail.
      if ((e as { code?: string })?.code === 'P2002') return;
      throw e;
    }
    // §5.8: mail xác minh gửi SAU COMMIT; lỗi gửi -> log, đăng ký lại để gửi lại; KHÔNG rollback.
    await this.sendVerification(created.userId, email, name);
  }

  /** User + project đầu tiên + membership owner + audit trong MỘT transaction; trùng slug -> thêm hậu tố, thử lại. Dùng chung với GitHub OAuth. */
  async createUserWithFirstProject(
    data: { email: string; name: string; passwordHash: string | null; emailVerifiedAt: Date | null; githubId?: string | null; googleSub?: string | null },
    ctx: ReqCtx,
  ): Promise<{ userId: string; projectId: string }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const created = await this.store.$transaction(async (tx) => {
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
        // ADR-180: SAU COMMIT (như SET NX của ingest) — tx lỗi thì không tới đây. Một chỗ cho cả mật khẩu/GitHub/Google.
        this.emailFilter?.recordCreated(data.email);
        return created;
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e;
        // P2002 trên email = đăng ký đồng thời cùng email: trả hình dạng giống hệt nhánh "đã tồn tại".
        // R-12: trùng email HOẶC githubId (callback GitHub đồng thời) -> ném cho người gọi xử lý, không thử slug khác.
        if (/email|github|google/i.test(String((e as { meta?: { target?: unknown } }).meta?.target ?? ''))) throw e;
      }
    }
    throw new Error('Không tạo được slug project duy nhất sau 3 lần');
  }


  // ------------------------------------------------------------------ gợi ý email đã có (ADR-180)

  /**
   * `POST /auth/email-check {email}` -> `{available}`. Đảo một phần R-6 có chủ đích (ADR-180): đây là oracle dò email,
   * nên rate limit theo IP + trần toàn cục; `/auth/register` vẫn R-6. Không log email thô (chỉ hash trong audit 429).
   */
  async emailCheck(input: { email?: unknown }, ctx: ReqCtx): Promise<{ available: boolean }> {
    const email = normalizeEmail(typeof input?.email === 'string' ? input.email : '');
    if (!isValidEmail(email)) throw authError(HttpStatus.BAD_REQUEST, 'bad_request', { field: 'email', message: 'Email không hợp lệ' });
    await this.limit('emailCheckIp', `rl:emailcheck:ip:${ctx.ip ?? 'unknown'}`, email);
    await this.limit('emailCheckGlobal', 'rl:emailcheck:all', email);
    if (!this.emailFilter) return { available: !(await this.store.identity().findUserByEmail(email)) };
    const r = await this.emailFilter.isAvailable(email);
    return { available: r.available };
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
      if (firstOverflow(lock, LIMITS.loginEmailFailures.limit)) await this.audit(null, 'auth.rate_limited', ctx.ip, { scope: 'login_email', emailHash: sha256Hex(email) });
      throw new TooManyAttempts(lock.retryAfterS);
    }

    const user = email ? await this.store.identity().findUserByEmail(email) : null;
    // Luôn chạy bcrypt.compare (hash giả khi không có user / user chỉ có GitHub) — cùng thời gian, cùng body.
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    // R-6 (ADR-120): tài khoản mật khẩu CHƯA xác minh email không đăng nhập được — CÙNG 401 với sai mật khẩu
    // (nếu không, đăng ký + đăng nhập vẫn dò ra email nào đã có tài khoản). Link xác minh trong mail đăng nhập luôn.
    if (user && ok && !user.emailVerifiedAt && !user.isOperator) {
      await this.audit(user.id, 'auth.login_unverified', ctx.ip);
      throw authError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
    }
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
  /**
   * R-6 (ADR-120): bấm link = chứng minh sở hữu email -> xác minh VÀ đăng nhập.
   * N-1 (ADR-121): tài khoản mật khẩu CHƯA xác minh thì mật khẩu hiện có là của "ai đó đã đăng ký" — có thể là kẻ đăng ký
   * trước email người khác. Người bấm link phải ĐẶT mật khẩu (+ tên) — thiếu thì 400 `password_required`, token chưa bị
   * đốt; đặt xong thì mọi thứ người trước để lại bị xoá (`claimAccount`).
   */
  async verifyEmail(input: { token?: unknown; password?: unknown; name?: unknown }, ctx: ReqCtx): Promise<{ body: AuthBody; session: IssuedSession }> {
    const raw = typeof input?.token === 'string' && input.token.length <= 128 ? input.token : '';
    const email = raw ? await this.store.identity().peekEmailTokenEmail(sha256Hex(raw), 'verify_email', this.now()) : null;
    if (!email) throw authError(HttpStatus.BAD_REQUEST, 'token_invalid');
    const user = await this.store.identity().findUserByEmail(email);
    const claim = !!user && !!user.passwordHash && !user.emailVerifiedAt;
    let passwordHash: string | null = null;
    let name = '';
    if (claim) {
      const password = typeof input?.password === 'string' ? input.password : '';
      if (!password) throw authError(HttpStatus.BAD_REQUEST, 'password_required', { message: 'Đặt mật khẩu để kích hoạt tài khoản' });
      this.assertPassword(password, email);
      name = str(input?.name, 100) ?? '';
      passwordHash = await hashPassword(password);
    }
    const row = await this.consume(raw, 'verify_email');
    if (!row?.userId) throw authError(HttpStatus.BAD_REQUEST, 'token_invalid');
    if (claim && passwordHash) {
      await this.claimAccount(row.userId, row.email, passwordHash, name || row.email.split('@')[0], 'email_claimed');
      await this.audit(row.userId, 'user.account_claimed', ctx.ip);
    } else {
      await this.store.identity().setEmailVerified(row.userId, this.now());
    }
    await this.audit(row.userId, 'user.email_verified', ctx.ip);
    const session = await this.issueSession(row.userId, null, null, ctx);
    return { body: await this.body(row.userId), session };
  }

  /**
   * N-1 (ADR-121): người chứng minh hộp thư nhận tài khoản: mật khẩu MỚI + xác minh + xoá dấu vết của người nắm tài khoản
   * trước đó (tên, githubId, lời mời chờ, token email chờ, mọi phiên, key của project chỉ mình user là thành viên).
   */
  async claimAccount(userId: string, email: string, passwordHash: string | null, name: string, reason: string): Promise<void> {
    const now = this.now();
    await this.store.$transaction(async (tx) => {
      const idn = this.store.identity(tx);
      await idn.updatePassword(userId, passwordHash, now);
      await idn.setEmailVerified(userId, now);
      const sole = await idn.resetClaimedAccount(userId, email, name, reason, now);
      for (const pid of sole) await new TenantScopedRepository(tx, pid).revokeAllApiKeys(now);
    });
    notifyAccessRevoked(userId);
  }

  /** `POST /auth/resend-verification` — luôn 202 (đã xác minh thì không gửi gì); 1 lần/phút, 5 lần/ngày theo email. */
  async resendVerification(p: UserPrincipal, ctx: ReqCtx): Promise<void> {
    const user = await this.store.identity().findUserById(p.id);
    if (!user) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    await this.mailLimit('verify_email', user.email);
    if (user.emailVerifiedAt) return;
    // G-4: gửi chạy nền như các mail khác — Gmail/Resend treo không giữ request tới ~20 s.
    void this.sendVerification(user.id, user.email, user.name).catch((err) =>
      logger.warn({ err: (err as Error).message, to: maskEmail(user.email) }, 'Gửi lại mail xác minh thất bại'),
    );
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
    // R-13: tạo token + gửi mail SAU khi trả 202 — email có thật không tốn thêm một transaction trước response (chống dò bằng thời gian).
    void this.newEmailToken('reset_password', user.email, user.id, RESET_TTL_MS)
      .then((token) => this.sendLater(user.email, mailTemplates.resetPassword(this.webLink(`/reset-password?token=${token}`), user.name)))
      .catch((err) => logger.warn({ err: (err as Error).message, to: maskEmail(user.email) }, 'Tạo token đặt lại mật khẩu thất bại'));
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
    // N-1 (ADR-121): tài khoản CHƯA xác minh nhận qua quên mật khẩu = cũng là "người nắm hộp thư nhận lại" -> xoá dấu vết.
    const before = await this.store.identity().findUserById(row.userId);
    if (before && !before.emailVerifiedAt) {
      await this.claimAccount(row.userId, row.email, passwordHash, row.email.split('@')[0], 'password_reset');
      await this.audit(row.userId, 'user.account_claimed', ctx.ip);
      await this.audit(row.userId, 'password.reset', ctx.ip);
      return;
    }
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
        if (firstOverflow(d, limit)) await this.audit(null, 'auth.rate_limited', null, { scope: `mail_${purpose}`, emailHash: h });
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

  /** GO-4: một INCR theo IP (đi qua đường IP R-2) cho `/auth/{google,github}/callback`; vượt -> 429. */
  async limitOAuthCallback(ctx: ReqCtx): Promise<void> {
    await this.limit('oauthCallbackIp', `rl:oauthcb:ip:${ctx.ip ?? 'unknown'}`, '');
  }

  private async limit(kind: keyof typeof LIMITS, key: string, email: string): Promise<void> {
    const { limit, windowS } = LIMITS[kind];
    const d = await this.limiter.hit(key, limit, windowS);
    if (!d.allowed) {
      if (firstOverflow(d, limit)) await this.audit(null, 'auth.rate_limited', null, { scope: kind, ...(email ? { emailHash: sha256Hex(email) } : {}) });
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
