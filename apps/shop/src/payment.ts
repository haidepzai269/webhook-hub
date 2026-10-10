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
