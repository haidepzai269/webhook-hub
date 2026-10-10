import { Controller, Get, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { FlowProjectScopeGuard, FlowScope } from './flow-scope';
import { RedactSecretsInterceptor } from '../api/redact-secrets.interceptor';
import { RequireScope } from '../service-api/require-scope.decorator';
import { ExecutionQuery, FlowService } from './flow.service';

/**
 * Event Flow (SPEC-event-flow-ui §3) — CHỈ ĐỌC. Guard + interceptor y hệt `ApiController`: JWT,
 * tenant từ token (`@FlowScope()`), không trả ciphertext. AU3 thêm `@RequireScope('read:project')`
 * một lần ở đây cho cả module.
 */
@Controller('api/v1/flow')
// X2: JWT trước, rồi ProjectScopeGuard (qua FlowProjectScopeGuard) đọc `?projectId=` — không controller nào tự đọc.
@UseGuards(SessionGuard, FlowProjectScopeGuard)
// SPEC-auth §6.1: cả module chỉ đọc -> read:project (FlowProjectScopeGuard bọc ProjectScopeGuard, kiểm scope ở đó)
@RequireScope('read:project')
@UseInterceptors(RedactSecretsInterceptor)
export class FlowController {
  constructor(private readonly flow: FlowService) {}

  @Get('executions')
  listExecutions(@FlowScope() tenantId: string, @Query() q: ExecutionQuery) {
    return this.flow.listExecutions(tenantId, q);
  }

  @Get('topology')
  getTopology(@FlowScope() tenantId: string, @Query('window') window?: string) {
    return this.flow.getTopology(tenantId, window);
  }

  @Get('events/:id')
  getEventFlow(@FlowScope() tenantId: string, @Param('id') id: string) {
    return this.flow.getEventFlow(tenantId, id);
  }
}
