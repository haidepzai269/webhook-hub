import { NORMALIZE_RETRY_TTL_MS, RETRY_TIERS } from './topology';

/**
 * Cửa sổ "còn có thể retry" của một message trong hệ thống — NGUỒN DUY NHẤT (trước ở cleanup.job.ts của hub-worker; QT4
 * tách ra đây để hub-api kiểm `olderThan` của lệnh dọn bằng CÙNG hằng số, SPEC-han-muc-dung-luong §5.2, ADR-184).
 * Không khai topology ở đây (chỉ đọc hằng số của topology.ts).
 */

/** Số lần thử lại tối đa qua hàng đợi 30s trước khi vào DLQ (5 × 30s ≈ 2,5 phút). */
export const NORMALIZE_MAX_RETRIES = 5;

/**
 * BP2 (SPEC-ap-luc-nguoc §3.3, C2, ADR-196): trần THỜI GIAN một lần thử được hoãn vì circuit (OPEN / HALF_OPEN không giành
 * được probe) trước khi tính là một lần thử thất bại. Mặc định 30 phút = hành vi cũ (30 lần × tầng 1m). NGUỒN DUY NHẤT cho cả
 * hub-worker (trần) lẫn cửa sổ retry bên dưới (hub-api + worker dùng làm sàn dọn).
 */
export const CIRCUIT_MAX_DEFER_MS = 1_800_000;

/**
 * Đọc `CIRCUIT_MAX_DEFER_MS` từ env — CHỈ được kẹp THẤP HƠN mặc định (C2): đặt cao hơn mà `TOTAL_RETRY_WINDOW_MS` không đổi
 * theo thì sàn dọn của QT sai (dọn mất chốt chống trùng của message còn đang hoãn -> đích nhận trùng). Bậy -> mặc định.
 */
export function circuitMaxDeferMs(env: string | undefined = process.env.CIRCUIT_MAX_DEFER_MS): number {
  const n = Number(env);
  if (env === undefined || env === '' || !Number.isFinite(n) || n <= 0) return CIRCUIT_MAX_DEFER_MS;
  return Math.min(Math.floor(n), CIRCUIT_MAX_DEFER_MS);
}

/**
 * Tổng thời gian một message có thể còn "sống" trong hệ thống retry: 5 tầng delivery (10s+1m+5m+30m+2h) + 5 lần normalize
 * 30s + (BP2, C2) tối đa `CIRCUIT_MAX_DEFER_MS` hoãn vì circuit cho MỖI lần thử (6 lần: 1 lần đầu + 5 tầng).
 * processed_messages/outbox phải sống LÂU HƠN thế; dữ liệu mới hơn mốc này không được dọn/xoá (QT §5.2). ≈ 5h38m40s.
 */
export const TOTAL_RETRY_WINDOW_MS =
  RETRY_TIERS.reduce((sum, t) => sum + t.ttlMs, 0) +
  NORMALIZE_RETRY_TTL_MS * NORMALIZE_MAX_RETRIES +
  (RETRY_TIERS.length + 1) * CIRCUIT_MAX_DEFER_MS;

/** Mốc thời gian MỚI NHẤT được phép dọn/xoá: dữ liệu nhận SAU mốc này có thể còn đang retry. */
export function retryWindowFloor(now: number = Date.now()): Date {
  return new Date(now - TOTAL_RETRY_WINDOW_MS);
}

/** Lệnh dọn với `cutoff` (dọn dữ liệu nhận TRƯỚC cutoff) có an toàn không: cutoff ≤ now − cửa sổ retry. */
export function isCutoffOutsideRetryWindow(cutoff: Date, now: number = Date.now()): boolean {
  return cutoff instanceof Date && Number.isFinite(cutoff.getTime()) && cutoff.getTime() <= now - TOTAL_RETRY_WINDOW_MS;
}
