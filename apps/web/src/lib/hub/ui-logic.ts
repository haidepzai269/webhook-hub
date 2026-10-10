/**
 * Gộp toast `trace.ingested` (review SPEC-2 #8, ADR-054) — logic THUẦN, không React, để test được.
 *
 * - Mốc "đã toast tới đâu" (`watermark`) nằm trong store realtime, KHÔNG trong `useRef` của component:
 *   mount lại trang Sự kiện không toast lại cả loạt trace cũ.
 * - Bị dội (vd 50 request chữ ký sai/giây) -> tối đa MỘT toast mỗi `windowMs`, kèm "+N" số còn lại;
 *   phần dồn lại được xả khi cửa sổ hết (component đặt hẹn giờ theo `flushInMs`).
 */
export const TOAST_WINDOW_MS = 2000;
export const NOTABLE_OUTCOMES = new Set(["REJECTED", "DUPLICATE", "RATE_LIMITED"]);

export interface ToastableTrace {
  receivedAt: number;
  outcome: string;
}

export interface ToastCursor<T extends ToastableTrace = ToastableTrace> {
  /** receivedAt lớn nhất đã xét. */
  watermark: number;
  /** Lúc hiện toast gần nhất (ms). */
  lastToastAt: number;
  /** Số trace đáng báo đang dồn, chưa toast. */
  pending: number;
  /** Trace đáng báo mới nhất trong phần đang dồn — là trace sẽ được toast. */
  latest: T | null;
}

export function emptyToastCursor<T extends ToastableTrace>(): ToastCursor<T> {
  return { watermark: 0, lastToastAt: 0, pending: 0, latest: null };
}

export interface ToastStep<T extends ToastableTrace> {
  toast: { trace: T; more: number } | null;
  cursor: ToastCursor<T>;
  /** Còn dồn mà chưa tới lượt -> gọi lại sau từng này ms để xả. */
  flushInMs: number | null;
}

/** `traces` mới nhất ở đầu (như store realtime). */
export function stepToasts<T extends ToastableTrace>(
  traces: readonly T[],
  cur: ToastCursor<T>,
  now: number,
  windowMs = TOAST_WINDOW_MS,
): ToastStep<T> {
  const fresh = traces.filter((t) => t.receivedAt > cur.watermark);
  const watermark = fresh.reduce((m, t) => Math.max(m, t.receivedAt), cur.watermark);
  const notable = fresh.filter((t) => NOTABLE_OUTCOMES.has(t.outcome));
  const newest = notable.reduce<T | null>((a, t) => (!a || t.receivedAt > a.receivedAt ? t : a), null);
  const pending = cur.pending + notable.length;
  const latest = newest ?? cur.latest;

  if (pending === 0 || !latest) {
    return { toast: null, cursor: { ...cur, watermark, pending: 0, latest: null }, flushInMs: null };
  }
  const since = now - cur.lastToastAt;
  if (since >= windowMs) {
    return {
      toast: { trace: latest, more: pending - 1 },
      cursor: { watermark, lastToastAt: now, pending: 0, latest: null },
      flushInMs: null,
    };
  }
  return { toast: null, cursor: { watermark, lastToastAt: cur.lastToastAt, pending, latest }, flushInMs: windowMs - since };
}

/**
 * Callback cho setInterval của đồng hồ đếm ngược: cập nhật "now" và TỰ dừng khi về 0
 * (review SPEC-2 #8 — trước đây interval chạy mãi sau khi đã tới giờ).
 */
export function countdownTicker(
  target: number,
  setNow: (n: number) => void,
  stop: () => void,
  clock: () => number = Date.now,
): () => void {
  return () => {
    const n = clock();
    setNow(n);
    if (n >= target) stop();
  };
}

/**
 * Mọi mutation có ghi audit_logs phải làm mới cả danh sách audit — gom một chỗ để không quên
 * (review SPEC-2 #8: renormalize/tạo nguồn/đích/subscription từng không invalidate ["audit"]).
 */
export const AUDIT_KEY = ["audit"] as const;
export function keysAfterAudited(...keys: readonly (readonly unknown[])[]): (readonly unknown[])[] {
  return [...keys, AUDIT_KEY];
}

/** 409 xoá (ADR-054) -> thông điệp dễ hiểu từ body server (deliveryCount / subscriptionCount). */
export function describeDeleteConflict(e: unknown): string | null {
  // Duck-typing HubApiError (status + body) để file này không phụ thuộc client/env — test được thuần.
  const err = e as { status?: unknown; body?: unknown; message?: unknown } | null;
  if (!err || err.status !== 409) return null;
  const b = (err.body ?? {}) as { deliveryCount?: number; subscriptionCount?: number };
  if (typeof b.subscriptionCount === "number") {
    return `Đích còn ${b.subscriptionCount} subscription trỏ vào (${b.deliveryCount ?? 0} delivery lịch sử). Tắt các subscription đó; đích chỉ xoá được khi không còn subscription nào.`;
  }
  if (typeof b.deliveryCount === "number") {
    return `Subscription còn ${b.deliveryCount} delivery trong lịch sử (kể cả DEAD) — không xoá để giữ bằng chứng. Hãy bấm "Tắt" để ngừng gửi.`;
  }
  return typeof err.message === "string" ? err.message : "Xung đột (409)";
}
