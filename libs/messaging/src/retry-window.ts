import { NORMALIZE_RETRY_TTL_MS, RETRY_TIERS, retryQueueForDelay } from './topology';

/**
 * Cửa sổ "còn có thể retry" của một message trong hệ thống — NGUỒN DUY NHẤT (trước ở cleanup.job.ts của hub-worker; QT4
 * tách ra đây để hub-api kiểm `olderThan` của lệnh dọn bằng CÙNG hằng số, SPEC-han-muc-dung-luong §5.2, ADR-184).
 * Không khai topology ở đây (chỉ đọc hằng số của topology.ts).
 */

/** Số lần thử lại tối đa qua hàng đợi 30s trước khi vào DLQ (5 × 30s ≈ 2,5 phút). */
export const NORMALIZE_MAX_RETRIES = 5;

/**
 * BP5 §7.4 (C2, ADR-200): khi bộ điều khiển áp lực ngược đã biết DB đang ốm (factor > 0), lỗi tạm ở normalize HOÃN vào
 * `retry.30s` không đốt lượt (`x-normalize-deferred-since`), tối đa `NORMALIZE_MAX_DEFER_MS` (60 phút) rồi mới đốt lượt như cũ.
 * Env chỉ được kẹp THẤP hơn (cửa sổ retry cộng theo mặc định).
 */
export const NORMALIZE_MAX_DEFER_MS = 3_600_000;

/**
 * BP5 §7.3 (review lượt 2): message chờ permit của bộ điều khiển áp lực ngược tối đa `BACKPRESSURE_HOLD_MAX_MS` (60s) trong
 * tiến trình rồi mới spill — thời gian này cũng nằm trong cửa sổ retry (một lần cho mỗi lần thử). Env chỉ kẹp THẤP hơn (≥ 1s).
 */
export const BACKPRESSURE_HOLD_MAX_MS = 60_000;
export function backpressureHoldMaxMs(env: string | undefined = process.env.BACKPRESSURE_HOLD_MAX_MS): number {
  const n = Number(env);
  if (env === undefined || env === '' || !Number.isFinite(n) || n <= 0) return BACKPRESSURE_HOLD_MAX_MS;
  return Math.max(1_000, Math.min(Math.floor(n), BACKPRESSURE_HOLD_MAX_MS));
}
export function normalizeMaxDeferMs(env: string | undefined = process.env.NORMALIZE_MAX_DEFER_MS): number {
  const n = Number(env);
  if (env === undefined || env === '' || !Number.isFinite(n) || n <= 0) return NORMALIZE_MAX_DEFER_MS;
  return Math.max(NORMALIZE_RETRY_TTL_MS, Math.min(Math.floor(n), NORMALIZE_MAX_DEFER_MS));
}

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
 * BP4 (SPEC-ap-luc-nguoc §5, ADR-198): slow-start sau khi probe thành công — cap = START × 2^floor(đã trôi / STEP), áp trong
 * `DELIVERY_RAMP_SECONDS` giây (0 = tắt). Mặc định 2 rps, bước 10s, 60s (trần cuối ~64 rps). `DELIVERY_RAMP_SECONDS` và
 * `DELIVERY_RAMP_STEP_SECONDS` chỉ được kẹp THẤP hơn mặc định: message bị ramp hoãn (retry.10s) tối đa trong thời gian khoá
 * `:ramp` sống — cửa sổ retry tính theo mặc định.
 * F3 (chaos [BP:T16] phần b, ADR-232): khoá `:ramp` sống `seconds + stepSeconds` và trần KẸP ở bậc cuối trong bậc thêm đó —
 * hàng tồn chưa xả hết trong 60s không dội về hết tốc ngay khi khoá hết hạn (đo được 123/s ở trần cuối 64).
 * F3 bậc cuối (ADR-234, đính chính ADR-232): ở bậc cuối mà gate còn THROTTLE (hàng còn dội) thì CÙNG EVAL gia hạn `:ramp`
 * thêm `deliveryRampExtendMs` (≥ một vòng retry.10s + một bậc), tới tối đa `rampStart + maxSeconds` (≤ 180s) — tính bằng đồng
 * hồ worker: lệch đồng hồ D giữa các worker thì ramp có thể sống tới RAMP_MAX + D.
 * Thấp-9: số lần nhân đôi kẹp ≤ `DELIVERY_RAMP_MAX_DOUBLINGS` (5) và `DELIVERY_RAMP_START_RPS` chỉ kẹp THẤP hơn 2 -> trần cuối
 * tuyệt đối ≤ 2 × 32 = 64 rps dù env đặt thế nào.
 */
