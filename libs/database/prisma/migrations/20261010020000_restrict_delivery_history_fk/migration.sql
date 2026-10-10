-- Review SPEC-2 #1 (ADR-054): xoá subscription/destination từng CASCADE xuống hub.deliveries ->
-- mất toàn bộ delivery + delivery_attempts (kể cả DEAD) và audit trỏ vào hư không.
-- Lịch sử gửi là bằng chứng: đổi sang RESTRICT. API trả 409 trước (kèm số lượng); FK này là lớp
-- phòng thủ ở DB khi có race hoặc ai đó xoá ngoài API. Muốn ngừng gửi: subscriptions.is_active = false.
-- deliveries.event_id vẫn CASCADE (cleanup theo retention xoá event cũ là có chủ đích).

-- DropForeignKey
ALTER TABLE "hub"."deliveries" DROP CONSTRAINT "deliveries_subscription_id_fkey";

-- DropForeignKey
ALTER TABLE "hub"."subscriptions" DROP CONSTRAINT "subscriptions_destination_id_fkey";

-- AddForeignKey
ALTER TABLE "hub"."subscriptions" ADD CONSTRAINT "subscriptions_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "hub"."destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub"."deliveries" ADD CONSTRAINT "deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "hub"."subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
