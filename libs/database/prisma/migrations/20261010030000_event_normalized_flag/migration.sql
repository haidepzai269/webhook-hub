-- S3-2 (ADR-053): cờ "data theo catalog kiểu chuẩn". DEFAULT true -> chạy được trên bảng đang có
-- dữ liệu (Postgres 11+ thêm cột có default hằng số không viết lại bảng). Event cũ KHÔNG migrate
-- dữ liệu (vẫn kiểu cũ, retention tự dọn) — cờ của chúng mặc định true như hợp đồng cũ.
ALTER TABLE "hub"."events" ADD COLUMN "normalized" BOOLEAN NOT NULL DEFAULT true;
