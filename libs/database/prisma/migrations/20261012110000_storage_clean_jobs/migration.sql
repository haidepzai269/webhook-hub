-- QT4 (SPEC-han-muc-dung-luong §5.5 + ĐÍNH CHÍNH E2, ADR-184): LỆNH DỌN. `POST …/storage/clean` (và `apply` gợi ý, QT4b)
-- chỉ ghi một dòng PENDING rồi trả 202 + id; hub-worker nhận lệnh bằng `FOR UPDATE SKIP LOCKED` (an toàn nhiều instance,
-- như outbox relay) và chạy THEO LÔ — mỗi lô một transaction ngắn, cộng tiến độ + byte giải phóng trong CÙNG transaction.
-- Chỉ DDL — bảng mới, không backfill. `lock_timeout` như QT1 (review QT-S1 L2): không xếp hàng chặn đường nóng.
SELECT set_config('lock_timeout', '5s', false);

CREATE TABLE "hub"."storage_clean_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "action" VARCHAR(8) NOT NULL,
    "importance" TEXT[] NOT NULL,
    "older_than" VARCHAR(40) NOT NULL,
    "cutoff" TIMESTAMPTZ(6) NOT NULL,
    "source_id" UUID,
    "origin" VARCHAR(16) NOT NULL DEFAULT 'manual',
    "suggestion_id" VARCHAR(64),
    "advisor" VARCHAR(32),
    "requested_by" VARCHAR(128) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "events_affected" INTEGER NOT NULL DEFAULT 0,
    "rejected_affected" INTEGER NOT NULL DEFAULT 0,
    "freed_bytes" BIGINT NOT NULL DEFAULT 0,
    "batches" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(6),
    "error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "storage_clean_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_clean_jobs_action_check" CHECK ("action" IN ('trim', 'delete')),
    -- "Giữ" không bao giờ nằm trong lệnh dọn (§5.3); audit_logs không phải một "mức" nên không thể nêu tên ở đây.
    CONSTRAINT "storage_clean_jobs_importance_check" CHECK ("importance" <@ ARRAY['junk', 'low', 'medium', 'high']::text[] AND cardinality("importance") > 0),
    CONSTRAINT "storage_clean_jobs_origin_check" CHECK ("origin" IN ('manual', 'suggestion')),
    CONSTRAINT "storage_clean_jobs_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))
);

ALTER TABLE "hub"."storage_clean_jobs" ADD CONSTRAINT "storage_clean_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "hub"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Worker tìm lệnh chờ / lệnh RUNNING hết lease (index một phần: bảng lớn dần theo lịch sử, phần đang chờ luôn nhỏ).
CREATE INDEX "storage_clean_jobs_pending_idx" ON "hub"."storage_clean_jobs"("created_at") WHERE "status" IN ('PENDING', 'RUNNING');
-- Console: lệnh gần đây của project; `apply` idempotent theo id gợi ý (QT4b).
CREATE INDEX "storage_clean_jobs_tenant_created_idx" ON "hub"."storage_clean_jobs"("tenant_id", "created_at" DESC);
CREATE INDEX "storage_clean_jobs_tenant_suggestion_idx" ON "hub"."storage_clean_jobs"("tenant_id", "suggestion_id") WHERE "suggestion_id" IS NOT NULL;

-- AU6 (ADR-108): RLS như mọi bảng mang tenant_id — FORCE để cả owner (không BYPASSRLS) cũng bị lọc.
ALTER TABLE hub.storage_clean_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.storage_clean_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hub.storage_clean_jobs;
CREATE POLICY tenant_isolation ON hub.storage_clean_jobs
  USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hub"."storage_clean_jobs" TO hub_app;
  END IF;
END
$$;

SELECT set_config('lock_timeout', '0', false);
