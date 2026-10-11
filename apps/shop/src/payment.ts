import { randomInt } from 'crypto';

// Máy trạng thái đơn hàng (ADR-034). PAID và EXPIRED là trạng thái CUỐI: không webhook nào kéo đơn ra khỏi đó.
//   PENDING   -> UNDERPAID | PAID | EXPIRED (quá SHOP_ORDER_TTL_MIN, mặc định 30 phút — ADR-141)
//   UNDERPAID -> UNDERPAID | PAID            (đã có tiền vào: không tự hết hạn)
export const EXPIRE_AFTER_MS = (Number(process.env.SHOP_ORDER_TTL_MIN) > 0 ? Number(process.env.SHOP_ORDER_TTL_MIN) : 30) * 60_000;
const TERMINAL = new Set(['PAID', 'EXPIRED']);

export type PaymentOutcome = 'PAID' | 'UNDERPAID' | 'LATE_PAYMENT' | 'EXTRA_PAYMENT';

/**
 * Cộng dồn một khoản tiền vào đơn. Thứ tự webhook đến KHÔNG quan trọng vì phép cộng giao hoán;
 * trùng lặp đã bị chặn trước đó bởi `processed_hub_events` (mỗi event-id chỉ được cộng một lần).
 * Đơn đã ở trạng thái cuối vẫn ghi nhận tiền (để đối soát/hoàn tiền) nhưng KHÔNG đổi trạng thái.
 */
export function applyPayment(
  order: { status: string; amount: bigint; paidAmount: bigint; createdAt: Date },
  amount: bigint,
  now = new Date(),
) {
  const paidAmount = order.paidAmount + amount;
  // Hết hạn "lười": không phụ thuộc lúc nào cron reconcile chạy (deployed có thể trễ hàng chục phút)
  if (isExpired(order, now)) return { status: 'EXPIRED', paidAmount, outcome: 'LATE_PAYMENT' as PaymentOutcome };
  if (TERMINAL.has(order.status)) {
    const outcome: PaymentOutcome = order.status === 'PAID' ? 'EXTRA_PAYMENT' : 'LATE_PAYMENT';
    return { status: order.status, paidAmount, outcome };
  }
  const status = paidAmount >= order.amount ? 'PAID' : 'UNDERPAID';
  return { status, paidAmount, outcome: status as PaymentOutcome };
}

export function isExpired(order: { status: string; createdAt: Date }, now = new Date()) {
  return order.status === 'PENDING' && now.getTime() - order.createdAt.getTime() > EXPIRE_AFTER_MS;
}

/**
 * MS-R2 (ADR-084): tiền THẬT chỉ đến từ cổng thanh toán. `source` do adapter của hub đặt (service publish qua
 * `/events` luôn là `api`, nguồn tuỳ chỉnh là `generic`) nên không giả được. Đổi bằng `SHOP_PAYMENT_SOURCES`.
 */
export const PAYMENT_SOURCES: readonly string[] = (process.env.SHOP_PAYMENT_SOURCES || 'payos,sepay').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Đọc khoản tiền từ webhook của hub (S3-2, ADR-053): Shop chỉ nói MỘT ngôn ngữ — kiểu chuẩn
 * `payment.received` (`data.amount` số nguyên đơn vị nhỏ nhất, `data.currency`). Không còn `if`
 * theo provider (trường riêng của SePay/PayOS chỉ còn trong `data.raw`). Mã đơn tìm trong `memo`, rồi `reference`.
 */
export function readPayment(body: any, allowed: readonly string[] = PAYMENT_SOURCES, trustedSourceIds?: readonly string[]): { orderCode: string; amount: number } | { skip: 'IGNORED' | 'UNMATCHED' } {
  const d = body?.data || {};
  if (body?.type !== 'payment.received' || d.currency !== 'VND' || !allowed.includes(body?.source)) return { skip: 'IGNORED' };
  // R-1 (ADR-094): có danh sách source tin cậy (sourceIds của subscription đã ghim lúc ensure) -> phải khớp ĐÚNG id.
  if (trustedSourceIds && !trustedSourceIds.includes(body?.sourceId)) return { skip: 'IGNORED' };
  const match = `${d.memo ?? ''}`.match(/DH\d+/) ?? `${d.reference ?? ''}`.match(/DH\d+/);
  if (!match) return { skip: 'UNMATCHED' };
  const amount = Number(d.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { skip: 'IGNORED' };
  return { orderCode: match[0], amount };
}

/** ADR-141: DH + 7 chữ số = 9 ký tự — vừa giới hạn `description` của PayOS; phần số là `orderCode` (kiểu SỐ) của PayOS. */
export const newOrderCode = () => `DH${randomInt(1_000_000, 10_000_000)}`;
export const payosOrderNumber = (orderCode: string) => Number(orderCode.slice(2));
export const qrImage = (data: string) => `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(data)}`;

/** SePay: VietQR THẬT của tài khoản nhận (img.vietqr.io), nội dung = mã đơn. Thiếu cấu hình -> null (không QR giả). */
export function bankQrUrl(env: NodeJS.ProcessEnv, amount: number, orderCode: string): string | null {
  const { SHOP_BANK_CODE: bank, SHOP_BANK_ACCOUNT: acc, SHOP_BANK_ACCOUNT_NAME: name } = env;
  if (!bank || !acc) return null;
  const q = new URLSearchParams({ amount: String(amount), addInfo: orderCode, ...(name ? { accountName: name } : {}) });
  return `https://img.vietqr.io/image/${encodeURIComponent(bank)}-${encodeURIComponent(acc)}-compact2.png?${q}`;
}
