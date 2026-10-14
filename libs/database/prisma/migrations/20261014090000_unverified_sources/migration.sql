-- PK5 (SPEC-provider-khac §7 + ĐÍNH CHÍNH E4/E5/E14, ADR-206): "đích tự kiểm" (scheme `unverified`) — bốn khoá.
--   khoá 1: `projects.allow_unverified_sources` — project tự bật (owner, có audit); tắt = source unverified bị từ chối.
--   khoá 2: `raw_events.verified` (ghi lúc ingest, E5) -> normalize CHÉP sang `events.verified` (không suy từ config).
--   khoá 4: `subscriptions.accept_unverified` — đích tự đồng ý nhận sự kiện chưa xác thực.
-- CHỈ thêm cột có DEFAULT hằng (PG 11+ chỉ ghi metadata, không viết lại bảng). Không DML, không giá trị enum mới
-- (`ALTER TYPE … ADD VALUE` không rollback được) -> rollback code về bản cũ vẫn chạy (cột thừa bị bỏ qua).
-- Không DML -> không cần app.rls_system. `lock_timeout` để không xếp hàng chặn đường nóng (ingest INSERT raw_events).
SELECT set_config('lock_timeout', '5s', false);
ALTER TABLE "hub"."projects" ADD COLUMN "allow_unverified_sources" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hub"."raw_events" ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "hub"."events" ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "hub"."subscriptions" ADD COLUMN "accept_unverified" BOOLEAN NOT NULL DEFAULT false;
SELECT set_config('lock_timeout', '0', false);
