/**
 * Phân loại kết quả HTTP của MỘT lần giao — nguồn sự thật DUY NHẤT (CB1, SPEC-canh-bao-nhan-dinh §4 ghi chú thiết kế).
 * `apps/hub-worker/src/consumers/delivery.consumer.ts` dùng hàm này để quyết retry / DEAD / circuit; luật cảnh báo
 * (`libs/common/src/alerts/rules.ts`) và insight `I-dest` dùng CHÍNH hàm này, không định nghĩa bản thứ hai (CB:T16).
 *
 * "Hiểu bản chất webhook" nằm ở đây:
 * - 2xx: bên nhận đã nhận.
 * - 401/403: bên nhận từ chối xác thực — retry vô ích (secret/token phía nhận đã đổi). DEAD ngay.
 * - 4xx khác (trừ 408/429): request bị từ chối về nội dung/cấu hình (404 sai URL, 400/422 payload) — retry vô ích. DEAD ngay.
 * - 408/429: bên nhận bảo "chậm lại" — retry được.
 * - 5xx: bên nhận lỗi — hub retry giúp.
 * - status < 100 (sender quy lỗi mạng/timeout về 500; 0 = không gọi đích / không có phản hồi): retry được.
 * - 1xx/3xx còn lại: không phải thành công, không phải lỗi cấu hình rõ ràng — retry được (hành vi cũ giữ nguyên).
 */
export type HttpOutcome = 'success' | 'auth_rejected' | 'client_error' | 'throttled' | 'server_error' | 'no_response' | 'unexpected';

export function classifyHttpOutcome(status: number | null | undefined): HttpOutcome {
  if (status === null || status === undefined || !Number.isFinite(status) || status < 100) return 'no_response';
  if (status >= 200 && status < 300) return 'success';
  if (status === 401 || status === 403) return 'auth_rejected';
  if (status === 408 || status === 429) return 'throttled';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'unexpected';
}

/**
 * §7.3: 4xx (trừ 408, 429) là lỗi cấu hình/client -> DEAD ngay, không retry. Bảng quyết định cũ của delivery.consumer:
 * `status >= 400 && status < 500 && status !== 408 && status !== 429` — giữ y nguyên (test bảng quyết định).
 */
export function isNonRetryableHttpStatus(status: number): boolean {
  const o = classifyHttpOutcome(status);
  return o === 'auth_rejected' || o === 'client_error';
}

/** Thất bại mà hub SẼ retry (5xx, 408/429, mạng/timeout, 1xx/3xx) — luật `destination.failing` đếm loại này. */
export function isRetryableFailure(status: number | null | undefined): boolean {
  const o = classifyHttpOutcome(status);
  return o !== 'success' && o !== 'auth_rejected' && o !== 'client_error';
}

/**
 * Review SPEC-2 #3 (ADR-054): chỉ lỗi cho thấy ĐÍCH đang hỏng mới tính vào circuit — 5xx, 408, 429 và
 * không có phản hồi (sender trả 500 khi lỗi mạng/timeout; status < 100 phòng hờ). 4xx khác là lỗi cấu
 * hình/nội dung của CHÍNH ta (404 sai URL, 400 payload, 401 sai token): đích vẫn sống, mở circuit vì
 * chúng sẽ hoãn oan mọi delivery khác của đích đó. (1xx/3xx: không tính — hành vi cũ.)
 */
export function countsTowardCircuit(status: number): boolean {
  const o = classifyHttpOutcome(status);
  return o === 'server_error' || o === 'throttled' || o === 'no_response';
}
