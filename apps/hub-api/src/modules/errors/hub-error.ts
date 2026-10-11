import { HttpException } from '@nestjs/common';
import { ERROR_CATALOG, HubErrorCode } from '@hub/common';

/**
 * DX1 §2.4: ném lỗi theo catalog — status lấy từ catalog, `params` chỉ là các tham số khai ở catalog (filter lọc lại
 * lần nữa). `detail` (tuỳ chọn) = câu tiếng Việt cho console (ADR-136).
 */
export function hubError(code: HubErrorCode, params: Record<string, unknown> = {}, detail?: string): HttpException {
  return new HttpException({ error: code, ...params, ...(detail ? { message: detail } : {}) }, ERROR_CATALOG[code].status);
}
