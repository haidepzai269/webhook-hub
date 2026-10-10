-- S1 đa service (SPEC-hub-multi-service §4.1, ADR-038/041). Chạy được trên DB đang có dữ liệu:
-- mọi cột mới nullable hoặc có default; `events.seq` BIGSERIAL tự đánh số các dòng cũ;
-- khoá ngoại ghép chỉ thêm được nếu không có subscription trỏ sang đích của tenant khác (dữ liệu bẩn
-- -> migration ĐỎ và dừng, không âm thầm xoá gì).

-- AlterEnum (ADD VALUE không chạy được trong transaction cùng lệnh dùng giá trị đó — ở đây không dùng)
ALTER TYPE "hub"."ProviderEnum" ADD VALUE 'generic';
ALTER TYPE "hub"."ProviderEnum" ADD VALUE 'api';

-- CreateEnum
CREATE TYPE "hub"."ProjectEnv" AS ENUM ('test', 'live');
CREATE TYPE "hub"."EndpointVerification" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateTable projects (bảng gốc: id = tenant_id ở mọi bảng nghiệp vụ)
CREATE TABLE "hub"."projects" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "environment" "hub"."ProjectEnv" NOT NULL DEFAULT 'test',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "projects_slug_key" ON "hub"."projects"("slug");

-- Project mặc định (= DEFAULT_TENANT_ID) TRƯỚC mọi thứ khác: dữ liệu cũ đều thuộc project này.
INSERT INTO "hub"."projects" ("id", "slug", "name", "environment")
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default', 'test')
ON CONFLICT ("id") DO NOTHING;

-- CreateTable api_keys (chỉ lưu sha256 của key)
CREATE TABLE "hub"."api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "service_name" VARCHAR(128) NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "scopes" TEXT[],
    "read_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_id" UUID,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "hub"."api_keys"("key_hash");
CREATE UNIQUE INDEX "api_keys_source_id_key" ON "hub"."api_keys"("source_id");
CREATE INDEX "api_keys_tenant_id_idx" ON "hub"."api_keys"("tenant_id");
ALTER TABLE "hub"."api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "hub"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- sources: cấu hình GenericAdapter (S8)
ALTER TABLE "hub"."sources" ADD COLUMN "verification_config" JSONB;

-- events: cursor polling + source
ALTER TABLE "hub"."events" ADD COLUMN "seq" BIGSERIAL NOT NULL;
ALTER TABLE "hub"."events" ADD COLUMN "source_id" UUID;
CREATE UNIQUE INDEX "events_seq_key" ON "hub"."events"("seq");
CREATE INDEX "events_tenant_id_seq_idx" ON "hub"."events"("tenant_id", "seq");
-- Event cũ: lấy source từ raw_event của nó (event không còn raw_event thì để NULL)
UPDATE "hub"."events" e SET "source_id" = r."source_id" FROM "hub"."raw_events" r WHERE e."raw_event_id" = r."id" AND e."source_id" IS NULL;

-- destinations: challenge (S6) + đích của khoá ngoại ghép
ALTER TABLE "hub"."destinations" ADD COLUMN "verification" "hub"."EndpointVerification" NOT NULL DEFAULT 'VERIFIED',
ADD COLUMN "verified_at" TIMESTAMPTZ(6),
ADD COLUMN "verification_error" VARCHAR(64);
CREATE UNIQUE INDEX "destinations_id_tenant_id_key" ON "hub"."destinations"("id", "tenant_id");

-- subscriptions: lọc source + khoá ngoại GHÉP thay FK đơn (vẫn RESTRICT, ADR-054)
ALTER TABLE "hub"."subscriptions" ADD COLUMN "source_ids" UUID[] DEFAULT ARRAY[]::UUID[];
ALTER TABLE "hub"."subscriptions" DROP CONSTRAINT "subscriptions_destination_id_fkey";
ALTER TABLE "hub"."subscriptions" ADD CONSTRAINT "subscriptions_destination_id_tenant_id_fkey" FOREIGN KEY ("destination_id", "tenant_id") REFERENCES "hub"."destinations"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
