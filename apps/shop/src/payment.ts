import { randomInt } from 'crypto';

// Máy trạng thái đơn hàng (ADR-034, ADR-154). PAID là cuối. EXPIRED nhận tiền trả SAU hạn: cộng dồn, đủ tổng thì -> PAID.
//   PENDING   -> UNDERPAID | PAID | EXPIRED (quá SHOP_ORDER_TTL_MIN, mặc định 30 phút — ADR-141)
//   UNDERPAID -> UNDERPAID | PAID            (đã có tiền vào: không tự hết hạn)
//   EXPIRED   -> EXPIRED | PAID              (Q1, ADR-154: tiền ĐỦ về muộn thì giao món — outcome LATE_PAID)
export const orderTtlMs = (env: NodeJS.ProcessEnv) => (Number(env.SHOP_ORDER_TTL_MIN) > 0 ? Number(env.SHOP_ORDER_TTL_MIN) : 30) * 60_000;
export const EXPIRE_AFTER_MS = orderTtlMs(process.env);

export type PaymentOutcome = 'PAID' | 'UNDERPAID' | 'LATE_PAID' | 'LATE_PAYMENT' | 'EXTRA_PAYMENT';

/**
 * Cộng dồn một khoản tiền (giao hoán: thứ tự đến không quan trọng; trùng đã bị `processed_hub_events` chặn). M-1 (ADR-144):
 * hạn xét theo lúc KHÁCH TRẢ (`paidAt` của provider, chặn ≤ now), không theo lúc webhook tới. Trả sau hạn: tổng đủ -> PAID
 * (LATE_PAID), thiếu -> giữ EXPIRED (LATE_PAYMENT, chờ khoản sau hoặc đối soát) — ADR-154 thay "không hồi sinh" của ADR-034.
 */
export function applyPayment(order: { status: string; amount: bigint; paidAmount: bigint; createdAt: Date }, amount: bigint, paidAt = new Date(), now = new Date()) {
  const paidAmount = order.paidAmount + amount;
  if (!['PENDING', 'UNDERPAID', 'EXPIRED'].includes(order.status)) return { status: order.status, paidAmount, outcome: (order.status === 'PAID' ? 'EXTRA_PAYMENT' : 'LATE_PAYMENT') as PaymentOutcome };
  const late = order.status !== 'UNDERPAID' && Math.min(paidAt.getTime(), now.getTime()) - order.createdAt.getTime() > EXPIRE_AFTER_MS;
  const full = paidAmount >= order.amount;
  const status = full ? 'PAID' : late ? 'EXPIRED' : 'UNDERPAID'; // trễ mà thiếu: hết hạn "lười", không chờ cron
  return { status, paidAmount, outcome: (late ? (full ? 'LATE_PAID' : 'LATE_PAYMENT') : status) as PaymentOutcome };
}

export function isExpired(order: { status: string; createdAt: Date }, now = new Date()) {
  return order.status === 'PENDING' && now.getTime() - order.createdAt.getTime() > EXPIRE_AFTER_MS;
}

/** MS-R2 (ADR-084): tiền THẬT chỉ từ cổng thanh toán (`source` do adapter hub đặt). R2-L5: đơn chỉ có kênh payos/sepay nên source thêm ở đây = OTHER_CHANNEL (không cộng). */
export const PAYMENT_SOURCES: readonly string[] = (process.env.SHOP_PAYMENT_SOURCES || 'payos,sepay').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Đọc khoản tiền từ kiểu chuẩn `payment.received` (S3-2, ADR-053) — không `if` theo provider. M-3 (ADR-144): lấy MỌI mã
 * `DH`+7 số (hoặc +10 số, mã cũ) trong `memo` rồi `reference`; Shop chọn mã có thật trong DB (`pickOrderCode`).
 */
export function readPayment(body: any, allowed: readonly string[] = PAYMENT_SOURCES, trustedSourceIds?: readonly string[]): { orderCodes: string[]; amount: number; source: string; paidAt?: Date } | { skip: 'IGNORED' | 'UNMATCHED' } {
  const d = body?.data || {};
  if (body?.type !== 'payment.received' || d.currency !== 'VND' || !allowed.includes(body?.source)) return { skip: 'IGNORED' };
  // R-1 (ADR-094): có danh sách source tin cậy (sourceIds của subscription đã ghim lúc ensure) -> phải khớp ĐÚNG id.
  if (trustedSourceIds && !trustedSourceIds.includes(body?.sourceId)) return { skip: 'IGNORED' };
  const orderCodes = [...new Set([...`${d.memo ?? ''} ${d.reference ?? ''}`.matchAll(/DH(?:\d{10}|\d{7})(?!\d)/g)].map((m) => m[0]))];
  if (orderCodes.length === 0) return { skip: 'UNMATCHED' };
  const amount = Number(d.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { skip: 'IGNORED' };
  const t = typeof d.paidAt === 'string' ? Date.parse(d.paidAt) : NaN;
  return { orderCodes, amount, source: body.source, paidAt: Number.isFinite(t) ? new Date(t) : undefined };
}

export const pickOrderCode = (candidates: string[], existing: string[]) => candidates.find((c) => existing.includes(c)) ?? null;
/** M-2 (ADR-144): chỉ cộng tiền từ ĐÚNG kênh khách chọn — một tài khoản đứng sau cả PayOS lẫn SePay không bị cộng đôi. */
export const creditsOrder = (orderProvider: string | null, source: string) => !orderProvider || orderProvider === source;

/** ADR-141: DH + 7 chữ số = 9 ký tự — vừa giới hạn `description` của PayOS; phần số là `orderCode` (kiểu SỐ) của PayOS. */
export const newOrderCode = () => `DH${randomInt(1_000_000, 10_000_000)}`;
export const payosOrderNumber = (orderCode: string) => Number(orderCode.slice(2));

/** SePay: VietQR THẬT của tài khoản nhận (img.vietqr.io), nội dung = mã đơn. Thiếu cấu hình -> null (không QR giả). */
export function bankQrUrl(env: NodeJS.ProcessEnv, amount: number, orderCode: string): string | null {
  const { SHOP_BANK_CODE: bank, SHOP_BANK_ACCOUNT: acc, SHOP_BANK_ACCOUNT_NAME: name } = env;
  if (!bank || !acc) return null;
  const q = new URLSearchParams({ amount: String(amount), addInfo: orderCode, ...(name ? { accountName: name } : {}) });
  return `https://img.vietqr.io/image/${encodeURIComponent(bank)}-${encodeURIComponent(acc)}-compact2.png?${q}`;
}
