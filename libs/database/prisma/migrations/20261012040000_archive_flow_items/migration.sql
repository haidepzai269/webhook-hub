-- ADR-161: "Ngắt" / "Xoá" trên bản đồ luồng. Xoá = LƯU TRỮ (archived_at), không DELETE — raw_events / deliveries /
-- attempts là bằng chứng đối soát (ADR-054). Đích thêm is_active (trước chỉ source/subscription có) để "Ngắt" được.
-- Chỉ DDL: cột NULL / DEFAULT hằng -> PG 11+ chỉ ghi metadata, không viết lại bảng. Policy RLS theo tenant_id giữ
-- nguyên (không đổi cột khoá); GRANT cho hub_app là cấp bảng nên cột mới tự có quyền.
ALTER TABLE "hub"."sources" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
ALTER TABLE "hub"."destinations" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "hub"."destinations" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
ALTER TABLE "hub"."subscriptions" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
