-- CB1 (SPEC-canh-bao-nhan-dinh §3 + DINH-CHINH-2026-10-12 D1/D2/D3, ADR-165..167): cảnh báo cho người vận hành.
-- Chỉ DDL — bảng mới + một cột có DEFAULT hằng (PG 11+ chỉ ghi metadata). Không có dữ liệu cần backfill, nên không cần
-- `SET LOCAL app.rls_system` (gate data-migration-rls chỉ áp cho migration dữ liệu).
--   hub.alerts            — mang tenant_id, RLS, qua TenantScopedRepository (BB-5). Trọng tài chống trùng = unique index
--                           MỘT PHẦN (tenant_id, rule, subject_id) WHERE state='OPEN' (Postgres, không Redis — như BB-2).
--   hub.alert_emails      — outbox email theo NGƯỜI (D1); mang tenant_id + RLS (D2), khoá ngoại ghép (alert_id, tenant_id).
--   hub.alert_preferences — gắn NGƯỜI DÙNG, không tenant_id, không RLS — chỉ qua IdentityRepository (như users).
--   users.locale          — vi|en, mặc định vi (D3): worker chọn ngôn ngữ email.

-- CreateEnum
CREATE TYPE "hub"."AlertSeverity" AS ENUM ('critical', 'warning', 'info');

-- CreateEnum
CREATE TYPE "hub"."AlertSubjectType" AS ENUM ('destination', 'source', 'project');

-- CreateEnum
CREATE TYPE "hub"."AlertState" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "hub"."AlertEmailKind" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "hub"."AlertEmailState" AS ENUM ('PENDING', 'SENT', 'SUPPRESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "hub"."UserLocale" AS ENUM ('vi', 'en');

-- AlterTable
ALTER TABLE "hub"."users" ADD COLUMN     "locale" "hub"."UserLocale" NOT NULL DEFAULT 'vi';

-- CreateTable
CREATE TABLE "hub"."alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule" VARCHAR(64) NOT NULL,
    "severity" "hub"."AlertSeverity" NOT NULL,
    "subject_type" "hub"."AlertSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "state" "hub"."AlertState" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "facts" JSONB NOT NULL DEFAULT '{}',
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" UUID,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."alert_emails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "hub"."AlertEmailKind" NOT NULL,
    "state" "hub"."AlertEmailState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "alert_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub"."alert_preferences" (
    "user_id" UUID NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_rules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email_on_resolve" BOOLEAN NOT NULL DEFAULT false,
    "muted_projects" UUID[] DEFAULT ARRAY[]::UUID[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "alerts_tenant_id_state_opened_at_idx" ON "hub"."alerts"("tenant_id", "state", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "alerts_state_severity_opened_at_idx" ON "hub"."alerts"("state", "severity", "opened_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "alerts_id_tenant_id_key" ON "hub"."alerts"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "alert_emails_user_id_created_at_idx" ON "hub"."alert_emails"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "alert_emails_state_created_at_idx" ON "hub"."alert_emails"("state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "alert_emails_alert_id_user_id_kind_key" ON "hub"."alert_emails"("alert_id", "user_id", "kind");

-- AddForeignKey
ALTER TABLE "hub"."alert_emails" ADD CONSTRAINT "alert_emails_alert_id_tenant_id_fkey" FOREIGN KEY ("alert_id", "tenant_id") REFERENCES "hub"."alerts"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."alert_emails" ADD CONSTRAINT "alert_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "hub"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."alert_preferences" ADD CONSTRAINT "alert_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "hub"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Bất biến chống trùng (§3.1, CB:T2): hai evaluator cùng chạy chỉ để lại MỘT dòng OPEN cho mỗi (tenant, rule, subject).
-- `INSERT … ON CONFLICT (tenant_id, rule, subject_id) WHERE state = 'OPEN' DO UPDATE` suy ra đúng index này. Prisma 6 không
-- khai được index có WHERE trong schema.prisma -> chỉ nằm ở đây (schema.prisma ghi chú tại model Alert).
CREATE UNIQUE INDEX "alerts_open_unique" ON "hub"."alerts"("tenant_id", "rule", "subject_id") WHERE "state" = 'OPEN';

-- AU6 (ADR-108): RLS như mọi bảng mang tenant_id — FORCE để cả owner (không BYPASSRLS) cũng bị lọc.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alerts', 'alert_emails'] LOOP
    EXECUTE format('ALTER TABLE hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hub.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON hub.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON hub.%I
        USING      (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                    OR current_setting('app.rls_system', true) = 'on')
        WITH CHECK (tenant_id = NULLIF(current_setting('app.project_id', true), '')::uuid
                    OR current_setting('app.rls_system', true) = 'on')$p$, t);
  END LOOP;
END
$$;

-- Runtime hub_app: DEFAULT PRIVILEGES (AU6) đã cấp cho bảng mới cùng owner; GRANT tường minh cho chắc (idempotent),
-- phòng khi migration chạy bằng role khác owner của default privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hub"."alerts", "hub"."alert_emails", "hub"."alert_preferences" TO hub_app;
  END IF;
END
$$;
