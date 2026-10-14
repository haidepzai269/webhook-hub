-- LH3 (SPEC-hub-sap §5 + ĐÍNH CHÍNH H5, ADR-217): đường vào của raw event qua lưới hứng (Cloudflare Worker).
--   'catchnet-forward' = Worker chuyển tiếp lúc hub sống (ghi xuyên — mọi request của source mới đều đi đường này);
--   'catchnet-replay'  = Worker phát lại từ D1 sau khi hub vắng. NULL = gọi thẳng (source cũ, URL Render).
-- Một giá trị 'catchnet' sẽ làm báo cáo "lưới đã cứu" đếm gấp hàng trăm lần -> tách hai giá trị; chỉ replay là "đã cứu".
-- CHỈ thêm cột NULL không DEFAULT (PG 11+ chỉ ghi metadata). CHECK thêm NOT VALID rồi VALIDATE riêng: VALIDATE chỉ giữ
-- SHARE UPDATE EXCLUSIVE, ingest vẫn ghi được trong lúc quét (mọi dòng cũ là NULL -> qua).
-- TEXT + CHECK, không enum mới (`ALTER TYPE … ADD VALUE` không rollback được) -> rollback code cũ vẫn chạy (cột thừa bỏ qua).
-- Không đụng dữ liệu -> không cần app.rls_system. `lock_timeout` để không xếp hàng chặn đường nóng của ingest.
SELECT set_config('lock_timeout', '5s', false);
ALTER TABLE "hub"."raw_events" ADD COLUMN "via" TEXT NULL;
ALTER TABLE "hub"."raw_events" ADD CONSTRAINT "raw_events_via_check" CHECK ("via" IN ('catchnet-forward', 'catchnet-replay')) NOT VALID;
ALTER TABLE "hub"."raw_events" VALIDATE CONSTRAINT "raw_events_via_check";
SELECT set_config('lock_timeout', '0', false);
