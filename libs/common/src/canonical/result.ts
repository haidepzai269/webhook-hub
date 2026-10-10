/** Kết quả validator của catalog: `field` là TÊN trường sai (không bao giờ kèm giá trị). */
export type CanonicalResult = { ok: true; field?: undefined } | { ok: false; field: string };

export const OK: CanonicalResult = Object.freeze({ ok: true }) as CanonicalResult;
export const FAIL = (field: string): CanonicalResult => ({ ok: false, field });

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isNullableString(v: unknown): boolean {
  return v === null || typeof v === 'string';
}

/**
 * Hình dạng ổn định (luật 7): mọi khoá khai báo phải CÓ MẶT (kể cả khi `null`) và không có khoá lạ.
 * Trả lỗi ở khoá thiếu đầu tiên, rồi khoá lạ đầu tiên; null nếu khớp.
 */
export function checkExactKeys(obj: Record<string, unknown>, keys: readonly string[], prefix = ''): CanonicalResult | null {
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === undefined) return FAIL(prefix + k);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) return FAIL(prefix + k);
  return null;
}
