import { Prisma } from '@prisma/client';

/**
 * Phân loại lỗi HẠ TẦNG CỦA CHÍNH HUB (BP1, ADR-195) — dùng chung cho normalize và delivery (sau này BP5).
 *
 * - `transient`: Postgres mất kết nối / pool hết chỗ / deadlock-serialization / transaction timeout, mạng reset.
 *   Đợi một lúc rồi thử lại là khỏi.
 * - `unknown`: mọi thứ còn lại (bug, dữ liệu lạ, lỗi adapter...). Không đoán là tự khỏi.
 *
 * Bảng mã của normalize trước BP1 (S1-3, ADR-044) + (BP5, ADR-200) Postgres cắt kết nối (57P0x, lớp 08). Chỉ lỗi được liệt kê
 * rõ mới là `transient`. `classifyNormalizeError` gọi hàm này nên đổi theo.
 */
export type InfraErrorKind = 'transient' | 'unknown';

// P2028 = Transaction API error (timeout giữ/chờ transaction khi DB chậm) — hạ tầng, thử lại là khỏi.
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']);
/**
 * BP5 (ADR-200, nợ §16 của BP1): Postgres cắt kết nối — SQLSTATE 57P01 (admin_shutdown, Neon autosuspend/restart), 57P02
 * (crash_shutdown), 57P03 (cannot_connect_now), lớp 08 (connection exception). Prisma đưa ra dạng
 * `PrismaClientUnknownRequestError` (message chứa mã/câu của Postgres) hoặc lỗi driver có `code`. Là lỗi HẠ TẦNG của hub.
 */
const TRANSIENT_PG_SQLSTATES = new Set(['57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006']);
const TRANSIENT_PG_MESSAGE = /\b57P0[123]\b|\b08(?:000|001|003|004|006)\b|terminating connection due to administrator command|the database system is (?:shutting down|starting up)|server closed the connection unexpectedly/i;

export function classifyInfraError(err: unknown): InfraErrorKind {
  const e = err as { name?: string; code?: unknown; errorCode?: unknown; cause?: { code?: unknown } } | null;
  if (!e) return 'unknown';

  // So sánh theo `name` ngoài `instanceof`: hai bản @prisma/client khác nhau (dist cũ, jest) vẫn nhận ra.
  const isKnown = err instanceof Prisma.PrismaClientKnownRequestError || e.name === 'PrismaClientKnownRequestError';
  if (isKnown) {
    if (TRANSIENT_PRISMA_CODES.has(String(e.code))) return 'transient';
    // Chaos [BP:T4] phần b (ADR-194): `$queryRaw`/`$executeRaw` bọc lỗi Postgres trong P2010 ("Raw query failed. Code: `57P01`")
    // — Postgres bị giết giữa transaction ra ĐÚNG dạng này. Không xét SQLSTATE bên trong thì normalize coi là lỗi dữ liệu -> DLQ ngay.
    if (String(e.code) === 'P2010') {
      const meta = (e as { meta?: { code?: unknown } }).meta;
      if (TRANSIENT_PG_SQLSTATES.has(String(meta?.code)) || TRANSIENT_PG_MESSAGE.test(String((e as { message?: unknown }).message ?? ''))) return 'transient';
    }
    return 'unknown';
  }

  if (err instanceof Prisma.PrismaClientInitializationError || e.name === 'PrismaClientInitializationError') {
    return 'transient';
  }

  if (TRANSIENT_NET_CODES.has(String(e.code)) || TRANSIENT_NET_CODES.has(String(e.cause?.code))) return 'transient';

  if (TRANSIENT_PG_SQLSTATES.has(String(e.code)) || TRANSIENT_PG_SQLSTATES.has(String(e.cause?.code))) return 'transient';
  if ((err instanceof Prisma.PrismaClientUnknownRequestError || e.name === 'PrismaClientUnknownRequestError') && TRANSIENT_PG_MESSAGE.test(String((e as { message?: unknown }).message ?? ''))) {
    return 'transient';
  }

  // amqplib "Channel closed" (IllegalOperationError) KHÔNG phải lỗi DB -> giữ `unknown` (không làm lệch bộ điều khiển `db`);
  // channel consumer đóng thì main.ts thoát tiến trình (BP5 đóng nợ channel zombie) — message unacked được giao lại.
  return 'unknown';
}
