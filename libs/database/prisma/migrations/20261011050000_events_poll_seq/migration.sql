-- R-3 (review sau merge, ADR-095): cursor polling theo THỨ TỰ COMMIT. `seq` cấp lúc INSERT nên transaction có seq nhỏ
-- COMMIT muộn bị cursor vượt qua (mất vĩnh viễn). `poll_seq` được cấp LÚC POLL, cho dòng ĐÃ COMMIT, bởi một UPDATE giữ
-- advisory lock theo tenant -> các lần cấp nối tiếp nhau, giá trị cấp sau luôn lớn hơn mọi giá trị đã thấy.
-- Dòng cũ: poll_seq = seq (cursor client đang giữ vẫn đúng); sequence tiếp sau max(seq).
CREATE SEQUENCE "hub"."events_poll_seq";
ALTER TABLE "hub"."events" ADD COLUMN "poll_seq" BIGINT;
UPDATE "hub"."events" SET "poll_seq" = "seq";
SELECT setval('"hub"."events_poll_seq"', GREATEST((SELECT COALESCE(MAX("seq"), 0) FROM "hub"."events"), 1));
CREATE UNIQUE INDEX "events_poll_seq_key" ON "hub"."events"("poll_seq");
CREATE INDEX "events_tenant_id_poll_seq_idx" ON "hub"."events"("tenant_id", "poll_seq");
CREATE INDEX "events_unassigned_poll_seq_idx" ON "hub"."events"("tenant_id", "seq") WHERE "poll_seq" IS NULL;
