/**
 * DX3 (SPEC-dev-experience §4.3 luật Parity, ADR-055): body JSON hub gửi tới đích webhook — NGUỒN DUY NHẤT.
 * `WebhookSender` (hub-worker, push thật) và `hub listen` (CLI của SDK, kéo bằng polling A rồi đẩy vào localhost)
 * cùng gọi hàm này -> cùng một event cho ra body BẰNG NHAU TỪNG BYTE. Cấm viết serializer thứ hai: code dev thử ở
 * local mà nhận body khác production là bug khó thấy nhất.
 *
 * Không import gì (kể cả từ `@hub/common`) -> CLI nạp được file này mà không kéo logger/pino.
 * Phong bì: docs/EVENT-CATALOG.md §1. Thứ tự khoá cố định ở đây là một phần của hợp đồng byte.
 */
export interface WebhookBodyEvent {
  id: string;
  type: string;
  source: string;
  /** id source cụ thể (R-1, ADR-094); rỗng/thiếu -> null. */
  sourceId?: string | null;
  /** null/thiếu -> BỎ khỏi body (event không có subject; worker vẫn làm vậy từ trước). */
  subject?: string | null;
  /** S3-2 (ADR-053): thiếu = true (event cũ trước S3-2). */
  normalized?: boolean;
  data: unknown;
  occurredAt: string | Date;
  receivedAt: string | Date;
}

const iso = (v: string | Date | undefined): string | undefined => (v instanceof Date ? v.toISOString() : v);

/** Chuỗi JSON (không phải object) để người gọi ký đúng bytes sẽ gửi. `renderedContent` rỗng -> bỏ. */
export function toWebhookBody(event: WebhookBodyEvent, renderedContent?: string): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    source: event.source,
    sourceId: event.sourceId || null,
    subject: event.subject ?? undefined,
    normalized: event.normalized !== false,
    data: event.data,
    occurredAt: iso(event.occurredAt),
    receivedAt: iso(event.receivedAt),
    renderedContent: renderedContent || undefined,
  });
}
