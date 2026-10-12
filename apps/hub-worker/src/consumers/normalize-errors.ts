import { Prisma } from '@prisma/client';

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

// P2028 = Transaction API error (timeout giữ/chờ transaction khi DB chậm) — hạ tầng, thử lại là khỏi.
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']);

export function classifyNormalizeError(err: unknown): NormalizeErrorKind {
  const e = err as { name?: string; code?: unknown; errorCode?: unknown; cause?: { code?: unknown } } | null;
  if (!e) return 'permanent';

  // So sánh theo `name` ngoài `instanceof`: hai bản @prisma/client khác nhau (dist cũ, jest) vẫn nhận ra.
  const isKnown = err instanceof Prisma.PrismaClientKnownRequestError || e.name === 'PrismaClientKnownRequestError';
  if (isKnown) return TRANSIENT_PRISMA_CODES.has(String(e.code)) ? 'transient' : 'permanent';

  if (err instanceof Prisma.PrismaClientInitializationError || e.name === 'PrismaClientInitializationError') {
    return 'transient';
  }

  if (TRANSIENT_NET_CODES.has(String(e.code)) || TRANSIENT_NET_CODES.has(String(e.cause?.code))) return 'transient';

  return 'permanent';
}

/** Đọc số lần đã retry từ header (RabbitMQ giữ nguyên header khi dead-letter từ hàng đợi TTL). */
export function readNormalizeRetryCount(headers: Record<string, unknown> | undefined): number {
  const n = Number(headers?.[NORMALIZE_RETRY_HEADER] ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
