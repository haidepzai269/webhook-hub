-- R2-2 (ADR-098): DB nâng cấp từ trước R-1 — endpoint tạo qua /v1/p có created_by_key_id = NULL (key của service không
-- thấy nó -> ensure tạo endpoint thứ hai). Gán chủ theo audit `endpoint.create` có actor `key:<uuid>` (chỉ /v1/p ghi
-- actor dạng này). Đích của operator (console/seed) giữ NULL. Idempotent: chỉ đụng dòng còn NULL.
UPDATE "hub"."destinations" d
SET "created_by_key_id" = substring(a."actor" from 5)::uuid
FROM "hub"."audit_logs" a
WHERE d."created_by_key_id" IS NULL
  AND d."type" = 'webhook'
  AND a."tenant_id" = d."tenant_id"
  AND a."action" = 'endpoint.create'
  AND a."entity_type" = 'destination'
  AND a."entity_id" = d."id"::text
  AND a."actor" ~ '^key:[0-9a-f-]{36}$';
