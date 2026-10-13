-- QT6 (SPEC-han-muc-dung-luong §3, §8 + ĐÍNH CHÍNH E3, ADR-189 c, ADR-190): cảnh báo dung lượng cho owner + operator.
--   1. project_usage.signaled_level — nấc đã "báo" lần cuối (alert mở/đóng + webhook `hub.project.storage` + email). Luồng
--      báo khoá dòng project_usage (FOR UPDATE), so `level` với `signaled_level` -> mỗi lần đổi nấc phát ĐÚNG một lần, kể cả
--      khi hai đường (lượt nấc 60s, lô dọn) cùng báo, và báo bù sau khi worker chết giữa đường (lượt nấc thấy lệch).
--   2. alert_emails.tag — email theo NẤC/NGÀY của cùng một cảnh báo (`up:WARN_85:2026-10-13`, `remind:LOCKED:2026-10-14`).
--      Unique đổi thành (alert_id, user_id, kind, tag); email CB cũ có tag '' nên hành vi CB không đổi.
--   3. project_members.storage_warn_email — owner tắt được email 70%/85% (KHÔNG tắt được 95%/LOCKED, §8). Bảng danh tính
--      (IdentityRepository), không RLS — như cột role cùng bảng.
-- Chỉ DDL + đổi index trên bảng nhỏ. `lock_timeout` như QT1 (review QT-S1 L2): không xếp hàng chặn đường nóng.
-- Backfill `signaled_level` là DML trên bảng có RLS -> đặt app.rls_system ngay đầu (gate data-migration-rls, ADR-111/125).
SELECT set_config('app.rls_system', 'on', false);
SELECT set_config('lock_timeout', '5s', false);

ALTER TABLE "hub"."project_usage" ADD COLUMN "signaled_level" VARCHAR(16);
-- Project đã có nấc từ trước migration: coi như đã báo (không bắn hàng loạt webhook/email lúc deploy). Nấc đổi sau đó mới báo.
UPDATE "hub"."project_usage" SET "signaled_level" = "level";

ALTER TABLE "hub"."alert_emails" ADD COLUMN "tag" VARCHAR(48) NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "hub"."alert_emails_alert_id_user_id_kind_key";
CREATE UNIQUE INDEX "alert_emails_alert_id_user_id_kind_tag_key" ON "hub"."alert_emails"("alert_id", "user_id", "kind", "tag");

ALTER TABLE "hub"."project_members" ADD COLUMN "storage_warn_email" BOOLEAN NOT NULL DEFAULT true;

SELECT set_config('lock_timeout', '0', false);
SELECT set_config('app.rls_system', '', false);
