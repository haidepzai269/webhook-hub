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
