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
