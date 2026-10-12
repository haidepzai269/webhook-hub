import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RequestWithPrincipal } from '../service-api/principal';
import { hubError } from '../errors/hub-error';

/**
 * CB3 (SPEC-canh-bao-nhan-dinh Q1, §5.2, ADR-169): route CHỈ cho người vận hành hub (`users.is_operator`). Chạy SAU
 * `SessionGuard` — cờ `isOperator` lấy từ CHÍNH truy vấn session/user của guard đó (không tin gì client gửi).
 * Không phải operator -> 403 `operator_required` theo khuôn lỗi (owner của project cũng nhận mã này).
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const p = context.switchToHttp().getRequest<RequestWithPrincipal>().principal;
    if (!p || p.kind !== 'user') throw new HttpException({ error: 'unauthenticated', message: 'Chưa đăng nhập' }, HttpStatus.UNAUTHORIZED);
    if (!p.isOperator) throw hubError('operator_required', {}, 'Chỉ người vận hành hub xem và cấu hình cảnh báo');
    return true;
  }
}
