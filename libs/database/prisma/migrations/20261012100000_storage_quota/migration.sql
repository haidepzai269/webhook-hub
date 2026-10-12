-- QT1 (SPEC-han-muc-dung-luong + ĐÍNH CHÍNH E1/E2/E5, ADR-182/183/186/189): hạn mức dung lượng theo project.
-- Phần DDL (cột NULL / DEFAULT hằng -> PG 11+ chỉ ghi metadata) + bảng mới có RLS + SEED policy dọn tự động mặc định (Q10)
-- cho project ĐÃ CÓ, kèm một dòng audit `system:migration` mỗi project. Phần seed là migration DỮ LIỆU trên bảng có RLS
-- -> đặt app.rls_system ngay đầu (gate data-migration-rls, ADR-111/125). Dùng set_config(…, false) (mức phiên) thay vì
-- SET LOCAL: đúng cả khi công cụ migrate không bọc file trong transaction; trả lại '' ở cuối file.
SELECT set_config('app.rls_system', 'on', false);

-- E2: request bị 507 hiện trong khối "Lưu lượng" (bytes = 0). Giá trị enum mới KHÔNG dùng trong chính migration này.
ALTER TYPE "hub"."TrafficOutcome" ADD VALUE IF NOT EXISTS 'STORAGE_FULL';

-- E2 (ADR-183): đo cộng dồn qua bộ gộp EG4 — số byte thực sự ghi xuống DB theo (source, phút, outcome).
ALTER TABLE "hub"."source_traffic_minutely" ADD COLUMN "bytes" BIGINT NOT NULL DEFAULT 0;

-- §2: operator ghi đè hạn mức (MB). NULL = PROJECT_STORAGE_QUOTA_MB.
ALTER TABLE "hub"."projects" ADD COLUMN "storage_quota_mb" INTEGER;
ALTER TABLE "hub"."projects" ADD CONSTRAINT "projects_storage_quota_mb_check" CHECK ("storage_quota_mb" IS NULL OR "storage_quota_mb" > 0);

-- E1 (ADR-189): cờ "Giữ lâu" do user tự gắn.
ALTER TABLE "hub"."sources" ADD COLUMN "keep_longer" BOOLEAN NOT NULL DEFAULT false;

-- §5.1 (ADR-184): "Dọn" giữ dòng gầy.
ALTER TABLE "hub"."events" ADD COLUMN "trimmed_at" TIMESTAMPTZ(6);
ALTER TABLE "hub"."raw_events" ADD COLUMN "trimmed_at" TIMESTAMPTZ(6);

-- §7 + E2: dung lượng ước tính của project. Một dòng / project (tenant_id = PK). `level` là varchar (thêm nấc không đổi enum).
CREATE TABLE "hub"."project_usage" (
    "tenant_id" UUID NOT NULL,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "calibrated_bytes" BIGINT NOT NULL DEFAULT 0,
    "calibrated_at" TIMESTAMPTZ(6),
    "freed_since_calibration" BIGINT NOT NULL DEFAULT 0,
    "bloat_factor" DECIMAL(6,3) NOT NULL DEFAULT 2,
    "by_source" JSONB NOT NULL DEFAULT '{}',
    "by_bucket" JSONB NOT NULL DEFAULT '[]',
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "suggested_at" TIMESTAMPTZ(6),
    "suggested_bytes" BIGINT,
    "level" VARCHAR(16) NOT NULL DEFAULT 'OK',
    "notified_level" VARCHAR(16),
    "notified_at" TIMESTAMPTZ(6),
    "measured_at" TIMESTAMPTZ(6),

    CONSTRAINT "project_usage_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "project_usage_bloat_factor_check" CHECK ("bloat_factor" >= 1 AND "bloat_factor" <= 4)
);
ALTER TABLE "hub"."project_usage" ADD CONSTRAINT "project_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "hub"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- §5.4: dọn tự động. Chỉ junk/low/medium ("Cao"/"Giữ" không đặt được). after_days ≥ 1 (sàn retry window ~2,6 giờ).
CREATE TABLE "hub"."storage_policies" (
    "tenant_id" UUID NOT NULL,
    "importance" VARCHAR(16) NOT NULL,
    "action" VARCHAR(8) NOT NULL,
    "after_days" INTEGER NOT NULL,
    "trigger" VARCHAR(16) NOT NULL DEFAULT 'always',
    "updated_by" VARCHAR(128) NOT NULL DEFAULT 'system',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_policies_pkey" PRIMARY KEY ("tenant_id", "importance"),
    CONSTRAINT "storage_policies_importance_check" CHECK ("importance" IN ('junk', 'low', 'medium')),
    CONSTRAINT "storage_policies_action_check" CHECK ("action" IN ('trim', 'delete', 'off')),
    CONSTRAINT "storage_policies_trigger_check" CHECK ("trigger" IN ('always', 'above_85')),
    CONSTRAINT "storage_policies_after_days_check" CHECK ("after_days" >= 1)
);
ALTER TABLE "hub"."storage_policies" ADD CONSTRAINT "storage_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "hub"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AU6 (ADR-108): RLS như mọi bảng mang tenant_id — FORCE để cả owner (không BYPASSRLS) cũng bị lọc.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_usage', 'storage_policies'] LOOP
    EXECUTE format('ALTER TABLE hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hub.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON hub.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON hub.%I
        USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                    OR current_setting('app.rls_system', true) = 'on')
        WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                    OR current_setting('app.rls_system', true) = 'on')$p$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE hub.%I TO hub_app', t);
    END IF;
  END LOOP;
END
$$;

-- Q10 / QT:T26: project có sẵn nhận policy mặc định (giống DEFAULT_STORAGE_POLICIES ở libs/common/src/storage/policy.ts)
-- + dòng project_usage (calibrated_at NULL -> job hiệu chỉnh quét thật ở lượt đầu) + MỘT dòng audit mỗi project.
INSERT INTO "hub"."storage_policies" ("tenant_id", "importance", "action", "after_days", "trigger", "updated_by")
SELECT p.id, d.importance, d.action, d.after_days, 'always', 'system:migration'
FROM "hub"."projects" p
CROSS JOIN (VALUES ('junk', 'delete', 1), ('low', 'trim', 3), ('medium', 'off', 5)) AS d(importance, action, after_days)
ON CONFLICT DO NOTHING;

INSERT INTO "hub"."project_usage" ("tenant_id") SELECT id FROM "hub"."projects" ON CONFLICT DO NOTHING;

INSERT INTO "hub"."audit_logs" ("tenant_id", "action", "entity_type", "entity_id", "actor", "reason", "metadata")
SELECT p.id, 'storage.policies.seeded', 'project', p.id::text, 'system:migration',
       'QT1: policy dọn tự động mặc định (Q10) — Rác xoá hẳn sau 1 ngày, Thấp dọn sau 3 ngày',
       '{"policies":[{"importance":"junk","action":"delete","afterDays":1,"trigger":"always"},{"importance":"low","action":"trim","afterDays":3,"trigger":"always"},{"importance":"medium","action":"off","afterDays":5,"trigger":"always"}]}'::jsonb
FROM "hub"."projects" p;

SELECT set_config('app.rls_system', '', false);
