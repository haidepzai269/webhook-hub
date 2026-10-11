-- KQ1 (SPEC-ket-noi §5.1/§11): event là request KIỂM TRA của chính provider (vd PayOS confirm-webhook). Lưu để console thấy,
-- nhưng không định tuyến và polling không trả. Chỉ DDL; DEFAULT hằng -> PG 11+ chỉ ghi metadata, không viết lại bảng.
-- Dòng cũ = false (không phải probe) — đúng hành vi trước đây. Policy RLS theo tenant_id giữ nguyên (không đổi cột khoá).
ALTER TABLE "hub"."events" ADD COLUMN "probe" BOOLEAN NOT NULL DEFAULT false;
