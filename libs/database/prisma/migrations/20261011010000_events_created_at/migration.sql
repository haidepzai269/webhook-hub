-- S7 (ADR-077): thời điểm INSERT của event — cửa sổ lắng của polling lọc theo cột này, KHÔNG theo
-- received_at (= lúc hub nhận raw event, có thể sớm hơn INSERT rất nhiều khi retry/renormalize).
-- clock_timestamp() (không phải now()): now() là lúc BẮT ĐẦU transaction, sớm hơn lúc cấp seq.
-- Dòng cũ lấy received_at (đã lắng từ lâu). Thêm nullable -> backfill -> default + NOT NULL: chạy được trên bảng có dữ liệu.
ALTER TABLE "hub"."events" ADD COLUMN "created_at" TIMESTAMPTZ(6);
UPDATE "hub"."events" SET "created_at" = "received_at" WHERE "created_at" IS NULL;
ALTER TABLE "hub"."events" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
ALTER TABLE "hub"."events" ALTER COLUMN "created_at" SET NOT NULL;
