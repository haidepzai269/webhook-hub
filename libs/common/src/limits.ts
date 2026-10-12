/**
 * ADR-162: trần kích thước body của MỘT request ingest — nguồn sự thật DUY NHẤT. `apps/hub-api/src/body-parsers.ts`
 * đặt limit của express.json/urlencoded cho /hooks/* bằng số này (mặc định Express chỉ 100KB → push GitHub lớn bị 413 trước khi
 * vào ingest, không ghi gì) và `IngestService` kiểm lại trên `rawBody` (đường /events, test gọi thẳng service).
 */
export const MAX_INGEST_PAYLOAD_BYTES = 1024 * 1024;

/** ADR-162: trần body của mọi route KHÔNG phải /hooks/* (console, /v1/p, auth…) — giữ đúng mặc định cũ 100KB. */
export const MAX_API_BODY_BYTES = 100 * 1024;

/**
 * QT9 (SPEC-han-muc-dung-luong §10, Q11): trần số source CHƯA lưu trữ mỗi project (`SOURCE_LIMIT_PER_PROJECT`, mặc định 20).
 * Hạn mức dung lượng chặn ổ, không chặn TỐC ĐỘ (N × 100 req/phút đè lên worker + RabbitMQ chung). Operator không bị giới hạn.
 */
export const DEFAULT_SOURCE_LIMIT_PER_PROJECT = 20;
export function resolveSourceLimitPerProject(v: string | undefined = process.env.SOURCE_LIMIT_PER_PROJECT): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 ? n : DEFAULT_SOURCE_LIMIT_PER_PROJECT;
}
