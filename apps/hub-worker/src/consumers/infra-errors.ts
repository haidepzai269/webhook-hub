import { Prisma } from '@prisma/client';

/**
 * Phân loại lỗi HẠ TẦNG CỦA CHÍNH HUB (BP1, ADR-195) — dùng chung cho normalize và delivery (sau này BP5).
 *
 * - `transient`: Postgres mất kết nối / pool hết chỗ / deadlock-serialization / transaction timeout, mạng reset.
 *   Đợi một lúc rồi thử lại là khỏi.
 * - `unknown`: mọi thứ còn lại (bug, dữ liệu lạ, lỗi adapter...). Không đoán là tự khỏi.
 *
 * Bảng mã giữ NGUYÊN như bảng của normalize trước BP1 (S1-3, ADR-044): chỉ lỗi được liệt kê rõ mới là `transient`.
 */
export type InfraErrorKind = 'transient' | 'unknown';

// P2028 = Transaction API error (timeout giữ/chờ transaction khi DB chậm) — hạ tầng, thử lại là khỏi.
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']);

export function classifyInfraError(err: unknown): InfraErrorKind {
  const e = err as { name?: string; code?: unknown; errorCode?: unknown; cause?: { code?: unknown } } | null;
  if (!e) return 'unknown';

  // So sánh theo `name` ngoài `instanceof`: hai bản @prisma/client khác nhau (dist cũ, jest) vẫn nhận ra.
  const isKnown = err instanceof Prisma.PrismaClientKnownRequestError || e.name === 'PrismaClientKnownRequestError';
  if (isKnown) return TRANSIENT_PRISMA_CODES.has(String(e.code)) ? 'transient' : 'unknown';

  if (err instanceof Prisma.PrismaClientInitializationError || e.name === 'PrismaClientInitializationError') {
    return 'transient';
  }

  if (TRANSIENT_NET_CODES.has(String(e.code)) || TRANSIENT_NET_CODES.has(String(e.cause?.code))) return 'transient';

  return 'unknown';
}
