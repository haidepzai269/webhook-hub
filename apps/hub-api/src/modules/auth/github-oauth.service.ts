import { HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '@hub/database';
import { logger, MAIL_SENDER, MailSender, mailTemplates, maskEmail, normalizeEmail } from '@hub/common';
import { AUTH_CONFIG, AuthConfig } from './auth-config';
import { AuthService, ReqCtx } from './auth.service';
import { IssuedSession } from './cookies';
import { authError } from './auth-errors';
import { UserPrincipal } from '../service-api/principal';
import { OAUTH_COOKIE, OAUTH_COOKIE_OPTIONS, OAUTH_TTL_MS, OAuthCookie, openOAuthCookie, safeEqual, sealOAuthCookie } from './oauth-cookie';

export { OAUTH_COOKIE };

/**
 * SPEC-auth §5.10 (AU5): đăng nhập GitHub — OAuth 2.0 authorization code + state + PKCE (RFC 6749, RFC 9700).
 * - Không lưu access token của GitHub (dùng xong bỏ). Chỉ xin `read:user user:email`.
 * - Ghép tài khoản AN TOÀN: theo githubId (id số); email trùng user ĐÃ xác minh -> liên kết + mail báo; trùng user
 *   CHƯA xác minh -> KHÔNG liên kết (chặn chiếm tài khoản bằng cách đăng ký trước email người khác).
 * - Operator không đăng nhập bằng GitHub (giảm bề mặt tấn công, §5.6).
 * - `GITHUB_OAUTH_BASE_URL` cho stack kiểm chứng (fake-github, VF4); production bắt buộc https://github.com
 *   (test-only-config.ts chặn lúc khởi động).
 */
export const GITHUB_OAUTH = Symbol('GITHUB_OAUTH');

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  apiUrl: string;
}

export function loadGithubConfig(env: Record<string, string | undefined> = process.env): GithubConfig {
  const baseUrl = (env.GITHUB_OAUTH_BASE_URL || 'https://github.com').trim().replace(/\/$/, '');
  return {
    clientId: (env.GITHUB_OAUTH_CLIENT_ID ?? '').trim(),
    clientSecret: (env.GITHUB_OAUTH_CLIENT_SECRET ?? '').trim(),
    baseUrl,
    // GitHub thật: API ở api.github.com; fake-github phục vụ cả hai trên cùng một gốc.
    apiUrl: baseUrl === 'https://github.com' ? 'https://api.github.com' : baseUrl,
  };
}

export interface CallbackResult {
  redirect: string;
  session?: IssuedSession;
}

