/**
 * Thời gian chuẩn của catalog (SPEC đa service §4.14.1 luật 9): ISO 8601 có múi giờ.
 *
 * - number            -> unix GIÂY (Stripe `created`) -> ISO.
 * - "YYYY-MM-DD HH:mm[:ss[.SSS]]" không múi giờ (PayOS `transactionDateTime`, SePay
 *   `transactionDate`) -> hiểu là giờ `defaultOffset` (mặc định giờ Việt Nam +07:00).
 * - chuỗi ISO có `Z` hoặc `±hh:mm` -> giữ nguyên thời điểm.
 * - còn lại -> ném lỗi (lỗi normalize vĩnh viễn — hub không đoán định dạng ngày).
 */
const NO_TZ = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/;
const WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const OFFSET = /^[+-]\d{2}:\d{2}$/;

export function parseProviderTime(value: string | number, defaultOffset = '+07:00'): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Thời gian không hợp lệ: ${value}`);
    return new Date(value * 1000).toISOString();
  }
  if (typeof value !== 'string') throw new Error('Thời gian phải là chuỗi hoặc số unix giây');
  if (!OFFSET.test(defaultOffset)) throw new Error(`defaultOffset không hợp lệ: ${defaultOffset}`);
  const s = value.trim();
  let iso: string | null = null;
  const m = NO_TZ.exec(s);
  if (m) iso = `${m[1]}T${m[2]}${defaultOffset}`;
  else if (WITH_TZ.test(s)) iso = s;
  if (!iso) throw new Error(`Không hiểu định dạng thời gian: "${s.slice(0, 40)}"`);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`Thời gian không hợp lệ: "${s.slice(0, 40)}"`);
  return new Date(t).toISOString();
}

/** Chuỗi ISO 8601 CÓ múi giờ và parse được — dùng trong validator. */
export function isIsoWithTimezone(v: unknown): boolean {
  return typeof v === 'string' && WITH_TZ.test(v) && !Number.isNaN(Date.parse(v));
}
