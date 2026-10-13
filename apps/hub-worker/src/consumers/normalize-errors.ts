import { classifyInfraError } from './infra-errors';

/**
 * Phân loại lỗi ở chặng normalize (S1-3, ADR-044).
 *
 * - `transient`: hạ tầng chập chờn (Postgres mất kết nối, pool hết chỗ, deadlock/serialization,
 *   mạng reset). Đợi một lúc rồi thử lại là khỏi → đưa vào `q.normalize.retry.30s`.
 * - `permanent`: lỗi của chính dữ liệu (adapter ném, JSON hỏng, provider chưa đăng ký, vi phạm
 *   ràng buộc). Thử lại bao nhiêu lần cũng vậy → DLQ ngay.
 *
 * Mặc định là `permanent`: chỉ những lỗi được liệt kê rõ mới được retry, để một lỗi lạ không
 * quay vòng âm thầm 5 lần.
 */
export type NormalizeErrorKind = 'transient' | 'permanent';

/** Số lần thử lại tối đa qua hàng đợi 30s trước khi vào DLQ — nguồn ở @hub/messaging (retry-window.ts, QT4). */
export { NORMALIZE_MAX_RETRIES } from '@hub/messaging';
export const NORMALIZE_RETRY_HEADER = 'x-normalize-retry';

/** BP1 (ADR-195): bảng mã nằm ở `classifyInfraError` (dùng chung với delivery); hành vi normalize giữ nguyên. */
export function classifyNormalizeError(err: unknown): NormalizeErrorKind {
  return classifyInfraError(err) === 'transient' ? 'transient' : 'permanent';
}

/** Đọc số lần đã retry từ header (RabbitMQ giữ nguyên header khi dead-letter từ hàng đợi TTL). */
export function readNormalizeRetryCount(headers: Record<string, unknown> | undefined): number {
  const n = Number(headers?.[NORMALIZE_RETRY_HEADER] ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
