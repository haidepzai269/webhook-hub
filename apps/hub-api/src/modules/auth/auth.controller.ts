import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  HttpCode,
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
import { clearSessionCookies, CSRF_COOKIE, CSRF_HEADER, readCookie, readHeader, REFRESH_COOKIE, setSessionCookies } from './cookies';
import { TooManyAttempts } from './auth-errors';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';

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
  const ua = req.headers?.['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null };
}

const user = (req: RequestWithPrincipal) => req.principal as UserPrincipal;

/**
 * SPEC-auth §6. Route công khai: register, login, refresh (cookie rt + CSRF). Còn lại: SessionGuard
 * (cookie access + CSRF cho method thay đổi dữ liệu). Token chỉ đi qua cookie, không bao giờ trong body.
 */
@Controller('auth')
@UseFilters(TooManyAttemptsFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tickets: SocketTicketService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
    const r = await this.auth.register(body ?? {}, reqCtx(req));
    if (r.session) setSessionCookies(res, r.session);
    return r.body;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: any) {
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

  /** §5.7: vé socket 60 giây cho đúng một project mà người gọi được vào. */
  @Get('socket-ticket')
  @UseGuards(SessionGuard)
  socketTicket(@Req() req: RequestWithPrincipal, @Query('projectId') projectId: unknown) {
    return this.tickets.issue(user(req), projectId);
  }
}
