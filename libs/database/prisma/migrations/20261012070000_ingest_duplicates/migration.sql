-- CB6 (SPEC-canh-bao-nhan-dinh §7 `I-dup`, ADR-171): bộ đếm bản trùng hub đã chặn, theo (source, giờ UTC).
-- Bản trùng KHÔNG được lưu vào raw_events (unique (source_id, idempotency_key) là trọng tài, BB-2) nên trước đây Postgres
-- không biết gì về chúng. Chỉ DDL — bảng mới, không backfill (không cần `SET LOCAL app.rls_system`).

-- CreateTable
CREATE TABLE "hub"."ingest_duplicates" (
    "tenant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "bucket" TIMESTAMPTZ(6) NOT NULL,
    "n" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ingest_duplicates_pkey" PRIMARY KEY ("tenant_id","source_id","bucket")
);

-- CreateIndex
CREATE INDEX "ingest_duplicates_tenant_id_bucket_idx" ON "hub"."ingest_duplicates"("tenant_id", "bucket" DESC);

-- AddForeignKey (ghép: không đếm được cho source của project khác)
ALTER TABLE "hub"."ingest_duplicates" ADD CONSTRAINT "ingest_duplicates_source_id_tenant_id_fkey" FOREIGN KEY ("source_id", "tenant_id") REFERENCES "hub"."sources"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AU6 (ADR-108): RLS như mọi bảng mang tenant_id — FORCE để cả owner (không BYPASSRLS) cũng bị lọc.
ALTER TABLE hub.ingest_duplicates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.ingest_duplicates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hub.ingest_duplicates;
CREATE POLICY tenant_isolation ON hub.ingest_duplicates
  USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hub"."ingest_duplicates" TO hub_app;
  END IF;
END
$$;
