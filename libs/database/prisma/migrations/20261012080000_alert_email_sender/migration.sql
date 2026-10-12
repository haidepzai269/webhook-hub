-- CB5 (SPEC-canh-bao-nhan-dinh §6, DINH-CHINH D1/D2, ADR-173): cột cho VÒNG GỬI email cảnh báo (outbox theo người).
-- Chỉ DDL — thêm cột NULL được + một index một phần. Không đụng dữ liệu (gate data-migration-rls không áp).
--   next_attempt_at   — lease + lùi thời gian thử lại: vòng gửi giữ dòng bằng FOR UPDATE SKIP LOCKED trong transaction
--                       NGẮN, đặt mốc này rồi COMMIT, gửi NGOÀI transaction; worker chết giữa chừng -> hết lease, worker
--                       khác lấy lại (at-least-once). NULL = chưa ai lấy.
--   last_error        — lỗi gửi gần nhất (cắt 200 ký tự, không bao giờ chứa nội dung thư).
--   suppressed_reason — vì sao SUPPRESSED: 'cap' (trần 6/giờ/người) hoặc 'ineligible:<lý do>' (kiểm lại lúc gửi).
--   rolled_into       — email SENT đã mang dòng "…và k cảnh báo khác" thay cho dòng 'cap' này (đếm k một lần).
ALTER TABLE "hub"."alert_emails"
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "last_error" VARCHAR(200),
  ADD COLUMN "suppressed_reason" VARCHAR(64),
  ADD COLUMN "rolled_into" UUID;

-- Trần 6/giờ/người: đếm email ĐÃ GỬI của một người trong 1 giờ. Prisma 6 không khai được index có WHERE -> chỉ ở đây.
CREATE INDEX "alert_emails_user_sent_idx" ON "hub"."alert_emails"("user_id", "sent_at" DESC) WHERE "state" = 'SENT';
