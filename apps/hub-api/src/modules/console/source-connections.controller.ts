import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { SessionGuard } from '../auth/session.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { RedactSecretsInterceptor } from '../api/redact-secrets.interceptor';
import { ProjectScopeGuard } from './project-scope.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { SourceConnectionService } from './source-connection.service';

/**
 * KN2 (SPEC-ket-noi §4.4, ADR-138): "Kết nối <provider>" — hub tạo source và tự đăng ký URL ingest tại provider.
 * MỌI route cần `manage:sources` (§4.3 điều 4); source của project khác -> 404 giống hệt id lạ. Không route nào trả
 * credentials (chỉ `hasCredentials` + 4 ký tự cuối) — `RedactSecretsInterceptor` là lưới thứ hai (`credentialsEncrypted`).
 * Controller riêng (như FlowModule) để không đụng `ApiController`.
 */
@Controller('api/v1')
@UseGuards(SessionGuard, ProjectScopeGuard)
@UseInterceptors(RedactSecretsInterceptor)
export class SourceConnectionsController {
  private readonly svc: SourceConnectionService;

  constructor(prisma: PrismaService) {
    this.svc = new SourceConnectionService(prisma);
  }

  /** Provider nào có connector + các ô của form (UI dựng form từ `fields`). */
  @Get('connectors')
  @RequireScope('manage:sources')
  connectors() {
    return this.svc.listConnectors();
  }

  /** Luôn 201 kể cả FAILED (source giữ lại, `fix` nói cách sửa) — giống tạo endpoint. */
  @Post('sources/connect')
  @RequireScope('manage:sources')
  connect(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Body() body: any) {
    return this.svc.connect(tenantId, `user:${userId}`, body);
  }

  /**
   * H-1 (ADR-151): gắn connector vào source CÓ SẴN (giữ sourceKey -> service đang ghim source đó vẫn nhận). Không tạo source.
   * Luôn 201 kể cả FAILED, như `sources/connect`.
   */
  @Post('sources/:id/connect')
  @RequireScope('manage:sources')
  connectExisting(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.svc.connectExisting(tenantId, `user:${userId}`, id, body ?? {});
  }

  @Post('sources/:id/connection/retry')
  @HttpCode(200)
  @RequireScope('manage:sources')
  retry(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Param('id') id: string, @Body() body: any) {
    return this.svc.retry(tenantId, `user:${userId}`, id, body ?? {});
  }

  @Get('sources/:id/connection')
  @RequireScope('manage:sources')
  status(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.svc.status(tenantId, id);
  }

  @Delete('sources/:id/connection')
  @RequireScope('manage:sources')
  disconnect(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Param('id') id: string) {
    return this.svc.disconnect(tenantId, `user:${userId}`, id);
  }

  @Delete('sources/:id/connection/credentials')
  @RequireScope('manage:sources')
  deleteCredentials(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Param('id') id: string) {
    return this.svc.deleteCredentials(tenantId, `user:${userId}`, id);
  }
}
