import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Lỗi auth theo định dạng tạm `{error, message}` (DX1 chưa có — DINH-CHINH-AUTH §4 #10).
 * Body CỐ ĐỊNH theo mã: hai nhánh khác nhau (email không tồn tại / sai mật khẩu) ra cùng một body.
 */
const MESSAGES: Record<string, string> = {
  unauthenticated: 'Chưa đăng nhập',
  session_expired: 'Phiên đăng nhập đã hết hạn hoặc bị thu hồi',
  refresh_race: 'Phiên vừa được làm mới ở tab khác — thử lại',
  invalid_credentials: 'Email hoặc mật khẩu không đúng',
  csrf_failed: 'Thiếu hoặc sai CSRF token',
  too_many_attempts: 'Thử quá nhiều lần — đợi rồi thử lại',
  not_found: 'Không tìm thấy',
  project_required: 'Thiếu ?projectId=',
};

export function authError(status: HttpStatus, error: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ error, message: MESSAGES[error] ?? error, ...extra }, status);
}

export class TooManyAttempts extends HttpException {
  constructor(readonly retryAfterS: number) {
    super({ error: 'too_many_attempts', message: MESSAGES.too_many_attempts }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