export const DELIVERY_RAMP_START_RPS = 2;
export const DELIVERY_RAMP_STEP_SECONDS = 10;
export const DELIVERY_RAMP_SECONDS = 60;
/** ADR-234: trần TUYỆT ĐỐI thời gian ramp kể từ `rampStart` (kể cả gia hạn ở bậc cuối). Env chỉ kẹp thấp hơn. */
export const DELIVERY_RAMP_MAX_SECONDS = 180;
/** ADR-234 (Thấp-9): số lần nhân đôi tối đa — trần cuối ≤ start × 2^5 (mặc định 2 → 64), không phụ thuộc env bước ramp. */
export const DELIVERY_RAMP_MAX_DOUBLINGS = 5;

export interface DeliveryRampConfig {
  startRps: number;
  stepSeconds: number;
  /** 0 = tắt slow-start. */
  seconds: number;
  /**
   * ADR-234: trần tuyệt đối (giây, tính từ rampStart) — trong [seconds + stepSeconds, DELIVERY_RAMP_MAX_SECONDS]. Mặc định
   * min(180, 3 × (seconds + step)) (review F3 Thấp-3: hạ ramp thì trần cũng hạ theo); env chỉ kẹp thấp hơn mặc định đó.
   */
  maxSeconds: number;
}

function intEnv(v: string | undefined): number | null {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? null : Math.floor(n);
}

export function deliveryRampConfig(env: Record<string, string | undefined> = process.env): DeliveryRampConfig {
  const start = intEnv(env.DELIVERY_RAMP_START_RPS);
  const step = intEnv(env.DELIVERY_RAMP_STEP_SECONDS);
  const secs = intEnv(env.DELIVERY_RAMP_SECONDS);
  const max = intEnv(env.DELIVERY_RAMP_MAX_SECONDS);
  // review F3 Thấp-4: START chỉ kẹp THẤP hơn mặc định — trần cuối tuyệt đối ≤ DELIVERY_RAMP_START_RPS × 2^MAX_DOUBLINGS (64).
  const startRps = start !== null && start >= 1 ? Math.min(start, DELIVERY_RAMP_START_RPS) : DELIVERY_RAMP_START_RPS;
  const stepSeconds = step !== null && step >= 1 ? Math.min(step, DELIVERY_RAMP_STEP_SECONDS) : DELIVERY_RAMP_STEP_SECONDS;
  const seconds = secs !== null && secs >= 0 ? Math.min(secs, DELIVERY_RAMP_SECONDS) : DELIVERY_RAMP_SECONDS;
  // ADR-234: chỉ kẹp THẤP hơn mặc định (≤ 180 — cửa sổ retry tính theo 180), không thấp hơn khoá gốc (ramp + một bậc).
  // Env bậy / ≤ 0 -> mặc định (không có nghĩa "tắt"; tắt ramp là DELIVERY_RAMP_SECONDS=0).
  const keySeconds = seconds > 0 ? seconds + stepSeconds : 0;
  const def = Math.min(DELIVERY_RAMP_MAX_SECONDS, 3 * keySeconds);
  const maxSeconds = Math.max(keySeconds, max !== null && max > 0 ? Math.min(max, def) : def);
  return { startRps, stepSeconds, seconds, maxSeconds };
}

/**
 * Bậc cuối của ramp (số lần nhân đôi) — MỘT công thức cho `LUA_GATE` (ARGV) và test: `ceil(seconds/step) − 1` (bậc thêm F3
 * giữ trần cuối), kẹp ≤ `DELIVERY_RAMP_MAX_DOUBLINGS` (Thấp-9: bước 1s không đẩy trần lên start × 2^59).
 */
export function deliveryRampLastStep(c: DeliveryRampConfig): number {
  if (c.seconds <= 0) return 0;
  return Math.max(0, Math.min(DELIVERY_RAMP_MAX_DOUBLINGS, Math.ceil(c.seconds / c.stepSeconds) - 1));
}

