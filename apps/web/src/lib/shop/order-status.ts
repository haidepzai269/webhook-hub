// Logic THUẦN của checkout Shop (không React, không env) để test được.

/**
 * R2-L1 (ADR-144): sau hạn đơn, Shop vẫn có thể chuyển EXPIRED -> PAID khi webhook của khoản trả ĐÚNG hạn tới muộn
 * (cold start hub/Shop, M-1). Web hỏi tiếp trong cửa sổ này, dài hơn biên 5 phút của link PayOS.
 */
export const LATE_WEBHOOK_GRACE_MS = 6 * 60 * 1000;

export function isFinalStatus(status: string, expiresAt: string | undefined, now: number): boolean {
  if (status === "PAID" || status === "CANCELLED") return true;
  if (status !== "EXPIRED") return false;
  return !expiresAt || now > Date.parse(expiresAt) + LATE_WEBHOOK_GRACE_MS;
}

/** Hỏi trạng thái tới hạn đơn + grace; server cũ không trả expiresAt thì dùng `fallback`. */
export const pollDeadline = (expiresAt: string | undefined, fallback: number) =>
  expiresAt ? Date.parse(expiresAt) + LATE_WEBHOOK_GRACE_MS : fallback;
