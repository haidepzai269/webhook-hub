import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { clientIp } from '../auth/client-ip';
import { OperatorGuard } from '../console/operator.guard';
import { NoProjectScope } from '../service-api/require-scope.decorator';
import { RequestWithPrincipal } from '../service-api/principal';
import {
  AlertListQuery,
  ackAlert,
  ackAllAlerts,
  alertSummary,
  getAlertPreferences,
  listAlerts,
  putAlertPreferences,
  putUserLocale,
} from './alerts-api';

const OPERATOR_SCOPE = 'chuông của operator nhìn MỌI project (SPEC-canh-bao §5.2) — OperatorGuard, đọc qua escape hatch có tên';

/**
 * CB3 (SPEC-canh-bao-nhan-dinh §5.2, ADR-169): API cảnh báo + tuỳ chọn cảnh báo — CHỈ operator (`OperatorGuard` sau
 * `SessionGuard`; người khác 403 `operator_required`). Không qua `ProjectScopeGuard`: chuông là xuyên project.
 * Test gửi thử email (CB5) và insights (CB6) KHÔNG ở đây.
 */
@Controller('api/v1')
@UseGuards(SessionGuard, OperatorGuard)
export class AlertsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('alerts')
  @NoProjectScope(OPERATOR_SCOPE)
  list(@Query() q: AlertListQuery) {
    return listAlerts(this.prisma, q);
  }

  @Get('alerts/summary')
  @NoProjectScope(OPERATOR_SCOPE)
  summary() {
    return alertSummary(this.prisma);
  }

  @Post('alerts/ack-all')
  @HttpCode(HttpStatus.OK)
  @NoProjectScope(OPERATOR_SCOPE)
  ackAll(@Body() body: unknown, @Query() q: Record<string, unknown>, @CurrentUser() actor: string) {
    return ackAllAlerts(this.prisma, body, q, actor);
  }

  @Post('alerts/:id/ack')
  @HttpCode(HttpStatus.OK)
  @NoProjectScope(OPERATOR_SCOPE)
  ack(@Param('id') id: string, @CurrentUser() actor: string) {
    return ackAlert(this.prisma, id, actor);
  }

  @Get('me/alert-preferences')
  @NoProjectScope('tuỳ chọn cảnh báo gắn NGƯỜI (IdentityRepository), chỉ operator')
  getPreferences(@CurrentUser() userId: string) {
    return getAlertPreferences(this.prisma, userId);
  }

  @Put('me/alert-preferences')
  @NoProjectScope('tuỳ chọn cảnh báo gắn NGƯỜI (IdentityRepository), chỉ operator')
  putPreferences(@Req() req: RequestWithPrincipal, @CurrentUser() userId: string, @Body() body: unknown) {
    return putAlertPreferences(this.prisma, userId, body, clientIp(req));
  }
}

/** DINH-CHINH D3: ngôn ngữ của CHÍNH người dùng (mọi người dùng — nút Ngôn ngữ của console gọi; worker đọc cho email). */
@Controller('api/v1/me')
@UseGuards(SessionGuard)
export class MeLocaleController {
  constructor(private readonly prisma: PrismaService) {}

  @Put('locale')
  @NoProjectScope('ngôn ngữ của CHÍNH người gọi — users.locale qua IdentityRepository')
  putLocale(@Req() req: RequestWithPrincipal, @CurrentUser() userId: string, @Body() body: unknown) {
    return putUserLocale(this.prisma, userId, body, clientIp(req));
  }
}
