import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { resolveStorageAutoCleanEnabled, resolveStorageLockEnabled } from '@hub/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ProjectScopeGuard } from '../console/project-scope.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { StorageFlags, applySuggestion, createCleanJob, getCleanJob, getStorageOverview } from './storage-api';

/**
 * QT4 (SPEC-han-muc-dung-luong §5.5, ADR-184): trang "Dung lượng" của một project. Quyền = scope (`storage:read` cho
 * owner/developer/người vận hành; `storage:write` cho owner/người vận hành) — không có `if` theo vai trò trong controller.
 * Dọn = tạo LỆNH (202 + id), worker chạy theo lô; xem tiến độ ở `GET …/storage/clean/:jobId`.
 */
@Controller('api/v1/projects/:projectId')
@UseGuards(SessionGuard, ProjectScopeGuard)
export class StorageController {
  /** E5: đọc MỘT lần lúc khởi động — đổi cờ = đổi env + restart. */
  private readonly flags: StorageFlags = { lockEnabled: resolveStorageLockEnabled(), autoCleanEnabled: resolveStorageAutoCleanEnabled() };

  constructor(private readonly prisma: PrismaService) {}

  @Get('storage')
  @RequireScope('storage:read')
  overview(@Param('projectId') projectId: string) {
    return getStorageOverview(this.prisma, projectId, this.flags);
  }

  @Post('storage/clean')
  @HttpCode(202)
  @RequireScope('storage:write')
  clean(@Param('projectId') projectId: string, @CurrentUser() actor: string, @Body() body: unknown) {
    return createCleanJob(this.prisma, projectId, body, actor);
  }

  /** QT4b (§5.6, ADR-187): áp dụng gợi ý — tính lại tại thời điểm gọi, 409 `suggestion_stale` kèm bộ mới, idempotent theo id. */
  @Post('storage/suggestions/:suggestionId/apply')
  @HttpCode(202)
  @RequireScope('storage:write')
  apply(@Param('projectId') projectId: string, @Param('suggestionId') suggestionId: string, @CurrentUser() actor: string) {
    return applySuggestion(this.prisma, projectId, suggestionId, actor);
  }

  @Get('storage/clean/:jobId')
  @RequireScope('storage:read')
  cleanJob(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    return getCleanJob(this.prisma, projectId, jobId);
  }
}
