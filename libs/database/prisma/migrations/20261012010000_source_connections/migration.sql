-- KN2 (SPEC-ket-noi §4.2, ADR-138): hub tự đăng ký URL ingest tại provider (biến thể A). Chỉ DDL — không có dữ liệu
-- cần backfill (bảng mới), nên không cần `SET LOCAL app.rls_system` (gate data-migration-rls chỉ áp cho migration dữ liệu).

CREATE TYPE "hub"."ConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'FAILED', 'DRIFTED', 'DISCONNECTED');

-- Đích của khoá ngoại ghép (source_id, tenant_id) — id đã unique nên index này luôn tạo được.
CREATE UNIQUE INDEX "sources_id_tenant_id_key" ON "hub"."sources"("id", "tenant_id");

CREATE TABLE "hub"."source_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "provider" "hub"."ProviderEnum" NOT NULL,
    -- AES-256-GCM bằng MASTER_KEY. KHÔNG có cột plaintext. NULL = đã "Xoá credentials".
    "credentials_encrypted" TEXT,
    "status" "hub"."ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "remote_ref" VARCHAR(255),
    "display" VARCHAR(255),
    "ingest_url" TEXT NOT NULL,
    "last_error" VARCHAR(255),
    "last_fix" TEXT,
    "connected_at" TIMESTAMPTZ(6),
    "last_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_connections_source_id_key" ON "hub"."source_connections"("source_id");
CREATE INDEX "source_connections_tenant_id_idx" ON "hub"."source_connections"("tenant_id");

-- Khoá ngoại GHÉP: kết nối không bao giờ trỏ sang source của project khác, kể cả khi code quên kiểm.
ALTER TABLE "hub"."source_connections" ADD CONSTRAINT "source_connections_source_id_tenant_id_fkey"
  FOREIGN KEY ("source_id", "tenant_id") REFERENCES "hub"."sources"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AU6 (ADR-108): RLS như mọi bảng mang tenant_id — FORCE để cả owner (không BYPASSRLS) cũng bị lọc.
ALTER TABLE "hub"."source_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hub"."source_connections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "hub"."source_connections";
CREATE POLICY tenant_isolation ON "hub"."source_connections"
  USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on');

-- Runtime hub_app: DEFAULT PRIVILEGES (AU6) đã cấp cho bảng mới cùng owner; GRANT tường minh cho chắc (idempotent),
-- phòng khi migration chạy bằng role khác owner của default privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hub"."source_connections" TO hub_app;
  END IF;
END
$$;
