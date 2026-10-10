import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@hub/database';
import { AUTH_CONFIG, AuthConfig } from './auth-config';
import { signSocketTicket } from './tokens';
import { resolveProjectScope } from '../console/project-scope.guard';
import { UserPrincipal } from '../service-api/principal';

/**
 * SPEC-auth §5.7: `GET /auth/socket-ticket?projectId=` -> `{ticket}`. Quyền vào project kiểm bằng ĐÚNG luật của
 * console (`resolveProjectScope`) để HTTP và socket không bao giờ lệch nhau. Socket.IO không đi qua rewrites của
 * web (khác site ở deployed) nên dùng vé thay cookie.
 */
@Injectable()
export class SocketTicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  async issue(principal: UserPrincipal, projectId: unknown): Promise<{ ticket: string; projectId: string }> {
    const scoped = await resolveProjectScope(this.prisma, projectId, principal);
    return { ticket: signSocketTicket(this.jwt, this.cfg, { userId: principal.id, sessionId: principal.sessionId, projectId: scoped.projectId }), projectId: scoped.projectId };
  }
}
