import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@hub/database';
import { verifyCsrfToken } from '@hub/common';
import { AUTH_CONFIG, AuthConfig } from './auth-config';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER, readCookie, readHeader } from './cookies';
import { verifyAccessToken } from './tokens';
import { authError } from './auth-errors';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';

export const AUTH_CLOCK = Symbol('AUTH_CLOCK');
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type SessionStore = Pick<PrismaService, 'identity'>;

/**
 * SPEC-auth §5.6 (thay JwtAuthGuard): xác thực NGƯỜI qua cookie `__Host-hub_at`.
 *   1. verify JWT (HS256 + iss + aud + exp)                         sai/thiếu  -> 401
 *   2. MỘT truy vấn theo khoá chính: session còn sống + user        thu hồi    -> 401 (logout-all có hiệu lực ngay)
 *   3. method thay đổi dữ liệu -> CSRF double-submit ký theo sid    sai/thiếu  -> 403 csrf_failed
 * Gắn `request.principal = {kind:'user', …}` + `request.user.sub` (actor của audit = user.id).
 * Không chạm Redis (quota Upstash, ADR-057).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly store: SessionStore,
    private readonly jwt: JwtService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Optional() @Inject(AUTH_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithPrincipal & { user?: { sub: string } }>();
    const token = readCookie(req, ACCESS_COOKIE);
    if (!token) throw authError(HttpStatus.UNAUTHORIZED, 'unauthenticated');
    const claims = verifyAccessToken(this.jwt, this.cfg, token);
    if (!claims) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');

    const session = await this.store.identity().findLiveSessionWithUser(claims.sid, this.now());
    if (!session || session.userId !== claims.sub) throw authError(HttpStatus.UNAUTHORIZED, 'session_expired');

    if (MUTATING.has(String(req.method).toUpperCase())) {
      const ok = verifyCsrfToken(this.cfg.csrfSecret, session.id, readCookie(req, CSRF_COOKIE), readHeader(req.headers as Record<string, unknown>, CSRF_HEADER));
      if (!ok) throw authError(HttpStatus.FORBIDDEN, 'csrf_failed');
    }

    const u = session.user;
    const principal: UserPrincipal = {
      kind: 'user',
      id: u.id,
      sessionId: session.id,
      email: u.email,
      name: u.name,
      isOperator: u.isOperator,
      emailVerified: !!u.emailVerifiedAt,
    };
    req.principal = principal;
    req.user = { sub: u.id };
    return true;
  }
}
