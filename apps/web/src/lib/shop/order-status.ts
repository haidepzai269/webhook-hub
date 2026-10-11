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

export type PaymentQr = { kind: "code"; value: string } | { kind: "image"; url: string } | null;

/**
 * Q3 (ADR-154): PayOS trả chuỗi VietQR (`qrCode`) -> web tự vẽ QR, không gửi số tài khoản/số tiền/nội dung cho dịch vụ
 * vẽ ảnh bên thứ ba (và không mất QR khi dịch vụ đó sập). SePay: ảnh VietQR chuẩn của img.vietqr.io (giữ nguyên).
 */
export function paymentQr(p: { qrImageUrl: string | null; qrCode?: string }): PaymentQr {
  if (p.qrCode) return { kind: "code", value: p.qrCode };
  if (p.qrImageUrl && !p.qrImageUrl.includes("qrserver.com")) return { kind: "image", url: p.qrImageUrl };
  return null;
}

/**
 * M-1 (REVIEW-ADR154): "chuyển thêm phần còn thiếu cùng nội dung" chỉ đúng cho chuyển khoản thẳng (SePay). Đơn PayOS: link
 * đã hết hạn, chuyển thẳng vào tài khoản thì tiền về từ nguồn sepay -> OTHER_CHANNEL, không cộng vào đơn -> chỉ hotline.
 */
export const canTopUp = (paymentProvider: string | undefined) => paymentProvider !== "payos";

/** Chữ ký giỏ (thứ tự không quan trọng) — so với lúc tạo đơn để biết giỏ đã đổi chưa. */
export const cartSignature = (items: { id: string; qty: number }[]) =>
  items
    .filter((l) => l.qty > 0)
    .map((l) => `${l.id}:${l.qty}`)
    .sort()
    .join(",");

/**
 * Lỗi production (2026-10-12): mở lại modal vẫn thấy QR PayOS của đơn CŨ — khách quét lại, ngân hàng báo "đã thanh toán".
 * Mở modal mà giỏ đã khác lúc tạo đơn -> bỏ đơn cũ, tạo đơn mới (đơn cũ PENDING tự hết hạn ở server).
 */
export function shouldStartNewOrder(order: { cartSig?: string } | null, currentCartSig: string): boolean {
  return !!order && order.cartSig !== undefined && order.cartSig !== currentCartSig;
}

/** M-2: `?order=DH…` trong returnUrl của PayOS. Chỉ nhận đúng khuôn mã đơn (DH + 7 hoặc 10 số). */
export function orderCodeFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get("order");
  return v && /^DH(?:\d{7}|\d{10})$/.test(v) ? v : null;
}

/** M-2: đơn lưu trong sessionStorage của tab — đọc lại an toàn (rác/khác khuôn -> null). */
export function parseSavedOrder<T extends { orderCode: string }>(raw: string | null): T | null {
  try {
    const o = raw ? (JSON.parse(raw) as T) : null;
    return o && typeof o.orderCode === "string" && /^DH\d+$/.test(o.orderCode) ? o : null;
  } catch {
    return null;
  }
}
