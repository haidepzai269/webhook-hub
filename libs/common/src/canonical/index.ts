/**
 * "Vào nhiều kiểu, ra một kiểu" (S3-2 = lõi S14, ADR-053). Đây là CHỖ DUY NHẤT biết catalog.
 * Lõi (NormalizeConsumer) chỉ hỏi: kiểu này có thuộc không gian dành riêng không? Nếu có thì
 * `data` có đúng khuôn không? — không bao giờ hỏi provider nào (không `if (provider === 'x')`).
 */
import { CanonicalResult, FAIL } from './result';
import { paymentKeys, validatePayment } from './payment';
import { repoKeys, validateRepo } from './repo';

export type { CanonicalResult } from './result';
export * from './payment';
export * from './repo';
export * from './time';

/** Không gian tên dành riêng cho kiểu chuẩn: `payment.*`, `repo.*`. */
export const RESERVED_NAMESPACES = ['payment', 'repo'] as const;

export function isReservedType(type: string): boolean {
  if (typeof type !== 'string') return false;
  return RESERVED_NAMESPACES.some((ns) => type === ns || type.startsWith(`${ns}.`));
}

/** Tập khoá đầy đủ của `data` cho một kiểu chuẩn; null nếu kiểu không có trong catalog. */
export function canonicalKeys(type: string): string[] | null {
  return paymentKeys(type) ?? repoKeys(type);
}

/**
 * Kiểm `data` của một kiểu thuộc không gian dành riêng. Kiểu dành riêng mà không có trong catalog
 * (vd `payment.foo`, `repo.release`) -> `{ok:false, field:'type'}`. Kiểu KHÔNG dành riêng -> ok
 * (hub không cam kết hình dạng của nó).
 */
export function validateCanonical(type: string, data: unknown): CanonicalResult {
  if (!isReservedType(type)) return { ok: true };
  if (type.startsWith('payment')) return paymentKeys(type) ? validatePayment(type, data) : FAIL('type');
  return repoKeys(type) ? validateRepo(type, data) : FAIL('type');
}
