import { Controller, Get, Param, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { RedactSecretsInterceptor } from '../api/redact-secrets.interceptor';
import { FlowService } from './flow.service';

/**
 * Event Flow (SPEC-event-flow-ui §3) — CHỈ ĐỌC. Guard + interceptor y hệt `ApiController`: JWT,
 * tenant từ token (`@CurrentTenant()`), không trả ciphertext. AU3 thêm `@RequireScope('read:project')`
 * một lần ở đây cho cả module.
 */
@Controller('api/v1/flow')
@UseGuards(JwtAuthGuard)
@UseInterceptors(RedactSecretsInterceptor)
export class FlowController {
  constructor(private readonly flow: FlowService) {}

  @Get('events/:id')
  getEventFlow(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.flow.getEventFlow(tenantId, id);
  }
}
