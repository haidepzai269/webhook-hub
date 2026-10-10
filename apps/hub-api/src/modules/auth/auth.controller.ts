import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService, ReqCtx } from './auth.service';
import { SessionGuard } from './session.guard';
import { SocketTicketService } from './socket-ticket.service';
import { MembersService } from './members.service';
import { GithubOAuthService, OAUTH_COOKIE } from './github-oauth.service';
import { clearSessionCookies, CSRF_COOKIE, CSRF_HEADER, readCookie, readHeader, REFRESH_COOKIE, setSessionCookies } from './cookies';
import { TooManyAttempts } from './auth-errors';
import { clientIp } from './client-ip';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';
import { PublicRoute } from '../service-api/require-scope.decorator';

/** 429 kèm `Retry-After` (SPEC-auth §5.5). */
@Catch(TooManyAttempts)
export class TooManyAttemptsFilter implements ExceptionFilter {
  catch(e: TooManyAttempts, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Retry-After', String(e.retryAfterS));
    res.status(e.getStatus()).json(e.getResponse());
  }
}

export function reqCtx(req: Request): ReqCtx {
  // `req.ip` = địa chỉ socket, hoặc X-Forwarded-For CHỈ khi `trust proxy` bật (TRUST_PROXY=1, main.ts).
  // R-2: đi qua proxy web có secret hợp lệ -> IP client do web chuyển tiếp (client-ip.ts).
  const ua = req.headers?.['user-agent'];
  return { ip: clientIp(req as never), userAgent: typeof ua === 'string' ? ua : null };
}

/**
 * R-10 (review AU, ADR-114): login/register CHỈ nhận `application/json`. Form urlencoded / text/plain là "simple request"
 * — trang lạ POST được mà không preflight (login CSRF: đăng nhập nạn nhân vào tài khoản kẻ tấn công). JSON cross-origin
 * buộc preflight, mà CORS đã khoá origin. Sai kiểu -> 415.
 */
export function requireJsonBody(req: Pick<Request, 'headers'>): void {
  const ct = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    throw new HttpException({ error: 'unsupported_media_type', message: 'Chỉ nhận Content-Type: application/json' }, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  }
}

const user = (req: RequestWithPrincipal) => req.principal as UserPrincipal;

/**
 * SPEC-auth §6. Route công khai: register, login, refresh (cookie rt + CSRF). Còn lại: SessionGuard
 * (cookie access + CSRF cho method thay đổi dữ liệu). Token chỉ đi qua cookie, không bao giờ trong body.
 */
