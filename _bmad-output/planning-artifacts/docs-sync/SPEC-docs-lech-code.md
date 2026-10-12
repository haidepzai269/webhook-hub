# SPEC — Đồng bộ ARCHITECTURE.md với code (đường ingest + delivery)

> Phòng party viết ngày 2026-10-12, khi lập danh mục 21 bước cho tính năng "Mô phỏng một webhook" ở trang login (bản `ui/login-event`).
> **Chỉ sửa tài liệu.** Không đụng code, không đụng test. Code là nguồn đúng. Mô phỏng đã chạy theo code.
> Ước lượng: khoảng 15 phút cho DS1–DS3, thêm 5 phút nếu làm DS4.

## Bối cảnh

Đọc code thật để lập danh mục bước thì phát hiện 2 chỗ tài liệu lệch code và 1 chỗ dễ đọc nhầm. Có thêm 1 điểm giáo khảo có thể hỏi (DS4), nên cần một ADR để trả lời sẵn.

Đã kiểm lại và **không** phải lỗi:

- "ACK duplicate" (§3.1, dòng 121, 124): code trả **200** ở cả hai lớp (Redis `GET` trúng, Postgres P2002). Hai bên khớp nhau, chỉ là tài liệu không ghi số. Có thể ghi thêm cho rõ, không bắt buộc.
- GitHub "HMAC trên raw body" (§7.1, dòng 491): đúng. Việc so sánh nằm trong SDK chính chủ (xem DS4).

## Các thay đổi

### DS1 — Thứ tự rate limit và nạp source (§3.1, dòng 114–116). **Lệch thật.**

- **Tài liệu hiện ghi:** bước 2 rate limit theo source, rồi bước 3 nạp source + secrets.
- **Code làm:** nạp source trước, rồi mới rate limit.
  - `apps/hub-api/src/modules/ingest/ingest.service.ts:264` gọi `findSourceBySourceKeyForIngest`.
  - Không có source, source bị tắt hoặc đã lưu trữ thì trả **404**.
  - `:276` mới gọi `checkRateLimit("rate:source:${source.id}", …)`, vì khoá cần `source.id`.
- **Sửa:** đổi chỗ bước 2 và bước 3 trong khối mã §3.1. Thêm một dòng lý do: khoá rate limit cần `source.id`, và `sourceKey` rác bị 404 trước nên không tốn lượt `EVAL` Redis.
- **Kiểm:** ngân sách Redis (R1, ADR-062) không đổi, chỉ đổi thứ tự. Soát lại §3.1 xem còn câu nào nói "rate limit trước khi chạm DB" không.

### DS2 — Timeout gửi (§3.3, dòng 152). **Lệch thật, nhỏ.**

- **Tài liệu hiện ghi:** "timeout cứng 5s (`AbortSignal.timeout`)".
- **Code làm:** `apps/hub-worker/src/senders/http-limits.ts:18–22` (`resolveSendTimeoutMs`). `DELIVERY_TIMEOUT_MS` là trần **tổng** của một lần gửi, kẹp trong 1000–10000ms, mặc định 5000ms. Có từ S10 (SPEC §4.9, ADR-078).
- **Sửa:** đổi thành "timeout tổng mặc định 5s, cấu hình `DELIVERY_TIMEOUT_MS` kẹp 1–10s (ADR-078)". Nếu `docs/DEPLOYMENT.md` có bảng env thì kiểm xem đã liệt kê `DELIVERY_TIMEOUT_MS` chưa.

### DS3 — Số lần gửi (§3.3, dòng 155–156). **Dễ đọc nhầm.**

- **Tài liệu hiện ghi:** "không đốt 5 lần retry".
- **Code làm:** `RETRY_TIERS` trong `libs/messaging/src/topology.ts` có 5 tầng retry (10s → 1m → 5m → 30m → 2h). Tính cả lần đầu là **6 lần gửi**. `delivery.consumer.ts` chuyển sang `DEAD` khi `getNextRetryQueue(6)` trả `null`.
- **Sửa:** ghi rõ "5 tầng retry, tổng 6 lần gửi (1 lần đầu + 5)" ở dòng 155 hoặc chỗ liệt kê tầng retry, rồi soát các chỗ khác nói "5 lần" trong ARCHITECTURE và README. Không đổi chữ trong `lastError` "Hết 5 lần retry" của code.

### DS4 — ADR: GitHub dùng SDK để so chữ ký. **Tùy chọn, nên làm.**

- **Vấn đề:** CLAUDE.md ghi "mọi so sánh chữ ký dùng `crypto.timingSafeEqual` — kể cả khi SDK provider có hàm verify riêng". PayOS tự so (ADR-058, vì SDK PayOS so bằng `!==`). GitHub thì giao cho `verifyWithFallback` của `@octokit/webhooks-methods` (`libs/providers/src/github.adapter.ts:49–66`). Giáo khảo có thể hỏi vì sao hai provider làm hai kiểu.
- **ADR 3 dòng:**
  - **Vấn đề:** quy tắc "luôn `timingSafeEqual`" và việc GitHub dùng SDK trông như mâu thuẫn.
  - **Chọn:** quy tắc thật là "không bao giờ so chữ ký bằng `!==`/`===`". SDK nào so bằng `timingSafeEqual` thì được dùng (octokit, có xử lý sẵn việc xoay secret). SDK nào so bằng `!==` thì tự so (PayOS, ADR-058).
  - **Đánh đổi:** tin vào triển khai của SDK, nên khi nâng version octokit phải kiểm lại.
