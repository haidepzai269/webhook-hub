import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { SessionGuard } from '../auth/session.guard';
import { ProjectScopeGuard } from '../console/project-scope.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { getInsights, InsightQuery } from './insights-api';

/**
 * CB6 (SPEC-canh-bao-nhan-dinh §7): nhận định của MỘT project — KHÔNG chỉ operator: thành viên nào đọc được project
 * (`read:project`) thì thấy nhận định của project đó. `ProjectScopeGuard` đọc `:projectId` trên path (tồn tại + thành
 * viên/operator, cùng 404 cho "không có"/"không phải của bạn"); handler chỉ dùng `projectId` đã qua guard.
 */
@Controller('api/v1/projects/:projectId')
@UseGuards(SessionGuard, ProjectScopeGuard)
export class InsightsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('insights')
  @RequireScope('read:project')
  list(@Param('projectId') projectId: string, @Query() q: InsightQuery) {
    return getInsights(this.prisma, projectId, q);
  }
}
