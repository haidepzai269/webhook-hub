import { NORMALIZE_RETRY_TTL_MS, RETRY_TIERS, retryQueueForDelay } from './topology';

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
/** Kẹp dưới của `CIRCUIT_MAX_DEFER_MS` khi đặt qua env: không ngắn hơn một vòng hoãn (tầng 1m). */
export const CIRCUIT_MAX_DEFER_MIN_MS = 60_000;
/**
 * BP3 (SPEC-ap-luc-nguoc §4, C4, C6 Q2, ADR-197): thời lượng OPEN của circuit — lần đầu 60s, từ lần probe thất bại thứ nhất là
 * `CIRCUIT_OPEN_MAX_MS` (mặc định 300s). Hai giá trị khớp đúng hai tầng TTL sẵn có (`retry.1m`, `retry.5m`) — không thêm queue,
 * không sửa topology. NGUỒN DUY NHẤT cho circuit breaker (hub-worker) lẫn cửa sổ retry bên dưới.
 */
export const CIRCUIT_OPEN_MS = 60_000;
export const CIRCUIT_OPEN_MAX_MS = 300_000;

/**
 * `CIRCUIT_OPEN_MAX_SECONDS` từ env, kẹp trong 60..300 (chỉ được THẤP hơn mặc định — cửa sổ retry tính theo mặc định). Bậy -> 300.
 */
export function circuitOpenMaxSeconds(env: string | undefined = process.env.CIRCUIT_OPEN_MAX_SECONDS): number {
  const n = Number(env);
  const max = CIRCUIT_OPEN_MAX_MS / 1000;
  if (env === undefined || env === '' || !Number.isFinite(n) || n <= 0) return max;
  return Math.max(CIRCUIT_OPEN_MS / 1000, Math.min(Math.floor(n), max));
}

/**
 * Tầng hoãn vì circuit — MỘT nguồn cho consumer (hoãn thật) và cửa sổ retry (review BP2 §16): hoãn tới hết OPEN theo PTTL
 * thật của `:open` mà gate trả về (C4) -> tầng ngắn nhất có TTL ≥ PTTL (`retry.1m` hoặc `retry.5m`). Không biết PTTL (HALF_OPEN
 * không giành probe, PTTL lạ) -> một nhịp OPEN đầu (1m), như cũ.
 */
export function circuitDeferTier(openPttlMs?: number): { queueName: string; ttlMs: number } {
  const pttl = typeof openPttlMs === 'number' && Number.isFinite(openPttlMs) && openPttlMs > 0 ? Math.min(openPttlMs, CIRCUIT_OPEN_MAX_MS) : CIRCUIT_OPEN_MS;
  return retryQueueForDelay(pttl);
}

/**
 * Một vòng hoãn vì circuit DÀI NHẤT (BP3: OPEN 300s -> `retry.5m`). Trần hoãn chỉ được kiểm mỗi vòng, nên một lần thử có thể
 * hoãn tới `max + 1 vòng` (review BP2 TH-5) — cửa sổ retry cộng thêm một vòng cho mỗi lần thử.
 */
export const CIRCUIT_DEFER_ROUND_MS = circuitDeferTier(CIRCUIT_OPEN_MAX_MS).ttlMs;

/**
 * Đọc `CIRCUIT_MAX_DEFER_MS` từ env — CHỈ được kẹp THẤP HƠN mặc định (C2): đặt cao hơn mà `TOTAL_RETRY_WINDOW_MS` không đổi
 * theo thì sàn dọn của QT sai (dọn mất chốt chống trùng của message còn đang hoãn -> đích nhận trùng). Bậy -> mặc định.
 */
export function circuitMaxDeferMs(env: string | undefined = process.env.CIRCUIT_MAX_DEFER_MS): number {
  const n = Number(env);
  if (env === undefined || env === '' || !Number.isFinite(n) || n <= 0) return CIRCUIT_MAX_DEFER_MS;
  // Review BP2 TH-2: kẹp dưới ≥ 1 vòng hoãn (60s) — '0.5'/'1' không được biến mỗi lần OPEN thành một lượt thử đốt ngay.
  return Math.max(CIRCUIT_MAX_DEFER_MIN_MS, Math.min(Math.floor(n), CIRCUIT_MAX_DEFER_MS));
}

/**
 * Tổng thời gian một message có thể còn "sống" trong hệ thống retry: 5 tầng delivery (10s+1m+5m+30m+2h) + 5 lần normalize
 * 30s + (BP2, C2) tối đa `CIRCUIT_MAX_DEFER_MS` hoãn vì circuit cho MỖI lần thử (6 lần: 1 lần đầu + 5 tầng).
 * + một vòng hoãn DÀI NHẤT mỗi lần thử (trần kiểm theo vòng; BP3: 5 phút). processed_messages/outbox phải sống LÂU HƠN thế;
 * dữ liệu mới hơn mốc này không được dọn/xoá (QT §5.2). ≈ 6h08m40s.
 */
export const TOTAL_RETRY_WINDOW_MS =
  RETRY_TIERS.reduce((sum, t) => sum + t.ttlMs, 0) +
  NORMALIZE_RETRY_TTL_MS * NORMALIZE_MAX_RETRIES +
  (RETRY_TIERS.length + 1) * (CIRCUIT_MAX_DEFER_MS + CIRCUIT_DEFER_ROUND_MS);

/** Mốc thời gian MỚI NHẤT được phép dọn/xoá: dữ liệu nhận SAU mốc này có thể còn đang retry. */
export function retryWindowFloor(now: number = Date.now()): Date {
  return new Date(now - TOTAL_RETRY_WINDOW_MS);
}

/** Lệnh dọn với `cutoff` (dọn dữ liệu nhận TRƯỚC cutoff) có an toàn không: cutoff ≤ now − cửa sổ retry. */
export function isCutoffOutsideRetryWindow(cutoff: Date, now: number = Date.now()): boolean {
  return cutoff instanceof Date && Number.isFinite(cutoff.getTime()) && cutoff.getTime() <= now - TOTAL_RETRY_WINDOW_MS;
}
