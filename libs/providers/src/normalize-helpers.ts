import { NormalizedEvent, ProviderType } from '@hub/common';
import { ulid } from 'ulidx';

/** Ngữ cảnh normalize mà lõi truyền cho adapter. */
export interface NormalizeContext {
  tenantId: string;
  sourceId: string;
  correlationId: string;
  rawEventId: string;
}

/** Phong bì chung (luật 1 §4.14.1) — adapter chỉ quyết định type/subject/data/occurredAt/normalized. */
export function envelope(
  provider: ProviderType,
  ctx: NormalizeContext,
  e: { type: string; subject?: string; data: Record<string, unknown>; occurredAt?: string; normalized: boolean; id?: string },
): NormalizedEvent {
  const now = new Date().toISOString();
  return {
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

/** Chuỗi rỗng / thiếu -> null (luật 7: khoá luôn có mặt, thiếu dữ liệu thì null). */
export function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}
