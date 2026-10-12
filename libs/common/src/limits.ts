/**
 * ADR-162: trần kích thước body của MỘT request ingest — nguồn sự thật DUY NHẤT. `apps/hub-api/src/body-parsers.ts`
 * đặt limit của express.json/urlencoded cho /hooks/* bằng số này (mặc định Express chỉ 100KB → push GitHub lớn bị 413 trước khi
 * vào ingest, không ghi gì) và `IngestService` kiểm lại trên `rawBody` (đường /events, test gọi thẳng service).
 */
export const MAX_INGEST_PAYLOAD_BYTES = 1024 * 1024;

/** ADR-162: trần body của mọi route KHÔNG phải /hooks/* (console, /v1/p, auth…) — giữ đúng mặc định cũ 100KB. */
export const MAX_API_BODY_BYTES = 100 * 1024;