@Injectable()
export class GithubOAuthService {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(GITHUB_OAUTH) private readonly gh: GithubConfig,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @Optional() private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.gh.clientId && !!this.gh.clientSecret;
  }

  private web(path: string): string {
    return `${this.cfg.webPublicUrl || 'http://localhost:3000'}${path}`;
  }

  private redirectUri(): string {
    // Đi qua proxy của web: cookie __Host-hub_oauth là cookie first-party của domain web.
    return this.web('/auth/github/callback');
  }

  /** `GET /auth/github`: state 32 byte + PKCE verifier 32 byte trong cookie HttpOnly ký HMAC, sống 10 phút. */
  start(): { redirectUrl: string; cookie: { name: string; value: string; options: Record<string, unknown> } } {
    if (!this.enabled) throw new HttpException({ error: 'github_oauth_disabled', message: 'Chưa cấu hình GitHub OAuth App' }, HttpStatus.SERVICE_UNAVAILABLE);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(`${this.gh.baseUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', this.gh.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('allow_signup', 'true');
    return {
      redirectUrl: url.toString(),
      cookie: {
        name: OAUTH_COOKIE,
        value: this.sealCookie({ p: 'github', state, verifier, exp: Date.now() + OAUTH_TTL_MS }),
        options: { ...OAUTH_COOKIE_OPTIONS },
      },
    };
  }

  /** `GET /auth/github/callback?code&state` — trả nơi chuyển hướng (+ phiên nếu đăng nhập được). */
  async callback(query: { code?: unknown; state?: unknown }, cookieValue: string | undefined, ctx: ReqCtx): Promise<CallbackResult> {
    const sealed = this.openCookie(cookieValue);
    const state = typeof query?.state === 'string' ? query.state : '';
    if (!sealed || !state || !safeEqual(state, sealed.state)) {
      throw new HttpException({ error: 'oauth_state_mismatch', message: 'state OAuth không khớp hoặc đã hết hạn — thử đăng nhập lại' }, HttpStatus.BAD_REQUEST);
    }
    const code = typeof query?.code === 'string' ? query.code : '';
    if (!code) return { redirect: this.web('/login?error=github_denied') };

    let profile: { id: string; name: string; email: string } | null;
    try {
      profile = await this.fetchProfile(code, sealed.verifier);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'GitHub OAuth: đổi code / đọc hồ sơ thất bại');
      return { redirect: this.web('/login?error=github_failed') };
    }
    if (!profile) return { redirect: this.web('/login?error=github_email_unverified') };
    return this.match(profile, ctx, true);
  }

  /** Ghép hồ sơ GitHub với user (spec §5.8). `retry`: đua tạo user (P2002 email/githubId) -> ghép lại MỘT lần, user kia đã có. */
  private async match(profile: { id: string; email: string; name: string }, ctx: ReqCtx, retry: boolean): Promise<CallbackResult> {
    const idn = this.prisma.identity();
    // 1. đã liên kết theo githubId (id số — login đổi được) -> đăng nhập user đó
    const byGithub = await idn.findUserByGithubId(profile.id);
    if (byGithub) {
      if (byGithub.isOperator) return { redirect: this.web('/login?error=operator_github_forbidden') };
      return { redirect: this.web('/dashboard'), session: await this.login(byGithub.id, ctx) };
    }
    // 2. email trùng user có sẵn
    const byEmail = await idn.findUserByEmail(profile.email);
    if (byEmail) {
      if (byEmail.isOperator) return { redirect: this.web('/login?error=operator_github_forbidden') };
      if (!byEmail.emailVerifiedAt) return { redirect: this.web('/login?error=email_exists_unverified') };
      // R-12 (ADR-116): user đã gắn GitHub KHÁC (linkGithub = 0) -> KHÔNG đăng nhập bằng tài khoản GitHub này.
      if ((await idn.linkGithub(byEmail.id, profile.id)) !== 1) {
        await idn.recordAuthAudit({ userId: byEmail.id, action: 'github.link_mismatch', ip: ctx.ip, meta: { githubId: profile.id } });
        return { redirect: this.web('/login?error=github_account_mismatch') };
      }
      await idn.recordAuthAudit({ userId: byEmail.id, action: 'github.linked', ip: ctx.ip, meta: { githubId: profile.id } });
      void this.mail
        .send({ to: byEmail.email, ...mailTemplates.githubLinked(byEmail.name) })
        .catch((err) => logger.warn({ err: (err as Error).message, to: maskEmail(byEmail.email) }, 'Gửi mail github.linked thất bại'));
      return { redirect: this.web('/dashboard'), session: await this.login(byEmail.id, ctx) };
    }
    // 3. người mới: email GitHub đã xác minh -> tạo user đã xác minh, không mật khẩu, kèm project đầu tiên (§5.8)
    let created: { userId: string };
    try {
      created = await this.auth.createUserWithFirstProject(
        { email: profile.email, name: profile.name, passwordHash: null, emailVerifiedAt: new Date(), githubId: profile.id },
        ctx,
      );
    } catch (e) {
      // R-12: callback đồng thời cùng email/githubId -> P2002; trước đây thành 500. Lượt kia đã tạo user -> ghép lại.
      if ((e as { code?: string })?.code === 'P2002' && retry) return this.match(profile, ctx, false);
      throw e;
    }
    return { redirect: this.web('/dashboard'), session: await this.login(created.userId, ctx) };
  }

  /** `POST /auth/github/unlink`: chỉ khi còn mật khẩu (không tự khoá mình ra ngoài) -> 409 last_login_method. */
  async unlink(p: UserPrincipal, ctx: ReqCtx): Promise<void> {
    const idn = this.prisma.identity();
    const user = await idn.findUserById(p.id);
    if (!user) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    // AU5b (ADR-127): còn mật khẩu HOẶC Google thì gỡ được.
    if (!user.githubId) return;
    // GO-1 (ADR-128): điều kiện "còn mật khẩu hoặc Google" nằm TRONG câu UPDATE (không đua được với gỡ Google).
    if ((await idn.unlinkGithub(user.id)) !== 1) {
      throw new HttpException({ error: 'last_login_method', message: 'Đặt mật khẩu (luồng quên mật khẩu) hoặc liên kết Google trước khi gỡ GitHub' }, HttpStatus.CONFLICT);
    }
    await idn.recordAuthAudit({ userId: user.id, action: 'github.unlinked', ip: ctx.ip });
  }

  private async login(userId: string, ctx: ReqCtx): Promise<IssuedSession> {
    const s = await this.auth.issueSession(userId, null, null, ctx);
    await this.prisma.identity().recordAuthAudit({ userId, action: 'auth.login_succeeded', ip: ctx.ip, meta: { via: 'github' } });
    return s;
  }

  /** Đổi code (kèm code_verifier) lấy token, đọc `/user` + `/user/emails`. Không có email primary+verified -> null. */
  private async fetchProfile(code: string, verifier: string): Promise<{ id: string; name: string; email: string } | null> {
    const tokRes = await this.fetchImpl(`${this.gh.baseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.gh.clientId, client_secret: this.gh.clientSecret, code, redirect_uri: this.redirectUri(), code_verifier: verifier }),
    });
    const tok = (await tokRes.json()) as { access_token?: string; error?: string };
    if (!tokRes.ok || !tok.access_token) throw new Error(`GitHub token: ${tokRes.status} ${tok.error ?? ''}`);
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${tok.access_token}`, 'user-agent': 'webhook-hub' };
    const [uRes, eRes] = await Promise.all([this.fetchImpl(`${this.gh.apiUrl}/user`, { headers }), this.fetchImpl(`${this.gh.apiUrl}/user/emails`, { headers })]);
    if (!uRes.ok || !eRes.ok) throw new Error(`GitHub API: /user ${uRes.status}, /user/emails ${eRes.status}`);
    const u = (await uRes.json()) as { id?: number; login?: string; name?: string | null };
    const emails = (await eRes.json()) as { email?: string; primary?: boolean; verified?: boolean }[];
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified && typeof e.email === 'string') : undefined;
    if (!primary || typeof u.id !== 'number') return null;
    return { id: String(u.id), name: (u.name || u.login || 'GitHub user').slice(0, 100), email: normalizeEmail(primary.email!) };
  }

  private sealCookie(c: OAuthCookie): string {
    return sealOAuthCookie(this.cfg.oauthCookieSecret, c);
  }

  private openCookie(v: string | undefined): OAuthCookie | null {
    return openOAuthCookie(this.cfg.oauthCookieSecret, v, 'github');
  }
}
