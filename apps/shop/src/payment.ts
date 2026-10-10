// Máy trạng thái đơn hàng (ADR-034). PAID và EXPIRED là trạng thái CUỐI: không webhook nào kéo đơn ra khỏi đó.
//   PENDING   -> UNDERPAID | PAID | EXPIRED (quá 15 phút)
//   UNDERPAID -> UNDERPAID | PAID            (đã có tiền vào: không tự hết hạn)
export const EXPIRE_AFTER_MS = 15 * 60 * 1000; // khớp 15 phút ngừng poll ở modal thanh toán
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
 * Đọc khoản tiền từ webhook của hub (S3-2, ADR-053): Shop chỉ nói MỘT ngôn ngữ — kiểu chuẩn
 * `payment.received` (`data.amount` số nguyên đơn vị nhỏ nhất, `data.currency`). Không còn `if`
 * theo provider (trường riêng của SePay/PayOS chỉ còn trong `data.raw`). Mã đơn tìm trong `memo`, rồi `reference`.
 */
export function readPayment(body: any): { orderCode: string; amount: number } | { skip: 'IGNORED' | 'UNMATCHED' } {
  const d = body?.data || {};
  if (body?.type !== 'payment.received' || d.currency !== 'VND') return { skip: 'IGNORED' };
  const match = `${d.memo ?? ''}`.match(/DH\d+/) ?? `${d.reference ?? ''}`.match(/DH\d+/);
  if (!match) return { skip: 'UNMATCHED' };
  const amount = Number(d.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { skip: 'IGNORED' };
  return { orderCode: match[0], amount };
}
