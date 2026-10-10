-- MS-P2-5 (ADR-092): migration 20261011000000 chỉ chèn project `default`. DB cũ có dữ liệu mang tenant_id khác thì
-- không có dòng `projects` -> console không thấy, không tạo key được. Tạo project cho MỌI tenant_id còn thiếu trong
-- các bảng nghiệp vụ. slug = 'tenant-' + 32 hex của id (duy nhất, khớp PROJECT_SLUG_RE). Idempotent (ON CONFLICT).
INSERT INTO "hub"."projects" ("id", "slug", "name", "environment")
SELECT t.tenant_id, 'tenant-' || replace(t.tenant_id::text, '-', ''), 'Tenant ' || left(t.tenant_id::text, 8), 'test'
FROM (
  SELECT tenant_id FROM "hub"."sources"
  UNION SELECT tenant_id FROM "hub"."destinations"
  UNION SELECT tenant_id FROM "hub"."subscriptions"
  UNION SELECT tenant_id FROM "hub"."events"
  UNION SELECT tenant_id FROM "hub"."deliveries"
  UNION SELECT tenant_id FROM "hub"."api_keys"
  UNION SELECT tenant_id FROM "hub"."audit_logs"
) t
WHERE t.tenant_id IS NOT NULL
ON CONFLICT DO NOTHING;
