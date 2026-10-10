import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { RequestWithPrincipal } from '../service-api/principal';

/**
 * Đọc `tenantId` (= project đang xem) mà guard phạm vi project đã đặt (`ProjectScopeGuard` / `ApiKeyGuard`).
 * KHÔNG BAO GIỜ đọc từ JWT, body hay header client gửi (SPEC-auth §5.6).
 */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
  if (!request.tenantId) {
    // Báo lỗi rõ thay vì để lọt truy vấn không scope (BB-5).
    throw new UnauthorizedException('Thiếu tenantId — route chưa đi qua guard phạm vi project');
  }
  return request.tenantId;
});