@Controller('auth')
@PublicRoute('đăng ký/đăng nhập công khai; route có SessionGuard chỉ đụng phiên/tài khoản CỦA CHÍNH người gọi, không theo project')
@UseFilters(TooManyAttemptsFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tickets: SocketTicketService,
    private readonly members: MembersService,
    private readonly github: GithubOAuthService,
  ) {}

  // ---------------------------------------------------------------- AU5: GitHub OAuth (SPEC-auth §5.10)

  @Get('github')
  githubStart(@Res() res: Response) {
    const s = this.github.start();
    res.cookie(s.cookie.name, s.cookie.value, s.cookie.options);
    res.redirect(302, s.redirectUrl);
  }

  /** Cookie state/PKCE dùng MỘT lần: xoá ngay, kể cả khi lỗi. state sai -> 400 oauth_state_mismatch. */
  @Get('github/callback')
  async githubCallback(@Req() req: RequestWithPrincipal, @Res() res: Response, @Query() q: Record<string, unknown>) {
    const sealed = readCookie(req, OAUTH_COOKIE);
    res.clearCookie(OAUTH_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    const r = await this.github.callback({ code: q?.code, state: q?.state }, sealed, reqCtx(req));
    if (r.session) setSessionCookies(res, r.session);
    res.redirect(302, r.redirect);
  }

  @Post('github/unlink')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  async githubUnlink(@Req() req: RequestWithPrincipal) {
    await this.github.unlink(user(req), reqCtx(req));
  }

  /** AU4 (§5.11): nhận lời mời — email đăng nhập phải trùng email được mời (403 invite_email_mismatch). */
  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  acceptInvitation(@Req() req: RequestWithPrincipal, @Body() body: any) {
    requireJsonBody(req); // N-3 (ADR-123): mọi POST có body của /auth chỉ nhận JSON
    return this.members.acceptInvitation(user(req), body ?? {}, reqCtx(req));
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Req() req: Request, @Body() body: any) {
    requireJsonBody(req);
    // R-6 (ADR-120): KHÔNG cookie, body cố định — email mới hay đã có trông giống hệt nhau.
    const r = await this.auth.register(body ?? {}, reqCtx(req));
    return r.body;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
    requireJsonBody(req);
    const r = await this.auth.login(body ?? {}, reqCtx(req));
    setSessionCookies(res, r.session);
    return r.body;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refresh(@Req() req: RequestWithPrincipal, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.refresh(
      readCookie(req, REFRESH_COOKIE),
      readCookie(req, CSRF_COOKIE),
      readHeader(req.headers as Record<string, unknown>, CSRF_HEADER),
      reqCtx(req),
    );
    setSessionCookies(res, s);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  async logout(@Req() req: RequestWithPrincipal, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user(req), reqCtx(req));
    clearSessionCookies(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  async logoutAll(@Req() req: RequestWithPrincipal, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(user(req), reqCtx(req));
    clearSessionCookies(res);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: RequestWithPrincipal) {
    return this.auth.me(user(req).id);
  }

  @Get('sessions')
  @UseGuards(SessionGuard)
  sessions(@Req() req: RequestWithPrincipal) {
    return this.auth.listSessions(user(req));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  async revokeSession(@Req() req: RequestWithPrincipal, @Param('id') id: string) {
    await this.auth.revokeSession(user(req), id, reqCtx(req));
  }

  // ---------------------------------------------------------------- AU2: email + mật khẩu (SPEC-auth §5.2, §5.9)

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
    requireJsonBody(req); // N-3 (ADR-123): mọi POST có body của /auth chỉ nhận JSON
    // R-6: link xác minh đăng nhập luôn (đăng ký không còn tự đăng nhập).
    const r = await this.auth.verifyEmail(body ?? {}, reqCtx(req));
    setSessionCookies(res, r.session);
    return r.body;
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SessionGuard)
  async resendVerification(@Req() req: RequestWithPrincipal) {
    await this.auth.resendVerification(user(req), reqCtx(req));
    return { ok: true };
  }

  /** LUÔN 202 `{ok:true}` dù email có hay không (§5.2). */
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Req() req: Request, @Body() body: any) {
    requireJsonBody(req); // N-3 (ADR-123): mọi POST có body của /auth chỉ nhận JSON
    await this.auth.forgotPassword(body ?? {}, reqCtx(req));
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
    requireJsonBody(req); // N-3 (ADR-123): mọi POST có body của /auth chỉ nhận JSON
    await this.auth.resetPassword(body ?? {}, reqCtx(req));
    clearSessionCookies(res); // mọi phiên đã bị thu hồi
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  async changePassword(@Req() req: RequestWithPrincipal, @Body() body: any) {
    requireJsonBody(req); // N-3 (ADR-123): mọi POST có body của /auth chỉ nhận JSON
    await this.auth.changePassword(user(req), body ?? {}, reqCtx(req));
  }

  /** §5.7: vé socket 60 giây cho đúng một project mà người gọi được vào. */
  @Get('socket-ticket')
  @UseGuards(SessionGuard)
  socketTicket(@Req() req: RequestWithPrincipal, @Query('projectId') projectId: unknown) {
    return this.tickets.issue(user(req), projectId);
  }
}
