/**
 * "Vào nhiều kiểu, ra một kiểu" (S3-2 = lõi S14, ADR-053). Đây là CHỖ DUY NHẤT biết catalog.
 * Lõi (NormalizeConsumer) chỉ hỏi: kiểu này có thuộc không gian dành riêng không? Nếu có thì
 * `data` có đúng khuôn không? — không bao giờ hỏi provider nào (không `if (provider === 'x')`).
 */
import { CanonicalResult, FAIL } from './result';
import { paymentKeys, validatePayment } from './payment';
import { repoKeys, validateRepo } from './repo';
import { HUB_CLEANUP_SUGGESTED, hubKeys, validateHub } from './hub';
import { SAMPLE_TYPES } from './samples';

export type { CanonicalResult } from './result';
export * from './payment';
export * from './repo';
export * from './hub';
export * from './time';
export * from './samples';

/**
 * Không gian tên dành riêng cho kiểu chuẩn: `payment.*`, `repo.*` và `hub.*` (sự kiện do chính hub phát — QT4b, ADR-187;
 * dành riêng để service/adapter không giả mạo được).
 */
export const RESERVED_NAMESPACES = ['payment', 'repo', 'hub'] as const;

export function isReservedType(type: string): boolean {
  if (typeof type !== 'string') return false;
  return RESERVED_NAMESPACES.some((ns) => type === ns || type.startsWith(`${ns}.`));
}

/**
 * Review QT-S2 M1 (ADR-187): `hub.*` là sự kiện CHỈ hub nội bộ phát (`emitHubEvent`, đi thẳng vào route — không qua
 * publish/normalize). Mọi đường vào từ bên ngoài (publish của service, `hub trigger`, adapter kể cả Generic) phải từ chối
 * CẢ namespace, kể cả khi `data` đúng khuôn — không thì service có `publish:events` giả mạo được sự kiện của hub. Luật theo
 * namespace, không theo provider.
 */
export const HUB_ONLY_NAMESPACE = 'hub';

export function isHubOnlyType(type: string): boolean {
  return typeof type === 'string' && (type === HUB_ONLY_NAMESPACE || type.startsWith(`${HUB_ONLY_NAMESPACE}.`));
}

/** Tập khoá đầy đủ của `data` cho một kiểu chuẩn; null nếu kiểu không có trong catalog. */
export function canonicalKeys(type: string): string[] | null {
  return paymentKeys(type) ?? repoKeys(type) ?? hubKeys(type);
}

/**
 * Kiểm `data` của một kiểu thuộc không gian dành riêng. Kiểu dành riêng mà không có trong catalog
 * (vd `payment.foo`, `repo.release`) -> `{ok:false, field:'type'}`. Kiểu KHÔNG dành riêng -> ok
 * (hub không cam kết hình dạng của nó).
 */
export function validateCanonical(type: string, data: unknown): CanonicalResult {
  if (!isReservedType(type)) return { ok: true };
  if (type.startsWith('payment')) return paymentKeys(type) ? validatePayment(type, data) : FAIL('type');
  if (type.startsWith('hub')) return hubKeys(type) ? validateHub(type, data) : FAIL('type');
  return repoKeys(type) ? validateRepo(type, data) : FAIL('type');
}

/** Kiểu cụ thể đại diện của catalog — dùng để hỏi "mẫu wildcard này có phủ kiểu chuẩn nào không". */
const CATALOG_REPRESENTATIVES = [...SAMPLE_TYPES, 'repo.pull_request.closed', 'repo.issue.closed', HUB_CLEANUP_SUGGESTED];

/**
 * KN1 (SPEC-ket-noi §3.1): mẫu `eventTypes` của endpoint console có khớp catalog không. Mẫu NGOÀI không gian dành
 * riêng (vd `order.*`, `*`) -> luôn ok (hub không cam kết kiểu của service). Trong `payment.*` / `repo.*`: mẫu cụ thể
 * phải là kiểu có trong catalog (`payment.recieved` gõ sai -> false); wildcard phải phủ ít nhất một kiểu chuẩn.
 */
export function catalogCoversPattern(p: string): boolean {
  if (typeof p !== 'string') return false;
  if (!p.endsWith('.*')) return !isReservedType(p) || canonicalKeys(p) !== null;
  const prefix = p.slice(0, -1); // 'payment.' / 'repo.pull_request.'
  if (!isReservedType(prefix.slice(0, -1))) return true;
  return CATALOG_REPRESENTATIVES.some((t) => t.startsWith(prefix));
}
