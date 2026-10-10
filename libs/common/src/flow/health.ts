/**
 * Ngưỡng sức khoẻ — MỘT nguồn sự thật (SPEC-event-flow-ui §0A.E). Server gắn `health` cho mọi node
 * và cạnh của bản đồ luồng; UI chỉ tô màu theo giá trị này, không tự tính.
 */

export type Health = 'healthy' | 'warning' | 'crashed' | 'idle';

export const HEALTH_LABELS: Record<Health, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  crashed: 'Crashed',
  idle: 'Idle',
};

export const HEALTH_THRESHOLDS = {
  /** Tỉ lệ lỗi > 2% → warning. */
  warnFailureRate: 0.02,
  /** Tỉ lệ lỗi > 20% → crashed. */
  crashFailureRate: 0.2,
  /** p95 > 2s → warning (timeout gửi là 5s). */
  warnP95Ms: 2000,
  /** Source bị chặn hàng loạt: ≥ 5 request bị từ chối và chiếm > 50% → crashed. */
  crashRejectedMin: 5,
  crashRejectedRate: 0.5,
} as const;

export interface HealthInput {
  /** Số lượng đi qua trong cửa sổ (event, delivery, request…). 0 + không có tín hiệu xấu → idle. */
  events: number;
  /** Số thất bại trong cùng cửa sổ (DEAD, rejected, orphan…). */
  failed?: number;
  /** 0..1, null khi chưa có gì kết thúc. Ưu tiên hơn `failed/events` nếu có. */
  successRate?: number | null;
  p95Ms?: number | null;
  circuit?: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | null;
  /** Đang RETRYING (hiện tại). */
  retrying?: number;
  /** Số delivery rơi vào DLQ (DEAD) trong cửa sổ. */
  dlqDelta?: number;
  /** Request bị từ chối chữ ký trong cửa sổ (node source/gate). */
  rejected?: number;
  /** Endpoint (đa service): FAILED = không gửi được gì → crashed; PENDING = chờ challenge → warning. */
  verification?: 'PENDING' | 'VERIFIED' | 'FAILED' | null;
}

export function healthOf(i: HealthInput): Health {
  const t = HEALTH_THRESHOLDS;
  const events = Math.max(0, i.events || 0);
  const failed = Math.max(0, i.failed ?? 0);
  const rejected = Math.max(0, i.rejected ?? 0);
  const failureRate =
    i.successRate !== undefined && i.successRate !== null ? 1 - i.successRate : events > 0 ? failed / events : 0;
  const rejectedRate = events > 0 ? rejected / events : 0;

  // Crashed: đỏ, nổi bật từ xa.
  if (i.circuit === 'OPEN') return 'crashed';
  if (i.verification === 'FAILED') return 'crashed';
  if ((i.dlqDelta ?? 0) > 0) return 'crashed';
  if (events > 0 && failureRate > t.crashFailureRate) return 'crashed';
  if (rejected >= t.crashRejectedMin && rejectedRate > t.crashRejectedRate) return 'crashed';

  // Warning: vàng.
  if (i.circuit === 'HALF_OPEN') return 'warning';
  if (i.verification === 'PENDING') return 'warning';
  if ((i.retrying ?? 0) > 0) return 'warning';
  if (events > 0 && failureRate > t.warnFailureRate) return 'warning';
  if (rejected > 0) return 'warning';
  if (i.p95Ms !== undefined && i.p95Ms !== null && i.p95Ms > t.warnP95Ms) return 'warning';

  if (events === 0) return 'idle';
  return 'healthy';
}

/** Sức khoẻ một cạnh: cùng ngưỡng, dữ liệu là count/failed của cạnh. */
export function edgeHealthOf(count: number, failed: number, retrying = 0): Health {
  return healthOf({ events: count, failed, retrying });
}
