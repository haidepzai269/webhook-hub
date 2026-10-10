-- S1-1 (ADR-042): dọn dữ liệu cũ. Trước S1-1, replay ghi vào hub.outbox cả cấu hình đích và
-- signing secret ĐÃ GIẢI MÃ. Message delivery giờ chỉ mang tham chiếu — xoá các khoá thừa khỏi
-- mọi dòng outbox của chặng delivery (worker đọc tham chiếu, bỏ qua phần còn lại).
-- Chỉ đổi dữ liệu, không đổi schema. Chạy lại vô hại (jsonb - key không có thì thôi).
UPDATE hub.outbox
SET payload = payload - 'config' - 'signingSecret' - 'event' - 'destinationType' - 'destinationId' - 'subscriptionId' - 'rateLimitRps' - 'eventId'
WHERE topic IN ('delivery.replayed', 'delivery.requested')
  AND (payload ? 'config' OR payload ? 'signingSecret' OR payload ? 'event');
