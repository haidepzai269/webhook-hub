-- AU5b (ADR-127): đăng nhập Google — định danh ỔN ĐỊNH là `sub` của ID token (không bao giờ khoá theo email).
-- Chỉ DDL (bảng users không bật RLS, không có dữ liệu cần backfill).
ALTER TABLE "hub"."users" ADD COLUMN "google_sub" VARCHAR(255);
CREATE UNIQUE INDEX "users_google_sub_key" ON "hub"."users"("google_sub");
