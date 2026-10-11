# CẦN ADMIN QUYẾT — phiên DEV verification (C-1 + VF3→VF8)

Mỗi câu có **mặc định** đã áp để không chặn việc; Admin đổi thì báo phiên sau.

| # | Câu | Mặc định đang áp | Vì sao cần Admin |
|---|---|---|---|
| Q1 | Probe tầng L3 (SPEC §6.3: P-BB3-01 "trả 200 trước COMMIT" phải làm đỏ **chaos** "kill hub-api giữa ingest"; P-BB3-02 → chaos "kill worker") cần build lại image hubv từ worktree đã phá cho MỖI probe (~5–8 phút/lần, ổ C còn ~25 GB) rồi build lại bản sạch. Có làm không? | Probe BB-3 chạy ở **L0** (test đích `[BB:3] (phần a/b/c)`: COMMIT lỗi → không 2xx; thứ tự tx→SET NX→ACK; ack trước khi ghi → nack). Chaos L3 vẫn chứng minh "xanh trên code thật" (VF5). | Tốn thời gian + đĩa; build image trùng lúc phiên khác build thì tranh cache (§14.5). |
| Q2 | `P-BB2-01` spec ghi "bỏ unique `(source_id, idempotency_key)`" — migration không áp vào DB hubv đã migrate từ worktree tạm. | Probe phá ở code: nuốt P2002 rồi ghi bản thứ hai với khoá khác → `[BB:2] (phần a)` đỏ. | Muốn bản "bỏ hẳn constraint" thì cần probe kiểu migration (dựng DB riêng mỗi lần). |
| Q3 | `verify:deployed` (VF8) cần một API key `publish:events + read:events` của project `demo` trên Render + `VERIFY_API_URL`. Phiên dev KHÔNG được chạy vào hạ tầng thật. | Lệnh có sẵn, bắt buộc env, không có mặc định trỏ deployed; CHƯA chạy. | Admin tự chạy (hoặc cho phép) khi muốn bằng chứng "online thật". |
| Q4 | `demo:reset --env deployed` (§9.2) cần API operator MỚI `DELETE /api/v1/operator/projects/demo/data` trong hub-api — xoá dữ liệu sự kiện của một project trên production. Làm không, và xoá đến đâu (raw_events/events/deliveries/attempts; GIỮ source/endpoint/key/thành viên để PayOS vẫn trỏ đúng)? | Chưa làm: lệnh từ chối rõ ràng (exit 2, không xoá gì); VT14 để mồ côi có lý do. | Là khả năng XOÁ trên production (bảo mật + BB-5) — cần story riêng có review, không nên kẹp trong VF8. |
