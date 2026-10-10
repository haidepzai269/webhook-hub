-- MS-R6 (review đa service pha 1, ADR-087).
-- 1) api_keys.scopes / read_types NOT NULL, mặc định mảng rỗng: dữ liệu tay NULL làm `key.scopes.includes` ném 500.
UPDATE "hub"."api_keys" SET "scopes" = ARRAY[]::TEXT[] WHERE "scopes" IS NULL;
UPDATE "hub"."api_keys" SET "read_types" = ARRAY[]::TEXT[] WHERE "read_types" IS NULL;
ALTER TABLE "hub"."api_keys" ALTER COLUMN "scopes" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "hub"."api_keys" ALTER COLUMN "scopes" SET NOT NULL;
ALTER TABLE "hub"."api_keys" ALTER COLUMN "read_types" SET NOT NULL;
-- 2) origin 'api': raw_event + event do service tự phát qua POST /v1/p/:project/events (không phải webhook bên thứ ba).
--    Thêm giá trị enum (PG ≥ 12 cho phép trong transaction; không dùng giá trị mới trong cùng migration).
ALTER TYPE "hub"."EventOrigin" ADD VALUE IF NOT EXISTS 'api';
