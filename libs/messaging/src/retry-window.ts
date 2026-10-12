import { NORMALIZE_RETRY_TTL_MS, RETRY_TIERS } from './topology';

/**
 * Cửa sổ "còn có thể retry" của một message trong hệ thống — NGUỒN DUY NHẤT (trước ở cleanup.job.ts của hub-worker; QT4
 * tách ra đây để hub-api kiểm `olderThan` của lệnh dọn bằng CÙNG hằng số, SPEC-han-muc-dung-luong §5.2, ADR-184).
 * Không khai topology ở đây (chỉ đọc hằng số của topology.ts).
 */

/** Số lần thử lại tối đa qua hàng đợi 30s trước khi vào DLQ (5 × 30s ≈ 2,5 phút). */
export const NORMALIZE_MAX_RETRIES = 5;

/**
 * Tổng thời gian một message có thể còn "sống" trong hệ thống retry: 5 tầng delivery (10s+1m+5m+30m+2h) + 5 lần normalize
 * 30s. processed_messages/outbox phải sống LÂU HƠN thế; dữ liệu mới hơn mốc này không được dọn/xoá (QT §5.2).
 */
export const TOTAL_RETRY_WINDOW_MS =
  RETRY_TIERS.reduce((sum, t) => sum + t.ttlMs, 0) + NORMALIZE_RETRY_TTL_MS * NORMALIZE_MAX_RETRIES;

/** Mốc thời gian MỚI NHẤT được phép dọn/xoá: dữ liệu nhận SAU mốc này có thể còn đang retry. */
export function retryWindowFloor(now: number = Date.now()): Date {
  return new Date(now - TOTAL_RETRY_WINDOW_MS);
}

/** Lệnh dọn với `cutoff` (dọn dữ liệu nhận TRƯỚC cutoff) có an toàn không: cutoff ≤ now − cửa sổ retry. */
export function isCutoffOutsideRetryWindow(cutoff: Date, now: number = Date.now()): boolean {
  return cutoff instanceof Date && Number.isFinite(cutoff.getTime()) && cutoff.getTime() <= now - TOTAL_RETRY_WINDOW_MS;
}
