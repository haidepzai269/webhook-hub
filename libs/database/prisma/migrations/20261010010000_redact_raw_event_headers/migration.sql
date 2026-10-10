-- Review SPEC-1 #1 (ADR-051): dọn dữ liệu cũ. Trước bản vá, ingest lưu NGUYÊN header -> API key SePay
-- (`Authorization: Apikey <key>`) nằm rõ trong hub.raw_events.headers và signature_header, lộ qua
-- GET /api/v1/events/:id. Ingest mới che trước khi lưu; migration này che các dòng đã có.
--
-- Quy tắc che giống redactHeaderValue() (apps/hub-api/src/modules/ingest/redact-headers.ts):
--   "<scheme> <phần còn lại>" -> "<scheme> ***" nếu scheme là một token; ngược lại -> "***".
-- Header nhạy cảm: authorization, cookie, x-api-key, proxy-authorization (so sánh lower()).
-- body_raw KHÔNG đụng (bytes gốc, cần cho điều tra/replay). Chỉ đổi dữ liệu, không đổi schema.
-- Chạy lại vô hại: giá trị đã che ("Apikey ***", "***") che lần nữa vẫn y nguyên, và WHERE bỏ qua chúng.

UPDATE hub.raw_events r
SET headers = (
  SELECT jsonb_object_agg(
           e.k,
           CASE
             WHEN lower(e.k) IN ('authorization', 'cookie', 'x-api-key', 'proxy-authorization')
                  AND jsonb_typeof(e.v) = 'string' AND (e.v #>> '{}') <> ''
             THEN to_jsonb(
                    CASE WHEN (e.v #>> '{}') ~ '^[A-Za-z][A-Za-z0-9._~+-]* '
                         THEN split_part(e.v #>> '{}', ' ', 1) || ' ***'
                         ELSE '***' END)
             ELSE e.v
           END)
  FROM jsonb_each(r.headers) AS e(k, v)
)
WHERE jsonb_typeof(r.headers) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_each(r.headers) AS e(k, v)
    WHERE lower(e.k) IN ('authorization', 'cookie', 'x-api-key', 'proxy-authorization')
      AND jsonb_typeof(e.v) = 'string'
      AND (e.v #>> '{}') <> ''
      AND (e.v #>> '{}') !~ '^([A-Za-z][A-Za-z0-9._~+-]* )?\*\*\*$'
  );

-- signature_header = JSON.stringify(x-hub-signature-256 || authorization || ''). Chữ ký HMAC
-- ("sha256=...") không phải bí mật -> giữ; mọi chuỗi khác (Authorization của SePay) -> che.
UPDATE hub.raw_events
SET signature_header = to_jsonb(
      CASE WHEN (signature_header::jsonb #>> '{}') ~ '^[A-Za-z][A-Za-z0-9._~+-]* '
           THEN split_part(signature_header::jsonb #>> '{}', ' ', 1) || ' ***'
           ELSE '***' END)::text
WHERE signature_header IS NOT NULL
  AND signature_header LIKE '"%'
  AND signature_header <> '""'
  AND signature_header NOT LIKE '"sha256=%'
  AND (signature_header::jsonb #>> '{}') !~ '^([A-Za-z][A-Za-z0-9._~+-]* )?\*\*\*$';
