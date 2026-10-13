# Trả lời nếu hội đồng hỏi "jitter ±20% nằm ở đâu trong code?" (phụ lục đã nộp, không sửa — Q1)

1. Không có jitter ở tầng thử lại: mỗi tầng retry là một queue riêng với TTL **cố định** (10s, 1m, 5m, 30m, 2h — `libs/messaging/src/topology.ts`). RabbitMQ chỉ hết hạn message ở đầu queue, nên TTL ngẫu nhiên theo từng message sẽ gây head-of-line blocking (message 2h chặn message 10s) — ARCHITECTURE §4.
2. Câu trong phụ lục là lời hứa của bản thiết kế sớm; khi làm thật, nhóm thấy jitter không làm được đúng với kiến trúc TTL theo queue và **đã thay bằng cơ chế giải đúng vấn đề jitter nhắm tới** (ADR-198, ARCHITECTURE §5.4c).
3. Jitter ±20% của 1 phút chỉ rải hàng ra khoảng 24 giây — đích vừa hồi phục vẫn nhận gần cả hàng. Vấn đề thật là **tốc độ** dội vào đích ngay khi circuit breaker cho gọi lại.
4. Thay vào đó: **slow-start theo đích** — probe HALF_OPEN thành công thì trần gửi bắt đầu 2 rps và nhân đôi mỗi 10s (2 → 4 → … → 64) trong 60s; phần vượt hoãn 10s, không ghi DB (`circuit-breaker.service.ts` `LUA_GATE`, test `[BP:T15]`, `[BP:T16]`).
5. Kèm theo: OPEN kéo dài 60s → 300s khi probe thất bại (ADR-197) và áp lực ngược cho DB của chính hub (ADR-200) — cùng tinh thần bài Canva *Worker Backpressure*: không ngừng retry, mà giảm nhịp.
6. Jitter thật CÓ ở các nhịp nền để N worker không đập cùng lúc: outbox relay ±100ms quanh 500ms, sweeper ±10s, cleanup ±10% (ARCHITECTURE §4) — không phải ở tầng retry delivery.
