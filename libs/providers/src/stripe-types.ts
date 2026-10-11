/** Bảng ánh xạ Stripe -> catalog thanh toán (SPEC đa service §4.14.2). */
export const STRIPE_PAYMENT_TYPES: Record<string, { type: string; amountField: string; timeKey: string }> = {
  'payment_intent.succeeded': { type: 'payment.received', amountField: 'amount_received', timeKey: 'paidAt' },
  'payment_intent.payment_failed': { type: 'payment.failed', amountField: 'amount', timeKey: 'failedAt' },
  'charge.refunded': { type: 'payment.refunded', amountField: 'amount_refunded', timeKey: 'refundedAt' },
};
