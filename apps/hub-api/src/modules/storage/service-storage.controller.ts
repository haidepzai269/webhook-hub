import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { resolveStorageAutoCleanEnabled, resolveStorageLockEnabled } from '@hub/common';
import { ApiKeyGuard } from '../service-api/api-key.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { RequestWithPrincipal } from '../service-api/principal';
import { StorageFlags, applySuggestion, getCleanJob, getStorageOverview } from './storage-api';

/**
 * QT4b (SPEC-han-muc-dung-luong §5.6, ADR-187): hệ thống của user tự động hoá dọn dẹp — nhận webhook
 * `hub.project.cleanup_suggested`, quyết định, gọi lại `apply` bằng API key có `storage:write` (chỉ owner cấp được). Cùng
 * logic với console (`storage-api.ts`); `tenantId` lấy từ key (ApiKeyGuard), actor = `key:<id>` trong audit.
 */
@Controller('v1/p/:project')
@UseGuards(ApiKeyGuard)
export class ServiceStorageController {
  private readonly flags: StorageFlags = { lockEnabled: resolveStorageLockEnabled(), autoCleanEnabled: resolveStorageAutoCleanEnabled() };

  constructor(private readonly prisma: PrismaService) {}

  @Get('storage')
  @RequireScope('storage:read')
  overview(@Req() req: RequestWithPrincipal) {
    return getStorageOverview(this.prisma, req.tenantId!, this.flags);
  }

  @Post('storage/suggestions/:suggestionId/apply')
  @HttpCode(202)
  @RequireScope('storage:write')
  apply(@Req() req: RequestWithPrincipal, @Param('suggestionId') suggestionId: string) {
    return applySuggestion(this.prisma, req.tenantId!, suggestionId, `key:${req.apiKey!.id}`);
  }

  @Get('storage/clean/:jobId')
  @RequireScope('storage:read')
  cleanJob(@Req() req: RequestWithPrincipal, @Param('jobId') jobId: string) {
    return getCleanJob(this.prisma, req.tenantId!, jobId);
  }
}
