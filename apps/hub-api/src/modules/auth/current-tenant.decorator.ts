import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { RequestWithTenant } from './jwt-auth.guard';

/**
 * Đọc `tenantId` đã được `JwtAuthGuard` gắn vào `request` (verify từ JWT) —
 * thay cho việc controller tự đọc header `x-tenant-id` do client gửi.
 * Chỉ dùng được trên route đã áp `JwtAuthGuard`.
 */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<RequestWithTenant>();
  if (!request.tenantId) {
    // Không nên xảy ra nếu JwtAuthGuard đã chạy trước — báo lỗi rõ ràng thay vì
    // âm thầm trả về undefined và để lọt truy vấn không scope (BB-5).
    throw new UnauthorizedException('Thiếu tenantId — route chưa được bảo vệ bởi JwtAuthGuard');
  }
  return request.tenantId;
});
