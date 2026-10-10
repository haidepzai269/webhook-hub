import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { MembersService } from '../auth/members.service';
import { reqCtx } from '../auth/auth.controller';
import { ProjectScopeGuard } from './project-scope.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';

const me = (req: RequestWithPrincipal) => req.principal as UserPrincipal;

/**
 * SPEC-auth §5.11 (AU4): thành viên + lời mời của MỘT project. `ProjectScopeGuard` đọc `:projectId` trên path
 * (tồn tại + thành viên/operator + scope) TRƯỚC khi vào handler.
 */
@Controller('api/v1/projects/:projectId')
@UseGuards(SessionGuard, ProjectScopeGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('members')
  @RequireScope('read:project')
  list(@Param('projectId') projectId: string) {
    return this.members.listMembers(projectId);
  }

  @Patch('members/:userId')
  @HttpCode(204)
  @RequireScope('manage:members')
  async changeRole(@Req() req: RequestWithPrincipal, @Param('projectId') projectId: string, @Param('userId') userId: string, @Body() body: any) {
    await this.members.changeRole(me(req), projectId, userId, body ?? {}, reqCtx(req as Request));
  }

  /** Xoá người khác cần manage:members (kiểm trong service); TỰ RỜI thì mọi thành viên đều được -> scope route = read:project. */
  @Delete('members/:userId')
  @HttpCode(204)
  @RequireScope('read:project')
  async remove(@Req() req: RequestWithPrincipal, @Param('projectId') projectId: string, @Param('userId') userId: string) {
    await this.members.removeMember(me(req), projectId, userId, reqCtx(req as Request));
  }

  @Get('invitations')
  @RequireScope('manage:members')
  listInvitations(@Param('projectId') projectId: string) {
    return this.members.listInvitations(projectId);
  }

  @Post('invitations')
  @RequireScope('manage:members')
  invite(@Req() req: RequestWithPrincipal, @Param('projectId') projectId: string, @Body() body: any) {
    return this.members.invite(me(req), projectId, body ?? {}, reqCtx(req as Request));
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequireScope('manage:members')
  async revoke(@Req() req: RequestWithPrincipal, @Param('projectId') projectId: string, @Param('id') id: string) {
    await this.members.revokeInvitation(me(req), projectId, id, reqCtx(req as Request));
  }
}
