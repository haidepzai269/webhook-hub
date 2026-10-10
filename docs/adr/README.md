# Nhật ký quyết định kiến trúc (ADR)

> **Append-only.** Thêm ở cuối, không sửa mục cũ. Quyết định cũ sai → viết mục mới, ghi `Thay thế ADR-00X`.
>
> **Mẫu 3 dòng — mỗi quyết định tốn 2 phút:**
> ```
> ## ADR-0XX — <tiêu đề>   (ngày)
> **Vấn đề:** ...
> **Chọn:** ...
> **Đánh đổi:** ...
> ```
>
> Đề tài chấm nặng *architecture và hiểu bản chất*. Thứ được chấm không phải code, mà là **lý do**. File này chính là phần đó của báo cáo.

---

## ADR-001 — Tách Demo Shop thành service riêng, Hub không biết "đơn hàng" (2026-09-17)

**Vấn đề:** Bản ý tưởng gốc để `Order Matcher` làm worker bên trong Hub và bảng `orders` nằm chung schema `hub`. Nhưng mục 11.2 lại nói Demo Shop nhận outbound webhook rồi cũng cập nhật đơn. → Hai writer, một bảng, không ranh giới. Nặng hơn: Hub tự nhận là "generic hub, thêm provider chỉ cần một class", rồi nhét regex `DH\d+` vào lõi. Hội đồng sẽ hỏi *"thêm GitHub thì Order Matcher làm gì?"* và không có câu trả lời.

**Chọn:** Hai domain, hai schema, hai tiến trình. Hub = hạ tầng generic, **không biết** đơn hàng/tiền/khách. Shop = khách hàng của Hub, sở hữu `orders`, tự khớp mã đơn, tự đối soát PayOS. Giao tiếp **chỉ** qua outbound webhook có ký HMAC. Trần cứng Shop: 1 bảng, 3 endpoint, 1 cron, ~300 dòng.

**Đánh đổi:** +300 dòng và một tiến trình nữa. Đổi lại: giữ được luận điểm Open/Closed, và Hub **được kiểm chứng bằng chính một client độc lập của nó** — outbound webhook trở thành tính năng thật thay vì đồ trang trí.

---

## ADR-002 — Pipeline 2 hop, gộp normalize + route (2026-09-17)

**Vấn đề:** Bản gốc thiết kế 3 hop: `q.normalize` → `q.route` → `q.delivery`.

**Chọn:** Gộp normalize và route vào **một consumer**. Route chỉ là hàm thuần trên `(event, subscriptions cache trong Redis)`.

**Đánh đổi:** Mất khả năng scale riêng bước route — nhưng bước đó không phải nút thắt (nó là tra cache + insert). Đổi lại bớt một chỗ phải lo idempotency, ack, DLQ, và bớt một độ trễ hop. Vẫn còn 2 hop để chứng minh luận điểm "tách *nhận* khỏi *xử lý*".

---

## ADR-003 — PostgreSQL là trọng tài idempotency, Redis chỉ là đường tắt (2026-09-17)

**Vấn đề:** Bản gốc (mục 6.2) `SET NX` vào Redis **trước** transaction. Postgres chết giữa chừng → Redis key vẫn còn → provider retry → hub trả "200 duplicate" → **sự kiện biến mất vĩnh viễn** và provider tưởng đã giao thành công. Mâu thuẫn trực tiếp với chính mục 7.1 của nó ("Transactional Outbox — không mất sự kiện"), cách nhau 4 trang.

**Chọn:** `UNIQUE(source_id, idempotency_key)` trên `raw_events` là trọng tài. Redis chỉ `GET` để đi tắt trước transaction, và `SET NX` **sau `COMMIT`**. Rollback ngoài ý muốn → `DEL` key → trả 5xx cho provider retry.

**Đánh đổi:** Mỗi webhook mới phải chạm DB một lần (không tránh được nữa). Đổi lại: **Redis mất sạch dữ liệu thì hệ thống chậm đi chứ không sai.**

---

## ADR-004 — Lưu `body_raw bytea` bên cạnh `body jsonb` (2026-09-17)

**Vấn đề:** Bản gốc chỉ lưu `body jsonb`. HMAC tính trên **byte gốc**. Parse JSON rồi vứt bytes đi → vĩnh viễn không xác thực lại được chữ ký, không replay được request thật. Chính mục 8.1 viết *"HMAC phải tính trên byte gốc"* rồi mục 9.2 vứt nó đi.

**Chọn:** `raw_events` lưu cả `body_raw bytea` (sự thật) lẫn `body jsonb` (để query), cộng `content_type` và `signature_header` để debug chữ ký.

**Đánh đổi:** Tốn ~2x dung lượng cho payload. Với đề tài này không đáng kể.

---

## ADR-005 — `events` cần `idempotency_key` riêng, `raw_event_id` cho phép NULL (2026-09-17)

**Vấn đề:** Bản gốc để `events.raw_event_id` là `uuid FK UNIQUE` bắt buộc. Nhưng sự kiện phái sinh (sinh từ sự kiện khác, không từ webhook nào) không có `raw_event` → insert nổ. Và nếu worker retry một message normalize, nó đẻ ra sự kiện phái sinh lần hai → Telegram bắn hai lần.

**Chọn:** `raw_event_id` nullable, thêm `parent_event_id`, thêm `idempotency_key UNIQUE` cho `events` với công thức `sha256(parentEventId + ':' + type)`, thêm `correlation_id` để truy vết.

**Đánh đổi:** Không có. Đây là sửa lỗi.

---

## ADR-006 — `deliveries` unique kèm `attempt_generation` để replay được (2026-09-17)

**Vấn đề:** Bản gốc `UNIQUE(event_id, subscription_id)`. Nhưng mục 7.7 nói replay event = chạy lại định tuyến cho tất cả đích → INSERT → đụng unique → chết.

**Chọn:** `UNIQUE(event_id, subscription_id, attempt_generation)`. Replay tăng generation lên 1, tạo bản ghi mới.

**Đánh đổi:** Thêm một cột. Đổi lại giữ được **toàn bộ lịch sử** các lần giao trước thay vì đè lên — mà lịch sử đó chính là thứ hiện trên tab Deliveries của dashboard.

---

## ADR-007 — Mỗi tầng retry một queue riêng, không dùng per-message TTL (2026-09-17)

**Vấn đề:** Cần exponential backoff 10s → 1m → 5m → 30m → 2h.

**Chọn:** 5 queue riêng, mỗi queue một `x-message-ttl` cố định, `x-dead-letter-exchange` trỏ ngược về `x.hub.delivery`. Thêm jitter ±20%.

**Đánh đổi:** 5 queue thay vì 1. Bắt buộc phải thế: RabbitMQ chỉ hết hạn message ở **đầu queue**, nên per-message TTL trong một queue chung sẽ để message 2h chặn message 10s phía sau (head-of-line blocking).

---

## ADR-008 — Thêm `q.normalize.dlq` (2026-09-17)

**Vấn đề:** Bản gốc chỉ có DLQ cho nhánh delivery. Nếu provider đổi format payload và normalizer ném exception mãi mãi → message nack-requeue vô hạn, quay vòng chiếm worker.

**Chọn:** `x.hub.normalize.dlx` → `q.normalize.dlq` + trang **Poison Events** trên dashboard.

**Đánh đổi:** Không có.

---

## ADR-009 — Đối soát PayOS thuộc Shop, không thuộc Hub (2026-09-17)

**Vấn đề:** Bản gốc để job đối soát trong hub scheduler. Nhưng nó hỏi *"đơn này đã trả tiền chưa?"* — câu hỏi của Shop.

**Chọn:** Cron trong `shop-api`. Tìm thấy giao dịch bị lỡ → POST vào endpoint nội bộ của Hub với `origin=reconciliation`, Hub xử lý như sự kiện bình thường.

**Đánh đổi:** Hub phải mở thêm một endpoint nội bộ. Đổi lại giữ BB-1, và tính năng tự phục hồi vẫn nguyên vẹn.

---

## ADR-010 — Relay dùng `SKIP LOCKED`, bỏ Redis lock (2026-09-17)

**Vấn đề:** Bản gốc nói scheduler chạy 1 instance **và** dùng Redis lock **và** dùng `SELECT ... FOR UPDATE SKIP LOCKED` — ba cơ chế chồng nhau cho cùng một việc.

**Chọn:** `SKIP LOCKED` là đủ, nó vốn đã an toàn với nhiều instance. Redis lock chỉ giữ lại cho job `cleanup`.

**Đánh đổi:** Không có. Bớt một cơ chế.

---

## ADR-011 — Cắt filter DSL và pipe filter trong template (2026-09-17)

**Vấn đề:** Bản gốc thiết kế `filter: {"data.amount": {"$gte": 1000}}` và template `{{data.amount | vnd}}`. Cái đầu là viết lại query language của MongoDB; cái sau là viết template engine. Cộng lại nhiều ngày công, không phải trọng tâm đề tài.

**Chọn:** Khớp subscription **chỉ theo `event_types`**. Template dùng `String.replace` với `{{path.to.field}}` thuần, ~20 dòng.

**Đánh đổi:** Mất tính linh hoạt lọc. Ghi vào báo cáo mục "hướng phát triển". Đề tài chấm độ tin cậy của tầng webhook, không chấm biểu thức lọc.

---

## ADR-012 — SSRF guard phải pin IP và chặn redirect (2026-09-17)

**Vấn đề:** Bản gốc chỉ chặn dải IP nội bộ khi kiểm URL. Hai lỗ còn lại: (1) DNS rebinding — domain resolve về IP public lúc kiểm, về `169.254.169.254` lúc connect; (2) đích trả `301` sang địa chỉ metadata nội bộ.

**Chọn:** resolve DNS → kiểm IP → **connect vào đúng IP đã kiểm** (pin IP, set header `Host` thủ công) → **`maxRedirects: 0`**. Chỉ bỏ qua khi `NODE_ENV=development`.

**Đánh đổi:** HTTP client phải cấu hình tay thay vì dùng mặc định. Vài chục dòng.

---

## ADR-013 — Giữ Grafana dù đang cắt phạm vi (2026-09-17)

**Vấn đề:** Đang cắt mạnh để vừa 14 ngày. Prometheus/Grafana nằm ở mục "mở rộng" của bản gốc.

**Chọn:** Giữ. Đưa vào `docker-compose`, commit sẵn 1 dashboard JSON.

**Đánh đổi:** ~30 phút công. Đổi lại cảnh demo mạnh nhất cả buổi: k6 bắn 500 rps → queue RabbitMQ phình → `--scale hub-worker=5` → biểu đồ tụt xuống trước mặt hội đồng. Đề tài này chấm nặng "chịu tải & scale".

---

## ADR-014 — Xây theo lát cắt dọc, không theo tầng ngang (2026-09-17)

**Vấn đề:** Kế hoạch gốc xây theo tầng: tuần 3 làm cả 3 adapter, tuần 6 mới có delivery → **tuần 6 mới biết các tầng có khớp nhau không**.

**Chọn:** Ngày 3 phải có một đường đi xuyên hết hệ thống: GitHub → verify → outbox → RabbitMQ → worker → Discord. Chỉ một provider, một đích, không dashboard. PayOS và SePay thêm vào Ngày 5.

**Đánh đổi:** Ngày 1–3 không có gì "nhìn được". Đổi lại: rủi ro tích hợp lộ ra ở **Ngày 3** thay vì Ngày 11, và thời gian viết adapter #2/#3 trở thành **số liệu thật** chứng minh luận điểm Open/Closed — mạnh hơn một đoạn văn lý thuyết.

---

## ADR-015 — `tenant_id` vào 5 bảng ngay Ngày 1 (2026-09-17)

**Vấn đề:** Thiết kế có `users` sở hữu `sources`/`destinations`, nhưng `events` và `deliveries` **không mang `tenant_id`** — mọi truy vấn dashboard là "lấy tất cả", không có đường phân tách khách hàng. Đối chiếu với Svix cho thấy multi-tenancy là tính năng lõi của lĩnh vực này, và hội đồng sẽ hỏi *"hệ thống phục vụ nhiều khách hàng thế nào?"*.

**Chọn:** `tenant_id uuid NOT NULL` trên `sources` · `destinations` · `subscriptions` · `events` · `deliveries`. Unique scope theo tenant. Một `TenantScopedRepository` (~40 dòng) lấy `tenant_id` từ JWT hoặc từ `source.tenant_id` ở luồng ingest. **Không repository nào được query không scope** (BB-5).

**Đánh đổi:** ~30 phút Ngày 1 cho một cột hiện luôn mang cùng một giá trị (chạy 1 admin). Nhưng đây là **Ngày 1 hoặc không bao giờ**: làm ở Ngày 10 tốn nửa ngày (migration + sửa từng query + từng test) và chắc chắn bị bỏ vì hết giờ.

---

## ADR-016 — Ba bổ sung rẻ để khép khoảng cách với Svix (2026-09-17)

**Vấn đề:** Đối chiếu Svix lộ ra ba ô thiếu, mỗi ô đều rẻ và đều dùng lại code đã có.

**Chọn:** Làm cả ba ở Ngày 12, tổng ~2,5 giờ.

