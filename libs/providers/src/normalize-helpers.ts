import { NormalizedEvent, ProviderType } from '@hub/common';
import { ulid } from 'ulidx';
import { bodyHashKey } from '@hub/crypto';

/** Ngữ cảnh normalize mà lõi truyền cho adapter. */
export interface NormalizeContext {
  tenantId: string;
  sourceId: string;
  correlationId: string;
  rawEventId: string;
  /**
   * Review SPEC-3 #4: thời điểm hub NHẬN raw event (`raw_events.received_at`). Dùng cho `receivedAt` và
   * làm thời gian dự phòng khi provider không gửi thời gian giao dịch — renormalize ra CÙNG giá trị.
   */
  receivedAt?: string;
  /** S8: `sources.verification_config` — chỉ GenericAdapter đọc. */
  verificationConfig?: unknown;
}

/** Thời gian dự phòng ổn định: thời điểm nhận raw event; chỉ khi không có mới dùng giờ hiện tại. */
export function receivedTime(ctx: NormalizeContext): string {
  return ctx.receivedAt ?? new Date().toISOString();
}

/** Phong bì chung (luật 1 §4.14.1) — adapter chỉ quyết định type/subject/data/occurredAt/normalized. */
export function envelope(
  provider: ProviderType,
  ctx: NormalizeContext,
  e: { type: string; subject?: string; data: Record<string, unknown>; occurredAt?: string; normalized: boolean; id?: string; probe?: true },
): NormalizedEvent {
  const now = receivedTime(ctx);
  return {
    ...(e.probe ? { probe: true } : {}),
    id: e.id ?? `evt_${ulid()}`,
    tenantId: ctx.tenantId,
    type: e.type,
    source: provider,
    sourceId: ctx.sourceId,
    subject: e.subject,
    data: e.data,
    occurredAt: e.occurredAt ?? now,
    receivedAt: now,
    correlationId: ctx.correlationId,
    rawEventId: ctx.rawEventId,
    origin: 'webhook',
    normalized: e.normalized,
  };
}

/**
 * Số tiền: nhận number, hoặc chuỗi CHỈ gồm chữ số. Còn lại trả nguyên để validator báo `amount`
 * (hub không đoán định dạng số — "50.000" là sai).
 */
export function amountOf(v: unknown): unknown {
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
}

/**
 * Id giao dịch dự phòng (review SPEC-3 #1): provider không gửi id nào thì dùng hash của body gốc,
 * KHÔNG để null (null làm validator từ chối -> 0 event dù hub đã trả 200). Cùng body -> cùng giá trị,
 * khớp với khoá chống trùng dự phòng (S3-1).
 */
export function fallbackTxnId(rawBody: Buffer | string): string {
  return `sha:${bodyHashKey(rawBody)}`;
}

/** Chuỗi rỗng / thiếu -> null (luật 7: khoá luôn có mặt, thiếu dữ liệu thì null). */
export function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}
