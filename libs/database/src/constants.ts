export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * MASTER_KEY dùng để mã hoá/giải mã AES-256-GCM cho các secret nhạy cảm:
 * source_secrets.secret_encrypted, destinations.config_encrypted,
 * destinations.signing_secret_encrypted.
 *
 * KHÔNG có giá trị fallback ngầm ở đây. Trước đây từng có
 * `DEV_MASTER_KEY = process.env.MASTER_KEY || 'dev-master-secret-key-at-least-32-chars!'`,
 * nhưng giá trị fallback đó trùng với giá trị mẫu công khai trong `.env.example`
 * (đã commit lên git) — nếu quên set MASTER_KEY khi deploy thật, toàn bộ secret
 * khách hàng sẽ bị mã hoá bằng một key ai cũng đọc được trên GitHub, mà không có
 * gì báo lỗi. Đã xoá bỏ hoàn toàn.
 *
 * apps/hub-api/src/main.ts và apps/hub-worker/src/main.ts đã kiểm tra MASTER_KEY
 * lúc bootstrap (process.exit(1) nếu thiếu hoặc < 32 ký tự) nên trong luồng chạy
 * thật, hàm này luôn có giá trị hợp lệ khi được gọi. Hàm vẫn tự kiểm tra để an
 * toàn cho các entrypoint khác không đi qua main.ts (vd. seed script, test script).
 */
export function getMasterKey(): string {
  const key = process.env.MASTER_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      'FATAL: MASTER_KEY thiếu hoặc quá ngắn (yêu cầu tối thiểu 32 ký tự) — không thể mã hoá/giải mã secret.',
    );
  }
  return key;
}

/**
 * Delivery CHƯA tới đích (còn đang chờ / gửi / thử lại). NGUỒN DUY NHẤT cho mọi đường xoá `events` theo tuổi hay theo lệnh
 * dọn: event còn delivery ở các trạng thái này KHÔNG được xoá — FK `deliveries.event_id` là CASCADE, xoá event là xoá luôn
 * delivery đang chờ, worker gặp `!row` thì ack -> mất webhook âm thầm (ADR-199). Dùng trong SQL qua
 * `IN_FLIGHT_DELIVERY_STATUS_SQL` (danh sách hằng, không tham số người dùng).
 */
export const IN_FLIGHT_DELIVERY_STATUSES = ['PENDING', 'DELIVERING', 'RETRYING'] as const;
