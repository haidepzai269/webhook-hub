-- BP3 (SPEC-ap-luc-nguoc §4, ĐÍNH CHÍNH C4, ADR-197): lúc `:open` của circuit hết hạn (-> HALF_OPEN), ghi ĐÚNG LÚC trip
-- (now + TTL vừa SET EX, 60s hoặc 300s) cùng UPDATE `circuit_state`. Cảnh báo `destination.circuit_open` dựng câu
-- "Thử lại lúc …" từ cột này — evaluator không gọi Redis mỗi tick. NULL khi không OPEN. Chỉ thêm cột nullable (không backfill,
-- không DML) -> không cần app.rls_system; `lock_timeout` để không xếp hàng chặn đường nóng.
SELECT set_config('lock_timeout', '5s', false);
ALTER TABLE "hub"."destinations" ADD COLUMN "circuit_half_open_at" TIMESTAMPTZ(6);
SELECT set_config('lock_timeout', '0', false);
