import { HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '@hub/database';
import { logger, MAIL_SENDER, MailSender, mailTemplates, maskEmail, normalizeEmail } from '@hub/common';
import { AUTH_CONFIG, AuthConfig } from './auth-config';
import { AuthService, ReqCtx } from './auth.service';
import { authError } from './auth-errors';
import { UserPrincipal } from '../service-api/principal';
import { CallbackResult } from './github-oauth.service';
import { GoogleJwks, IdTokenError, verifyGoogleIdToken } from './google-id-token';
import { OAUTH_COOKIE, OAUTH_COOKIE_OPTIONS, OAUTH_TTL_MS, openOAuthCookie, safeEqual, safeNextPath, sealOAuthCookie } from './oauth-cookie';

/**
 * AU5b (ADR-127): đăng nhập Google — OpenID Connect authorization code + PKCE (S256) + state + nonce, scope
 * `openid email profile` (không nhạy cảm -> không cần Google thẩm định). Định danh ổn định là `sub` (users.google_sub),
 * KHÔNG bao giờ khoá theo email. ID token kiểm đủ: chữ ký theo JWKS (cache, xoay `kid`), iss, aud, exp, nonce.
 * Client OAuth này KHÁC client gửi mail Gmail (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN chỉ cho mail, ADR-124).
 * `GOOGLE_OAUTH_FAKE_BASE_URL` (fake-google của hubv) CHỈ khi NODE_ENV ≠ production — production bỏ qua và
 * test-only-config.ts làm app thoát.
 */
export const GOOGLE_OAUTH = Symbol('GOOGLE_OAUTH');

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export function loadGoogleConfig(env: Record<string, string | undefined> = process.env): GoogleConfig {
  const fake = env.NODE_ENV === 'production' ? '' : (env.GOOGLE_OAUTH_FAKE_BASE_URL ?? '').trim().replace(/\/$/, '');
  return {
    clientId: (env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim(),
    clientSecret: (env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim(),
    authUrl: fake ? `${fake}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: fake ? `${fake}/token` : 'https://oauth2.googleapis.com/token',
    jwksUrl: fake ? `${fake}/oauth2/v3/certs` : 'https://www.googleapis.com/oauth2/v3/certs',
  };
}

interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  hd?: string;
}

/** GO-2: Google là nơi CẤP email này — gmail.com/googlemail.com, hoặc Workspace có `hd` trùng domain của email. */
export function googleAuthoritative(email: string, hd: string | undefined): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return true;
  return !!hd && hd.toLowerCase() === domain;
}

@Injectable()
export class GoogleOAuthService {
  private readonly jwks: GoogleJwks;

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(GOOGLE_OAUTH) private readonly g: GoogleConfig,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @Optional() private readonly fetchImpl: typeof fetch = fetch,
    @Optional() private readonly now: () => number = Date.now,
  ) {
    this.jwks = new GoogleJwks(g.jwksUrl, fetchImpl, now);
  }

  get enabled(): boolean {
    return !!this.g.clientId && !!this.g.clientSecret;
  }

  private web(path: string): string {
    return `${this.cfg.webPublicUrl || 'http://localhost:3000'}${path}`;
  }

  private redirectUri(): string {
    return this.web('/auth/google/callback'); // qua proxy web: cookie __Host-hub_oauth first-party
  }

  /** `GET /auth/google?next=`: state + PKCE verifier + nonce (+ next an toàn) trong cookie ký HMAC, 10 phút. */
  start(next?: unknown): { redirectUrl: string; cookie: { name: string; value: string; options: Record<string, unknown> } } {
    if (!this.enabled) throw new HttpException({ error: 'google_oauth_disabled', message: 'Chưa cấu hình Google OAuth client' }, HttpStatus.SERVICE_UNAVAILABLE);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const url = new URL(this.g.authUrl);
    url.searchParams.set('client_id', this.g.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    const safe = safeNextPath(next, this.web(''));
    return {
      redirectUrl: url.toString(),
      cookie: {
        name: OAUTH_COOKIE,
        value: sealOAuthCookie(this.cfg.oauthCookieSecret, { p: 'google', state, verifier, nonce, exp: this.now() + OAUTH_TTL_MS, ...(safe ? { next: safe } : {}) }),
        options: { ...OAUTH_COOKIE_OPTIONS },
      },
    };
  }

  /** `GET /auth/google/callback?code&state` — trả nơi chuyển hướng (+ phiên). */
  async callback(query: { code?: unknown; state?: unknown; error?: unknown }, cookieValue: string | undefined, ctx: ReqCtx): Promise<CallbackResult> {
    const sealed = openOAuthCookie(this.cfg.oauthCookieSecret, cookieValue, 'google', this.now());
    const state = typeof query?.state === 'string' ? query.state : '';
    if (!sealed || !sealed.nonce || !state || !safeEqual(state, sealed.state)) {
      throw new HttpException({ error: 'oauth_state_mismatch', message: 'state OAuth không khớp hoặc đã hết hạn — thử đăng nhập lại' }, HttpStatus.BAD_REQUEST);
    }
    const code = typeof query?.code === 'string' ? query.code : '';
    if (!code) return { redirect: this.web('/login?error=google_denied') };
    let profile: GoogleProfile;
    try {
      profile = await this.exchange(code, sealed.verifier, sealed.nonce);
    } catch (err) {
      const reason = err instanceof IdTokenError ? err.reason : (err as Error).message;
      logger.warn({ reason }, 'Google OAuth: đổi code / kiểm ID token thất bại');
      return { redirect: this.web('/login?error=google_failed') };
    }
    if (!profile.emailVerified) return { redirect: this.web('/login?error=google_email_unverified') };
    return this.match(profile, sealed.next, ctx, true);
  }

  /**
   * Ma trận ghép (ADR-127): theo `sub` trước; email trùng user ĐÃ xác minh -> gắn `sub` (đã gắn sub khác ->
   * google_account_mismatch); email trùng user CHƯA xác minh -> Google đã chứng minh hộp thư -> `claimAccount` (xoá mật khẩu
   * chờ, phiên, token, lời mời, key của người đăng ký trước — N-1) rồi gắn `sub`; không có -> tạo user đã xác minh.
   * `retry`: callback đồng thời (P2002 trên email/google_sub) -> ghép lại MỘT lần (R-12).
   */
  private async match(p: GoogleProfile, next: string | undefined, ctx: ReqCtx, retry: boolean): Promise<CallbackResult> {
    const done = this.web(next ?? '/dashboard');
    const idn = this.prisma.identity();
    const bySub = await idn.findUserByGoogleSub(p.sub);
    if (bySub) {
      if (bySub.isOperator) return { redirect: this.web('/login?error=operator_google_forbidden') };
      return { redirect: done, session: await this.login(bySub.id, ctx) };
    }
    const email = normalizeEmail(p.email);
    const byEmail = await idn.findUserByEmail(email);
    if (byEmail) {
      if (byEmail.isOperator) return { redirect: this.web('/login?error=operator_google_forbidden') };
      if (byEmail.googleSub) {
        await idn.recordAuthAudit({ userId: byEmail.id, action: 'google.link_mismatch', ip: ctx.ip, meta: { googleSub: p.sub } });
        return { redirect: this.web('/login?error=google_account_mismatch') };
      }
      // GO-2 (ADR-128): tự ghép vào tài khoản ĐÃ xác minh chỉ khi Google có thẩm quyền với email (gmail.com /
      // googlemail.com, hoặc Workspace với hd = domain email). Domain riêng có thể đổi chủ mà email_verified vẫn true.
      if (byEmail.emailVerifiedAt && !googleAuthoritative(email, p.hd)) {
        await idn.recordAuthAudit({ userId: byEmail.id, action: 'google.link_requires_password', ip: ctx.ip, meta: { googleSub: p.sub } });
        return { redirect: this.web('/login?error=google_link_requires_password') };
      }
      if (!byEmail.emailVerifiedAt) {
        // N-1 (ADR-121/127): mật khẩu/tên hiện có là của "ai đó đã đăng ký" — Google chứng minh hộp thư -> nhận tài khoản.
        await this.auth.claimAccount(byEmail.id, email, null, p.name, 'google_claimed');
        await idn.recordAuthAudit({ userId: byEmail.id, action: 'user.account_claimed', ip: ctx.ip, meta: { via: 'google' } });
      }
      if ((await idn.linkGoogle(byEmail.id, p.sub)) !== 1) {
        await idn.recordAuthAudit({ userId: byEmail.id, action: 'google.link_mismatch', ip: ctx.ip, meta: { googleSub: p.sub } });
        return { redirect: this.web('/login?error=google_account_mismatch') };
      }
      await idn.recordAuthAudit({ userId: byEmail.id, action: 'google.linked', ip: ctx.ip, meta: { googleSub: p.sub } });
      void this.mail
        .send({ to: byEmail.email, ...mailTemplates.googleLinked(p.name) })
        .catch((err) => logger.warn({ err: (err as Error).message, to: maskEmail(byEmail.email) }, 'Gửi mail google.linked thất bại'));
      return { redirect: done, session: await this.login(byEmail.id, ctx) };
    }
    let created: { userId: string };
    try {
      created = await this.auth.createUserWithFirstProject({ email, name: p.name, passwordHash: null, emailVerifiedAt: new Date(this.now()), googleSub: p.sub }, ctx);
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002' && retry) return this.match(p, next, ctx, false);
      throw e;
    }
    return { redirect: done, session: await this.login(created.userId, ctx) };
  }

  /** `POST /auth/google/unlink`: chỉ khi còn cách đăng nhập khác (mật khẩu hoặc GitHub) -> không thì 409 last_login_method. */
  async unlink(principal: UserPrincipal, ctx: ReqCtx): Promise<void> {
    const idn = this.prisma.identity();
    const user = await idn.findUserById(principal.id);
    if (!user) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');
    if (!user.googleSub) return; // chưa gắn: không có gì để gỡ
    // GO-1 (ADR-128): điều kiện "còn cách khác" nằm TRONG câu UPDATE — 0 dòng = không còn cách khác (kể cả do đua).
    if ((await idn.unlinkGoogle(user.id)) !== 1) {
      throw new HttpException({ error: 'last_login_method', message: 'Đặt mật khẩu hoặc liên kết GitHub trước khi gỡ Google' }, HttpStatus.CONFLICT);
    }
    await idn.recordAuthAudit({ userId: user.id, action: 'google.unlinked', ip: ctx.ip });
  }

  private async login(userId: string, ctx: ReqCtx) {
    const s = await this.auth.issueSession(userId, null, null, ctx);
    await this.prisma.identity().recordAuthAudit({ userId, action: 'auth.login_succeeded', ip: ctx.ip, meta: { via: 'google' } });
    return s;
  }

  /** Đổi code (kèm code_verifier) ở token endpoint CỐ ĐỊNH; KHÔNG lưu access token; chỉ đọc ID token đã kiểm. */
  private async exchange(code: string, verifier: string, nonce: string): Promise<GoogleProfile> {
    const res = await this.fetchImpl(this.g.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: this.g.clientId,
        client_secret: this.g.clientSecret,
        redirect_uri: this.redirectUri(),
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) throw new Error(`token_http_${res.status}${body.error ? `_${String(body.error).replace(/[^a-z_]/gi, '').slice(0, 40)}` : ''}`);
    return verifyGoogleIdToken(body.id_token, { jwks: this.jwks, clientId: this.g.clientId, nonce, now: this.now });
  }
}