/** Trần ramp (rps) tại `elapsedMs` sau rampStart — mô hình JS của `LUA_GATE` (không tính gia hạn; hết `maxSeconds` -> null). */
export function deliveryRampCapAt(c: DeliveryRampConfig, elapsedMs: number): number | null {
  if (c.seconds <= 0 || elapsedMs >= c.maxSeconds * 1000) return null;
  const steps = Math.min(deliveryRampLastStep(c), Math.floor(Math.max(0, elapsedMs) / (c.stepSeconds * 1000)));
  return c.startRps * 2 ** steps;
}

/**
 * ADR-234 (review F3 Thấp-2): mỗi lần gia hạn ở bậc cuối = max(2 × step, một vòng retry.10s + một bậc) — hàng bị chặn quay lại
 * sau 10s, nên gia hạn ngắn hơn 10s (bước < 5s) để khoá hết hạn trước vòng kế tiếp và F3 mất tác dụng. Mặc định 20s.
 */
export function deliveryRampExtendMs(c: DeliveryRampConfig): number {
  return Math.max(2 * c.stepSeconds * 1000, retryQueueForDelay(0).ttlMs + c.stepSeconds * 1000);
}

/** F3 (ADR-232): thời gian khoá `:ramp` sống = ramp + một bậc kẹp ở trần cuối. */
export function deliveryRampKeySeconds(c: DeliveryRampConfig): number {
  return c.seconds > 0 ? c.seconds + c.stepSeconds : 0;
}

/**
 * Thời gian một lần thử có thể bị ramp hoãn: khoá `:ramp` sống tối đa `DELIVERY_RAMP_MAX_SECONDS` (180s, gồm gia hạn ở bậc cuối —
 * ADR-234) + một vòng `retry.10s` (vòng kiểm cuối) — cộng vào cửa sổ retry cho MỖI lần thử (BP4). Throttle `rate_limit_rps` do
 * khách đặt (ADR-016) không có trần thời gian — ngoài phạm vi, như trước BP4.
 */
export const DELIVERY_RAMP_DEFER_MS = DELIVERY_RAMP_MAX_SECONDS * 1000 + retryQueueForDelay(0).ttlMs;

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
 * + một vòng hoãn DÀI NHẤT mỗi lần thử (trần kiểm theo vòng; BP3: 5 phút) + (BP4) hoãn vì ramp ≤ 180s + 10s mỗi lần thử (ADR-234).
 * + (BP5) normalize hoãn/spill ≤ 60 phút + một vòng 30s + giữ chờ permit ≤ 60s mỗi lần thử. processed_messages/outbox phải sống LÂU HƠN thế; dữ liệu mới hơn mốc này không được
 * dọn/xoá (QT §5.2). = 27.250.000 ms ≈ 7h34m10s (F3 ADR-232 thêm 6 × 10s; ADR-234 thêm 6 × 110s).
 */
export const TOTAL_RETRY_WINDOW_MS =
  RETRY_TIERS.reduce((sum, t) => sum + t.ttlMs, 0) +
  NORMALIZE_RETRY_TTL_MS * NORMALIZE_MAX_RETRIES +
  NORMALIZE_MAX_DEFER_MS + // BP5: normalize hoãn / spill không đốt lượt khi DB ốm (một lần cho mỗi event)
  NORMALIZE_RETRY_TTL_MS + // + một vòng 30s: trần chỉ kiểm mỗi vòng (review BP5 TH-1)
  (RETRY_TIERS.length + 1) * (CIRCUIT_MAX_DEFER_MS + CIRCUIT_DEFER_ROUND_MS + DELIVERY_RAMP_DEFER_MS + BACKPRESSURE_HOLD_MAX_MS);

/** Mốc thời gian MỚI NHẤT được phép dọn/xoá: dữ liệu nhận SAU mốc này có thể còn đang retry. */
export function retryWindowFloor(now: number = Date.now()): Date {
  return new Date(now - TOTAL_RETRY_WINDOW_MS);
}

/** Lệnh dọn với `cutoff` (dọn dữ liệu nhận TRƯỚC cutoff) có an toàn không: cutoff ≤ now − cửa sổ retry. */
export function isCutoffOutsideRetryWindow(cutoff: Date, now: number = Date.now()): boolean {
  return cutoff instanceof Date && Number.isFinite(cutoff.getTime()) && cutoff.getTime() <= now - TOTAL_RETRY_WINDOW_MS;
}