- **Kèm theo:** sửa câu trong CLAUDE.md cho khớp với ADR, hoặc giữ nguyên câu và thêm "(trừ SDK đã so constant-time, xem ADR-xxx)". **Grep số ADR tiếp theo trước khi ghi:** phiên khác đang giữ ADR-164 chưa commit.

## Bổ sung sau khi phòng party kiểm chéo (2026-10-12)

Đã đối chiếu DS1–DS4 với code. Cả bốn mục đều đúng. Kết quả kiểm:

| Mục | Bằng chứng |
|---|---|
| DS1 | `ingest.service.ts:264` (nạp source) chạy trước `:276` (rate limit) |
| DS2 | `http-limits.ts` có `resolveSendTimeoutMs` |
| DS3 | `getNextRetryQueue(currentAttemptNo)` trả `null` ở lần 6 |
| Duplicate 200 | Cả hai đường đi qua `:205` |
| DS4 | octokit `dist-node/index.js:91–94` so độ dài trước, sau đó gọi `timingSafeEqual` |

Ngoài ra phải làm thêm ba việc:

- **DS2 — bắt buộc:** thêm `DELIVERY_TIMEOUT_MS` vào bảng env của `docs/DEPLOYMENT.md`, ngay cạnh `INGEST_RATE_LIMIT_PER_MIN` (khoảng `:431`). Bảng hiện chưa có biến này. Ghi theo dạng `DELIVERY_TIMEOUT_MS=5000 # trần tổng một lần gửi, kẹp 1000–10000 (ADR-078)`.
- **DS4 — sửa thêm `docs/ARCHITECTURE.md` §7.1:**
  - Dòng GitHub (`:491`) ghi thêm: "verify bằng `@octokit/webhooks-methods` `verifyWithFallback` (constant-time, xoay secret)".
  - Dòng "So sánh" (`:494`) đổi thành "không bao giờ so bằng `!==`/`===`. Tự so bằng `crypto.timingSafeEqual`, hoặc dùng SDK đã so constant-time (ADR-174)".
  - Nếu chỉ sửa CLAUDE.md thì ARCHITECTURE vẫn mâu thuẫn với chính nó.
- **DS4 — số ADR:** ADR-163..173 đã dùng (163–164 trên master, 165–173 là alerts CB1–CB7 trên `feat/alerts`), nên dùng **ADR-174**. Grep lại trước khi ghi.
  - Phần đánh đổi ghi version `@octokit/webhooks-methods` đang dùng, kèm câu "nâng version phải kiểm lại hàm verify".
  - Spec cảnh báo đã giữ ADR-165..173. Spec chống quá tải (`edge/SPEC-chong-qua-tai.md`) dùng từ ADR-175.

### DS5 — Redis "cache subscription" (§15 Q&A, `ARCHITECTURE.md:770`). **Lệch thật.**

- **Tài liệu hiện ghi:** Redis làm "đường tắt chống trùng, rate limit, circuit breaker, **cache subscription**, pub/sub cho Socket.IO".
- **Code làm:** không có cache subscription nào (grep `apps/` `libs/` không thấy). §3.2 bước 5 của chính tài liệu ghi "truy vấn Postgres, không cache".
- **Sửa:** bỏ "cache subscription". Thay bằng "throttle chiều ra" để liệt kê đủ năm vai: idem, rate limit nguồn, circuit breaker, throttle đích, pub/sub realtime.
- **Kiểm:** grep `cache subscription` và `subscriptions cache` trong `docs/`. Câu ở §3 ("route chỉ là hàm thuần trên `(event, subscriptions cache)`", khoảng dòng 106) cũng dễ đọc thành có cache. Đổi thành `(event, subscriptions)`.

Cập nhật mục "Xong khi" thêm:
- [ ] DS5: `docs/` không còn chỗ nào nói Redis cache subscription.
- [ ] `DEPLOYMENT.md` có `DELIVERY_TIMEOUT_MS`.
- [ ] `ARCHITECTURE.md` §7.1 (`:491`, `:494`) khớp ADR-174.

## Ngoài phạm vi

- Không đổi thứ tự trong code. Thứ tự hiện tại hợp lý hơn tài liệu.
- Không đổi thông điệp `lastError`.
- Mô phỏng ở trang login (`apps/web/.../(auth)/_components/simulator/steps.ts`) đã theo code, kèm test chống lệch kiểm `source.file` + `symbol`. Không cần sửa theo spec này.

## Xong khi

- [ ] DS1–DS3 đã sửa trong `docs/ARCHITECTURE.md`. Grep "cứng 5s", "5 lần retry" không còn câu nào gây hiểu sai.
- [ ] DS4: ghi ADR (hoặc Admin quyết không ghi) và CLAUDE.md khớp với ADR.
- [ ] Commit riêng `docs(architecture): …`, không gộp với commit code.
