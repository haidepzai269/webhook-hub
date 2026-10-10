/**
 * Catalog kiểu chuẩn v1 — miền THANH TOÁN (SPEC đa service §4.14.2, ADR-053).
 * Thuần TypeScript, không phụ thuộc thư viện ngoài: 4 dạng, viết tay để đọc và bảo vệ được.
 *
 * Luật ổn định hình dạng (§4.14.1 luật 7): mọi khoá dưới đây LUÔN có mặt (thiếu dữ liệu thì
 * `null`). Chỉ được THÊM trường tuỳ chọn; đổi/bỏ trường = kiểu mới (`payment.received.v2`).
 */
import { CanonicalResult, FAIL, OK, isNullableString, isPlainObject, checkExactKeys } from './result';
import { isIsoWithTimezone } from './time';

export type PaymentMethod = 'bank_transfer' | 'card' | 'ewallet' | 'payment_link' | 'other';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['bank_transfer', 'card', 'ewallet', 'payment_link', 'other'];

export type Counterparty = { name: string | null; accountNumber: string | null; bank: string | null };
export type PaymentAccount = { number: string | null; bank: string | null };

export interface PaymentCore {
  /** Số nguyên, ĐƠN VỊ NHỎ NHẤT của ISO 4217 (VND = đồng, USD = cent). > 0; riêng `payment.failed` cho phép 0. */
  amount: number;
  /** ^[A-Z]{3}$ */
  currency: string;
  method: PaymentMethod;
  /** Mã tham chiếu giao dịch phía ngân hàng/cổng. */
  reference: string | null;
  /** Nội dung chuyển khoản / description — nơi service tìm mã của chính mình (vd mã đơn). */
  memo: string | null;
  /** Người trả (received) / người nhận (sent). */
  counterparty: Counterparty | null;
  /** Tài khoản của mình. */
  account: PaymentAccount | null;
  /** Id giao dịch duy nhất phía provider. */
  providerTxnId: string;
  /** Body gốc của provider đã parse — lối thoát cho trường riêng (vd `orderCode` của PayOS). */
  raw: unknown;
}
export interface PaymentReceived extends PaymentCore { paidAt: string }
export interface PaymentSent extends PaymentCore { sentAt: string }
export interface PaymentFailed extends PaymentCore { failedAt: string; reason: string | null }
export interface PaymentRefunded extends PaymentCore { refundedAt: string }

export const PAYMENT_CORE_KEYS = [
  'amount', 'currency', 'method', 'reference', 'memo', 'counterparty', 'account', 'providerTxnId', 'raw',
] as const;

/** Khoá riêng của từng kiểu (ngoài phần lõi). */
export const PAYMENT_TYPE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'payment.received': ['paidAt'],
  'payment.sent': ['sentAt'],
  'payment.failed': ['failedAt', 'reason'],
  'payment.refunded': ['refundedAt'],
};

export const PAYMENT_TYPES = Object.keys(PAYMENT_TYPE_KEYS);

/** Tập khoá ĐẦY ĐỦ của `data` cho một kiểu thanh toán; null nếu không phải kiểu trong catalog. */
export function paymentKeys(type: string): string[] | null {
  const extra = PAYMENT_TYPE_KEYS[type];
  return extra ? [...PAYMENT_CORE_KEYS, ...extra] : null;
}

export function validatePayment(type: string, data: unknown): CanonicalResult {
  const keys = paymentKeys(type);
  if (!keys) return FAIL('type');
  if (!isPlainObject(data)) return FAIL('data');
  const d = data as Record<string, unknown>;

  const shape = checkExactKeys(d, keys);
  if (shape) return shape;

  // Review SPEC-3 #5: giao dịch THẤT BẠI có thể không có tiền (PayOS code≠00 gửi amount=0) -> cho phép 0.
  const minAmount = type === 'payment.failed' ? 0 : 1;
  if (typeof d.amount !== 'number' || !Number.isInteger(d.amount) || d.amount < minAmount) return FAIL('amount');
  if (typeof d.currency !== 'string' || !/^[A-Z]{3}$/.test(d.currency)) return FAIL('currency');
  if (!PAYMENT_METHODS.includes(d.method as PaymentMethod)) return FAIL('method');
  if (!isNullableString(d.reference)) return FAIL('reference');
  if (!isNullableString(d.memo)) return FAIL('memo');

  if (d.counterparty !== null) {
    if (!isPlainObject(d.counterparty)) return FAIL('counterparty');
    const cp = d.counterparty as Record<string, unknown>;
    const bad = checkExactKeys(cp, ['name', 'accountNumber', 'bank'], 'counterparty.');
    if (bad) return bad;
    for (const k of ['name', 'accountNumber', 'bank']) if (!isNullableString(cp[k])) return FAIL(`counterparty.${k}`);
  }
  if (d.account !== null) {
    if (!isPlainObject(d.account)) return FAIL('account');
    const ac = d.account as Record<string, unknown>;
    const bad = checkExactKeys(ac, ['number', 'bank'], 'account.');
    if (bad) return bad;
    for (const k of ['number', 'bank']) if (!isNullableString(ac[k])) return FAIL(`account.${k}`);
  }
  if (typeof d.providerTxnId !== 'string' || d.providerTxnId.length === 0) return FAIL('providerTxnId');
  if (d.raw === undefined) return FAIL('raw');

  const timeKey = PAYMENT_TYPE_KEYS[type][0];
  if (!isIsoWithTimezone(d[timeKey])) return FAIL(timeKey);
  if (type === 'payment.failed' && !isNullableString(d.reason)) return FAIL('reason');
  return OK;
}
