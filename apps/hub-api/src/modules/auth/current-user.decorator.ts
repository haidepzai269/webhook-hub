import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { RequestWithTenant } from './jwt-auth.guard';

/**
 * `actor` cho audit log (S2-3): `sub` của JWT ĐÃ VERIFY (JwtAuthGuard gắn `request.user`).
 * Không bao giờ lấy từ body/header client gửi. Chỉ dùng trên route có JwtAuthGuard.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<RequestWithTenant>();
  const sub = request.user?.sub;
  if (typeof sub !== 'string' || !sub) {
    throw new UnauthorizedException('Thiếu danh tính người dùng — route chưa được bảo vệ bởi JwtAuthGuard');
  }
  return sub;
});