1. **Outbound throttle per destination** (~1h) — token bucket Redis, **dùng lại nguyên code rate limit inbound**, chỉ đổi key. Đi thành cặp với circuit breaker: *throttle phòng ngừa để không làm đích quá tải; circuit breaker phản ứng khi đích đã hỏng.* Thiếu throttle thì scale worker lên 5 sẽ bắn gấp 5 lần vào một đích yếu và **tự tạo ra sự cố mà circuit breaker phải đi dọn**.
2. **Polling endpoint** `GET /api/v1/events?after=<cursor>` (~1h) — cursor = `events.id` (ULID). Lý do thật: **không phải đích nào cũng nhận push được** (sau firewall, client di động, script chạy theo lịch). Push và pull là hai mặt của cùng một bài toán phân phối.
3. **Tự cảnh báo** (~30') — circuit breaker chuyển `OPEN` → hub bắn cảnh báo qua `telegram.sender` của **chính nó**. Hub dùng chính nó để báo động về chính nó.

**Đánh đổi:** 2,5 giờ ở Ngày 12 (ngày đệm). Đổi lại ba ô nữa ngang hàng với sản phẩm thương mại, và ý #1 cho một cặp khái niệm đẹp để trình bày.

---

## ADR-017 — Không làm FIFO ordering, và biết tại sao (2026-09-17)

**Vấn đề:** Svix có "FIFO-ordered delivery". Có nên làm không?

**Chọn:** Không.

**Đánh đổi:** FIFO đòi **single-flight theo partition key** — trong mỗi key chỉ một message được xử lý, và khi message đó phải retry thì mọi message cùng key phải **chờ**, nếu không thứ tự vỡ. Điều đó **mâu thuẫn trực tiếp** với scale worker ngang và với retry có độ trễ — chính hai thứ đề tài này đang chứng minh. Không thể có cả hai bằng cùng một topology. Đây là ranh giới có chủ đích, không phải thiếu sót.

---

## ADR-018 — Không làm multi-region và payload transformation bằng JS (2026-09-17)

**Vấn đề:** Hai ô còn lại trong bảng tính năng Svix.

**Chọn:** Không làm cả hai. Ghi rõ vào báo cáo là ranh giới có chủ đích.

**Đánh đổi:**
- **Multi-region** — kiến trúc *không cản trở* (`hub-api`/`hub-worker` stateless, state ở PG/Redis/MQ). Nhưng đây là bài toán **replication + data residency + routing theo vùng**, không phải bài toán **độ tin cậy của tầng webhook** — trọng tâm đề tài.
- **Payload transformation bằng JS** — Svix chạy code người dùng viết, tức là bài toán **thực thi code không tin cậy**: sandbox, timeout, giới hạn bộ nhớ, chống thoát sandbox. Đó là **một đề tài riêng**, không phải một tính năng. Template `{{path}}` là điểm dừng đúng.

---

## ADR-019 — Hai môi trường, hai nhiệm vụ (2026-09-17)

**Vấn đề:** Đã chốt deploy lên Render + Vercel + Neon + Upstash + CloudAMQP. Nhưng bốn kịch bản demo mạnh nhất — k6 500 rps, `--scale hub-worker=5`, `docker kill` worker, tắt Redis — **không chạy được ở đó**: không có quyền kill container, scale là service trả phí, và một lần load test đốt sạch quota của cả ba nhà cung cấp. Thêm nữa Neon free autosuspend làm mọi số đo p95 vô nghĩa.

**Chọn:** Hai môi trường với hai nhiệm vụ tách bạch. **LOCAL `docker-compose`** = môi trường đo đạc & chaos, **toàn bộ số liệu báo cáo lấy ở đây**. **DEPLOYED** = chứng minh hệ thống online thật, provider thật gọi vào URL thật.

**Đánh đổi:** Phải duy trì hai cấu hình. Đổi lại số đo tái lập được, và bản thân lý do tách là một điểm cộng trong báo cáo: *"đo hiệu năng trên hạ tầng dùng chung có autosuspend và quota sẽ cho số liệu không tái lập được."*

---

## ADR-020 — Gộp `hub-scheduler` vào `hub-worker` (2026-09-17)

**Vấn đề:** Thiết kế có 3 tiến trình hub. Trên Render mỗi tiến trình là một service tính tiền riêng. Nhưng nhìn lại: ADR-010 đã chốt outbox relay dùng `FOR UPDATE SKIP LOCKED`, mà `SKIP LOCKED` **vốn đã an toàn với nhiều instance**. `hub-scheduler` chạy 1 instance là quán tính từ bản ý tưởng gốc, không có lý do.

**Chọn:** Bỏ `hub-scheduler`. Outbox relay chạy **trong mọi `hub-worker`** (thêm jitter vào chu kỳ poll để N worker không cùng đập vào bảng `outbox` một nhịp). Job `cleanup` cũng chạy trong worker, guard bằng Redis lock như cũ. Còn **2 tiến trình hub**.

**Đánh đổi:** Không có — **đúng hơn** chứ không chỉ rẻ hơn: relay giờ **scale theo worker**, thêm worker là thêm năng lực đẩy outbox. Tiết kiệm thêm một service trả phí.

---

## ADR-021 — `RealtimeNotifier` sau interface, phòng pub/sub Upstash (2026-09-17)

**Vấn đề:** Socket.IO adapter và kênh worker → api dùng Redis pub/sub. Upstash tính quota theo **số lệnh**, và hành vi pub/sub trên hạ tầng serverless có thể khác Redis tự host.

**Chọn:** Tách sau interface `RealtimeNotifier { publish, subscribe }` (~30 dòng, viết Ngày 7). Mặc định `RedisNotifier`. Dự phòng `RabbitFanoutNotifier` — fanout exchange, mỗi `hub-api` một queue tạm — **chỉ viết khi cần**. Đổi một dòng trong DI container, không sửa gì khác.

**Đánh đổi:** Một interface và một tầng gián tiếp. Rẻ hơn nhiều so với phát hiện pub/sub không chạy ở Ngày 13. Ghi chú: adapter chỉ thực sự cần khi có **nhiều instance `hub-api`** — trên Render chạy 1 instance nên có thể tắt ở deployed, bật ở local khi demo scale.

---

## ADR-022 — `shop` lên Vercel dưới dạng route handlers (2026-09-17)

**Vấn đề:** `shop` là service riêng (ADR-001) nhưng chỉ có 3 endpoint + 1 cron. Để nó thành một service Render riêng tốn thêm ~$7/tháng.

**Chọn:** `shop` chạy trên **Vercel** dưới dạng Next.js route handlers, kết nối Neon bằng **pooled connection string**. Cron đối soát 5 phút chuyển sang **GitHub Actions scheduled workflow** gọi `POST /api/internal/reconcile` (có `X-Internal-Token`), vì Vercel Hobby giới hạn cron quá ngặt.

**Đánh đổi:** `shop` thành serverless → có cold start và phải dùng pooled connection. Nhưng ranh giới domain (BB-1) **không đổi**: vẫn là service riêng, schema riêng, chỉ giao tiếp với Hub qua outbound webhook có ký. Tiết kiệm $7/tháng. Cron chạy từ ngoài cũng là một pattern ghi được vào báo cáo: *"tác vụ định kỳ tách khỏi tiến trình ứng dụng."*

---

## ADR-023 — Deploy lần đầu cuối Ngày 3, không phải Ngày 13 (2026-09-17)

**Vấn đề:** Roadmap để deploy ở Ngày 13. Nhưng deploy lần đầu **luôn** mất một ngày, và có ít nhất sáu cái bẫy cấu hình chỉ lộ ra khi deploy thật: region lệch làm p95 thành nửa giây · thiếu `DIRECT_URL` làm `prisma migrate` hỏng · không nghe `PORT` · CORS chặn Socket.IO handshake · CloudAMQP từ chối connection · `SIGTERM` 30s đúng mép vực làm mất message sau mỗi lần deploy.

**Chọn:** "Deploy rỗng" ngay khi xương sống chạy local — **cuối Ngày 3**. Checklist ở `DEPLOYMENT.md` §10. DoD: `git push` → tin nhắn Discord, **đi qua hạ tầng thật**.

**Đánh đổi:** Mất một phần Ngày 3–4. Đổi lại sáu cái bẫy lộ ra khi codebase còn đơn giản (mất nửa giờ mỗi cái) thay vì ở Ngày 13 khi mọi thứ chồng lên nhau (mất nửa ngày mỗi cái).

---

<!-- Thêm ADR mới bên dưới dòng này -->

## ADR-024 — Shop đặt đồ ăn có giỏ hàng (phía client), sửa luật "không giỏ hàng" (2026-10-09)

**Vấn đề:** Shop chuyển thành shop đặt đồ ăn theo template Sarab. Đặt đồ ăn mà chỉ được 1 món thì không ai dùng, nhưng CLAUDE.md và ADR-001 cấm giỏ hàng để giữ trần ~300 dòng.

**Chọn:** Giỏ hàng **chỉ ở client** (state React + `localStorage`). `POST /orders` nhận `{ items: [{id, qty}], customer }`, **server tự tính tổng từ menu** (không tin `amount` từ client nữa). Lưu `items jsonb` + `customer jsonb` vào `shop.orders`. Vẫn không có đăng nhập, không có kho. Trần ~300 dòng của `apps/shop` giữ nguyên.

**Đánh đổi:** +1 migration, khoảng +40 dòng backend. Hub **không đổi một dòng nào**: nó vẫn chỉ thấy "tiền về, nội dung DH…". Đổi cả miền nghiệp vụ của shop mà không đụng `apps/hub-*` là thêm một bằng chứng cho BB-1.

---

## ADR-025 — Hai root layout tách bằng route group: `(admin)` Tailwind/shadcn, `(shop)` Bootstrap (2026-10-09)

**Vấn đề:** Dashboard theo Studio Admin (Tailwind v4 + shadcn), shop theo Sarab (Bootstrap 5). Hai bộ CSS cùng reset `body/h1/button`. Chung một root layout là chúng đè lên nhau.

**Chọn:** `apps/web/src/app/(admin)/layout.tsx` và `apps/web/src/app/(shop)/layout.tsx`, **mỗi cái là một root layout** có `<html>` riêng. Không còn `app/layout.tsx` chung. CSS của Sarab nạp bằng `<link>` từ `public/shop-assets/` trong layout shop. Tailwind chỉ import trong layout admin.

**Đánh đổi:** Chuyển giữa admin và shop là tải lại toàn trang (chấp nhận được, vì hai thế giới không liên kết với nhau). 404 chung cần `global-not-found` hoặc mỗi nhóm tự có `not-found`.

---

## ADR-026 — Port Sarab sang React, giữ nguyên `style.css` gốc; thay Font Awesome Pro bằng Free (2026-10-09)

**Vấn đề:** Sarab viết bằng jQuery + Bootstrap. Thả nguyên HTML tĩnh vào thì "y hệt" nhất, nhưng tạo một đảo jQuery trong monorepo TS. Ngoài ra `css/all.min.css` của template là **Font Awesome Pro 6.0.0 (giấy phép thương mại)**, bị đóng gói kèm template MIT.

**Chọn:** Port từng section thành component React, **giữ nguyên markup class và `style.css`** để hình y hệt. Bỏ jQuery: Swiper → `swiper/react`, AOS giữ nguyên, popup/filter/search viết lại bằng state. Thay FA Pro bằng `@fortawesome/fontawesome-free` (template chỉ dùng `fas/far/fab`, cùng tên class). **Không commit** webfonts Pro.

**Đánh đổi:** Port tốn công hơn copy. Đổi lại code nhất quán và không vi phạm giấy phép.

---

## ADR-027 — Shop hiển thị giá thật; giả lập thanh toán chỉ ở local (2026-10-09)

**Vấn đề:** Giá đồ ăn thật (35.000–120.000đ) nghĩa là mỗi lần demo PayOS/SePay thật tốn tiền thật. Hạ giá xuống 2.000đ thì phá trải nghiệm của template. Hiển thị một giá mà thu một giá khác thì làm hỏng logic PAID/UNDERPAID.

**Chọn:** Giá hiển thị **chính là** giá thu. Nút "Giả lập chuyển khoản" (bắn SePay vào hub với seed key) chỉ hiện khi `NEXT_PUBLIC_DEMO_SIMULATE=true`, nghĩa là chỉ ở local. Ở môi trường deployed, chuyển khoản thật được dùng để chứng minh online.

**Đánh đổi:** Mỗi lần demo trên deployed phải chuyển tiền thật (có thể làm một đơn nhỏ, 1 món rẻ nhất). Seed key SePay nằm trong bundle client ở local, nên **tuyệt đối không bật cờ này ở deployed**.

---

## ADR-028 — Chi tiết thực thi SPEC-B: che PII, `+` thêm thẳng vào giỏ, FA 7 Free (2026-10-09)

**Vấn đề:** (a) `GET /orders/:code` là public, mã `DH…` đoán được, mà spec yêu cầu trả thêm `customer` → lộ SĐT/địa chỉ khách. (b) Template mở popup khi bấm `+`, spec B-4 lại muốn `+` thêm vào giỏ. (c) Bản `@fortawesome/fontawesome-free` cài được là **v7**, mặc định icon rộng cố định 1.25em, lệch so với FA 6 của template.

**Chọn:** (a) `/orders/:code` chỉ trả `customer = { name, phone đã che *** 3 số cuối }`; địa chỉ/ghi chú chỉ nằm trong DB. Mã đơn đổi sang `DH` + 6 số cuối timestamp + 2 số ngẫu nhiên (vẫn khớp `DH\d+`, giảm va chạm `@unique` so với 5 số ngẫu nhiên). (b) `+` trên thẻ thêm 1 phần vào giỏ; bấm thẻ mở popup chọn số lượng. (c) `shop-cart.css` đặt `--fa-width: auto` cho `.fas/.far/.fab`. Logic tính tiền tách ra `apps/shop/src/menu.ts` (thuần, không Prisma) để test được.

**Đánh đổi:** Khách xem lại đơn không thấy địa chỉ của chính mình (không có đăng nhập để xác thực chủ đơn, nên chấp nhận). `apps/shop` giờ là 2 file (~250 dòng tổng), vẫn dưới trần 300.

---

## ADR-029 — Hub không biết "order": gỡ kênh `hub:realtime:orders` khỏi RealtimeGateway (2026-10-09)

**Vấn đề:** `realtime.gateway.ts` subscribe kênh `hub:realtime:orders` và emit `order.updated`. Không ai publish vào kênh đó, và nó là khái niệm nghiệp vụ "đơn hàng" lọt vào lõi hub. Đây là vi phạm BB-1.

**Chọn:** Xoá kênh và event đó. Shop tự poll API của chính nó (README ui-revamp §1), không nghe Socket.IO của hub.

**Đánh đổi:** Không có. Đó là code chết mang nghĩa sai.

---

## ADR-030 — `/api/v1/stats/timeseries`: một câu SQL qua `TenantScopedRepository`, bucket theo giờ Việt Nam (2026-10-09)

**Vấn đề:** Biểu đồ dashboard cần chuỗi thời gian, mà API cũ chỉ trả số đếm. Đếm trong Redis thì tốn quota Upstash và trái BB-2. Gom ở client thì phải kéo hết event về.

**Chọn:** Thêm `getTimeseries('24h'|'7d')` vào `TenantScopedRepository`. `generate_series` sinh đủ bucket (bucket rỗng = 0), LEFT JOIN hai CTE `date_trunc(unit, ts, 'Asia/Ho_Chi_Minh') GROUP BY` trên `events` (`received_at`) và `deliveries` (`created_at`, đếm theo trạng thái *hiện tại*). `generate_series`/`date_subtract` bản 4 tham số (PG16) tính theo cùng múi giờ, để session TimeZone có DST cũng không làm lệch bucket (có test). `tenant_id` lấy từ repo. Đo local với 10k event: 10–50ms tuỳ máy và cache, dưới ngưỡng 200ms. Phía events dùng index `(tenant_id, received_at)`.

**Đánh đổi:** Delivery được tính theo thời điểm tạo, không theo thời điểm đổi trạng thái. Nên một delivery DEAD lúc 10h, nếu được tạo lúc 9h, sẽ nằm ở bucket 9h. Chấp nhận được với biểu đồ tổng quan; nếu cần chính xác phải có bảng sự kiện trạng thái. Phía `deliveries` **chưa có index `(tenant_id, created_at)`** nên CTE `dl` quét tuần tự khi bảng lớn. Nếu đo thấy chậm thì thêm index đó (schema hub, không đổi logic).

---

## ADR-031 — DLQ = DEAD *chưa bị replay*; replay ghi delivery + outbox trong một transaction (2026-10-09)

**Vấn đề:** Replay tạo delivery mới với `attempt_generation + 1` và giữ bản DEAD cũ để không mất lịch sử. Hệ quả là bản cũ vẫn `DEAD` nên nằm mãi trong DLQ. Ngoài ra replay lần hai trên cùng bản cũ đụng unique (event, subscription, generation) → 500. Delivery mới và outbox lại ghi bằng hai lệnh rời: crash giữa chừng để lại một delivery PENDING mà worker không bao giờ nhận.

**Chọn:** DLQ và KPI "DEAD" chỉ tính bản DEAD **không có generation cao hơn** (`NOT EXISTS` self-join, raw SQL trong `TenantScopedRepository`). Chỉ replay được bản đang `DEAD`. Replay một delivery còn RETRYING hay DELIVERING sẽ chạy song song với lượt retry đang xếp hàng, khiến đích nhận hai lần → 409. Replay bản đã bị thay thế → 409. Hai request replay đua nhau → request thua nhận 409 nhờ bắt P2002. Insert delivery và outbox nằm trong cùng một `$transaction`.

**Đánh đổi:** `findDeadDeliveries` phải chạy 2 câu (lấy id, rồi `findMany` kèm quan hệ). Không thêm trạng thái `REPLAYED` vào enum vì như thế phải migrate và đổi worker.

---

## ADR-032 — `/api/v1/*` không bao giờ trả ciphertext `*Encrypted` (2026-10-09)

**Vấn đề:** `GET /sources`, `/destinations`, `/subscriptions`, `/deliveries` trả nguyên `secretEncrypted`, `configEncrypted` và `signingSecretEncrypted` ra trình duyệt. Chúng đã được mã hoá, nhưng nếu master key lộ một lần thì mọi ciphertext từng hiện trên DevTools hay trong log proxy đều giải mã được.

**Chọn:** `RedactSecretsInterceptor` trên `ApiController` đệ quy bỏ **đúng 3 khoá** `secretEncrypted`, `configEncrypted` và `signingSecretEncrypted`, thay bằng cờ `has*`. Dùng danh sách trắng để không sửa payload người dùng (`event.data`) có trường tình cờ tên `…Encrypted`. Cùng chỗ đó, `BigInt` được đổi sang string. `DeliveryAttempt.id` là BIGSERIAL, trước đây làm `/deliveries` và `/dlq` trả 500 mỗi khi có attempt. Dashboard không bao giờ hiển thị secret sau khi tạo (SPEC-A A-7).

**Đánh đổi:** Không xem lại được config của một đích từ UI. Muốn sửa thì phải tạo lại hoặc làm endpoint cập nhật riêng (chưa có).

---

## ADR-033 — Index `deliveries (tenant_id, created_at DESC)` (2026-10-09)

**Vấn đề:** Danh sách deliveries, DLQ và `stats/timeseries` đều lọc theo `tenant_id` rồi `ORDER BY created_at DESC`. Index duy nhất là `(tenant_id, status, next_attempt_at)`, phục vụ relay chứ không phục vụ dashboard.

**Chọn:** Thêm `@@index([tenantId, createdAt(sort: Desc)])`. `prisma db push` lúc hub-api khởi động sẽ tự tạo index.

**Đánh đổi:** Mỗi lần ghi delivery tốn thêm một lần cập nhật index. Không đáng kể so với một lần gửi HTTP.

---

## ADR-034 — Shop: chống trùng bền vững + cộng dồn tiền + máy trạng thái (2026-10-09)

**Vấn đề:** (1) Chống trùng dùng `Set` trong bộ nhớ: restart là mất, trên serverless gần như vô dụng. (2) `paidAmount` bị **ghi đè** bởi lần chuyển khoản sau, không được cộng dồn. (3) Webhook trễ mang dữ liệu cũ ghi đè dữ liệu mới. (4) Không có state machine: reconcile không làm gì, tiền về đơn đã hết hạn có thể hồi sinh đơn.

**Chọn:** Bảng `shop.processed_hub_events (event_id PK)`. Insert event-id và `paidAmount += amount` nằm trong **cùng một transaction** (optimistic `version`; thua race thì rollback và trả 409, hub sẽ retry). Cộng dồn có tính giao hoán nên **thứ tự đến không còn quan trọng**, không cần so sánh timestamp. `PAID` và `EXPIRED` là trạng thái cuối. Tiền về sau đó vẫn được ghi nhận (`LATE_PAYMENT`/`EXTRA_PAYMENT`, log cảnh báo) nhưng **không hồi sinh đơn** (Admin chốt). Reconcile chuyển đơn `PENDING` quá 15 phút sang `EXPIRED`, bắt buộc `X-Internal-Token`.

**Đánh đổi:** +1 bảng, `apps/shop` lên ~306 dòng (vượt nhẹ mốc ~300). Đây là cùng một nguyên lý với BB-2 của hub (Postgres là trọng tài), áp dụng ở phía client của hub.

---

## ADR-035 — Socket.IO bắt buộc JWT, phát theo room tenant (2026-10-09)

**Vấn đề:** Gateway `server.emit` cho **mọi** kết nối, không cần đăng nhập, trộn dữ liệu mọi tenant. Đây là BB-5 bị thủng ở tầng realtime.

**Chọn:** Middleware handshake verify JWT (cùng `JwtService` với HTTP guard), lấy `tenantId` từ payload **đã verify** và join `tenant:<id>`. Worker gắn `tenantId` vào mọi message Redis pub/sub. Gateway chỉ `to(room).emit`. Message thiếu `tenantId` thì bị bỏ (thà mất một cập nhật còn hơn lộ dữ liệu sang tenant khác). `metrics.tick` đếm theo tenant trong bộ nhớ. Worker phát thêm `RETRYING`/`DEAD`, không chỉ `SUCCEEDED`.

**Đánh đổi:** CORS của gateway vẫn là `*`. Vì xác thực bằng token trong handshake chứ không dùng cookie, origin không phải lớp bảo vệ ở đây.

---

## ADR-036 — Seed nhận biết docker: URL đích và signing secret lấy từ env (2026-10-09)

**Vấn đề:** Seed chạy trong container ghi URL đích `localhost` (mà trong container thì đó là chính worker), nên mọi delivery bị `ECONNREFUSED ::1`. Telegram sender đoán `localhost` khi token là mock. Signing secret outbound bị gán cứng, lệch với `HUB_SIGNING_SECRET` mà shop dùng để verify.

**Chọn:** `MOCK_BASE_URL` (compose: `http://hub-api:4000`) cho mock Discord/Telegram. Seed ghi `apiUrl` vào config Telegram mock, sender bỏ việc đoán localhost. Signing secret lấy từ `HUB_SIGNING_SECRET`. Nút giả lập ở local nhận `NEXT_PUBLIC_*` qua build args của compose (chỉ service `web`).

**Đánh đổi:** Đổi seed buộc phải reset DB local một lần (Admin đã duyệt, dữ liệu test).

---

## ADR-037 — Sửa ADR-034/027/036 sau review đối kháng (2026-10-09)

**Vấn đề:** Review tìm ra 4 lỗi. (1) Shop trả **409** khi xung đột version, mà hub coi mọi 4xx (trừ 408/429) là non-retryable, nên delivery thành **DEAD** và khoản tiền thứ hai **mất**. Đây chính là kịch bản hai lần chuyển khoản song song. (2) Hạn 15 phút phụ thuộc lúc cron reconcile chạy (trên deployed có thể trễ hàng chục phút). (3) Khoá SePay **thật** được nhúng vào bundle trình duyệt qua build arg. (4) `.env` bị `COPY . .` đưa vào mọi image.

**Chọn:** (1) Bắt đầu transaction bằng `SELECT … FOR UPDATE` trên hàng đơn, để webhook/reconcile trên cùng đơn chạy tuần tự. Nếu vẫn lệch version (phòng thủ) thì trả **503**, để hub retry. (2) Hết hạn "lười": đơn `PENDING` quá 15 phút được coi là `EXPIRED` ngay trong `applyPayment`; `UNDERPAID` không tự hết hạn. (3) Nút giả lập dùng khoá riêng `DEMO_SEPAY_APIKEY`; seed thêm khoá này làm secret v2 của source SePay. (4) `.dockerignore` loại `.env*`; container nhận secret qua env của compose. `ProcessedHubEvent → Order` dùng `Restrict` vì sổ tiền không được mất theo đơn.

**Đánh đổi:** Khoá hàng làm các webhook trên **cùng một đơn** phải chờ nhau (các đơn khác nhau không ảnh hưởng). Khoá demo là secret thứ hai của SePay ở local. Chỉ chấp nhận được vì local không public.

---

## ADR-038 — Hub là hạ tầng dùng chung; biên cô lập = Project, mỗi service một API key có scope (2026-10-09)

**Vấn đề:** Hub nối được N service (code hub có 0 tham chiếu tới shop) nhưng chưa tách được chúng. Subscription chỉ lọc theo `type`, nên hai service cùng đăng ký `payment.succeeded` nhận cả tiền của nhau. Mọi thao tác đi qua một JWT admin. `tenant_id` không có bảng gốc. Admin muốn hub là công cụ như CloudAMQP hay Upstash, tách dữ liệu như Jira.

**Chọn:** Biên cô lập là **Project** (giống Jira Site, RabbitMQ vhost, Upstash Database, Hookdeck Project). Cột `tenant_id` giữ nguyên, đổi nghĩa thành project_id; `TenantScopedRepository` và BB-5 không đổi. Mỗi **service** là một **API key** có scope bên trong project (`publish:events`, `read:events` kèm lọc type/source, `manage:*`), prefix `hk_test_` / `hk_live_`. Không làm Organization, billing hay tự đăng ký.

**Đánh đổi:** Đã bác phương án "service làm biên" vì nó mâu thuẫn với fan-out: service A phát cho B nhận thì phải đục biên. Các service cùng project thấy nhau qua scope của key, không có tường cứng. Cách service kết nối (REST publish, push, poll, SSE, SDK, connection string) chưa chốt, sẽ có ADR riêng.

---

## ADR-039 — Cách service kết nối: connection string chứa key, push là mặc định, polling dự phòng, REST là hợp đồng (2026-10-09)

**Vấn đề:** Sau ADR-038 (Project + API key theo service), cần chốt cách một service bên ngoài kết nối vào hub để hub dùng như một công cụ hạ tầng (CloudAMQP, Upstash).

**Chọn:** (1) Credential là **một connection string** có key nằm sẵn bên trong, kiểu `AMQP_URL`/`REDIS_URL`: dev dán một dòng vào `.env` là xong. (2) Nhận sự kiện: **push** (hub gọi webhook có ký vào endpoint của service) là mặc định. **Polling** theo cursor là đường dự phòng. (3) **REST là hợp đồng gốc**, dùng được từ mọi ngôn ngữ. SDK không bắt buộc, nhưng có làm và khuyến khích dùng.

**Đánh đổi:** Key nằm trong URL dễ lộ qua log và stack trace, nên SDK phải tách key ra và không bao giờ in nguyên chuỗi. Push đòi service có địa chỉ public; service không có địa chỉ public thì dùng polling. Duy trì SDK là việc thêm, nhưng REST vẫn đủ dùng nếu không có SDK. Chi tiết định dạng chuỗi, header chữ ký và ngữ nghĩa polling sẽ có ADR riêng.

---

## ADR-040 — Push ký theo Standard Webhooks, endpoint phải qua challenge, polling = đọc nhật ký sự kiện (2026-10-09)

**Vấn đề:** ADR-039 chốt push là mặc định và polling là dự phòng, nhưng còn ba điểm mở. Header ký tự đặt (`X-Hub-Signature: v1=<hex>`) buộc mọi ngôn ngữ phải tự viết code verify. Ai có key `manage:endpoints` cũng trỏ được hub vào máy chủ của người khác. Và "polling dự phòng" có hai cách hiểu.

**Chọn:** (1) Ký push theo **Standard Webhooks**: header `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 của "id.timestamp.body">`. Sửa Shop theo, không gửi song song header cũ. (2) Endpoint mới phải qua **challenge** (hub gửi chuỗi ngẫu nhiên, endpoint trả lại đúng chuỗi đó) trước khi được giao sự kiện. (3) Polling kiểu **(A): đọc nhật ký sự kiện** theo cursor tăng dần, stateless, kèm lọc `?status=failed` để lấy những sự kiện push tới service đã thất bại. Service chống trùng theo `event.id`, vì push vốn đã là at-least-once.

**Đánh đổi:** Đổi header phá Shop hiện tại, phải sửa cùng lúc. Challenge thêm một bước khi đăng ký endpoint. Polling (A) có thể trả lại sự kiện mà push đã giao rồi, nên service bắt buộc phải chống trùng. Đã bác (B) "hộp thư delivery lỡ" vì nó cần lưu trạng thái riêng cho từng service.

---

## ADR-041 — Chốt các câu mở của bàn giao đa service: noisy neighbor bằng timeout, có làm GenericAdapter (2026-10-10)

**Vấn đề:** HANDOFF-2026-10-09 còn 13 câu mở. Hai câu gây tranh luận: (1) một endpoint chậm chiếm hết prefetch 20 của `q.delivery.main`, làm project khác phải chờ; (2) service muốn nhận webhook từ bên gửi chưa có adapter (vd một ngân hàng) thì làm thế nào.

**Chọn:** (1) **Hướng A:** hạ timeout gửi xuống ~5s, kết hợp circuit breaker hiện có. Không tách queue theo project, không làm semaphore. (2) **Làm `GenericAdapter` ngay đợt này**, đọc `sources.verification_config`. Chỉ có 3 mẫu xác thực (`hmac-sha256` / `static-token` / `standard-webhooks`). Idempotency lấy từ header hoặc trường cấp một, thiếu thì từ chối. `type` cố định. Sự kiện gắn `normalized:false`. Nút "Gửi thử" đổi thành **chế độ lắng nghe**: hub chờ request test thật từ bên gửi rồi báo chữ ký khớp hay sai và vì sao. Các câu còn lại theo đề xuất của phòng:
- giữ `{project}` trong path; lệch thì trả 404;
- giữ cột `tenant_id`, có comment rằng nghĩa là project_id;
- nhật ký lưu 7 ngày, chỉnh được qua env;
- wildcard chỉ cho `.*` ở cuối;
- không đổi body sang CloudEvents, chỉ có bảng ánh xạ trong tài liệu;
- long-poll `?wait=20` bằng vòng lặp DB, SSE để sau;
- Shop thành service thật dùng `HUB_URL`;
- dashboard nhóm theo project;
- `DEFAULT_TENANT_ID` thành project mặc định.

**Đánh đổi:** Timeout chỉ giới hạn thời gian một slot bị giữ, chứ chưa cô lập tài nguyên giữa các project. Semaphore theo endpoint được ghi là hướng phát triển, kèm số đo trước/sau. GenericAdapter không chuẩn hoá `data`, nên service phải tự đọc payload gốc của bên gửi. Đổi lại, luận điểm "hạ tầng dùng chung" có câu trả lời là service tự cấu hình, không phải chờ đội hub.

---

## ADR-042 — Message delivery chỉ mang tham chiếu; worker giải mã cấu hình đích lúc gửi; Telegram gửi văn bản thuần (2026-10-10)

**Vấn đề:** Normalize và replay giải mã `config` + `signingSecret` của đích rồi nhét nguyên văn vào message RabbitMQ. Replay còn ghi chúng vào `hub.outbox.payload`, tức là bot token và signing secret nằm rõ trong Postgres, trong hàng đợi retry và trong DLQ (BB09 câu 3, 6). Riêng Telegram gửi `parse_mode: Markdown`, nên một dấu `_` hay `*` lẻ trong dữ liệu làm Telegram trả 400 và delivery thành DEAD.

**Chọn:** `DeliveryMessage` chỉ còn `{deliveryId, tenantId, attemptGeneration, attemptCount, correlationId}`, dựng bằng một hàm duy nhất `buildDeliveryMessage`. Worker nạp delivery + event + subscription + destination bằng **một** truy vấn `findDeliveryForSend` (lọc tenant ở cả ba bảng) và giải mã ngay lúc gửi. Message kiểu cũ còn trong hàng đợi vẫn đọc được: worker chỉ lấy các trường tham chiếu, bỏ qua phần còn lại, và mọi lần đẩy tiếp (retry, hoãn, DLQ) đều dựng lại bản gọn. Migration `20261010000000_scrub_outbox_secrets` xoá các khoá thừa khỏi outbox cũ. Telegram bỏ `parse_mode`, template seed của Telegram bỏ `**`.

**Đánh đổi:** Thêm 1 truy vấn DB mỗi lần gửi. Đổi lại, sửa URL/token của đích có hiệu lực ngay cả với message đang chờ retry, và ngoài bảng `destinations` (đã mã hoá) không còn chỗ nào giữ secret. Telegram mất định dạng in đậm, nhưng không còn chết vì ký tự lạ.

---

## ADR-043 — Mọi chặng đều qua outbox; sweeper và lease thay cho "phép màu" (2026-10-10)

**Vấn đề:** Normalize COMMIT event + delivery rồi mới `channel.publish` trên kênh không confirm. Worker chết hay broker từ chối giữa hai bước đó thì delivery nằm PENDING mãi mà không ai biết (BB09 câu 4). Chặng ingest → normalize đã có outbox, chặng normalize → delivery thì chưa.

**Chọn:** Trong cùng transaction của normalize, mỗi delivery có thêm một dòng outbox `delivery.requested`. Relay định tuyến bằng bảng `TOPIC_ROUTES` thay cho `if`. Trước khi gửi, worker **giành lease** bằng một UPDATE có điều kiện (`claimForSend`): phải đúng generation và attemptCount, trạng thái PENDING/RETRYING, hoặc DELIVERING đã treo quá 60s. Không giành được thì ack và thôi. **Sweeper** chạy cùng relay mỗi 60s ± 10s. Nó tìm delivery PENDING quá 10 phút chưa có attempt, hoặc DELIVERING treo quá 10 phút, mà không có outbox chưa publish (hay vừa được ghi trong 10 phút), rồi ghi lại một outbox `delivery.requested` (`FOR UPDATE SKIP LOCKED`, `LIMIT 100`). Sweeper chạy xuyên tenant giống relay, chỉ ghi outbox trong cùng câu lệnh, không trả dữ liệu nghiệp vụ ra ngoài.

**Đánh đổi:** Chặng thứ hai trễ thêm một vòng relay (~500ms). Lease 60s phải lớn hơn timeout gửi 5s cộng thời gian ghi DB; một lần gửi treo quá 60s có thể bị gửi lại (at-least-once, đích phải chống trùng theo event id). Sweeper có thể sinh message trùng, nhưng lease + `processed_messages` đảm bảo chỉ có một lần gửi thật.

---

## ADR-044 — Lỗi normalize phân loại tạm/vĩnh viễn; phát lại từ `raw_events`, không từ DLQ broker (2026-10-10)

**Vấn đề:** Mọi lỗi ở normalize đều `nack` thẳng vào `q.normalize.dlq`. Postgres chập chờn một giây là sự kiện đã nhận (đã trả 200 cho provider) nằm chết trong DLQ, và không có công cụ phát lại (BB09 câu 4).

**Chọn:** Hàm thuần `classifyNormalizeError` coi Prisma `P1001/P1002/P1008/P1017/P2024/P2034`, `PrismaClientInitializationError`, `ECONNRESET/ETIMEDOUT` là lỗi **tạm**; còn lại (adapter ném, JSON hỏng, provider lạ) là **vĩnh viễn**. Lỗi tạm đi vào queue mới `q.normalize.retry.30s` (TTL 30s, dead-letter về `x.hub.events/event.received`) với header `x-normalize-retry` tăng dần, tối đa 5 lần rồi mới vào DLQ. Phát lại dựa trên **Postgres**:
- `GET /api/v1/raw-events/orphans` trả raw ACCEPTED quá 2 phút, chưa có event, chưa có `processed_messages`;
- `POST /api/v1/raw-events/renormalize {ids?, reason}` ghi lại outbox `event.received` (≤ 500 dòng/lần) kèm một dòng `audit_logs`.

Dashboard `/dashboard/events` có dải cảnh báo kèm nút "Chuẩn hoá lại". Cờ `NORMALIZE_FAULT_FIRST_N` (chỉ ngoài production) dùng để tiêm lỗi khi kiểm.

**Đánh đổi:** Lỗi lạ chưa liệt kê bị coi là vĩnh viễn. Cách này an toàn hơn quay vòng âm thầm, nhưng lỗi đó phải phát lại bằng tay. DLQ của broker vẫn còn, chỉ là bản sao để quan sát; nguồn sự thật là `raw_events`.

---

## ADR-045 — AMQP rớt thì chết sạch để orchestrator dựng lại; cleanup giữ 7 ngày; request ký sai chỉ lưu mẫu có giới hạn (2026-10-10)

**Vấn đề:** Worker không thử lại khi broker lên chậm và không xử lý `close`, nên mất RabbitMQ thì tiến trình vẫn sống nhưng điếc. Không có job dọn `outbox`/`processed_messages`. Request ký sai được lưu nguyên body với khoá không bao giờ trùng: ai biết một source key là có thể đổ ~14GB/ngày vào `raw_events`, trong khi Neon free chỉ có 0,5GB.

**Chọn:**
1. **Kết nối AMQP.** Lúc khởi động thử 10 lần, backoff 1s→30s. Đang chạy mà gặp `close` thì log, dừng relay/sweeper/cleanup rồi `process.exit(1)`; compose `restart: unless-stopped` và Render sẽ dựng lại. **Không** tự dựng lại channel trong cùng tiến trình: dựng lại consumer, confirm channel và relay giữa chừng dễ sinh bug hơn là chết sạch rồi lên lại. Message chưa ack tự quay về hàng đợi, outbox chưa publish vẫn nằm trong Postgres. Mọi client Redis trong worker có `.on('error')`.
2. **`CleanupJob`.** Chạy mỗi giờ ± 10%, giành `SET cleanup:lock <instance> NX EX 300`, rồi xoá theo lô 5000 dòng: outbox đã publish, `processed_messages`, `raw_events` REJECTED quá `CLEANUP_RETENTION_DAYS` (mặc định 7). Lúc load có assert: retention phải lớn hơn tổng thời gian retry (10s+1m+5m+30m+2h + 5×30s).
3. **Request REJECTED.** Chỉ lưu 4KB đầu, ghi meta `__hub_meta.bodyTruncated` vào cột `headers` (không cần migration). Tối đa 20 bản ghi/phút/source, đếm trong bộ nhớ; vượt thì vẫn trả 401 nhưng chỉ log. Không đụng `raw_events` ACCEPTED.

**Đánh đổi:** Mỗi lần broker chớp là một lần restart worker (vài giây). Trần 20/phút nằm trong bộ nhớ nên nhân theo số instance hub-api, nhưng không tốn lệnh Redis nào. Mẫu REJECTED bị cắt thì không verify lại được, nhưng nó vốn chỉ dùng để điều tra.

---

## ADR-046 — Kiểm đích cùng tenant ở API và lọc lại ở repo; Shop có user DB riêng chỉ thấy schema `shop` (2026-10-10)

**Vấn đề:** `POST /subscriptions` nhận `destinationId` của tenant bất kỳ. Normalize đọc `raw_events` bằng `prisma.rawEvent.findUnique` trần, không qua repo. Hub và Shop dùng chung `hub_user`, nên Shop đọc/ghi được toàn bộ `hub.*` (BB09 câu 9; BB-5).

**Chọn:**
- API gọi `repo.findDestinationById` trước khi tạo; không thấy thì trả **404** (không phải 403, để không lộ việc đích có tồn tại ở tenant khác).
- Repo lọc thêm `destination: { tenantId }` trong `findActiveSubscriptionsForEventType` và `findDeliveryForSend`, để phòng thủ chiều sâu cho dữ liệu cũ.
- Normalize đọc qua `repo.findRawEventById` (lọc theo `source.tenantId`).
- Thêm role `shop_user` (`docker/postgres/init/02-shop-user.sh`, mật khẩu từ `SHOP_DB_PASSWORD`): chỉ có `USAGE` và CRUD trên schema `shop`, cộng `ALTER DEFAULT PRIVILEGES FOR ROLE hub_user` để bảng do migration tạo sau vẫn dùng được. Không cấp gì trên `hub`.

**Đánh đổi:** Script init chỉ tự chạy khi volume rỗng; volume cũ phải chạy tay một lần. Trên Neon phải tạo role tương tự bằng tay. Bảng tenants, RLS và khoá ngoại ghép theo tenant vẫn để cho phiên đa service (ADR-038).

---

## ADR-047 — `migrate deploy` thay `db push --accept-data-loss`; kiểm export lúc khởi động (2026-10-10)

**Vấn đề:** Entrypoint chạy `prisma db push --accept-data-loss` mỗi lần hub-api lên. Khi image nạp nhầm `libs/database/dist` cũ (BB09 P0-1), schema cũ bị "đồng bộ" ngược và xoá dữ liệu. Worker nạp dist cũ thì chỉ lộ lỗi khi message đầu tiên tới, lúc đó message đã trôi vào DLQ.

**Chọn:**
- Baseline `libs/database/prisma/migrations/0_init` sinh bằng `migrate diff --from-empty`. DB local được đánh dấu bằng `migrate resolve --applied 0_init`, không reset; `migrate diff` giữa DB đang chạy, migrations và schema đều ra rỗng.
- Entrypoint chạy `prisma migrate deploy`. Mọi thay đổi schema về sau là một migration mới.
- `assertDatabaseLib()` kiểm `getMasterKey`, `TenantScopedRepository` và các phương thức mới; được gọi ở đầu `bootstrap()` của hub-api và hub-worker.
- Dockerfile chạy `rm -rf libs/*/dist apps/*/dist` trước `npm run build`, làm lớp chặn thứ hai sau `.dockerignore`.
- `.gitignore` chặn `dist/`, `libs/*/src/**/*.js|.d.ts`, `*.js.map`; `.gitattributes` giữ `*.sh` ở LF.

**Đánh đổi:** Đổi schema phải viết migration (thêm một bước), và Neon cần `DIRECT_URL` cho `migrate deploy`. Đổi lại, luồng khởi động không còn lệnh nào có quyền xoá dữ liệu.


---

## ADR-048 — Circuit breaker 3 trạng thái với probe `SET NX`; DB `circuit_state` chỉ để hiển thị, Redis là nguồn chạy; sweeper cứu RETRYING kẹt (2026-10-10)

**Vấn đề:** Circuit cũ không có HALF_OPEN: hết khoá thì mọi message đều được gửi. Bộ đếm lỗi không bao giờ reset, `destinations.circuit_state` không ai ghi, và message bị hoãn vì OPEN rơi vào hàng đợi 2h dù circuit chỉ mở 60s (BB09 câu 5). Review SPEC-1 còn chỉ ra ba lỗ:
- worker COMMIT RETRYING + `processed_messages` rồi chết trước `sendToQueue` thì delivery RETRYING mãi;
- sweeper nhân bản message của delivery PENDING đang bị circuit hoãn;
- claim thua vì lease DELIVERING còn hạn thì message bị ack bỏ, delivery treo tới khi sweeper cứu (10 phút).

**Chọn:**
- **Khoá Redis.** `circuit:{id}:failures` (INCR, EX 120 ở lần đầu, gia hạn 180s lúc OPEN), `:open` (EX 60), `:probe` (SET NX EX 30). `getState` dùng một lệnh MGET. HALF_OPEN là trạng thái suy ra (`:open` hết hạn mà `failures ≥ 5`), không lưu.
- **Chọn trạng thái.** OPEN, hoặc HALF_OPEN mà không giành được probe, thì hoãn vào tầng ngắn nhất có TTL ≥ 60s (`retryQueueForDelay`, ra `q.delivery.retry.1m`). Không tăng `attemptCount`, có ghi `next_attempt_at`.
- **Kết quả gửi.** Thành công khi `failures == 0` thì không gọi Redis. Thành công trong các trường hợp khác thì một lệnh DEL ba khoá. Thất bại khi đạt ngưỡng, hoặc probe thất bại, thì sang OPEN.
- **Ghi DB.** Chỉ khi trạng thái đổi: `UPDATE … WHERE circuit_state <> to`. Nhiều worker cùng thấy thì chỉ bên đổi được dòng mới `PUBLISH hub:realtime:circuit` (có tenantId). Lần đổi do khoá hết hạn được phát hiện ở message kế tiếp, bằng cách so với cột DB đọc kèm delivery. Bỏ kênh `hub:alerts`. Redis chết thì fail-open và không ghi DB.
- **Sweeper.** Quét thêm RETRYING có `next_attempt_at` quá hạn hơn 5 phút (`DELIVERY_RETRY_SWEEP_GRACE_MS`); `attemptCount` lấy từ cột `attempt_count`. PENDING có `next_attempt_at` mới (đang bị hoãn) thì không bị quét. Bản sao do sweeper sinh và message gốc mang cùng `attemptCount`, nên lease `claimForSend` chỉ cho một bên gửi; bản tới muộn lệch `attempt_count` nên bị bỏ (có test trên Postgres thật).
- **Lease thua.** Nếu delivery vẫn DELIVERING với đúng generation và attemptCount (lease còn hạn) thì hoãn vào 1m, không ack bỏ.
- **Graceful shutdown.** Huỷ consume trước, chờ handler đang chạy (`InFlightTracker`) trong `SHUTDOWN_TIMEOUT_MS − 5s`, rồi mới đóng channel.

**Đánh đổi:**
- Mỗi message tốn một MGET.
- DB có thể chậm một nhịp so với Redis: OPEN hết hạn mà không có message nào tới thì dashboard vẫn hiện OPEN.
- Lỗi 4xx cũng tính vào circuit, vì đích cấu hình sai cũng là đích hỏng.
- Hoãn vì throttle không ghi `next_attempt_at`, để không ghi DB cho mỗi message bị throttle. Nếu throttle kéo dài quá 5 phút, sweeper có thể sinh bản sao; lease chặn được việc gửi trùng.
- Delivery RETRYING cũ, có từ trước khi có cột `next_attempt_at`, không được sweeper cứu.

---

## ADR-049 — Trace in-process ở hub-api, chỉ pub/sub ở worker; gộp chặng để giữ ngân sách Redis (2026-10-10)

**Vấn đề:** Realtime chỉ có `event.received` và `delivery.updated` thiếu trường, không có trace ingest và không có `circuit.changed`. `successRate` hiện 100% khi chưa có gì (BB09 câu 7).

**Chọn:**
- **`trace.ingested`.** Gộp ① nhận → ④ ACK, `IngestService` gọi interface `TraceNotifier` (ADR-021). `RealtimeGateway` cài interface này và emit thẳng vào room tenant, tốn 0 lệnh Redis. Chỉ phát khi đã biết tenant (source tồn tại). Outcome thêm `ERROR` cho trường hợp 500 lúc COMMIT.
- **`event.received`.** Một publish cho mỗi raw event, mang `correlationId`, `events[]` và `deliveries[]` (id, tên, loại đích; không có cấu hình).
- **`delivery.attempt`.** Thay `delivery.updated`, mang `attemptNo`, `generation`, `httpStatus`, `ms`, `nextQueue` và `nextAttemptAt`. DEFERRED không publish. Worker ghi `deliveries.next_attempt_at = now + TTL tầng kế`.
- **`circuit.changed`.** Lấy từ `hub:realtime:circuit`.
- **`successRate`.** Bằng `null` khi `done = 0` (cả `metrics.tick` lẫn `/overview`).

**Đánh đổi:** Chạy nhiều instance hub-api thì client nối vào instance B không thấy `trace.ingested` của instance A. Chấp nhận được: dữ liệu đầy đủ vẫn nằm ở `GET /events/:id`, socket chỉ để cập nhật trực tiếp.

---

## ADR-050 — Audit log ghi cùng transaction với hành động; bulk replay ≤ 500 dòng, bắt buộc lý do, có dryRun (2026-10-10)

**Vấn đề:** Không có replay hàng loạt. `audit_logs` gần như không ai ghi: chỉ renormalize của S1-3 ghi (BB09 câu 6).

**Chọn:**
- **Audit.** `repo.createAuditLog` / `findAuditLogs`. `actor` lấy từ JWT `sub` qua `@CurrentUser()`. Mọi hành động ghi audit trong cùng `$transaction`, gồm:
  - tạo, sửa, xoá đích và subscription;
  - tạo và sửa source (không xoá source, vì sẽ mất `raw_events`);
  - replay đơn (thêm `reason?`);
  - renormalize.
  Metadata chỉ ghi tên trường, không ghi config hay secret.
- **Replay hàng loạt.** `POST /deliveries/replay-bulk` chọn tập bằng `findDeadDeliveryRefs`. Hàm này dùng chung điều kiện `notSuperseded` của DLQ (ADR-031) và nhận thêm bộ lọc đích, khoảng thời gian, `errorContains` (ILIKE có escape). Tối đa 500 dòng. `dryRun` chỉ đọc. Chạy thật ghi `createMany` N delivery, `createMany` N outbox `delivery.replayed` (message gọn) và một audit `delivery.replay_bulk` trong một transaction. Gặp P2002 thì rollback cả lô và trả 409.
- **Xem audit.** `GET /audit-logs?limit&before`; id bigint trả về dạng chuỗi.

**Đánh đổi:** Transaction lớn (tối đa 1000 dòng, timeout 30s) giữ khoá lâu hơn. Chọn tất-cả-hoặc-không vì dễ giải thích hơn chạy từng phần. Audit không có bảng riêng cho tenant; tenant thứ hai để cho phiên đa service.

---

## ADR-051 — Che header nhạy cảm trước khi lưu `raw_events`; `body_raw` giữ nguyên bytes (2026-10-10)

**Vấn đề:** Review SPEC-1: API key SePay (`Authorization: Apikey <key>`) nằm rõ trong `raw_events.headers` và `signature_header`, lộ qua `GET /api/v1/events/:id` và trang chi tiết sự kiện. Lưu cả bản REJECTED (key sai nhưng có thể gần đúng).

**Chọn:**
- **Ingest.** `redactHeaders()` (`apps/hub-api/src/modules/ingest/redact-headers.ts`) che `authorization`, `cookie`, `x-api-key`, `proxy-authorization` thành `<scheme> ***` (vd `Apikey ***`) hoặc `***`, **sau** `adapter.verify` và **trước** mọi lần ghi (ACCEPTED lẫn REJECTED). `signature_header` tính từ bản đã che; chữ ký HMAC `sha256=` (không phải bí mật) giữ nguyên. Request gốc không bị đột biến, adapter vẫn đọc được.
- **`body_raw` không đụng.** HMAC tính trên bytes gốc; điều tra/replay cần bytes nguyên vẹn.
- **Dữ liệu cũ.** Migration `20261010010000_redact_raw_event_headers` che cùng quy tắc bằng SQL (idempotent).
- **Log.** Ingest không log header; thêm `redact` của pino cho `headers.*`/`req.headers.*` làm lưới an toàn.
- **Sender (cùng đợt review).** Gửi ra thêm `AbortSignal.timeout(5000)` (axios `timeout` chỉ là idle) và trần 64KB body gửi/nhận; abort thành `SendResult` 500 như timeout cũ. Normalize: P2028 (transaction timeout) vào nhóm lỗi tạm. `seed --sync-destinations` thiếu env thì exit 2 trừ khi `--allow-defaults`. Sweeper cứu RETRYING `next_attempt_at IS NULL` có `updated_at` > 3h (dữ liệu trước khi có cột).

**Đánh đổi:** Không còn xem lại được key SePay đã gửi tới để điều tra "sai key nào" — chỉ biết scheme. Không verify lại được từ header đã lưu (hiện không chặng nào làm thế; replay dùng event đã chuẩn hoá). Header nhạy cảm của provider tương lai phải thêm vào danh sách — một chỗ duy nhất.

---

## ADR-052 — DLQ broker có giới hạn bằng POLICY, không bằng arguments queue (2026-10-10)

**Vấn đề:** `q.delivery.dlq`, `q.normalize.dlq` không consumer, không giới hạn → phình tới trần CloudAMQP free. Thêm `x-max-length` vào arguments thì queue đang tồn tại báo `PRECONDITION_FAILED` (CLAUDE.md cạm bẫy 3).

**Chọn:** Policy `hub-dlq-bounded` — pattern `^q\.(delivery|normalize)\.dlq$`, `max-length 5000`, `overflow drop-head`, priority 10, apply-to queues. Nguồn giá trị: `DLQ_POLICY` trong `libs/messaging/src/topology.ts` (vẫn MỘT chỗ khai báo topology). Local: service one-shot `rabbitmq-init` (rabbitmqadmin, PUT idempotent) trong docker-compose; test bắt compose khớp hằng số. Deployed: đặt tay qua management API CloudAMQP (`docs/DEPLOYMENT.md` §6.1) — app không giữ quyền management.

**Đánh đổi:** Quá 5000 thì bản CŨ nhất trong DLQ broker bị bỏ. Chấp nhận được vì nguồn sự thật DLQ là Postgres (`deliveries` DEAD, `raw_events`) — trang DLQ và replay đọc từ DB, không đọc broker. Policy nằm ngoài code app: quên đặt trên CloudAMQP thì chỉ quay về hành vi cũ (phình), không hỏng chức năng.

## ADR-053 — Vào nhiều kiểu, ra một kiểu: catalog kiểu chuẩn `payment.*` / `repo.*` có validator (2026-10-10)

**Vấn đề:** Phong bì event đã thống nhất, còn `data` thì vẫn theo kiểu của từng provider: PayOS `amount` + `orderCode` (phạm BB-1), SePay `transferAmount`, GitHub và Stripe dùng body gốc. Hệ quả là khách hàng của hub (Shop) phải tự viết `amount || transferAmount`, tức cái `if` theo provider bị đẩy từ lõi sang phía khách hàng. Admin chốt: giá trị cốt lõi của hub với dev production là service chỉ nói **một ngôn ngữ**, ở cả định dạng (S14), cách xác thực (Standard Webhooks, ADR-040) và nhịp nhận (push/polling, ADR-039).
**Chọn:**
- Catalog v1 gồm `payment.received|sent|failed|refunded` (PayOS, SePay, Stripe) và `repo.push|pull_request.*|issue.*` (GitHub). Phần chung mỏng, kèm `data.raw` là body gốc.
- Không gian `payment.*` và `repo.*` dành riêng, phải qua validator viết tay trong `libs/common/src/canonical`. Sai khuôn → lỗi normalize vĩnh viễn, không hạ cấp âm thầm.
- Kiểu chưa có ánh xạ → `<provider>.<kiểu gốc>`, `normalized:false`, `data={raw}`.
- GenericAdapter có thêm `mapping` khai báo, chỉ trường cấp một hoặc `const`, chỉ cho miền thanh toán.
- PayOS lỗi giờ ra `payment.failed`. GitHub ngoài push/PR/issue chuyển từ `repo.<event>` sang `github.<event>`.
- Event cũ không migrate, retention 7 ngày tự dọn.

Chi tiết ở SPEC hub-multi-service §4.14, story S14.
**Đánh đổi:**
- `events.data` gần gấp đôi vì giữ `raw`.
- Catalog là hợp đồng công khai: chỉ được thêm trường; muốn đổi thì phải làm kiểu `.v2`.
- Không chuẩn hoá được mọi miền: chỉ thanh toán và repo, miền khác đi qua `raw`.
- Đổi tên kiểu (`payment.succeeded` → `payment.received`) làm vỡ subscription cũ, phải sửa seed, Shop và placeholder của UI.

## ADR-054 — Lịch sử gửi không mất theo cấu hình; circuit chỉ tính lỗi phía đích và có trần hoãn; phản hồi 2xx lớn vẫn là 2xx (2026-10-10)

Sửa sau review đối kháng SPEC-2 (gộp các điểm cùng chủ đề "không mất, không lặp, không quay vòng").

**Vấn đề:**
1. FK `deliveries.subscription_id` / `subscriptions.destination_id` là `ON DELETE CASCADE`: xoá một subscription/đích xoá luôn mọi delivery + attempt (kể cả DEAD), audit trỏ vào hư không.
2. `replay-bulk` coi `dryRun: "true"` (chuỗi) là "không phải true" → chạy thật.
3. `recordFailure` chạy cho cả 4xx → một subscription sai URL (404) mở circuit, hoãn oan mọi delivery khác của đích.
4. Hoãn vì circuit không có trần → đích chết hẳn làm delivery quay vòng `retry.1m` mãi, đốt Redis/DB.
5. (Hồi quy ADR-051) `maxContentLength` 64KB biến 2xx body lớn thành 500 → retry → **gửi trùng**.
6. Probe `SET NX` không kiểm lại trạng thái, nhả probe bằng `DEL` không kiểm chủ; INCR + EXPIRE là 2 lệnh.

**Chọn:**
1. API trả **409** kèm `deliveryCount` / `subscriptionCount` và hướng dẫn "tắt (`isActive=false`) thay vì xoá"; đích chỉ xoá được khi không còn subscription. Migration `20261010020000_restrict_delivery_history_fk` đổi hai FK sang `ON DELETE RESTRICT` (lớp phòng thủ ở DB; race → P2003 → 409). `deliveries.event_id` vẫn CASCADE (retention xoá event cũ là có chủ đích). UI có nút Tắt/Bật + Xoá, 409 hiện thành toast dễ hiểu kèm nút "Tắt".
2. `dryRun` **bắt buộc** boolean JSON — thiếu hay sai kiểu đều 400 (thao tác ghi hàng loạt phải nói rõ ý định; không đoán mặc định). `from`/`to` phải là chuỗi ISO 8601, `from ≤ to`; `destinationId` UUID; `errorContains` chuỗi. Audit bulk: `entityType='delivery_batch'`, `entityId` = UUID của lô (trả về `batchId`), danh sách id ở `metadata`.
3. Chỉ **5xx, 408, 429, lỗi mạng/timeout** (sender trả 500 khi không có phản hồi; status < 100 phòng hờ) tính vào circuit. 4xx khác vẫn DEAD ngay nhưng không chạm circuit. Probe HALF_OPEN nhận 4xx: không phải bằng chứng đích sống/chết → **nhả probe, giữ HALF_OPEN** (lần gửi kế tiếp thử lại ngay, không phải đợi 30s TTL probe).
4. Header `x-circuit-deferrals` +1 mỗi lần hoãn; vượt `CIRCUIT_MAX_DEFERRALS` (mặc định 30 ≈ 30 phút) → coi là MỘT lần thử thất bại: vẫn qua `processed_messages` + lease `claimForSend`, ghi attempt (`response_status` NULL, error "circuit … quá lâu"), đi tầng retry kế tiếp theo `attemptCount` như lỗi retryable (cuối cùng DEAD), `next_attempt_at` = TTL tầng đó (sweeper không nhân bản). Không chạm circuit (không gọi đích = không có bằng chứng mới). Header về 0 ở mỗi lần thử mới.
5. Sender đọc phản hồi bằng `responseType: 'stream'`, `validateStatus: () => true`, giữ tối đa 64KB rồi huỷ stream; status lấy từ dòng trạng thái. Giữ `maxBodyLength` 64KB cho body GỬI đi.
6. Ba script Lua: `INCR+EXPIRE` (một lệnh — dùng cho cả throttle), giành probe (chỉ `SET NX` khi `:open` không tồn tại và `failures ≥ 5`, giá trị = token ngẫu nhiên), nhả probe chỉ khi giá trị = token. Thành công sau lỗi: UPDATE có điều kiện `circuit_state <> 'CLOSED'` bất kể `persistedState` đọc trước. Kèm: `/mock/*` chỉ đăng ký khi `NODE_ENV !== 'production'`, mock Telegram che token trong log.

**Đánh đổi:**
- Đích từng được dùng gần như không xoá được nữa (subscription có lịch sử không xoá được → đích còn subscription). Muốn dọn phải tắt; xoá thật chỉ qua retention event (CASCADE từ `events`). Chấp nhận: bằng chứng gửi quan trọng hơn gọn danh sách.
- Client cũ gửi `replay-bulk` không có `dryRun` giờ nhận 400 (UI đã sửa).
- 4xx hàng loạt (vd token Telegram bị thu hồi → 401) không còn mở circuit: mỗi delivery tự gọi đích một lần rồi DEAD. Đúng ngữ nghĩa (đích sống, lỗi là của ta) nhưng tốn một request/delivery.
- Lần "thử" vì circuit quá trần đốt một bậc retry mà không gọi đích; đích chết > ~30 phút × 5 tầng thì delivery thành DEAD dù chưa từng được gửi thêm — đúng ý: replay từ DLQ khi đích sống lại.
- Phản hồi > 64KB bị cắt (chỉ lưu 2KB đầu vào `delivery_attempts` như trước). Lua cần Redis hỗ trợ `EVAL` (Upstash có).

## ADR-055 — Trải nghiệm dev: lỗi có `fix`, Quickstart 60 giây, `hub listen` trên nền polling (A); không làm trang "cam kết" (2026-10-10)

**Vấn đề:** Admin yêu cầu nhìn từ vị trí dev dùng hub (tiện, setup dễ, quản lý dễ, uy tín, dễ scale, như Cloudflare/AWS). Hiện tại một dev mới phải qua 6 bước và đọc tài liệu ở mỗi bước. Lỗi trả về chỉ có mã. Dev viết handler trên laptop thì không nhận được webhook, vì SSRF guard và NAT chặn.
**Chọn:**
- **Lỗi:** dạng `{error, message, fix, docsUrl, requestId}` cộng header `x-request-id`, lấy từ một catalog duy nhất. `message` và `fix` viết tiếng Anh theo thông lệ API; `docs/ERRORS.md` giải thích bằng tiếng Việt. `/hooks` giữ ack theo provider.
- **Quickstart:** response tạo key kèm 3 ô copy, sinh từ `buildQuickstart` trong SDK. Có app mẫu ≤ 40 dòng. Mục tiêu ≤ 60s từ connection string tới event đầu tiên.
- **`hub listen`:** CLI trong SDK, long-poll `after=latest`, ký Standard Webhooks bằng secret phiên, forward vào localhost.
  - Không thêm hạ tầng server.
  - Body phải byte-identical với `WebhookSender` (dùng chung `toWebhookBody`).
  - Chỉ đọc, không tạo delivery.
- **Không** làm trang "Cam kết của hub". Admin: "chứng minh bằng hành động chứ không phải lời nói".

Chi tiết ở `planning-artifacts/hub-multi-service/SPEC-dev-experience.md`.
**Đánh đổi:**
- `listen` trễ 2–4s do cửa sổ lắng.
- SDK chưa publish npm, nên `npx hub` cần cài từ đường dẫn.
- Thông báo lỗi tiếng Anh, có thể bị hội đồng hỏi.
- Thêm một lớp filter lỗi phải giữ cho đủ mã.

## ADR-056 — Có đăng ký + đăng nhập cho người dùng; đảo một phần ADR-038 (2026-10-10)

**Vấn đề:** ADR-038 bỏ tự đăng ký, ARCHITECTURE §7.4 chỉ có một admin sống trong biến môi trường. Hiện JWT gắn cứng `DEFAULT_TENANT_ID`. Spec đa service chỉ mô tả danh tính của máy (API key + scope), bỏ trống danh tính của người. Hai hệ quả: `?projectId=` của admin trở thành IDOR ngay khi có người thứ hai, và màn đầu tiên hội đồng nhìn thấy, tức đăng ký và đăng nhập, không tồn tại.

**Chọn:** Có đăng ký và đăng nhập thật, với bảng `users` và `project_members`. Role (owner/developer/viewer) là một bó scope có tên, dùng chung ngôn ngữ quyền với API key. Admin trong env chuyển vai thành operator, dùng như tài khoản root. Chi tiết (xác minh email, đăng nhập GitHub, nơi giữ token, RLS bắt buộc hay không) chốt ở vòng bàn tiếp theo và ghi bổ sung vào spec.

**Đánh đổi:** Phạm vi tăng khoảng 1–1,5 ngày. Kéo theo việc phải làm phần bảo mật đăng nhập, gồm rate limit, chống dò email và thu hồi phiên. Hội đồng sẽ soi phần này, nên làm nửa vời còn tệ hơn không làm.

## ADR-057 — Chi tiết xác thực: JWT 15 phút trong cookie HttpOnly + refresh xoay vòng ở Postgres; xác minh email thật; đăng nhập GitHub; RLS bắt buộc (2026-10-10)

**Vấn đề:** ADR-056 đã chốt có đăng ký. Admin yêu cầu "bảo mật đúng chuẩn" và cho chọn giữa session cookie và access/refresh trong Redis. Admin cũng chốt: xác minh email thật (Admin cấp key mail), có đăng nhập GitHub, mời thành viên qua link, RLS bắt buộc.

**Chọn:** Spec riêng ở `_bmad-output/planning-artifacts/auth/SPEC-auth.md` (AU1–AU6), tách khỏi SPEC-3 mà phiên khác đang làm.
- **Token:** access JWT HS256 15 phút trong cookie `__Host-` HttpOnly. Refresh token là chuỗi ngẫu nhiên, lưu sha256 ở `auth_sessions` trong **Postgres**, xoay vòng và phát hiện dùng lại theo family. CSRF dùng double-submit có ký theo sid.
- **Vì sao không để token ở Redis:** theo BB-2, Redis mất dữ liệu sẽ làm mù việc phát hiện dùng lại, tức là sai về bảo mật. Redis chỉ dùng cho rate limit, có fallback trong bộ nhớ.
- **Phân quyền:** role là bó scope dùng chung ngôn ngữ với API key (`ROLE_SCOPES`, Principal chung).
- **Web:** proxy `/api` và `/auth` qua Next rewrites để cookie là first-party (Vercel ≠ Render). Socket dùng vé 60 giây.
- **RLS:** role runtime `hub_app`, không superuser, không BYPASSRLS, kiểm lúc khởi động. Mỗi transaction gọi `set_config('app.project_id', …, true)`. Đường hệ thống đi qua đúng một hàm `systemTx` (grep được).

**Đánh đổi:**
- Mỗi request console thêm một lần đọc Postgres.
- Mỗi thao tác repo bọc trong transaction, phải đo p95 (trần lệch 15%).
- Cờ `app.rls_system` về lý thuyết code nào cũng set được; chỉ kiểm soát bằng grep và test.
- Resend chưa xác minh domain thì chỉ gửi được tới email chủ tài khoản.
- Ước lượng thật khoảng 25 giờ, thay con số 1–1,5 ngày ở ADR-056.
- Đã bác: mỗi project một DB hoặc schema riêng; hai connection string với role BYPASSRLS cho worker (nhân đôi connection Neon); access token trong localStorage.

## ADR-058 — PayOS: chữ ký tính bằng SDK, so sánh bằng `timingSafeEqual` của ta; khoá chống trùng dự phòng = hash body; adapter tự trả chữ ký để lưu (S3-1, 2026-10-10)

**Vấn đề:** `payos.webhooks.verify()` so chữ ký bằng `!==` (rò thời gian, trái CLAUDE.md). SePay chấp nhận cả header không có tiền tố `Apikey`. Thiếu `id`/`reference` thì khoá chống trùng là `ulid()` — provider gửi lại sinh event thứ hai (phá BB-2). `signature_header` do lõi đoán (`x-hub-signature-256 || authorization`) nên PayOS/Stripe lưu rỗng.
**Chọn:** PayOS gọi `crypto.createSignatureFromObj(data, key)` của `@payos/node` (giữ canonicalization chính chủ) rồi `timingSafeCompare` (thử đủ mọi secret, không thoát sớm). SePay bắt buộc `Apikey <key>` (không phân biệt hoa thường ở scheme); comment ghi rõ "không ký nội dung, là API key dùng chung". Mọi nhánh dự phòng của khoá chống trùng (PayOS, SePay, GitHub, Stripe) = `bodyHashKey(rawBody)` = sha256 hex 32 ký tự. `ProviderAdapter.extractSignature(req)`: GitHub `x-hub-signature-256`, Stripe `stripe-signature`, PayOS `body.signature`, SePay `Apikey ***` (che); ingest lưu giá trị này dạng chuỗi trần.
**Đánh đổi:** Hai body khác nhau một byte (vd khoảng trắng) mà cùng là một giao dịch sẽ ra hai khoá — chấp nhận, vì provider gửi lại byte-y-hệt. `signature_header` cũ là chuỗi JSON có ngoặc kép (`"sha256=…"`), dòng mới là chuỗi trần — không migrate (cột chỉ để điều tra, không ai đọc lại để verify).

## ADR-059 — SPEC-3 S3-2 (CloudEvents + `payment.succeeded`/`bank.transfer.*`) bị thay bằng lõi S14: một đầu ra duy nhất (2026-10-10)

**Vấn đề:** S3-2 gốc đổi body sang CloudEvents và giữ hai họ kiểu tiền (`payment.succeeded`, `bank.transfer.*`). Nó đâm vào ADR-053: service vẫn phải phân biệt "tiền qua cổng" và "tiền qua ngân hàng", tức cái `if` theo provider chỉ đổi chỗ. Admin chốt (DINH-CHINH 10/10 §0, A1): "chỉ có 1 đầu ra duy nhất".
**Chọn:** Làm phần lõi S14 không phụ thuộc đa service: catalog viết tay `libs/common/src/canonical` (`validateCanonical`, `isReservedType`, `parseProviderTime`); 4 adapter ra `payment.received|sent|failed|refunded` / `repo.push|pull_request.*|issue.*` kèm `data.raw`, kiểu chưa ánh xạ ra `<provider>.<kiểu gốc>` + `normalized:false`; `NormalizeConsumer` kiểm kiểu dành riêng TRƯỚC transaction (sai → lỗi vĩnh viễn, metric `hub_normalize_schema_errors_total{source}`); cột `events.normalized` (migration `20261010030000`, default true) và trường `normalized` trong body gửi đích. Shop chỉ đọc `payment.received` (`data.amount`, mã đơn trong `memo` rồi `reference`). **Không** đổi body sang CloudEvents, **không** thêm cột `events.provider`; bảng ánh xạ sang CloudEvents chỉ nằm trong `docs/EVENT-CATALOG.md`.
**Đánh đổi:** Đổi tên kiểu làm subscription cũ trên DB đang chạy không khớp nữa — seed đã đổi, DB cũ phải sửa qua dashboard/API (đã làm trên docker local). Validator chặt (từ chối cả khoá lạ) nên payload thiếu trường bắt buộc (vd GitHub push không có `repository.html_url`) thành lỗi normalize thay vì đi tiếp; sửa adapter rồi renormalize. Thiếu thời gian giao dịch (PayOS/SePay) thì dùng thời điểm nhận thay vì từ chối.

## ADR-060 — Subscription khớp theo mẫu: wildcard đuôi `.*` và `*`, truy vấn bằng danh sách ứng viên (S3-3, 2026-10-10)

**Vấn đề:** `eventTypes` chỉ khớp chính xác (`has`), nên muốn nhận mọi sự kiện thanh toán phải liệt kê từng kiểu; seed còn kiểu ma `order.paid`; API nhận chuỗi bất kỳ.
**Chọn:** Ngữ pháp `^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$` (`*` một mình hợp lệ, wildcard chỉ ở đuôi, khớp nhiều cấp), validate ở POST/PATCH → 400 `invalid_event_pattern`. Định tuyến sinh ứng viên từ kiểu event (`a.b.c` → `a.b.c, a.b.*, a.*, *`, hàm thuần `libs/common/src/event-pattern.ts`) rồi `eventTypes && candidates` — một truy vấn, không quét subscription trong bộ nhớ. Seed: Telegram `['payment.*']`, Shop `['payment.received']`, bỏ `order.paid`.
**Đánh đổi:** Không hỗ trợ wildcard giữa/đầu (`*.paid`) — đủ cho catalog phân cấp, giữ truy vấn dùng chỉ mục được. `--sync-destinations` không sửa subscription: DB đang chạy phải đổi qua dashboard/API. Subscription cũ có mẫu sai ngữ pháp vẫn chạy (chỉ chặn lúc tạo/sửa).

## ADR-061 — Metrics: hub-api qua Nest `/metrics`, worker qua http server tối giản; Grafana provisioning trong repo; k6 có script (S3-4, 2026-10-10)

**Vấn đề:** `/metrics` trả 404, Grafana không có dashboard, k6 không có script (BB09 công cụ) — các con số trong phụ lục không kiểm lại được.
**Chọn:** `prom-client` với registry riêng mỗi tiến trình, đếm trong bộ nhớ (0 lệnh Redis). hub-api: `GET /metrics` không JWT, có `METRICS_TOKEN` (Bearer, timingSafeEqual) cho deployed; `hub_ingest_requests_total{provider,outcome}` (nhãn `provider` chỉ nhận provider đã đăng ký → path lạ thành `unknown`, chống nổ cardinality), `hub_ingest_duration_seconds` (5ms…1s). hub-worker: `http.createServer` trên `WORKER_METRICS_PORT` (9101, `0` = tắt, compose chỉ `expose`): `hub_deliveries_total`, `hub_delivery_duration_seconds`, `hub_circuit_transitions_total` (chỉ đếm khi worker này ghi được lần đổi), `hub_outbox_lag_seconds` (đo trong câu SELECT của relay), `hub_normalize_retries_total`, `hub_normalize_schema_errors_total`. Prometheus `v3.14.0`, Grafana `13.2.2` (ghim), datasource + dashboard 6 panel provisioning từ `infra/grafana/provisioning`. `k6/ingest-github.js` (ramping-arrival-rate 10→50→100 RPS, ký HMAC đúng bytes, event `k6_load` không khớp subscription nào). Trần ingest `INGEST_RATE_LIMIT_PER_MIN` (mặc định 100) để nâng khi đo.
**Đánh đổi:** Metric theo tiến trình — nhiều instance thì Prometheus phải scrape từng instance (local chỉ 1). Counter reset khi restart (dùng `rate()`/`increase()`). Dashboard sửa trên UI không được lưu (repo là nguồn sự thật). Lag outbox chỉ cập nhật khi relay chạy lượt.

## ADR-062 — Ngân sách Redis R1: ≤ 4 lệnh cố định/sự kiện + ≤ 2/delivery, đếm bằng test; rate limit ingest một EVAL (S3-5, 2026-10-10)

**Vấn đề:** CLAUDE.md/DEPLOYMENT.md hứa "≤ 4 lệnh Redis/sự kiện" nhưng không ai đếm; đo theo code 10/10 là 8–11 lệnh (1 đích), 13–17 (2 đích). Một sự kiện toả ra N đích thì không thể ≤ 4 cố định.
**Chọn:** Admin chốt R1: định nghĩa lại thành "≤ 4 cố định (ingest + normalize) + ≤ 2 mỗi delivery". Rate limit ingest gộp INCR+EXPIRE thành MỘT `EVAL` Lua (cùng kiểu circuit/throttle, ADR-054). Kết quả đường thành công: ingest 3 (EVAL, GET, SET NX) + normalize 1 (PUBLISH) + delivery 2 (MGET, PUBLISH) → 1 đích = 6, 2 đích = 8. `apps/hub-api/test/redis-budget.spec.ts` thay mọi client ioredis của api lẫn worker bằng Proxy đếm lệnh và `expect` đúng chuỗi lệnh từng chặng. Giữ GET idem (không làm R2). Quota Upstash free hiện tại 500K lệnh/tháng ≈ 2.700 sự kiện/ngày (1 đích).
**Đánh đổi:** Ngân sách giờ tỉ lệ với số đích — fan-out lớn vẫn đắt; chỉ đường thành công được khoá bằng số chính xác (lỗi/throttle/circuit có lệnh thêm, ghi trong DEPLOYMENT §5.2). Test dùng Redis giả nên không đếm lệnh nền (pub/sub adapter, PING health).

## ADR-063 — Tài liệu nói đúng điều code làm: fixed window, không jitter ở retry, DLQ nguồn sự thật là Postgres, SePay là API key (S3-6, 2026-10-10)

**Vấn đề:** ARCHITECTURE.md và phụ lục nộp đi mô tả token bucket, jitter ±20% ở retry, DLQ broker, "tự cảnh báo Telegram", "5 lớp chống trùng" kiểu cũ, `payment.succeeded`/`bank.transfer.*` — code không làm như vậy (BB09 câu 1, 5, 6).
**Chọn:** Sửa tài liệu theo code, không sửa code theo tài liệu: ARCHITECTURE §3.1–3.3, §4, §5.1–5.4b, §7.1–7.2, §8, §11 viết lại; thêm §5.4c "Cố tình không làm" (jitter tầng retry, token bucket, DLQ broker làm nguồn sự thật, tự cảnh báo). Xoá chữ "token bucket" khỏi comment code. `.env.example` thêm biến vận hành. `PHU-LUC-SUA.md` liệt kê câu cũ → câu mới → bằng chứng; Admin tự sửa .docx.
**Đánh đổi:** Tài liệu thừa nhận giới hạn (không jitter, tự cảnh báo chưa có, polling chưa dùng được cho BE ngoài) — hội đồng sẽ thấy, nhưng mỗi câu đều có lệnh kiểm; đổi lấy việc không còn câu nào "đúng một phần".

## ADR-064 — Circuit + throttle trong một `EVAL`: đường delivery ≤ 2 lệnh Redis kể cả khi đích có throttle (review SPEC-3 #2, 2026-10-10)

**Vấn đề:** Review đo `redis-cli MONITOR`: 1 sự kiện SePay tới 2 đích có `rate_limit_rps` tốn 10 lệnh (MGET + EVAL throttle + PUBLISH mỗi đích), vượt R1 (ADR-062) cho phép 8. Đích seed đều có throttle nên đây là đường nóng thật, không phải ngoại lệ.
**Chọn:** `CircuitBreakerService.getState(destinationId, rateLimitRps)`: đích không throttle vẫn một `MGET`; đích có throttle dùng một script `LUA_STATE_AND_THROTTLE` (GET `:open`, GET `:failures`, rồi INCR+EXPIRE khoá throttle **chỉ khi CLOSED**) và trả `throttleAllowed`. Delivery consumer không gọi `checkThrottle` riêng nữa. Đo lại: 2 đích có throttle = 8 lệnh client (eval, get, set, publish, eval×2, publish×2). `redis-budget.spec.ts` có ca `rateLimitRps>0`.
**Đánh đổi:** OPEN/HALF_OPEN không tiêu RPS (đúng ý: message đó không gửi theo đường thường); probe HALF_OPEN không qua throttle (chỉ một request). Throttle tăng bộ đếm trước khi biết lease/`processed_messages` có cho gửi không — một message trùng có thể "ăn" một suất RPS (như trước). Con số giả định Upstash tính một `EVAL` là một lệnh — **chưa xác nhận** từ tài liệu Upstash (DEPLOYMENT §5.2).

## ADR-065 — Outbox relay theo lô: confirm theo lô, một UPDATE `ANY`, lô đầy chạy ngay (review SPEC-3 #3, 2026-10-10)

**Vấn đề:** Relay lấy 50 dòng mỗi ~500ms, publish tuần tự chờ từng confirm, UPDATE từng dòng → trần ~100 dòng/s. Mỗi webhook có ≥ 2 dòng outbox (event.received + delivery.requested), nên ở 100 RPS backlog dồn: k6 đo lag lớn nhất 43,2s (p95 trễ publish 41,4s).
**Chọn:** `RELAY_BATCH = 200`; trong cùng transaction `FOR UPDATE SKIP LOCKED`: publish cả lô không chờ, `Promise.all` các callback confirm, rồi một `UPDATE … WHERE id = ANY($ids::bigint[])`; lô đầy thì `scheduleNext(0)`. Giữ nguyên: an toàn nhiều instance (SKIP LOCKED), không đánh dấu khi chưa confirm đủ, nack một message → rollback cả lô (at-least-once như cũ). Đo lại cùng kịch bản (k6 10→50→100 RPS, mỗi bậc 20s, 1 đích mock): lag lớn nhất 0,65s, p95 0,55s; 0 delivery bị gửi thành công hai lần.
**Đánh đổi:** Lỗi một message làm cả lô 200 dòng publish lại (nhiều bản trùng hơn trước khi broker chập chờn — consumer đã chống trùng). Transaction giữ khoá tới khi cả lô được confirm (vẫn trong timeout 15s). Lô đầy chạy liên tục có thể giữ một connection DB lâu hơn khi backlog lớn.

## ADR-066 — Compose tự seed khi DB trống; subscription Telegram seed mặc định TẮT trên local (review SPEC-3 #7, 2026-10-10)

**Vấn đề:** `docker compose up` trên volume sạch không seed (thiếu `RUN_SEED`), người kiểm phải chạy tay `docker-entrypoint.sh seed`. Bật seed tự động lại kéo theo subscription Telegram `payment.*` bật sẵn — `.env` local có token thật nên mọi stack mới sẽ gửi Telegram thật ngay sự kiện thanh toán đầu tiên.
**Chọn:** Compose đặt `RUN_SEED=${RUN_SEED:-true}` cho hub-api; seed vốn idempotent (đã có source → bỏ qua, không tạo thêm/ghi đè/xoá). `seedTelegramActive(env)`: `SEED_TELEGRAM_ACTIVE` đặt rõ thì theo nó; không đặt thì bật chỉ khi có đủ `TELEGRAM_BOT_TOKEN` (không phải mock) và `TELEGRAM_CHAT_ID`. Compose đặt `SEED_TELEGRAM_ACTIVE=${SEED_TELEGRAM_ACTIVE:-false}` → local mặc định TẮT dù `.env` có token. Deployed (Render, không dùng compose, không đặt `RUN_SEED`) giữ nguyên: không tự seed.
**Đánh đổi:** Muốn demo Telegram thật trên local phải bật tay (PATCH `isActive=true` hoặc `SEED_TELEGRAM_ACTIVE=true` trước khi seed). Seed chỉ xét bảng `sources` — DB có source nhưng thiếu đích/subscription sẽ không được bù (dùng `--sync-destinations` hoặc dashboard).

## ADR-067 — Quy trình kiểm chứng: 5 tầng, stack `hubv` tách biệt, probe phá có chủ đích, CI bắt buộc (2026-10-10)

**Vấn đề:** Test rải ở 5 spec, không có lệnh chung. `RUN_DB_TESTS` quên đặt thì 30 test skip mà jest vẫn xanh. Test DB chạy bằng superuser nên test RLS sau AU6 sẽ pass vô nghĩa. Review bị cấm restart docker (stack dùng chung) nên các kịch bản BB-3 chỉ "✅ một phần". Bốn kịch bản demo giành thứ tự. Chưa có CI. Admin: "chỉ mô phỏng sau khi dev xong thì chưa chắc chắn, viết cả luồng cho dev agent test", và chọn có CI (theo Murat).
**Chọn:** `_bmad-output/planning-artifacts/verification/SPEC-verification.md`, story VF1–VF8, khoảng 26 giờ:
- `verify` L0 unit → L1 db → L2 e2e → L3 chaos → L4 perf (chỉ local); skip > 0 ở L1 là đỏ; bánh cóc số test.
- Stack compose `-p hubv` tách khỏi stack dev, được phép kill.
- Test dùng hai role: owner chỉ để dựng fixture, `hub_app` cho code đang được test.
- Mã test `[AU:UA12]` cùng `verify:map` sinh `docs/TEST-MAP.md`.
- Bộ giả lập `tools/hub-sim` ký độc lập, không import code hub; fixture vàng ghi một lần từ sandbox, phát lại bytes nguyên bản (ký lại khi provider có timestamp).
- Vòng đời story RED → GREEN → GATED → PROBED → REVIEWED (phiên khác); probe phá có chủ đích trong worktree tạm.
- GitHub Actions: `unit` + `db` mọi push, `e2e` khi PR/nightly, `chaos` nightly.
- Một kịch bản demo ba hồi (đăng ký → gãy rồi tự lành → thật và cô lập), thay thứ tự ở ARCHITECTURE §12.

**Đánh đổi:** Thêm khoảng 26 giờ; VF1, VF2, VF7 (9,5 giờ) không được cắt. Admin chốt repo **public**: CI không giới hạn phút, e2e chạy mọi push, nhưng phải có gitleaks trên toàn lịch sử và xoay secret nếu từng lộ. Admin tự tay chuyển khoản PayOS khi demo. Driver `MAIL_DRIVER=capture` và `fake-github` là mã chỉ dành cho test, có assert khởi động chặn ở production. Đã bác: để hub tự ký để mô phỏng ("hub tự đồng ý với chính hub"); tự động chạy lại test chập chờn; đo p95 trên CI.

## ADR-068 — Stack `hubv`: ghi đè bằng `!reset`/`!override`, AMQP 15673, sink nhận thử riêng, chờ healthy không dùng `--wait` trần (VF1, 2026-10-10)

**Vấn đề:** Compose GỘP `ports` của hai file (hubv sẽ chiếm luôn 5433/4000 của dev) và không bỏ được `container_name` bằng ghi đè thường. Spec §4.1 đặt AMQP hubv ở 15672 — trùng cổng UI RabbitMQ của stack dev (đã thấy `port is already allocated`). `up --wait` coi one-shot `rabbitmq-init` "exited (0)" là lỗi. Web nhúng `HUB_API_URL` lúc build (mặc định API dev). SPEC đa service §7.0 bảo tự dựng echo.js ngoài compose.
**Chọn:** `docker-compose.verify.yml` dùng `container_name: !reset null` và `ports: !override` (Compose ≥ 2.24). Cổng hubv = dev + 10000, riêng AMQP **15673**, sink 14100. `verify:up` = `up -d --build` → `up --wait` chỉ các service chạy lâu → kiểm `rabbitmq-init` exit 0 → chờ `/health` → seed. Prometheus/Grafana chỉ khi `VERIFY_WITH_METRICS=1`; web chỉ khi `VERIFY_WITH_WEB=1` (VF4 xử lý URL). Service `sink` (`tools/verify-sink`, không import code hub) trả challenge, ghi mọi request, `GET/DELETE /_requests`, `?mode=fail|slow` (DINH-CHINH-AUTH §8 #6). `.env.verify` chỉ có `VERIFY_ONLY_…`, đích Telegram/Discord trống → `/mock/*`; script từ chối chạy nếu khác, và xoá biến shell trùng tên trước khi gọi compose. hub-api/hub-worker thoát nếu `NODE_ENV=production` gặp `VERIFY_ONLY_…` hoặc `MAIL_DRIVER=capture`.
**Đánh đổi:** Cổng AMQP lệch quy tắc +10000 (ghi lại để spec sửa). Seed hubv vẫn là seed hiện có (1 tenant, `src_*_main`), chưa phải thế giới §4.4: chờ S12/AU1, gộp chung, không tạo `cafe`/`bookstore` theo khuôn riêng. hubv build image riêng (`hubv-*`), dùng chung cache nên tránh hai phiên `--build` cùng lúc.

## ADR-069 — Runner L0/L1 chia theo file, bánh cóc theo tầng, mã test có "mồ côi có lý do" và "xong ở spec khác" (VF2, 2026-10-10)

**Vấn đề:** Ba file test trộn unit với khối Postgres/Redis (`circuit-breaker`, `timeseries`, `delivery-lease-sweeper`); nếu tách theo khối thì L1 phải lọc `-t` và jest báo phần còn lại là skip, làm hỏng luật "skip > 0 ở L1 = đỏ". Spec gốc không ghi mã nào thuộc story nào (trừ S14), lõi S14 (U34–U45, U50) đã làm dưới tên S3-2 nên story S14 chưa `[x]`. Nhiều dòng REVIEW-CHECKLIST kiểm bằng docker/grep/tài liệu, không có test jest.
**Chọn:** File dùng `describeDb` (helper duy nhất `libs/database/test/support/test-db.ts`, cũng là chỗ duy nhất được `new PrismaClient(`) là file **L1**, chạy nguyên file với `RUN_DB_TESTS=1`; còn lại **L0**. Hai tầng chia hết, không đếm trùng. L1 không kết nối được Postgres/Redis thì runner không gọi jest mà tính toàn bộ là skip → đỏ (VT1). Runner luôn `--maxWorkers=2`; chỉ `VERIFY_JEST_WORKERS` (CI) ghi đè; `npm test` cũng gắn `--maxWorkers=2`. Bánh cóc `verify/baseline.json` theo tầng: giảm chỉ được khi commit có `Verify-Baseline: giảm N vì … ADR-xxx` (hoặc `VERIFY_BASELINE_NOTE` trước khi commit). `verify/spec-sources.json` khai nguồn mã bằng regex, nhóm story → mã, `doneOverrides` (MS:U34–U45, U50 ← AF:S3-2) và `acceptedOrphans` (mã xong nhưng kiểm bằng docker/tài liệu, bắt buộc ghi lý do, luôn in ra). Mã chưa có nhóm story chỉ bắt buộc khi mọi story của spec đã `[x]`. Một test được mang nhiều mã (`[MS:U37][AF:#9]`); hai test cùng mã phải có `(phần a/b)`. Kịch bản tự kiểm stack (VT8, VT9) ở `verify/scenarios/`, chạy tay bằng `verify:selftest`.
**Đánh đổi:** Phần unit trong ba file trộn chỉ chạy ở L1 (cần Postgres). Spec nguồn chưa commit (`auth/`, `verification/`) thì `verify:map` đỏ "thiếu file" — phải commit spec trước khi push. AU/MS cần tự thêm nhóm story → mã ở story đầu tiên của mình, nếu không map chỉ bắt mồ côi khi cả spec xong. 9 dòng AF + VT15 là "mồ côi có lý do", chờ VF4/VF5 hoặc CI thật.

## ADR-070 — CI `verify.yml`: unit + db + secrets; grep gác cổng có ngoại lệ ghi lý do; jest bỏ qua worktree trong repo (VF7, 2026-10-10)

**Vấn đề:** §7.3 đòi 0 vi phạm, nhưng code hiện tại có chỗ khớp grep mà không sai: `orderCode` là tên trường của payload PayOS; `PrismaService.rawEvent`/`processedMessage` là lối thoát có tên cho bảng không mang tenant (S1-5); `typeof body.signature !== 'string'` là kiểm kiểu, không so sánh bí mật. Agent khác tạo git worktree trong `.claude/worktrees/` dưới repo, jest thấy hai bản `@hub/*` và 34 suite chết. gitleaks toàn lịch sử ra 3 phát hiện.
**Chọn:** `.github/workflows/verify.yml`: `unit` (gates → L0 → map), `db` (service container postgres:16-alpine + redis:7-alpine → `migrate deploy` → L1), `secrets` (gitleaks v8.18.4 ghim, `fetch-depth: 0`). Trigger `push` + `pull_request` (không `pull_request_target`), `concurrency` huỷ lượt cũ, `paths-ignore` md/docs/_bmad-output, `permissions: contents: read`. `VERIFY_JEST_WORKERS` chỉ CI đặt. Gate ở `verify/lib/gates.ts` (12 luật, `npm run verify:gates`): luật giữ nguyên độ chặt, chỗ khớp hợp lệ vào `exceptions` theo (file, regex dòng) kèm lý do và luôn được in; luật chữ ký chỉ bỏ `typeof … === '<kiểu>'` và `=== null/undefined`; luật test-only bỏ dòng chú thích. Mọi chuỗi mẫu trong gate/test được ghép để gate không tự khớp chính nó. `jest.config.js` bỏ qua `<rootDir>/.claude/`.
**Đánh đổi:** Job `e2e`/`chaos` để VF8 (chưa có runner L2/L3). Chưa có bước tạo role `hub_app` (AU6 thêm). Khi đẩy lên, `unit` sẽ đỏ ở `verify:map` nếu chưa commit `auth/SPEC-auth.md` và `verification/SPEC-verification.md`, và `secrets` sẽ đỏ vì 3 phát hiện cũ (đều là giá trị ví dụ trong spec: `whsec_` base64 của "testtest…", `bank_secret_123`) cho tới khi Admin quyết định allowlist có fingerprint hay sửa — phiên này KHÔNG tự viết lại lịch sử, KHÔNG tự thêm allowlist. Bảo vệ nhánh `main` do Admin bật tay.

---

## ADR-071 — Project + API key trong schema; khoá ngoại ghép subscription→đích; `events.seq` cho polling; bigint ra JSON là chuỗi (S1 đa service, 2026-10-11)

**Vấn đề:** `tenant_id` chưa có bảng gốc, chưa có danh tính cho service, subscription chỉ được chặn trỏ sang đích của project khác bằng code (S1-5) — quên một chỗ là lọt. Polling cần cursor có thứ tự (ULID sinh ở nhiều worker trong cùng ms thì không). Thêm cột BIGINT làm mọi response có event ném `TypeError: Do not know how to serialize a BigInt`.
**Chọn:** Migration `20261011000000_projects_api_keys`: bảng `projects` (id = tenant_id, chèn sẵn project `default` = DEFAULT_TENANT_ID) và `api_keys` (chỉ lưu `sha256(key)` hex — key 256 bit entropy nên không cần bcrypt, tra bằng index unique; `key_prefix` 12 ký tự để hiển thị). `projects` là bảng gốc nên đọc/ghi qua escape hatch có tên trên `PrismaService` (`listProjects`, `findProjectById`, `findProjectBySlug`, `createProject`, `findApiKeyByHash`); `api_keys` mang `tenant_id` nên CRUD qua repo (`createApiKey`, `findApiKeys` — không bao giờ select `keyHash`). Khoá ngoại GHÉP `subscriptions(destination_id, tenant_id) → destinations(id, tenant_id)` thay FK đơn, giữ `ON DELETE RESTRICT` (ADR-054). `events.seq BIGSERIAL UNIQUE` + index `(tenant_id, seq)`, `events.source_id` (backfill từ raw_event). Cột mới của S5–S8 thêm luôn (`sources.verification_config`, `destinations.verification/verified_at/verification_error` default VERIFIED, `subscriptions.source_ids uuid[]` default rỗng, enum `generic`, `api`). `installBigIntJson()` gọi đầu `bootstrap()` của hub-api và hub-worker: bigint → chuỗi JSON.
**Đánh đổi:** Dữ liệu bẩn (subscription trỏ đích tenant khác) làm migration ĐỎ thay vì tự sửa — chủ ý, không âm thầm xoá. Chưa có FK `tenant_id → projects` ở các bảng nghiệp vụ (test L1 tạo tenant ngẫu nhiên; AU6 bật RLS sẽ cân nhắc). Bigint ra chuỗi là quy ước toàn cục, client phải so cursor như chuỗi số.

---

## ADR-072 — Console project/API key: `?projectId=` đọc ở MỘT guard; lỗi kiểm đầu vào 422 có tên trường; key `shop` seed lấy từ env để compose tự nối (S2 đa service, 2026-10-11)

**Vấn đề:** Admin env (operator, ADR-056) cần quản lý nhiều project trong khi dashboard cũ không gửi `projectId`; AU3 sẽ thay bằng membership nên việc đọc `projectId` không được rải khắp controller (X2). Shop phải có key của chính nó ngay khi `docker compose up` trên volume mới, nhưng key sinh ngẫu nhiên trong seed thì không truyền được sang container shop.
**Chọn:** `ProjectScopeGuard` (`apps/hub-api/src/modules/console/project-scope.guard.ts`) chạy sau `JwtAuthGuard` trên toàn `ApiController`: không có `?projectId=` → giữ tenant của JWT (project `default`); có → project phải tồn tại (404 `{error:"not_found"}`), rồi đặt `request.tenantId`. `ProjectsController` (`/api/v1/projects`, `/api/v1/projects/:projectId/keys`): tạo project/key kiểm đầu vào → 422 `{error:"validation_failed", field, message}`, trùng slug → 409 `{error:"slug_taken"}`, revoke idempotent 204 (audit chỉ ghi khi thật sự đổi). Audit `project.created`, `api_key.created`, `api_key.revoked` cùng transaction. Seed tạo key `shop` (`manage:endpoints`, `read:events`) từ `SEED_SHOP_API_KEY` nếu có (compose truyền cùng giá trị cho shop qua `HUB_URL` ở S11), không có thì sinh ngẫu nhiên và in `HUB_URL=…` đúng một lần.
**Đánh đổi:** Route console cũ (S3-3) vẫn trả 400 cho lỗi pattern, route mới trả 422 — hai quy ước song song cho tới DX1. Compose có giá trị key mặc định CHỈ cho local (giống `HUB_SIGNING_SECRET` mặc định); production không chạy seed. `.env.verify` chấp nhận dạng `hk_test_VERIFY_ONLY_…` và assert production chặn luôn dạng này.

---

## ADR-073 — `ApiKeyGuard`: 401 → 404 → 403, so slug của project GẮN VỚI KEY, principal `{kind:'key'}`, `lastUsedAt` ≤ 1 lần/phút trong bộ nhớ (S3 đa service, 2026-10-11)

**Vấn đề:** `/v1/p/:project/*` không được lộ project nào tồn tại (U22), không được tốn Redis (R1, X9), và phải cắm được vào `@RequireScope` dùng chung với user ở AU3 (X13).
**Chọn:** Guard parse `Bearer hk_(test|live)_…` → `sha256` → `findApiKeyByHash` (escape hatch kèm project). Sai/thiếu/revoke → 401 `{error:"invalid_api_key"}`. Rồi so `key.project.slug` với `:project` — KHÔNG tra project theo slug của path, nên "project khác tồn tại" và "không tồn tại" đi cùng một nhánh code, cùng body `{error:"not_found"}`. Thiếu scope → 403 `{error:"missing_scope", required}`. Gắn `request.principal = {kind:'key', id, tenantId, scopes, serviceName}`, `request.tenantId`, `request.apiKey`. `lastUsedAt` ghi bất đồng bộ tối đa 1 lần/phút/key/tiến trình.
**Đánh đổi:** Mỗi request 1 truy vấn DB theo index unique (không cache, để revoke có hiệu lực ngay). Nhiều instance hub-api thì `lastUsedAt` có thể ghi N lần/phút. Key thô dài bất thường (>128 ký tự sau tiền tố) bị coi như sai định dạng.

---

## ADR-074 — `POST /v1/p/:project/events` đi qua `persistAccepted` dùng chung với `/hooks`; source `api` tạo kèm key; 202 khi đã COMMIT (S4 đa service, 2026-10-11)

**Vấn đề:** Service tự phát sự kiện phải có cùng bảo đảm như webhook (BB-2 trọng tài Postgres, BB-3 không 2xx trước COMMIT, outbox cùng transaction, `trace.ingested`, ≤ 4 lệnh Redis) mà không nhân bản code transaction và không thêm `if (provider === 'api')` vào lõi.
**Chọn:** Tách bước 5–7 của `IngestService` thành `persistAccepted(source, req, idempotencyKey, correlationId, stored)` (GET idem → transaction raw_event ACCEPTED + outbox `event.received` → SET SAU COMMIT); `/hooks` và `publishFromService` cùng gọi nó và cùng bọc bởi `traced()` (metric + `trace.ingested`). `ApiAdapter` (đăng ký registry như mọi provider): `verify()` luôn false nên `/hooks/api/*` luôn 401; khoá idem `api:<idempotencyKey>`, khoá > 251 ký tự thành `api:sha256:<hex>` để vừa VARCHAR(255). Key có scope `publish:events` được tạo kèm `Source{provider:'api', sourceKey:'api_'+keyId}` trong CÙNG transaction tạo key. Controller kiểm đồng bộ trước khi ghi: `type`/`idempotencyKey`/`data`/`subject` → 422 `validation_failed{field}`; kiểu dành riêng (`payment.*`, `repo.*`) qua `validateCanonical` → 422 `schema_mismatch{field}` (U49). Trả 202 `{eventId:null, rawEventId, duplicate:false}`, trùng → 200 `{duplicate:true}`, source api đã tắt → 409 `source_inactive`.
**Đánh đổi:** Mỗi key publish có source riêng nên chống trùng theo key (hai key cùng project gửi cùng `idempotencyKey` = hai sự kiện); revoke key không tắt source (event cũ vẫn truy được nguồn). `raw_events.origin` vẫn là `webhook` (không thêm giá trị enum). Trần body thực tế là giới hạn mặc định 100KB của body-parser Nest (đúng cho cả `/hooks`), thấp hơn 1MB của SPEC; express trả 413 trước khi tới controller.

---

## ADR-075 — Endpoint/subscription của service qua `/v1/p`; `sourceIds` lọc ở truy vấn ứng viên; hàm repo cũ giữ cho nhánh UI (S5 đa service, 2026-10-11)

**Vấn đề:** Service cần tự đăng ký endpoint + subscription trong project của mình (không qua admin), lọc theo nguồn (`sourceIds`), và không bao giờ trỏ được sang tài nguyên project khác. Nhánh UI Event Flow (X16) đang gọi `findActiveSubscriptionsForEventType` — đổi tên sẽ vỡ khi rebase.
**Chọn:** `ServiceResourcesController` (`POST/GET /v1/p/:project/endpoints|subscriptions`, scope `manage:endpoints`): endpoint = `destinations` type `webhook`, url lưu mã hoá như config cũ, tạo ở trạng thái `PENDING` (S6 chạy challenge), response không bao giờ có trường mã hoá. Subscription: `endpointId` khác project → 404 `{error:"not_found"}` (giống hệt không tồn tại), `eventTypes` sai ngữ pháp → 422 `validation_failed{field:"eventTypes"}` (`*` hợp lệ — X1), `sourceIds` có id lạ/của project khác → 422 `{error:"unknown_source", ids}` — cùng hàm `resolveSourceIds` cho console `/api/v1/subscriptions` (POST + PATCH). Audit `endpoint.create`/`subscription.create`, actor `key:<keyId>`. Repo thêm `findActiveSubscriptionsForEvent(type, sourceId)` = ứng viên wildcard **AND** (`source_ids` rỗng **OR** chứa source); event không rõ nguồn chỉ khớp sub không lọc. Normalize dùng hàm mới và ghi `events.source_id`. Hàm cũ **giữ nguyên tên và hành vi** (spec bảo đổi tên — lệch có chủ ý, ghi DINH-CHINH §7).
**Đánh đổi:** Hai hàm gần giống nhau cùng tồn tại tới khi nhánh UI rebase. Console vẫn 400 cho pattern sai nhưng 422 cho `unknown_source` (cùng mã với `/v1/p`, vì là cùng một hàm). Khoá ngoại ghép (S1) là lưới cuối: `INSERT` thẳng subscription tenant A → đích tenant B bị DB từ chối.

---

## ADR-076 — Standard Webhooks thay `X-Hub-*` (không gửi song song); challenge đồng bộ khi tạo endpoint; link-local luôn bị chặn kể cả ngoài production (S6 đa service, 2026-10-11)

**Vấn đề:** Header `X-Hub-*` tự chế, ký hex, không ai ngoài hub verify được bằng thư viện có sẵn. Endpoint đăng ký qua API có thể là URL của người khác (hub bị dùng để bắn sự kiện vào hệ thống không đồng ý nhận). SSRF guard ngoài production bỏ qua MỌI dải nội bộ — kể cả 169.254.169.254 (metadata đám mây).
**Chọn:** `libs/crypto/src/standard-webhooks.ts` (`swSign`/`swVerify`/`swHeaders`/`generateWhsecSecret`) — MỘT bản cho WebhookSender, challenge, Shop (sau này GenericAdapter, SDK); khớp vector chuẩn README standard-webhooks (U6); secret không có `whsec_` ký bằng utf8 (secret cũ của Shop vẫn chạy). WebhookSender gửi `webhook-id` (= event.id, giữ qua retry/replay) / `webhook-timestamp` / `webhook-signature: v1,<base64>`, xoá hẳn `X-Hub-*`; Shop verify bằng `swVerify` (sai/quá 300s → 401). `EndpointVerifier` (hub-api, 0 lệnh Redis): POST `{type:"endpoint.verification", challenge}` ký Standard Webhooks (`webhook-id` = `verify_<ulid>`), qua SSRF guard có pin IP, không theo redirect, tổng ≤ 10s, đọc ≤ 64KB; kết quả `VERIFIED` hoặc `FAILED` + `timeout|http_<status>|challenge_mismatch|ssrf_blocked|invalid_json|unreachable` (thêm `unreachable` cho từ chối kết nối/DNS — SPEC không có). Tạo endpoint: không truyền secret thì hub sinh `whsec_…` và trả đúng một lần; challenge chạy NGOÀI transaction rồi ghi kết quả + audit `endpoint.verified`/`endpoint.verification_failed`; luôn 201. `POST /v1/p/:project/endpoints/:id/verify` chạy lại (khác project → 404). Normalize không tạo delivery cho đích `webhook` có `verification ≠ VERIFIED` (log info). `isLinkLocalIp` (169.254/16, fe80::/10, cả dạng `::ffff:`) bị chặn ở MỌI môi trường và cả khi `allowPrivate`; dải private thường vẫn được phép khi `NODE_ENV=development` (sink của hubv).
**Đánh đổi:** Phá tương thích với mọi bên nhận đang đọc `X-Hub-*` (chỉ có Shop — sửa cùng commit). Tạo endpoint chậm thêm tối đa 10s (challenge đồng bộ). Endpoint đổi URL không có API sửa ở `/v1/p` (tạo mới hoặc `/verify` lại). Endpoint FAILED vẫn tồn tại, không tự thử lại.

---

## ADR-077 — Polling (A) theo `seq`, cửa sổ lắng 2s theo cột mới `events.created_at` (lúc INSERT); dashboard `before`/`after`; retention xoá events, giữ raw ACCEPTED (S7 đa service, 2026-10-11)

**Vấn đề:** Service cần lấy lại sự kiện khi endpoint chết (polling/long-poll) mà không lặp, không sót. `seq` cấp lúc INSERT nhưng transaction có seq nhỏ có thể COMMIT sau transaction seq lớn — đọc ngay thì cursor vượt qua và mất vĩnh viễn sự kiện đó. SPEC lọc theo `received_at`, nhưng cột này là lúc hub NHẬN raw event (retry normalize/renormalize INSERT muộn hàng phút–ngày) nên không bảo vệ gì. `after` của dashboard đang mang nghĩa "cũ hơn id X".
**Chọn:** Migration `20261011010000_events_created_at`: `events.created_at` DEFAULT `clock_timestamp()` (thời điểm INSERT thật, không phải `now()` = đầu transaction), dòng cũ backfill bằng `received_at`. `TenantScopedRepository.pollEvents` (SQL thô, scope tenant): `seq > after AND created_at <= clock_timestamp() - 2s`, `types` và `readTypes` của key là hai điều kiện AND (mẫu như subscription: `*`, `a.*` = `starts_with`, chính xác), `status=failed` = có delivery DEAD/RETRYING ở generation MỚI NHẤT của cặp (event, subscription) [tới `endpointId`], `ORDER BY seq LIMIT`. `GET /v1/p/:project/events` (scope `read:events`): seq ra CHUỖI, rỗng thì `nextCursor = after`, tham số sai → 422 có tên trường, `endpointId` khác project → 404; long-poll `wait` 0–20s truy vấn lại mỗi 1s, dừng khi `res` đóng (không dùng `req.on('close')` — Node ≥16 phát sự kiện đó ngay khi đọc xong body), 0 lệnh Redis. Dashboard `GET /api/v1/events`: `before=<id>` = trang cũ hơn (hành vi cũ), `after=<seq>` = tăng dần theo seq; `after` không phải số (client cũ) hiểu như `before`; `useEvents` gửi `before`. Retention (DINH-CHINH §3): `EVENT_RETENTION_DAYS` (alias `CLEANUP_RETENTION_DAYS`, mặc định 7), CleanupJob thêm bước xoá `events` có `received_at` quá N ngày theo lô qua escape hatch `PrismaService.deleteExpiredEventsBatch` (xuyên project, cascade deliveries → attempts); KHÔNG đụng raw ACCEPTED (ADR-045); danh sách orphan loại raw cũ hơn N ngày.
**Đánh đổi:** Polling trễ ≥ 2s (đo E2E: publish → long-poll trả về ~5s gồm normalize + lắng + nhịp 1s). Transaction normalize giữ lâu hơn 2s sau INSERT vẫn có thể bị cursor vượt qua (biên an toàn, không phải bảo đảm tuyệt đối). Polling chỉ lấy lại được trong N ngày; bằng chứng gốc giữ vô hạn (đánh đổi dung lượng Neon), renormalize được qua orphans trong N ngày đầu. Mỗi vòng long-poll là một truy vấn DB/giây/kết nối đang chờ.

---

## ADR-078 — `DELIVERY_TIMEOUT_MS` kẹp 1000–10000ms, mặc định 5000 — hướng A cho noisy neighbor, có số đo (S10 đa service, 2026-10-11)

**Vấn đề:** Một đích chậm (ngủ 30s) chiếm slot consumer của MỌI project dùng chung queue delivery; trần gửi gắn cứng 5000ms không chỉnh được khi đo.
**Chọn:** `http-limits.ts`: `SEND_TIMEOUT_MS = resolveSendTimeoutMs(process.env.DELIVERY_TIMEOUT_MS)` — kẹp [1000, 10000], rác/không đặt = 5000, đọc một lần lúc load; đi vào cả `timeout` lẫn `AbortSignal.timeout` (trần TỔNG). Timeout = SendResult 500 + error chứa "timeout" → retryable + `recordFailure` (U28 khoá hành vi), không DEAD. Compose truyền `DELIVERY_TIMEOUT_MS` (mặc định 5000). Số đo T10 trên hubv (40 event vào đích ngủ 30s rồi 20 event vào project khác, prefetch 20, 1 worker): timeout 5000 → trễ project bên cạnh p50 1712ms / p95 2463ms; timeout 10000 → p50 6424ms / p95 7005ms. Cả hai lần: attempt đích chậm `duration_ms` ≈ timeout, 20/20 có "timeout", circuit OPEN sau 5 lỗi, phần còn lại PENDING (hoãn theo circuit).
**Đánh đổi:** Đích hợp lệ nhưng chậm > 10s không bao giờ nhận được. Cô lập vẫn là "mềm" (giới hạn bởi timeout × số slot); cô lập cứng (semaphore theo endpoint / queue theo project) là hướng phát triển, ngoài phạm vi đợt này.

---

## ADR-079 — GenericAdapter: cấu hình theo source qua `AdapterContext`, thiếu khoá chống trùng = 422 + REJECTED, header bí mật do adapter khai, mapping cấp một ra kiểu chuẩn (S8 đa service, 2026-10-11)

**Vấn đề:** Service cần nhận webhook từ bên thứ ba hub chưa có adapter (ngân hàng nội địa, SaaS nhỏ) mà không sửa lõi và không viết code — đúng luận điểm "thêm provider = một adapter + registry". Ba rủi ro: lõi bị kéo vào `if (provider === 'generic')`; token static nằm ở header tuỳ ý (`x-token`) lọt vào `raw_events` vì `redactHeaders` chỉ biết danh sách cố định; thiếu khoá chống trùng mà fallback ulid thì provider gửi lại = hai sự kiện (phá BB-2).
**Chọn:** Interface thêm tham số tuỳ chọn `ctx: AdapterContext {verificationConfig}` cho `verify` / `extractIdempotencyKey` / `extractSignature` và `context.verificationConfig` cho `normalize`; lõi chỉ chuyển `sources.verification_config` qua (ingest đọc từ source đã nạp; normalize nạp CÙNG truy vấn raw_event, 0 query thêm). 4 adapter cũ bỏ qua. Hook tuỳ chọn `sensitiveHeaders(ctx)` — lõi che thêm các header này trước khi lưu (static-token). `IdempotencyKeyMissingError` là lỗi CHUNG: lõi lưu raw_event REJECTED với `signature_valid = true` (để chế độ lắng nghe phân biệt với sai chữ ký) và trả 422 `{error:"missing_idempotency_key"}`; không fallback. `GenericAdapter`: `hmac-sha256` (hex|base64, `prefix`, trên `rawBody`), `static-token`, `standard-webhooks` (lib dùng chung ADR-076), thử mọi secret (xoay secret), so bằng timingSafeEqual không dừng sớm; khoá `generic:<header|body[field]>` (chuỗi hoặc số); cấu hình được kiểm LẠI mỗi lần dùng (DB hỏng → verify false, không bao giờ nhận bừa). `mapping` (§4.14.4) chỉ cho `payment.*`: giá trị là tên trường cấp một hoặc `{const}`; thiếu trường bắt buộc → `MappingFieldMissingError` (chỉ tên trường) = lỗi normalize vĩnh viễn; số tiền có dấu phân cách bị validator từ chối. `parseSourceInput` dùng chung cho console `/api/v1/sources` và `POST/GET /v1/p/:project/sources` (scope `manage:sources`, response không bao giờ có secret): provider ∉ {github, payos, sepay, stripe, generic} (gồm `api`) → 422 field `provider`; lỗi config → 422 field `verificationConfig.<đường dẫn>`.
**Đánh đổi:** Không JSONPath / không trường lồng nhau / không biến đổi giá trị — nguồn có payload lồng nhau phải dùng `normalized:false` (`data.raw`) hoặc chờ adapter riêng. Mapping chỉ miền thanh toán. Console `POST /api/v1/sources` đổi từ "nhận gì lưu nấy" sang 422 có tên trường (UI phải gửi đúng provider). Một request thiếu khoá vẫn tốn một dòng REJECTED (trong trần 20/phút/source).

---

## ADR-080 — Chế độ lắng nghe: `diagnose()` chạy trên raw_event ĐÃ LƯU, không cần secret, chỉ trả tên (S9 đa service, 2026-10-11)

**Vấn đề:** Dev cấu hình GenericAdapter sai (tên header, khoá chống trùng, trường ánh xạ) chỉ thấy 401/422 mà không biết vì sao. Chẩn đoán bằng cách tính lại chữ ký thì cần secret và header gốc — mà header nhạy cảm đã bị che trước khi lưu (ADR-051/079), và trả giá trị ra ngoài là lộ bí mật.
**Chọn:** Hook tuỳ chọn `diagnose(raw, ctx)` trên adapter (không cài → lõi trả `{ok: signatureValid}`). GenericAdapter suy từ những gì ĐÃ LƯU: REJECTED + `signature_valid=true` → `missing_idempotency_key` (+ `expectedField|expectedHeader`); REJECTED khác → thiếu header đã cấu hình → `missing_header` + `candidateHeaders` (tên header có `sig|token|auth|hmac|key`, không giá trị), có header → `signature_mismatch` / `token_mismatch`; standard-webhooks: header thiếu → `missing_header`, `webhook-timestamp` lệch > 300s so với `received_at` → `timestamp_out_of_range`; ACCEPTED có `mapping` → chạy lại ánh xạ + validator trên body đã lưu → `mapping_field_missing` / `mapping_field_invalid` + TÊN trường body. `GET /v1/p/:project/sources/:id/inspect?since=` (scope `manage:sources`): 10 raw_events mới nhất của source (`received_at >= since`, scope qua `source.tenant_id`), source khác project → 404, `since` sai → 422.
**Đánh đổi:** Không phân biệt được "sai secret" với "sai encoding/prefix" (cả hai là `signature_mismatch`) — muốn vậy phải giữ secret trong luồng chẩn đoán. Raw REJECTED chỉ có mẫu ≤4KB và tối đa 20/phút/source (S1-4) nên lúc bị dội có thể thiếu dòng để chẩn đoán.

---

## ADR-081 — `@hub/sdk` không phụ thuộc runtime, che key bằng private field; Shop thành service thật tự `endpoints.ensure`, seed không tạo đích Shop (S11 đa service, 2026-10-11)

**Vấn đề:** Shop (đại diện "service của dev") đang được seed tạo sẵn đích + subscription — không chứng minh được dev bên ngoài tự nối vào hub. SDK chạy trong process của khách hàng: key lộ qua `console.log(client)`, log lỗi hay JSON là sự cố bảo mật phổ biến nhất; kéo thư viện hub vào khiến khách phải cài cả Prisma/Nest.
**Chọn:** `libs/hub-sdk` (`@hub/sdk`, workspace mới, paths/jest/Dockerfile/`build:libs`): `createHubClient(hubs://|hub://key@host/project)` dùng `fetch`, `crypto` của Node — 0 dependency runtime; type catalog re-export bằng `export type` (xoá khi biên dịch). Key giữ trong private field `#key`; `toJSON`/`util.inspect.custom` in `hk_live_••••` + 4 ký tự cuối; `HubError{status, code}` không bao giờ chèn message gốc của lỗi mạng (có thể chứa header). `verifyWebhook` tự viết lại Standard Webhooks (đối chiếu vector chuẩn + chữ ký do `libs/crypto` ký), `challengeResponse`. `endpoints.ensure` idempotent: tìm theo url → tạo (truyền `signingSecret`) → chưa VERIFIED thì `/verify` → vẫn không VERIFIED thì ném `endpoint_not_verified` → đảm bảo subscription phủ `eventTypes` + `sourceIds`. Shop: `HUB_SIGNING_SECRET` bắt buộc (thiếu → exit 1), verify MỌI request (kể cả challenge) bằng SDK rồi mới trả `{challenge}`; sau `listen` gọi `ensure({url: SHOP_PUBLIC_URL/hub-webhook, eventTypes:['payment.received']})`, lỗi thử lại 10s × 6, vẫn phục vụ trong lúc chờ. Compose truyền `HUB_URL=hub://${SEED_SHOP_API_KEY}@hub-api:4000/default` + `SHOP_PUBLIC_URL`; seed (cả `verify:seed`) bỏ đích + subscription Shop (X6).
**Đánh đổi:** DB đang chạy vẫn giữ đích "Demo Shop Outbound Webhook" cũ — `ensure` tìm theo URL nên dùng lại nó (không tạo trùng) nhưng không đổi được secret của nó (API không trả secret). Shop khởi động trước hub-api thì phải chờ tối đa 60s mới nhận sự kiện. SDK chỉ cho Node ≥ 18 (`fetch`).

---

## ADR-082 — Seed demo `cafe`/`bookstore` (operator ghi endpoint VERIFIED trực tiếp); L1 dùng `MASTER_KEY` của hubv (S12 đa service, 2026-10-11)

**Vấn đề:** Màn bảo vệ cần hai service độc lập dùng chung hub, dựng lại được y hệt trên volume mới (X5). Endpoint seed không thể qua challenge (hub-api chưa listen lúc seed chạy). Test L1 chạy seed trực tiếp từ host: `seed.ts` nạp `.env` DEV bằng dotenv nên ghi dữ liệu mã hoá bằng `MASTER_KEY` khác hubv — hub-api hubv không đọc được.
**Chọn:** `seedDemoProjects()` (gọi trong `seed()`, idempotent theo slug, tắt bằng `SEED_DEMO_PROJECTS=false`): mỗi project 1 source mock (secret demo cố định, chỉ local), 1 key `<slug>-be` đủ 4 scope + source `api` gắn key (như console, ADR-074), 1 endpoint `<slug>-endpoint` ghi thẳng `VERIFIED` (operator tạo, url là mock của chính stack: `/mock/echo/<slug>` mới thêm ở hub-api ngoài production, hoặc sink hubv qua `DEMO_ENDPOINT_BASE_URL`), subscription `payment.*`, audit `project.created`/`api_key.created`; key + `signingSecret` in log đúng một lần. Runner L1 (`verify/cli/run.ts`) đặt `MASTER_KEY` = giá trị `.env.verify` (ghi đè được bằng `VERIFY_MASTER_KEY`). `scripts/demo-multi-project.sh` + `docs/DEMO-MULTI-PROJECT.md` chạy 6 hồi §7.3.
**Đánh đổi:** Endpoint seed bỏ qua challenge (chấp nhận được vì do operator tạo và trỏ mock nội bộ; endpoint của service thật luôn qua challenge). Key demo chỉ thấy một lần trong log — mất thì tạo key mới. Dữ liệu L1 cũ đã ghi bằng khoá DEV trong hubv không tự sửa (`verify:reset` nếu cần).

---

## ADR-083 — SSRF: mở IPv6 ra 8 hextet trước khi kiểm (ánh xạ/nhúng IPv4, `::`, NAT64); `/verify` 5 lần/phút/endpoint trong bộ nhớ (MS-R1, review đa service pha 1, 2026-10-11)

**Vấn đề:** `isPrivateIp` chỉ so chuỗi `::1`/`fc`/`fd`/`fe8x`: `http://[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[::]`, `[64:ff9b::7f00:1]` lọt ở production; `new URL().hostname` của IPv6 còn ngoặc `[…]` nên `net.isIP` sai và rơi sang DNS. Từ S5/S6, key service (`manage:endpoints`) điều khiển được URL của challenge và đọc lại `http_<status>` / `timeout` / `unreachable` → dò cổng nội bộ, gọi `/verify` lặp vô hạn.
**Chọn:** Bỏ ngoặc ở hostname; `expandIpv6` mở thành 8 hextet (cả đuôi `a.b.c.d`); `::ffff:0:0/96` → kiểm như IPv4; chặn `::`, `::1`, `::a.b.c.d` (IPv4-compatible), `64:ff9b::/96`, `fc00::/7`, `fe80::/10`; IPv4 thêm `100.64/10` (CGNAT); không phân tích được → chặn. `isLinkLocalIp` dùng cùng bộ mở. `/v1/p/:project/endpoints/:id/verify`: `WindowLimiter` 5 lần/60s/endpoint trong bộ nhớ (0 lệnh Redis) → 429 `rate_limited`. Test từng dạng ở `NODE_ENV=production`.
**Đánh đổi:** Giới hạn theo instance (N instance → 5N/phút). Tạo endpoint mới vẫn chạy challenge (giới hạn bởi rate limit chung của hub-api); lý do FAILED vẫn phân biệt `timeout`/`unreachable` — giữ vì dev cần biết vì sao endpoint hỏng, rủi ro dò cổng đã bị chặn ở tầng IP.

---

## ADR-084 — Shop chỉ tin `payment.received` từ source thanh toán thật (`payos`, `sepay`) (MS-R2, 2026-10-11)

**Vấn đề:** Từ khi có `POST /v1/p/:project/events` và GenericAdapter, MỘT key `publish:events` bất kỳ trong project `default` gửi được `payment.received` đúng khuôn (qua validator) có `memo:"DH…"` → đơn Shop thành PAID mà không có tiền.
**Chọn:** `readPayment(body, allowed = SHOP_PAYMENT_SOURCES ?? ['payos','sepay'])` bỏ qua (IGNORED) mọi event có `source` ngoài danh sách. `source` do adapter của hub đặt — đường `/events` luôn là `api`, nguồn tuỳ chỉnh là `generic` — nên publisher không giả được. Không dùng `sourceIds` trong `ensure` vì key `shop` không có `manage:sources` (không liệt kê được id source) và id khác nhau giữa các stack.
**Đánh đổi:** Shop phải đổi env khi thêm cổng thanh toán (vd ngân hàng qua GenericAdapter có mapping). Hub vẫn cho service publish kiểu `payment.*` hợp lệ — bên nhận nào xử lý tiền phải tự kiểm `source` (ghi ở EVENT-CATALOG §5b).

---

## ADR-085 — `/v1/p` subscription chỉ tới endpoint (webhook); push không rộng hơn `readTypes` của key (MS-R3, 2026-10-11)

**Vấn đề:** `POST /v1/p/:project/subscriptions` nhận mọi `destinationId` cùng project — key `manage:endpoints` gắn được đích Telegram/Discord của operator vào `*` (spam kênh admin); `GET` trả cả subscription của operator (lộ id đích). `readTypes` chỉ giới hạn polling nên key `readTypes=["order.*"]` vẫn nhận `payment.*` qua push.
**Chọn:** Đích `type ≠ webhook` → 404 `not_found` (như không tồn tại, cùng khuôn `/verify`, `GET /endpoints`); `GET /subscriptions` lọc `destination.type = webhook`. Key có `readTypes` thì mỗi mẫu trong `eventTypes` phải được một mẫu của `readTypes` phủ (`*` phủ mọi thứ, `a.*` phủ `a.x` và `a.x.*`) — sai → 422 `{error:"outside_read_types", field:"eventTypes", invalid}`.
**Đánh đổi:** Kiểm lúc TẠO subscription; subscription sống độc lập với key (đổi `readTypes` của key sau đó không thu hẹp subscription cũ — key hiện không sửa được scope, chỉ revoke/tạo mới).

---

## ADR-086 — Xoay signing secret của endpoint bằng challenge: `/verify` kèm `signingSecret` chỉ lưu khi endpoint chứng minh được secret mới; `ensure` luôn chứng minh lại (MS-R4, 2026-10-11)

**Vấn đề:** `endpoints.ensure` gặp endpoint đã VERIFIED thì bỏ qua secret: Shop đổi `HUB_SIGNING_SECRET` → hub vẫn ký bằng secret cũ → Shop 401 mọi webhook → retry → DEAD, trong khi log Shop báo "endpoint VERIFIED". API không có cách xoay secret.
**Chọn:** `POST /v1/p/:project/endpoints/:id/verify` nhận tuỳ chọn `{signingSecret}`: challenge ký bằng secret MỚI; endpoint trả đúng challenge (nghĩa là bên nhận đang verify bằng secret mới) → lưu secret mới + VERIFIED + audit `secretRotated`; sai → trả `{verification:"FAILED", verificationError, secretRotated:false}` và GIỮ NGUYÊN secret + trạng thái cũ (key không phá được endpoint đang chạy bằng một secret bậy). SDK `ensure` có `signingSecret` thì luôn gọi `/verify` kèm secret; không VERIFIED → `HubError endpoint_not_verified` kèm lý do (Shop log và thử lại). Không thêm endpoint API riêng.
**Đánh đổi:** Mỗi lần service khởi động là một challenge (trong trần 5/phút/endpoint, ADR-083). Không có cửa sổ hai secret song song: đổi secret ở bên nhận phải kèm chạy `ensure`/`verify` (giữa hai bước, delivery tới đích có thể 401 và retry).

---

## ADR-087 — Vệ sinh sau review pha 1: `api_keys.scopes` NOT NULL, `origin = 'api'` cho sự kiện tự phát, seed không in key; các mục ghi nhận để lại (MS-R5/R6, 2026-10-11)

**Vấn đề:** `api_keys.scopes` nullable → dữ liệu tay NULL làm `key.scopes.includes` ném 500. Raw_event/event của `POST /events` mang `origin:'webhook'` (sai nguồn gốc). Seed in nguyên connection string chứa key ra log container (kể cả khi key lấy từ env) — log tập trung là nơi lộ key phổ biến nhất.
**Chọn:** Migration `20261011020000_ms_r6_scopes_not_null_origin_api`: `scopes`/`read_types` NOT NULL mặc định `{}` (dòng NULL cũ → `{}`), enum `EventOrigin` thêm `api`; `persistAccepted` nhận `origin` (`/events` = `api`), `ApiAdapter` phát event `origin:'api'`. Seed chỉ in prefix 12 ký tự + cách lấy key (`keyCreatedLogLine`); key demo đặt trước được qua `SEED_CAFE_API_KEY` / `SEED_BOOKSTORE_API_KEY`, `scripts/demo-multi-project.sh` tự tạo key qua console khi không truyền. Probe P-MS-S8-01 / P-MS-S11-01 (`verify/probes/`, chạy tay vì runner VF6 chưa có) chứng minh U12 + T9(d) và U32 biết đỏ.
**Để lại (ghi nhận, không làm đợt này):** (a) cửa sổ lắng 2s theo thời gian — thay bằng `pg_snapshot_xmin`/xid là đổi thiết kế polling, cần đo INSERT→COMMIT p99 trước; (b) long-poll không có trần số kết nối chờ — cần số đo pool Neon; (c) delivery đã tạo/replay vẫn gửi khi endpoint chuyển FAILED sau `/verify` — sửa ở worker (kiểm verification lúc gửi) chạm hợp đồng retry; (d) chưa có API nộp/xoay secret source ở `/v1/p`; (e) `CREATABLE_PROVIDERS` + nhánh `generic` ở `source-input.ts` (tầng API, không phải lõi); (f) `/hooks/:provider/:sourceKey` không so `source.provider` với path (không leo thang: vẫn cần secret của source); (g) `ProjectsController.create` gọi `tx.project.create` thay vì escape hatch có tên. Thêm giá trị enum `api` là thay đổi X17 (UI đọc `origin`).

---

## ADR-088 — Seed: thế giới `default` quyết định theo dữ liệu của `default`, seed demo chạy SAU (MS-P2-2, review pha 2, 2026-10-11)

**Vấn đề:** S12 gọi `seedDemoProjects()` TRƯỚC bước "đã seed?" và bước đó đếm source TOÀN DB → trên DB rỗng, source của `cafe`/`bookstore`/`api_*` có trước nên seed chính bỏ qua: project `default` không có source, đích, subscription; smoke 404 ngay sau `verify:reset` / `down -v && up` / deploy DB mới. L1 cũ (`seed-demo-db`) chạy trên DB đã có dữ liệu nên không bắt được.
**Chọn:** `seed()` = project default → key shop → `seedDefaultWorld()` (idempotent theo `source.count({tenantId: default})`) → `seedDemoProjects()`. Test L1 `seed-fresh-db.spec.ts` tạo DB TẠM rỗng, chạy đúng `prisma migrate deploy` + `seed.ts` trong tiến trình con (2 lần), kiểm default có 3 source + 2 đích + 2 subscription và có `cafe`/`bookstore`, rồi DROP DB. `newTestPrisma(role, urlOverride?)` để test trỏ DB tạm mà không `new PrismaClient` ngoài helper.
**Đánh đổi:** L1 chậm thêm ~15s (migrate + seed thật). Default "đã có source" do người dùng tạo tay thì seed default bỏ qua — đúng ý idempotent, không ghi đè.

---

## ADR-089 — Tin theo SOURCE CỤ THỂ, không theo tên provider: subscription ghim `sourceKeys`, Shop `ensure({sourceKeys, exclusive})` (MS-P2-1, 2026-10-11)

**Vấn đề:** MS-R2 lọc theo `event.source` (tên provider). Key có `manage:sources` tự tạo source `sepay` với secret của chính nó rồi ký webhook giả → event `source=sepay` → Shop PAID mà không có tiền (E2E pha 2). Tên provider không phải danh tính; secret mới là danh tính, và secret thuộc về TỪNG source.
**Chọn:** `POST /v1/p/:project/subscriptions` nhận `sourceKeys` (resolve thành id trong project — service biết sourceKey từ URL webhook, không cần `manage:sources`; lạ/khác project → 422 `unknown_source {keys}`); response kèm `sourceKeys`. `PATCH /v1/p/:project/subscriptions/:id {isActive}` (chỉ đích webhook, audit). SDK `ensure({sourceKeys, exclusive})`: ghim nguồn, so subscription theo `sourceKeys`, `exclusive` tắt mọi subscription khác đang bật của endpoint (sub cũ chưa ghim). Shop ghim `SHOP_PAYMENT_SOURCE_KEYS` (mặc định `src_payos_main,src_sepay_main`, source do operator seed) — lọc ở hub (`sourceIds`), bộ lọc `source` ở Shop (ADR-084) giữ làm lớp phụ. KHÔNG chặn key tạo source provider thanh toán: service có thể có tài khoản PayOS/SePay riêng hợp lệ; ghim nguồn làm tên provider không còn quan trọng.
**Đánh đổi:** Đổi/thêm cổng thanh toán của Shop phải đổi env (sourceKey). Tắt subscription cũ là "mềm" (`isActive=false`, lịch sử delivery giữ). Service nào nhận tiền mà không ghim nguồn vẫn tự chịu rủi ro — ghi ở EVENT-CATALOG §5b.

---

## ADR-090 — Client Redis "fail nhanh": không offline queue, `commandTimeout` 300ms, cho mọi client trên đường request/delivery (MS-P2-3, 2026-10-11)

**Vấn đề:** Redis chết thì kết quả vẫn đúng (BB-2) nhưng MỖI request ingest mất 8,6–18,3s: `RedisService` chỉ đặt `maxRetriesPerRequest: 1`, lệnh nằm trong offline queue chờ reconnect. GitHub/Stripe cắt ở ~10s → coi là lỗi → bão retry. Worker (circuit breaker, publish realtime, cleanup lock) có cùng cấu hình.
**Chọn:** `fastFailRedisOptions()` (`libs/common/src/redis-options.ts`): `enableOfflineQueue:false` (chưa kết nối → lệnh lỗi ngay), `commandTimeout` = `REDIS_COMMAND_TIMEOUT_MS` (50–5000, mặc định 300), `connectTimeout` 2000, `maxRetriesPerRequest:0`, reconnect nền. Dùng cho `RedisService` (hub-api), circuit breaker, publisher realtime của normalize/delivery, cleanup. Giữ nguyên client SUBSCRIBE của Socket.IO (cần xếp hàng `subscribe`, không nằm trên đường request). Đo trên hubv với `stop redis`: `/v1/p/cafe/events` 17–44ms (202 rồi 200 duplicate), `/hooks/sepay` 21–22ms; DB đúng 1 raw + 1 event mỗi khoá; bật lại Redis → bình thường ngay.
**Đánh đổi:** Redis chậm thật (>300ms) bị coi như chết cho lệnh đó (fail-open: rate limit mở, đường tắt idem bỏ qua — Postgres vẫn chặn trùng). Lúc khởi động trước khi Redis sẵn sàng, vài lệnh đầu fail-open.

---

## ADR-091 — SSRF chuyển sang ALLOWLIST "global unicast" (thay danh sách chặn) (MS-P2-4, 2026-10-11)

**Vấn đề:** Danh sách chặn (ADR-083) vẫn lọt 192.0.0/24, 198.18/15, multicast 224/4, 255.255.255.255, NAT64 local-use `64:ff9b:1::/48`, 6to4 `2002::/16` (vd `2002:7f00:1::` nhúng 127.0.0.1), `::ffff:0:a.b.c.d`; ở development `[64:ff9b::a9fe:a9fe]` (link-local trong NAT64) đi qua. Blocklist thì luôn thiếu dải mới.
**Chọn:** IPv4: chặn mọi dải đặc biệt IANA (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4) — còn lại là global unicast. IPv6: CHỈ cho `2000::/3`, trừ `2001::/23`, `2001:db8::/32`, `2002::/16`; `::ffff:a.b.c.d` kiểm như IPv4; mọi thứ khác (gồm NAT64 cả hai dải, `::ffff:0:a.b.c.d`, ULA, link-local, multicast) bị chặn. `isLinkLocalIp` (chạy cả ở development) mở IPv4 nhúng trong ánh xạ / NAT64 / 6to4. Không thêm thư viện (`ipaddr.js`): 30 dòng viết tay, có test từng dạng.
**Đánh đổi:** Dải IPv6 global mới ngoài `2000::/3` (nếu IANA cấp) sẽ bị chặn tới khi sửa — chấp nhận, an toàn hơn lọt.

---

## ADR-092 — Migration backfill `projects` cho mọi tenant_id cũ (MS-P2-5, 2026-10-11)

**Vấn đề:** `20261011000000_projects_api_keys` chỉ chèn project `default`. DB cũ có dữ liệu mang tenant_id khác (thử `2222…` ở review) không có dòng `projects`: console không thấy, không tạo được key; bảng nghiệp vụ không có FK tới `projects` nên migrate vẫn "xanh".
**Chọn:** Migration MỚI `20261011030000_backfill_projects_for_tenants` (không sửa migration cũ): `INSERT … SELECT` tenant_id từ hợp của sources, destinations, subscriptions, events, deliveries, api_keys, audit_logs; slug `tenant-<32 hex>` (duy nhất, khớp `PROJECT_SLUG_RE`), name `Tenant <8 ký tự>`, environment `test`; `ON CONFLICT DO NOTHING` (idempotent). Test L1 tạo tenant mồ côi rồi chạy chính file SQL hai lần.
**Đánh đổi:** Tenant backfill mặc định môi trường `test` (key mới mang `hk_test_`) — operator đổi tay nếu cần. Vẫn chưa thêm FK `tenant_id → projects` (để AU6, ADR-071).

---

## ADR-093 — Lock cleanup giữ ~0,9 chu kỳ (một lượt mỗi chu kỳ cho N worker); CORS không `*` kèm credentials (MS-P2-6, 2026-10-11)

**Vấn đề:** Lock `cleanup:lock` (EX 300, nhả khi xong) chỉ chặn chạy chồng: N worker = N lượt/giờ (T13.5: worker-1 xoá 3 event, worker-2 chạy 10s sau xoá 0). hub-api trả `Access-Control-Allow-Origin: *` cùng `Allow-Credentials: true` (cấu hình sai; trình duyệt từ chối, và "sửa" bằng phản chiếu origin là mở cho mọi site kèm cookie).
**Chọn:** Lock TTL = max(300s, 0,9 × `CLEANUP_INTERVAL_MS`), KHÔNG nhả khi xong (kể cả khi lượt lỗi) — 0,9 < khoảng cách tối thiểu giữa hai lượt của cùng instance (jitter ±10%). CORS qua `corsOptions()`: không cấu hình → origin `*`, `credentials:false` (dashboard gửi JWT bằng header Bearer, không cookie); có `WEB_PUBLIC_URL`/`CORS_ORIGINS` → đúng danh sách origin, cho credentials. Biến mới ghi ở `.env.example`.
**Đánh đổi:** Instance giữ lock chết giữa lượt thì lượt sau chờ hết TTL (≤ 0,9h) — chấp nhận cho job dọn dẹp. Khi AU1 chuyển sang cookie thì phải đặt `WEB_PUBLIC_URL` (ghi để AU1 làm tiếp).

---

## ADR-094 — Endpoint có CHỦ (API key tạo nó) + `sourceId` trong body push, Shop chỉ tin sourceId đã ghim (R-1/R-2, review sau merge, 2026-10-11)

**Vấn đề:** MS-P2-1 ghim nguồn ở subscription CỦA Shop, nhưng bất kỳ key nào có `manage:endpoints` trong cùng project vẫn thấy endpoint `shop` và gắn thêm subscription KHÔNG ghim vào đó (rồi ký webhook SePay giả bằng source của chính nó → đơn PAID), hoặc PATCH tắt subscription đã ghim của Shop (DoS thanh toán). Body push không có `sourceId` nên Shop không tự kiểm được nguồn.
**Chọn:** (1) Cột `destinations.created_by_key_id` (migration `20261011040000_destination_owner_key`); `/v1/p` chỉ cho KEY ĐÃ TẠO endpoint thấy (`GET /endpoints`, `GET /subscriptions`), `/verify`, gắn subscription, PATCH subscription, lọc polling theo `endpointId` — key khác cùng project nhận 404 như không tồn tại. NULL = đích của operator (console/seed cũ): `/v1/p` không quản. Endpoint demo do seed gán cho key demo. (2) Phòng thủ chiều sâu: body push thêm `sourceId` (id source cụ thể); Shop lưu `subscription.sourceIds` trả về từ `ensure` và bỏ qua `payment.received` có `sourceId` ngoài danh sách; chưa ghim xong → 503 (hub retry, R-8). EVENT-CATALOG §1 thêm `sourceId`.
**Đánh đổi:** Chủ là MỘT key: xoay key của service (key mới) thì endpoint cũ không quản được qua `/v1/p` — service tạo endpoint mới (ensure tìm theo url trong phạm vi key mới), operator dọn đích cũ ở console. DB nâng cấp còn đích "Demo Shop Outbound Webhook" của seed cũ (chủ NULL, subscription không ghim) → operator phải tắt ở console; lớp (2) vẫn chặn tiền giả tới Shop trong lúc đó.

---

## ADR-095 — Cursor polling theo THỨ TỰ COMMIT (`events.poll_seq` cấp lúc poll dưới advisory lock), bỏ cửa sổ lắng 2s (R-3, thay phần cửa sổ lắng của ADR-077)

**Vấn đề:** ADR-077 lọc `created_at <= now()-2s` theo `seq` cấp lúc INSERT. Transaction normalize giữ lâu hơn 2s (khoá, DB chậm) → event của nó có seq NHỎ HƠN event đã trả → consumer polling đã vượt qua và mất vĩnh viễn (review tái hiện: giữ 5s). Lọc theo `xid < pg_snapshot_xmin(...)` cũng không chặt: xid cấp ở đầu câu lệnh, `nextval` của seq trong lúc INSERT — hai INSERT xen kẽ cho ra xid nhỏ hơn nhưng seq lớn hơn.
**Chọn:** Migration `20261011050000_events_poll_seq`: cột `events.poll_seq` + sequence riêng; dòng cũ `poll_seq = seq` (cursor client đang giữ vẫn đúng), sequence tiếp sau `max(seq)`. `pollEvents` gọi `assignPollSeq()` trước: MỘT transaction ngắn `pg_advisory_xact_lock(4242, hashtext(tenant))` + `UPDATE … SET poll_seq = nextval(...)` cho ≤ 1000 dòng ĐÃ COMMIT còn NULL của tenant (READ COMMITTED: dòng của transaction đang mở không thấy). Các lần gán nối tiếp nhau (lock) nên giá trị gán sau luôn lớn hơn mọi giá trị đã hiện → transaction commit muộn nhận poll_seq MỚI, không bao giờ bị cursor bỏ qua; trong một lô giữ thứ tự `seq`. Đọc `poll_seq > after ORDER BY poll_seq`; API vẫn gọi là `seq`. Không còn trễ 2s; 0 lệnh Redis (R1 giữ nguyên). L1 `polling-commit-order-db.spec.ts` giữ transaction 4s thật; E2E hubv: A (seq 30150) giữ 10s, B (seq 30151) commit trước → poll trả B (10083), sau khi A commit poll tiếp trả A (10084).
**Đánh đổi:** Mỗi lần poll thêm một UPDATE + advisory lock theo tenant (long-poll: mỗi giây một lần/kết nối chờ); các poll đồng thời của cùng tenant xếp hàng ở lock (rất ngắn). `seq` (dashboard `after=<seq>`, UI) vẫn là thứ tự INSERT — hai số khác nhau cho hai mục đích. Event chưa từng được poll thì chưa có `poll_seq`.

---

## ADR-096 — Seed default xét "đã có" theo đúng các source nó tạo (R-7, 2026-10-11)

**Vấn đề:** ADR-088 đếm MỌI source của project default. `ensureShopKey()` chạy trước; nếu key `shop` (hoặc key nào khác của default) có `publish:events` thì sinh source `api_*` trong default → seed default bị bỏ qua, quay lại đúng lỗi MS-P2-2.
**Chọn:** `SEED_DEFAULT_SOURCE_KEYS = ['src_github_main','src_payos_main','src_sepay_main']`; seed default chạy khi default chưa có source nào trong danh sách này. L1 `seed-fresh-db` thêm một source `api_preexisting` vào default trước khi seed và kiểm thế giới default vẫn đủ.
**Đánh đổi:** Operator xoá/đổi sourceKey một source seed thì lần seed sau tạo lại các source seed còn thiếu? Không — chỉ chạy khi KHÔNG có source nào trong danh sách (giữ idempotent kiểu "cả cụm"), tránh nhân đôi đích/subscription.

---

## ADR-097 — Shop tự lành đăng ký với hub: thử lại vô hạn (backoff 10s → 60s) + `ensure` ngay khi webhook tới lúc chưa ghim (R2-1, review vòng 2, 2026-10-11)

**Vấn đề:** Shop thử `ensure` 6 lần × 10s rồi bỏ cuộc; từ R-8 (ADR-094) chưa ghim thì trả 503 → hub chết lúc Shop khởi động > ~50s (Render free cold start 30–60s+) là Shop từ chối mọi khoản tiền vĩnh viễn tới khi có người restart.
**Chọn:** `apps/shop/src/hub-registration.ts` (`HubRegistration`): `start()` thử lại KHÔNG giới hạn, backoff 10s/20s/40s/60s (trần 60s); `ensureNow()` single-flight. `/hub-webhook` (sau verify chữ ký và challenge) thấy chưa ghim → gọi `ensureNow()` ngay (hub đang gửi webhook nghĩa là hub đã sống), vẫn chưa ghim mới 503 (hub retry). Tái hiện hubv: dừng hub-api, restart Shop, 91s sau bật hub-api → khoản SePay tiếp theo làm đơn PAID sau ~6s, không restart Shop.
**Đánh đổi:** Hub chết lâu thì Shop gọi hub mỗi 60s mãi (rẻ). Webhook đầu tiên sau khi hub sống chờ thêm một `ensure` (gồm challenge) — vài trăm ms.

---

## ADR-098 — Endpoint "mồ côi": migration gán chủ theo audit; `POST /endpoints` cùng url nhận lại endpoint của key ĐÃ REVOKE CÙNG serviceName (R2-2, 2026-10-11)

**Vấn đề:** Từ R-1 (ADR-094) endpoint có chủ là một key. (a) DB nâng cấp từ trước R-1: endpoint tạo qua `/v1/p` có chủ NULL → key của service không thấy → `ensure` tạo endpoint THỨ HAI cùng url, endpoint cũ vẫn nhận (giao gấp đôi). (b) Xoay key Shop: endpoint cũ thuộc key đã revoke → cùng hậu quả; không key nào dọn được qua `/v1/p`.
**Chọn:** (a) Migration `20261011060000_endpoint_owner_from_audit`: gán `created_by_key_id` từ audit `endpoint.create` có actor `key:<uuid>` (chỉ `/v1/p` ghi actor dạng này); đích operator giữ NULL. (b) `POST /v1/p/:project/endpoints`: nếu có endpoint webhook CÙNG url trong project mà chủ là một key ĐÃ REVOKE có CÙNG `serviceName` với key đang gọi → chuyển chủ (audit `endpoint.adopted`), chạy challenge (kèm secret mới → xoay theo ADR-086), trả `{…, adopted: true}` thay vì tạo mới. Luật chặt nhất có thể tự động: `serviceName` do operator đặt khi cấp key = danh tính service; không bao giờ nhận endpoint của key còn sống, của service khác, hay của operator (NULL). Tái hiện hubv: (a) đặt chủ shop = NULL, deploy → migration gán lại, Shop `created:false`, 1 endpoint; (b) tạo key mới `serviceName=shop`, revoke key cũ, khởi động Shop bằng key mới → nhận lại đúng endpoint cũ, 1 endpoint, 1 delivery, đơn PAID.
**Đánh đổi:** Operator đặt trùng `serviceName` cho hai service khác nhau thì service sau nhận được endpoint cùng url của service trước khi key trước bị revoke — ghi ở DEPLOYMENT: `serviceName` phải là danh tính duy nhất của service. Endpoint mồ côi khác url thì vẫn phải operator dọn ở console.

---

## ADR-099 — Trường cursor polling tên là `cursor`, bỏ `seq` khỏi response `/v1/p/:project/events` (R2-3, 2026-10-11)

**Vấn đề:** Từ ADR-095 response polling trả `poll_seq` dưới tên `seq`, trong khi dashboard (`/api/v1/events?after=<seq>`, UI) dùng `events.seq` (thứ tự INSERT). Trên DB mới hai dãy lệch xa (poll 15–18 so với seq ≈ 10037) → dev lấy "seq" từ dashboard làm cursor sẽ bỏ sót hoặc nhận lại.
**Chọn:** Response `events[].cursor` (chuỗi) + `nextCursor`; KHÔNG còn `seq` trong response polling (chưa có consumer ngoài — SDK và tài liệu đổi cùng commit). Repo `PolledEvent.cursor`, SDK `HubEvent.cursor`. EVENT-CATALOG §5a và ARCHITECTURE §8.1 ghi rõ hai dãy số khác nhau.
**Đánh đổi:** Phá tương thích với client đọc `event.seq` của polling (chỉ có code trong repo này, đã sửa). Dashboard giữ `seq` (thứ tự INSERT) vì là màn xem.

---

## ADR-100 — Gate `repo-subclass`: lớp con của `TenantScopedRepository` chỉ ở danh sách cho phép (R2-5, 2026-10-11)

**Vấn đề:** R-9 đổi `prisma` của `TenantScopedRepository` thành `protected` + `extend(Sub)` để `FlowScopedRepository` viết SQL đọc hành trình — mọi lớp con đều có client trần, viết được truy vấn không lọc `tenant_id` mà gate BB-5 (`prisma.<model>.` ngoài libs/database) không bắt.
**Chọn:** Luật gate mới `repo-subclass` (`verify/lib/gates.ts`): `class X extends TenantScopedRepository` chỉ được ở `REPO_SUBCLASS_ALLOWED` (hiện: `apps/hub-api/src/modules/flow/flow.repository.ts`, kèm lý do). Thêm lớp con = thêm file vào danh sách kèm lý do và review từng câu SQL lọc tenant (giống luật `rls-system`). Test `verify/test/gates.spec.ts` (lớp con ngoài danh sách → đỏ).
**Đánh đổi:** Gate dựa trên grep (một lớp con gián tiếp qua lớp trung gian sẽ lọt) — đủ cho quy mô repo; khi AU6 bật RLS thì DB là lưới cuối.

---

## ADR-101 — Sửa ADR-098: nhận lại endpoint chỉ SAU khi chứng minh được secret; FAILED → 409, giữ nguyên chủ/secret/trạng thái (R3-1, review vòng 3, 2026-10-11)

**Vấn đề:** ADR-098 chuyển chủ trước rồi mới chạy challenge: key mới (cùng `serviceName`, chủ cũ đã revoke) gửi secret SAI → vẫn `adopted:true`, endpoint chuyển FAILED `http_401` → Shop ngừng nhận tiền.
**Chọn:** Đảo thứ tự: challenge trước (secret mới nếu có, không thì secret đang lưu); chỉ khi VERIFIED mới chuyển chủ + xoay secret + `verification=VERIFIED` + audit `endpoint.adopted` trong MỘT transaction. Không VERIFIED → 409 `{error:"adoption_not_verified", verificationError}`, KHÔNG ghi gì (chủ cũ, secret cũ, trạng thái cũ giữ nguyên). SDK `ensure` nhận 409 như lỗi → Shop log và thử lại (ADR-097).
**Đánh đổi:** Không có audit cho lần nhận lại thất bại (chỉ log + 409 trả về caller) — tránh ghi gì khi chưa chứng minh sở hữu.

---

## ADR-102 — Sửa ADR-100: gate `repo-subclass` bắt cả bí danh (R3-3, 2026-10-11)

**Vấn đề:** Regex của ADR-100 chỉ bắt `class X extends TenantScopedRepository` — `import { TenantScopedRepository as Base }` rồi `extends Base` lọt.
**Chọn:** `repoSubclassCheck` (per file): gom tên gốc + bí danh từ `import { TenantScopedRepository as X }` và `const|let|var X = TenantScopedRepository`, rồi bắt `class … extends <tên bất kỳ trong tập>`. Test gate thêm hai dạng bí danh (đỏ) và dùng bí danh để `new` (không phải lớp con, không bắt).
**Đánh đổi:** Vẫn là grep, không phải AST: bí danh qua re-export ở file khác (`export { TenantScopedRepository as X }` rồi import X) chưa bắt — chấp nhận ở quy mô repo; AU6 bật RLS là lưới cuối.

## ADR-103 — AU1: đăng ký/đăng nhập bằng cookie, refresh xoay vòng ở Postgres, vé socket và kiểm membership ngay từ AU1 (2026-10-11)

**Vấn đề:** SPEC-auth §8 đặt vé socket và membership ở AU3, nhưng AU1 đổi đăng nhập sang cookie HttpOnly (web hết token để handshake) và mở đăng ký công khai (ai đăng ký cũng sẽ đọc được project `default` nếu console còn coi mọi người là operator). Trang web `/auth/login` trùng đường proxy `/auth/*` mà spec yêu cầu. Top 1.000 mật khẩu phổ biến không có mục nào dài ≥ 10 ký tự, trong khi tối thiểu là 10, nên luật "nằm trong danh sách" không bao giờ bắn. Bcryptjs v3 không cho `spyOn` (UA4).
**Chọn:**
- Bảng danh tính qua `IdentityRepository` duy nhất (migration `20261011100000_auth_identity`, sinh bằng `prisma migrate diff`). Gate BB-5 cấm `prisma.user/projectMember/authSession/emailToken/authAudit.` ngoài `libs/database/src`.
- `SessionGuard` thay `JwtAuthGuard`: verify HS256 + iss + aud, MỘT truy vấn khoá chính kiểm session còn sống, CSRF ký theo sid cho method thay đổi dữ liệu.
- Refresh trong MỘT transaction `FOR UPDATE`; nhánh lỗi trả về (không ném) để việc thu hồi family vẫn COMMIT.
- Logout và xoá thiết bị thu hồi cả family, không chỉ dòng hiện tại.
- Làm sớm trong AU1:
  - `resolveProjectScope` kiểm tồn tại + membership (operator vào mọi project). Đây là luật chung cho HTTP, vé socket và `/api/v1/projects/*`. Thiếu `?projectId=` thì tạm lấy project đầu tiên; AU3 bỏ nhánh này.
  - `/api/v1/projects` liệt kê theo membership; người tạo project thành owner.
  - Vé socket `/auth/socket-ticket`; room `project:<id>`.
- Web: trang chuyển sang `/login`, `/register` (route group `(auth)`); `next.config` rewrites `/api/*`, `/auth/*` → `HUB_API_INTERNAL_URL` (build arg); `client.ts` dùng URL tương đối, `credentials:'include'`, CSRF, refresh single-flight; xoá `token.ts`.
- `CoreModule` `@Global` cấp MỘT PrismaService/RedisService cho mọi module.
- Danh sách mật khẩu = top 1.000 ∪ 51 mục dài ≥ 10 của SecLists 10k (nhúng TS, không đọc `.txt` lúc chạy). bcrypt gọi qua `bcryptImpl` để test spy được.
- Operator seed từ `OPERATOR_EMAIL`/`OPERATOR_PASSWORD_HASH`; đã có thì KHÔNG ghi đè mật khẩu.
- Rate limit: một `EVAL` (INCR+EXPIRE của ingest, trả thêm TTL cho `Retry-After`), Redis lỗi thì dùng bộ đếm trong bộ nhớ; không tính vào R1.
- helmet (CORP cross-origin để playground gọi `/hooks/*`) + cookie-parser, ghim phiên bản.

**Đánh đổi:** AU1 lấn sang AU3 (vé socket, membership tối thiểu) để mỗi commit đều chạy được và không mở IDOR; scope theo role, `?projectId=` bắt buộc, `operator.access` vẫn là AU3. Đăng ký trùng email trả 201 cùng hình dạng nhưng không đặt cookie (mail "có người thử" là AU2), nên người cố ý dò vẫn thấy bước kế tiếp hỏng. Rate limit theo IP sau proxy Vercel có thể chỉ thấy IP egress của Vercel; giới hạn theo email vẫn đúng. Cookie `__Host-` Secure trên http chỉ chạy ở localhost (Chrome/Firefox); Safari cần kiểm ở TA14.

## ADR-104 — AU2: MailSender ba driver, token mail dùng một lần bằng một câu UPDATE, đặt lại mật khẩu thu hồi mọi phiên (2026-10-11)

**Vấn đề:** Đăng ký cần xác minh email thật, quên mật khẩu cần link một lần; E2E phải đọc được link mà không grep log; hai request song song có thể dùng cùng một token; mật khẩu mới yếu không được đốt mất token đặt lại.
**Chọn:** `libs/common/src/mail`: `MailSender` + driver `log` (mặc định local, in link ra log), `resend` (fetch API Resend, thiếu key thì ném lúc khởi tạo), `capture` (mỗi thư một file JSON; hubv mount `verify/.mail`; production + capture thì app thoát). Mẫu thư tiếng Việt có bản text, escape HTML. Token 32 byte base64url, DB chỉ sha256, xác minh 24 giờ, đặt lại 1 giờ; dùng một lần bằng MỘT câu `UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING` (UA14); gửi lại thì vô hiệu token cũ chưa dùng. Mail gửi SAU COMMIT, không chặn response; lỗi gửi chỉ log. Đăng ký trùng email: 201 cùng hình dạng + mail "có người thử" (không kèm token). Quên mật khẩu luôn 202 cùng body; giới hạn 1/phút + 5/ngày theo email. Đặt lại mật khẩu: kiểm mật khẩu yếu TRƯỚC khi đốt token (peek không đốt), rồi đổi hash + thu hồi mọi phiên + đánh dấu email đã xác minh trong một transaction. Đổi mật khẩu thu hồi mọi phiên trừ phiên hiện tại. CleanupJob sẵn có thêm hai bước qua `IdentityRepository` (phiên hết hạn > 30 ngày, token > 7 ngày). Web: trang trần `/verify-email` (POST token ngay, `replaceState`, `Referrer-Policy: no-referrer`).
**Đánh đổi:** Driver `log` in link có token vào log, nên DEPLOYMENT ghi rõ deployed phải dùng `resend`. Không có trang `/forgot-password`, `/reset-password` trên web (việc của phiên UI; API đã có). Đặt lại mật khẩu đánh dấu email đã xác minh (bấm link trong mail là bằng chứng sở hữu), lệch nhẹ so với spec (spec không nói).

## ADR-105 — AU3: role = bó scope, ProjectScopeGuard là ProjectAccessGuard của spec, projectId bắt buộc, operator để lại dấu vết (2026-10-11)

**Vấn đề:** Spec gọi guard là `ProjectAccessGuard`, nhưng repo (HTTP, vé socket, module flow) đã dựa vào `ProjectScopeGuard` + `resolveProjectScope`. Route `/api/v1/projects` (liệt kê/tạo) không thuộc project nào nên không có scope để khai. Query key của web không mang projectId, nên đổi project sẽ hiện dữ liệu cũ.
**Chọn:**
- `libs/common/src/auth/roles.ts` là hằng số DUY NHẤT: `ROLE_SCOPES` (viewer ⊂ developer ⊂ owner), `KEY_GRANTABLE_SCOPES` (4 scope, không bao giờ `manage:keys`/`members`/`project`).
- GIỮ tên `ProjectScopeGuard` (chính là ProjectAccessGuard của spec):
  - đọc `projectId` từ path hoặc query; thiếu thì 400 `project_required` (bỏ project mặc định của AU1);
  - không tồn tại / không thành viên → CÙNG 404;
  - thiếu scope → 403 `missing_scope {required}` (thứ tự 401 → 404 → 403 như ApiKeyGuard);
  - operator không là thành viên được coi như owner và MỖI request ghi `audit_logs` `operator.access`.
- Một `@RequireScope` cho cả người lẫn máy. Route không thuộc project khai `@NoProjectScope(lý do)`; UA20 quét metadata, route nào thiếu cả hai thì đỏ. Quy tắc §6.1, lệch duy nhất: `GET …/keys` là `read:project` (chỉ prefix, không bao giờ key/hash).
- `email_not_verified`: project `live` / key `hk_live_`; `hk_test_` vẫn được ngay.
- Vé socket kiểm thêm `read:project`.
- Web:
  - store project chung toàn dashboard (`project-store.ts`, localStorage chỉ id);
  - `hubFetch` tự gắn `?projectId=` cho `/api/v1/*` (trừ `/api/v1/projects`);
  - bộ chọn project ở sidebar (role hiển thị kèm);
  - đổi project thì `resetQueries` + xin vé socket mới;
  - AuthGuard chọn project hợp lệ trước khi mount trang.
- Sửa bug AU1 (bắt bởi TA8): gateway khai `prisma?: Pick<PrismaService,…>` nên Nest không inject được (metadata là `Object`) và mọi socket thật bị từ chối. Đã có test DI hồi quy.

**Đánh đổi:** Operator ghi một dòng audit cho MỖI request vào project người khác (nhiều dòng nếu xem lâu), chấp nhận vì operator ngày thường không dùng. Ẩn nút theo role trên web chưa làm (phiên UI). TA14 (trình duyệt thật) là mồ côi có lý do — phiên TEST làm tay.

## ADR-106 — AU4: lời mời qua email, thành viên, khoá owner bằng FOR UPDATE, API key không bao giờ có scope của người (2026-10-11)

**Vấn đề:** Hai owner cùng hạ quyền nhau đồng thời có thể để project không còn owner. Bấm link mời bằng tài khoản khác không được làm mất lời mời. Viewer phải tự rời được project dù không có `manage:members`. Spec chỉ nói `manage:keys` trả 422, chưa phân biệt với scope gõ sai.
**Chọn:**
- `MembersService` (AuthModule) + `MembersController` `/api/v1/projects/:projectId/{members,invitations}` qua `ProjectScopeGuard`; `POST /auth/invitations/accept`.
- Mời: cần email đã xác minh; mời/gán role owner chỉ owner (operator không là thành viên = owner); đã là thành viên → 409 `already_member`; mời lại cùng email vào cùng project thì vô hiệu lời mời cũ của project đó; token 7 ngày, mail gửi sau COMMIT.
- Accept: peek token (không đốt) để so email; khác email → 403 `invite_email_mismatch`, token còn nguyên. Đúng email thì đốt token + membership + đặt `emailVerifiedAt` trong một transaction.
- Đổi role / xoá: khoá MỌI dòng owner của project (`SELECT … FOR UPDATE`) rồi mới kiểm `last_owner`.
- `DELETE …/members/:userId` khai scope `read:project`: tự rời thì mọi thành viên đều được; xoá người khác kiểm `manage:members` trong service.
- Audit `member.invited/joined/role_changed/removed`, `invitation.revoked`.
- Tạo API key xin scope của người (`manage:keys/members/project`, `read:project`, `replay:deliveries`) → 422 `scope_not_grantable`; scope không tồn tại → 422 `validation_failed`.
- Driver capture ghi file tạm rồi `rename` (TA9 từng đọc phải JSON ghi dở).

**Đánh đổi:** Bị xoá khỏi project không thu hồi phiên (spec §5.3); request kế tiếp vào project đó là 404. Không có trang web `/invite` và trang Thành viên (phiên UI); API đã đủ.

## ADR-107 — AU5: GitHub OAuth (state + PKCE trong cookie ký HMAC), ghép tài khoản chỉ khi email đã xác minh, fake-github bị chặn ở production (2026-10-11)

**Vấn đề:** Đăng nhập GitHub mở hai đường chiếm tài khoản: kẻ tấn công đăng ký trước email của nạn nhân (chưa xác minh) rồi chờ nạn nhân đăng nhập GitHub; hoặc CSRF đăng nhập (đẩy code của kẻ tấn công vào trình duyệt nạn nhân). Test không gọi được GitHub thật; fake-github là VF4.
**Chọn:**
- `GithubOAuthService`. `GET /auth/github` sinh state 32 byte + PKCE verifier 32 byte, lưu trong cookie `__Host-hub_oauth` (HttpOnly, Secure, Lax, 10 phút, ký HMAC bằng `OAUTH_COOKIE_SECRET`), scope chỉ `read:user user:email`, `code_challenge_method=S256`.
- Callback:
  - cookie bị xoá ngay;
  - state so bằng `timingSafeEqual`; sai / cookie bị sửa / thiếu → 400 `oauth_state_mismatch`, không gọi GitHub;
  - đổi code kèm `code_verifier`; lấy email primary + verified, không có thì `/login?error=github_email_unverified`.
- Ghép tài khoản:
  - theo `githubId` (id SỐ) → đăng nhập;
  - email trùng user đã xác minh → liên kết (chỉ khi chưa có githubId) + `auth_audit github.linked` + mail báo;
  - email trùng user CHƯA xác minh → không liên kết (`/login?error=email_exists_unverified`);
  - operator → từ chối;
  - người mới → user đã xác minh, không mật khẩu, project đầu tiên, về `/onboarding`.
- Không lưu access token của GitHub. `POST /auth/github/unlink` khi chưa có mật khẩu → 409 `last_login_method`.
- `GITHUB_OAUTH_BASE_URL` cho fake-github; production khác `https://github.com` thì app thoát (`testOnlyConfigProblems`). Test dùng fetch giả (DINH-CHINH-AUTH §4 #9).
- Web: nút GH ở trang đăng nhập điều hướng toàn trang tới `/auth/github` (qua proxy); bỏ ba nút Google/Facebook/X giả.

**Đánh đổi:** TA11 (GitHub thật) là mồ côi có lý do — cần Admin tạo OAuth App. `/onboarding` trên web chưa có (phiên UI), nên người mới đăng nhập GitHub tạm thấy 404 cho tới khi có trang. Chưa đặt client id/secret thì `/auth/github` trả 503 `github_oauth_disabled`.

## ADR-108 — AU6: RLS bắt buộc — runtime `hub_app`, repo tự đặt `app.project_id`, `systemTx` là lối xuyên project duy nhất, p95 ingest +7,6% (2026-10-11)

**Vấn đề:** BB-5 trước đây chỉ có hai lớp (guard + `TenantScopedRepository`); một câu SQL quên `tenant_id` là lộ dữ liệu. Postgres local chạy bằng superuser nên RLS sẽ bị bỏ qua hoàn toàn. Ba bảng con (`source_secrets`, `raw_events`, `delivery_attempts`) không có cột `tenant_id`. Trên Neon, owner không phải superuser nên FORCE RLS chặn cả seed. Lần đo đầu sau RLS ra p95 ingest +16,7%, vượt trần 15% của spec §5.12.7.
**Chọn:**
- Migration `20261011110000_rls_hub_app` (chạy bằng owner):
  - bảo đảm role `hub_app` (NOLOGIN nếu chưa có), GRANT trên schema `hub` + default privileges, thu quyền với `_prisma_migrations`;
  - ENABLE + FORCE RLS + policy `tenant_isolation` (`tenant_id = app.project_id` HOẶC `app.rls_system = on`; không set gì thì 0 dòng) cho 6 bảng có `tenant_id`;
  - 3 bảng con dùng policy `EXISTS` trên bảng cha (bảng cha cũng RLS), nên không thêm cột, không backfill;
  - bảng danh tính, `outbox`, `processed_messages` KHÔNG bật (spec §5.1, §5.12.3).
- Đăng nhập/mật khẩu của `hub_app` không bao giờ nằm trong migration: local có `ensure-app-role` (entrypoint, owner, `HUB_APP_DB_PASSWORD`, chỉ ký tự an toàn); Neon tạo role trong console (DEPLOYMENT).
- hub-api/hub-worker chạy bằng `hub_app`; `assertAppRoleNotPrivileged` thoát nếu runtime là superuser/BYPASSRLS (chỉ bỏ qua khi `RLS_ALLOW_PRIVILEGED=1` và `NODE_ENV=test`).
- `TenantScopedRepository` (chọn proxy thay Prisma extension):
  - constructor trả proxy: client gốc → mỗi lời gọi phương thức là MỘT transaction tương tác `set_config('app.project_id', …, true)` + thân phương thức, lời gọi lồng chạy trên cùng tx;
  - trong tx có sẵn → đặt một lần cho tx đó;
  - phủ cả lớp con.
- `PrismaService.tenantTx(tenantId, fn)` cho chỗ ghi thẳng `tx.rawEvent`/`tx.deliveryAttempt`.
- `PrismaService.systemTx(reason, fn)` là lối DUY NHẤT đặt `app.rls_system` (tra source lúc ingest, cleanup, sweeper); chỉ `prisma.service.ts` chứa chuỗi này (gate + UA30).
- Tra source lúc ingest (đường NÓNG) dùng batch transaction thay transaction tương tác, đưa p95 từ +16,7% về +7,6%.
- Seed dùng `DIRECT_URL` + `options=-c app.rls_system=on`.
- Test L1 chạy code bằng `hub_app`, fixture bằng owner (SPEC-verification §4.3); TA12 assert tiền đề `hub_app/false/false` trước.

**Đánh đổi:**
- Mỗi lời gọi repo trên client gốc thành một transaction (thêm BEGIN/set_config/COMMIT). Đường ingest đo được: p95 25,46 → 27,39ms (+7,6%; trước 2 lần, sau 3 lần, k6 10→50→100 RPS, hubv local). Đường worker chậm hơn nhưng không nằm trên p95 ingest.
- Ai đặt được `options=-c app.rls_system=on` trong chuỗi kết nối thì bỏ qua RLS. Đó là cấu hình (như cầm mật khẩu owner), không phải code; code thì chỉ một chỗ được đặt (đã ghi ở ADR-057).
- Test giả không có `$executeRaw` bị bỏ qua `set_config` (Prisma thật luôn có).
- Migration dữ liệu chạy bằng owner trên Neon về sau phải tự `SET LOCAL app.rls_system = 'on'`.
- Probe P-BB5-01 của spec ghi `expectRed` nhưng claim là "RLS vẫn chặn"; đã chạy dưới dạng probe SỐNG SÓT (test phải còn xanh), probe đỏ tương ứng là P-BB5-02.
