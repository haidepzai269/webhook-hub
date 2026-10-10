import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { RequestWithPrincipal } from '../service-api/principal';

/**
 * `actor` cho audit log: id của user ĐÃ xác thực (SessionGuard gắn `request.principal`). DINH-CHINH-AUTH §4 #5:
 * từ AU1 actor = user.id (không còn chuỗi `admin`). Không bao giờ lấy từ body/header client gửi.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const p = ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
  if (!p || p.kind !== 'user' || !p.id) {
    throw new UnauthorizedException('Thiếu danh tính người dùng — route chưa được bảo vệ bởi SessionGuard');
  }
  return p.id;
});
