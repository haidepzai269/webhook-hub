-- EG4 (SPEC-chong-qua-tai §5, ADR-179): lưu lượng theo source, gộp theo PHÚT. hub-api đếm trong bộ nhớ ở `traced()`
-- (không thêm truy vấn nào vào đường nóng) rồi upsert theo lô mỗi 60s. 404 của sourceKey lạ KHÔNG vào đây (không thuộc
-- tenant nào, BB-5) — chỉ có ở metric + log. Chỉ DDL — bảng mới, không backfill.

-- CreateEnum
CREATE TYPE "hub"."TrafficOutcome" AS ENUM ('ACCEPTED', 'DUPLICATE', 'REJECTED', 'RATE_LIMITED', 'BLOCKED');

-- CreateTable
CREATE TABLE "hub"."source_traffic_minutely" (
    "tenant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "minute" TIMESTAMPTZ(6) NOT NULL,
    "outcome" "hub"."TrafficOutcome" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "top_ips" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "source_traffic_minutely_pkey" PRIMARY KEY ("tenant_id","source_id","minute","outcome")
);

-- CreateIndex (dọn dữ liệu cũ xuyên project theo `minute`; đọc theo source dùng tiền tố PK (tenant_id, source_id, minute))
CREATE INDEX "source_traffic_minutely_minute_idx" ON "hub"."source_traffic_minutely"("minute");

-- AddForeignKey (ghép: không ghi được lưu lượng cho source của project khác)
ALTER TABLE "hub"."source_traffic_minutely" ADD CONSTRAINT "source_traffic_minutely_source_id_tenant_id_fkey" FOREIGN KEY ("source_id", "tenant_id") REFERENCES "hub"."sources"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AU6 (ADR-108): RLS như mọi bảng mang tenant_id — FORCE để cả owner (không BYPASSRLS) cũng bị lọc.
ALTER TABLE hub.source_traffic_minutely ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub.source_traffic_minutely FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hub.source_traffic_minutely;
CREATE POLICY tenant_isolation ON hub.source_traffic_minutely
  USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
              OR current_setting('app.rls_system', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hub"."source_traffic_minutely" TO hub_app;
  END IF;
END
$$;
