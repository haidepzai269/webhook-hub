import { randomBytes } from 'crypto';

/**
 * LOGGING.md §4 (ADR-250): ngữ cảnh trace theo chuẩn W3C `traceparent` — KHÔNG đổi schema DB.
 * `trace_id` (32 hex) = `correlationId` (UUID v4, 128 bit) bỏ dấu `-`. `span_id` (16 hex) mới mỗi chặng.
 * Mất ngữ cảnh -> bên đọc sinh trace mới (`trace_origin: orphan`), không bao giờ ném lỗi.
 */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TRACEPARENT_HEADER = 'traceparent';
/** Replay là trace MỚI có link về trace gốc (LOGGING.md §4 "Retry vs. replay"). */
export const REPLAY_OF_HEADER = 'x-replay-of';

export interface TraceParent {
  traceId: string;
  spanId: string;
  flags: string;
}

/** `correlationId` (UUID) -> trace_id 32 hex. Không phải UUID ("unknown"…) -> null. */
export function traceIdOf(correlationId: unknown): string | null {
  if (typeof correlationId !== 'string' || !UUID_RE.test(correlationId)) return null;
  return correlationId.replace(/-/g, '').toLowerCase();
}

/** trace_id 32 hex -> UUID dạng chuỗi (cột `correlation_id`). Sai khuôn -> null. */
export function correlationIdOf(traceId: string): string | null {
  if (typeof traceId !== 'string' || !TRACE_ID_RE.test(traceId)) return null;
  return `${traceId.slice(0, 8)}-${traceId.slice(8, 12)}-${traceId.slice(12, 16)}-${traceId.slice(16, 20)}-${traceId.slice(20)}`;
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

/** Parse `traceparent` version 00. Sai khuôn / id toàn 0 / version `ff` -> null (không ném). */
export function parseTraceparent(v: unknown): TraceParent | null {
  if (typeof v !== 'string') return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(v.trim());
  if (!m) return null;
  if (/^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], spanId: m[2], flags: m[3] };
}

/** Span con: cùng trace_id, span_id mới. Cha hỏng -> null. */
export function childTraceparent(parent: unknown): string | null {
  const p = parseTraceparent(parent);
  return p ? formatTraceparent(p.traceId, newSpanId(), p.flags) : null;
}

export function isTraceId(v: unknown): v is string {
  return typeof v === 'string' && TRACE_ID_RE.test(v);
}

export function isSpanId(v: unknown): v is string {
  return typeof v === 'string' && SPAN_ID_RE.test(v);
}
