# Nhật ký quyết định kiến trúc (ADR)

> **ĐÃ ĐÓNG BĂNG ở ADR-266 (ADR-267).** File này giữ ADR-001 → ADR-266 nguyên văn; KHÔNG thêm gì vào đây nữa (gate `adr-unique` trong `npm run verify:gates` sẽ đỏ). Lý do: một file chung thì hai nhánh song song luôn xung đột ở cuối file.
>
> **Quy ước từ ADR-267, vẫn append-only:**
> - **ADR mới:** mỗi ADR một file `docs/adr/NNNN-<slug-không-dấu>.md` (vd `0267-adr-moi-file.md`). Lấy số + tạo file: `npm run adr:new -- "<tiêu đề>"`. Quyết định cũ sai → ADR mới, ghi `Thay thế ADR-00X`.
> - **Bổ sung cho ADR cũ** (≤ 266 hoặc ADR file đã chốt): file mới `docs/adr/bo-sung/NNNN-YYYY-MM-DD-<slug>.md`, NNNN = số ADR được bổ sung. Không sửa mục gốc, không sửa README.
> - **Trùng số giữa hai nhánh:** nhánh vào sau đổi tên file và số trong tiêu đề (gate nêu số kế tiếp).
>
> **Mẫu 3 dòng — mỗi quyết định tốn 2 phút:**
> ```
> # ADR-NNNN — <tiêu đề>   (ngày)
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

**Đính chính (DS5, 2026-10-12, append):** không có cache subscription — trong Redis hay trong bộ nhớ. Route tìm `subscriptions` bằng truy vấn Postgres trong cùng transaction với INSERT `events`/`deliveries` (ARCHITECTURE §3.2 bước 5). Lý do gộp 2 hop vẫn giữ: route là hàm thuần trên `(event, subscriptions)` và không phải nút thắt.

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
**Thay một phần (ADR-154, 2026-10-12):** "không hồi sinh đơn" chỉ còn đúng khi tiền trễ CHƯA đủ; tổng đủ thì EXPIRED → PAID (`LATE_PAID`).

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

## ADR-109 — Review AU R-1: khoá theo email đếm TRƯỚC khi so mật khẩu (INCR nguyên tử), đúng mật khẩu thì trả lượt (2026-10-11)

**Vấn đề:** `login` đọc bộ đếm (`peek`) rồi mới tăng (`hit`) sau khi bcrypt báo sai. N request song song cùng đọc được count < 5 → review đo 18 lần sai song song: 17×401, 1×429 (spec §5.5 hứa tối đa 5).
**Chọn:** `hit` (một `EVAL` INCR+EXPIRE) chạy TRƯỚC bcrypt; Redis đơn luồng cấp số thứ tự 1..N nên chỉ 5 lượt đầu tới bcrypt. Đăng nhập đúng gọi `release` (EVAL `DECR` nếu khoá còn tồn tại, không tạo khoá không TTL). Test UA12(b): 18 lượt song song → đúng 5×401 + 13×429.
**Đánh đổi:** đăng nhập đúng tốn thêm 1 lệnh Redis (đường console, không thuộc ngân sách R1). Khi đang có 5 lượt sai "đang bay", một lượt đúng đồng thời cũng bị 429 — chấp nhận (người dùng thử lại sau). Ai cũng khoá được email người khác bằng 5 request/15 phút — giữ nguyên như spec.

## ADR-110 — Review AU R-2: web chuyển IP client sang hub-api bằng header kèm secret chung `WEB_PROXY_SECRET` (2026-10-11)

**Vấn đề:** console đi qua `rewrites` của Next nên hub-api thấy mọi người dùng mang IP của web (local: container web; deployed: egress Vercel). `loginIp`/`registerIp`/`refreshIp` thành giới hạn CHUNG cho cả hệ thống: hubv qua web, client Y (IP khác) bị 429 ngay sau khi client X đăng ký 5 lần.
**Chọn:** `apps/web/src/proxy.ts` (Next 16 Proxy, Node runtime, matcher `/api/*`, `/auth/*`) xoá mọi `x-hub-*` client gửi, rồi gắn `x-hub-client-ip` (= `x-real-ip` / phần tử đầu `x-forwarded-for`, Vercel ghi đè hai header này) + `x-hub-proxy-secret`. hub-api (`client-ip.ts`) chỉ tin `x-hub-client-ip` khi secret khớp (`timingSafeEqual` trên sha256, IP phải hợp lệ theo `net.isIP`), ngược lại dùng `req.ip`. Secret tuỳ chọn; đã đặt thì ≥ 32 ký tự (hub-api thoát nếu ngắn). Chọn secret chung thay vì HMAC từng request: kênh web→API là server-to-server qua TLS, secret không bao giờ tới trình duyệt; HMAC chỉ thêm chống replay, mà replay chỉ cho phép "mượn" IP của người khác.
**Đánh đổi:** local không có proxy đứng trước web nên client tự đặt `x-forwarded-for` được → tự chọn IP để né giới hạn theo IP (khoá theo EMAIL 5 lần/15 phút vẫn là lớp chính, ADR-109). Deployed đúng chỉ khi Vercel ghi đè XFF (tài liệu Vercel nói vậy). Thêm một biến môi trường phải giống nhau ở hai nơi (Render + Vercel); lệch = quay về hành vi cũ, không hỏng.

## ADR-111 — Review AU R-7: migration dữ liệu sau RLS phải tự `SET LOCAL app.rls_system = 'on'`, có gate chặn (2026-10-11)

**Vấn đề:** trên Neon owner (`neondb_owner`) không phải superuser nên FORCE RLS (ADR-108) chặn cả owner. Migration dữ liệu (backfill, UPDATE/INSERT/DELETE trên 9 bảng có RLS) chạy đúng ở local (owner `hub_user` là superuser) nhưng trên Neon ảnh hưởng **0 dòng, không lỗi**. Đã tái hiện bằng `prisma migrate deploy` thật với role owner NOSUPERUSER NOBYPASSRLS trên bảng FORCE RLS: migration `UPDATE t SET x=x+10` không đổi gì, migration mở đầu `SET LOCAL app.rls_system='on'` đổi đủ 3 dòng (kết quả x=101 thay vì 111).
**Chọn:** quy ước — migration dữ liệu tạo sau `20261011110000_rls_hub_app` mở đầu bằng `SET LOCAL app.rls_system = 'on';` (Prisma gửi cả file trong một simple query = một transaction ngầm, nên `SET LOCAL` có hiệu lực tới hết file và không rò sang phiên khác; tách thành 2 query thì PG chỉ cảnh báo và cờ mất). Gate `data-migration-rls` (verify:gates, CI) quét `migration.sql` sau mốc đó: có DML trên bảng RLS mà thiếu cờ → đỏ. Ghi ở DEPLOYMENT §9 cạnh bước tạo `hub_app`.
**Đánh đổi:** gate là grep — DML động (`EXECUTE format(...)`, DO block) hoặc bảng RLS mới chưa thêm vào `RLS_TABLES` sẽ lọt; bảng RLS mới phải cập nhật danh sách. Migration dữ liệu có cờ chạy bỏ qua RLS như owner trước AU6 — đúng ý (migration là thao tác hệ thống, xuyên tenant).

## ADR-112 — Review AU R-3: socket đang mở bị ngắt khi mất phiên / mất quyền — kiểm lại ngay trong tiến trình + quét lô 30 s (2026-10-11)

**Vấn đề:** gateway chỉ kiểm vé + session lúc handshake. Review tái hiện: E bị xoá khỏi project A vẫn nhận `event.received` của A; sau `logout-all` socket vẫn `connected`. Spec §5.3 hứa thu hồi tức thì; với BB-5 đây là kẽ hở cô lập.
**Chọn:** socket mang `sid`/`userId`/`tenantId`. `RealtimeGateway.recheckSockets(userId?)` kiểm theo LÔ bằng hai truy vấn (`IdentityRepository.socketAccess`: session còn sống + cặp thành viên; operator luôn được) rồi `disconnect(true)` socket hỏng; lỗi DB thì giữ nguyên. Kích hoạt (1) ngay khi logout / logout-all / thu hồi thiết bị / đặt lại + đổi mật khẩu / phát hiện dùng lại refresh / xoá thành viên, qua EventEmitter trong tiến trình (`access-revocation.ts`, tránh phụ thuộc vòng auth↔realtime), SAU commit; (2) định kỳ mỗi `SOCKET_RECHECK_MS` (mặc định 30 s) cho mọi socket của instance. 0 lệnh Redis (quota Upstash, R1 không đổi).
**Đánh đổi:** nhiều instance hub-api: instance khác chỉ ngắt ở lượt quét kế (≤ 30 s), không tức thì — chấp nhận thay vì thêm kênh pub/sub Redis. Mỗi instance thêm 2 truy vấn / 30 s khi có socket mở. Đổi role (vẫn là thành viên) không ngắt — viewer vẫn được xem luồng.

## ADR-113 — Review AU R-8: phạm vi đóng mặc định — mọi route khai `@RequireScope` | `@NoProjectScope` | `@PublicRoute`, guard gặp route thiếu khai báo trả 500 (2026-10-11)

**Vấn đề:** `ProjectScopeGuard`/`ApiKeyGuard` chỉ kiểm khi route có `@RequireScope`; quên decorator = mở cho mọi role/mọi key. UA20 chỉ quét 4 controller ghi cứng nên controller mới lọt.
**Chọn:** thêm `@PublicRoute(lý do)` cho controller tự xác thực bằng cơ chế riêng (`/auth`, `/hooks` chữ ký provider, `/metrics` token, `/health`, `/mock`); `/v1/p/:project/me` khai `@NoProjectScope`. Hai guard gặp route không có `@RequireScope` (và với ApiKeyGuard: cũng không có `@NoProjectScope`) → 500 `scope_not_declared` + log error. UA20 tự tìm mọi `*.controller.ts` dưới `apps/hub-api/src` và đòi mỗi route có một trong ba khai báo.
**Đánh đổi:** quên decorator giờ là 500 ở runtime (lộ ra ngay khi thử) thay vì im lặng mở; UA20 bắt trước khi chạy. `@PublicRoute` vẫn là lời khai của dev — review phải đọc lý do.

## ADR-114 — Review AU R-10: `/auth/login` và `/auth/register` chỉ nhận `application/json` (415 cho kiểu khác) (2026-10-11)

**Vấn đề:** body parser mặc định của Nest nhận form urlencoded; login/register không đòi CSRF (chưa có phiên). Review: form POST từ `Origin: https://evil.example` → 200 + 3 cookie — trang lạ đăng nhập nạn nhân vào tài khoản kẻ tấn công (login CSRF), nạn nhân cấu hình đích webhook vào đó.
**Chọn:** `requireJsonBody` trong controller: Content-Type (bỏ tham số) khác `application/json` → 415 `unsupported_media_type`. Request JSON cross-origin không phải "simple request" nên trình duyệt buộc preflight, mà CORS đã khoá origin (MS-P2-6).
**Đánh đổi:** client nào gửi login bằng form (curl `-d` không kèm header) giờ nhận 415 — web, e2e, script demo đều đã gửi JSON. Không kiểm `Origin` (thêm một lớp nữa nhưng lệch giữa local/proxy/deployed).

## ADR-115 — Review AU R-5: trang trần `/forgot-password`, `/reset-password`, `/invite`; user GitHub mới về `/dashboard`; `?next=` chỉ đường nội bộ (2026-10-11)

**Vấn đề:** link trong mail (quên/đặt lại mật khẩu, lời mời, "có người thử đăng ký") và redirect `/onboarding` của GitHub dẫn tới 404 — không tự cứu tài khoản qua giao diện được, demo hỏng.
**Chọn:** ba trang tối thiểu dùng `AuthShell`/`AuthField` sẵn có + icon Lucide (thêm prop `social={false}`). Trang token đọc token rồi `replaceState` (không còn trên URL, `no-referrer` đã có ở next.config); `/invite` giữ token trong `sessionStorage` để sống qua `/login?next=/invite`. `login-form` theo `?next=` qua `safeNext` (chỉ chấp nhận đường bắt đầu bằng một `/`, chặn `//host`, `/\host` — open redirect). GitHub user mới → `/dashboard` (chưa có trang onboarding).
**Đánh đổi:** giao diện trần, bản đầy đủ vẫn là việc của phiên UI. Token lời mời nằm trong `sessionStorage` của tab tới khi nhận (cùng mức lộ với URL ban đầu, nhưng không vào lịch sử/Referer).

## ADR-116 — Review AU R-12: GitHub — user đã gắn GitHub khác thì không đăng nhập; callback đồng thời không thành 500 (2026-10-11)

**Vấn đề:** (a) email GitHub trùng user đã xác minh nhưng user đó đã gắn GitHub KHÁC: `linkGithub` trả 0 mà vẫn đăng nhập. (b) hai callback cùng lúc cho email mới: P2002 trên email (hoặc githubId — trường hợp này còn bị thử slug 3 lần rồi ném lỗi thường) → 500.
**Chọn:** (a) `linkGithub ≠ 1` → `/login?error=github_account_mismatch`, ghi `github.link_mismatch`, không phiên. (b) `createUserWithFirstProject` ném lại P2002 trên email|githubId; `GithubOAuthService.match` bắt P2002 và ghép lại đúng một lần (lượt kia đã tạo user → nhánh "theo githubId"). Web `/login` hiển thị thông báo theo `?error=`.
**Đánh đổi:** người dùng muốn đổi sang GitHub khác phải gỡ liên kết cũ trước (unlink cần còn mật khẩu). TA11 (luồng GitHub thật) vẫn làm tay.

## ADR-117 — Review AU R-13: các lệch nhỏ — vé socket của operator ghi `operator.access`, lời mời chết khi người mời mất quyền, token reset tạo sau response, production bắt buộc `WEB_PUBLIC_URL`; giới hạn của RLS kiểu GUC (2026-10-11)

**Vấn đề:** (1) operator xin vé socket cho project người khác không để lại dấu vết (HTTP thì có, UA21). (2) lời mời còn hiệu lực sau khi người mời bị hạ quyền/bị xoá. (3) quên mật khẩu: email có thật tốn thêm một transaction trước response (~4 ms, đo được bằng thống kê). (4) thiếu `WEB_PUBLIC_URL` ở production thì link trong mail lùi về `http://localhost:3000` im lặng. (5) `hub_app` tự `SET app.rls_system = 'on'` được ở mức phiên.
**Chọn:** (1) `SocketTicketService` ghi `operator.access` khi `viaOperator`. (2) lúc nhận, người mời (`invitedBy`) phải còn `manage:members` (mời owner thì phải còn là owner; operator luôn được) — không thì 400 `token_invalid`, token không bị đốt. (3) `forgotPassword` trả 202 trước, tạo token + gửi mail chạy nền (đo lại hubv: median có 5,6 ms / không 6,8 ms). (4) `authSecretProblems`: `NODE_ENV=production` mà `WEB_PUBLIC_URL` không phải http(s) → thoát lúc khởi động. (5) ghi nhận là giới hạn đã biết: RLS ở đây chống *quên lọc tenant* (BB-5), không chống SQL injection — ai chạy được SQL tuỳ ý bằng `hub_app` thì đặt được biến; gate chỉ chặn chuỗi literal trong code (ADR-108).
**Đánh đổi:** lỗi tạo token reset giờ chỉ vào log (người dùng đã thấy 202) — giống cách gửi mail vốn đã chạy nền. Lời mời của owner cũ bị vô hiệu dù owner mới có thể muốn giữ — mời lại là đủ.

## ADR-118 — Review AU R-14: trần số project mỗi user — chưa xác minh 3, đã xác minh 10, operator không giới hạn (2026-10-11)

**Vấn đề:** user chưa xác minh tạo 20 project test liên tiếp đều thành công — đăng ký hàng loạt rồi tạo vô hạn project (mỗi project kèm source/endpoint/key) trên free tier Neon.
**Chọn:** `POST /api/v1/projects` đếm project user đang là owner, sau `pg_advisory_xact_lock` theo user trong cùng transaction (song song không vượt trần); vượt → 403 `project_limit` kèm `limit`. Trần là hằng số trong `projects.controller.ts`. Project tạo lúc đăng ký/GitHub/seed không đi qua đây (luôn là project đầu tiên).
**Đánh đổi:** project được mời vào (không phải owner) không tính. Hằng số cứng — đổi cần deploy; đủ cho đồ án. Không phải rate limit theo thời gian (giữ 0 lệnh Redis).

## ADR-119 — Review AU R-4: đo đường giao bằng k6 sau RLS; ba truy vấn nóng của delivery consumer chạy batch transaction (2026-10-11)

**Vấn đề:** AU6 bọc MỖI lời gọi repo trên client gốc thành một transaction tương tác (BEGIN, `set_config`, truy vấn, COMMIT). Dev chỉ đo ingest (+7,6%); đường giao chưa đo. Review ước tính +5–7 ms mỗi delivery ở local.
**Đo (hubv local, k6 `k6/delivery-e2e.js`: 30 event/s × 60 s publish qua `/v1/p/cafe/events` → endpoint sink trả 200; mỗi chế độ 2 lượt, ~1 790 delivery/lượt):**

| Chế độ | worker xử lý 1 message (`hub_delivery_handle_seconds`, trung bình) | event vào hub → SUCCEEDED p50 / p95 | delivery tạo → SUCCEEDED p50 / p95 |
|---|---|---|---|
| C. giả lập trước AU6 (superuser, repo không bọc tx; bản build tạm, không commit) | 110,9 ms | 940 / 1 227 ms | 579 / 695 ms |
| A. AU6 hiện tại (transaction tương tác mỗi lời gọi) | 147,6 ms (**+33 %**) | 965 / 1 252 ms (+2,7 %) | 577 / 705 ms |
| B. AU6 + batch 3 truy vấn nóng (bản commit) | 129,5 ms (**+16,8 %**) | 953 / 1 238 ms (+1,4 %) | 580 / 688 ms |

Độ trễ người dùng thấy (event → SUCCEEDED) bị chi phối bởi chu kỳ outbox (~0,5 s) nên RLS chỉ thêm 1–3 %; nhưng thời gian xử lý của worker tăng 33 % (vượt trần 15 % của spec §5.12.7) vì transaction tương tác giữ connection lâu hơn, pool 10 connection của worker thành hàng đợi khi tải.
**Chọn:** `findDeliveryForSend`, `claimForSend`, `getDeliveryLeaseState` thành phương thức trả `PrismaPromise` (không `async`); proxy của `TenantScopedRepository` chạy chúng bằng batch transaction `[set_config('app.project_id'), truy vấn]` như tra source lúc ingest (ADR-108). Ghi kết quả (`tenantTx`, nhiều câu ghi) giữ transaction tương tác. Thêm histogram `hub_delivery_handle_seconds` (bộ nhớ, 0 lệnh Redis). `RLS_HOT_BATCH=0` quay về chế độ A để đo lại. Cách đo: `k6/README.md`.
**Đánh đổi:** còn +16,8 % thời gian xử lý của worker so với trước AU6 (hơi trên trần 15 %; độ trễ đầu-cuối chỉ +1,4 %) — phần còn lại là `set_config` của `tenantTx` và BEGIN/COMMIT của batch. Gộp thêm (vd claim + ghi kết quả) phải đổi luồng lease, không làm ở đây. Số đo ở local (Neon có round-trip lớn hơn nên chênh tuyệt đối sẽ lớn hơn — lý do thêm để giữ batch). Baseline C là bản build tạm (bỏ proxy, chạy bằng owner) — mã đó không nằm trong repo.

## ADR-120 — Review AU R-6: đăng ký KHÔNG đăng nhập; tài khoản mật khẩu chưa xác minh không đăng nhập được; link xác minh đăng nhập luôn (2026-10-11)

**Vấn đề:** spec §5.2 hứa đăng ký email đã có "201 giống hệt", nhưng email mới nhận 201 + 3 cookie còn email đã có nhận 201 + 0 cookie → dò được email nào có tài khoản (review §2 #14). Chỉ bỏ cookie ở register là chưa đủ: kẻ dò đăng ký rồi đăng nhập ngay bằng mật khẩu vừa đặt — email mới vào được, email đã có thì 401.
**Chọn:**
- `POST /auth/register`: mọi email hợp lệ → CÙNG 201 `{ok:true, message}`, không cookie; băm mật khẩu ở cả hai nhánh, phần phụ thuộc "email đã có chưa" (tạo user + project, gửi mail) chạy NỀN sau response → body, cookie và thời gian giống nhau (hubv: lệch TB 3,1 ms).
- Email mới → mail xác minh. Email đã có, chưa xác minh, có mật khẩu → gửi lại link xác minh (đăng ký lại = "gửi lại link"; theo hạn mức mail). Đã xác minh → mail "có người thử đăng ký".
- `POST /auth/login`: tài khoản có mật khẩu mà `emailVerifiedAt` rỗng (trừ operator) → CÙNG 401 `invalid_credentials` sau bcrypt, ghi `auth.login_unverified`, tính là một lần sai (R-1).
- `POST /auth/verify-email`: xác minh VÀ phát phiên (đặt 3 cookie, trả body như `/auth/me`) — bấm link = chứng minh sở hữu email, giống link đặt lại mật khẩu. Web `/verify-email` chuyển thẳng `/dashboard` (hoặc `/invite` nếu đang nhận lời mời); `/register` hiện "kiểm tra email".
**Đánh đổi:** quickstart thêm một bước mở thư (local `MAIL_DRIVER=log`/`capture`: link nằm trong log/thư mục; hubv TA1 đăng ký → event trong console 1,46 s kể cả bấm link). Không còn phiên "chưa xác minh" mới — luật `email_not_verified` (§5.6) chỉ còn áp cho tài khoản cũ/được tạo trực tiếp; UA28 vẫn kiểm ở L1. Tài khoản cũ chưa xác minh phải bấm link (đăng ký lại hoặc quên mật khẩu) mới đăng nhập được. Lỗi tạo user nền chỉ vào log (người dùng đăng ký lại là được).

## ADR-121 — Review AU vòng 2 N-1: người chứng minh hộp thư mới chọn mật khẩu — link xác minh của tài khoản mật khẩu chưa xác minh buộc đặt mật khẩu, xoá mọi thứ người trước để lại (2026-10-11)

**Vấn đề:** sau ADR-120, kẻ xấu đăng ký email nạn nhân với mật khẩu A; nạn nhân đăng ký lại (V) chỉ nhận link mới, bấm link là đăng nhập vào tài khoản mang mật khẩu A và tên "Attacker" — A vẫn dùng được, V thì không (chiếm tài khoản bằng đăng ký trước, đúng thứ spec §5.10 chặn).
**Chọn (phương án a của review):**
- `POST /auth/verify-email`: nếu tài khoản có mật khẩu mà chưa xác minh thì `{token}` trơn → 400 `password_required` (chỉ peek, token KHÔNG bị đốt); `{token, password, name?}` → đốt token, đặt mật khẩu MỚI, xác minh rồi `claimAccount`. Tài khoản đã xác minh / không mật khẩu giữ hành vi cũ (link = đăng nhập).
- `claimAccount` (một transaction): tên = `name` gửi kèm (hoặc phần trước @), `githubId` = null, vô hiệu mọi token `verify_email`/`reset_password` còn chờ của email và mọi lời mời user này gửi còn chờ, thu hồi MỌI phiên, thu hồi mọi API key của project mà user là thành viên DUY NHẤT; sau commit ngắt socket (ADR-112). Project tự tạo lúc đăng ký giữ nguyên (slug/tên project có thể mang tên kẻ xấu — chỉ là hiển thị; chưa đổi tên để không đụng URL/connection string).
- `POST /auth/reset-password` trên tài khoản CHƯA xác minh cũng đi `claimAccount` (nhận lại qua quên mật khẩu).
- Web `/verify-email`: gặp `password_required` thì hiện form tên + mật khẩu.
**Đánh đổi:** người đăng ký thật nhập mật khẩu hai lần (lúc đăng ký và lúc bấm link) — mật khẩu lúc đăng ký chỉ còn để qua kiểm tra hình thức. Sau R-6 kẻ xấu không còn đăng nhập được khi chưa xác minh nên hầu như không để lại gì; phần thu hồi key/lời mời là cho tài khoản cũ (trước R-6). Key trong project dùng chung (≥ 2 thành viên) không bị thu hồi để không phá dữ liệu của người khác. Đã cân nhắc phương án (b) gắn hash vào token: nạn nhân không phân biệt được link của mình với link do kẻ xấu kích hoạt nên bỏ.

## ADR-122 — Review AU vòng 2 N-2: `?next=` kiểm bằng cách PHÂN GIẢI URL cùng origin, không chỉ kiểm tiền tố (2026-10-11)

**Vấn đề:** `safeNext` chỉ chặn tiền tố `//` và `/\`. Parser URL (WHATWG) bỏ tab/newline nên `?next=/%09/evil.com` thành `//evil.com` — sau khi đăng nhập, router của Next chuyển sang site lạ (open redirect, hợp cho phishing).
**Chọn:** từ chối `raw` chứa ký tự điều khiển (< 0x20, 0x7f) hoặc `\`, đòi bắt đầu bằng đúng một `/`, rồi `new URL(raw, origin)` phải cùng origin; trả `pathname + search + hash` đã phân giải (không trả chuỗi gốc). Test bảng (`next-path.spec.ts`, 14 dòng: `//`, `/\`, `%09`, `%0a`, `%0d`, `%5C`, `%2F%2F`, scheme lạ, `javascript:`).
**Đánh đổi:** đường nội bộ hợp lệ nhưng có ký tự lạ cũng về dashboard — chấp nhận.

## ADR-123 — Review AU vòng 2 N-3 + N-4: mọi POST có body của `/auth` chỉ nhận JSON; proxy web viết lại header IP, API qua proxy chỉ tin `x-hub-client-ip` (2026-10-11)

**Vấn đề:** N-3 — `forgot-password` (và verify/reset/accept/change-password) vẫn nhận form urlencoded: trang lạ buộc trình duyệt nạn nhân bắn mail reset. N-4 — đi qua proxy web, `x-forwarded-for`/`x-real-ip` client tự đặt được chuyển nguyên sang hub-api; hub-api khi `x-hub-client-ip` rác lại lùi về `req.ip` (đọc XFF khi `TRUST_PROXY=1`).
**Chọn:** N-3: `requireJsonBody` ở đầu MỌI handler `@Post` có `@Body()` trong `auth.controller.ts` (415); test quét nguồn đỏ nếu handler mới quên. N-4: `proxy.ts` xoá `x-real-ip`, `x-forwarded-for`, `x-hub-*` client gửi, đặt `x-forwarded-for` = đúng MỘT IP đã chọn (phải là IP hợp lệ) + `x-hub-client-ip`/secret; `clientIp` của hub-api khi secret đúng chỉ dùng `x-hub-client-ip` (rác → null, không lùi về `req.ip`). DEPLOYMENT ghi bước kiểm một lần trên Vercel thật (khoá `rl:reg:ip:*` trên Upstash phải là IP thật, không phải XFF giả).
**Đánh đổi:** local/tự host không có proxy đứng trước web thì IP client vẫn do client chọn (Next không cho Proxy đọc địa chỉ socket, và chỉ đặt XFF khi request chưa có) — giới hạn theo IP ở local chỉ là lớp phụ, khoá theo email (ADR-109) là lớp chính; chọn vậy thay vì trả về một IP chung cho mọi người (R-2).

## ADR-124 — Driver mail `MAIL_DRIVER=gmail`: Gmail API qua HTTPS + OAuth2 refresh token, không SMTP (2026-10-11)

**Vấn đề:** deployed cần mail thật (R-6/N-1: không có mail thì người dùng mới không kích hoạt được tài khoản). Resend chưa xác minh domain chỉ gửi tới email chủ tài khoản; Render free chặn cổng SMTP nên không dùng SMTP của Gmail được.
**Chọn:** driver thứ tư cùng giao diện `MailSender` (`libs/common/src/mail/gmail.ts`): `POST oauth2.googleapis.com/token` (grant `refresh_token`) → access token giữ trong BỘ NHỚ tới 60 s trước khi hết hạn, nhiều thư cùng lúc dùng chung một lần làm mới (0 lệnh Redis, R1 không đổi) → `POST gmail/v1/users/me/messages/send {raw: base64url(thư RFC 2822)}`. Thư multipart/alternative text + html, thân base64 UTF-8, Subject/tên người gửi tiếng Việt là encoded-word RFC 2047 (mỗi dòng header ≤ 78 ký tự). From/To/Subject có CR/LF → NÉM (không làm sạch ngầm), địa chỉ phải hợp lệ. Timeout 10 s mỗi request; Gmail 401 → làm mới token một lần rồi gửi lại; `invalid_grant` → log lỗi rõ cho operator (token bị thu hồi/hết hạn, app OAuth phải *In production*) và không bao giờ log token/secret. Thiếu `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`/`MAIL_FROM` khi `MAIL_DRIVER=gmail` → hub-api thoát lúc khởi động (`mailConfigProblems` trong `authSecretProblems`). Gửi vẫn chạy nền như cũ (không đổi thời gian của register/forgot — R-6). Hướng dẫn lấy refresh token: DEPLOYMENT §9.
**Đánh đổi:** gửi bằng một tài khoản Gmail cá nhân: hạn mức ~500 thư/ngày, thư có thể vào spam, From cố định là Gmail đó. App OAuth chưa qua xác minh của Google — chỉ dùng cho chính tài khoản của Admin; để chế độ *Testing* thì refresh token chết sau 7 ngày. Mỗi instance tự giữ token riêng (không chia sẻ) — vài lần gọi token endpoint thừa, chấp nhận.

## ADR-125 — Sửa ADR-111 (R-7): trên Neon của đồ án `neondb_owner` có BYPASSRLS — owner KHÔNG bị FORCE RLS chặn; giữ quy ước `SET LOCAL app.rls_system` + gate làm phòng thủ nhiều lớp (2026-10-11)

**Vấn đề:** ADR-111 và DEPLOYMENT §9 viết "trên Neon owner không phải superuser nên FORCE RLS chặn cả owner → migration dữ liệu cập nhật 0 dòng". Kiểm vận hành 11/10 trên project Neon của Admin (migration đã áp 14/14): `neondb_owner` là NOSUPERUSER nhưng **`rolbypassrls = true`** → owner bỏ qua RLS, migration dữ liệu chạy đủ dòng. Nhận định cũ suy từ "không superuser", chưa kiểm cờ BYPASSRLS. Thêm hai điều chưa ghi: `_prisma_migrations` trên Neon nằm ở schema `public` (DIRECT_URL không có `?schema=`) nên `REVOKE` trên `hub._prisma_migrations` trong migration RLS không trúng gì ở đó; `hub_app` vẫn bị permission denied ở bảng `public` (chưa từng được cấp). Shop deployed cần role `shop_user` riêng và connection string của hub-api/worker cần tham số pooler.
**Chọn:** sửa DEPLOYMENT §9 cho đúng (owner bỏ qua RLS trên Neon, đã kiểm 11/10; câu lệnh kiểm `rolsuper, rolbypassrls`). GIỮ quy ước `SET LOCAL app.rls_system = 'on'` ở đầu migration dữ liệu và gate `data-migration-rls`: vô hại khi owner có BYPASSRLS, và đúng khi chuyển sang nhà cung cấp/role mà owner không có (đã tái hiện 0 dòng bằng `prisma migrate deploy` ở ADR-111). Ghi ở DEPLOYMENT: SQL tạo `shop_user` trên Neon (từ `docker/postgres/init/02-shop-user.sh`, migrator = `neondb_owner`), DATABASE_URL của Shop `…?sslmode=require&schema=shop`, DATABASE_URL của hub-api/hub-worker thêm `&pgbouncer=true&connection_limit=1`.
**Đánh đổi:** quy ước giờ là phòng thủ chứ không phải điều kiện bắt buộc trên Neon hiện tại — dev có thể thấy thừa, nhưng gate rẻ và giữ migration mang đi được. Phần "Neon chặn owner" của ADR-111 được thay bằng ADR này (ADR append-only, không sửa ADR-111).

## ADR-126 — Review driver Gmail G-1..G-4: chặn ký tự điều khiển Unicode trong header, thêm Date/Message-ID + gập Subject, không chép body lỗi, resend-verification chạy nền (2026-10-11)

**Vấn đề:** review `152e749` ĐẠT với 4 điểm Thấp: U+0085 trong địa chỉ lọt vào header dạng thô (G-1); thiếu `Date`/`Message-ID`, Subject ASCII dài không gập (G-2); lỗi send chép 200 ký tự body lỗi của Google vào log (G-3); `resend-verification` chờ gửi xong, Google treo thì request kéo tới ~20 s (G-4). Hướng dẫn §9 lệch giao diện Google Auth Platform hiện tại.
**Chọn:** G-1 — mọi header từ chối C0/C1 (gồm NEL), U+2028/2029; địa chỉ chỉ nhận ASCII in được. G-2 — `Date` (RFC 5322, UTC) + `Message-ID: <uuid@domain của MAIL_FROM>`; Subject ASCII > 70 ký tự cũng mã hoá RFC 2047 để cắt thành nhiều word (mọi dòng ≤ 78). G-3 — lỗi send chỉ mang HTTP status + `error.status`/`errors[0].reason` (lọc ký tự). G-4 — `resendVerification` gửi bằng `void … .catch(log)` như các mail khác. DEPLOYMENT §9: Branding/Audience/Clients, @gmail cá nhân bắt buộc External, Test users chỉ cần khi còn Testing.
**Đánh đổi:** Subject ASCII dài giờ hiển thị qua encoded-word (client đọc bình thường). Lỗi gửi ít chi tiết hơn trong log — đủ để phân loại, chi tiết xem ở Google Cloud Console.

## ADR-127 — AU5b: đăng nhập Google bằng OpenID Connect (code + PKCE + state + nonce), định danh là `sub`, ID token tự kiểm theo JWKS, ghép tài khoản theo luật N-1 (2026-10-12)

**Vấn đề:** Admin muốn đăng nhập Google (cho cả test auth ở local). Phải an toàn ngang AU5 GitHub và không mở lại lỗ chiếm trước (N-1): email trùng tài khoản CHƯA xác minh — mật khẩu đang có là của "ai đó đã đăng ký".
**Chọn:**
- Luồng: `GET /auth/google?next=` → Google (`openid email profile`, không nhạy cảm nên không cần Google thẩm định; `prompt=select_account`, PKCE S256, state, nonce). State/verifier/nonce/next nằm trong cookie `__Host-hub_oauth` ký HMAC (dùng chung với GitHub qua `oauth-cookie.ts`, có trường provider nên cookie luồng này không mở được ở callback luồng kia). `next` kiểm phía server cùng luật N-2.
- Callback đổi code ở token endpoint CỐ ĐỊNH, không lưu access token; kiểm ID token tự viết bằng `crypto`: RS256 theo JWKS của Google (cache theo `max-age`; `kid` lạ → tải lại một lần, giãn cách 30 s chống bão gọi), `iss` ∈ {accounts.google.com, https://accounts.google.com}, `aud` = client id (mảng thì `azp` cũng phải khớp), `exp`/`iat` ±60 s, `nonce` khớp cookie. Định danh = `sub` (cột `users.google_sub` UNIQUE, migration chỉ DDL); KHÔNG BAO GIỜ khoá theo email.
- Ma trận: theo `sub` → đăng nhập. `email_verified` ≠ true → `google_email_unverified`. Email trùng user: operator → cấm; đã gắn `sub` khác → `google_account_mismatch` + audit; user ĐÃ xác minh → gắn `sub` + mail báo; user CHƯA xác minh → Google đã chứng minh hộp thư → `claimAccount` (ADR-121: xoá mật khẩu chờ — `password_hash = null`, tên = tên Google, githubId, phiên, token, lời mời, key project riêng) rồi gắn `sub`. Không có → tạo user đã xác minh, không mật khẩu. Callback song song: P2002 trên email/`google_sub` → ghép lại một lần (như R-12).
- Gỡ liên kết Google chỉ khi còn mật khẩu hoặc GitHub; gỡ GitHub giờ được khi còn mật khẩu HOẶC Google (`409 last_login_method`).
- Client OAuth đăng nhập (`GOOGLE_OAUTH_CLIENT_ID/SECRET`) TÁCH khỏi client gửi mail (`GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`, ADR-124). Thiếu → `/auth/google` 503. `GOOGLE_OAUTH_FAKE_BASE_URL` (fake-google của hubv) chỉ có hiệu lực khi NODE_ENV ≠ production; production đặt biến này → app thoát (test-only-config).
**Đánh đổi:** tự kiểm JWT thay vì thêm thư viện (`jose`) — ít phụ thuộc, nhưng phải tự giữ đúng spec (đã có test cho từng nhánh). `kid` mới xuất hiện trong 30 s sau lần tải JWKS bị từ chối tạm thời (Google công bố khoá mới trước khi dùng nên hiếm). Nhận tài khoản chưa xác minh bằng Google xoá mật khẩu người đăng ký trước — chủ thật muốn đăng nhập bằng mật khẩu thì đặt qua quên mật khẩu.

## ADR-128 — Review AU5b GO-1..GO-5: gỡ liên kết bằng UPDATE có điều kiện, chỉ tự ghép Google khi Google có thẩm quyền với email, `azp` luôn kiểm, rate limit callback OAuth (2026-10-12)

**Vấn đề:** GO-1 — gỡ Google và gỡ GitHub song song đều 204 (đọc rồi mới gỡ) → user không còn cách đăng nhập (4/5 vòng). GO-2 — email Google trùng tài khoản đã xác minh thì tự ghép; với domain riêng, `email_verified` phản ánh lúc tạo tài khoản Google — domain hết hạn đổi chủ thì tài khoản Google cũ chiếm được tài khoản hub. GO-3 — `aud` là chuỗi đúng mà `azp` khác vẫn qua. GO-4 — callback không rate limit: cookie lấy miễn phí, mỗi callback làm hub-api POST tới token endpoint (khuếch đại). GO-5 — tài liệu chưa nói client đăng nhập và client mail chung project thì chung consent screen.
**Chọn:**
- GO-1: `unlinkGoogle`/`unlinkGithub` là MỘT `UPDATE … WHERE field IS NOT NULL AND (password_hash IS NOT NULL OR <provider kia> IS NOT NULL)`; 0 dòng (và đang gắn) → 409 `last_login_method`. Lệnh song song thứ hai chờ khoá dòng rồi tính lại WHERE (READ COMMITTED) → đúng một 204, một 409.
- GO-2: tự ghép vào tài khoản ĐÃ xác minh chỉ khi email là `@gmail.com`/`@googlemail.com` hoặc ID token có `hd` = domain email (Workspace); còn lại `google_link_requires_password` (đăng nhập bằng mật khẩu; chưa có trang/endpoint liên kết khi đang đăng nhập — ghi ở DEPLOYMENT). Nhánh tài khoản CHƯA xác minh (claim, ADR-127) và tạo mới không đổi. Ghi chú GitHub: cùng rủi ro lý thuyết (email đã xác minh trên GitHub của domain đổi chủ) — giữ nguyên hành vi AU5 vì GitHub không có claim tương đương `hd`; người dùng nhận mail "GitHub vừa được liên kết".
- GO-3: có `azp` thì phải bằng client id; `aud` mảng thì bắt buộc có `azp`.
- GO-4: `/auth/google/callback` và `/auth/github/callback` gọi `limitOAuthCallback` — MỘT `EVAL` INCR theo IP (đường IP qua proxy R-2), 20 lần/phút, vượt → 429 `Retry-After`. Đường console, không thuộc ngân sách R1.
- GO-5: DEPLOYMENT ghi chung project = chung consent screen/publish; tách hai project là gia cố tuỳ chọn.
**Đánh đổi:** người dùng email công ty không phải Workspace (vd Microsoft 365 nhưng tạo tài khoản Google bằng email đó) không tự liên kết được — phải đăng nhập bằng mật khẩu cho tới khi có trang liên kết. 20 callback/phút/IP đủ cho người thật (mỗi lần đăng nhập 1 callback).

## ADR-129 — Triển khai free tier: hub-api + hub-worker chạy HAI tiến trình trong MỘT container Render (`docker-entrypoint.sh hub-all`, DEPLOYMENT §3.2 phương án D); CloudAMQP ở Tokyo (2026-10-12)

**Vấn đề:** Render free không có Background Worker; Admin không muốn trả ~7 USD/tháng cho worker Starter. CloudAMQP Little Lemur free không có region Singapore.
**Chọn:**
- Lựa chọn TRIỂN KHAI do hạn mức, KHÔNG phải kiến trúc: BB-4 vẫn giữ — hai tiến trình Node riêng (mỗi tiến trình một AMQP connection, một pool Prisma), chỉ chung vỏ container. Local/hubv vẫn chạy hai service tách rời (compose không đổi).
- `docker-entrypoint.sh hub-all`: bước chuẩn bị của hub-api chạy một lần (hàm `hub_prestart`: ensure-app-role local, `migrate deploy`, seed tuỳ chọn), rồi `exec node docker/hub-all.js` (PID 1, không phụ thuộc gói ngoài): sinh hub-api (nghe `$PORT`) + hub-worker (`WORKER_METRICS_PORT=0` mặc định). SIGTERM/SIGINT → chuyển cho cả hai, chờ trong `SHUTDOWN_TIMEOUT_MS` (25 s) rồi SIGKILL; một con thoát ngoài ý muốn → SIGTERM con kia → exit ≠ 0 → Render khởi động lại (không nửa sống). Log JSON giữ nguyên + `"proc"`. `connection_limit` đặt riêng từng con (5 + 5, đổi bằng `HUB_ALL_*_DB_CONNECTIONS`); heap `--max-old-space-size` 200/220 MB (`HUB_ALL_*_HEAP_MB`).
- Đo (hubv, image thật, `mem_limit: 512m`, sau smoke + một đơn Shop PAID): RSS supervisor 50,7 MB · hub-api 113,4 MB · hub-worker 112,0 MB (RSS tính trùng thư viện dùng chung); cgroup (docker stats) **112 MiB / 512 MiB (22 %)** — dư cho free tier; không cần hạ heap thêm.
- Kiểm: `apps/hub-api/test/hub-all-supervisor.spec.ts` (HA1–HA3, tiến trình thật; nhánh SIGKILL chỉ kiểm được trên Linux — chạy trong container node:22), `scripts/hub-all-e2e.sh` (HA4, image thật trên `docker-compose.verify-allinone.yml`): 2 tiến trình hub trong container, e2e-smoke OK, đơn Shop → PAID, `kill -9` worker → container exit 1 và được khởi động lại (RestartCount 0→1), `docker stop` → drain, ExitCode 0 trong 1 s, rồi trả hubv về hai service.
- CloudAMQP free chọn Tokyo (AWS ap-northeast-1): ~70 ms thêm mỗi lượt broker ở bản deployed. Chấp nhận — p95 chỉ đo ở LOCAL (ADR-019); deployed để chứng minh chạy thật.
**Đánh đổi:** hai tiến trình chung 512 MB và chung số phận (một con chết kéo cả container restart ~1 phút). Giờ instance free 750 h/tháng: hub-all luôn thức (UptimeRobot) ≈ 730 h, nên `shop` free phải được ngủ. hub-api hiện không có shutdown hook nên thoát ngay khi SIGTERM (chỉ worker drain) — như chế độ hai service. Muốn tách lại: Docker Command `hub-api` + Background Worker `hub-worker` (DEPLOYMENT §3.2 A).

## ADR-130 — Sửa ADR-129 sau review hub-all (REVIEW-DEPLOY D-1..D-6): số đo RAM dưới tải, câu chữ về drain, env của tiến trình con (2026-10-12)

**Vấn đề:** ADR-129 chỉ đo RAM lúc tải nhẹ (D-3) và viết như thể cả hai tiến trình đều drain khi SIGTERM (D-2); review còn chỉ ra con giả được nhãn log (D-1), supervisor không giữ backpressure (D-4), con kế thừa `DIRECT_URL` owner (D-5), hạn drain của con trùng hạn SIGKILL của supervisor (D-6).
**Chọn / sửa:**
- D-3 — đo hubv biến thể all-in-one (`mem_limit: 512m`), k6 SONG SONG: ingest GitHub 10→50→100 RPS (3 449 request, 0 lỗi) + giao 30 event/s × 90 s (2 707 publish, 0 lỗi; 2 579 delivery SUCCEEDED trong cửa sổ — phần còn lại là event normalize sau khi teardown tắt subscription). Đỉnh bộ nhớ cgroup (docker stats, lấy mẫu ~5 s) **157,6 MiB / 512 MiB (31 %)**; RSS đỉnh worker 134,7 MB, supervisor 56,4 MB; không OOM, không restart. Dưới ngưỡng ~400 MiB nên **giữ** trần heap 200/220 MB. (p95 ingest đo trong cgroup giới hạn này là 264 ms — KHÔNG dùng làm số báo cáo; số báo cáo vẫn đo ở local hai service, ADR-019.)
- D-2 — câu chữ đúng: chỉ worker drain; hub-api chưa có shutdown hook nên thoát ngay khi SIGTERM — request đang dở bị cắt TRƯỚC khi trả 2xx, provider gửi lại, BB-2/BB-3 bảo đảm không mất/không đôi. Không thêm `enableShutdownHooks` lần này (đổi hành vi cả chế độ hai service + phải giới hạn thời gian đóng Socket.IO — để story riêng). Sửa DEPLOYMENT §3.2 và HUONG-DAN §3.
- D-1/D-4/D-5/D-6 — `0ad7ce1`: `proc` đặt sau spread; `out.write` false → `rl.pause()` tới `drain`; con nhận `DIRECT_URL = DATABASE_URL` (hub_app) và không có `HUB_APP_DB_PASSWORD`; con drain 22 s, supervisor SIGKILL ở 25 s.
- Sửa kèm: `k6/delivery-e2e.js` chốt RUN trong `setup()` (mỗi VU tự tính `Date.now()` ra RUN khác nhau, làm `delivery-latency.sh` đếm 0 khi không truyền `RUN`).
**Đánh đổi:** số đo một lượt, máy local; Render free CPU chậm hơn nên RAM có thể khác — vẫn còn ~350 MiB dư.

## ADR-131 — Verify endpoint thất bại không được im lặng: mọi đường FAILED ghi audit, chống spam theo audit gần nhất (2026-10-11)

**Vấn đề:** smoke deploy: Shop retry `endpoints.ensure` (xoay secret qua `/verify {signingSecret}`) vào URL bị chặn (`ssrf_blocked`) — nhánh xoay secret thất bại trả `{…, secretRotated:false}` mà KHÔNG ghi audit, nhánh adopt thất bại trả 409 cũng không audit; console trống trơn. Ngược lại `/verify` thường thì ghi audit MỖI lần → vòng retry (backoff ≤ 60 s) sinh ~60 audit/giờ.
**Chọn:** mọi đường challenge FAILED (`create` · `verify` · `rotate` · `adopt`) ghi `endpoint.verification_failed {verificationError, attempt}` cùng transaction, TRỪ KHI audit verify mới nhất của endpoint trong 1 giờ (`verified`/`verification_failed`/`adopted`) đã là `verification_failed` cùng mã lỗi + cùng attempt. Đọc Postgres (`findLatestAuditForEntity`, cửa sổ 1 giờ nên chỉ quét đầu index `(tenant_id, created_at)`) → đúng với nhiều instance, 0 lệnh Redis, sống qua restart. Metadata chỉ mã lỗi + attempt — không url, không secret. Nhánh xoay secret / adopt vẫn GIỮ NGUYÊN trạng thái + secret endpoint (MS-R4, R3-1); `/verify` thường vẫn cập nhật `verification_error` mỗi lần.
**Đánh đổi:** thêm 1 SELECT mỗi lần verify thất bại (đã bị chặn 5 lần/phút/endpoint); lỗi kéo dài chỉ để dấu 1 lần/giờ; hai instance đua nhau có thể ghi trùng một dòng (chấp nhận). Lỗi xoay secret không hiện ở `verificationError` của endpoint (cột đó là trạng thái của secret ĐANG dùng) — chỉ ở audit. Không thêm cột/migration.

## ADR-132 — VF3 `tools/hub-sim`: ký độc lập theo tài liệu provider, fixture là bytes, ký lại lúc phát (2026-10-11)

**Vấn đề:** test chữ ký hiện tự ký bằng chính code/thư viện của hub → hub và test cùng sai một kiểu vẫn xanh (§5.1); thiếu fixture ca biên provider thật không bắn theo yêu cầu (code≠00, ký sai, t cũ, thiếu id, sai header).
**Chọn:** `tools/hub-sim` chỉ dùng `crypto` của Node, viết lại 5 thuật toán + Standard Webhooks (ký + verify phía nhận) từ tài liệu công khai; đối chiếu với SDK CHÍNH CHỦ (`@payos/node`, `stripe`, `@octokit/webhooks-methods`) và vector mẫu của đặc tả Standard Webhooks ([VF:VT5]). 14 fixture `synthetic` (§5.4) lưu `bodyBase64`, mỗi provider ≥ 1 body "bytes lạ"; ký lại bằng secret giả của `.env.verify` lúc phát; ca Stripe cũ giữ `fixedAt` (ISO, không viết epoch để gate số tài khoản không nhầm). `expect.status/type` nằm TRONG fixture → L0 (`verify/test/hub-sim-adapters.spec.ts`, adapter thật) và L2 (VF4) dùng chung. `--unique <chữ số>` thay `__U__` để tạo sự kiện mới có chủ đích mà khoá vẫn tất định. `capture` đọc `raw_events` qua `docker compose -p <stack> exec postgres psql` (owner, chỉ stack LOCAL, công cụ dev — không phải code hub nên không đi qua `TenantScopedRepository`; hub-sim cấm import libs), bỏ header chữ ký, bắt buộc `scrub`.
**Đánh đổi:** lệnh là `npm run hub-sim -- …` (không phải `npx hub-sim`: tools/ không phải workspace, tránh thêm package). Fixture base64 khó đọc bằng mắt → `hub-sim show`. Gate `fixture-account` chỉ quét file JSON (thấy base64, không thấy body) → test L0 giải mã từng body và kiểm số 9–14 chữ số thay cho gate. PayOS ký trên `data` đã parse (theo đặc tả PayOS) nên "bytes lạ" của PayOS không bắt lỗi ký-trên-JSON — bắt ở Stripe/GitHub/AB Bank.

## ADR-133 — `hub listen` = polling (A) + ký phía client; `toWebhookBody` dùng chung với WebhookSender; `after=latest` (DX3, 2026-10-11)

**Vấn đề:** dev viết handler trên laptop: hub không gọi được `localhost` (SSRF guard + NAT) → phải dựng ngrok/cloudflared. Nếu công cụ local tự dựng body thì code chạy ở local khác production.
**Chọn:** CLI `libs/hub-sdk/bin/hub.js listen` (node:util parseArgs, 0 phụ thuộc mới) kéo bằng long-poll `GET /v1/p/:project/events` (`wait=20`) rồi POST vào URL local, ký Standard Webhooks bằng secret phiên (`--secret`/`HUB_LISTEN_SECRET`, không có thì sinh `whsec_` và in một lần). Body dựng bằng `toWebhookBody` (`libs/common/src/webhook-body.ts`, không import gì) — NGUỒN DUY NHẤT, `WebhookSender` dùng cùng hàm (UX9 kiểm byte-identical cả khi `subject` null). Chỉ đọc (không delivery, không chạm endpoint/circuit), không retry, cursor tiến kể cả khi local lỗi, backoff 1/2/5 s khi hub 5xx/mất mạng, mặc định chỉ forward tới localhost/127.0.0.1/::1/host.docker.internal (`--allow-remote` để mở). Backend thêm đúng một thứ: `after=latest` → `{events:[], nextCursor}` = max `poll_seq` sau `assignPollSeq` (event commit sau đó luôn có cursor lớn hơn, ADR-095); `after` rác → **400 `invalid_cursor`** (trước là 422 `validation_failed`). Chạy được cả `hub://` (http, local) và `hubs://` (https, deployed). Bin dùng `dist/cli.js` nếu đã build, không thì ts-node + tsconfig-paths trong monorepo.
**Đánh đổi:** CLI nạp `toWebhookBody` từ `@hub/common` lúc chạy → chỉ chạy trong monorepo hoặc `npm i <đường dẫn libs/hub-sdk>` (symlink); thư viện chính của SDK vẫn 0 phụ thuộc runtime. Khi publish SDK lên npm phải gói `webhook-body` vào SDK (ghi ở rủi ro §7 SPEC-dev-experience). Đổi mã lỗi cursor rác 422 → 400 là breaking nhỏ (chỉ client trong repo). Độ trễ = vòng long-poll (truy vấn lại mỗi 1 s) + normalize — xem số đo trong RESUME-dx.

## ADR-134 — `hub trigger`: mẫu kiểu chuẩn nằm cạnh catalog (`libs/common/src/canonical/samples.ts`), đi đúng đường `POST /events` (DX3b, 2026-10-11)

**Vấn đề:** dev muốn thử handler `payment.received` mà không có cổng thanh toán/tài khoản ngân hàng; mẫu viết tay trong CLI sẽ lệch catalog khi catalog đổi.
**Chọn:** `canonicalSample(type)` đặt cạnh validator của catalog (test: MỌI mẫu qua `validateCanonical`); `hub trigger <type> [--data '{…}']` ghép `--data` lên mẫu (nông), kiểm `me()` có `publish:events`, rồi `publish` với `idempotencyKey = trigger-<thời gian+ngẫu nhiên>` (providerTxnId/reference cũng mới mỗi lần → không bị coi là trùng). Không kiểm khuôn ở client: hub chạy `validatePublishBody` → `schema_mismatch` như mọi service (UX16 dùng chính hàm đó trong hub giả). Kiểu tự do (`order.created`) → `data = --data` hoặc `{}`.
**Đánh đổi:** event trigger mang `source: api` (service tự phát) — bên nhận xử lý tiền đã phải kiểm `source`/ghim `sourceKeys` (MS-R2, ADR-084) nên mẫu không giả được thanh toán thật. Mẫu không có `ulid` (SDK không thêm phụ thuộc) — id = base36 thời gian + 10 hex ngẫu nhiên.

## ADR-135 — VF4 runner L2 bằng TypeScript: kịch bản có tag, dev mới tự dựng thế giới mỗi lượt, script cũ chạy như tiến trình con (2026-10-11)

**Vấn đề:** `scripts/e2e-smoke.sh` là bash (CRLF, `openssl`, tên container cứng), dựa vào source seed dùng chung (kết quả lượt trước ảnh hưởng lượt sau) và chỉ phủ GitHub/SePay; `auth-e2e.ts` là script tự `process.exit`, không nằm trong `npm run verify`.
**Chọn:** `npm run verify:e2e [-- --tag smoke|VF3|VF4|auth|…]` = tầng L2 của `verify/cli/run.ts` (`verify` = L0+L1+L2, lọc tag thì không đụng bánh cóc). Kịch bản module (`ScenarioFile`: `setup` + danh sách `{name, tags, fn}`) chạy trong tiến trình; `setup` của `ingest-e2e.ts` đi ĐÚNG đường dev ngoài: đăng ký → link mail capture → key → 5 source (secret giả `.env.verify`) → endpoint trỏ sink → subscription; mỗi lượt project mới nên khoá chống trùng không va lượt trước. Assert qua HTTP công khai (polling, sink) trước, psql hubv chỉ cho thứ nhìn xuyên (raw_events, deliveries, outbox, quyền `shop_user`). Push được verify bằng `hub-sim` (không bằng code hub). Script cũ (`auth-e2e.ts`) chạy như tiến trình con, dòng `✓/✗/∅` thành hàng kết quả (`∅` = SKIP → đỏ, §4.2). Tag `@deployed-safe` + `npm run verify:deployed` (bắt buộc `VERIFY_API_URL`, không mặc định, không đăng ký/không tạo source) để VF8 dùng. `e2e-smoke.sh` thành vỏ gọi `--tag smoke` (giờ chạy vào hubv, không vào stack dev). AF:#35, AF:#39 có kịch bản, rời `acceptedOrphans`.
**Đánh đổi:** mỗi lượt để lại một user/project `l2-<run>@e2e.test` trong hubv (stack bỏ đi được, `verify:reset` dọn). psql qua `docker compose exec` chậm (~2 s/lệnh) → kịch bản chống trùng ~10 s. Script cũ chưa được tách thành module (giữ nguyên để không phá AU đã review) — nhập dần.

## ADR-136 — DX1-lite: một khuôn lỗi `{error, message, fix, docsUrl, requestId}` + `x-request-id` cho `/v1/p/*` và `/api/v1/*`; console giữ câu tiếng Việt qua `detail` (2026-10-11)

**Vấn đề:** lỗi API trả rời rạc (`{error}` trơn, `BadRequestException('câu Việt')` ra `{statusCode, message, error:"Bad Request"}`, lỗi lạ lộ message Nest), dev không biết sửa gì, admin không tra được request. Đổi `message` sang tiếng Anh (ADR-055) thì console — vốn hiện `body.message` — sẽ ra tiếng Anh.
**Chọn:** catalog `libs/common/src/errors/catalog.ts` gồm MỌI mã mà hai nhóm route đang ném (giữ nguyên mã cũ như `slug_taken`, `outside_read_types` — đổi mã = breaking; thêm mã suy từ status: `bad_request`, `forbidden`, `conflict`…; bỏ `reserved_type`/`endpoint_unreachable` của spec vì không có đường nào ném). `ServiceExceptionFilter` (global, chỉ biến đổi khi path là `/v1/p/` hoặc `/api/v1/`; route khác giữ mặc định Nest) dựng body từ catalog; tham số = CHỈ trường khai ở `params` của mã; câu gốc của code hub ra `detail` (không có cho `not_found` — UX2 — và 5xx); lỗi lạ/5xx → `internal_error` không lộ gì, log đủ kèm requestId; lỗi body-parser (JSON hỏng/quá lớn) → 400/413 thay vì 500. Middleware `x-request-id` (nhận id client nếu `[A-Za-z0-9._-]{8,128}`, không thì UUID). Web: `errorMessageOf` ưu tiên `detail` → câu Việt theo mã → `message` (UI tiếng Việt không đổi). Publish: kết quả lỗi của lõi ingest đi qua filter (thêm `source_inactive`). Endpoint: `verificationFix` cạnh `verificationError`; `ssrf_blocked` nêu cả hai đường (deployed: URL công khai/`SHOP_PUBLIC_URL`; local: `hub listen`). SDK: message của `HubError` kèm `fix` + `requestId`. GenericAdapter.buildAck lỗi có `fix`. Giải thích tiếng Việt: `docs/ERRORS.md` (test: mỗi mã một `## <mã>`; test quét `apps/hub-api/src` đỏ nếu ném mã chưa có trong catalog).
**Đánh đổi:** body lỗi console đổi khuôn (`statusCode` mất, `message` thành tiếng Anh) — client ngoài web đọc `message` phải chuyển sang `detail`/`error`. `detail` chưa có bản tiếng Anh. Lỗi 401/422 ở `/hooks` do lõi ingest trả thẳng, KHÔNG qua `buildAck` → `fix` của GenericAdapter hiện chỉ tới được ack lỗi đi qua adapter (đưa vào CAN-ADMIN-QUYET-DX, không tự sửa đường nóng của mọi provider). CORS chưa `expose` header `x-request-id` (web đi qua proxy cùng origin nên không cần).

## ADR-137 — VF5 L3 chaos: phá giữa luồng request đang bay, provider gửi lại, Postgres phán 0 mất / 0 trùng (2026-10-11)

**Vấn đề:** BB-2/BB-3 mới được chứng minh bằng tay (REVIEW-CHECKLIST "✅ một phần" vì không được restart) — không có kịch bản tự động "kill giữa chừng → 0 mất, 0 trùng".
**Chọn:** `npm run verify:chaos [-- --tag chaos-api|chaos-worker|chaos-rabbit|chaos-redis|chaos-pg]` = tầng L3 (`verify:all` = L0→L3), `verify/scenarios/chaos-l3.ts`: dev mới + source GitHub + endpoint sink; bắn LUỒNG id mới liên tục (hub-sim) và phá BẤT ĐỒNG BỘ giữa luồng (`docker compose -p hubv kill -s SIGKILL hub-api|hub-worker`, `restart rabbitmq`, `stop redis`, `FLUSHALL`, `pause postgres` 5 s) — `spawn` chứ không `spawnSync`, vì spawnSync chặn event loop làm luồng request đứng im đúng lúc cần phá (lần chạy đầu "kill hub-api" không làm request nào lỗi). Hành xử như provider: id nào không 2xx thì gửi lại tới khi 2xx. Postgres phán theo delivery id: đúng 1 raw ACCEPTED, 1 event, 1 delivery SUCCEEDED, 0 delivery trùng; BB-3: mọi id đã nhận 2xx lần đầu đều có raw_event. Kịch bản kill api tự đỏ nếu không request nào lỗi (phá không trúng). `guarded()` luôn unpause/start lại mọi container hubv.
**Đánh đổi:** ~5–6 phút, đè hubv (không chạy song song phiên khác đang dùng hubv). Kết quả lần đầu: kill api 455 id (60 lỗi gửi lại) · kill worker 653 · restart rabbit 948 · Redis tắt 20×3 · FLUSHALL 20×2 · pause pg 517 (4 lỗi) → tất cả 0 mất / 0 trùng. Mức "đỏ khi phá" (probe P-BB3-01/02) thuộc VF6.

## ADR-138 — Kết nối hai đầu: console tạo endpoint (hub sinh `whsec_`), hub tự đăng ký URL ingest tại provider (biến thể A), credentials provider lưu mã hoá theo project (2026-10-11)

**Vấn đề:** dev phải làm tay ở cả hai đầu: tạo source rồi sang dashboard PayOS dán URL (cạm bẫy 4), và tự đăng ký endpoint bằng code. Console `POST /api/v1/destinations` không sinh `whsec_`, không challenge. Admin: "chỉ cần nhập hoặc điền, verify ở hub và nó kết nối tới bên thứ 3 luôn".
**Chọn:** spec gộp `_bmad-output/planning-artifacts/hub-multi-service/SPEC-ket-noi.md` (KN1–KN6).
- KN1: `EndpointService` dùng chung cho console và API service. Hub sinh `whsec_` (trả 1 lần), có challenge, subscription tạo cùng tx. `ensure()` vẫn nhận secret của service. Shop giữ allowlist hai lớp.
- KN2–KN4: connector là năng lực tuỳ chọn `adapter.connector?` (không `switch(provider)` trong lõi). Thứ tự: source + secret COMMIT, sau đó mới gọi API provider. PayOS dùng `webhooks.confirm` (có cảnh báo ghi đè). Stripe dùng `POST /v1/webhook_endpoints` (provider sinh secret, hub lưu).
- Credentials **được lưu** (Admin bác "dùng một lần rồi quên", theo cách AWS/Jira) trong `source_connections.credentials_encrypted` (AES-GCM `MASTER_KEY`), chỉ ghi không đọc, không vào log/audit, có RLS + `manage:sources`, có nút xoá credentials.
- Base URL provider tường minh. `*_FAKE_BASE_URL` chỉ ngoài production, vì SDK PayOS tự đọc `PAYOS_BASE_URL`.
- GitHub (KN5) viết nhưng hoãn. SePay chờ Admin xác nhận có đăng ký được OAuth app. Biến thể B (hub đọc `/.well-known/hub` của service) để backlog.
**Đánh đổi:** hub giữ credentials có quyền GHI bên thứ ba (key PayOS tạo được link thanh toán). An toàn chỉ ngang `MASTER_KEY`: lộ DB thôi thì chưa sao, lộ DB + env thì lộ hết (chưa có KMS/xoay khoá). PayOS chỉ có một URL/kênh, nên kết nối sẽ thay URL cũ của dev. Chưa rõ request kiểm tra của PayOS có bị normalize ra `payment.received` không (KQ1), phải có bằng chứng trước khi code. Kết nối chỉ chạy khi `HUB_PUBLIC_URL` public (local cần named tunnel).

## ADR-139 — Ack từ chối ở `/hooks` (401 chữ ký, 422 thiếu khoá chống trùng) đi qua `adapter.buildAck`; status do lõi giữ (Q1 = a, 2026-10-11)

**Vấn đề:** lõi ingest trả 401/422 thẳng (`{error: '…'}`) nên `fix` của GenericAdapter (ADR-136) không bao giờ tới dev cấu hình nguồn tuỳ chỉnh; định dạng ack của provider (PayOS `{code,desc,data}`, SePay `{success,message}`) chỉ áp cho ack thành công.
**Chọn:** Admin chọn (a): hai chỗ đó gọi `rejectAck(adapter, 401|422, <hằng của lõi>)` → `{status: <lõi giữ>, body: adapter.buildAck({accepted:false,…}).body}`. Adapter chỉ quyết body, KHÔNG đổi được status; `message` là hằng của lõi (không secret, không body request); buildAck ném lỗi → body cũ. Hàm thuần sau `storeRejected` như trước: thứ tự BB-3, số lệnh Redis, ghi REJECTED không đổi. GitHub/Stripe/API body giữ nguyên (`{error}`); SePay → `{success:false,message}`, PayOS → `{code:'01',desc,data:null}`, Generic → `{ok:false,error,fix}`. Test `ingest-reject-ack.spec.ts` (5 provider, status không đổi, không lộ secret/body).
**Đánh đổi:** body 401/422 của SePay/PayOS/Generic đổi khuôn — provider thật không đọc body ack lỗi (chỉ status) nên không ảnh hưởng gửi lại; ai parse body cũ `{error}` của ba provider này phải đổi. fixture hub-sim chỉ kỳ vọng status (không vỡ).

## ADR-140 — P2: console thấy được tính chất webhook — `trace.ingested` (trùng/chữ ký sai) trên Hành trình + Bản đồ luồng; cột "Xác minh" ở trang Đích; `/api/v1/destinations` trả bản công khai (2026-10-11)

**Vấn đề:** request trùng (DUPLICATE) và chữ ký sai (REJECTED) không sinh event nên người xem demo không thấy chúng; `trace-feed.tsx` có sẵn nhưng không trang nào gắn. Đích FAILED (vd `ssrf_blocked`) bị hub bỏ qua mà console không hiện. `GET /api/v1/destinations` trả nguyên hàng Prisma (kể cả `configEncrypted`/`signingSecretEncrypted`) và không có `hasSigningSecret`, nên cột "Ký HMAC" luôn ghi "không".
**Chọn:** gắn `<TraceFeed />` (dải + toast) ở Hành trình sự kiện, `<TraceFeed toastsOnly />` ở Bản đồ luồng (canvas toàn màn hình, chỉ toast). Hàm thuần `consoleDestination()` (`apps/hub-api/src/modules/api/destination-view.ts`) cho list/create/patch: bỏ blob mã hoá, thêm `hasSigningSecret`, `verification`, `verificationError`, `verificationFix`, `verifiedAt`, `managedByService`. Web thêm cột "Xác minh" (`describeVerification` trong `ui-logic.ts`, lý do tiếng Việt theo mã). Vẫn đi qua `forTenant` (BB-5). Test `destination-view.spec.ts`, `ui-logic.spec.ts`.
**Đánh đổi:** ai đọc `configEncrypted` từ API console sẽ không còn thấy (không có ai trong repo). Lý do tiếng Việt của mã xác minh nằm ở web, song song với `verificationFix` tiếng Anh của hub — thêm mã mới phải sửa hai chỗ (mã lạ vẫn hiện nguyên mã).
**Đính chính (ADR-144, review L-7):** câu "trả nguyên hàng Prisma, lộ `configEncrypted`/`signingSecretEncrypted`, không có `hasSigningSecret`" là SAI — `ApiController` đã có `RedactSecretsInterceptor` ở mức class, đổi hai trường đó thành `hasConfig`/`hasSigningSecret`. Trước P2 không có rò rỉ ciphertext. Giá trị thật của `consoleDestination()`: danh sách trắng (phòng thủ nhiều lớp) + thêm các trường xác minh.

## ADR-141 — P1: Shop nhận tiền THẬT — link PayOS thật (fetch + crypto), VietQR thật cho SePay, hạn đơn 30 phút cấu hình được, tiền về đơn hết hạn không mất âm thầm; nâng trần `apps/shop/src` lên ~450 dòng (2026-10-11)

**Vấn đề:** web luôn gửi `paymentProvider: "sepay"`; Shop không gọi PayOS (biến `PAYOS_*` bỏ không); QR ở checkout là ảnh qrserver của chuỗi "DHxxx số tiền" — không ngân hàng nào quét được; `payosPaymentLinkId: link_<code>` là giá trị giả; đơn hết hạn sau 15 phút nên trả chậm thành EXPIRED. Admin cần trả tiền thật qua PayOS trên production. Trần ~300 dòng (tính cả `apps/shop/src`, đang 405) không đủ cho việc tạo link thật.
**Chọn:** (1) `apps/shop/src/payos.ts`: `POST {SHOP_PAYOS_API_BASE|https://api-merchant.payos.vn}/v2/payment-requests` với `x-client-id`/`x-api-key`, chữ ký HMAC-SHA256(checksumKey) trên `amount&cancelUrl&description&orderCode&returnUrl`; kiểm chữ ký phản hồi (khoá `data` a→z) bằng `timingSafeEqual` trước khi tin `checkoutUrl`. Không thêm dependency; test đối chiếu chữ ký với SDK `@payos/node` (đã có ở libs/providers) làm oracle, fetch giả — không gọi PayOS thật. Tên base riêng của Shop (không đặt `PAYOS_BASE_URL`, SDK của hub đọc biến đó — SPEC-ket-noi §4.5); khoá dùng chung kênh `PAYOS_CLIENT_ID/API_KEY/CHECKSUM_KEY`. (2) Mã đơn đổi thành `DH` + 7 chữ số (9 ký tự = giới hạn `description` của PayOS với tài khoản không liên kết); `orderCode` PayOS = phần số. `description` = mã đơn nên webhook PayOS → hub → `payment.received.data.memo` vẫn chứa `DH\d+`; khớp đơn vẫn chỉ ở `apps/shop` (BB-1), hub không đổi. `payos_payment_link_id` giờ lưu id thật. (3) SePay: VietQR thật `img.vietqr.io/image/<SHOP_BANK_CODE>-<SHOP_BANK_ACCOUNT>-compact2.png?amount&addInfo=<mã đơn>`; thiếu cấu hình → `qrImageUrl: null`, web nói rõ, không còn QR giả. Web cho chọn PayOS/SePay (mặc định PayOS nếu `GET /payment-options` báo có), có nút "Mở trang thanh toán PayOS". (4) Hạn đơn `SHOP_ORDER_TTL_MIN` (mặc định 30); link PayOS đặt `expiredAt` = hạn đơn nên PayOS từ chối trả muộn. Tiền vẫn về đơn đã hết hạn (chuyển khoản thẳng): giữ quyết định ADR-034 (KHÔNG hồi sinh, cộng `paidAmount` trong cùng transaction FOR UPDATE + dedupe), nhưng không còn âm thầm: log cảnh báo như cũ, khách thấy "đã hết hạn nhưng Shop đã nhận X — gọi hotline để giao món/hoàn tiền", `POST /api/internal/reconcile` trả thêm `lateMoneyOrders`. (5) Trần `apps/shop/src` nâng lên ~450 dòng (hiện 443): bỏ `payosPaymentLinkId` giả, bỏ tra đơn theo UUID (không ai dùng), gọn vài khối.
**Đánh đổi:** không gian mã đơn còn 9×10⁶ (trùng thì sinh lại; PayOS cấm lặp `orderCode` trong một kênh — trùng hiếm, khi đó tạo link lỗi 502 và khách tạo lại). Đơn PENDING có mã DH+10 số cũ vẫn khớp (regex không đổi). Ảnh QR PayOS vẽ qua api.qrserver.com (chuỗi VietQR đi qua bên thứ ba; chỉ chứa số tài khoản/số tiền/nội dung) để không thêm thư viện QR vào web. Nếu PayOS chèn tiền tố có dạng `DH<số>` vào nội dung chuyển khoản thì có thể khớp nhầm — chưa thấy, ghi lại để kiểm khi trả tiền thật. Hồi sinh đơn hết hạn khi đủ tiền là lựa chọn của Admin (CAN-ADMIN-QUYET-P1P2 Q1).
**Đính chính (ADR-144, review M-1/L-1):** (a) câu "link PayOS hết hạn cùng lúc nên trả muộn chỉ còn với SePay" là SAI — hạn đơn từng xét theo lúc webhook TỚI Shop, nên khoản trả ở phút 29:50 qua PayOS vẫn có thể thành EXPIRED khi hub/Shop cold start. ADR-144 sửa (link PayOS hết hạn sớm hơn 5 phút + xét hạn theo `paidAt`). (b) Ảnh QR của nhánh PayOS VẪN vẽ qua api.qrserver.com (commit a9bea33 ghi "bỏ QR giả qrserver" là chỉ đúng cho nhánh SePay); chấp nhận tạm, Admin quyết ở CAN-ADMIN-QUYET-P1P2 Q3.
**Thay một phần (ADR-154, 2026-10-12):** tiền ĐỦ về đơn hết hạn → PAID; QR PayOS vẽ tại trình duyệt (`qrcode.react`), Shop không còn gọi api.qrserver.com.

## ADR-142 — KN1: console tạo endpoint qua `EndpointService` dùng chung; ranh giới console ↔ service ở xoay secret; catalog chỉ siết `payment.*`/`repo.*` (2026-10-11)

**Vấn đề:** SPEC-ket-noi KN1 cần console tạo endpoint như API service (hub sinh `whsec_`, challenge, subscription cùng tx) mà không chép code; còn chừa: ai được xoay secret của endpoint do service (Shop) tạo, "kiểm theo catalog" nghĩa là gì khi service publish kiểu riêng (`order.*`), và route `POST /destinations` cũ.
**Chọn:** lõi tạo/verify ở `apps/hub-api/src/modules/service-api/endpoint.service.ts` (TX tạo PENDING + audit + `within()` của bên gọi → COMMIT → challenge ngoài tx → ghi kết quả); `ServiceResourcesController` và `ConsoleEndpointsController` (controller riêng, không sửa `ApiController`) cùng gọi. Console: `POST /api/v1/endpoints` (subscription + kiểm `sourceIds` NẰM TRONG tx — lỗi rollback cả endpoint; id lạ/sai khuôn/khác project → cùng một 404), `GET /endpoints/:id`, `POST /endpoints/:id/verify` (WindowLimiter 5/phút, instance riêng của controller), `POST /endpoints/:id/rotate-secret` (chỉ endpoint `createdByKeyId = NULL`; của service → 409 `endpoint_owned_by_service`; không challenge lại vì service chưa biết secret mới, trạng thái giữ nguyên), `GET /catalog/event-types` (UI tick từ catalog). `eventTypes`: ngữ pháp như cũ + trong `payment.*`/`repo.*` phải khớp catalog (`payment.recieved` → 422), ngoài không gian dành riêng thì tự do. `POST /destinations` với `type:"webhook"` → 422 `use_endpoints_route`. Actor console = `user:<id>`.
**Đánh đổi:** xoay secret ở console không có thời gian chồng (KN1b tuỳ chọn): delivery giữa lúc xoay và lúc service cập nhật env bị từ chối → retry/DLQ, replay được. Trần /verify đếm riêng cho console và cho `/v1/p` (một endpoint tối đa 10 lần/phút nếu gọi cả hai phía). E2E TA9 đổi đích mẫu từ webhook sang discord (route cũ không còn tạo webhook).

## ADR-143 — Review DX-A M-1/L-5: `after=latest` có trần (10 lô × 1000) rồi 503 + Retry-After; `listen` thử lại 429/503 theo Retry-After (trần 30 s) (2026-10-11)

**Vấn đề:** `latestPollCursor` lặp `assignPollSeq` không trần trong một request — project chỉ dùng push (Shop) tích luỹ event `poll_seq IS NULL`, lần đầu `listen` có thể chạy hàng trăm transaction giữ advisory lock (M-1). `listen` thoát khi poll gặp 429 (L-5).
**Chọn:** tối đa `maxRounds` (10) lô × `batch` (1000) mỗi request; còn tồn → repo trả `null`, controller 503 `service_unavailable` `{retryAfter: 1}` + header `Retry-After` (filter đặt header khi body có `retryAfter`; 503 log `warn` không phải `error`). KHÔNG trả max tạm: event tồn cấp sau sẽ có cursor lớn hơn và bị `listen` coi là mới (dội lịch sử) — "latest" phải nằm sau MỌI event đã commit. Mỗi lô vẫn là transaction ngắn dưới advisory lock theo tenant, đọc qua `TenantScopedRepository` (RLS giữ nguyên). CLI: `--from latest` thử lại khi 0/5xx/429; vòng poll coi 429 như lỗi tạm; 429/503 có Retry-After (header hoặc `retryAfter` của body, SDK `HubError.retryAfter`) thì chờ đúng số giây, trần 30 s, không có thì bậc 1/2/5 s.
**Đánh đổi:** backlog > 10 000 event → `listen` khởi động chậm vài vòng 1 s (mỗi vòng tiến 10 000). Trần cố định trong code (không env).

## ADR-144 — Review P1/P2: hạn đơn xét theo `paidAt`, link PayOS hết hạn sớm 5 phút, chỉ cộng tiền đúng kênh, chọn mã đơn có thật trong DB (2026-10-11)

**Vấn đề:** review P1/P2 (`_bmad-output/planning-artifacts/REVIEW-P1P2-2026-10-11.md`). M-1: hạn đơn so với lúc webhook TỚI Shop; link PayOS hết hạn đúng bằng hạn đơn → trả ở phút 29:50 + cold start Render = EXPIRED. M-2: một tài khoản đứng sau cả PayOS lẫn SePay → một lần chuyển sinh hai `payment.received` khác event-id → cộng đôi. M-3: `/DH\d+/` không neo lấy lần khớp đầu → tiền tố PayOS có "DH<số>" làm tiền thật không gắn vào đơn nào.
**Chọn:** (M-1) `applyPayment(order, amount, paidAt)` xét hạn theo `data.paidAt` của kiểu chuẩn `payment.received` (đã có trong EVENT-CATALOG, không thêm từ vựng PayOS vào Shop), chặn ≤ now (đồng hồ provider lệch về tương lai không gia hạn được). Trả đúng hạn thì tính như đơn mở, kể cả khi cron đã EXPIRE trước khi webhook tới; trả SAU hạn vẫn giữ ADR-034 (không hồi sinh, ghi nhận tiền). Link PayOS `expiredAt` = hạn đơn − 5 phút (tối đa nửa TTL). (M-2) Shop chỉ cộng khi `source === order.paymentProvider` (đơn cũ không ghi kênh thì cộng); kênh khác → 200 `OTHER_CHANNEL` + log cảnh báo đối soát, không ghi event-id. (M-3) lấy MỌI `DH`+7 số / `DH`+10 số (mã cũ) trong memo rồi reference, khoá `WHERE order_code = ANY(...) FOR UPDATE`, chọn mã có thật đầu tiên. Kèm: L-2 `GET /orders/:code` hiển thị hết hạn lười; L-3 PayOS trả `231` (orderCode đã tồn tại) → đổi mã đơn, thử lại một lần; L-4 `orderTtlMs(env)` thuần; L-5 `payosLinkInput()` thuần có test (giây, ≤ 9 ký tự, orderCode số, sớm hơn hạn); L-6 đổi project xoá `traces`; gate `shop-size` đo TỔNG `apps/shop/src` ≤ 450 (hàm `checkAll` mới trong `verify/lib/gates.ts`). `apps/shop/src` = 444 dòng.
**Đánh đổi:** tin `paidAt` của provider (nguồn đã ghim sourceId, R-1) — provider ghi lùi giờ thì khoản trễ thành đúng hạn (chấp nhận: tiền đã về thật). Khoản `OTHER_CHANNEL` không cộng vào đơn (không có trong `paidAmount`, chỉ ở log/console hub) — nếu hai kênh là HAI tài khoản khác nhau và khách cố ý chuyển sang kênh kia thì tiền đó phải đối soát tay. Mã đơn có độ dài khác 7/10 số không còn khớp (không ai tạo). Mã PayOS `231` lấy từ bảng mã lỗi PayOS, chưa thấy tận mắt.
**Bổ sung (review vòng 2, 2026-10-11):** R2-L1 — hai bản sửa ngược nhau ở phía hiển thị: `GET /orders/:code` báo EXPIRED đúng lúc hết hạn (L-2, cron cũng ghi EXPIRED) nên web ngừng hỏi, trong khi M-1 vẫn có thể đưa đơn sang PAID khi webhook của khoản trả đúng hạn tới muộn. Chọn cách đơn giản hơn, chỉ sửa ở web: EXPIRED **chưa** là trạng thái cuối cho tới `expiresAt + 6 phút` (dài hơn biên 5 phút của link PayOS). Web tiếp tục hỏi và hiện "Đơn đã quá hạn… Shop đang chờ xác nhận" (`apps/web/src/lib/shop/order-status.ts`, có test). Server giữ nguyên. R2-L4 — `FOR UPDATE` nhiều dòng có `ORDER BY order_code` để thứ tự khoá cố định. R2-L5 — `SHOP_PAYMENT_SOURCES` chỉ có tác dụng với `payos`/`sepay`, vì đơn chỉ mang hai kênh đó; source khác luôn thành OTHER_CHANNEL (ghi ở chú thích `PAYMENT_SOURCES`). R2-L2 — tiền OTHER_CHANNEL chưa được đếm ở reconcile vì cần thêm cột/bảng, vượt trần 450 dòng. Hiện chỉ thấy trong log Shop và trên console hub (sự kiện `payment.received` vẫn SUCCEEDED).

## ADR-145 — Sửa ADR-143 (review DX-A vòng 2, R2-M1): mỗi lô cấp `poll_seq` của `after=latest` là MỘT transaction riêng; Retry-After kẹp ≥ 1 s; `--from latest` bỏ cuộc sau 10 lần (2026-10-11)

**Vấn đề:** ADR-143 viết "mỗi lô vẫn là transaction ngắn", nhưng proxy `scopeToTenant` bọc CẢ `latestPollCursor` trong một `$transaction` tương tác (timeout mặc định 5 s): 10 lô × 1000 UPDATE commit một lần, advisory lock giữ suốt (reviewer đo: kết nối khác chỉ thấy 12000 → 2000). Trên Neon free vượt 5 s → P2028 → 500, rollback cả 10 lô, lần thử lại lặp y hệt — `listen --from latest` không bao giờ khởi động, poller cùng project bị chặn. Ngoài ra `Retry-After: 0`/rỗng của proxy thành `sleep(0)`, header dạng HTTP-date bị bỏ (R2-L1); vòng `--from latest` thử lại vô hạn (R2-L2). Code M-1/L-5 thực tế nằm ở commit `c888ef6` (lẫn KN1), `80a98bd` rỗng — không viết lại lịch sử.
**Chọn:** `latestPollCursor` thành phương thức ĐIỀU PHỐI (`ORCHESTRATED_METHODS` trong proxy): không bọc tx, chạy với `this` = proxy nên mỗi `assignPollSeq` (rồi `hasUnassignedPollSeq`, `maxPollCursor`) là một tx riêng có `app.project_id` + lock riêng, commit ngay. Test DB chạy bằng `hub_app` (RLS bật) chứng minh kết nối khác thấy tiến độ giữa các lô (5 → 3 → 1). SDK `parseRetryAfter` hiểu số giây và HTTP-date, header hỏng thì lấy `retryAfter` của body; CLI kẹp [1 s, 30 s]. `--from latest` thoát mã 1 sau 10 lần, in `fix` của hub (hoặc gợi ý kiểm `/health`) + `--from <cursor>`.
**Đánh đổi:** gọi `latestPollCursor` bên trong một tx có sẵn thì các lô vẫn chung tx đó (không tránh được, hiện không có chỗ nào gọi vậy). Hai `listen` cùng lúc trên backlog lớn xen lô nhau — đúng, vì mỗi lô dưới advisory lock. R2-L3 (413/404/429 của `/hooks` chưa qua `rejectAck`): không làm — 413 xảy ra TRƯỚC khi nạp adapter, đổi thứ tự là chạm đường nóng; ghi ở RESUME-dx.

## ADR-146 — KN2: khung connector — năng lực `adapter.connector?` + bảng `source_connections` (RLS, FK ghép) + thứ tự commit-trước-gọi-provider; fake provider trong sink (2026-10-11)

**Vấn đề:** SPEC-ket-noi KN2 cần một khung chung để hub tự đăng ký URL ingest tại provider mà lõi không biết provider nào, credentials lưu được mà không bao giờ lộ, và CI không gọi provider thật.
**Chọn:** `ProviderConnector` (spec.fields/sourceSecretField/overwriteWarning/keyHint/manualDisconnect/defaultBaseUrl/fakeBaseUrlEnv + connect/status?/disconnect?) là thuộc tính tuỳ chọn của adapter; mọi thứ khác lõi đọc từ `spec` — "secret ký do dev nhập" (`sourceSecretField`), "phải xác nhận ghi đè" (`overwriteWarning` → 422 `overwrite_not_acknowledged`) — nên lõi không có `if (provider === …)` (test gate trong `source-connections.spec.ts`, probe P-KN1). `SourceConnectionService` (console, `manage:sources` mọi route): TX tạo source + SourceSecret + kết nối PENDING + audit → COMMIT → gọi provider ngoài tx → TX ghi CONNECTED/FAILED (+ SourceSecret do provider sinh) + audit chỉ tên trường. FAILED giữ source; retry dùng credentials đã lưu. Kết nối lại mà provider cấp id mới → gỡ cái cũ; secret ký mới thì version cũ sống thêm 24 giờ. `GET …/connection` gọi `status?` tối đa 1 lần/phút (đọc `last_checked_at`, 0 lệnh Redis) và báo DRIFTED khi `HUB_PUBLIC_URL` đổi. Bảng `hub.source_connections` (credentials AES-GCM, RLS+FORCE, policy như các bảng tenant, FK ghép `(source_id, tenant_id)` → thêm unique `sources(id, tenant_id)`, GRANT hub_app). Base URL: `connectorBaseUrl(spec)` — production luôn URL cứng; ngoài production đọc `spec.fakeBaseUrlEnv`. Production có biến `*_FAKE_BASE_URL` (luật theo hậu tố) hoặc `CONNECTOR_INGEST_BASE_URL` (URL ingest cho stack kiểm chứng, nơi `hub-api` là tên một nhãn) → app không khởi động. `HUB_PUBLIC_URL` localhost / IP nội bộ / tên một nhãn → 422 `public_url_required` trước khi gọi provider. Fake PayOS/Stripe ở `tools/verify-sink/fake-providers.js` (cộng thêm, ghi vào `/_requests`).
**Đánh đổi:** credentials có quyền ghi bên thứ ba chỉ an toàn ngang `MASTER_KEY` (ADR-138). Hai lần bấm "Kết nối" song song tạo hai source (không khoá theo provider). Ngắt kết nối khi provider từ chối xoá → 409, trạng thái giữ nguyên. Gate P-KN1 nằm trong test L0 của KN thay vì `verify/lib/gates.ts` (file đó phiên VF đang sửa).

## ADR-147 — VF6 `verify:probe` + `verify:bb`: đột biến nhắm đích trong git worktree tạm dưới `.claude/worktrees/`, test đích BB ở L0 (2026-10-11)

**Vấn đề:** 27 file `verify/probes/*.json` đã có (AU, BB5, MS) nhưng chưa có runner; §6.3 còn thiếu probe BB-1/2/3, chữ ký, SSRF; §8.2 cần bảng "xanh trên code thật / đỏ khi phá" cho 5 bất biến. Probe BB-3 của spec nhắm chaos L3 — cần build lại image hubv từ code đã phá cho mỗi probe.
**Chọn:** `npm run verify:probe -- P-… | --all [--overlay a,b]`: mỗi probe một `git worktree add --detach HEAD` dưới `.claude/worktrees/probe-<id>-<pid>` (jest.config đã bỏ qua `.claude/`, node_modules của repo vẫn tìm được khi đi ngược lên), chép đè test đích + `--overlay` từ cây làm việc, áp `find→replace` (khớp trên bản LF, ghi lại đúng CRLF/LF; khớp 0 = "probe MỤC", >1 = mơ hồ — đều đỏ; `replace` chèn nguyên văn), chạy jest đúng tầng (L1 dùng env hubv §4.3), phán `expectRed` (≥ 1 test khớp đỏ) / `expectGreen` (probe sống sót, vd P-BB5-01), rồi xoá worktree. VT11: so nội dung các file bị nhắm trước/sau + không còn worktree `probe-*` (KHÔNG so cả `git status` — phiên khác sửa cây song song). `ownerAsApp` (P-VT12-01): đổi môi trường thay vì code — test RLS chạy bằng owner phải tự đỏ. 8 probe mới: P-BB1-01, P-BB2-01, P-BB3-01 (COMMIT lỗi vẫn ACK), P-BB3-02 (ack trước khi ghi), P-SIG-01, P-SIG-02, P-SSRF-01, P-VT12-01; test đích mới `apps/hub-api/test/ingest-invariants.spec.ts` ([BB:3] a/b, [BB:2] a), `[BB:3] (phần c)` trong delivery-consumer.spec, `verify/test/bb-invariants.spec.ts` ([BB:1], [BB:4]). `npm run verify:bb` in bảng 5 dòng.
**Đánh đổi:** worktree từ HEAD → code chưa commit KHÔNG được probe (chỉ test đích/overlay được chép đè). ~2,5 phút/probe (ts-jest biên dịch lạnh trong đường dẫn mới) → `--all` ~1,5 giờ ở máy dev; CI chạy đêm. Probe BB-3 ở L0 thay vì L3 (CAN-ADMIN-QUYET-VF Q1); P-BB2-01 phá ở code thay vì bỏ constraint (Q2). Biến thể "transaction chạy nền không await" làm tiến trình jest chết vì unhandled rejection nên P-BB3-01 dùng "lỗi vẫn ACK" — cùng hậu quả 2xx khi chưa COMMIT.

## ADR-148 — VF8 demo + CI e2e/chaos: một kịch bản 14 bước có tự kiểm, chưa có reset deployed (2026-10-11)

**Vấn đề:** thứ tự demo nằm rải ở 4 tài liệu; tập dượt bằng tay không lặp lại được; CI chỉ có L0/L1 (L2/L3 chạy tay); chưa có RUNBOOK / trang cho hội đồng.
**Chọn:** `verify/demo/steps.yaml` (14 bước §9.1: say/do/expect/env/timeoutS, tổng ngân sách ≤ 11') là nguồn duy nhất — ARCHITECTURE §12 trỏ về đây. `npm run demo:run -- --step N` in lời thoại, chờ Enter, rồi TỰ KIỂM nếu bước có `check` (chỉ bước LOCAL: bước 6 = chaos `chaos-worker`, bước 9 = e2e `demo-redeliver`); `demo:rehearse` ghi `verify/results/rehearsal-<ngày>.md`; `demo:reset -- --env local` = `verify:reset` + `verify/demo/seed-demo.ts` (dev demo + 200 event nền); `demo:warm` bắt buộc `DEMO_WARM_URLS` (không mặc định). CI: job `e2e` mọi push (compose hubv + `VERIFY_WITH_WEB=1` để kịch bản web không SKIP), job `chaos` đêm + bấm tay (`verify:chaos` + `verify:probe --all`). `docs/RUNBOOK.md`, `docs/FOR-EXAMINERS.md`, `verify/demo/PREFLIGHT.md`.
**Đánh đổi:** `demo:reset --env deployed` CHƯA làm — cần API operator xoá dữ liệu trên production (CAN-ADMIN-QUYET-VF Q4) → lệnh từ chối rõ ràng, VT14 mồ côi có lý do. Bước deployed không bao giờ tự kiểm từ máy dev. FOR-EXAMINERS để ô `‹…›` cho Admin điền URL/tài khoản thật. Job e2e build image mỗi push (~10 phút runner).

## ADR-149 — KN3: "Kết nối PayOS" gọi `confirm-webhook` bằng `fetch` (không qua SDK), `acknowledgeOverwrite` bắt buộc; KQ1 để TODO có hook trong PayosAdapter (2026-10-11)

**Vấn đề:** spec KN3 bảo dùng `new PayOS(...).webhooks.confirm()`. SDK 2.0.5 nối path tuyệt đối vào `baseURL` (fake `/_fake/payos` mất tiền tố), tự đọc `PAYOS_*` env, tự retry (mỗi lần PayOS lại bắn request kiểm tra), log debug có header. KQ1 (request kiểm tra có thành `payment.received`?) chưa có bằng chứng bản thật; tài liệu không có cờ nhận diện.
**Chọn:** connector `libs/providers/src/connectors/payos.connector.ts`: `POST {base}/confirm-webhook` (header `x-client-id`/`x-api-key`, body `{webhookUrl}`, timeout 20 s, không retry, không log header) — cùng API/header/body như SDK. `spec.sourceSecretField = checksumKey` (SourceSecret v1 COMMIT trước khi gọi), `overwriteWarning` → bắt buộc `acknowledgeOverwrite: true`, không `status?`/`disconnect?` (`manualDisconnect` hướng dẫn đổi URL ở dashboard). Display `<accountName> · ****<4 số cuối>`. KQ1: hook `isPayosConfirmProbe()` trong PayosAdapter (BB-1) hiện luôn `false` + TODO; `[KN:U16]` mồ côi có lý do; câu hỏi + đề xuất (ra `payos.webhook_test`, `normalized:false`) ở CAN-ADMIN-QUYET-KN.md.
**Đánh đổi:** tự viết lời gọi HTTP thay SDK chính chủ — PayOS đổi API confirm thì phải sửa tay (SDK cũng chỉ là một POST). Tới khi có bằng chứng KQ1, request kiểm tra (nếu đúng chữ ký) đi như giao dịch thường: service subscribe `payment.received` mà không tra theo đơn có thể thấy khoản 3.000đ "ma" lúc kết nối. Shop an toàn (allowlist + tra mã đơn).

## ADR-150 — KN4: "Kết nối Stripe" — `fetch` form-encoded tới `/v1/webhook_endpoints`, chỉ đăng ký 3 event có trong catalog, secret do Stripe sinh thành SourceSecret; `gone` → FAILED (2026-10-11)

**Vấn đề:** SPEC-ket-noi KN4: dev không nhập secret ký; kết nối lại phải tạo endpoint mới (secret chỉ trả lúc tạo) mà không làm rớt event đang chuyển; cần map kết quả `status?` vào trạng thái kết nối.
**Chọn:** `libs/providers/src/connectors/stripe.connector.ts` (không thêm SDK): `POST {base}/v1/webhook_endpoints` (`url`, `enabled_events[]` = khoá của `STRIPE_PAYMENT_TYPES` — tách ra `stripe-types.ts` để adapter và connector dùng chung, không đăng ký event mà normalize không hiểu), `secret` → `sourceSecret`; `GET` so `url` với `ingest_url` (`drifted`), 404 → `gone`; `DELETE` (404 coi như đã ngắt). Khung KN2: kết nối lại có `remoteRef` mới → xoá `we_` cũ, SourceSecret mới, bản cũ `valid_until = now + 24h`. Trạng thái: `gone` → FAILED `remote_gone` + fix "Kết nối lại". Ô form duy nhất là restricted key (`keyHint` nói rõ chỉ bật Webhook Endpoints: Write).
**Đánh đổi:** event Stripe khác 3 kiểu catalog không tới hub nữa (trước đây dán tay có thể bật mọi event → `stripe.<type>` `normalized:false`); muốn thêm thì mở rộng `STRIPE_PAYMENT_TYPES`. Display lộ `we_…` (không nhạy cảm). Probe `P-KN4-01` (không gỡ `we_` cũ) làm `[KN:U15]` đỏ.

## ADR-151 — "Kết nối" gắn được vào source CÓ SẴN (giữ sourceKey); gỡ cấu hình cũ ở provider SAU COMMIT; 409 cho sourceKey trùng và lượt bấm đang chạy (2026-10-11)

**Vấn đề:** REVIEW-KN H-1: "Kết nối PayOS" luôn tạo source mới `src_payos_<ulid>`; Shop ghim `src_payos_main` (exclusive + `trustedSourceIds`) và dùng chung kênh PayOS → kết nối dời URL của kênh sang source Shop không tin, đơn không bao giờ PAID. M-1: kết nối lại Stripe xoá `we_` cũ TRƯỚC TX lưu `we_` mới + secret → TX lỗi = mất secret mới vĩnh viễn, mọi event 401. L-1: `sourceKey` trùng (UNIQUE toàn cục) → 500, dò được key của project khác. L-3: bấm hai lần → hai lượt gọi provider.
**Chọn:** `POST /api/v1/sources/:id/connect` (hoặc `sourceId` trong body `sources/connect`): source của project (khác project → 404 giống hệt id lạ), provider lấy từ source (body khác → 422), cùng khung connector (không nhánh theo provider): TX thêm SourceSecret version mới chỉ khi secret ký nhập vào khác bản HIỆN HÀNH (bản cũ `valid_until` +24h) + kết nối PENDING → COMMIT → gọi provider; đã có kết nối → kết nối lại trên chính source đó. UI mặc định "Kết nối nguồn có sẵn" khi provider đã có nguồn. `callConnect`: TX ghi kết quả COMMIT trước rồi mới gỡ cấu hình cũ ở provider (lỗi → `last_error=previous_remote_not_removed`, vẫn CONNECTED); TX lỗi → dọn cấu hình MỚI ở provider (secret của nó đã mất), ghi FAILED `save_failed` ở TX riêng, cấu hình cũ giữ nguyên. P2002 `source_key` → 409 `conflict` (`field:sourceKey`, `code:source_key_taken`) một body duy nhất. Retry giành kết nối bằng UPDATE có điều kiện (không PENDING, hoặc PENDING cũ hơn 60 s = kẹt) → lượt thua 409 `code:connection_in_progress`; `source_id` UNIQUE chặn hai lượt gắn đồng thời.
**Đánh đổi:** gắn vào source có sẵn với checksum khác = secret dán tay cũ còn verify 24 giờ (giống retry). "Tạo nguồn mới" song song (không có khoá chung) vẫn có thể tạo hai source — UI tắt nút khi đang chờ. PENDING kẹt phải đợi 60 s mới bấm lại được. `POST /api/v1/sources` (dán tay) vẫn trả 500 khi sourceKey trùng — chưa sửa ở đây.

## ADR-152 — Secret ký do NGƯỜI DÙNG nhập (checksumKey PayOS) không bao giờ tự hết hạn bản cũ; chỉ retire khi webhook thật verify bằng key mới — đối chiếu lười lúc kiểm tình trạng, không chạm ingest (2026-10-11)

**Vấn đề:** REVIEW-KN-R2 H-R2-1: `connectExisting`/`retry` thêm version cho checksumKey mới và hẹn bản cũ hết hạn +24h bất kể kết quả. PayOS `confirm-webhook` chỉ kiểm clientId/apiKey và ký request kiểm tra bằng key THẬT (bản cũ còn hạn) → dán nhầm key vẫn CONNECTED, 24 giờ sau mọi webhook thật 401, đơn không PAID; FAILED cũng hẹn hết hạn.
**Chọn:** secret do người dùng nhập (`spec.sourceSecretField`) → thêm version KHÔNG retire gì, response `secretChanged:true` (UI cảnh báo "giữ cả hai"). Retire chỉ khi có bằng chứng: lúc `GET …/connection` (đã giới hạn 1 lần/phút) đem ≤ 20 raw_events ACCEPTED từ lúc key trong credentials được lưu verify lại bằng adapter (chỉ key đó) → khớp: các version hiện hành khác `valid_until = now+24h`, xoá `secret_mismatch`; chỉ khớp version khác: `last_error=secret_mismatch` + fix "nhập lại đúng key", không retire gì; chưa có webhook: giữ cả hai. Secret do provider sinh (Stripe `result.sourceSecret`) giữ luật +24h. Chọn đối chiếu lười thay vì ghi "version đã khớp" trên đường ingest: ingest không đổi một dòng (0 lệnh Redis thêm — redis-budget giữ xanh; không thêm ghi vào TX raw_events — BB-3 nguyên vẹn; `verify(…, secrets)` không phải đổi chữ ký trả về).
**Đánh đổi:** chưa ai mở hộp kết nối thì key cũ còn hiệu lực vô thời hạn (chiều an toàn: không mất sự kiện; một key cũ của chính kênh đó vẫn ký được — rủi ro chấp nhận). Đối chiếu tốn tối đa 20 lần HMAC × số version trong request console. Chỉ áp dụng được cho adapter verify bằng body/headers đã lưu (PayOS ký trong body); adapter cần header bị che thì không đi tới kết luận → giữ cả hai. Chưa có nút "gỡ secret cũ" thủ công.

## ADR-153 — Sửa ADR-152: đối chiếu secret quyết theo webhook MỚI NHẤT, chỉ hàng ACCEPTED; GET tình trạng ghi kiểu compare-and-set (2026-10-11)

**Vấn đề:** REVIEW-KN-R3 M-R3-1: ADR-152 kết luận "confirmed" ở BẤT KỲ event nào khớp key trong credentials, cửa sổ tính từ version có giá trị đó → PayOS xoay A→B, dán B, webhook ký B, rồi dán nhầm lại A (A còn hiện hành, không thêm version) → event cũ ký A "xác nhận" A → B (key đúng) hết hạn sau 24 giờ, không cảnh báo. L-R3-1: `status()` ghi `status` vô điều kiện → GET song song đè kết quả của lượt connect đang chạy bằng PENDING đã đọc. L-R3-2: ADR-152 nói "ACCEPTED" nhưng code không lọc.
**Chọn:** cửa sổ = từ version hiện hành cũ nhất; duyệt raw_events `status=ACCEPTED` (lọc ở repo) theo `received_at` giảm dần, event ĐẦU TIÊN verify được bằng bất kỳ version hiện hành nào quyết định rồi dừng: khớp key nhập → retire các bản khác (+24h); chỉ khớp bản khác → `secret_mismatch`, không retire. `status()` cập nhật bằng `updateSourceConnectionIf` (WHERE status + updated_at đã đọc); thua thì đọc lại bản mới nhất. Test `[KN:U27]`, `[KN:U28]`, `[KN:U29]`.
**Đánh đổi:** event mới nhất là một lượt gửi lại muộn ký bằng key trước khi xoay → báo `secret_mismatch` tạm thời cho tới webhook kế tiếp (chiều an toàn: không retire gì). GET thua compare-and-set thì không ghi `last_checked_at` → lần GET sau kiểm lại (rẻ).

## ADR-154 — Admin chốt P1/P2: tiền ĐỦ về đơn đã hết hạn → PAID (thay "không hồi sinh" của ADR-034/141/144); QR PayOS vẽ tại trình duyệt (bỏ api.qrserver.com); hai kênh dùng chung một tài khoản (2026-10-12)

**Vấn đề:** CAN-ADMIN-QUYET-P1P2. Q1: khách trả ĐỦ sau hạn (chủ yếu chuyển khoản thẳng SePay) thì đơn kẹt EXPIRED, khách phải gọi hotline dù Shop đã cầm tiền. Q3: chuỗi VietQR PayOS (số tài khoản, số tiền, nội dung) gửi tới api.qrserver.com để vẽ ảnh — bên thứ ba thấy dữ liệu thanh toán, dịch vụ đó sập là khách không có QR. Q4: PayOS và SePay có thể là hai tài khoản khác nhau → tiền chuyển "nhầm kênh" phải đối soát tay.
**Chọn:** (Q1) `applyPayment` (`apps/shop/src/payment.ts`): EXPIRED (hoặc PENDING quá hạn chưa bị cron ghi) nhận khoản trả SAU hạn → `paidAmount` cộng dồn như cũ (cùng transaction `FOR UPDATE` + dedupe `processed_hub_events`, ADR-034/037); tổng ≥ giá đơn → `PAID`, outcome `LATE_PAID` (log info, giao món); thiếu → giữ `EXPIRED`, `LATE_PAYMENT` (khoản sau cộng tiếp, đủ thì PAID — giao hoán, thứ tự không quan trọng). `PAID` → `EXTRA_PAYMENT`; `CANCELLED` không hồi sinh. Luật kênh giữ nguyên (`creditsOrder`: chỉ cộng khi `source === order.paymentProvider`). `GET /orders/:code` trả trạng thái đã lưu nên thấy PAID; web hỏi tiếp tới `expiresAt + 6 phút` (ADR-144) rồi dừng — trả muộn hơn thì khách tải lại trang mới thấy. Web: EXPIRED có tiền thiếu hiện "còn thiếu X — chuyển thêm cùng nội dung để hoàn tất, hoặc gọi hotline để hoàn tiền". (Q3) Shop trả `payment: {qrImageUrl: null, qrCode, checkoutUrl}` cho PayOS (bỏ `qrImage()`); web vẽ `qrCode` bằng `qrcode.react@4.2.0` (`QRCodeSVG`, 280px, mức M, viền trắng; không phụ thuộc gì, không native) kèm số tiền + mã đơn dưới QR, giữ nút "Mở trang thanh toán PayOS". `paymentQr()` (`apps/web/src/lib/shop/order-status.ts`) chọn: `qrCode` → vẽ tại chỗ; ảnh → chỉ img.vietqr.io (SePay, renderer chuẩn của ngân hàng, giữ nguyên); URL qrserver → không hiện. (Q4) Không đổi code: Admin dùng CÙNG tài khoản ngân hàng cho PayOS và `SHOP_BANK_*` — một lần chuyển sinh hai `payment.received`, Shop chỉ cộng theo kênh khách đã chọn (OTHER_CHANNEL bỏ qua), ghi ở HUONG-DAN-DEPLOY §8.
**Đánh đổi:** Đơn hết hạn có thể thành PAID muộn (vài giờ/ngày) — món đã "huỷ" trong đầu khách nay lại phải giao; Shop chấp nhận vì đã cầm đủ tiền (cách ngược lại là hoàn tiền thủ công). `lateMoneyOrders` của reconcile giờ chỉ đếm đơn EXPIRED nhận THIẾU tiền. +1 dependency ở web (~13 dòng package-lock). `apps/shop/src` 444 → 441 dòng. Q2 của CAN-ADMIN-QUYET-P1P2 (tài khoản PayOS có liên kết hay không, giới hạn 9 ký tự) chưa chốt.

**Đính chính (ADR-158, REVIEW-ADR154 M-2):** câu "trả muộn hơn thì khách tải lại trang mới thấy" là SAI ở thời điểm viết — web không lưu đơn (không đọc `?order=` của PayOS, mở lại modal khi đơn đã kết thúc thì `resetOrder()`), nên khách trả sau `expiresAt + 6'` không bao giờ thấy PAID. ADR-158 sửa: đơn lưu trong `sessionStorage` của tab, mở lại modal / tải lại trang / quay về từ PayOS (`?order=`) thì hỏi trạng thái một lần.

## ADR-155 — Cách B: Shop có trang Cài đặt kết nối — `shop.settings` (bí mật AES-256-GCM) thắng env, mã quản trị, lưu là đăng ký lại endpoint ngay (2026-10-12)

**Vấn đề:** Shop chỉ nối được project `default` của operator; HUB_URL, nguồn tin cậy, khoá PayOS, tài khoản VietQR đều cứng trong env Render — dev lạ muốn cắm Shop vào project của mình phải sửa env và redeploy (SPEC-shop-ket-noi-project §1). Production đang chạy bằng env đó và Admin sắp trả tiền thật.
**Chọn:** (1) Bảng `shop.settings` một dòng (`CHECK id = 1`, migration `20261012020000_shop_settings`, GRANT tường minh cho `shop_user` nếu role tồn tại, không lệnh superuser); 4 cột bí mật `*_encrypted` (HUB_URL chứa key, PayOS clientId/apiKey/checksumKey) mã hoá bằng `aesGcmEncrypt` của `@hub/crypto` với env mới `SHOP_SETTINGS_KEY` (32 byte base64). (2) `apps/shop/src/settings.ts`: `resolveSettings` gộp DB → env TỪNG TRƯỜNG và trả về DƯỚI DẠNG env (`HUB_URL`, `PAYOS_*`, `SHOP_BANK_*`…) nên `payosConfig`/`bankQrUrl` không đổi; chưa lưu gì (hoặc không có `SHOP_SETTINGS_KEY`, hoặc DB lỗi) = y như trước ([SK:U2]). Cache trong bộ nhớ, xoá khi `PUT`. (3) Route `GET /settings`, `POST /settings/test-hub`, `PUT /settings` sau `x-shop-admin-token` = env `SHOP_ADMIN_TOKEN` (so sha256 hai phía bằng `timingSafeEqual`, không lộ độ dài); env không đặt → 404; sai 5 lần/phút/IP → 429 (`trust proxy 1` cho IP thật trên Render). `GET` chỉ trả `configured` + 4 ký tự cuối (bí mật < 12 ký tự: không gì), HUB_URL thêm project + host. (4) `HubLink`: client + `sourceKeys` hiện hành; `PUT` → `reconnect()` dựng client mới, `HubRegistration.reset()` (quên `trustedSourceIds` cũ NGAY, kết quả ensure của thế hệ cũ bị bỏ) rồi `ensureNow()` → trả VERIFIED/FAILED + `verificationFix` (tách từ `— fix:` của HubError). Shop nạp cài đặt TRƯỚC `listen` nên webhook không tới lúc chưa biết nguồn tin cậy. (5) `test-hub` = `me()` (bắt buộc `manage:endpoints`, thiếu → 422 + `fix`) + `GET /v1/p/:project/sources` (SDK thêm `sources.list()`). Route đó đòi `manage:sources`; key mặc định của Shop (manage:endpoints + read:events) nhận 403 → Shop vẫn trả 200 với `sources: null` + `sourcesFix`, UI cho gõ sourceKey. KHÔNG nới scope của hub (lệch spec, ghi §8).
**Đánh đổi:** Bí mật nằm ở DB của Shop, khoá ở env — lộ cả hai mới lộ bí mật; mất `SHOP_SETTINGS_KEY` = phải nhập lại (giải mã lỗi thì rơi về env, có log). Mã quản trị là một token chung, không phải đăng nhập (ADR-024 giữ nguyên); rate-limit trong bộ nhớ, mất khi restart. Dev dùng key tối thiểu phải gõ sourceKey tay, hoặc cấp thêm `manage:sources` để chọn từ danh sách.

## ADR-156 — Nâng trần `apps/shop/src` lên ~600 dòng cho cách B (2026-10-12)

**Vấn đề:** Trần ~450 (ADR-141) đã dùng 442; trang Cài đặt kết nối (ADR-155: mã hoá, mã quản trị, test-hub, đăng ký lại endpoint) cần thêm ~160 dòng. Cách B là kịch bản demo chính (dev lạ tự cắm Shop vào project của mình, không đụng Render).
**Chọn:** Trần mới 600 dòng tổng `apps/shop/src/**/*.ts` (gate `shop-size`, CLAUDE.md). Phần mới tách file `settings.ts`; `main.ts` chỉ đổi chỗ đọc env sang `settings.get()`. Hiện đúng 600.
**Đánh đổi:** Shop phình gần gấp đôi trần gốc (300); mọi tính năng Shop sau này phải bù dòng ở chỗ khác hoặc ADR mới. Vẫn không đăng nhập, không kho, giỏ ở client.

## ADR-157 — Khoá PayOS nằm ở HAI chỗ là đúng mô hình: hub giữ khoá để NHẬN webhook, backend của dev giữ khoá để TẠO link thanh toán (2026-10-12)

**Vấn đề:** Admin hỏi vì sao dán khoá PayOS hai lần (console hub › Kết nối PayOS và Shop › Cài đặt) — có phải trùng lặp?
**Chọn:** Giữ hai chỗ, mỗi chỗ một việc, cùng một chủ là dev (SPEC-shop-ket-noi-project §2). Hub (source PayOS, KN3): `checksumKey` để verify chữ ký webhook; thêm `clientId` + `apiKey` chỉ khi bấm "Kết nối" (hub gọi `confirm-webhook`). Backend của dev (Shop): `clientId` + `apiKey` + `checksumKey` để tạo link thanh toán cho đơn. Hub KHÔNG tạo link thay Shop (hub không biết "đơn hàng" — BB-1) và KHÔNG trả credentials ra API (SPEC-ket-noi §4.3) nên Shop không đọc khoá từ hub. Cùng mô hình Stripe + Svix/Hookdeck: backend giữ API key để tạo charge, cổng webhook giữ signing secret để verify. Việc của cách B là làm chỗ thứ hai dễ điền (trang Cài đặt, ADR-155), không phải xoá nó. UI Shop nhắc: checksumKey phải CÙNG kênh với source PayOS bên hub (khác → hub 401 webhook), đối chiếu bằng 4 ký tự cuối (không tự so).
**Đánh đổi:** Dev phải dán khoá hai lần và tự giữ hai chỗ khớp nhau khi xoay khoá; đổi lại ranh giới rõ: lộ DB hub không cho ai tạo link thanh toán thay Shop, và hub không phình thành cổng thanh toán.

## ADR-158 — Checkout Shop: đơn sống trong `sessionStorage` của tab, giỏ đổi thì tạo đơn mới, đơn PayOS không bao giờ được bảo "chuyển thêm" (SK4: REVIEW-ADR154 M-1/M-2 + lỗi QR cũ) (2026-10-12)

**Vấn đề:** (M-1) lời nhắn "chuyển thêm phần còn thiếu cùng nội dung" hiện cả cho đơn PayOS — link đã hết hạn, chuyển thẳng thì tiền về nguồn sepay → OTHER_CHANNEL, không cộng. (M-2) khách trả muộn không thấy PAID (web không giữ đơn). (Production) mở lại modal vẫn hiện QR PayOS của đơn CŨ: Admin đã trả đơn đó, định mua đơn mới nhưng quét lại QR cũ, ngân hàng báo "đã thanh toán", DB không có đơn thứ hai.
**Chọn:** Logic thuần ở `apps/web/src/lib/shop/order-status.ts`: `canTopUp(provider)` (PayOS → chỉ hotline, cả UNDERPAID lẫn EXPIRED thiếu); `cartSignature` + `shouldStartNewOrder` (đơn mang chữ ký giỏ lúc tạo; mở modal mà giỏ khác — kể cả giỏ rỗng sau khi PAID — thì bỏ đơn cũ, form mới); `orderCodeFromSearch` (`?order=DH…` từ returnUrl PayOS, đúng khuôn); `parseSavedOrder`. `CheckoutModal`: lưu đơn vào `sessionStorage` (`shop:order`), mount thì lấy lại; có `?order=` thì mở modal, dựng đơn tối thiểu từ `GET /orders/:code` rồi xoá query khỏi URL; mỗi lần mở modal với đơn cũ (giỏ không đổi) hỏi trạng thái MỘT lần (thay `resetOrder()` khi đã kết thúc). Khung "Đơn DHxxxx · số tiền" + nút **Tạo đơn mới** luôn ở đầu bước thanh toán.
**Đánh đổi:** Đơn chỉ nhớ trong tab (đóng tab là mất — không localStorage, không tài khoản, ADR-024). Đơn mở từ `?order=` không có danh sách món/QR (chỉ trạng thái). Đơn cũ bị bỏ vẫn PENDING ở server tới khi tự hết hạn.

## ADR-159 — KQ1: PayOS confirm probe nhận diện bằng bộ mẫu cố định (2026-10-12)

**Vấn đề:** Bằng chứng production (SPEC-ket-noi §11, 2026-10-11): lúc "Kết nối PayOS", PayOS bắn request kiểm tra ký HỢP LỆ, `code "00"`, data = đúng bộ mẫu tài liệu (`orderCode 123`, 3000đ, `description "VQRIO123"`, `reference "TF230204212323"`) → normalize thành `payment.received` 3000 và push tới mọi subscriber — service khác thấy một khoản 3.000đ ma. PayOS không gửi cờ nào đánh dấu "kiểm tra".
**Chọn:** `PayosAdapter.isPayosConfirmProbe()` true chỉ khi khớp ĐỦ CẢ BA `orderCode === 123` (số), `description === "VQRIO123"`, `reference === "TF230204212323"`; chỉ gọi trong `normalize` (sau verify — raw ACCEPTED, BB-3: ingest không đổi, vẫn 200; kiểm lại → khoá `payos:123:TF230204212323` trùng → 200 duplicate, không 4xx). Khớp → `payos.webhook_test`, `normalized:false`, cờ chung `NormalizedEvent.probe = true`. `normalized:false` một mình không đủ (vẫn tới subscription `*`/`payos.*` và polling) nên thêm cột `hub.events.probe` (DEFAULT false): normalize consumer lưu event probe nhưng bỏ định tuyến, `pollEvents` lọc `NOT e.probe`; console/inspect/raw vẫn thấy. Lõi chỉ đọc cờ — không `if (provider === 'payos')` (BB-1, từ vựng PayOS chỉ ở adapter). `[KN:U16]` hết mồ côi.
**Đánh đổi:** Dựa vào bộ mẫu của tài liệu PayOS, không phải hợp đồng. PayOS đổi bộ mẫu → hàm trả false → hệ thống quay về hành vi cũ (event `payment.received` 3000 được giao; Shop bỏ qua vì memo không có mã `DH…`; service khác tự lọc). Giao dịch thật trùng cả ba trường là gần như không thể (reference ngân hàng thật dạng `FT…`), nhưng nếu xảy ra sẽ bị nuốt — raw còn nguyên để soát. Thêm một cột + một migration chỉ để chặn rò; cờ `probe` dùng lại được cho provider khác (vd GitHub `ping`, chưa đổi).

## ADR-160 — SK: Lưu cài đặt Shop = kiểm trước, lưu sau; allowlist host hub; một bản chụp cấu hình (2026-10-12)

**Vấn đề:** REVIEW-SK H-1: `PUT /settings` ghi DB rồi mới `ensure`; FAILED thì cấu hình hỏng đã nằm trong DB, `trustedSourceIds = []`, mọi `payment.received` (kể cả từ project cũ đang chạy tốt) nhận 503, cấu hình cũ mất. M-2: ai có `SHOP_ADMIN_TOKEN` trỏ được `HUB_URL` về host của mình và nhận `HUB_SIGNING_SECRET` qua `ensure` → giả mạo thanh toán; token không có độ dài tối thiểu. M-3: DB > env theo TỪNG trường nên ra cấu hình lai (khoá sai: bí mật về env nhưng `payment_source_keys` vẫn từ DB); boot lúc DB lỗi thì không bao giờ hội tụ. L-6: hai PUT xen nhau làm link lệch DB.
**Chọn:** (1) `ShopSettings.prepare()` dựng cấu hình ỨNG VIÊN trong bộ nhớ (chưa ghi); `HubLink.reconnect(env, commit)` chạy `ensure` trên client ỨNG VIÊN; chỉ VERIFIED mới `commit()` (ghi DB) rồi thay client + nguồn tin cậy một lượt (`registration.reset(ids)`); FAILED → không ghi, link cũ giữ nguyên, trả **422** `{saved: [], registration: FAILED, fix}` (web: "Chưa lưu gì — Shop vẫn chạy cấu hình cũ"). PUT và đồng bộ định kỳ chạy qua `HubLink.lock` (tuần tự). (2) Host hub được phép = host của `HUB_URL` **env** + `SHOP_ALLOWED_HUB_HOSTS` (phẩy); host khác → 422 + fix ở `test-hub`/`PUT`, và `HubLink` từ chối `ensure` (không gửi secret) kể cả khi dòng DB cũ trỏ host lạ. `SHOP_ADMIN_TOKEN` < 24 ký tự = chưa đặt (404) + cảnh báo lúc khởi động. (3) `resolveSettings` ra MỘT bản chụp: dòng giải mã được → DB thắng mọi trường đã đặt, env chỉ cho trường chưa từng đặt; dòng có mà giải mã lỗi → env cho MỌI trường, log error một lần. DB lỗi lúc đọc → env (`degraded`, cache tạm, hết spam truy vấn lỗi — L-1); khi `degraded`, main `reload()` mỗi 60s rồi `HubLink.sync()` để hội tụ. (4) M-1: webhook từ source không tin cậy → `skip: 'UNTRUSTED'` (vẫn 200) + `warn` kèm `sourceId`, mã đơn ứng viên; runbook: chỉ chuyển project khi không còn đơn PENDING/UNDERPAID, sau đó tắt/xoá subscription Shop ở project cũ.
**Đánh đổi:** Hub đang ngủ thì Lưu (kể cả chỉ đổi mã ngân hàng) báo FAILED, phải bấm lại sau 30–60s — chấp nhận, an toàn hơn lưu mù. `ensure` thành công mà ghi DB lỗi → hub đã có subscription mới nhưng Shop vẫn chạy cấu hình cũ (route 500, bấm lại là hội tụ). Không re-sync định kỳ khi DB khoẻ (60s/lần sẽ giữ Neon thức, tốn giờ compute) — chỉ thử lại khi đang `degraded`. Dùng hub ở host khác HUB_URL env phải đặt `SHOP_ALLOWED_HUB_HOSTS` trên Render (một lần). Trần Shop giữ 600: gọn `hub-registration.ts`, bỏ dòng trống trong thân hàm, không đụng logic tiền.
**Bổ sung (REVIEW-SK R2, 2026-10-12, append):** N-1: `commit()` ném sau khi ensure ứng viên VERIFIED → `HubLink.reconnect` chạy NGAY `registration.ensureNow()` trên link CŨ (cùng project: `exclusive` bật lại sub cũ; best effort, log `restored`), trả `COMMIT_FAILED` → route **500** kèm `fix` "Lưu lại / restart, đối soát log KHÔNG tin cậy theo orderCodes"; project mới vẫn giữ endpoint `shop` (không hoàn tác được từ Shop — runbook HUONG-DAN-DEPLOY §8). N-5: vòng 60s đi qua `HubLink.resync()` có `.catch` → lỗi chỉ log, không unhandled rejection làm thoát tiến trình. N-3: `NODE_ENV=production` → `test-hub`/`PUT` từ chối `hub://` (422, "dùng hubs://"); `HUB_URL` env `hub://` chỉ cảnh báo (không đổi hành vi). N-4: đổi host `HUB_URL` env → dòng đã lưu trỏ host cũ đóng an toàn (503) tới khi Lưu lại hoặc thêm host vào `SHOP_ALLOWED_HUB_HOSTS` — chỉ ghi tài liệu. **N-2 (ghi nhận, không sửa):** `gen` chỉ chặn ghi đè trạng thái phía Shop; một `ensure` cũ còn bay (từ `start()`/`ensureNow` lúc chưa ghim) vẫn tới hub bằng client cũ và có thể (cùng project, xong SAU ensure mới) tắt sub mới/bật lại sub cũ qua `exclusive`. Chỉ xảy ra khi Lưu đúng lúc Shop đang đăng ký lại (hub vừa thức); Lưu lại hoặc restart là hội tụ. Cách chặt hơn (trong `lock`, chờ in-flight cũ trước ensure ứng viên) để sau. Trần Shop vẫn 600/600 (gom `catch`/dòng trống `hub-registration.ts`).

## ADR-162 — GitHub: giải `payload` form-urlencoded trong adapter, `ping` là probe, body limit = 1MB một nguồn (2026-10-12)

**Vấn đề:** (1) Webhook GitHub đặt "Content type: application/x-www-form-urlencoded" gửi `payload=<json>`: chữ ký khớp (HMAC trên rawBody), hub ACK 200, nhưng `req.body = {payload}` → `repo.push` thiếu `repo.fullName` → CanonicalSchemaError → DLQ vĩnh viễn, GitHub không gửi lại. (2) `ping` không mang `probe` như confirm probe PayOS (ADR-159) → endpoint `*`/`github.*` nhận ping, flow báo "Không subscription nào nhận". (3) Express mặc định 100KB → push lớn nhận 413 TRƯỚC ingest, không raw_event nào, GitHub không tự retry; trần 1MB của ingest không bao giờ áp dụng.
**Chọn:** (1) `githubPayload(req)` trong `GithubAdapter` (không đụng lõi): form-urlencoded → `JSON.parse` của `payload` lấy từ **rawBody** (= `raw_events.body_raw`, renormalize/replay ra y hệt), rớt về `body.payload` chuỗi; JSON hỏng → body nguyên trạng. Console gợi ý "Content type: application/json khuyến nghị". (2) `ping` → `github.ping`, `normalized:false`, `probe:true` — cùng cờ chung `events.probe` của ADR-159, lõi không biết provider. (3) `MAX_INGEST_PAYLOAD_BYTES` (1MB) + `MAX_API_BODY_BYTES` (100KB) ở `@hub/common` là nguồn duy nhất: `configureBodyParsers(app)` (`apps/hub-api/src/body-parsers.ts`, gắn SAU helmet/requestId/CORS, ngay trước listen — lỗi 400/413 của parser vẫn mang header CORS/helmet) đặt json + urlencoded (`extended:true` như mặc định cũ) 1MB CHỈ cho `/hooks/*`, route khác giữ 100KB; 413 trên /hooks tăng `hub_ingest_requests_total{outcome="TOO_LARGE"}` (bộ nhớ, 0 lệnh Redis); `IngestService` kiểm lại cùng hằng.
**Đánh đổi:** Request /hooks giữ tới 1MB trong bộ nhớ (vẫn có trần; route khác không đổi 100KB). Quá 1MB bị body-parser trả 413 TRƯỚC ingest — được đếm `TOO_LARGE` nhưng không ghi raw_event (không có tenant/source để gắn). Probe GitHub vẫn hiện "Chưa ánh xạ" ở bước normalize (y như PayOS, `normalized:false`) — UI tự ghi chú theo `github.ping`. GitHub `payload` chuỗi chỉ được giải khi content-type là form hoặc thiếu (JSON thật có trường `payload` không bị hiểu nhầm).
**Theo dõi sau (chưa sửa):** `IngestController` dựng rawBody giả `JSON.stringify(req.body || {})` (= `"{}"`) khi content-type không có parser (text/plain, octet-stream…) — chữ ký luôn sai/khoá trùng theo hash của `{}`; có từ trước, cần parser raw cho /hooks hoặc 415 rõ ràng.

## ADR-161 — Bản đồ luồng: "Ngắt" = `is_active=false`, "Xoá" = lưu trữ `archived_at` (không DELETE) (2026-10-12)

> Số 161 được giữ chỗ cho quyết định này; ghi sau ADR-162 vì log append-only.

**Vấn đề:** Bản đồ luồng (`/dashboard/flow`) cần nút thùng rác trên source / đích / subscription. `DELETE destinations/:id` trả 409 khi còn subscription, `DELETE subscriptions/:id` 409 khi còn delivery (FK RESTRICT, ADR-053/054); source không có DELETE (raw_events là bằng chứng đã nhận). Xoá thật = mất lịch sử đối soát hoặc luôn 409 — vô dụng trên bản đồ. Đích chưa có `is_active` nên không "Ngắt" được.
**Chọn:** Migration `20261012040000_archive_flow_items`: `archived_at TIMESTAMPTZ NULL` cho `hub.sources/destinations/subscriptions` + `destinations.is_active DEFAULT true` (chỉ DDL, RLS/GRANT cấp bảng không đổi). "Ngắt"/"Kết nối lại" = PATCH `isActive` sẵn có (PATCH `destinations/:id` nhận thêm `isActive`); node ở lại, vẽ mờ "ĐÃ NGẮT". "Xoá" = `POST /api/v1/{sources|destinations|subscriptions}/:id/archive` (scope `manage:sources` / `manage:endpoints`, `TenantScopedRepository`, audit `*.archive` cùng transaction): đặt `archived_at` + `is_active=false`. Lưu trữ đích → lưu trữ MỌI subscription của nó; lưu trữ source → lưu trữ subscription có `sourceIds` mà không còn source sống nào (sub `sourceIds=[]` không bị đụng) — bản đồ không còn cạnh treo, id liệt kê trong audit. Mục lưu trữ: ingest từ chối y như source tắt (404 `/hooks`, 409 `source_inactive` `/v1/p`), normalize không khớp (sub `archived_at IS NULL`, đích `is_active AND archived_at IS NULL`), ẩn khỏi topology + danh sách console + list `/v1/p`, PATCH/archive lại → 404, `sourceIds`/`sourceKeys` trỏ source lưu trữ → `unknown_source`. raw_events/events/deliveries/attempts giữ nguyên.
**Đánh đổi:** Không hoàn tác qua API/UI (cần SQL tay) — cố ý đơn giản; không xoá cứng kể cả khi không có lịch sử (dòng cấu hình chết nằm lại DB). Delivery đang PENDING/RETRYING tới đích vừa ngắt/lưu trữ vẫn chạy nốt (giống tắt subscription) — chặn giữa chừng phải thêm trạng thái delivery mới. Flow chi tiết event ghi đích đã ngắt là `subscription_inactive` (không thêm mã lý do để khỏi đổi UI log). `sourceKey` của source lưu trữ vẫn bị giữ (UNIQUE) — PayOS còn bắn vào nhận 404; `source_connections` không đổi, muốn gỡ webhook ở PayOS phải làm tay.

**Bổ sung (review phòng, 2026-10-12, append):** (T1) `findSourceById/findDestinationById/findSubscriptionById` mặc định BỎ QUA mục lưu trữ (tuỳ chọn tường minh `{ includeArchived: true }`, hiện chưa chỗ nào cần) → GET/verify/rotate endpoint, inspect source, kết nối/thử lại provider, tạo subscription trên đích lưu trữ (C1), nhận lại endpoint (C2, `findAdoptable` lọc `archived_at`) đều 404; mọi chỗ `updated ?? d` trên các đường này → update trả null thì 404, không báo thành công/không trả secret chưa lưu. (T2) Tạo/sửa subscription (console + `/v1/p`) kiểm đích + `sourceIds/sourceKeys` TRONG transaction; lưu trữ + tạo/sửa subscription lấy `pg_advisory_xact_lock(4243, hashtext(tenant_id))` qua `repo.lockFlowConfig()` (xact-level, hợp pgbouncer transaction mode) → cascade thấy tập nhất quán. (T4) Lưu trữ source gỡ id của nó khỏi `source_ids` của subscription còn sống (`array_remove`, scope tenant). (T3) Replay đơn: subscription/đích lưu trữ → 409 `destination_archived`, đích Ngắt → 409 `destination_inactive` (docs/ERRORS.md); replay hàng loạt (xem trước + chạy thật, cùng `errorKind`) chỉ chọn `replayableOnly` = subscription chưa lưu trữ + đích chưa lưu trữ và đang bật; bảng DLQ vẫn liệt kê đủ. Worker: đích **lưu trữ** → delivery DEAD `destination_archived: …`, không gửi; đích chỉ **Ngắt** → delivery đang bay chạy nốt (như cũ), chỉ chặn tạo mới (normalize) và replay. (L1) `POST sources/:id/archive` đòi thêm `manage:endpoints` (luôn, không tuỳ dữ liệu). (L2) Endpoint/subscription do service tạo qua `/v1/p` (vd Shop `ensure`) có thể được service TẠO LẠI ở lần khởi động/đồng bộ kế — hộp thoại cảnh báo (cờ `managedByService` = `created_by_key_id`); muốn ngừng hẳn phải gỡ cấu hình phía service. Hộp thoại cũng cảnh báo source có `source_connections` (URL ở provider không tự gỡ) và "Kết nối lại" subscription khi đích còn Ngắt. Còn hở: tạo endpoint ở console (KN1, `endpoints.controller`) vẫn kiểm `sourceIds` ngoài transaction.

**Bổ sung (review 3, 2026-10-12, append):** Đoạn "Bổ sung" trên THAY đánh đổi "delivery đang bay chạy nốt" của **Đánh đổi** cho đích **lưu trữ**: worker không gửi, delivery PENDING/RETRYING → DEAD `destination_archived` (DELIVERING không đụng — worker giữ lease có thể đang gửi dở); "chạy nốt" chỉ còn đúng cho đích **Ngắt**. Lưu trữ source xoá `credentials_encrypted` + `source_connections.status = DISCONNECTED` (`last_error = source_archived`) trong CÙNG tx — credentials không nằm lại mãi; vì thế hộp thoại gợi ý ngắt kết nối provider TRƯỚC khi Xoá (sau đó hub không gỡ hộ được), `disconnect`/`deleteCredentials` vẫn chạy trên source đã lưu trữ (`includeArchived`), `callConnect` kiểm lại source trong tx ghi (sau `lockFlowConfig`) → 404 + dọn cấu hình mới ở provider. `providerConnected` trên bản đồ chỉ khi kết nối khác DISCONNECTED. Lưu trữ source mà Shop ghim qua `SHOP_PAYMENT_SOURCE_KEYS` → lần đăng ký lại kế tiếp của Shop (`ensure`) nhận 422 `unknown_source` (Shop giữ cấu hình cũ, ADR-160) cho tới khi đổi `SHOP_PAYMENT_SOURCE_KEYS` sang source còn sống. `requireAlsoScope` đóng mặc định (không có scopes → 403). `/v1/p` GET events `?endpointId=` vẫn nhận endpoint đã lưu trữ (`includeArchived`, đọc lịch sử). KN1 tạo endpoint ở console cũng `lockFlowConfig()` trước khi kiểm `sourceIds` (đóng chỗ hở đã ghi ở trên).

**Bổ sung (review 4, 2026-10-12, append):** tx giành kết nối (`retry`) và tx tạo kết nối (`connectExisting`) cũng `lockFlowConfig()` + kiểm lại source → 404, không ghi credentials/PENDING lên source vừa lưu trữ. Nhánh "lưu trữ giữa lúc gọi provider" của `callConnect` (vẫn 404) thêm best-effort: gỡ cấu hình cũ (`previousRemoteRef`) ở provider khi credentials thường còn trong bộ nhớ, rồi tx idempotent xoá credentials + DISCONNECTED `source_archived`. Trên source đã lưu trữ, `disconnect`/`deleteCredentials` chỉ là ghi sổ (credentials đã bị xoá nên thường không gỡ được gì ở provider); `disconnect` giữ `last_error = source_archived` + lời nhắc gỡ URL ở dashboard provider thay vì xoá trắng.

## ADR-163 — Trang nhật ký: keyset cursor `(created_at, id)`, bộ lọc trên URL, cờ `probe` qua danh sách hành trình (2026-10-12)

**Vấn đề:** `GET /api/v1/deliveries` và `/dlq` cắt cứng 50 dòng, không cursor, gần như không lọc; audit phân trang theo `id`, không lọc. Danh sách lớn dần ở ĐẦU (dòng mới chèn trên cùng) nên OFFSET làm trang trôi -> trùng/sót. Bộ lọc chỉ nằm trong state -> F5/gửi link mất. UI đoán request kiểm tra kết nối (payos.webhook_test, github.ping) theo tên kiểu + summary (TODO probe-flag) trong khi `events.probe` (ADR-159) đã có ở DB.
**Chọn:** (1) KEYSET duy nhất, không OFFSET: so sánh BỘ `(created_at, id)` (thế hoà cùng µs phân định bằng id), cursor = base64url `["YYYY-MM-DDTHH:MM:SS.ffffff" UTC, id]` (µs vì timestamptz(6); `Date` JS chỉ có ms). Trước/Sau: `before=<cursor>` cũ hơn (DESC), `after=<cursor>` mới hơn (ASC sát cursor, server đảo lại); response `{items, next, prev}`; "Trước" chạm đầu (< limit dòng) -> trả trang đầu đủ cỡ, `prev:null`. Áp cho deliveries (lọc status, destination, code = HTTP lần thử cuối 404|5xx|none, from/to), dlq (destination, errorKind = http_4xx|http_5xx|no_response theo HTTP lần thử cuối, from/to) và audit-logs (actor ILIKE, action tiền tố, entityType, from/to; `nextBefore` giữ làm alias) — repo `findDeliveryPage`/`findAuditLogPage` (TenantScopedRepository, raw SQL có `tenant_id`), kiểm đầu vào ở `apps/hub-api/src/modules/api/list-params.ts` -> 400 `bad_request` + `field`. Replay hàng loạt nhận `errorKind` và dùng CÙNG `errorKindSql` -> xem trước đếm đúng tập bảng DLQ đang lọc (trang DLQ gửi đúng bộ lọc đang xem, tuổi preset -> from/to). (2) `/flow/executions` thêm `provider`, `probes=hide` (lọc `events.probe` ở SERVER), `from`/`to`, `q` (tiền tố event id / raw id ≥ 4 ký tự); mỗi dòng mang `probe`, và probe đi vào `buildEventFlow` như màn chi tiết. UI tin cờ khi có (probe = cờ && không failedAt && 0 delivery), chỉ phỏng đoán khi server cũ không gửi. (3) Bộ lọc (và cursor Trước/Sau) nằm trên URL, đọc bằng `readParams` (giá trị lạ bị bỏ qua), ghi bằng History API (đổi lọc = replace + bỏ cursor; Trước/Sau = push). (4) Danh sách cuộn vô hạn (ngăn Nhật ký sự kiện, Hành trình) có hiệu ứng "mở cuộn giấy": số phận mỗi dòng quyết định MỘT lần lúc thấy khoá lần đầu (`lib/ui/unroll.ts`), class chỉ giữ trong cửa sổ animation -> dòng đã trên màn hình không bao giờ chạy lại; CSS thuần `styles/unroll.css`, tắt khi prefers-reduced-motion.
**Đánh đổi:** Không có số trang/tổng số (keyset không đếm). `code`/`errorKind` dùng subquery lần thử cuối mỗi dòng (không index riêng) — chấp nhận ở quy mô đồ án. Response deliveries/dlq đổi từ mảng sang `{items,next,prev}` (chỉ console dùng); `before` số kiểu cũ của audit giờ là 400. Facets audit (`/audit-logs/facets`) quét DISTINCT ≤100 mỗi cột.
**Bổ sung (review G, 2026-10-12, append):**
- **Replay hàng loạt chạy đúng tập đã xem trước (M1).** Xem trước lấy 501 dòng, trả `ids` (≤ 500), và `truncated` chỉ bật khi có thật dòng thứ 501. Chạy thật **bắt buộc** gửi `ids`; không có thì 400 `field: ids`, và xem trước gửi kèm `ids` cũng 400. Server không chọn lại theo bộ lọc. Trong **một** transaction, server gọi `lockFlowConfig()` (ADR-161) rồi kiểm lại từng id bằng `findDeadDeliveryRefs({ids, replayableOnly})`: còn DEAD, chưa bị replay, đúng tenant, subscription và đích chưa lưu trữ, đích đang bật. Điều kiện `replayableOnly` là của ADR-161, dùng chung với xem trước. Id bị loại được `findReplaySkipReasons` gắn lý do `not_found`, `not_dead`, `already_replayed` hoặc `destination_unavailable`, rồi trả về trong `skipped {count, byReason, items}` và ghi vào audit (`requested`, `skipped`). Đánh đổi: client cũ chạy thật mà không có `ids` giờ nhận 400 (chỉ console dùng, đã sửa).
- **Đổi tên nhóm lỗi `http_5xx` → `http_other`** ("Lỗi phía nhận (5xx/khác)"). Sender quy lỗi mạng và timeout về 500, nên ở DB không tách được "5xx thật" khỏi lỗi mạng. Gọi nhóm này là 5xx thì không trung thực.
- **"Ẩn request kiểm tra" chỉ ẩn probe đúng thiết kế.** Điều kiện là `NOT (probe AND không có delivery nào)`, cùng quy tắc với `expectedProbe` của UI. Probe có delivery (lỗi thật) **không bao giờ** bị ẩn.
- **`q` không phân biệt hoa thường với ULID**: so `upper(event_id)`.
- **Đầu vào:**
  - Query lặp khoá (mảng) hoặc lồng object → 400, không còn 500.
  - Mốc cursor phải là thời điểm có thật trên lịch; tháng 13 hay giờ 25 → 400.
  - Ngày `from`/`to` tràn (31/02) → 400.
  - Id cursor audit phải ≤ 9223372036854775807.
- **Ngăn Nhật ký sự kiện:**
  - Giữ tối đa 5 trang trong bộ nhớ (`maxPages`).
  - Cuộn xa khỏi đỉnh thì tạm dừng luồng, như nút Tạm dừng; về đỉnh thì chạy tiếp. Nếu trang đầu đã bị bỏ thì nạp lại từ trang mới nhất.
  - Tạm dừng dùng `enabled` thay cho `subscribed:false`, để "cuộn nạp trang cũ" vẫn hiện ngay khi đang dừng.
- **Bộ lọc thời gian:**
  - "Đến" gồm cả phút đã chọn (…:59.999).
  - Gõ được gom 500 ms rồi mới ghi URL.
  - "Từ" sau "Đến" thì báo ngay dưới ô và không ghi URL.
**Bổ sung (re-review G, 2026-10-12, append):**
- **Ngăn Nhật ký không còn vòng nạp vô tận (TB1).**
  - Khi ô tìm phía client đang có chữ, sentinel đáy KHÔNG tự nạp trang cũ hơn. Người xem bấm "Tải thêm" để nạp.
  - Việc nạp lại từ trang mới nhất chỉ xảy ra ở bước chuyển thật "đang cuộn xa → về đỉnh", có ref nhớ trạng thái trước. Nó không chạy chỉ vì luồng đang "trực tiếp".
  - Logic thuần nằm ở `components/flow/event-log-logic.ts`, có spec.
- **Chạy thật replay hàng loạt chỉ nhận `ids` (TB2).**
  - Gửi kèm bộ lọc (`destinationId`, `from`, `to`, `errorContains`, `errorKind`) → 400 `bad_request` + `field`, không nhận rồi lờ đi.
  - Audit của lượt chạy không còn `filter` toàn null; nó ghi `requested`, `deliveryIds`, `skipped`.
  - Body xem trước dùng chung bộ kiểm `list-params` với các trang danh sách: lỗi trả `field`, và giờ là HttpException 400 chứ không phải `BadRequestException`.
- **`replayableOnly` thêm `subscriptions.is_active`.** Lý do bỏ qua `destination_unavailable` vì thế cũng gồm subscription đang tắt. PATCH `isActive` của đích lấy `lockFlowConfig` trong transaction của nó.
- **Cursor:** năm phải ≥ 1970, áp cho cả keyset của console lẫn cursor `/flow/executions`.
- **Link chia sẻ:**
  - Link cũ `errorKind=http_5xx` được đọc như `http_other` (alias trong `readParams`).
  - Preset `code=5xx` ghi nhãn "5xx / lỗi mạng".
  - "Bỏ lọc" tăng `resetToken`, nên ô gõ dở và lỗi của TimeRange cũng xoá.
  - TimeRange chỉ ghi URL sau khi người xem tự sửa ô. Mở link chia sẻ không làm tròn mốc rồi ghi đè URL.
- **Chấp nhận:** Safari có thể nhảy vị trí cuộn khi dòng mới chèn trên đầu lúc đang ở đỉnh, vì không có scroll anchoring. Không xử lý riêng.
**Bổ sung (re-review G lần 3, 2026-10-12, append):**
- **Ngăn Nhật ký:** việc nạp lại trang đầu theo bước chuyển `live` (`!paused && ở đỉnh`) từ false sang true. "Bấm Tiếp tục khi đã ở đỉnh" mà trang đầu đã bị bỏ giờ cũng nạp lại.
- **Replay đơn:** subscription đang tắt → 409 `subscription_inactive` (thêm vào catalog và `docs/ERRORS.md`).
- **PATCH `isActive` của subscription (`/v1/p`):** lấy `lockFlowConfig`.
- **Replay hàng loạt khi mọi id bị bỏ qua:** vẫn ghi 1 audit, với count 0, `requested` và `skipped`.

## ADR-164 — Chiều ra lệnh (Actions): tuỳ chọn, mặc định tắt; PostgreSQL trọng tài idempotency lệnh; lease + fencing, không giữ tx qua HTTP (2026-10-12)

**Vấn đề:** Hub đã giữ credentials PayOS (ADR-146), nhưng service muốn tạo link thanh toán vẫn phải tự giữ cả 3 key và tự ký HMAC (`apps/shop/src/payos.ts`). Với backend ít kỹ thuật thì thế là thừa. Ngược lại, biến hub thành cổng thanh toán lại phá ranh giới "webhook hub" (BB-1) và kéo hub vào đường đi của checkout.
**Chọn:** (SPEC `_bmad-output/planning-artifacts/hub-multi-service/SPEC-chieu-ra-lenh.md`)
- **Tuỳ chọn ở 3 tầng:** adapter có `actions?`; kết nối bật `actions_enabled` (mặc định tắt); API key có scope `act:payments`.
- **Lệnh đồng bộ trong hub-api:** chỉ `payment.link.create/get/cancel`, từ vựng trung lập với provider (`reference` là chuỗi mờ).
- **Hub cấp `remote_key`** (orderCode của PayOS) từ sequence của DB trước khi gọi provider, để đối soát được.
- **Idempotency:** `UNIQUE(tenant, source, action_type, idempotency_key)` trong `hub.actions`, kèm `request_hash`. Thiếu `Idempotency-Key` thì mặc định `ref:<reference>`.
- **Concurrency:** TX1 nhận lease 30 s → gọi provider ngoài tx → TX2 ghi kết quả `WHERE attempt = :mine` (fencing). Trạng thái `UNKNOWN` được đối soát theo `remoteIdempotency` (`lookup`/`native`/`none`) do adapter khai báo.
- **Không chạm Redis.** Cấm mọi lệnh làm tiền đi ra (hoàn tiền, chi hộ).
**Đánh đổi:**
- Bật Actions thì hub nằm trên đường đi của checkout: hub ngủ hoặc chết thì service đó không tạo được link. Service vẫn có thể giữ key và gọi thẳng.
- Thêm một cơ chế idempotency thứ hai, riêng cho lệnh, bên cạnh dedupe ở ingest.
- Request bị treo lâu hơn lease có thể khiến provider bị gọi hai lần; trường hợp này dựa vào việc provider chặn trùng theo `remote_key` (PayOS mã 231).
- Shop đang ở trần 600 dòng, nên việc tích hợp vào Shop chờ Admin chọn (SPEC §12 Q1).
**Admin chốt (2026-10-12, append):** Q1 — Shop **chuyển sang tạo link PayOS qua hub** làm mặc định. Gọi thẳng chỉ còn khi Shop có đủ 3 key. Không bao giờ thử chế độ này rồi rơi sang chế độ kia trong cùng một lần tạo link, vì có thể ra hai link trả được tiền (SPEC §9). Được nâng trần `apps/shop/src` bằng ADR riêng ghi cùng commit. Q2 — AC6 để sau. Q3 — lease 30 s. Chưa code.

---

## ADR-165 — Cảnh báo = bảng Postgres `hub.alerts` + evaluator trong `hub-worker`; trọng tài là unique index một phần, KHÔNG khoá (CB1, 2026-10-12)

> Số 164 đã được lô Actions dùng ở cây chính (chưa gộp) — CB lấy từ 165.

**Vấn đề:** Hub cần tự báo cho người vận hành (endpoint 401 làm sự kiện DEAD im lặng, nguồn ký sai, kết nối provider bị gỡ…). Hai instance worker cùng đánh giá không được đẻ hai cảnh báo cho cùng một chuyện, và Redis mất dữ liệu không được làm cảnh báo sai (tinh thần BB-2). SPEC §5.1 đề xuất `pg_try_advisory_xact_lock`, nhưng khoá mức transaction nhả ngay khi transaction ngắn kết thúc nên không che được cả lượt đánh giá, còn khoá mức session thì pgbouncer transaction mode của Neon cấm (DINH-CHINH D4).

**Chọn:** Bảng `hub.alerts` mang `tenant_id`, có RLS, đi qua `TenantScopedRepository` (BB-5). Bất biến chống trùng là `UNIQUE (tenant_id, rule, subject_id) WHERE state='OPEN'` cộng `INSERT … ON CONFLICT … DO UPDATE` (`upsertOpenAlert`, `xmax = 0` cho biết dòng vừa tạo). **Không khoá nào cả**: không advisory lock, không Redis lock. Evaluator chạy trong `hub-worker` (ADR-020, không thêm tiến trình — BB-4). Luật là hàm thuần trong `libs/common/src/alerts/rules.ts`, ngưỡng là hằng số có tên. Bảng phân loại HTTP tách thành `libs/common/src/http-outcome.ts` và được dùng chung cho `delivery.consumer` lẫn luật, để không có bản thứ hai.

**Đánh đổi:** Hai worker cùng chạy sẽ làm cùng một việc hai lần (gấp đôi truy vấn tổng hợp mỗi 60s), nhưng kết quả vẫn đúng một dòng OPEN (CB:T2). Prisma 6 không khai được index có `WHERE`, nên index này chỉ có ở migration `20261012050000_alerts` và `schema.prisma` chỉ ghi chú lại. Hysteresis (ví dụ "< 20% trong 2 lượt liền") được lưu trong `facts.calmStreak` của chính dòng OPEN, không cần bảng trạng thái riêng.

**Bổ sung (review CB1, 2026-10-12, append):**
- **`opened` lấy từ `xmax = 0`.** Trong `INSERT … ON CONFLICT DO UPDATE`, dòng vừa chèn có `xmax = 0`; dòng bị cập nhật thì `xmax` khác 0. Đây là hành vi nội bộ của Postgres, ổn định từ 9.5 và được dùng rộng rãi, nhưng tài liệu không cam kết. Test `[CB:T2]` sẽ đỏ nếu hành vi này đổi.
- **Chấp nhận một lần "opened" thứ hai theo D4.** Evaluator A đóng cảnh báo đúng lúc evaluator B (dữ liệu cũ hơn) upsert, nên B có thể tạo một dòng OPEN mới và nhận `opened = true`. Bất biến "≤ 1 dòng OPEN" vẫn giữ. Email trùng bị chặn bởi luật chống flapping 30 phút (đếm trên `alert_emails`), còn realtime chỉ có thêm một thông báo.
- **Lượt "êm" của hysteresis** chỉ được đếm khi cách lượt êm trước ít nhất `CALM_MIN_SPACING_MS` (≈ 0.9 × chu kỳ), lưu ở `facts.lastCalmAt`. Nhờ vậy hai evaluator song song không rút "2 lượt liền" thành vài giây. Với `destination.failing`, mẫu nhỏ hơn `FAILING_MIN_ATTEMPTS` cũng tính là lượt êm.
- **Luật chuỗi (`auth_rejected`/`client_error`):**
  - Đóng khi bất kỳ attempt nào mới hơn mốc `facts.lastAttemptAt` là 2xx.
  - Đóng "im lặng" khi 30 phút không có attempt **cùng loại** (`facts.lastMatchAt`).
- **Lý do đóng `'disconnected'`.** `source.connection_broken` đóng với lý do này khi kết nối bị ngắt hoặc không còn. PENDING quá `CONNECTION_PENDING_STUCK_MS` (15 phút) bị coi là hỏng.
- **`ackAlert` chạy được trên cảnh báo đã RESOLVED.** Vô hại: nó chỉ ghi "đã xem" và không mở lại cảnh báo.

---

## ADR-166 — `alert_preferences` gắn người dùng nên đi qua `IdentityRepository`, không có `tenant_id` — có chủ ý, không phải lỗ BB-5 (CB1, 2026-10-12)

**Vấn đề:** Tuỳ chọn "Gửi cảnh báo về email của tôi" (bật/tắt, luật nào được gửi, gửi khi đóng, project bị tắt tiếng) là của **một người** và áp cho mọi project. Nhét `tenant_id` vào thì phải nhân bản tuỳ chọn theo project, hoặc chọn bừa một project.

**Chọn:** `hub.alert_preferences(user_id PK → users, email_enabled, email_rules[], email_on_resolve, muted_projects[], updated_at)` không có `tenant_id` và không bật RLS. Bảng này cùng loại với `users`/`auth_sessions` nên chỉ đi qua `IdentityRepository` (`findAlertPreferences`, `upsertAlertPreferences`, `listAlertEmailRecipients`). Dòng mới nhận mặc định `DEFAULT_EMAIL_RULES` (mọi luật critical). Gate `bb5` thêm model `alert`/`alertEmail`/`alertPreference` vào danh sách cấm gọi `prisma.<model>.` ngoài `libs/database/src`. Gate `data-migration-rls` thêm `alerts`/`alert_emails`.

**Đánh đổi:** `muted_projects` là mảng uuid không có khoá ngoại: project bị xoá để lại id mồ côi, vô hại vì chỉ dùng để lọc. Kiểm "chỉ operator" nằm ở route (CB3), repo không đoán quyền.

---

## ADR-167 — Email cảnh báo là outbox theo NGƯỜI `hub.alert_emails`, không phải cột trên `alerts`; ngôn ngữ email lấy từ `users.locale` (CB1, DINH-CHINH D1/D2/D3, 2026-10-12)

**Vấn đề:** SPEC §3.1 đặt `email_state`/`email_attempts` trên dòng cảnh báo. Nhưng một cảnh báo gửi cho nhiều operator, mỗi người có kết quả riêng (gửi được, bị trần 6/giờ chặn, lỗi), và một ô trạng thái không chứa nổi chừng đó. Ngoài ra ngôn ngữ người dùng chọn hiện chỉ nằm trong cookie trình duyệt, nên worker không đọc được.

**Chọn:**
- **`alert_emails`:** cấu trúc `hub.alert_emails(id, tenant_id, alert_id, user_id, kind OPEN|RESOLVED, state PENDING|SENT|SUPPRESSED|FAILED, attempts, created_at, sent_at)`, ràng buộc `UNIQUE (alert_id, user_id, kind)`.
  - Mang `tenant_id` và có RLS (D2). Khoá ngoại ghép `(alert_id, tenant_id) → alerts(id, tenant_id)` nên DB từ chối gắn email vào cảnh báo của project khác.
  - Evaluator tạo các dòng PENDING bằng `enqueueAlertEmails` trong **cùng transaction** đổi trạng thái cảnh báo.
  - Trần 6/giờ/người và chống flapping 30 phút được đếm trên bảng này, theo index `(user_id, created_at DESC)`.
  - Vòng gửi xuyên project là việc của CB5 và đi qua escape hatch có tên.
- **`users.locale`:** thêm cột `hub."UserLocale"` (`vi|en`), mặc định `vi`, ghi bằng `IdentityRepository.setUserLocale`.
- **`Destination.alertOnOpen`:** đánh dấu `@deprecated` trong schema, cột vẫn giữ. Việc bỏ khỏi view/UI và ADR thay bằng luật `destination.circuit_open` thuộc CB7.

**Đánh đổi:** Mỗi lần cảnh báo đổi trạng thái sinh thêm N dòng (N = số operator đủ điều kiện, thực tế 1–3). Vì có thêm một bảng nên đếm trần phải dùng truy vấn thay vì đọc một cột. Đổi lại, mỗi người có trạng thái riêng, vòng gửi dùng được `SKIP LOCKED` theo từng dòng, và gửi lỗi cho người này không chặn người kia.

---

## ADR-168 — AlertEvaluator: đầu vào theo cửa sổ + hai index mới, chống flapping theo cảnh báo, đối tượng biến mất = lưu trữ (CB2, 2026-10-12)

**Vấn đề:** Evaluator (ADR-165) chạy mỗi 60s cho mọi project, cần đọc attempt 15–30 phút và delivery DEAD 1 giờ mà không quét cả bảng; phải quyết khi nào KHÔNG gửi email lần nữa (flapping §6), xử lý cảnh báo OPEN của đối tượng đã bị xoá cứng, và báo số OPEN khi nhiều worker cùng chạy (D4, không khoá).
**Chọn:**
- **Index (migration `20261012060000_alert_eval_indexes`, chỉ DDL):** `delivery_attempts(created_at)` (bảng chỉ INSERT) cho luật chuỗi + `destination.failing`; index MỘT PHẦN `deliveries(tenant_id, updated_at DESC) WHERE status='DEAD'` cho `dead_spike` + `facts.dead` (chỉ tốn ghi khi delivery vào DEAD). Mọi truy vấn đầu vào là phương thức có tên của `TenantScopedRepository` (lọc `tenant_id`, RLS), có cửa sổ thời gian theo `now` tiêm vào và LIMIT; `auth_rejected`/`client_error` dùng CHUNG một truy vấn attempt (≤ 50 attempt mới nhất mỗi đích). Probe loại ở SQL (`events.probe`; raw ký sai không có event nên luôn tính). `source.silent` đọc ≤ 500 mốc gần nhất mỗi source, chỉ `origin='webhook'` (replay/đối soát không phải "provider còn gửi").
- **Email (D1):** OPEN — người đủ điều kiện §6, TRỪ khi cùng (rule, subject) có cảnh báo RESOLVED trong 30 phút (kiểm ở mức cảnh báo, cùng transaction): chuỗi mở/đóng liên tục < 30 phút chỉ gửi email đầu. RESOLVED — chỉ người chọn `email_on_resolve` VÀ đã có dòng OPEN của chính cảnh báo đó (không báo "đã ổn" cho tin chưa từng gửi). Lỗi đọc người nhận -> lượt đó không email, cảnh báo vẫn chạy.
- **Đối tượng có cảnh báo OPEN mà không còn trong DB** (xoá cứng) -> RESOLVED `reason='archived'`. Truy vấn đối tượng luôn kèm id của cảnh báo đang mở để đối tượng đã lưu trữ vẫn được đóng với lý do.
- **Realtime:** `hub:realtime:alerts` mang `{id, tenantId, rule, severity, state, titleKey}` (`titleKey = alerts.rules.<rule>.title`, web dịch). D5: `providerLabel` = mã provider của kết nối (dữ liệu), web dịch thành tên.
- **Metric:** `hub_alerts_open{severity}` đặt cuối mỗi lượt trọn vẹn — N worker báo cùng con số, panel dùng `max`; `hub_alert_transitions_total` chỉ đếm lần chuyển chính worker đó ghi được.
**Đánh đổi:** Thêm hai index trên đường giao (INSERT attempt, chuyển DEAD) — nhỏ nhưng có. Cửa sổ attempt quét mọi tenant trong 30 phút rồi lọc tenant (attempt không mang `tenant_id`); chấp nhận ở quy mô đồ án, đo lại nếu k6 thấy ảnh hưởng. Chống flapping theo cảnh báo (không theo người): người vừa bật email trong lúc flapping có thể lỡ một email OPEN. Chu kỳ khác 60s qua env không tự đổi `CALM_MIN_SPACING_MS` (hằng tính từ mặc định).
**Bổ sung (review CB2, 2026-10-12, append):**
- **`source.silent` tính cả `origin='api'`** (source `api` chỉ nhận qua `POST /v1/p/:project/events`); vẫn loại replay/đối soát/dẫn xuất và probe.
- **`delivery.dead_spike` loại bản DEAD đã bị replay** (cùng điều kiện `notSuperseded` với DLQ): "Phát lại hàng loạt" làm số đếm hạ và cảnh báo đóng theo, khớp với bảng DLQ.
- **Đọc thiếu không bao giờ đóng cảnh báo.** Danh sách đích/source xếp id đang có cảnh báo OPEN lên trước; chạm LIMIT (1000) thì bỏ bước "đối tượng vắng mặt = đã xoá". Ảnh chụp OPEN chạm trần (500) -> log cảnh báo, đối tượng ngoài ảnh chụp đóng theo (rule, subject), gauge giữ giá trị cũ. Truy vấn attempt chạm 20 000 dòng -> log cảnh báo.
- **Đóng theo id của ảnh chụp** (`resolveAlertById`, chỉ khi còn OPEN): không đóng nhầm dòng OPEN mới mà evaluator khác vừa mở sau ảnh chụp.
- **Redis publisher tạo lười** ở lần publish đầu và `quit()` khi module huỷ — worker không có cảnh báo nào thì không mở thêm kết nối (giới hạn kết nối Upstash).
- **Shutdown:** chờ lượt cảnh báo dừng ở ranh giới luật SONG SONG với chờ handler (một ngân sách 25s); vòng ghi trong một luật cũng kiểm cờ dừng.
- **Đo k6 (local):** chạy với `ALERT_EVAL_INTERVAL_MS=0` để số p95 không lẫn chi phí evaluator, hoặc ghi rõ evaluator đang bật (mỗi 60s, vài truy vấn tổng hợp / project) cạnh số liệu.

---

## ADR-169 — API cảnh báo chỉ cho operator: mã lỗi `operator_required`, ba escape hatch đọc xuyên project, ghi theo tenant của cảnh báo, audit tuỳ chọn ở `auth_audit` (CB3, 2026-10-12)

**Vấn đề:** Chuông của operator nhìn mọi project (SPEC §5.2), trong khi `alerts` mang `tenant_id` + RLS (BB-5). Cần chặn người không phải operator theo khuôn lỗi, đọc xuyên project mà không mở lỗ, ghi "đã xem" có audit, và audit cả thay đổi gắn NGƯỜI (tuỳ chọn, ngôn ngữ) vốn không có tenant cho `audit_logs`.
**Chọn:**
- **Quyền:** `OperatorGuard` sau `SessionGuard` (cờ `isOperator` lấy từ chính truy vấn session/user), mã lỗi mới **`operator_required` (403)** ở catalog + `docs/ERRORS.md` — tách khỏi `forbidden` để client rẽ nhánh được ("bạn không phải operator" khác "role của bạn trong project thiếu quyền"). Owner của project cũng nhận mã này. `PUT /api/v1/me/locale` (D3) cho mọi người dùng.
- **Đọc xuyên project:** ĐÚNG ba hàm có tên trên `PrismaService`, chạy trong `systemTx`: `operatorAlertsAcrossTenants` (keyset `(opened_at, id)`, cùng cursor/`before`/`after` của ADR-163, `cursor` = `before` theo tên trong SPEC), `operatorAlertSummaryAcrossTenants`, `operatorFindAlertTenant`. Chỉ `AlertsController` gọi.
- **Ghi:** ack / ack-all tra tenant của cảnh báo rồi `tenantTx` + `forTenant(tenant, tx)`; dòng `audit_logs` (`alert.acknowledged`, `alert.acknowledged_all`) cùng transaction và chỉ ghi khi thật sự đổi — ack lần hai trả 200 `changed:false`, không thêm audit.
- **Tuỳ chọn / ngôn ngữ** (gắn người, ADR-166): `IdentityRepository` + `auth_audit` (`alert_preferences.updated`, `user.locale_changed`) cùng transaction. `emailRules` ⊆ `ALERT_RULE_CODES`, `mutedProjects` phải là project đang tồn tại (kiểm trước khi ghi), trường lạ → 400.
- **Realtime:** `hub:realtime:alerts` → `alert.changed` qua đúng đường các kênh cũ (`REALTIME_CHANNELS`), vào room `project:<tenantId>` của tin; payload lọc lại còn 6 trường (`parseAlertChangedNotice`), sai hình thì bỏ. Không room operator, không đụng R-3.
**Đánh đổi:** Escape hatch dùng `app.rls_system` — một chỗ quên lọc trong ba hàm này là lộ chéo, nên chúng chỉ ĐỌC và có test riêng. Danh sách không lọc `state` sắp theo `opened_at` không có index khớp hoàn toàn (index hiện có bắt đầu bằng `state`/`tenant_id`) — đủ ở quy mô đồ án. Tóm tắt trả tối đa 500 project. `unacked` tính trên cảnh báo OPEN.
**Bổ sung (review CB3, 2026-10-12, append):**
- **M1 — `alert.changed` chỉ tới operator:** room project thường có cả thành viên không phải operator. Socket nhận `isOperator` từ CHÍNH user của session lúc handshake; operator join thêm room `project:<id>:ops` (vẫn theo project, đúng §5.3 — không room xuyên project). `alert.changed` chỉ vào room này; `metrics.tick` bỏ qua nó. Kiểm lại R-3 thấy operator bị hạ quyền nhưng còn là thành viên -> giữ kết nối, rời room `:ops` (ngữ nghĩa R-3 khác không đổi). Người vừa được nâng thành operator phải kết nối lại mới nhận.
- **Tổng của chuông không phụ thuộc trần:** `openBySeverity`/`unacked` từ một câu tổng hợp riêng không LIMIT; `perProject` vẫn tối đa 500. ack-all không chỉ định project lấy tenant bằng escape hatch thứ tư `operatorAlertsUnackedTenants` (`SELECT DISTINCT tenant_id`, chỉ đọc).
- **`asOf` cho ack-all:** `?asOf=<ISO>` = lúc mở chuông — cảnh báo mở sau mốc đó không bị đánh dấu "đã xem" oan.
- **Gate `operator-alerts`:** lời gọi `operator(Alerts|AlertSummary|FindAlert)…(` chỉ được ở `apps/hub-api/src/modules/alerts/` và `prisma.service.ts`.
- Lọc `state`/`severity` so sánh trên kiểu enum (không ép `::text` cột) để index dùng được; `mutedProjects` kiểm bằng `findExistingProjectIds` (`id IN (…)`). `GET /auth/me` trả `user.locale`.
- **Chấp nhận:** đọc của operator (list/summary) KHÔNG ghi audit — chỉ thao tác ghi (ack, ack-all, tuỳ chọn, ngôn ngữ). Index cho `/alerts` không lọc `state` để sau.

---

## ADR-170 — Console cảnh báo: banner chỉ cho critical nhận qua `alert.changed` trong phiên, toast cho project khác qua mốc poll; câu chữ dựng ở web từ `rule + facts` (CB4, 2026-10-12)

**Vấn đề:** Socket chỉ mang `alert.changed` của project đang mở (ADR-169), không có `facts`; chuông thì xuyên project. Phải bật banner/toast cho cảnh báo MỚI mà không bật cho cảnh báo cũ lúc tải trang (CB:T15), báo được cảnh báo của project khác, và người không phải operator không được thấy chuông lẫn gọi `/alerts*` — trong khi web chưa biết ai là operator.
**Chọn:**
- **Một nguồn dữ liệu, một bộ nhớ phiên** (`lib/alerts/notify-logic.ts`, hàm thuần): danh sách OPEN xuyên project (`GET /alerts?state=OPEN&limit=100`, poll 30s + gọi lại khi có `alert.changed`). Lần tải đầu là MỐC (không báo gì); sau đó id chưa thấy = vừa đến. `alert.changed` OPEN chỉ ghi nhận id. Định tuyến: critical có `alert.changed` → banner; critical chỉ thấy qua poll (project khác) → toast dính; warning → toast 6s; info/đã xem/RESOLVED → chỉ chuông. Banner sống qua chuyển trang; đối chiếu danh sách OPEN để biết "đã xem ở nơi khác" hoặc đã đóng khi socket không còn theo project đó (chỉ khi danh sách không bị cắt).
- **Câu chữ ở web** (`lib/alerts/message.ts` + `messages/alerts.ts`): khoá `alerts.rule.<mã luật, '_'→'-'>.<phần>` (khoá từ điển chỉ chữ thường/`.`/`-`; `titleKey` của server không dùng thẳng). `destination.failing` chọn câu "cách sửa" theo loại lỗi trội của `byClass`; tên provider từ `facts.providerLabel` qua bảng tên hiển thị (D5). `facts` hiện dạng bảng đã dịch, không bao giờ JSON thô.
- **`GET /auth/me` trả thêm `user.isOperator`**; console ẩn chuông/banner/mục "Cảnh báo" và tắt mọi query `/alerts*` khi false. `scopeToProject` không gắn `?projectId=` cho `/api/v1/alerts*` và `/api/v1/me/*` (route `@NoProjectScope`). Tên đối tượng lấy từ `GET /destinations|/sources?projectId=` của các project có cảnh báo (cache 5 phút) vì API cảnh báo chỉ trả `subjectId`.
**Đánh đổi:** Mỗi operator thêm 2 request/30s (summary + danh sách OPEN); cảnh báo của project khác trễ tối đa 30s và ra toast thay vì banner. Tên đối tượng tốn 2 request mỗi project có cảnh báo (lần đầu) và rơi về "Đích 3fa2c1d0" khi đối tượng đã xoá. Một critical của project đang mở mà poll thấy trước tin socket (cửa sổ rất hẹp) sẽ ra toast dính thay vì banner.
**Bổ sung (review CB4, 2026-10-12, append):**
- `asOf` của "đã xem tất cả" = cảnh báo mới nhất đang hiện trong chuông (+1ms vì `opened_at` có µs), chốt lại mỗi lần chuông chuyển đóng→mở (kể cả mở bằng "+k" của banner) — không dùng đồng hồ máy người xem.
- Summary trả thêm `unackedBySeverity` (cùng lượt quét, `FILTER`): badge đỏ chỉ khi còn critical CHƯA XEM.
- Banner xanh thu theo hạn sớm nhất và hẹn lại sau mỗi lần thu; `aria-live` nằm ở một nút ẩn riêng, ghi một lần cho mỗi (cảnh báo, mở/đã ổn) — poll không làm trình đọc màn hình đọc lại.
- Toast: bỏ cảnh báo mở trước mốc phiên mà lần đầu không thấy (danh sách bị cắt); gỡ toast khi cảnh báo được "Đã xem" hoặc rời danh sách OPEN đầy đủ. "Đã xem" ở banner lỗi -> báo lỗi + trả banner về.
- `lastError`/`lastFix` của kết nối là chữ một ngôn ngữ của server: chỉ hiện nguyên văn ở bảng số liệu, câu "cách sửa" luôn lấy từ từ điển.
**Đính chính (re-review CB4, 2026-10-12, append — sửa ADR-169 mục "asOf cho ack-all" và bổ sung ADR-170 ở trên):** `POST /api/v1/alerts/ack-all` không còn nhận `?project=`/`?asOf=` (400). Body bắt buộc `{ids: uuid[]}` (1–200, bỏ trùng) = đúng các cảnh báo CHƯA XEM đang hiện trong chuông. Lý do: `opened_at` là `now` của lượt đánh giá (chung mọi project), không phải lúc commit — một cảnh báo commit muộn hơn trong cùng lượt có cùng mốc mà chưa ai thấy, `asOf` sẽ đánh dấu oan nó và nuốt banner/toast của nó. Server tra tenant từng id qua escape hatch `operatorFindAlertTenants` (thay `operatorAlertsUnackedTenants`), mỗi tenant một `tenantTx` + `ackAlertsByIds` (chỉ dòng còn OPEN + chưa xem; thay `ackAllOpenAlerts`), audit `alert.acknowledged_all` kèm `{count, ids}`. Đánh đổi: "đã xem tất cả" chỉ chạm dòng đang hiện (tối đa 5 mỗi project trong popover) — phần "+N khác" vẫn chưa xem, đúng nghĩa "đã thấy".

---

## ADR-171 — Nhận định (insight) tính lúc đọc ở `hub-api`, route theo project cho mọi thành viên; bản trùng được ĐẾM ở Postgres (`hub.ingest_duplicates`) vì không có dòng raw_events (CB6, 2026-10-12)

**Vấn đề:** SPEC §7 cần bốn nhận định (`I-dest`, `I-dup`, `I-silent`, `I-dead`) không lưu, không làm chậm trang Tổng quan, và không có phán đoán thứ hai khác luật cảnh báo. Riêng `I-dup` ("hôm nay hub đã chặn n sự kiện trùng", đếm từ Postgres) không có nguồn: bản trùng KHÔNG được ghi (unique `(source_id, idempotency_key)` từ chối, ACK 200 ngay — BB-2/BB-3), còn metric Prometheus nằm trong bộ nhớ từng tiến trình và không theo project; đếm bằng Redis thì phá ngân sách R1 và trái "Redis được phép sai".
**Chọn:**
- `GET /api/v1/projects/:projectId/insights[?codes=I-dup,I-dead]` → `[{code, level: ok|info|warning|critical, subjectType, subjectId, facts, actions?}]`. `SessionGuard + ProjectScopeGuard`, `read:project` — thành viên nào đọc được project thì thấy (không chỉ operator, khác `/alerts*`). Mọi truy vấn qua `forTenant` (RLS). Câu chữ ở web (`messages/insights.ts`), hành động trả MÃ (`open_dlq`, `view_deliveries`, `view_events`), web tự ghép link.
- Hàm thuần `libs/common/src/alerts/insights.ts`, dùng lại ĐÚNG: `classifyHttpOutcome`/`isRetryableFailure` (CB:T16) + `FAILING_OPEN_RATIO` cho `I-dest`; `evalSourceSilent`/`silenceThresholdMs` + `findSourceActivity` (cùng cửa sổ 7 ngày, cùng 500 mốc — hằng `SILENT_BASELINE_MAX_EVENTS` chuyển lên `rules.ts`, evaluator đọc chung) cho `I-silent`; tập DLQ (`notSuperseded`) trừ D9 cho `I-dead` (trần đếm 10 000, `capped`). `I-dest` dùng lại `findAlertDestinations` + `countAttemptStatusesByDestination` + `findRecentAttemptsByDestination(…, 1)` của CB2 (index `delivery_attempts(created_at)`).
- Nhãn `I-dest`: circuit OPEN/HALF_OPEN → "Tạm ngưng"; không attempt → "Chưa có lượt giao"; attempt MỚI NHẤT 401/403 → "Từ chối xác thực"; 4xx khác → thêm nhãn thứ sáu "Bên nhận từ chối nội dung" (SPEC liệt kê năm, nhưng 404/422 không phải "Khoẻ"); mới nhất là thất bại hub sẽ retry hoặc ≥ 50% → "Lỗi/chậm (đang retry)"; còn lại "Khoẻ". Đích/nguồn Ngắt hoặc lưu trữ: không có nhận định.
- **`hub.ingest_duplicates(tenant_id, source_id, bucket giờ UTC, n)`** + RLS + FK ghép `(source_id, tenant_id)`. `IngestService` gọi `DuplicateCounter.record()` ở hai chỗ trả `duplicate` (Redis hit / P2002) — chỉ cộng trong bộ nhớ, không I/O; một timer 5s (unref, chỉ tồn tại khi có bản trùng) ghi mỗi project MỘT câu `INSERT … ON CONFLICT DO UPDATE n = n + EXCLUDED.n`; lỗi ghi thì cộng trả lại cho lượt sau; `onModuleDestroy` ghi nốt. "Hôm nay" = `date_trunc('day', now(), 'Asia/Ho_Chi_Minh')` (cùng múi biểu đồ dashboard; lệch giờ chẵn nên cắt đúng theo bucket). Index `(tenant_id, bucket DESC)`.
- Web: MỘT lời gọi mỗi trang (Tổng quan `I-dup,I-dead`; Đích `I-dest`; Nguồn `I-silent`), làm mới 60s, không socket.
**Đánh đổi:** Bộ đếm là bằng chứng, không phải trọng tài: SIGKILL mất tối đa ~5s số đếm (hub-api chưa bật shutdown hooks nên SIGTERM cũng có thể mất); nhiều instance cộng đúng nhờ ON CONFLICT. Bản trùng giờ tốn thêm ≤ 1 câu ghi / project / 5s trên Postgres (không trên đường ACK). Bảng chưa nằm trong job cleanup (vài dòng / source / giờ có bản trùng) — thêm khi cần. `I-dead` loại D9 nên có thể nhỏ hơn KPI "DLQ" và số dòng bảng DLQ (bảng vẫn liệt kê DEAD của đích đã lưu trữ để đối soát). Trang Đích/Nguồn tốn thêm một request mỗi phút; truy vấn `I-dest` đọc attempt 1 giờ (LIMIT 20 000 dòng nhóm).
**Bổ sung (review CB6, 2026-10-12, append — sửa phần "Đánh đổi" ở trên):**
- **`I-dead` nói theo LƯỢT GIAO, khớp KPI/bảng DLQ:** "{n} lượt giao cần xử lý trong hàng đợi lỗi, {k} trong 24 giờ qua" + "(+m thuộc đích đã lưu trữ)" khi m > 0. Logic D9 giữ nguyên; `facts.excludedArchived` = phần D9 (cùng lượt quét, trần 10 000 tính trên cả hai phần). Nút sang DLQ hiện khi n + m > 0.
- **Shutdown hub-api:** `main.ts` bắt SIGTERM/SIGINT một lần, ghi nốt bộ đếm với trần min(5s, `SHUTDOWN_TIMEOUT_MS`) rồi `exit(0)` — không gọi `app.close()` (request đang dở xử lý như trước), không đụng ngân sách 25s. Câu "SIGTERM cũng có thể mất" ở trên không còn đúng; chỉ SIGKILL mất ≤ 5s.
- **Khoá ngoại (23503, source đã xoá):** lô bị từ chối thì ghi từng dòng và BỎ dòng hỏng (log một lần mỗi lượt); lỗi tạm thì giữ lại, chỉ log khi chuyển sang trạng thái lỗi. Dòng trong mỗi câu upsert xếp theo `(source_id, bucket)` để nhiều instance khoá cùng thứ tự (không deadlock).
- **Retention:** `CleanupJob` (cùng khoá Redis, `systemTx`, theo lô 5000) xoá `ingest_duplicates` có bucket quá 30 ngày (`INGEST_DUPLICATES_KEEP_DAYS`).

---

## ADR-172 — Bỏ `alertOnOpen` khỏi API/UI, thay bằng luật `destination.circuit_open`; ack-all ghi bằng MỘT câu `UPDATE … RETURNING` (CB7, 2026-10-12)

**Vấn đề:** `Destination.alertOnOpen` là cờ chết: `consoleDestination` vẫn trả ra (`/api/v1/destinations`) nhưng không code nào đọc nó, nên ai thấy cờ này sẽ tưởng hub báo khi circuit OPEN (SPEC CB §3.3, §12 mục 3). Review CB2/CB4 còn để lại ba chỗ chưa gọn: câu log khi ảnh chụp OPEN chạm trần vẫn tả cách cũ, `resolveAlert(rule, subject)` chỉ còn test gọi, và `ackAlertsByIds` đọc (`findMany`) rồi mới ghi (`updateMany`), để hở một khe TOCTOU.
**Chọn:**
- `consoleDestination` không trả `alertOnOpen` nữa (CB:T14). Web chưa từng hiện cờ này, nên không phải sửa UI. Cột `alert_on_open` vẫn giữ, có `@deprecated` trong schema, và sẽ drop ở một migration sau. Circuit OPEN giờ do luật `destination.circuit_open` (warning) lo: luật luôn bật, muốn tắt email thì vào tuỳ chọn của từng người (ADR-166).
- `ackAlertsByIds` dùng một câu `UPDATE hub.alerts … WHERE tenant_id = $t AND id = ANY($ids::uuid[]) AND state = 'OPEN' AND acknowledged_at IS NULL RETURNING id`, đi qua đường raw có scope. Danh sách id cùng `count` ghi vào audit `alert.acknowledged_all` vì thế khớp đúng những dòng mà lần gọi này đã ghi.
- Xoá `TenantScopedRepository.resolveAlert`. Evaluator chỉ đóng theo id của ảnh chụp (`resolveAlertById`, ADR-168), và test cũng chuyển sang dùng hàm này.
- **Đính chính ADR-168:** khi ảnh chụp OPEN chạm trần, evaluator đọc bù dòng OPEN của từng luật (`findOpenAlertsForSubjects`) rồi vẫn đóng theo id. Câu "đóng theo (rule, subject)" trong phần bổ sung của ADR-168 là cách cũ. Câu log đã sửa cho khớp.
- Grafana có thêm panel 7 (`max by (severity) (hub_alerts_open)`) và panel 8 (transitions + `hub_alert_eval_errors_total`). Đã đưa vào checklist `- [x] CBn` của SPEC để `verify:map` đòi test. CB:T13 (email lỗi → FAILED) chuyển sang nhóm CB5, vì gửi email là outbox của CB5.
**Đánh đổi:** Client ngoài nào còn đọc `alertOnOpen` sẽ nhận `undefined`. Trường này chưa từng có tác dụng nên đây không phải hồi quy. Câu UPDATE raw không qua kiểu của Prisma, nên khi đổi tên cột phải sửa tay. Test DB `[CB:T2]` và `alerts-db` sẽ bắt lỗi nếu quên.

---

## ADR-173 — Vòng gửi email cảnh báo: `SKIP LOCKED` trong transaction ngắn + lease, gửi NGOÀI transaction, trần 6/giờ/người, câu luật dùng chung web + email (CB5, 2026-10-12)

**Vấn đề:** Outbox `alert_emails` (ADR-167) đã có dòng PENDING. Cần gửi đi mà: không giữ khoá/kết nối DB trong lúc gọi nhà mail (Gmail có thể mất vài giây); nhiều worker không gửi trùng; tuỳ chọn đổi sau khi xếp hàng vẫn được tôn trọng; một người không bị bão thư; gửi lỗi không chặn evaluator; thư không lộ payload/secret; vi/en đúng câu chữ console.
**Chọn:**
- **`AlertEmailSender` trong `hub-worker`** (không tiến trình mới), timer riêng `ALERT_EMAIL_INTERVAL_MS` (15s, `0` = tắt), tách hẳn khỏi evaluator. Năm escape hatch có tên trên `PrismaService` (`alertEmailOutboxClaim|CapState|MarkSent|MarkSuppressed|MarkFailure`, `systemTx`, xuyên project như cleanup — trần và dòng gộp là theo NGƯỜI, không theo project). Gate `alert-email-outbox` chỉ cho `alert-email.sender.ts` gọi.
- **Lấy lô:** `FOR UPDATE SKIP LOCKED` + `attempts+1` + lease `next_attempt_at = now + 120s` rồi COMMIT ngay; gửi ngoài transaction; ghi kết quả bằng transaction ngắn khác (chỉ dòng còn PENDING). Chỉ lấy dòng `created_at <= now` (now tiêm vào — test dùng mốc 2020 nên không đụng outbox của test khác). Migration `20261012080000_alert_email_sender`: `next_attempt_at`, `last_error`, `suppressed_reason`, `rolled_into` + index một phần `(user_id, sent_at DESC) WHERE state='SENT'`.
- **Kiểm lại lúc gửi** (hàm thuần `alertEmailEligibility`): còn operator, email đã xác minh, còn bật email, luật còn trong `email_rules`, project không bị tắt tiếng, thư RESOLVED cần `email_on_resolve` → sai thì `SUPPRESSED` `ineligible:<lý do>`.
- **Trần 6/giờ/người** đếm `SENT` theo `sent_at` 1 giờ; vượt → `SUPPRESSED` `cap`. Thư gửi được kế tiếp của người đó nêu "…và k cảnh báo khác, xem trong console" với k = số dòng `cap` chưa gộp, và đánh dấu chúng `rolled_into` = id thư đó (đếm đúng một lần; chỉ đánh dấu sau khi gửi thành công).
- **Lỗi gửi:** thử lại sau 1 phút, rồi 5 phút; lần 3 → `FAILED` + log + `hub_alert_emails_total{result}`. Driver mail tạo lười: cấu hình mail sai không làm worker chết. Shutdown trả các dòng chưa gửi (bớt lần thử).
- **Thư** (`libs/common/src/alerts/email.ts`): `[Webhook Hub][CRITICAL][<slug>] <title>` (`[ĐÃ ỔN]/[RESOLVED]` lúc đóng, `[THỬ]/[TEST]` khi gửi thử), HTML + text, giờ `Asia/Ho_Chi_Minh`, deep link `/dashboard/alerts?project=&rule=` và link `/dashboard/settings`. Chỉ dựng từ mã luật + trường `facts` đã biết + tên project/đối tượng; KHÔNG đọc cấu hình/URL đích (không cả host), không `lastError/lastFix`. Ngôn ngữ = `users.locale`.
- **Một nguồn câu:** câu luật + hàm dựng (`buildAlertText`) chuyển từ web về `libs/common/src/alerts/text.ts` (TS thuần, không import); web trải `ALERT_TEXT.vi/en` vào namespace `alerts` và import qua alias `@hub/common/alerts/text` (cùng kiểu `@hub/flow`).
- **Gửi thử** `POST /api/v1/me/alert-preferences/test-email` (operator): email đã xác minh của chính người gọi; 3 lần/giờ đếm trên `auth_audit` (`alert_preferences.test_email`) trong một transaction khoá dòng `users` (`IdentityRepository.reserveAuditSlot`) — Postgres, không Redis (ngân sách R1 không đổi). Gửi lỗi vẫn tốn suất. `GET /me/alert-preferences` trả thêm `email`, `emailVerified`, `hourlyCap`, `testEmail.perHour`. Trang `/dashboard/settings` (mục sidebar "Cài đặt", chỉ operator).
**Đánh đổi:** At-least-once: worker chết sau khi nhà mail nhận mà trước khi ghi SENT → hết lease gửi lại một lần. Trần đếm theo lô của MỘT worker; hai worker cùng lấy email của cùng một người trong cùng giây có thể vượt trần 1–2 thư (trần mềm, chấp nhận ở quy mô 1–3 operator). Email `OPEN` vẫn gửi dù cảnh báo đã đóng trước lượt gửi (thư "đã ổn" theo sau nếu người dùng chọn). Thư không có URL/host của đích — người nhận bấm deep link để xem. Biome báo `noUndeclaredDependencies` cho alias `@hub/common/…` như đã báo cho `@hub/flow`.
**Bổ sung (review CB5, 2026-10-12, append — sửa phần "Lấy lô" và "Đánh đổi" ở trên):**
- **Đồng hồ DB, không seam test trong query (T-1, TB-1):** bỏ `created_at <= now` và `now` tiêm vào; mọi so sánh/ghi mốc (`next_attempt_at`, `sent_at`, cửa sổ trần 1 giờ) dùng `now()` của Postgres. Test DB giới hạn vòng gửi bằng tuỳ chọn `tenantIds` (CHỈ test truyền, mỗi test một project) và giả lập thời gian trôi bằng cách lùi `next_attempt_at`/`sent_at` của dòng test. Worker của stack hubv tắt vòng gửi (`ALERT_EMAIL_INTERVAL_MS=0` trong `.env.verify` — không kịch bản L2 nào cần nó).
- **Fencing theo dòng (TB-2):** lease = giá trị `next_attempt_at` (đọc dạng text, đủ µs). Ngay trước khi gửi, `alertEmailOutboxRenew` gia hạn CÓ ĐIỀU KIỆN `… AND next_attempt_at = <lease đã lấy>`; 0 dòng = worker khác đã lấy lại → không gửi. `MarkSent/MarkSuppressed/MarkFailure`/trả lại đều kèm token lease mới — worker chậm không ghi đè kết quả của worker kia. Lượt ngừng khi đã dùng quá `lease − (hạn gửi + 15s)` và trả các dòng còn lại qua đường trả lại của shutdown.
- **Hạn chót (TB-3):** driver Resend có `AbortSignal.timeout(10s)` như Gmail; vòng gửi bọc mỗi lần gửi trong hạn chót tổng `ALERT_EMAIL_SEND_TIMEOUT_MS` (30s) — quá hạn = một lần lỗi.
- **T-2:** lúc lấy lô, dòng PENDING hết lease mà `attempts ≥ 3` (worker chết sau lần thử cuối) → `FAILED` ngay, không có lần thử thứ 4.
- **T-3:** thư RESOLVED chỉ gửi khi thư OPEN của cùng (cảnh báo, người) đã SENT/SUPPRESSED hoặc không có; OPEN còn PENDING → hoãn 30s (trả lại, không tốn lần thử); OPEN FAILED → RESOLVED `SUPPRESSED ineligible:open_not_sent` (người nhận chưa từng thấy cảnh báo).
- **T-5:** worker và hub-api hiện dùng CHUNG bộ `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` của driver gmail (một quota Gmail cho mail xác thực + cảnh báo). Khuyến nghị về sau: bộ `GMAIL_*` riêng cho email cảnh báo để bão cảnh báo không ăn quota thư đặt lại mật khẩu (DEPLOYMENT ghi chú).

---

## ADR-180 — Bloom filter gợi ý email đã tồn tại trên form đăng ký; đảo một phần R-6 có chủ đích (2026-10-12)

**Vấn đề:** R-6 (ADR-120) làm `POST /auth/register` trả cùng 201 cho email mới và email đã có. Người dùng gõ lại email cũ không biết mình đã có tài khoản. Admin muốn form đăng ký báo ngay (SPEC `_bmad-output/planning-artifacts/auth/SPEC-email-cuckoo.md`, kèm đính chính).
**Chọn:**
- **Endpoint `POST /auth/email-check {email}` → `200 {available}`.** Dùng POST để email không vào URL hay access log. Không cookie, không cần đăng nhập. Sai định dạng → 400 `bad_request`. Rate limit 20/phút/IP cộng trần toàn cục 600/phút (`AuthRateLimiter`, `EVAL` ngoài đường nóng). Vượt → 429 `too_many_attempts` kèm `Retry-After`. `/auth/register`, `/auth/login`, `/auth/forgot-password` **giữ nguyên R-6**.
- **Bloom filter trong bộ nhớ mỗi instance hub-api** (`bloom-filters@3.0.4`, `BloomFilter.create(EMAIL_FILTER_CAPACITY, 0.001)`, bọc trong `EmailFilterService`). Âm tính → trả ngay, **0 truy vấn DB**. Dương tính → xác nhận bằng PG (`findUserByEmail`), nên không bao giờ báo "đã dùng" sai. Chưa dựng xong, hoặc số phần tử vượt dung lượng (`degraded`) → hỏi thẳng DB. BB-2: filter là đường tắt, `UNIQUE(users.email)` vẫn là trọng tài.
- **Khoá** = `sha256(normalizeEmail(email))`, dùng chung chuẩn hoá của auth. Tin pub/sub qua Upstash chỉ mang hash.
- **Vòng đời:**
  - Dựng nền lúc boot từ `hub.users`, keyset `(id)` lô 1 000 qua `IdentityRepository.listUserEmailsAfter`.
  - Dựng lại định kỳ `EMAIL_FILTER_REBUILD_MS` (10 phút) vào bản **mới** rồi hoán đổi. Email thêm trong lúc dựng đi vào cả hai bản.
  - Thêm ở **một** chỗ: `AuthService.createUserWithFirstProject`, sau khi `$transaction` trả về (sau COMMIT). Cả ba đường mật khẩu, GitHub, Google đi qua đây. Operator do seed tạo (tiến trình khác) chỉ vào filter ở lượt dựng lại.
- **Đồng bộ:** `PUBLISH hub:auth:email-filter {op:'add', h, from}`. Instance phát tự thêm tại chỗ và bỏ tin vọng lại của chính mình. **Không mở connection subscriber thứ hai:** `redis/redis-channels.ts` là registry kênh dùng chung connection subscriber sẵn có của `RealtimeGateway`.
- **Metric:** `hub_email_filter_checks_total{result=negative|positive_confirmed|false_positive|db_fallback}` và `hub_email_filter_size`. Tiền tố `hub_` theo quy ước của mọi metric khác.
- **Giao diện `/register`:** debounce 400 ms, `AbortController`. `available:false` → gợi ý kèm link `/login` và `/forgot-password`, vùng `aria-live="polite"` gắn `aria-describedby`. 429 hoặc lỗi → im lặng. **Không bao giờ chặn submit.** Email mang sang trang kia qua `sessionStorage` (đọc một lần rồi xoá), không qua query string.

**Vì sao Bloom, không Cuckoo (spec ban đầu chọn Cuckoo vì xoá được):** `CuckooFilter` của `bloom-filters@3.0.4` có hai lỗi.
- **Âm tính giả khi đẩy chỗ.** Vị trí thay thế ở `cuckoo-filter.js:221-224` tính lệch `_locations` (XOR rồi mới mod, `Math.abs` trên int32 âm). Đo được 34 353/100 000 email đã thêm bị báo "chưa có" ở mức đầy 95%, và 24/50 000 email ngay ở mức đầy 38%.
- **Fingerprint tính theo byte nhưng dùng như số ký tự hex.** Kết quả: dương tính giả 2,9% thay vì 0,1%.

Gói `cuckoo-filter@1.1.4` thì `require` lỗi ngay (thiếu `cbor-js`). Bloom cùng thư viện đo được 0 âm tính giả. Repo không có đường xoá user hay đổi email, và lượt dựng lại định kỳ chữa được nếu sau này có. Bỏ hẳn op `remove`.

**Số đo (Node 22, 100 000 khoá sha256, `capacity` 100 000, FPR 0,001):**

| Chỉ số | Giá trị |
|---|---|
| Kích thước filter | 1 437 759 bit, k = 10 |
| Bitset (`arrayBuffers`) | +176 KB |
| `heapUsed` | +259 KB |
| Tổng mỗi bản | ≈ 435 KB |
| Đỉnh lúc dựng lại (hai bản cùng sống) | ≈ 0,9 MB |
| Dương tính giả đo được | 0,106–0,118% |
| CPU dựng 100k khoá | 1,2–1,35 s, chia theo lô 1 000 xen với `await` |

**Đánh đổi:**
- **Mở một oracle dò email.** Giảm thiểu bằng 20/phút/IP cộng 600/phút toàn cục. Lượt bị chặn ghi `auth_audit` với `emailHash`; không log email thô.
- **Âm tính giả tạm thời.** Có thể xảy ra ở instance mất tin pub/sub hoặc khi Redis chết, kéo dài tối đa tới lượt dựng lại. Hậu quả chỉ là mất một gợi ý; đăng ký vẫn đúng nhờ UNIQUE và R-6.
- **Thêm một lượt quét `users` mỗi 10 phút mỗi instance** (100 truy vấn keyset với 100k user).
- **Thêm một module dùng subscriber của gateway.** Gateway không chạy thì filter chỉ mất đồng bộ.
- **Ngân sách Redis R1 không đổi:** không lệnh nào trên đường nóng ingest/delivery; `redis-budget.spec.ts` xanh.

**Bổ sung (review lượt 1, 2026-10-12, append):**
- **TB-1: chỉ audit lần vượt trần đầu tiên của mỗi cửa sổ.** Mọi lần bị rate limit ở auth đều theo luật này: các scope qua `limit()` (login, register, refresh, OAuth callback, email-check), khoá email của login, và hạn mức mail. `auth_audit` chỉ ghi `auth.rate_limited` khi `count === limit + 1`. Các lần bị chặn sau đó chỉ trả 429, không INSERT. Trước đây mỗi request bị chặn ghi một dòng, nên một IP bắn 5k req/s thành 5k INSERT/s. Mỗi khoá, mỗi cửa sổ vẫn có đúng một dòng cho biết ai bị chặn và từ lúc nào. Lượt `release()` của login đúng mật khẩu có thể làm một cửa sổ có thêm dòng, nhưng số dòng vẫn bị chặn trên.
- **T-1: subscriber Redis của gateway subscribe lại ở mỗi lần `ready`.** Handler `message` được gắn một lần, ngoài promise `connect()`. Kênh đăng ký lúc `reconnecting` sẽ được subscribe ở lần `ready` kế tiếp. Lỗi của lần `connect()` đầu được log; ioredis tự thử lại (đã kiểm: promise bị reject, trạng thái `reconnecting`, sau đó `ready`). Trước đây trường hợp này làm realtime và đồng bộ filter chết vĩnh viễn.
- **T-2: kẻ tấn công có thể làm cạn trần toàn cục 600/phút để tắt gợi ý của mọi người.** Đây là đánh đổi có chủ đích: trần toàn cục chính là thứ giới hạn việc dò email hàng loạt từ nhiều IP. Bị chặn thì form vẫn hoạt động bình thường (429 thì im lặng, không bao giờ chặn submit, server vẫn là trọng tài). Hậu quả chỉ là tạm mất gợi ý.

---

## ADR-174 — Giao việc so chữ ký cho SDK chỉ khi đã kiểm SDK gọi `timingSafeEqual`: GitHub (octokit) và Stripe; PayOS tự so (DS4, 2026-10-12)

**Vấn đề:** CLAUDE.md và ARCHITECTURE §7.1 ghi "luôn `crypto.timingSafeEqual`, kể cả khi SDK có hàm verify riêng". Nhưng ba provider có ký làm ba kiểu: PayOS tự so (ADR-058), `GithubAdapter.verify` (`libs/providers/src/github.adapter.ts`) giao cho `verifyWithFallback` của `@octokit/webhooks-methods`, `StripeAdapter.verify` (`libs/providers/src/stripe.adapter.ts`) giao cho `stripe.webhooks.constructEvent`. Trông như mâu thuẫn.
**Chọn:** Quy tắc thật là **so chữ ký/khoá chỉ bằng `crypto.timingSafeEqual`, không bao giờ `!==`/`===`/`Buffer.equals`** — do ta gọi, hoặc do SDK gọi mà ta **đã đọc mã nguồn để xác nhận**:
- **PayOS — tự so:** SDK so bằng `!==` (ADR-058).
- **GitHub — giao SDK đã kiểm:** `@octokit/webhooks-methods` **4.1.0**, hàm `verify` (`dist-node/index.js`) so độ dài rồi gọi `crypto.timingSafeEqual`; `verifyWithFallback` lo sẵn xoay secret.
- **Stripe — giao SDK đã kiểm:** `stripe` **22.6.2**, `constructEvent` → `NodePlatformFunctions.secureCompare` (`cjs/platform/NodePlatformFunctions.js`) so độ dài rồi gọi `crypto.timingSafeEqual`.
CLAUDE.md và ARCHITECTURE §7.1 sửa theo.
**Đánh đổi:** Tin vào triển khai của SDK. Version được ghim bởi `package-lock.json`, nhưng `libs/providers/package.json` khai `^4.1.0` / `^22.6.2` nên `npm install` có thể kéo bản minor mới → **mọi lần lockfile đổi version octokit hoặc stripe phải kiểm lại** hàm so còn gọi `timingSafeEqual`.

---

## ADR-175 — nginx là tiến trình con thứ ba của `hub-all` (không đặt trong Shop, không chạy service riêng); `EDGE_NGINX` là công tắc rollback (EG1, 2026-10-12)

**Vấn đề:** Không có lớp nào chặn request rác trước khi hub-api chạm Postgres (Node nhận đủ body, giữ kết nối slowloris, `sourceKey` lạ vẫn query DB). Bản deployed không có Cloudflare phía trước; hub-api đứng thẳng sau proxy Render. Render free chỉ cho một container cho hub (ADR-129).
**Chọn:** nginx bản Debian thường (không Lua) cài trong image `node:22-slim`, chạy là con thứ ba `edge` của supervisor `docker/hub-all.js` khi `EDGE_NGINX=1`; hub-api lùi vào `HOST=127.0.0.1`, `PORT=EDGE_API_PORT` (4000), `TRUST_PROXY=1` (supervisor tự đặt — chỉ nginx gọi được nó, đúng một chặng). Một file cấu hình `docker/nginx/nginx.conf.template` cho cả deployed lẫn service `edge` ở compose local; dựng bằng `envsubst` với **danh sách biến cố định** và env **chỉ** gồm các biến đó (`docker/nginx/edge.js`) — biến nginx (`$remote_addr`…) và secret của container không bao giờ vào file; giá trị được kiểm/kẹp trước khi chèn, sai thì thoát lúc khởi động. Không đặt trong Shop: hub-api vẫn có URL `*.onrender.com` công khai nên đi vòng được, và cửa vào của hub không được phụ thuộc client của nó (BB-1). Mặc định **tắt** — không đặt biến thì `hub-all` chạy đúng hai con như trước [EG:T16]. Thêm hai điều phiên dev phát hiện khi làm:
- **Thứ tự tắt máy lệch spec §3.1 ("đồng thời"):** nginx nhận `SIGQUIT` + worker nhận `SIGTERM` ngay, nhưng hub-api chỉ nhận `SIGTERM` **khi nginx đã thoát** (chậm nhất `EDGE_DRAIN_MS` = 16 s). Lý do: hub-api thoát ngay khi SIGTERM (`shutdown.ts`, không `app.close()`), nên gửi đồng thời thì request đang proxy mất phản hồi — test đối chứng của [EG:T9] chứng minh (502). nginx `worker_shutdown_timeout 15s` + hub-api ghi nốt ≤ 5 s < 25 s.
- **Access log đi syslog UDP 127.0.0.1 về supervisor**, không phải `/dev/stdout`: stdout của tiến trình con do Node spawn là socket, nginx `open("/dev/stdout")` lỗi ENXIO và không khởi động. Service `edge` ở compose (nginx là PID 1) vẫn ghi `/dev/stdout`.
**Đánh đổi:** Thêm ~13 MB RSS và một tiến trình nữa chung số phận container (nginx chết → cả nhóm dừng, Render khởi động lại — như hai con kia). Gói UDP log có thể rơi khi quá tải → mất dòng access log (không mất request); lần cầu chì chặn vẫn có dòng `limiting requests` ở error log (stderr, luôn tới supervisor). Request đang chạy lúc tắt máy giờ được trả lời (tốt hơn hôm nay), đổi lại hub-api sống thêm tối đa 16 s sau SIGTERM. Ở compose local, hub-api giữ `TRUST_PROXY=0` (cổng 4000 mở cho k6) nên request qua `edge` có `req.ip` = IP container edge.

## ADR-176 — Cầu chì IP chỉ `/hooks/*` + `/v1/p/*`, trần 50 r/s burst 500; công tắc `EDGE_IP_FUSE` mặc định TẮT tới khi đo IP thật trên Render (EG1, 2026-10-12)

**Vấn đề:** Admin chốt Q2 "cầu chì theo IP bật ngay, ghi log". Nhưng §3.2 của spec: chưa đo IP thật = không bật cầu chì — sau proxy Render, nếu nginx không đọc đúng IP client thì mọi request mang cùng một IP và cầu chì chặn tất cả mọi người. Phiên dev không có quyền Render, không đo được.
**Chọn:** `limit_req zone=hooks_ip` (khoá `$binary_remote_addr`) chỉ ở location `/hooks/<provider>/<sourceKey>` và `/v1/p/`; **không** ở `/api/*`, `/auth/*` (console đi qua proxy Vercel = một IP; đăng nhập đã có giới hạn IP + email riêng), `/socket.io/*`, `/health`. Trần `EDGE_IP_RATE=50` r/s, `EDGE_IP_BURST=500`, đổi bằng env không cần build. Chặn → `429` + `Retry-After: 1` + body tĩnh khuôn ERRORS.md `edge_rate_limited` (mã có trong catalog, test so message), log JSON `limit_req_status=REJECTED`. Bật/tắt bằng `EDGE_IP_FUSE` (khoá rỗng = nginx không đếm): **mặc định tắt** trong image/hub-all; Q2 "bật ngay" áp dụng **sau khi** Admin đo IP thật theo `DEPLOYMENT.md` §3.6 (lần đầu dùng `EDGE_TRUSTED_PROXIES=0.0.0.0/0,::/0` + `EDGE_REAL_IP_RECURSIVE=off` = đúng hành vi `trust proxy 1` hôm nay, rồi xác nhận `ip` trong log = IP thật, không phải IP giả hay IP proxy). Local/hubv không có proxy phía trước nên compose bật sẵn (`EDGE_IP_FUSE=1`, hubv trần thấp 5/10 cho [EG:T10]). nginx **ghi đè** `X-Forwarded-For`/`X-Real-IP` bằng `$remote_addr` khi chuyển lên hub-api → `req.ip` của hub-api trùng IP nginx đếm [EG:T11]. Phần §3.4 (trần body, timeout slowloris, `limit_conn` 50/IP ở `/hooks/*`, lọc thô `sourceKey`) luôn chạy khi có nginx.
**Đánh đổi:** Trần phải đủ cho **tổng** lưu lượng một provider trên **mọi** tenant — GitHub/PayOS gửi webhook của mọi project từ chung dải IP; hub nhiều tenant thì cộng dồn trên cùng IP. Chặn oan provider = mất sự kiện (GitHub không tự gửi lại) — chấp nhận, đổi lại có log; trần cao + log được chọn thay chế độ "chỉ log". Chưa có metric riêng cho lần nginx chặn (không Lua, P2 §9). Khi `EDGE_TRUSTED_PROXIES` chưa đặt mà vẫn bật cầu chì, supervisor cảnh báo lúc khởi động. `limit_conn` 50/IP luôn chạy khi có nginx — nếu `EDGE_TRUSTED_PROXIES` để trống trên Render (mọi request mang IP proxy), nó thành trần 50 kết nối `/hooks/*` đồng thời cho **toàn bộ** container (hub-api với 5 kết nối DB cũng không xử lý nổi hơn thế).

## ADR-177 — Hộp phạt IP của `/hooks/*` nằm trong hub-api, trạng thái trong bộ nhớ, không Lua, không Redis; 401 phạt theo cặp (IP, sourceKey), 404 của source đã lưu trữ không tính điểm (EG2, 2026-10-12)

**Vấn đề:** ingest nạp source từ Postgres trước mọi lớp chặn — `sourceKey` ngẫu nhiên chạm DB không giới hạn (pool Neon rất nhỏ), còn ai biết một `sourceKey` thật thì bắn chữ ký sai bao nhiêu cũng được. nginx bản thường (không Lua, Q3) không biết request vừa rồi ra 404 hay 401.
**Chọn:** `apps/hub-api/src/modules/ingest/penalty-box.ts`, trạng thái trong bộ nhớ từng instance, **0 lệnh Redis, 0 truy vấn DB** (`redis-budget.spec.ts` không đổi). Luật (a): ≥ 20 lần 404 do **không tìm thấy** source trong 60s → chặn mọi `/hooks/*` của IP đó 10 phút, kiểm **trước** khi nạp source. Luật (b): ≥ 30 lần 401 trong 60s → chặn **chỉ cặp (IP, sourceKey)** 10 phút. IPv6 gộp theo /64. 429 `ip_temporarily_blocked` + `Retry-After`, log `warn` một lần khi bắt đầu phạt, metric `hub_ingest_penalty_{bans,blocked}_total{reason}`, `hub_ingest_penalty_entries`, `hub_ingest_unknown_source_total`. Tham số `EDGE_PENALTY_*` kẹp khoảng như `resolveSendTimeoutMs`. Lỗi trong hộp phạt → cho đi qua (fail-open).
**Đánh đổi:**
- **Mỗi instance đếm riêng** → ngưỡng thực tế nhân theo số instance hub-api; phạt không lan sang instance khác. Chấp nhận: mục tiêu là bịt lỗ 404→DB rẻ nhất có thể, không phải bộ đếm chính xác toàn cụm.
- **404 của source tắt/đã lưu trữ không tính điểm:** provider thật vẫn gửi vào source đã "Xoá" (ADR-161); đếm nó là khoá IP của GitHub/PayOS cho mọi tenant.
- **401 phạt theo cặp, không phạt cả IP:** một tenant cấu hình sai secret GitHub làm IP GitHub ra 401 hàng loạt; phạt cả IP là tenant khác dùng chung GitHub mất webhook. Cái giá: kẻ đổi `sourceKey` liên tục không bị luật (b) bắt — nhưng `sourceKey` lạ thì rơi vào luật (a).
- **Bộ nhớ có trần** `EDGE_PENALTY_MAX_ENTRIES` (50.000), LRU, khoá đang bị phạt giữ lâu hơn khoá đang đếm → nhiều IP chỉ làm hộp đầy, không cạn RAM; khi đầy thì có thể quên bớt bộ đếm của IP chưa bị phạt.
- `/v1/p/*` (`publishFromService`) **chưa** áp luật (b): 401 API key nằm ở `ApiKeyGuard`, không đi qua ingest; để P2 nếu có số đo cần.

---

## ADR-178 — Rate limit theo source chạy SAU `adapter.verify` (EG3, 2026-10-12)

**Vấn đề:** `checkRateLimit` chạy trước verify nên request sai chữ ký vẫn tiêu hạn mức `rate:source:{id}`. Ai biết một `sourceKey` thật (lộ qua log, ảnh chụp) bắn 100 request ký sai mỗi phút là PayOS/GitHub thật của nạn nhân nhận 429. Hộp phạt (ADR-177) chỉ ra tay sau 30 lần/cặp và không bắt được kẻ xoay IP.
**Chọn:** thứ tự mới: hộp phạt IP → nạp source → hộp phạt cặp → verify → **rate limit** → idem key → GET idem → tx → SET NX (ARCHITECTURE §3.1). Chỉ request ký đúng mới tiêu hạn mức. Sự kiện hợp lệ vẫn 3 lệnh Redis; request sai chữ ký 1 → **0** lệnh (`redis-budget.spec.ts` [EG:T8]). `/v1/p/*/events` không đổi (API key đã xác thực ở `ApiKeyGuard` trước khi tới rate limit).
**Đánh đổi:** request sai chữ ký tốn thêm một HMAC (body ≤ 1MB, vài micro giây tới ~1ms) mà trước đây có thể bị 429 chặn trước — đổi lại source không bị khoá oan. Rate limit vẫn chặn đúng hai thứ nó cần: provider gửi lại dồn dập và secret bị lộ. Spec QT (chưa code) sẽ chèn "khoá dung lượng" ngay sau bước nạp source, trước hộp phạt cặp.

---

## ADR-179 — Lưu lượng theo source: gộp theo phút trong bộ nhớ hub-api, đẩy xuống Postgres mỗi 60s, giữ 7 ngày; được phép thiếu, không được làm chậm ingest (EG4, 2026-10-12)

**Vấn đề:** `trace.ingested` (ACCEPTED/DUPLICATE/REJECTED/RATE_LIMITED) chỉ phát realtime, không lưu; `RATE_LIMITED` không để lại dấu vết nào, còn REJECTED chỉ có mẫu ≤ 20/phút/source. Chủ project và người vận hành không biết source của mình đang bị dội bao nhiêu.
**Chọn:** bảng `hub.source_traffic_minutely` (tenant_id + RLS, PK `(tenant_id, source_id, minute, outcome)`, `top_ips` ≤ 5, IPv6 theo /64). `traced()` cộng vào Map trong bộ nhớ (`traffic-recorder.ts`, 0 truy vấn + 0 Redis trên đường nóng); mỗi `TRAFFIC_FLUSH_MS` mỗi project MỘT câu upsert `count = count + excluded.count` qua `forTenant`. Ghi lỗi → giữ tối đa 10 phút, quá thì bỏ phần cũ + `hub_traffic_flush_dropped_total`. Tắt máy: ghi nốt qua `onShutdownFlush` (chạy song song với bộ đếm bản trùng, chung trần 5s trong ngân sách 25s). Cleanup xoá cũ hơn `TRAFFIC_RETENTION_DAYS` (7). 404 của sourceKey lạ **không** lưu (không thuộc tenant nào) — chỉ metric + log; không tạo bảng toàn hub không có `tenant_id` (BB-5).
**Đánh đổi:**
- Mất tối đa ~60s số liệu khi tiến trình bị SIGKILL, và mất phần quá 10 phút khi DB chết lâu — chấp nhận: đây là số liệu quan sát, không phải trọng tài (BB-2 không đổi).
- `top_ips` là xấp xỉ: mỗi ô (source, phút, outcome) chỉ theo dõi 64 IP khác nhau trong bộ nhớ, ghi 5 IP lớn nhất; gộp nhiều instance là gộp các top-5.
- `REJECTED` gộp cả 401 sai chữ ký lẫn 422 thiếu khoá chống trùng (đúng như `trace.ingested`); ERROR (5xx) không lưu — đã có metric + log.
- Thêm một lượt ghi DB mỗi 60s mỗi instance mỗi project có lưu lượng.
- **Yêu cầu thay đổi gửi sang CB (ghi lại, CHƯA code — §5.3 SPEC-chong-qua-tai):** (1) evaluator luật `source.signature_failing` nên đếm từ `source_traffic_minutely` (outcome REJECTED) thay vì mẫu `REJECTED` trong `raw_events` (mẫu có trần 20/phút nên đếm thiếu); (2) luật mới `source.rate_limited`, mức warning, bật khi có ≥ 1 phút `RATE_LIMITED` trong 15 phút gần nhất, người nhận vẫn chỉ là người vận hành. Không sửa evaluator trong EG4 để không trộn với nhánh alerts.

---

## ADR-181 — Quyền xem lưu lượng theo source là scope `traffic:read` (owner + người vận hành), khối "Lưu lượng" mở từ trang Nguồn (EG5, 2026-10-12)

**Vấn đề:** lưu lượng theo source lộ IP người gửi và tỷ lệ sai chữ ký — thông tin vận hành/an ninh, không phải dữ liệu nghiệp vụ mà mọi thành viên cần. Admin chốt (Q6): người vận hành + `owner` của project xem được; `developer`/`viewer` thì không.
**Chọn:** scope mới `traffic:read` thêm vào `ALL_SCOPES` và CHỈ bó `owner` của `ROLE_SCOPES`; người vận hành không là thành viên đi qua `viaOperator` (= owner, có `operator.access` audit như mọi route). Route `GET /api/v1/projects/:p/sources/:id/traffic` khai `@RequireScope('traffic:read')` — không `if` theo vai trò. Không cấp cho API key (`KEY_GRANTABLE_SCOPES` không đổi). Câu nhận định `I-traffic` là hàm thuần `buildTrafficInsight` (libs/common) trả `code + level + facts`, câu chữ vi/en dựng ở web. Repo console chưa có trang chi tiết source → khối Lưu lượng là **ngăn bên (Sheet)** mở từ nút trên từng dòng của trang Nguồn, không tạo trang mới.
**Đánh đổi:**
- Thêm một scope làm `ROLE_SCOPES.owner` dài thêm; role tuỳ biến sau này phải nhớ cân nhắc scope này.
- `blockedNow` chỉ là của instance hub-api đang trả lời (hộp phạt trong bộ nhớ) — UI ghi rõ là ước lượng.
- Bảng "IP gửi nhiều nhất" gộp top-5 của từng phút → xấp xỉ (IP gửi đều nhưng chưa bao giờ lọt top-5 của phút nào sẽ không hiện). UI ghi rõ.
- Lớp biên toàn hub (sourceKey lạ, hộp phạt) chỉ có panel Grafana 9–10 — màn hình console để P2 vì cần dữ liệu không thuộc tenant.

**Bổ sung ADR-177 (review `feat/edge`, 2026-10-12, append):**
- **CHẶN — hộp tự vô hiệu khi đầy:** ban hết hạn chỉ bị xoá khi đúng khoá đó quay lại, còn `evict()` loại khoá "đang đếm" trước (kể cả khoá vừa chèn) → sau khi ≥ `maxEntries` IP bị phạt (IPv6 /48 ≈ 65k /64), IP mới không bao giờ bị phạt nữa. Sửa: mỗi lần chấm điểm quét đầu Map `banned` bỏ ban hết hạn (banMs cố định → thứ tự chèn = thứ tự hết hạn, O(1) khấu hao); không bao giờ loại khoá vừa chèn; `banned` có trần riêng ≤ 50% `maxEntries` — đầy thì KHÔNG tạo ban mới, log `warn` (≤ 1 lần/phút) + `hub_ingest_penalty_bans_skipped_total{cause="capacity"}` (fail-open có tiếng).
- **CHẶN — chặn chéo tenant qua IP chung của provider (lỗ của spec):** luật (a) — kẻ xấu trỏ repo GitHub của nó vào `/hooks/github/<key không tồn tại>` và tự kích ≥ 20 event/phút → IP hook GitHub bị chặn mọi `/hooks/*`, mọi tenant mất webhook; luật (b) — kẻ biết sourceKey nạn nhân đặt webhook GitHub secret sai vào đó → cặp (IP GitHub, key nạn nhân) bị phạt. Sửa (0 DB, 0 Redis): cache **cặp tốt** trong bộ nhớ = (ipKey, sourceKey) đã verify đúng trong `EDGE_PENALTY_GOOD_TTL` (mặc định 24h, kẹp 5 phút–7 ngày), LRU, trần riêng = `maxEntries`. Luật (a): IP đang bị ban vẫn thông cặp tốt, chỉ key lạ/chưa từng verify từ IP đó bị 429. Luật (b): cặp tốt chỉ ĐẾM, không BAN (`cause="good_pair"`). Đánh đổi: kẻ biết key nạn nhân bắn sai chữ ký từ IP GitHub chỉ còn tốn HMAC (EG3 đã bảo đảm không tiêu rate limit); kẻ tự làm IP mình "tốt" bằng source hợp lệ của nó chỉ thông đúng key của nó. **Rủi ro còn lại chấp nhận:** source mới hoặc ít nhận webhook (chưa có trong cache, hoặc instance vừa khởi động) từ một IP provider đang bị ban có thể mất sự kiện trong thời gian ban (10 phút).
- **NÊN — IP dùng chung sau NAT/proxy:** IP loopback/private (127/8, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7, kể cả IPv4-mapped) không chấm điểm, không chặn (log debug); công tắc `EDGE_PENALTY_ENABLED` (mặc định 1). Đánh đổi: kẻ tấn công từ trong mạng riêng (hoặc khi proxy chưa được tin → mọi `req.ip` là IP của proxy) không bị hộp phạt bắt — đúng hướng fail-open. Cấu hình hub-api tin subnet của `edge` ở compose thuộc EG1.
- **Thấp:** cửa sổ cố định 60s nên một IP có thể lọt tới `2 × ngưỡng − 1` request ở mép hai cửa sổ trước khi bị phạt — chấp nhận (cùng sai số với rate limit theo source). 429 của hộp phạt ghi metric `outcome="BLOCKED"` (trước là `INVALID`). Lỗi metric không còn lật verdict `blocked` thành "cho qua". `ipKey` chuẩn hoá cả IPv4-mapped dạng hex (`::ffff:cb00:7107`).

**Bổ sung ADR-179 (review `feat/edge`, 2026-10-12, append):** upsert là cộng dồn (`count = count + excluded.count`) — nếu một lượt ghi bị timeout phía client nhưng thật ra đã COMMIT, lượt sau gửi lại cùng số và **cộng trùng**. Chấp nhận: số liệu quan sát, không phải trọng tài (không thêm khoá chống trùng cho bảng này). `top_ips` trong bộ nhớ dùng space-saving (trần 64 IP mỗi ô; đầy thì IP mới thay IP có đếm nhỏ nhất, kế thừa đếm + 1) thay cho "nhận 64 IP đầu tiên" — IP dồn dập đến sau vẫn lên top. `onShutdownFlush` trả hàm gỡ; `IngestService` gỡ khi `onModuleDestroy`.

**Bổ sung ADR-177 lần 2 (review `43c1a35`, 2026-10-12, append):**
- **CHẶN — đẩy cặp tốt của nạn nhân khỏi LRU chung:** cache tốt một tầng (`maxGood = maxEntries`) cho phép kẻ xấu có source riêng bắn ~50k request ký đúng từ 50k /64 khác nhau (IPv6 /48) để đẩy mọi cặp tốt thật ra, rồi dùng chiêu 404 qua IP GitHub chặn lại mọi tenant; thêm nữa `markGood` chạy TRƯỚC rate limit nên request bị 429 vẫn được tính tốt. Sửa: cache **chia theo sourceKey** — mỗi key một LRU riêng ≤ `EDGE_PENALTY_GOOD_IPS_PER_KEY` (64, kẹp 4–1024) IP, nên một key không đẩy được cặp của key khác; bảng ngoài theo key có trần `maxGoodKeys` (= `EDGE_PENALTY_MAX_ENTRIES`), loại key **hoạt động cũ nhất**, key hết hạn được quét ở đầu bảng. `markGood` chỉ chạy khi rate limit đã cho qua. **Chi phí / rủi ro còn lại:** để đẩy key thật ra, kẻ xấu cần cỡ `maxGoodKeys` (50.000) source hợp lệ ĐANG gửi đúng chữ ký đều đặn (mỗi source của project nó, mỗi source tiêu rate limit riêng) — nhiều hơn mọi tenant thật trong phạm vi đồ án; key có > 64 IP gửi tới (provider dùng dải IP lớn) có thể quên bớt IP ít gửi. Bộ nhớ tối đa ≈ `maxGoodKeys × 64` mục (trường hợp xấu nhất cỡ vài trăm MB khi cả 50k key đều đầy 64 IP — chấp nhận vì cần chừng ấy source hợp lệ đang hoạt động; hạ `EDGE_PENALTY_MAX_ENTRIES` nếu RAM chật).
- **NÊN — cặp tốt được miễn luật (b) vô hạn:** 1 request ký đúng vào source của chính kẻ xấu rồi bắn sai mãi từ cùng IP thì mỗi request chạm DB (tra source, giải mã, HMAC, ghi mẫu REJECTED) mà không bao giờ bị ban. **Chọn: nâng ngưỡng, không miễn** — cặp tốt bị ban ở `threshold401 × EDGE_PENALTY_401_GOOD_MULTIPLIER` (mặc định 30 × 10 = 300 lần/60s, kẹp hệ số 2–100). Không chọn "chỉ ban khi cửa sổ không có chữ ký đúng" vì kẻ xấu chỉ cần chen một request đúng mỗi phút là miễn mãi. Đánh đổi: GitHub dùng chung IP với đúng/sai xen kẽ chỉ bị ban oan khi một source nhận ≥ 300 chữ ký sai/phút từ một IP (khi đó source đằng nào cũng đang bị dội); flood trên cặp tốt vẫn lọt tối đa ~300 request/phút/instance trước khi bị ban.
- **NÊN — bỏ qua IP private đang câm:** thêm `hub_ingest_penalty_skipped_total{cause="private_ip"}`, log `warn` ≤ 1 lần/giờ/tiến trình khi gặp IP private lúc `NODE_ENV=production` hoặc `TRUST_PROXY=1`, đường "skipped_private" trên panel Grafana 10 (> 50% `/hooks` = cấu hình IP sai). Danh sách private thêm 169.254/16, fe80::/10, 100.64/10 (CGNAT — nhiều thuê bao chung một IP, không phân biệt được người).
- Metric `bans_skipped{cause="good_pair"}` của lần bổ sung trước bỏ (luật (b) giờ ban ở ngưỡng cao hơn); chỉ còn `cause="capacity"`.

**Bổ sung ADR-177 lần 3 (review `b764dc3`, 2026-10-12, append — theo D7/D9 của spec đính chính):**
- **CHẶN — cache tốt không có trần tổng:** đo thật 50k key × 64 IP ≈ 3,1 triệu mục, heap +340MB — Render free có 512MB cho cả `hub-all` → OOM. Sửa: trần tổng `EDGE_PENALTY_GOOD_MAX_ENTRIES` (100k ≈ 11MB, kẹp 2k–2M), `maxGoodKeys` có trần riêng `EDGE_PENALTY_GOOD_MAX_KEYS` (10k), `EDGE_PENALTY_GOOD_IPS_PER_KEY` mặc định hạ xuống 16; vượt trần thì loại key hoạt động cũ nhất (không bao giờ loại key vừa chạm); gauge `hub_ingest_penalty_good_entries`. Mỗi key lưu `lastExp` nên quét hết hạn ở đầu bảng là O(1) khấu hao.
- **NÊN — đẩy key nạn nhân bằng nhiều source:** chưa có quota source/project nên tạo nhiều source là rẻ. Sửa: `markGood(ip, sourceKey, tenantId)`; mỗi tenant tối đa `EDGE_PENALTY_GOOD_KEYS_PER_TENANT` (64) key trong cache, LRU theo tenant — một tenant chỉ đẩy được key của chính nó. **Rủi ro còn lại:** kẻ xấu dùng nhiều tài khoản/project (≈ `maxGoodKeys / 64` ≈ 160 project, mỗi project 64 source đang gửi chữ ký đúng) vẫn đẩy được key thật khỏi bảng ngoài; chặn triệt để phụ thuộc quota của SPEC QT (`quota/SPEC-han-muc-dung-luong`) và giới hạn số project mỗi tài khoản.
- **NÊN — metric private đếm 2–3 lần mỗi request:** bỏ hook khỏi `keyOf`; `ingestCore` kiểm `isLocalOrPrivateIp(req.ip)` một lần mỗi request và tăng `hub_ingest_penalty_skipped_private_total` (đổi tên theo D9, thay `hub_ingest_penalty_skipped_total{cause="private_ip"}`). Panel Grafana 10 lấy mẫu số `hub_ingest_requests_total{provider!="api"}`.
- **Thấp — IP bị ban luật (a) vẫn gửi được vào key của chính nó:** một IP đang bị ban luật (a) mà có cặp tốt thì vẫn gửi request ký đúng vào đúng key đó; giới hạn bởi rate limit theo source (ADR-178) và cầu chì nginx. Đây là hành vi của một source thật — chấp nhận.

**Bổ sung ADR-177 lần 4 (review `9dbad75`, 2026-10-12, append):** trần toàn cục `EDGE_PENALTY_GOOD_MAX_KEYS` (10k) loại key cũ nhất TOÀN CỤC nên 157 tenant × 64 key (≈ 10k source, 10k request) đẩy được key của nạn nhân. Sửa: chạm trần toàn cục (số key hoặc số mục) thì loại **key cũ nhất của tenant đang giữ nhiều key nhất** — tìm bằng bucket theo số key (`số key -> tập tenant` + `maxTenantKeys`, đổi ±1 nên O(1)). Tenant chỉ có 1–2 key chỉ bị đụng khi mọi tenant đã xuống còn chừng ấy key. **Chi phí kẻ xấu giờ:** cỡ `GOOD_MAX_KEYS` (≈ 10k) project mỗi project một source đang gửi chữ ký đúng mới đẩy được key của một tenant nhỏ; chặn triệt để vẫn cần quota của SPEC QT (số project / tài khoản). Kẹp trên `EDGE_PENALTY_GOOD_MAX_ENTRIES` hạ xuống 500k (~110 byte/mục ≈ 55MB). `markGood` chỉ ghi `tenantId` lúc key vào cache lần đầu (sourceKey duy nhất toàn hub); nếu sau này có đường chuyển source giữa project thì phải gọi `forgetGoodKey`.

**Bổ sung ADR-177 lần 5 (review `ede7c4b`, 2026-10-12, append — đính chính số của lần 4):**
- **Thứ tự trong bucket = hoạt động (TB-1).** Bucket cũ xếp theo lúc tenant *vào* bucket, nên ở chế độ mọi tenant còn 1 key, key ĐANG gửi của nạn nhân bị loại trước key nằm im của kẻ xấu. Sửa: mỗi `markGood` đưa tenant về cuối bucket của nó (`delete` + `add`, O(1)) — cùng mức thì tenant nằm im lâu nhất bị loại.
- **Loại theo đúng đại lượng của trần bị chạm (NÊN-1).** Hai bộ đếm-bucket theo tenant: số **key** (trần `GOOD_MAX_KEYS`) và số **mục/IP** (trần `GOOD_MAX_ENTRIES`). Chạm trần mục thì loại key cũ nhất của tenant giữ nhiều **mục** nhất — tenant 3 key × 1 IP không còn bị coi là "giàu nhất" trước 130 tenant × 16 IP. Vẫn O(1) khấu hao: chuyển bucket O(1) dù đếm đổi bao nhiêu (gỡ key bớt tới `GOOD_IPS_PER_KEY` mục một lần); bucket cao nhất chỉ tăng ≤ 1 mỗi `markGood` nên tổng bậc lùi ≤ tổng bậc tăng. **Chi phí kẻ xấu:** đẩy được key 1 IP của tenant nhỏ cần mọi tenant xuống còn 1 key/1 mục, tức ≈ `GOOD_MAX_KEYS` (10k) project mỗi project một source gửi chữ ký đúng (trần key chạm trước trần mục). Max-min vẫn cắt tenant lớn: cắt tenant 64 key xuống k key cần ≈ `GOOD_MAX_KEYS / k` project (vd 312 project cắt còn 32 key) — chặn triệt để cần quota SPEC QT.
- **RAM (TB-2) — số lần 4 sai.** "~110 byte/mục, 500k ≈ 55MB" chỉ đúng khi mỗi key nhiều IP. Đo heapUsed (sourceKey 24 ký tự, tenantId UUID, mỗi tenant 1 key — xấu nhất): **~850 byte/key** kèm IP đầu + **~120 byte** mỗi IP thêm → RAM ≈ `KEYS × 850 + (ENTRIES − KEYS) × 120`. Kẹp cũ `GOOD_MAX_KEYS` ≤ 1.000.000 cho phép 500k key × 1 IP ≈ 425MB (OOM trên 512MB). Hạ kẹp trên `EDGE_PENALTY_GOOD_MAX_KEYS` xuống **50.000**: hai trần (50k key, 500k mục) đo ≈ 79MB; mặc định (10k, 100k) ≈ 17MB. Đánh đổi: operator không thể nhớ quá 50k source tốt mỗi instance; key bị loại chỉ mất ưu tiên "cặp tốt" (vẫn verify bình thường), không mất webhook trừ khi IP chung đang bị ban.
- `clampEnvInt` coi chuỗi trắng là rỗng (về mặc định, không về min). `forgetGoodKey` **chưa ai gọi** (không có đường chuyển source giữa project / xoá cứng; xoay secret không cần) — giữ kèm test, ghi rõ chỉ tác dụng trên instance hiện tại; instance khác chờ TTL.

**Bổ sung ADR-177 lần 6 — D3, gate trước body parser (2026-10-12, append):** IP/cặp đã bị cấm vẫn khiến Node đọc + parse body tới 1MB rồi ingest mới trả 429. **Chọn:** `penalty-gate.ts` (`app.use` NGAY TRƯỚC `configureBodyParsers`), route là mảng cấu hình (mặc định `['/hooks']`), sourceKey lấy bằng khuôn của nginx `^/([a-z0-9-]+)/([A-Za-z0-9_-]{1,64})$` sau khi decode từng đoạn như `@Param()`; chỉ `checkIp` + `checkPair`, chấm điểm vẫn ở ingest. `PenaltyBox` thành provider Nest (`PENALTY_BOX_PROVIDER`) — gate và `IngestService` dùng MỘT instance. Chặn → 429 dựng bằng `blockedAck` dùng chung + `Connection: close` (`shouldKeepAlive=false`) để không nhận nốt body; metric `BLOCKED` + lưu lượng `BLOCKED` của cặp ghi đúng một lần ở gate. **Đánh đổi:** path không khớp khuôn (vd provider viết hoa) hoặc gate lỗi → cho qua (fail-open), ingest vẫn kiểm lại sau body parser — chỉ mất phần tiết kiệm body, không mất chặn. Không làm D5 (Content-Length: `raw-body` đã từ chối trước khi đọc) và D6 (`/v1/p`). Test `[EG:T19]`.

**Bổ sung ADR-177 lần 7 — review EG lượt 6 (2026-10-12, append):**
- **TB-1 — gate né được bằng `#frag`, absolute-form `http://h/hooks/...`, provider viết hoa:** gate tách path bằng `originalUrl.split('?')` + khuôn nginx, còn router Express 5 của Nest dùng `parseurl(req).pathname` và không phân biệt hoa thường → IP/cặp đang bị ban gửi đúng sourceKey hợp lệ vẫn khiến Node đọc body 1MB (luật b còn chạm DB). **Chọn:** helper chung `apps/hub-api/src/modules/ingest/hooks-path.ts` — `hooksPathOf(req)` (parseurl lấy từ đúng bản `router` của `@nestjs/platform-express` dùng) + `matchHookRoute(pathname, routes)` (tiền tố không phân biệt hoa thường, một `/` cuối, đúng 2 đoạn khác rỗng, decode như `@Param()`, route lồng nhau thử tiếp); gate **không lọc provider, không kiểm khuôn sourceKey** — mọi path router giao cho ingest thì gate kiểm (`checkIp`/`checkPair` chỉ cần sourceKey; key lạ chỉ còn luật (a), đúng như ingest bước 0). Nhãn metric vẫn qua `providerMetricLabel` (lạ → `unknown`). Nhánh nginx dùng lại `hooksPathOf` cho `rejectNonCanonicalHooksPath` khi rebase. Đánh đổi: thay phần "path lạ → cho qua" của lần 6. Test `[EG:T19]` cho cả ba.
- **NÊN-1 — đính chính "O(1)":** LRU bằng `Map`/`Set` (`delete` + `set`, đọc phần tử đầu) trên V8 phải bước qua các "lỗ" chưa rehash → mỗi thao tác O(dung lượng bảng) xấu nhất, bị chặn trên bởi các trần. Số đo (review R6): `markGood` key mới khi bảng đầy ~3µs @1k, ~19µs @10k (mặc định), ~41µs @50k (kẹp trên); `recordUnknownSource` IP mới khi hộp đầy ~3µs @1k, ~24µs @10k, ~31µs @50k (mặc định, không cần xác thực). **Chọn (a):** sửa comment + ghi ở đây, **chưa** viết danh sách liên kết — mọi bảng (`counting`, `banned`, `good`, `ips`, `tenantKeys`, bucket) đều phải đổi, node object làm số RAM đã đo (17MB/79MB) mất hiệu lực, và chi phí hiện tại vẫn nhỏ hơn một truy vấn DB. Đánh đổi: flood 404 không xác thực tốn thêm ~31µs CPU đồng bộ/request ở trần mặc định; nếu đo thấy event loop nghẽn thì làm (b): LRU danh sách liên kết + quét hết hạn mỗi K thao tác, kèm test tỉ lệ N=50k/N=1k < 3.
- **THẤP-1 — giảm đếm bị coi như "vừa hoạt động":** `TenantTally.add(delta<0)` đưa tenant về cuối bucket. **Chọn:** mỗi bucket có hai nhóm — **nguội** (vào do hết hạn / bị loại) đứng trước **nóng** (thứ tự chạm); giảm trong chính `markGood` của tenant đang gọi (đẩy IP theo `goodIpsPerKey`, vượt `goodKeysPerTenant`) vẫn tính là nóng. Đánh đổi: trong nhóm nguội thứ tự là lúc bị giảm (FIFO), không phải lúc hoạt động cuối — tenant bị giảm luôn đứng trước tenant vừa hoạt động cùng mức.

**Bổ sung ADR-177 lần 8 — review EG lượt 7 (2026-10-12, append):** THẤP-A: vòng loại theo trần tổng cuối `markGood` đưa victim về nhóm **nguội** kể cả khi victim là key của chính tenant đang gọi (≈51% số lần loại) → tenant vừa gửi đứng trước tenant nằm im cùng mức, trái luật "nằm im lâu nhất bị loại trước". **Chọn:** `removeGoodKey(victim, tenantId === t)` — cùng tenant đang gọi thì vẫn nóng. Đánh đổi: không có; luật lần 7 "bị loại → nguội" giờ chỉ áp cho tenant KHÁC. THẤP-B: SPEC-chong-qua-tai thêm đính chính D16 (D4(3) + dòng T19 theo lần 7).

**Bổ sung ADR-175/176 (review EG1 + review `feat/edge`, 2026-10-12, append):**
- **`/socket.io/` mất header ghi đè (sửa):** nginx không kế thừa `proxy_set_header` của `server` vào location có `proxy_set_header` riêng (Upgrade/Connection) → XFF giả và `x-request-id` sai khuôn lọt lên hub-api. Lặp đủ 4 header trong location đó; test L0 kiểm mọi location tự đặt header đều có đủ 4 header, [EG:T11] (phần b) L2 kiểm `/socket.io/` qua edge-sink, (phần d) kiểm bằng nginx thật. `Host` đổi từ `$host` sang `$http_host` (giữ cả cổng như khi gọi thẳng).
- **Dải tin cậy quá rộng + `real_ip_recursive on` = lấy IP client tự đặt (sửa, ADR-176):** `/0`, IPv4 < /8 hoặc IPv6 < /16 với recursive bật → nginx lấy phần tử **đầu** của XFF (đã đo bằng nginx thật). Chọn **từ chối khởi động** thay vì tự chuyển `off` ngầm: cấu hình sai phải hiện ra, không âm thầm đổi nghĩa. `0.0.0.0/0,::/0` chỉ hợp lệ với `EDGE_REAL_IP_RECURSIVE=off`. Cấu hình này cũng tin mọi máy trong **private network của Render** (service khác cùng tài khoản gọi thẳng `$PORT` được và tự đặt XFF) — cùng mức tin như `TRUST_PROXY=1` hôm nay; thu hẹp khi đo được dải proxy.
- **Render mà không khai proxy tin cậy → từ chối khởi động (sửa):** `EDGE_NGINX=1` + env `RENDER` + `EDGE_TRUSTED_PROXIES` trống thì `req.ip` của mọi người là IP proxy Render (rate limit đăng nhập chung một xô, `limit_conn` thành trần chung, hộp phạt EG2 phạt tất cả) — supervisor thoát 1 với hướng dẫn; cố ý vượt bằng `EDGE_ALLOW_NO_REAL_IP=1` (cảnh báo level 50). Bỏ câu "nếu để trống trên Render thì limit_conn thành trần chung" ở trên: trường hợp đó không còn chạy được nếu không cố ý.
- **`sourceKey` tự đặt (sửa):** `SOURCE_KEY_RE` + `generateSourceKey` + `apiSourceKey` thành một module (`apps/hub-api/src/modules/console/source-key.ts`), dùng ở mọi đường tạo source; `POST /api/v1/sources` trả 400 `bad_request` (field `sourceKey`) cho key sai khuôn thay vì tạo source mà nginx trả 404 lặng lẽ. [EG:T3] gọi hàm sinh key thật. Bằng chứng query (DB hubv 2026-10-12): 29 source, 0 key lệch regex nginx (DEPLOYMENT §3.6).
- **Compose: hub-api chỉ tin service `edge` (review `feat/edge`):** trước đây hub-api compose `TRUST_PROXY=0` → mọi request qua edge có `req.ip` = IP container edge (gộp với hộp phạt EG2 thì 20 lần 404 qua edge chặn tất cả). `TRUST_PROXY` nhận thêm danh sách IP/CIDR (`apps/hub-api/src/trust-proxy.ts`; `1` và trống giữ nghĩa cũ, số khác vẫn bị bỏ qua như cũ, `/0` hoặc sai khuôn → thoát). `edge` chỉ nằm trên mạng `edge_net` (10.250.250.0/29, cấp động trong /30) với IP cố định `.6`; hub-api `TRUST_PROXY=10.250.250.6` → qua edge `req.ip` = IP client nginx thấy, gọi thẳng :4000 (k6) với XFF giả không được tin. Đánh đổi: từ máy host mọi request qua edge mang IP gateway `10.250.250.1` (bản chất của port publish Docker) — hộp phạt bên `feat/edge` bỏ qua IP private/loopback.
- **Nhỏ:** `worker_shutdown_timeout` dẫn từ `EDGE_DRAIN_MS` − 1 s (không viết cứng); 502/504 của nginx → `503 service_unavailable` JSON khuôn ERRORS.md (mã có sẵn, không thêm mã); log UDP bỏ dòng khi stdout của supervisor đệm > 1 MB và in số dòng đã bỏ, lỗi socket sau bind chỉ ghi log (không sập PID 1); CI job `unit` cài nginx + đặt `EDGE_NGINX_BIN` để [EG:T9]/[EG:T11] (phần d) chạy nginx thật; `edge-sink` của hubv dùng chung image `hubv-edge`.
- **Không làm theo gợi ý:** ca `EDGE_NGINX=1` trong `scripts/hub-all-e2e.sh` — script đó thay hub-api của hubv (dùng chung) bằng hub-all và tắt hub-worker. Thay bằng [EG:T11] (phần d): supervisor + **nginx thật** + hub-api giả dùng đúng express của Nest và đúng luật `TRUST_PROXY` của `main.ts`, env lấy từ `buildSpecs` — kiểm `req.ip` ở `/hooks`, `/socket.io`, `/api` với cấu hình local và cấu hình Render.

**Bổ sung lượt 3 (review `2c3fc44` + spec EG mục Đính chính D11/D13, 2026-10-12, append):**
- **D13 — một luật `sourceKey` cho phía ghi và nginx:** `SOURCE_KEY_RE` đổi từ `^[a-z0-9_]{3,64}$` thành `^[A-Za-z0-9_-]{1,64}$`, trùng đúng phần sourceKey của regex location `/hooks/*` ([EG:T3] so hai regex). Chặt hơn nginx thì client đang gửi key có chữ hoa hoặc `-` bị gãy; lỏng hơn thì nginx trả 404 lặng lẽ. Dùng cho mọi đường tạo source, kể cả "Kết nối provider". Sai khuôn trả **422 `validation_failed`** (field `sourceKey`), giống `parseSourceInput`/`source-connection` — thay cho 400 `bad_request` ở bổ sung trước. Gợi ý định dạng trên console sửa theo.
- **D11 — `EDGE_NGINX=1` mà `EDGE_TRUSTED_PROXIES` trống thì từ chối khởi động ở mọi nơi**, không chỉ khi có env `RENDER` như bổ sung trước. Service `edge` của compose (không có proxy phía trước, không qua hub-all) không bị áp. Cố ý vượt: `EDGE_ALLOW_NO_REAL_IP=1`.
- **`TRUST_PROXY` (ADR-176):** áp cùng luật "quá rộng" với `edge.js` (IPv4 < /8, IPv6 < /16, gồm `/0`). **Đổi hành vi có chủ ý:** giá trị không phải số và không phải IP/CIDR (vd `true`, `yes`) trước đây bị bỏ qua im lặng (không tin XFF), giờ hub-api **không khởi động** — cấu hình sai phải hiện ra. `0`, trống, `1` và các số khác giữ nghĩa cũ.
- **Subnet `edge_net` tham số hoá:** `EDGE_NET_SUBNET` / `EDGE_NET_RANGE` / `EDGE_IP` (mặc định dev 10.250.250.0/29, edge .6; `TRUST_PROXY` mặc định theo `EDGE_IP`); hubv đè sang 10.250.251.0/29 → stack dev và hubv chạy song song không `Pool overlaps`. `.env.example` bỏ `TRUST_PROXY=0` (chép sang `.env` sẽ đè mặc định tin edge mà không báo gì).

**Bổ sung lượt 4 (review `9d7b9f0`, 2026-10-12, append):**
- **Path viết hoa đi vòng nginx (sửa, ADR-175):** router express không phân biệt hoa thường, nginx thì có → `/HOOKS/github/<key>` rơi vào `location /` (không cầu chì, không lọc) mà vẫn tới ingest. Chọn: location bảo vệ dùng `~*` (`^/hooks(/|$)` → 404 tĩnh, `^/v1/p/` → cầu chì) **và** lớp hai ở hub-api (`rejectNonCanonicalHooksPath`: `/hooks` không đúng chữ thường → 404 `not_found`, trước body parser). Không bật `case sensitive routing` toàn app: đổi nghĩa mọi route `/api/*` của client cũ chỉ để vá một tiền tố. Đánh đổi: `/hooks/GitHub/k` (provider hoa) giờ 404 ở nginx — provider luôn là chữ thường.
- **Dải rộng dạng IPv4-mapped (sửa, ADR-176):** `::ffff:0:0/96` = `0.0.0.0/0` với proxy-addr. `TRUST_PROXY` và `EDGE_TRUSTED_PROXIES` quy CIDR mapped về IPv4 (`p − 96`) rồi áp luật /8; dải IPv6 chứa trọn `::ffff:0:0/96` (vd `::/16`) cũng bị coi là IPv4 /0 — proxy-addr 2.0.8 và nginx hiện không cho dải đó khớp IPv4, chặn **phòng xa** (một luật cho hai bên, không phụ thuộc phiên bản). Đánh đổi: không ai dùng được `::/16`…`::/96` làm dải tin cậy (không có lý do thực tế). `EDGE_TRUSTED_PROXIES`/`TRUST_PROXY` chỉ gồm dấu phân cách (`" , "`) = trống (D11 vẫn chặn). `AuthConfig.trustProxy` bỏ (không ai đọc; nguồn duy nhất là `main.ts`).

**Bổ sung lượt 5 — gộp EG1 với D3 (sau rebase lên `feat/edge`, review EG1 lượt 4 Thấp-A/B + review EG lượt 6 S1/S2/S4, 2026-10-12, append):**
- **Vấn đề:** `rejectNonCanonicalHooksPath` tách path bằng `originalUrl.split('?')` → absolute-form `http://h/hooks/...` bị 404 oan; mount `/hooks` đặt sau gate hộp phạt (D3) mà gate so tiền tố KHÔNG phân biệt hoa thường → `/HOOKS/github/<key>` nhận 429 khi IP bị ban nhưng 404 khi IP sạch (lộ trạng thái phạt, hai lớp kết luận khác nhau); `fix` của 404 nói về "project slug" trong khi nginx nói về URL webhook.
- **Chọn:** guard dùng chung `hooksPathOf`/`pathnameOfUrl` (`modules/ingest/hooks-path.ts`, parseurl như router + gate), gắn ở GỐC qua `installHooksPathGuard(app)` và đặt **TRƯỚC** `installPenaltyGate` trong `main.ts` (vẫn sau CORS). Lý do chọn "reject trước gate" thay vì cho gate phân biệt hoa thường: path sai hoa thường là path nginx đã 404 tĩnh — hub-api phải ra cùng kết luận cho MỌI IP, và gate giữ nguyên ngữ nghĩa "khớp như router" của ADR-177 lần 7 (không thêm luật riêng). `fix` = `HOOKS_NOT_FOUND_FIX`, cùng câu với body 404 tĩnh của nginx (test so khớp).
- **Đánh đổi:** guard parse path cho mọi request (không chỉ `/hooks`) — tra cache `_parsedUrl` chung với gate/router nên gần như 0. Test L0 `[EG:T19]` (IP ban/sạch cùng 404, absolute-form chữ thường không 404 oan, khoá thứ tự main.ts), `[EG:T10]` (phần g), `[EG:T1]` qua proxy tin cậy (A bị chặn không kéo B, mức `req.ip`). L2 qua container `edge` thật: **chưa chạy** (không Docker).

## ADR-188 — Toast/banner "cảnh báo mới" theo đồng hồ SERVER, không theo đồng hồ trình duyệt (2026-10-12)

- **Vấn đề:** `takeArrivals` so `opened_at` (đồng hồ hub-worker) với mốc `Date.now()` của trình duyệt — máy người dùng lệch giờ vài phút là nuốt toast cảnh báo mới (đồng hồ nhanh) hoặc bật lại cảnh báo cũ (đồng hồ chậm); review REVIEW-TOAST-6ac202a mục HIGH.
- **Chọn:** `GET /api/v1/alerts` trả `asOf` = `now()` của DB (`PrismaService.dbNow`, đọc TRƯỚC danh sách). Client: lần tải đầu ĐẦY ĐỦ (`next === null`) không dùng mốc thời gian nào — id lạ về sau là mới (bắt luôn ca lượt evaluator bắt đầu trước khi trang tải nhưng commit sau); lần đầu bị cắt -> mốc = `asOf` (server cũ thiếu `asOf` -> max(openedAt) đã thấy). Mốc giữ cố định — các lần sau dựa vào tập id đã thấy. Không còn `Date.now()` trong quyết định toast/banner; badge chuông vốn đếm ở server. Chính sách §8.3 không đổi. Test `notify-logic.spec` với `Date.now` lệch ±10 phút.
- **Đánh đổi:** thêm một câu `SELECT now()` mỗi lần đọc danh sách (poll 30s); khi lần đầu bị cắt vẫn so `opened_at` (đồng hồ worker) với `asOf` (đồng hồ DB) — hai đồng hồ server (local chung kernel VM Docker, deployed NTP), không còn đồng hồ người dùng. Giờ tương đối ("2 phút trước") chưa bù lệch. **Ca đã biết (review R3 L1):** lần đầu BỊ CẮT (> 100 OPEN lúc tải) mà một lượt evaluator bắt đầu trước `asOf` nhưng COMMIT sau đó, và dòng của nó không lọt vào trang đầu -> `opened_at` (= `now` đầu lượt) < `asOf` nên bị coi là cũ, không toast (project khác không có `alert.changed`). Cửa sổ = thời lượng một lượt evaluator. Không sửa bằng `asOf − một chu kỳ`: đổi lại sẽ bật toast cho cảnh báo cũ nằm ngoài trang trong khoảng đó (L3 vòng 1), cần thêm cơ chế chống — không đáng cho ca hiếm này; badge chuông (đếm ở server) vẫn đúng.
---

## ADR-186 — Mức quan trọng là hàm thuần trên tín hiệu chung của hub, không đọc payload; policy dọn tự động mặc định seed cho mọi project (QT1, 2026-10-12)

**Vấn đề:** gợi ý dọn và dọn tự động (SPEC-han-muc-dung-luong §5.3–5.4) cần biết event nào "ít quan trọng", nhưng hub không được hiểu nghiệp vụ (BB-1) và không được `if (provider === …)`.
**Chọn:** `importanceOf(event, deliveries, sourceSettings)` thuần trong `libs/common/src/storage/importance.ts`: `keep_longer` → Giữ (thắng mọi tín hiệu); mẫu REJECTED → Rác; có delivery `DEAD` hoặc replay trong 24h → Cao; còn delivery đang chạy → Cao (đằng nào cũng không bao giờ dọn — xếp Cao để không ai gợi ý); không có delivery push → Trung bình; mọi delivery `SUCCEEDED` → Thấp. Bảng `hub.storage_policies` (tenant_id + RLS, chỉ junk/low/medium, CHECK ràng buộc giá trị). Mặc định Q10 (`DEFAULT_STORAGE_POLICIES`): Rác xoá hẳn sau 1 ngày, Thấp dọn sau 3 ngày, Trung bình tắt — migration seed cho project có sẵn kèm audit `system:migration`, project mới seed trong cùng transaction tạo project (console + đăng ký + seed).
**Đánh đổi:** hub không biết event nào quan trọng về nghiệp vụ — user phải tự gắn "Giữ lâu"; event đang giao dở bị xếp Cao (khác bảng §5.3 một chút, an toàn hơn); dọn tự động chỉ thật sự chạy khi `STORAGE_AUTO_CLEAN_ENABLED=1` (ADR-189).

---

## ADR-183 — Đo dung lượng project bằng cộng dồn `bytes` qua bộ gộp EG4 + hiệu chỉnh quét thật mỗi 24h (QT2, 2026-10-12)

**Vấn đề:** cần biết dung lượng từng project để cảnh báo/khoá (ADR-182) mà không quét cả DB mỗi 10 phút (Neon free: đọc lại cả DB 144 lần/ngày) và không thêm truy vấn/lệnh Redis vào đường nóng ingest (R1, ADR-062).
**Chọn:** `traced()` đưa số byte THỰC SỰ ghi (`rawBody.length` khi ACCEPTED, độ dài mẫu ≤4KB khi REJECTED có lưu, còn lại 0) vào `TrafficRecorder.record` — ô trong Map cộng thêm `bytes`, flush 60s cộng `bytes = bytes + excluded.bytes` trong CÙNG câu upsert (cột mới `source_traffic_minutely.bytes`). Publish `/v1/p` đi qua `traced()` nên tự cộng. `hub-worker` có `StorageJob` (ADR-020) hai nhịp, mỗi nhịp một khoá Redis `SET NX EX ~0,9 chu kỳ` không nhả (như cleanup): (1) cập nhật nấc 60s — MỘT truy vấn gộp xuyên project qua escape hatch có tên `storageLevelTickAcrossTenants` (systemTx; gate `storage-cross-tenant`) tính `used = calibrated_bytes + bloat_factor × Σ bytes sau phút mốc − freed_since_calibration`, `levelFor` với vùng đệm, chỉ project có số đổi bị ghi lại qua `forTenant`; (2) hiệu chỉnh — kiểm mỗi giờ, quét thật project có mốc cũ hơn `min(24h, TRAFFIC_RETENTION_DAYS − 1 ngày)` (cũ nhất trước, 50/lượt), mỗi project một truy vấn gộp theo source qua `forTenant`, đặt lại mốc, `bloat_factor` = tổng/body_raw kẹp [1, 4] (mặc định 2 khi body_raw < 64KB), log chênh lệch cộng dồn ↔ quét thật. Đổi nấc hôm nay: log + metric `hub_project_storage_level_transitions_total` + hook `onLevelChange` (QT6 cắm email/webhook/cảnh báo owner).
**Đánh đổi:**
- Số liệu là ƯỚC TÍNH: trôi tới 24h giữa hai lần hiệu chỉnh, phụ thuộc `bloat_factor` (`events.data`, `deliveries`, `delivery_attempts` sinh sau ở worker); phút chứa mốc coi như thuộc lần quét (sai số ≤ 1 phút traffic). Upsert cộng dồn có thể cộng trùng khi một lượt flush timeout nhưng đã COMMIT (bổ sung ADR-179) — lần hiệu chỉnh kế sửa.
- Độ trễ của nấc ≈ 2 phút (flush 60s + job 60s); flush lỗi thì bộ đệm EG4 giữ tối đa 10 phút.
- Job tốn 1 lệnh Redis (`SET NX`) mỗi nhịp mỗi instance (~1440/ngày/worker cho nhịp 60s) — ngoài ngân sách theo sự kiện của R1, nhưng ăn vào quota Upstash. Chấp nhận để giữ đúng "N worker = một lượt".
- `by_bucket` (byte theo mức quan trọng × tuổi) và `RuleAdvisor` chưa chạy trong lượt hiệu chỉnh — thuộc QT4/QT4b.

## ADR-185 — Cấp vượt hạn mức + chốt toàn cục 80% `DB_DISK_BUDGET_MB` cho người vận hành (QT2, 2026-10-12)

**Vấn đề:** hạn mức theo project (mặc định 50MB) được CẤP VƯỢT — 10 project × 50MB đã bằng cả ổ Neon free 0,5GB — nên hạn mức từng project không bảo vệ được ổ chung.
**Chọn:** lượt cập nhật nấc đọc thêm `pg_database_size(current_database())` tối đa 10 phút một lần (đếm trong bộ nhớ, không Redis); ≥ 80% `DB_DISK_BUDGET_MB` (mặc định 512) -> metric `hub_storage_near_full = 1` + log error `hub.storage_near_full`; `hub_db_size_bytes` luôn có. Mở cảnh báo operator qua luồng CB (bảng `alerts` cần tenant) để QT6.
**Đánh đổi:** tổng hạn mức có thể vượt ổ thật; `pg_database_size` tính cả index/TOAST/bloat của mọi schema (khác định nghĩa "dung lượng project"), nên hai con số không cộng khớp nhau — chốt toàn cục chỉ là lưới an toàn.

## ADR-182 — Hạn mức dung lượng theo project: cảnh báo nhiều nấc rồi khoá CHIỀU GHI (507), vùng đệm 100/90 (QT3, 2026-10-12)

**Vấn đề:** Neon free 0,5GB dùng chung cho mọi project; một source (100 req/phút × 1MB, giữ 7 ngày) đủ làm đầy ổ và khi đó INSERT của MỌI project lỗi (noisy neighbor). Chưa có gói trả phí, chưa có trần nào theo project.
**Chọn:** hạn mức `projects.storage_quota_mb` (NULL = `PROJECT_STORAGE_QUOTA_MB`, mặc định 50), nấc `OK / WARN_70 / WARN_85 / CRITICAL_95 / LOCKED (≥100%) / HARD_LOCKED (≥110%)` tính bằng `levelFor` thuần (vùng đệm: cảnh báo hạ khi thấp hơn ngưỡng 5 điểm, `LOCKED` mở khi < 90%, `HARD_LOCKED` về `LOCKED` khi < 100%). Khoá CHỈ chiều ghi mới: `/hooks` và `/v1/p/:project/events` trả **507 `project_storage_full`** (khuôn ERRORS.md; exception filter giữ 507 vì mã có trong catalog với đúng status). Nấc đọc bằng LEFT JOIN `project_usage` trong CHÍNH câu nạp source (ingest: batch `set_config + sources⋈project_usage + secrets` — vẫn 2 câu SQL như `findUnique+include`; publish: một câu, ít hơn trước) → +0 lượt DB, +0 lệnh Redis. Bước 2q đặt SAU nạp source, TRƯỚC hộp phạt theo cặp / verify / rate limit (E4). Giao event đã lưu, retry, polling, console, dọn dẹp, tạo source/đích vẫn chạy. Đọc nấc lỗi → fail-open + log. 507 ghi vào bảng lưu lượng outcome `STORAGE_FULL` (bytes 0).
**Đánh đổi:**
- Provider gửi lại rồi bỏ: owner bỏ mặc cảnh báo thì mất event — đó chính là hợp đồng "cảnh báo trước, khoá sau".
- Project đã khoá vẫn bị Node đọc body (tới 1MB) trước khi trả 507 (gate trước body parser không chạm DB nên không biết trạng thái khoá).
- 507 trả trước verify: ai biết `sourceKey` thì biết project đang đầy — chấp nhận vì `sourceKey` vốn là bí mật chia với provider; đổi lại request vào project khoá không tốn HMAC, không tốn `EVAL`.
- Nấc trễ ≈ 2 phút so với thực tế (ADR-183).

## ADR-189 — "Giữ lâu" nhận tới 110% (HARD_LOCKED); cờ STORAGE_LOCK_ENABLED / STORAGE_AUTO_CLEAN_ENABLED mặc định 0 ở production (QT3, 2026-10-12)

**Vấn đề:** (a) ở 100% mọi source bị 507 như nhau — source user đã đánh dấu quan trọng (thường là thanh toán) chết cùng lúc với source rác; hub không được đoán nghiệp vụ (BB-1). (b) Deploy tự động có thể chạy ban đêm, trước khi Admin kiểm số đo cộng dồn (ADR-183) trên dữ liệu thật — không được tự khoá project thật hay tự xoá dữ liệu thật.
**Chọn:** (a) `isWriteBlocked(level, keepLonger, lockEnabled) = lockEnabled && (level === 'HARD_LOCKED' || (level === 'LOCKED' && !keepLonger))`, dùng chung `/hooks` và publish; `HARD_LIMIT_PCT = 110` là HẰNG SỐ trong `levelFor`, không phải env; hub chỉ đọc cờ `sources.keep_longer` user TỰ gắn. (b) `STORAGE_LOCK_ENABLED` đọc một lần lúc khởi động hub-api, mặc định 0 trong code/production (compose local + hubv = 1): tắt thì vẫn đo, vẫn đổi nấc, KHÔNG trả 507, đếm `hub_ingest_storage_would_reject_total{path}`; bật thì đếm `hub_ingest_storage_rejected_total{path}`. `STORAGE_AUTO_CLEAN_ENABLED` (QT5) cùng nguyên tắc. Tắt lại = rollback tức thì (đổi env + restart).
**Đánh đổi:** thêm một nấc, hub dôi 10% ổ cho source user tự gắn cờ (gắn càng nhiều càng nhanh chạm 110%); production chưa thật sự khoá cho tới khi Admin bật tay theo checklist DEPLOYMENT (QT8). Phần (c) — owner thấy cảnh báo dung lượng qua `audience` — ghi bổ sung khi làm QT6.

**Bổ sung ADR-182 (QT9, 2026-10-12, append) — trần số source mỗi project:** hạn mức dung lượng chặn ổ nhưng không chặn TỐC ĐỘ (N source × 100 req/phút đè lên worker + RabbitMQ chung). Chọn `SOURCE_LIMIT_PER_PROJECT` (mặc định 20) source CHƯA lưu trữ, kiểm trong CÙNG transaction tạo source sau `pg_advisory_xact_lock('source-create:<tenant>')` (khuôn R-14/ADR-118) → 409 `source_limit {limit}`; áp cho mọi đường tạo source (console, `/v1/p/:project/sources`, "Kết nối provider", key có `publish:events` kèm source `api`); operator đăng nhập console miễn, API key không bao giờ miễn. Đánh đổi: key `publish:events` thứ 21 cũng bị 409 (source `api` tính vào trần); trần là env chung, chưa ghi đè theo project.

## ADR-184 — Dọn hai kiểu: "Dọn" giữ dòng gầy (BB-2 còn) và "Xoá hẳn" (mất chống trùng); lệnh dọn chạy theo lô trong worker (QT4, 2026-10-13)

**Vấn đề:** hạn mức (ADR-182) cần lối thoát — không dọn được thì khoá là bẫy. Dữ liệu nặng nằm ở `raw_events.body_raw`, `events.data`, `delivery_attempts`; nhưng dòng `events`/`raw_events` lại là trọng tài chống trùng của Postgres (BB-2). Neon free có `connection_limit=1`: một DELETE lớn giữ connection là chặn cả ingest.
**Chọn:**
- Hai hành động, user chọn: **Dọn** (`trim`) — `body_raw` rỗng, `data` = null, cắt body/lỗi dài của `delivery_attempts`/`deliveries`, đặt `trimmed_at`; dòng gầy giữ khoá chống trùng, kiểu, thời gian, trạng thái giao. **Xoá hẳn** (`delete`) — xoá `events` + `raw_events` (deliveries/attempts theo CASCADE), mất chống trùng; mẫu REJECTED (rác) chỉ xoá hẳn.
- `POST /api/v1/projects/:p/storage/clean` (scope mới `storage:write` — owner + người vận hành) chỉ ghi LỆNH vào `hub.storage_clean_jobs` (RLS) + `audit_logs` cùng transaction, trả **202 + id**. `hub-worker` (`StorageCleanRunner`, ADR-020) nhận lệnh bằng escape hatch có tên `storageClaimCleanJobAcrossTenants` (`FOR UPDATE SKIP LOCKED` + lease 2 phút, tối đa 5 lần) — 0 lệnh Redis — và chạy theo lô 1000 dòng, mỗi lô một `tenantTx` có hạn 30s + `statement_timeout` 25s.
- Bất biến nằm TRONG SQL của `cleanStorageBatch`, không phụ thuộc người gọi: không đụng event còn delivery PENDING/DELIVERING/RETRYING, không đụng dữ liệu nhận sau `now − TOTAL_RETRY_WINDOW_MS` (hằng số chuyển sang `@hub/messaging` `retry-window.ts`, dùng chung với `assertRetentionSafe`; API trả 400 khi `olderThan` mới hơn sàn), không đụng source "Giữ lâu", không có câu nào chạm `audit_logs`. Mức quan trọng bằng MỘT biểu thức SQL (`eventImportanceSql`) cùng bảng với `importanceOf`, dùng chung cho lệnh dọn và `by_bucket`.
- Mỗi lô đo byte TRƯỚC/SAU theo đúng công thức §2 (không ước bằng `bloat_factor` như spec E2 cho phép — đo thật rẻ vì chỉ trên ≤1000 dòng vừa khoá), cộng vào `freed_since_calibration`, trừ `used_bytes` và tính lại nấc NGAY trong cùng transaction (mở khoá không chờ lượt 60s). Lượt nấc 60s ghi bằng compare-and-set thêm `freed_since_calibration` (không ghi đè số cũ lên nấc vừa hạ); hiệu chỉnh đọc mốc `freed` ngay trước khi quét để lô dọn COMMIT trong lúc quét không bị xoá mất.
- `by_bucket` (byte + số event chưa dọn theo source × mức × tuổi-ngày) tính trong lượt hiệu chỉnh 24h. `GET …/storage` (scope `storage:read` — owner, developer, người vận hành) trả số ước tính, nấc, theo source/mức, `growthPerDay`, `forecastHours`, gợi ý, lệnh gần đây và cờ `lockEnabled`/`autoCleanEnabled` để console nói thật (E5).
- Event đã dọn: polling `/v1/p` trả `trimmed: true, data: null`; replay delivery → **409 `event_trimmed`**; replay hàng loạt bỏ qua với lý do `event_trimmed`.
**Đánh đổi:**
- Event đã dọn không replay được, không xem lại được body; "Xoá hẳn" để provider gửi lại khoá cũ thì hub nhận lần nữa (test QT:T16 ghi nhận, không phải lỗi).
- Lệnh dọn chạy bất đồng bộ (thăm dò 5s, `STORAGE_CLEAN_POLL_MS`): bấm xong phải xem tiến độ ở `GET …/storage/clean/:jobId`. Thêm một bảng và một vòng thăm dò DB nhẹ (outbox relay đã thăm dò 500ms nên Neon không ngủ thêm vì vòng này).
- Đo byte trước/sau tốn thêm hai câu gộp mỗi lô — đổi lại `used_bytes` sau dọn là số thật, không phải ước.

## ADR-187 — Gợi ý dọn là interface `CleanupAdvisor` (`rules@1`), hàng rào an toàn NGOÀI advisor; webhook `hub.project.cleanup_suggested` qua outbox bình thường + API `apply` tính lại khi gọi (QT4b, 2026-10-13)

**Vấn đề:** user cần được hub gợi ý dọn gì (kèm số MB) và tự động hoá được (nhận webhook → quyết định → gọi lại); sau này Admin muốn thay luật bằng LLM mà không đụng lõi. Một gợi ý sai (dọn event giao lỗi chưa xử lý, dọn dữ liệu còn retry, đụng `audit_logs`) là mất dữ liệu thật.
**Chọn:**
- `CleanupAdvisor { id; suggest(StorageSnapshot) }` (libs/common/src/storage/cleanup-advisor.ts) — snapshot CHỈ là số gộp (`by_bucket`, policy, id source "Giữ lâu"), không payload. Hôm nay `RuleAdvisor` (`rules@1`, bảng §5.3: Rác xoá hẳn ≥1 ngày, Thấp dọn ≥3 ngày, Trung bình dọn ≥5 ngày; Cao/Giữ không có luật). Chạy trong lượt hiệu chỉnh 24h, lưu `project_usage.suggestions`.
- `assertSuggestionSafe`/`guardSuggestions` NGOÀI advisor, áp trước khi lưu, phát hay áp dụng: dựng LẠI gợi ý từ danh sách trắng trường (không thể nêu bảng nào khác), chỉ `trim`/`delete` × Rác/Thấp/Trung bình, Rác chỉ xoá hẳn, `olderThan` không mới hơn sàn retry, không nhắm source "Giữ lâu", id tính lại (hash xác định), `estimatedBytes`/`estimatedEvents` tính lại từ `by_bucket`. Vi phạm → loại + log + `hub_cleanup_suggestions_rejected_total{advisor}`. Advisor lỗi/quá 5s → fail-open về `rules@1` (`hub_cleanup_advisor_fail_open_total`).
- `hub.*` thành không gian dành riêng của catalog (`hub.project.cleanup_suggested` + validator + U50): event của hub ghi `events` (source `hub`, `sourceId` null) rồi đi `routeEventToSubscriptions` — hàm định tuyến tách ra từ `NormalizeConsumer`, DÙNG CHUNG cho mọi event (delivery PENDING + outbox `delivery.requested` cùng transaction, đích chưa VERIFIED không nhận). Phát khi nấc đi lên (kể cả LOCKED) hoặc tổng gợi ý đổi ≥10% quota và lần trước cũ hơn 24h; `suggested_at/bytes` đánh dấu CÙNG transaction với event.
- `POST …/storage/suggestions/:id/apply` (console + `/v1/p` với key `storage:write`, scope mới cấp được cho key — chỉ owner cấp vì role phải có scope): tính lại bằng `rules@1` + hàng rào tại thời điểm gọi; id không còn trong bộ mới hoặc bản đã gửi hết hạn → 409 `suggestion_stale` kèm bộ mới (lưu thay bộ cũ); idempotent theo id trong 24h (khoá advisory `(project, id)` trong transaction); tạo lệnh dọn như ADR-184, audit ghi `suggestionId` + `advisor`.
**Đánh đổi:**
- Thêm một lớp trừu tượng khi mới có một bản cài; `CLEANUP_ADVISOR` chưa có (chỉ `rules`) — LLM là việc sau, cắm vào `StorageJob.advisor`.
- Gợi ý và số MB có thể cũ tới 24h (theo `by_bucket` của lần hiệu chỉnh); `apply` tính lại trên CÙNG số cũ đó, nên "tính lại" bảo đảm an toàn và nhất quán, không bảo đảm số mới nhất.
- Gợi ý nằm ở mức project (không tách theo source) để id ổn định; user muốn dọn một source thì dùng lệnh dọn tay có `sourceId`.
- Dành riêng `hub.*`: service nào lỡ dùng tiền tố `hub.` cho kiểu riêng sẽ bị 422 (hôm nay không có).

**Bổ sung ADR-186 (QT5, 2026-10-13, append) — dọn tự động chạy thật + retention có kế toán byte:** `GET/PUT /api/v1/projects/:p/storage/policies` (scope `storage:read`/`storage:write`; Cao/Giữ không đặt được, Rác chỉ Xoá hẳn/tắt, `afterDays` 1–365, `trigger` `always`|`above_85`; audit `storage.policies.update` trước/sau cùng transaction); GET luôn trả `autoCleanEnabled` + câu "Đã cài, chưa chạy" khi cờ tắt (E5). Dọn tự động nằm TRONG lượt cleanup job (cùng khoá Redis, ADR-020/093): đọc policy xuyên project qua escape hatch có tên `storageAutoCleanTargetsAcrossTenants`, mỗi (project, policy) tối đa 20 lô/lượt bằng CÙNG `runCleanBatch` của lệnh dọn tay (cùng bất biến ADR-184), audit `storage.auto_clean` actor `system:auto-clean` kèm số dòng + MB — chỉ khi có dọn được gì (audit_logs không dọn được, không cho nó phình mỗi giờ). `STORAGE_AUTO_CLEAN_ENABLED=0` (mặc định) → job không đọc policy, không dọn. Retention 7 ngày (events + mẫu REJECTED) nay trừ byte giải phóng vào `project_usage` của từng tenant trong CÙNG câu xoá rồi tính lại nấc ngay. Cờ "Giữ lâu" sửa qua `PATCH /api/v1/sources/:id {keepLonger}` cần THÊM `storage:write` (developer có `manage:sources` không tự cho source của mình 110%). Đánh đổi: dọn tự động chậm nhất một chu kỳ cleanup (mặc định 1h); project lớn cần nhiều lượt; `traffic-retention.ts` tách khỏi `cleanup.job.ts` để cleanup job tiêm `StorageJob` mà không vòng import.

**Bổ sung ADR-184 (review QT-S2, 2026-10-13, append) — raw ACCEPTED mồ côi dọn được:** **Vấn đề:** retention 7 ngày xoá `events` nhưng giữ raw ACCEPTED (ADR-045, FK SET NULL); `measureStorage` đếm byte của chúng nhưng lệnh dọn / `apply` / dọn tự động không với tới và `by_bucket` không đếm → project LOCKED dọn hết mọi mức vẫn không xuống < 90% (khoá thành bẫy, §13). **Chọn:** raw ACCEPTED không event nào trỏ tới vào `by_bucket` và `cleanStorageBatch` với CÙNG một biểu thức `orphanRawImportanceSql`: source Giữ lâu = `keep`; **ứng viên renormalize** (chưa có `processed_messages(normalize)` và còn trong hạn `EVENT_RETENTION_DAYS` — đúng điều kiện `findOrphanRawEvents`, tức chính mục đích giữ raw của ADR-045/S1-3) = `high` (chỉ dọn khi xác nhận Cao, như DEAD chưa replay); còn lại (event đã hết hạn lưu, hoặc adapter cố ý ra 0 event) = `low` — vòng đời event đã xong. Cùng sàn retry, cùng `SKIP LOCKED`; "Dọn" = `body_raw` rỗng + `trimmed_at`, GIỮ dòng (khoá chống trùng còn, BB-2); "Xoá hẳn" = xoá dòng. Số dòng cộng vào `events` của lô/lệnh (một ô `by_bucket` của raw mồ côi cũng đếm là một "event"). Bất biến mới: Σ `by_bucket` = `measureStorage` (test DB). Không đổi retention (cách "retention trim luôn raw" bị loại vì đổi hành vi ADR-045 cho MỌI project, kể cả project còn xa hạn mức). **Đánh đổi:** raw mồ côi cũ hơn hạn lưu giờ nằm trong gợi ý/policy mức Thấp — bật dọn tự động mức Thấp là mất bằng chứng gốc của event đã hết hạn (vốn chỉ còn giá trị điều tra); câu gợi ý `delivered_old` nói rõ "hoặc chỉ còn bản gốc". Câu `NOT EXISTS events` theo raw đi bằng unique index `raw_event_id`.
Cũng trong review này: **L1** ghi tiến độ lệnh dọn chỉ khi `status='RUNNING' AND attempts = <lượt nhận>` (claim trả `attempts` làm fencing token); 0 dòng → runner ném `CleanJobLostError`, lô rollback, dừng (`LOST`) — worker treo quá lease không ghi đè DONE/không audit hai lần. **L5** audit `storage.auto_clean` ghi TRONG transaction của lô cuối (xong hoặc chạm trần 20 lô) với số cộng dồn; chỉ còn đường lỗi giữa chừng (lô trước đã COMMIT, lô sau rollback) ghi ngoài tx. **L7** `CLEAN_TX_TIMEOUT_MS` 30s → 20s, `statement_timeout` cục bộ 25s → 18s: lô đang chạy lúc tắt máy kết thúc trong `SHUTDOWN_TIMEOUT_MS` 25s. Đánh đổi: lô 1000 dòng trên Neon chậm hơn 18s thì rollback — lệnh vẫn RUNNING, lượt sau chạy tiếp.

**Bổ sung ADR-187 (review QT-S2, 2026-10-13, append) — `hub.*` không giả mạo được + `apply` idempotent trước khi tính lại:** **M1** — catalog chỉ kiểm khuôn, nên service có `publish:events` (cả `hub trigger`) publish `hub.project.cleanup_suggested` đúng khuôn vẫn tới mọi subscriber. **Chọn:** luật theo NAMESPACE (`isHubOnlyType`, `libs/common/canonical`): publish `/v1/p/:project/events` trả 422 `reserved_type {type, field:'type'}` trước khi ghi (mã mới trong catalog lỗi + ERRORS.md); `assertCanonical` của normalize coi `hub.*` từ adapter (kể cả Generic) là lỗi sai khuôn vĩnh viễn. Chỉ `emitHubEvent` (đi thẳng `routeEventToSubscriptions`, không qua publish/normalize) tạo được kiểu này. Không `if (provider)`. **M2** — `apply` tìm lệnh đã tạo cho CÙNG id trong 24h (khoá advisory `(project, id)`) TRƯỚC khi tính lại gợi ý: hệ thống của user retry sau lượt hiệu chỉnh 24h đổi `by_bucket` vẫn nhận cùng lệnh, không 409 `suggestion_stale`; kiểm lại lần hai trong transaction tạo lệnh cho hai lần gọi song song. **L3** — lời "Sửa" của `event_trimmed` nói đúng: "Dọn" giữ khoá chống trùng nên gửi lại cùng khoá bị chặn trùng; chỉ vào lại được dưới khoá MỚI. Đánh đổi: thêm một transaction ngắn (một SELECT có khoá advisory) mỗi lần `apply`. Nợ còn lại (L6): `apply` vẫn cố định `RuleAdvisor` — cắm `llm@1` phải lấy advisor theo tiền tố/advisor của id gợi ý.

## ADR-190 — Cảnh báo dung lượng theo sự kiện đổi nấc: `audience` trên luật, báo trong MỘT transaction khoá `project_usage`, email theo nấc/ngày qua outbox CB (QT6, 2026-10-13)

> ADR-188 dành cho fix toast theo đồng hồ server (master) — không dùng ở nhánh này.

**Vấn đề:** CB chỉ có luật do `AlertEvaluator` đánh giá mỗi 60s và chỉ operator thấy. QT cần: owner thấy cảnh báo dung lượng của project mình (E3); alert mở/đóng ĐÚNG lúc nấc đổi (kể cả nấc hạ ngay sau lô dọn — không chờ 60s); đúng MỘT webhook `hub.project.storage` mỗi lần đổi nấc dù hai đường cùng báo (lượt nấc 60s và lô dọn) hay worker chết giữa đường; email mỗi nấc đi lên một lần + nhắc mỗi ngày ở 95%/LOCKED, trong khi `alert_emails` unique `(alert, user, kind)` chỉ cho MỘT thư OPEN mỗi cảnh báo; chốt ổ `hub.storage_near_full` là cảnh báo VẬN HÀNH trong bảng `alerts` bắt buộc `tenant_id`.
**Chọn:**
- `rules.ts`: thêm `audience: 'operator' | 'owners+operator'` (mặc định operator) và `driver: 'evaluator' | 'event'`. `project.storage_warn` (WARN_70/85, warning), `project.storage_critical` (95), `project.storage_locked` (LOCKED + HARD_LOCKED) là `owners+operator` + `event`; `hub.storage_near_full` là operator + `event`. Evaluator chỉ lặp `EVALUATED_RULE_CODES` nên không đánh giá và KHÔNG đóng nhầm luật sự kiện. Không thêm cột vào `alerts`: lọc owner bằng `rule = ANY(ownerVisibleRules())`.
- `StorageAlerts` (hub-worker, cắm vào `StorageJob.onLevelChange` / `onTick` / `onDiskCheck` — không job mới): một lần báo = một `tenantTx` khoá `project_usage FOR UPDATE`, so `level` với cột mới `signaled_level`. Lệch -> đóng alert nấc cũ, mở alert nấc mới (facts: mức dùng ước tính, %, dự báo, gợi ý lớn nhất, `lockEnabled`, `autoCleanEnabled`), `emitHubEvent(hub.project.storage)` (outbox như mọi event, vẫn phát khi LOCKED), ghi `signaled_level`. Đường báo thứ hai xếp hàng ở khoá, thấy đã khớp -> không làm gì. Lượt nấc 60s so `signaled_level`/`notified_at` trong bộ nhớ (cùng câu gộp, +0 truy vấn) để báo bù và nhắc hằng ngày. Realtime publish SAU COMMIT qua kết nối Redis lười của evaluator (`announce`, không mở kết nối mới).
- Email: `alert_emails.tag` (`up:<nấc>:<ngày>`, `remind:<nấc>:<ngày>`; email CB = `''`), unique thành `(alert, user, kind, tag)`. Người nhận = mọi owner đã xác minh email (bỏ qua `alert_preferences`; `project_members.storage_warn_email` chỉ tắt được 70/85) + operator theo tuỳ chọn của họ. Vòng gửi CB kiểm lại lúc gửi (owner + luật owners -> chỉ cần email xác minh), trần 6/giờ/người dùng chung. Thư owner có link trang Dung lượng, ở 70% có link "Bật dọn tự động", nói thật khi `STORAGE_LOCK_ENABLED=0`.
- API: `GET /alerts`, `/alerts/summary` mở cho owner qua escape hatch có tên `ownerAlertsAcrossTenants` / `ownerAlertSummaryAcrossTenants` (JOIN `project_members role='owner'` của chính user, gate `owner-alerts`); developer/viewer vẫn 403; ack/ack-all/preferences/test-email giữ `OperatorGuard`. Realtime: notice mang `audience` (tính lại từ `rules.ts`, không tin tin nhắn) -> gateway emit thêm room `project:<id>:owners` (vai trò kiểm lúc join; R-3 rời room khi mất vai trò owner).
- `hub.storage_near_full` neo vào project LÂU ĐỜI NHẤT (`listProjectIds()[0]`), facts kèm 3 project dùng nhiều nhất (số đã có trong bộ nhớ của lượt nấc).
**Đánh đổi:**
- Thêm một cột trạng thái (`signaled_level`) và một transaction mỗi lần đổi nấc (hiếm). Migration đặt `signaled_level = level` cho project cũ — không bắn webhook/email hàng loạt lúc deploy, đổi lại project đang ở nấc cao lúc deploy không nhận thư "đi lên" (vẫn nhận thư nhắc 24h ở 95%/LOCKED).
- Hai nấc chung một luật (70/85, LOCKED/HARD_LOCKED): đi 70 -> 85 không mở alert mới (facts đổi, có thư mới theo tag); banner/toast mới chỉ xuất hiện khi luật đổi.
- Lên lại cùng nấc trong CÙNG ngày không có thư thứ hai (tag theo ngày) — chống bão thư khi trạng thái dao động quanh vùng đệm.
- `hub.storage_near_full` gắn chip project gốc trong chuông dù không thuộc project nào; xoá project gốc thì alert đi theo CASCADE và lượt chốt sau mở lại ở project kế.
- Owner nhận email theo trần chung 6/giờ/người với mọi cảnh báo khác của họ.

## ADR-191 — Console dung lượng: banner theo nấc của dự án đang chọn, operator ghi đè hạn mức qua route riêng, event đã Dọn không hứa Replay (QT7, 2026-10-13)

**Vấn đề:** spec §9 cần banner theo nấc (70 vàng, 85 toast, 95 đỏ, LOCKED hai nút), cột mức sử dụng + ô ghi đè hạn mức cho
operator, và giao diện không được hứa điều server từ chối (Replay event đã dọn -> 409, "Nâng cấp" khi chưa có gói trả phí).
Banner cảnh báo CB chỉ hiện critical MỚI đến trong phiên và chỉ cho người thấy cảnh báo — developer của project đang LOCKED
không thấy gì.
**Chọn:**
- `StorageBanner` riêng ở layout, đọc `GET …/storage` của dự án đang chọn (mọi thành viên có `storage:read`); quyết định là hàm
  thuần `storageBannerFor(level, lockEnabled)` — cờ khoá tắt thì câu chính là "Khoá chưa bật…, sự kiện vẫn được nhận". 70/85
  ẩn được trong phiên (sessionStorage), 85 toast một lần mỗi phiên, 95/LOCKED không tắt. Không có nút "Nâng cấp"; "Liên hệ
  người vận hành" chỉ là câu giải thích.
- Operator: `GET /api/v1/projects` thêm `usage` (escape hatch có tên `operatorProjectUsage`, chỉ số gộp); `PUT
  /api/v1/projects/:id/storage-quota` (OperatorGuard, 1–102400 | null, audit `project.storage_quota_changed` cùng transaction).
  Nấc tính lại ở lượt 60s kế tiếp.
- Hành trình event: server bỏ hành động `replay_delivery` khi `events.trimmed_at` có (`withoutReplayWhenTrimmed`) và trả
  `trimmedAt`; trang chi tiết ẩn nút Replay, hiện "Nội dung đã được dọn ngày X".
- Gợi ý: bấm ĐÚNG hành động hub gợi ý -> `apply` (idempotent, tính lại khi gọi); hành động kia -> lệnh dọn tay cùng tham số.
**Đánh đổi:**
- Có thể thấy hai dải cùng lúc (banner CB critical vừa đến + banner dung lượng) trong vài giây đầu — chấp nhận, CB tự thu lại khi "Đã xem"/đóng.
- Banner đọc overview mỗi lần đổi dự án (staleTime 30s): thêm một GET nhẹ; viewer nhận 403 và không thấy banner.
- Đổi hạn mức không đổi nấc tức thì (≤ 60s) — tránh thêm đường ghi nấc thứ ba ngoài job đo và lô dọn.

## ADR-195 — Lỗi hạ tầng ở delivery không bao giờ `requeue=true`; hoãn 10s, không đốt lượt (BP1, 2026-10-13)

**Vấn đề:** `catch` ngoài cùng của `DeliveryConsumer` gọi `nack(requeue=true)` cho mọi ngoại lệ (kể cả Postgres mất kết nối ở bước 0). Requeue trả message về đầu queue và RabbitMQ giao lại ngay, không độ trễ; lỗi DB không tự khỏi trong vài mili giây nên message lỗi lại, requeue lại — Neon autosuspend/mất mạng 2 phút là 2 worker × 20 prefetch quay liên tục, mỗi vòng một lần đập vào DB đang cố dậy và một dòng `log.error` (log Render bị xả, Neon bị dội đúng lúc yếu nhất); message cũng không bao giờ vào DLQ vì requeue không tăng bộ đếm nào. Đây chính là "retry liên tục = tự tay phá" — không nằm ở tầng retry 10s→2h (có nhịp) mà ở một dòng `catch` không có nhịp (SPEC-ap-luc-nguoc §2, F1).
**Chọn:** `classifyInfraError(err): 'transient' | 'unknown'` dùng chung (`apps/hub-worker/src/consumers/infra-errors.ts`; `classifyNormalizeError` gọi lại, hành vi và bảng mã Prisma/mạng giữ nguyên). `transient` → republish `slim()` vào `q.delivery.retry.10s`, header `x-infra-deferrals`+1, KHÔNG tăng `attemptCount`, rồi ack. `unknown` → `q.delivery.retry.1m`, `x-unknown-errors`+1; lần thứ 5 `publish` bản sao `slim()` vào `x.hub.delivery.dlx`/`dead` (header `x-dead-reason: unknown_error` + số lần), publish xong mới `ack`, một dòng `log.error`; publish ném lỗi thì không ack (RabbitMQ giao lại). Không dùng `nack(requeue=false)` như spec viết ban đầu: `q.delivery.main` không khai báo DLX (`topology.ts`), nack(false) là vứt message chứ không vào `q.delivery.dlq` (phát hiện lúc code, phòng chọn phương án publish DLX). Metric `hub_delivery_infra_errors_total{kind}` (trong bộ nhớ, 0 lệnh Redis). Không thêm queue, topology không đổi; consumer không còn `nack(..., true)` (`[BP:T3]`).
**Đánh đổi:** không chọn `nack(false)` vì nó đẩy vào DLQ ngay trong khi lỗi DB thường tự hết sau vài phút — hoãn có độ trễ giữ message sống và cho DB nghỉ 10s giữa các lần. Không tăng `attemptCount` vì lần đó chưa gọi tới đích: đốt lượt vì lỗi của hub thì khách mất webhook vì lỗi không phải của họ (đổi lại — phát hiện lúc code, không có trong spec: lỗi hạ tầng kéo dài không có trần số lần, message quay mỗi 10s tới khi DB về — chờ BP5 điều tốc). Lỗi `unknown` có trần 5 vì có thể là bug cố định (poison message); đẩy bản sao vào DLQ rồi ack không mất dữ liệu vì Postgres vẫn là nguồn sự thật và sweeper hồi sinh delivery còn PENDING/RETRYING tối đa một lần mỗi 10 phút — có giới hạn, không thành vòng lặp nóng. Lỗi sau `claimForSend` để delivery ở DELIVERING: lần quay lại thua lease 60s và đi nhánh hoãn 1 phút sẵn có.
**Sửa sau review lượt 1 (2026-10-13):** sang lần thử mới thì `x-unknown-errors`/`x-infra-deferrals` về 0 (trần 5 là "liên tiếp trong một lần thử", như `x-circuit-deferrals`); log lỗi hạ tầng tối đa 1 dòng/30s/tiến trình kèm số lần gộp (metric vẫn đếm đủ); `x-dead-error` chỉ tên lỗi + message ≤ 200 ký tự. BP1 không cho cận trên số truy vấn Prisma/s khi DB chết — cận trên thuộc BP5 (`[BP:T4]` chuyển nhóm BP5).

## ADR-196 — Message giao hàng mang gợi ý `destinationId` + `rateLimitRps` để gate trước khi nạp DB; hoãn ghi DB thưa, trần hoãn tính theo thời gian (BP2, 2026-10-13)

**Vấn đề:** circuit breaker bảo vệ **đích** nhưng không bảo vệ **hub**: muốn biết message thuộc đích nào, consumer phải nạp row trước (join 4 bảng, kéo cả payload), rồi mới hỏi Redis; mạch OPEN thì bỏ hết, `UPDATE` một dòng, republish, một phút sau lặp lại. Một đích chết 3 giờ với 1.000 delivery chờ → mỗi phút 1.000 lần đọc nặng + 1.000 `UPDATE` + 1.000 lệnh Redis chỉ để quyết định "chưa gửi"; cả 6 lần thử × 30 lần hoãn ≈ 180.000 lệnh Upstash, hơn một phần ba quota tháng cho một đích chết của một khách; Neon free `connection_limit=1` nên các truy vấn này giành pool với ingest. Trần "30 lần hoãn" thành 2,5 giờ khi OPEN dài 5 phút (BP3), và việc reset bộ đếm ở mỗi tầng nhân tổng số lần hoãn lên 6 mà không ai thấy. `TOTAL_RETRY_WINDOW_MS` của QT chưa tính thời gian hoãn → sàn dọn bị đánh giá thấp (SPEC-ap-luc-nguoc §3, F2, F3, F7, F9, C2).
**Chọn:**
- `DeliveryMessage` thêm gợi ý tuỳ chọn `destinationId` + `rateLimitRps`, điền ở MỌI nơi tạo message (`route-event.ts` — một chỗ cho normalize lẫn `hub.*`/`emitHubEvent`; sweeper SQL; replay đơn + hàng loạt; `slim()`). Có gợi ý → **gate trước khi nạp**: OPEN / HALF_OPEN không giành probe → hoãn, 0 truy vấn đọc, 1 lệnh Redis; vượt throttle → `retry.10s`, 0 truy vấn DB. Sau khi nạp: `destinationId` lệch row → gate lại với id thật (+1 lệnh); chỉ `rateLimitRps` lệch → `recheckThrottle` so lại bộ đếm gate vừa INCR với rps thật (0 lệnh), hoặc một INCR nếu gate chưa INCR (gợi ý rps 0) — không đếm hai lần nên không hoãn oan. Bản republish mang gợi ý đúng với row. Message thiếu gợi ý đi đường cũ.
- **Gate** = `LUA_GATE`, LUÔN đúng 1 lệnh (thay `MGET` + `LUA_STATE_AND_THROTTLE`, ADR-064): INCR throttle chỉ khi CLOSED và rps > 0, trả PTTL của `:open` (BP3 dùng). Ramp để BP4 thêm vào chính script này.
- Hoãn vẫn ghi `next_attempt_at` (F7 — sweeper dựa vào nó; bỏ hẳn thì cứ 10 phút sweeper nhân bản message rồi dội vào đích khi mạch đóng) nhưng **thưa**: chỉ khi `x-defer-written-at` chưa có hoặc cũ hơn 2 phút, mốc = now + TTL tầng hoãn (mốc lưu luôn trong hạn của sweeper: PENDING 10 phút, RETRYING 5 phút).
- Trần hoãn theo **thời gian**: `x-circuit-deferred-since` đặt ở lần hoãn đầu của một lần thử, xoá khi lần thử thật diễn ra; `CIRCUIT_MAX_DEFER_MS` mặc định 30 phút export từ `@hub/messaging` `retry-window.ts`, env chỉ kẹp thấp hơn và không dưới 60s (một vòng hoãn — `'0.5'`/`'1'` không biến mỗi lần OPEN thành một lượt đốt ngay); bỏ `CIRCUIT_MAX_DEFERRALS`. `TOTAL_RETRY_WINDOW_MS` cộng `6 × (CIRCUIT_MAX_DEFER_MS + một vòng hoãn 1m)` (≈ 5h44m40s) trong cùng commit — trần chỉ được kiểm mỗi vòng nên một lần thử có thể hoãn tới `max + 1 vòng`.
**Đánh đổi:**
- **Lệch ADR-042** (C9): message mang một mẩu **cấu hình** (`rateLimitRps`), không chỉ tham chiếu. Giá trị thật vẫn đọc từ DB và được kiểm lại trước khi gửi; không có bí mật. Cần nó để gate trước khi nạp mà giữ R1: đích có throttle, gợi ý đúng → vẫn 2 lệnh/delivery; gợi ý lệch → 3 lệnh, ca ngoại lệ đã biết, có test trong `redis-budget.spec.ts`. Gợi ý `destinationId` lệch thì lần INCR throttle (nếu có) ở đích cũ là một lần đếm dư cho đích đó — chấp nhận.
- `destinationId` của subscription **không đổi được qua API**, nên gợi ý lệch đích chỉ xảy ra khi sửa DB tay; khi đó, nếu đích cũ đang OPEN, message bị hoãn tới hết `CIRCUIT_MAX_DEFER_MS` (30 phút) mới nạp row, gate lại và gửi (không ghi lần thử thất bại oan). Hai ca lệch CÓ THẬT, chấp nhận:
  - (a) Đích bị **lưu trữ** trong lúc đang OPEN: lần hoãn trước khi nạp không thấy `archived_at`, nên delivery chưa DEAD ngay mà chờ hết OPEN (60s; BP3 tới 5 phút), rồi lần nạp row (probe hoặc gate CLOSED) mới cho DEAD.
  - (b) `rateLimitRps` được **nâng hoặc bỏ**: message đang bay vẫn bị throttle theo gợi ý cũ ở nhánh trước khi nạp (vượt trần cũ → `retry.10s`, không nạp row nên không sửa được gợi ý) trong thời gian ngắn; không kẹt, lần nào qua được gate thì nạp row và gợi ý được sửa. (Hạ rps thì lần nạp row đầu tiên đã kiểm lại.)
  - Không làm `UPDATE … RETURNING destination_id` trong lần ghi thưa ở đợt này.
- Mốc `x-circuit-deferred-since` chỉ xoá khi lần thử thật diễn ra; các nhánh hoãn khác (throttle, thua lease, lỗi hạ tầng BP1) giữ nguyên nó. DB sập 40 phút ngay sau một lần hoãn vì circuit, DB về mà mạch vẫn OPEN → lần hoãn kế bị coi là quá trần ngay (ghi một lần thử thất bại). Cùng ngữ nghĩa với bộ đếm cũ, không phải hồi quy (review BP2 TH-6).
- `syncObserved` không chạy ở lần hoãn trước khi nạp (không có `persistedState`) → DB/console thấy OPEN→HALF_OPEN trễ một nhịp (tới khi có message nạp row, thường là người giữ probe). Không ảnh hưởng gửi.
- Cửa sổ retry dài ra ≈ 3 giờ → lệnh dọn `olderThan` dưới ~5h45m (vd. `3h`, trước đây hợp lệ) nay bị 400; đổi lại không dọn mất chốt chống trùng của message còn đang hoãn (lỗi đúng sai, không phải hiệu năng).
- Ghi thưa nghĩa là `next_attempt_at` trên console có thể cũ tối đa ~2 phút trong lúc hoãn.

## ADR-197 — OPEN 60s → 300s theo số probe thất bại; hoãn tới hết OPEN theo PTTL thật; "thử lại lúc" ghi lúc trip (BP3, 2026-10-13)

**Vấn đề:** OPEN cố định 60s nghĩa là hub coi mọi sự cố như sự cố một phút: đích chết 3 giờ thì khoảng 180 lần probe vào đích, và mỗi message trong hàng bị bốc ra, bỏ vào lại khoảng 180 lần — dù probe thất bại lần đầu đã là bằng chứng sự cố không ngắn. Thời điểm "thử lại" viết cứng 60s ở đường gửi (`CIRCUIT_OPEN_SECONDS`, `CIRCUIT_DEFER`), còn câu "Thử lại lúc …" của cảnh báo `destination.circuit_open` không bao giờ hiện vì evaluator không có `halfOpenAt` (SPEC-ap-luc-nguoc §4, C4).
**Chọn:**
- Backoff ở cấp **đích**: trip lần đầu (đủ ngưỡng khi CLOSED) OPEN 60s; **probe thất bại** → OPEN `CIRCUIT_OPEN_MAX_SECONDS` (mặc định 300, kẹp 60..300 — chỉ được thấp hơn), `:trips` +1 (DEL khi CLOSED, cùng lệnh DEL với 3 khoá cũ). `:failures`/`:trips` EXPIRE `openSeconds + 120` — HALF_OPEN là trạng thái suy ra từ "hết `:open` mà `:failures` còn", `:failures` hết trước thì mạch nhảy thẳng về CLOSED bỏ qua probe.
- Hoãn **tới hết OPEN**: gate (vẫn 1 EVAL) trả PTTL của `:open`; consumer hoãn vào `circuitDeferTier(pttl)` = tầng ngắn nhất có TTL ≥ PTTL — `retry.1m` hoặc `retry.5m`; HALF_OPEN không giành probe vẫn 1m; thua lease (không thuộc circuit) vẫn 1m. Hai mức 60/300 khớp đúng hai tầng TTL sẵn có — không thêm queue, không sửa `topology.ts` (C6 Q2: không tầng 2m).
- `circuitDeferTier`, `CIRCUIT_OPEN_MS/MAX_MS`, `circuitOpenMaxSeconds` ở `@hub/messaging` `retry-window.ts` — MỘT nguồn cho circuit breaker, consumer và cửa sổ retry (`CIRCUIT_DEFER_ROUND_MS` = tầng hoãn dài nhất = 5m). `TOTAL_RETRY_WINDOW_MS` = … + 6 × (30 phút + 5 phút) ≈ 6h08m40s, cùng commit.
- `destinations.circuit_half_open_at` (migration `20261013120000_circuit_half_open_at`, cột nullable): `now + TTL vừa SET EX` (60 hoặc 300s) tính ĐÚNG LÚC trip, ghi CÙNG `UPDATE circuit_state` (về trạng thái khác → NULL). Evaluator đọc cột này (truy vấn đích sẵn có) và truyền `halfOpenAt` vào `evalCircuitOpen` — không gọi Redis mỗi tick (quota Upstash), không suy ra bằng `openedAt + 60s`.
**Đánh đổi:**
- Đích hồi phục thì phải chờ tối đa khoảng 5 phút hub mới biết (Sally muốn 2 phút; không có tầng 2m — muốn có phải sửa topology, cạm bẫy `PRECONDITION_FAILED`). 5 phút là mức tối đa chấp nhận cho một khách vừa sửa xong server; cao hơn (30 phút) thì sự cố 10 phút thành 37 phút trễ. Đổi lại, đích chết lâu chỉ tốn ~1 lệnh Redis mỗi 5 phút cho mỗi message thay vì mỗi phút.
- PTTL hơi quá 60s (vd. 61s) cũng rơi vào tầng 5m — hoãn thừa tới ~4 phút; chỉ xảy ra với OPEN 300s nên chấp nhận.
- Lệnh dọn `olderThan` dưới ~6h09m (vd. `6h`) nay bị 400.
- `halfOpenAt` chỉ được ghi khi UPDATE đổi được `circuit_state` (có điều kiện, ADR-054). Probe thất bại luôn đi qua HALF_OPEN (người giữ probe nạp row và `syncObserved` OPEN→HALF_OPEN trước khi gửi) nên lần trip lại ghi được mốc mới; nếu `syncObserved` bị bỏ (Redis degraded) thì mốc có thể cũ một nhịp — chỉ ảnh hưởng câu hiển thị.
- `:trips` hiện chỉ để quan sát (hai mức 60/300 nên "đã có probe thất bại" là đủ); giữ theo spec để BP sau có thể bậc thang thêm. Giá trị ghi vào dòng log `warn` mỗi lần trip, lấy từ kết quả INCR trong chính MULTI (0 lệnh thêm). Câu "Thử lại lúc …" bỏ khi mốc đã qua so với `now` của người dựng câu (mốc cũ một nhịp không hiện thành giờ sai).
- (review BP3 TH-3) Một request gửi với view CLOSED (vd. fail-open khi Redis chập chờn) thất bại SAU lần trip lại 300s thì `recordFailure` thấy `failures ≥ 5` và `SET :open EX 60` ghi đè — OPEN 300s bị rút xuống 60s. Hầu như không xảy ra (request ≤ 10s, probe chạy sau ≥ 60s); chấp nhận, không thêm Lua "chỉ đặt khi PTTL nhỏ hơn".
- (review BP3 TH-4) Rolling deploy: worker BP2 còn chạy song song thì ghi `circuit_state` mà không NULL `circuit_half_open_at`, không DEL `:trips`. Vô hại: mốc cũ bị ghi đè ở lần trip kế (và câu hiển thị bỏ mốc đã qua), `:trips` tự hết hạn sau ≤ 420s.

## ADR-198 — Slow-start sau probe thành công thay cho jitter (BP4, 2026-10-13)

**Vấn đề:** một probe thành công chỉ chứng minh đích chịu được **một** request, không chứng minh nó chịu được cả hàng tồn. Trước BP4, probe thành công thì xoá khoá và về CLOSED ngay, trong khi `rate_limit_rps` mặc định 0 — toàn bộ hàng hoãn quay về theo tốc độ prefetch × số worker. Kịch bản: server khách chết 20 phút vì hết RAM, restart xong probe trả 200, ngay sau đó 500 delivery dội vào trong vài giây, server hết RAM lần nữa, mạch lại OPEN; khách thấy toast đỏ lần hai và kết luận hub đánh sập họ — đợt tải dồn dập ngay khi breaker vừa cho gọi lại mà bài Canva mô tả. Phụ lục còn hứa "jitter ±20%" mà code cố tình không làm (SPEC-ap-luc-nguoc §5, F5, F8).
**Chọn:**
- Probe thành công → MỘT lệnh (`LUA_CLOSE_AND_RAMP`): DEL `failures/open/probe/trips` + `SET circuit:{id}:ramp = nowMs EX DELIVERY_RAMP_SECONDS`. Chỉ khi probe (view HALF_OPEN): mạch tự về CLOSED vì khoá hết hạn hay thành công lúc CLOSED nghĩa là chưa từng OPEN, đích không có hàng tồn (C11).
- Gate (vẫn MỘT `EVAL` `LUA_GATE`, thêm khoá `:ramp` + ARGV nowMs/start/step): CLOSED và còn `:ramp` → `rampCap = START × 2^floor((now − rampStart)/STEP)`; INCR bộ đếm throttle của giây hiện tại (chung cửa sổ với `rate_limit_rps`); trần = min(rps nếu > 0, rampCap); vượt → `retry.10s` (nhánh throttle sẵn có): không tăng lượt, không ghi DB, trước khi nạp row nếu message có gợi ý (BP2). Mặc định 2 rps, bước 10s, 60s (trần cuối ~64 rps), `DELIVERY_RAMP_SECONDS=0` tắt. Lỗi trong ramp tính bình thường; đủ ngưỡng → OPEN và DEL `:ramp`.
- Nhân đôi theo thời gian như TCP slow-start: đích yếu thì lỗi sớm ở mức thấp, mạch OPEN lại với ít thiệt hại; đích khoẻ thì sau 60s đã chạy gần hết tốc — không cần tham số theo từng khách.
- Cửa sổ retry (`TOTAL_RETRY_WINDOW_MS`) cộng `6 × (60s + 10s)` ≈ 6h15m40s, cùng commit; `DELIVERY_RAMP_SECONDS` chỉ kẹp thấp hơn 60.
**Đánh đổi:**
- **Không jitter** (phụ lục hứa ±20%): jitter ở tầng retry không làm được với TTL theo queue — per-message TTL gây head-of-line blocking (ARCHITECTURE §4); kể cả làm được, jitter ±20% của 1 phút chỉ rải hàng ra ~24 giây và đích vẫn nhận gần cả hàng. Slow-start chặn trực tiếp **tốc độ** vào đích. Phụ lục được đính chính ở BP6 (chờ Admin trả lời Q1).
- **Không dùng `rate_limit_rps` cố định cho mọi đích**: ngưỡng cố định khó chọn — quá chặt lúc bình thường hoặc quá lỏng lúc sự cố; ramp chỉ áp trong 60s sau sự cố, thời gian còn lại không giới hạn gì.
- Đích hồi phục mất thêm ~60s mới chạy hết tốc; message bị ramp hoãn quay lại sau 10s (vòng `retry.10s`), nên trần thực tế mỗi giây ≤ rampCap nhưng thông lượng trung bình thấp hơn trần một chút.
- Ramp tính bằng đồng hồ của worker (nowMs trong ARGV, mốc trong `:ramp`); lệch đồng hồ giữa worker chỉ làm bậc ramp lệch tương ứng.
- Mất `:ramp` (Redis mất dữ liệu) → gửi bình thường không ramp; Redis lỗi → gate fail-open (BB-2: chậm/khác đi, không sai). Không gộp `tryAcquireProbe` vào gate (C11).

## ADR-199 — Retention không xoá event còn delivery chưa tới đích (phát hiện trong review BP4, 2026-10-13)

**Vấn đề:** `deleteExpiredEventsBatchAccounted` (retention theo `CLEANUP_RETENTION_DAYS`) xoá event quá N ngày mà không xét delivery; FK `deliveries.event_id` là `onDelete: Cascade` nên delivery đang chờ (PENDING/DELIVERING/RETRYING — vd. đích có `rate_limit_rps` thấp tồn hàng lâu hơn retention) bị xoá theo, worker nạp row gặp `!row` thì ack → **mất webhook âm thầm**. Lỗi có từ trước BP; lệnh dọn QT (`cleanStorageBatch`) đã chặn đúng điều này nhưng retention thì không.
**Chọn:** CTE chọn lô của retention thêm `NOT EXISTS (delivery của event với status IN ('PENDING','DELIVERING','RETRYING'))`, cùng tập trạng thái với `cleanStorageBatch` qua một hằng duy nhất `IN_FLIGHT_DELIVERY_STATUSES` (`libs/database/src/constants.ts`, SQL `IN_FLIGHT_DELIVERY_STATUS_SQL`). Đã kiểm các đường xoá `events`/`raw_events` khác: lệnh dọn QT (đã chặn), mẫu REJECTED và raw ACCEPTED mồ côi (không có event/delivery). Test DB `retention-db.spec`.
**Đánh đổi:** event (và byte của nó trong `project_usage`) có thể sống lâu hơn retention khi đích chậm/hoãn kéo dài — chỉ tới khi delivery tới đích hoặc thành DEAD; lượt retention sau xoá được. Index `deliveries(event_id, …)` (unique) phục vụ `NOT EXISTS` nên lô retention không chậm đi đáng kể.

## ADR-200 — Áp lực ngược cục bộ kiểu Canva, chỉ cho phụ thuộc của chính hub; lỗi đích không bao giờ là tín hiệu (BP5, 2026-10-13)

**Vấn đề:** worker là "greedy worker" đúng như Canva tả: còn chỗ trong prefetch là nhận việc, dù việc nào cũng sẽ lỗi vì DB chết. Normalize có 5 lượt × 30s ≈ 2,5 phút; DB chết lâu hơn thế thì mọi sự kiện trong hàng cạn lượt và vào `q.normalize.dlq`, sáng ra phải renormalize tay (Neon sự cố 20 phút lúc 2 giờ sáng → cả lô, vd. 3.000 thanh toán PayOS). Vòng lỗi hạ tầng của delivery (BP1) có nhịp nhưng không có cận trên số truy vấn/giây (SPEC-ap-luc-nguoc §7, F6).
**Chọn:**
- `FailureRateController` cục bộ trong tiến trình, MỘT cho phụ thuộc `db` (MỘT factor), dùng chung normalize + delivery nhưng **mỗi consumer một semaphore riêng** MAX = prefetch 20 (review BP5 TB-1: một semaphore chung thì 20 delivery treo HTTP ở đích chậm của một tenant chiếm hết permit và normalize của mọi tenant xếp hàng sau — lỗi đích làm chậm tenant khác, trái §0; lúc khoẻ thông lượng như trước BP5, 40 đồng thời mỗi tiến trình); đếm trong bộ nhớ, 0 lệnh Redis (Redis có quota và có thể chết — một bộ điều khiển phụ thuộc Redis để bảo vệ khỏi lỗi hạ tầng thì lại thêm một hạ tầng có thể lỗi). Tín hiệu `infra_fail` CHỈ khi `classifyInfraError === 'transient'`; lỗi của đích (5xx/4xx/timeout) là `ok` — Postgres là phụ thuộc chung nên chậm cả worker không phạt oan ai, còn đích chỉ của một tenant (§0).
- Cửa sổ 30s, bucket 1s, ≥ 10 mẫu; mỗi 1s: lỗi > 5% (con số Canva chạy thật) → factor +0.25 (lùi nhanh), ngược lại −0.1 (hồi chậm) — AIMD đảo chiều: lùi chậm thì đốt nhiều lượt, hồi nhanh thì DB vừa dậy bị dội lại. permits = max(1, ceil(20 × (1 − factor))); factor = 1 → chế độ dò 1 message / 5s **mỗi lane** (≤ 2 lần gọi DB / 5s / tiến trình; ý HALF_OPEN — câu Canva để Part 2). Thiếu mẫu mà còn lỗi trong cửa sổ thì giữ factor (C12).
- Message chờ permit trong tiến trình, unacked, prefetch giữ 20 (không đổi `basic.qos` lúc chạy — hành vi với consumer đang mở không chắc chắn). Giữ quá 60s (`consumer_timeout` của RabbitMQ, không chặn message sau) → republish không đốt lượt (normalize `retry.30s` giữ `x-normalize-retry`; delivery `retry.10s` giữ `attemptCount`) rồi ack. Spill normalize dùng chung trần `NORMALIZE_MAX_DEFER_MS` với §7.4 (gắn/giữ `x-normalize-deferred-since`); quá trần thì đốt lượt, hết lượt vào DLQ (review BP5 TH-1). Spill delivery KHÔNG cần trần: delivery đang chờ vẫn PENDING/RETRYING/DELIVERING trong Postgres, lệnh dọn QT và retention (ADR-199) đều chừa event còn delivery chưa tới đích, sweeper hồi sinh nếu message mất — giữ lâu chỉ làm trễ, không mất dữ liệu.
- Normalize §7.4: factor > 0 thì lỗi tạm hoãn `retry.30s` KHÔNG đốt lượt (`x-normalize-deferred-since`), tối đa `NORMALIZE_MAX_DEFER_MS` = 60 phút (export từ `retry-window.ts`, env chỉ kẹp thấp hơn, cộng vào `TOTAL_RETRY_WINDOW_MS` cùng một vòng 30s (trần kiểm theo vòng) ≈ 7h16m10s, cùng commit); factor = 0 thì hành vi cũ 5 lượt — để một message có vấn đề riêng không được hoãn mãi.
- Tắt máy (C5): message đang chờ permit nhận `shutdown` ngay — không xử lý, không republish (sẽ trùng bản RabbitMQ giao lại), không ack; chỉ message có permit tính vào `inFlight`. Thứ tự nằm trong `gracefulStop` (`src/shutdown.ts`, có test): huỷ consume → `backpressure.shutdown()` → chờ handler có permit → đóng channel.
- Bảng mã: 57P01/57P02/57P03 và lớp 08 thành `transient` (cả `classifyNormalizeError`, gọi lại cùng hàm); "Channel closed" giữ `unknown`. Channel consumer đóng riêng → thoát tiến trình (hết channel zombie). Metric `hub_backpressure_factor{dependency}`, `hub_backpressure_held{consumer}`, `hub_backpressure_spilled_total{consumer}`, `hub_deliveries_deferred_total{reason}`, `hub_normalize_deferred_total`.
**Đánh đổi:**
- Chậm cả worker khi DB ốm — đúng ý, vì mọi message đều cần DB. Permit giới hạn đồng thời chứ không giới hạn tốc độ: vài giây đầu (tới khi factor lên 1) DB lỗi nhanh vẫn bị gọi theo nhịp broker; sau đó ≤ 1 lần / 5s. DB về thì mất tới ~30s (lỗi cũ trôi khỏi cửa sổ) mới bắt đầu hồi, rồi hồi dần 10%/giây.
- Event có thể nằm trong hệ thống thêm tới 60 phút + một vòng (normalize hoãn/spill) + giữ chờ permit 60s mỗi lần thử → `TOTAL_RETRY_WINDOW_MS` cộng `NORMALIZE_MAX_DEFER_MS + 30s + 6 × BACKPRESSURE_HOLD_MAX_MS` (≈ 7h22m10s; `BACKPRESSURE_HOLD_MAX_MS` export từ `retry-window.ts`, env chỉ kẹp thấp hơn) — lệnh dọn `olderThan` dưới ~7h23m bị 400.
- Channel consumer đóng → worker thoát; ở chế độ `hub-all` (ADR-129) supervisor dừng cả hub-api, Render dựng lại container — ingest gián đoạn tới khi lên lại; provider tự retry (BB-3: chưa COMMIT thì không 2xx) nên không mất sự kiện.
- Không áp cho ingest (`hub-api` đã trả 5xx khi DB chết, BB-3 — provider tự retry) và outbox relay (P2). Chaos LOCAL chưa chạy (C8); bằng chứng hiện là mô phỏng L0 (`backpressure.spec`).

## ADR-192 — Ngoại lệ truy vấn không qua `TenantScopedRepository`: chỉ bảng hạ tầng dùng chung (`outbox`, `processed_messages`) và các lối đã có tên (BP6, 2026-10-13)

**Vấn đề:** BB-5 nói mọi truy vấn đi qua `TenantScopedRepository`, nhưng một số chỗ gọi Prisma trực tiếp. Agent vẽ sơ đồ (BP6) đối chiếu code thấy các chỗ đó mà không có một ADR liệt kê đầy đủ, nên không phân biệt được "ngoại lệ có chủ đích" với "lỗ BB-5".
**Chọn:** liệt kê bằng grep `(prisma|tx|this.db).($queryRaw|$queryRawUnsafe|$executeRaw|$transaction|outbox.*|processedMessage.*|rawEvent.*|deliveryAttempt.*)` trên `apps/hub-api/src`, `apps/hub-worker/src` (13/10, sau `56fa384`) và phân loại:
- **Bảng hạ tầng dùng chung, không mang tenant, không RLS (ngoại lệ của ADR này):** `outbox` — `tx.outbox.create` ở `ingest.service.ts:262`, `route-event.ts:34`, `api.controller.ts:690` (replay), `:807` (replay hàng loạt `createMany`), `:935` (renormalize); `OutboxRelay.relayBatch` `outbox.relay.ts:115` (`$transaction`), `:117` (`$queryRawUnsafe` — SQL hằng, chỉ nội suy hằng `RELAY_BATCH`, `FOR UPDATE SKIP LOCKED`), `:146` (`$executeRaw` đánh dấu `published_at`). `processed_messages` — `delivery.consumer.ts:476` (`findUnique`), `:556` (`create`), `normalize.consumer.ts:142` (`findUnique`), `:221` (`create`). Hai bảng này là cơ chế giao nhận (outbox pattern, khoá idempotency theo message), payload chỉ là tham chiếu (S1-1), không có cột tenant để scope; ghi luôn nằm TRONG transaction đã đặt tenant của bảng nghiệp vụ đi kèm.
- **Bảng nghiệp vụ có RLS ghi trong `tenantTx` (đã có ADR-108, không phải ngoại lệ mới):** `tx.rawEvent.create` `ingest.service.ts:240` (ACCEPTED) và `:557` (mẫu REJECTED); `tx.deliveryAttempt.create` `delivery.consumer.ts:552`. `tenantTx(tenantId)` đặt `app.project_id` nên RLS chặn ghi sai tenant ở tầng DB.
- **Lớp con của repo (hợp lệ theo ADR-100):** `FlowScopedRepository extends TenantScopedRepository` (`apps/hub-api/src/modules/flow/flow.repository.ts`) — truy vấn bản đồ luồng bằng `this.db.$queryRaw` (getter trả `this.prisma` của repo, đã đặt `app.project_id`, SQL lọc `tenant_id`). Mẫu grep phải thêm `this.db.` mới bắt được — review BP6 TH-4.
- **Escape hatch có tên trong `libs/database/src/prisma.service.ts`** (ngoài phạm vi grep `apps/`): tra source lúc ingest (`findSourceBySourceKeyForIngest`, `systemTx`), retention (`deleteExpired*BatchAccounted`), các lối operator / xuyên project của cảnh báo, dung lượng, email (ADR-108/169/184/190) — mỗi cái một tên, gate trong `verify:gates` giới hạn nơi gọi.
- **Lối xuyên project có tên `systemTx` (ADR-108):** `cleanup.job.ts:329`, `delivery.sweeper.ts:123`. **Trong `tenantTx` rồi qua repo:** `storage-clean.ts:37` (chỉ `set_config statement_timeout`). **`$transaction` chỉ để gom transaction, thân đi qua repo / `IdentityRepository`:** `members.service.ts:55,117,149,181`, `projects.controller.ts:184,255`. **Health:** `health.controller.ts:46` (`SELECT 1`).
- Không có chỗ nào chạm bảng nghiệp vụ mang tenant mà KHÔNG scope (không repo, không `tenantTx`, không `systemTx`) — nếu grep sau này ra chỗ như vậy thì đó là lỗi BB-5, không phải ngoại lệ.
**Đánh đổi:** `outbox`/`processed_messages` không có lớp bảo vệ RLS — bù lại payload không mang dữ liệu nghiệp vụ hay bí mật (S1-1, migration scrub ADR-042) và mọi ghi đi cùng transaction có tenant. Danh sách số dòng sẽ trôi khi code đổi: lần đối chiếu sau phải grep lại, không tin số dòng ở đây.

## ADR-201 — `/hooks`: segment khớp provider của source, cổng phạt mọi method, bytes gốc mọi content-type (PK0, 2026-10-13)

**Vấn đề:** (1) lõi chọn adapter theo segment URL nhưng chọn source theo `sourceKey` — `/hooks/github/<key-sepay>` chạy HMAC kiểu GitHub với secret SePay, luôn 401 mà dev không hiểu vì sao; có adapter verify lỏng thì một `sourceKey` lộ ra là đi vòng được adapter chặt (F7). (2) Gate hộp phạt chỉ chặn POST, PK4 sẽ mở GET cho bắt tay → cửa sau mở đúng ngày merge (F11). (3) `/hooks` chỉ có parser json/urlencoded, controller dựng lại body bằng `JSON.stringify(req.body || {})` → SNS `text/plain`, XML, JWT, JSON lines, body rỗng thành `"{}"`, bytes provider đã ký mất hẳn; JSON lines gắn `application/json` bị 400 trước ingest (review PK bản 2 N1). Query và method không tới adapter (N6).
**Chọn:** (1) `ingest.service.ts` ngay sau nạp source, TRƯỚC `trace.tenantId`: `source.provider !== req.provider` → 404 CÙNG body với source không tồn tại (ADR-161), không `recordUnknownSource`, metric `NOT_FOUND` — so hai giá trị, không phải `if (provider === 'x')`. (2) `penalty-gate.ts` áp mọi method trên `/hooks/*` trừ `OPTIONS`. (3) `/hooks` thêm `express.raw({ type: () => true, limit: MAX_INGEST_PAYLOAD_BYTES, verify: keepRawBody })` SAU json/urlencoded; controller bỏ fallback, không có `rawBody` → `Buffer.alloc(0)`; JSON lỗi cú pháp RIÊNG `/hooks/generic/*` không 400 ở parser (`body = null`, bytes giữ), provider native giữ 400. (4) `RawWebhookRequest` thêm `method` + `query` (chuỗi thô sau `?`), controller điền; PK0 chưa lưu query vào DB, chưa mở `@Get` (PK4).
**Đánh đổi:** 404 khi lệch segment không cộng điểm phạt — kẻ dò được sourceKey thật không bị luật (a) đếm ở lối này (đổi lại URL sai của provider thật không khoá IP dùng chung); lệch không vào lưu lượng/trace của tenant nên dev chỉ thấy qua metric + log. Parser raw đọc tới 1MB với mọi content-type lạ (trước đây bỏ qua không đọc) — cùng trần với JSON, gate hộp phạt vẫn chặn trước. Hai trường mới là tuỳ chọn trong kiểu (request dựng lại ở worker và `/v1/p/:project/events` không có): thiếu = `POST` / `''`. Test mock source cũ phải mang `provider` khớp segment.

## ADR-202 — `generic` lên console ("Nhà cung cấp khác"), tab Lắng nghe dùng chung inspect, Svix = Standard Webhooks đổi tên header (PK1, 2026-10-14)

**Vấn đề:** backend có `generic` từ S8 nhưng console không có — dev không thấy bên mình dùng thì kết luận hub không hỗ trợ (F2). Dev cấu hình sai chỉ thấy 401, `inspect` chỉ có ở service API (F3). Clerk, Resend và các bên gửi qua Svix ký đúng thuật toán Standard Webhooks nhưng header là `svix-*`, `swVerify` chỉ đọc `webhook-*` (F4). "Tạo source xong" chưa phải là nối được — thước đo của Admin là request thật đầu tiên vào ACCEPTED.
**Chọn:** (1) Console thêm "Nhà cung cấp khác" (`generic`) với form tay tối thiểu (scheme, header, encoding, khoá chống trùng, eventType) — dựng `verificationConfig`, server `validateGenericConfig` vẫn là trọng tài; PK7 thay bằng form nhận diện. (2) `GET /api/v1/sources/:id/inspect` (scope `read:project` như GET sources của console, repo theo tenant) và `GET /v1/p/:project/sources/:id/inspect` gọi MỘT hàm `inspectSourceRows` (`service-api/source-inspect.ts`) — cùng khuôn, cùng 404/422, không giá trị header/body. (3) Nút "Lắng nghe" trên dòng nguồn generic mở một sheet (console chưa có trang chi tiết nguồn), poll 2s, dòng trạng thái: chờ / "Đã nhận request đầu tiên ✓" (có ACCEPTED) / "Trượt: …" (chẩn đoán REJECTED gần nhất, chỉ tên). (4) `swHeaderSet`: có header `webhook-*` nào thì dùng bộ chuẩn, không có mà có `svix-*` thì bộ Svix — ba header luôn cùng một bộ, trộn = thiếu header = false; `diagnose`/`extractSignature` theo bộ đang có; khoá chống trùng mặc định `webhook-id` nghĩa là "id của bộ đang dùng" (`svix-id`). Không thêm scheme mới.
**Đánh đổi:** trạng thái kết nối tính ở client từ 10 dòng mới nhất (không thêm truy vấn) — nguồn từng ✓ mà 10 request gần nhất đều trượt sẽ hiện "Trượt", đúng điều dev cần sửa. `read:project` cho inspect rộng hơn `manage:sources` của service API (viewer thấy tên header và lý do trượt, không thấy giá trị). Idempotency `webhook-id` tự đổi sang `svix-id` là một quy ước ngầm — ghi ở đây và ở hint của form.

## ADR-203 — `hmac` mở rộng thành tham số (algo, encoding, prefix tĩnh hoặc `<algo>=`, keyEncoding); `static-token` có vị trí header | basic | query; không biểu thức (PK2, 2026-10-14)

**Vấn đề:** nghiên cứu §1: `hmac-sha256` chỉ phủ khoảng 60% nhóm S1. Phần còn lại vướng sha1 (Vercel, Intercom, Trello), sha512, tiền tố (`sha256=`, `v1=`, `hmac-sha256=`), thuật toán ghi trong tiền tố (Bitbucket, Jira, WebSub `method=sig`), hoặc khoá phải giải mã trước khi HMAC (Squarespace hex, Airtable base64, Adyen hex). S2 có basic auth (Chargebee, Pipedrive, Azure DevOps, Postmark) và token ở query. Đây đều là tham số của CÙNG một thuật toán HMAC trên bytes body — không phải lý do để viết code riêng cho từng bên.
**Chọn:** (1) Scheme mới `hmac`: `algo` sha1|sha256|sha512 (mặc định sha256), `encoding` hex|base64, `prefix` chuỗi tĩnh ≤ 32 (E15) HOẶC đúng chuỗi `"<algo>="` = thuật toán đọc từ tiền tố chữ ký, chỉ nhận trong tập (lạ như `md5=`/`sha384=` → false, không ném; khi đó không lưu `algo`), `keyEncoding` utf8|hex|base64 — giải mã CHẶT (hex lẻ/ký tự lạ, base64 hỏng → secret đó bị bỏ qua; không dùng `Buffer.from` lỏng vì nó cắt ở ký tự lạ). (2) `hmac-sha256` giữ làm bí danh: khuôn lưu không đổi (không thêm trường), `hmacParams` đọc ra `{algo:"sha256", keyEncoding:"utf8"}`, prefix luôn tĩnh — source cũ không đổi hành vi; bí danh từ chối `algo`/`keyEncoding` (đổi thì dùng `hmac`). Form console chỉ tạo `hmac`. (3) `static-token.location`: `header` (mặc định, khuôn lưu cũ), `basic` (so base64 của "user:pass" với phần sau `Basic ` của Authorization — so chuỗi đã mã hoá, không giải mã lỏng), `query` (tham số `param` của chuỗi query thô E6, `URLSearchParams`; xuất hiện khác đúng 1 lần → false). Mọi so sánh vẫn `timingSafeEqual`, kể cả sha1. (4) Lúc tạo source, `secretProblem` kiểm secret dùng được với config (hex/base64 giải mã được, basic có `:`) → 422 `secret` thay vì 401 mãi. (5) Token ở query: lõi không lưu query ở đâu (raw_events chỉ có headers + body), log của hub không in URL, access log nginx dùng `$uri` (không query) — nhưng **error_log của nginx** (cầu chì `limit_req`, upstream timeout/502) in nguyên request line kèm query (sửa theo review PK2 T-2), `extractSignature` = `***`, `diagnose` chỉ trả TÊN tham số (`expectedQueryParam`). `[PK:T6]`, `[PK:T7]`.
**Đánh đổi:** sha1 là ngoại lệ có chủ đích — HMAC-SHA1 chưa có tấn công giả mạo thực tế, nhưng là lựa chọn yếu nhất; form gắn nhãn "chỉ khi nhà cung cấp quy định". Ở chế độ `<algo>=` kẻ gửi tự chọn thuật toán trong tập (hạ xuống sha1) — vẫn phải biết secret mới ký được, nên chấp nhận; bên nào cố định thuật toán thì khai `algo` + prefix tĩnh. `hmac-sha256` và `hmac` song song là hai cách viết cùng một thứ (giữ vì tương thích ngược). Token ở query vẫn lộ qua log của máy trung gian ngoài hub (proxy của Render, của provider) — console cảnh báo, chỉ dùng khi provider không cho cách khác. Diagnose của query không phân biệt "thiếu" với "sai" (vì không lưu). Không biểu thức, không JSONPath, không vòng lặp (§15): bên nào cần hơn thì `signed-template` (PK3) hoặc adapter native.
**Bổ sung (review PK2, 2026-10-14):** (a) T-3: `"<algo>="` nhận thêm `algos?` (tập thuật toán được phép); vắng = **sha256 + sha512**, sha1 phải khai rõ (WebSub `["sha1","sha256","sha512"]`). Config `"<algo>="` đã lưu không có `algos` (chỉ tồn tại vài phút trên production) nhận mặc định mới — chấp nhận: bên nào thật sự gửi `sha1=` thì khai lại. Kẻ gửi không còn hạ xuống sha1 khi config không cho. (b) T-4: khoá base64 phải khứ hồi (bit thừa khác 0 → từ chối) — mỗi khoá một cách viết. (c) T-5: `location: "query"` chỉ nhận token gồm `[A-Za-z0-9._~-]` (422 `secret`), vì `URLSearchParams` giải mã `+` thành dấu cách và `%xx` thành byte. (d) T-2: error_log nginx không che được query → đánh đổi cùng nhóm log proxy Render; console khuyên tiêu đề / Basic thay query. **Đánh đổi:** thêm một trường (`algos`) để đóng một đường hạ cấp không giả mạo được — rẻ, và mặc định an toàn hơn.

## ADR-204 — `signed-template`: HMAC trên chuỗi ký `{timestamp}` / `{body}` / `{id}`, chữ ký ở 1–2 tiêu đề hoặc khoá=giá trị, bắt buộc độ lệch; `verifyAt` thay "bây giờ" (PK3, 2026-10-14)

**Vấn đề:** nhóm S4 (Stripe, Slack, Paddle, Calendly, Box, Twitch, Zendesk, Webflow, Zoom…) ký `HMAC(secret, chuỗi gồm timestamp/id + body)` để chống phát lại; theo nghiên cứu §6.2 cả nhóm chỉ khác **dấu phân cách, vị trí timestamp, chỗ đặt chữ ký**. `hmac` (ADR-203) chỉ ký body nên không phủ được. Viết adapter riêng cho từng bên trái luận điểm "thêm provider = config/adapter, không sửa lõi"; mở biểu thức tự do thì thành ngôn ngữ cấu hình không kiểm được (§15).
**Chọn:** (1) Scheme `signed-template`: `template` khớp `^([^{}]|\{(timestamp|body|id)\}){1,128}$` — đúng **3 token**, `{body}` **đúng một lần** (thiếu thì chữ ký không phủ body → thay body giữ chữ ký cũ được), thêm token = ADR + fixture provider thật. HMAC (`algo` sha256|sha512, `encoding` hex|base64, `keyEncoding` utf8|hex|base64) tính trên `Buffer.concat` các phần: chữ thường utf8, `{body}` = **bytes gốc**, `{timestamp}`/`{id}` = chuỗi header **đúng như nhận** (không chuẩn hoá lại). (2) `signature`: `{headers: [1–2], prefix?}` (Box primary/secondary — khớp một là đủ) HOẶC `{header, kv:{sep ";"|",", sig, timestamp?}}` (Stripe `t=,v1=`, Paddle `ts=;h1=`) — mọi giá trị của khoá `sig` là ứng viên (xoay khoá), khoá khác (`v0`) bị bỏ; khoá timestamp xuất hiện ≠ 1 lần → false. (3) Có `{timestamp}` thì **bắt buộc** nguồn timestamp (`timestampHeader` hoặc `kv.timestamp`, không cả hai), `timestampFormat` unix|unix-ms|iso8601 (RFC 3339, tới 9 chữ số lẻ — Twitch) và `toleranceSec` 5..900 (5 vì Paddle SDK); không có `{timestamp}` thì các trường này bị cấm. `{id}` ↔ `idHeader`. Sai luật → 422 đúng tên trường lúc tạo; config đã lưu kiểm lại mỗi request. (4) Mọi so sánh `timingSafeCompare`, vòng secret × chữ ký không dừng sớm. (5) E2: `AdapterContext.verifyAt?: Date` là "bây giờ" khi kiểm độ lệch — cả `signed-template` và `standard-webhooks` (`swVerify` nhận `nowSec`). Ingest thường không truyền (giữ hành vi); verify bù của chế độ thu (PK6) truyền `received_at`. (6) `diagnose`: thiếu tiêu đề chữ ký/timestamp/id → `missing_header`, lệch giờ so với `received_at` của dòng → `timestamp_out_of_range`, còn lại `signature_mismatch` — chỉ tên header. (7) Console: scheme mới + ba nút "điền nhanh" (Stripe/Slack/Paddle) chỉ điền sẵn giá trị theo tài liệu công khai, không phải danh mục. `[PK:T8]`, `[PK:T9]`.
**Đánh đổi:** chỉ phủ chữ ký **trên bytes body + header**; bên ký cả URL (HubSpot v3, Twilio), ký JSON đã sắp khoá (Casso) hay chữ ký có timestamp ở vị trí không tên trong kv (Recurly `<ts>,<sig>`) không vào được — đi `unverified` (PK5) hoặc adapter native. `toleranceSec` tối đa 900: bên cần cửa sổ dài hơn phải chấp nhận 900. `{timestamp}` ký nguyên chuỗi nhận được nên cùng một thời điểm viết hai kiểu khác nhau là hai chữ ký khác nhau — đúng với mọi provider đã đối chiếu. Điền nhanh có thể lệch khi provider đổi tài liệu — dev vẫn thấy và sửa mọi ô, server là trọng tài.
**Bổ sung (review PK3, 2026-10-14):** (a) T-1: chuỗi ký ghép token **liền nhau, không ký tự ngăn cách** thì byte có thể dời qua ranh giới mà chữ ký vẫn đúng. Luật tối thiểu để chặn: unix/unix-ms **không nhận số 0 đứng đầu** (`^(0|[1-9]\d{0,11})$`, ms tới 15 chữ số), và validator trả 422 `template` khi `{id}` đứng sát `{body}` (cả hai phía), vì hai token này đều không có khuôn cố định. `{timestamp}` đứng sát token khác vẫn được (Twitch `{id}{timestamp}{body}`, Box `{body}{timestamp}`): khuôn timestamp cứng, cộng với cửa sổ độ lệch, nên dời một byte sẽ làm giá trị đổi ≥ 10 lần hoặc làm hỏng khuôn. (b) T-2: `verifyAt` không hợp lệ (Invalid Date) → verify **false** (adapter kiểm `Number.isFinite`, `swVerify` so `!(|now − ts| ≤ tol)`): fail-closed, trước khi PK6 truyền `received_at`. (c) T-5: điền nhanh Paddle giữ 5 giây (khớp SDK). Câu nhắc ở form nói rõ: trên DEPLOYED, request đầu tiên sau khởi động lạnh có thể lệch quá 5 giây và bị 401 giả; Paddle sẽ gửi lại, và dev tăng lên 30 nếu hay gặp. (d) T-6: `diagnose` dạng kv thiếu hẳn khoá timestamp → `missing_kv_key` kèm `expectedKvKey` (vd `t` trong `stripe-signature`), thay vì báo "lệch giờ". **Đánh đổi:** chặn được hai đường phát lại/đổi body mà không đổi config của provider thật nào. Bên nào thật sự ký `{id}{body}` liền nhau thì phải đi `unverified` hoặc adapter native. Không provider nào đã đối chiếu làm vậy, và cấu hình như thế vốn đã cho đổi body mà chữ ký vẫn đúng.

## ADR-205 — Bắt tay khai báo được (5 kiểu); hub không tự gọi URL lấy từ request (SSRF); GET chỉ cho bắt tay; `rejectStatus` không bao giờ là 2xx (PK4, 2026-10-14)

**Vấn đề:** Slack, Meta, Dropbox, Twitch, Zoom, SNS… gửi một request kiểm tra lúc dev dán URL và đòi trả lời đúng khuôn — hub trả 401 thì provider không cho lưu URL, dev kẹt ngay bước một (S7, nghiên cứu §1: 6 biến thể). Meta/Dropbox/WebSub bắt tay bằng GET mà `/hooks` chỉ có POST (F5). MoMo đòi 204; KiotViet ngừng gửi khi gặp 4xx; Haravan/Shopify xoá subscription sau nhiều lần lỗi — ack cố định 200/401 không đủ (F6). Mỗi lối mở thêm đều là bề mặt tấn công: echo phản chiếu nội dung, `hmac-echo` thành máy ký hộ (review N3), SubscribeURL là SSRF, 2xx khi sai chữ ký là lối vòng qua EG2.
**Chọn:**
- `verificationConfig.handshake` (GenericAdapter, kiểm ở `validateGenericConfig`, khoá lạ → 422): `query-echo` (GET `?<param>`, tuỳ chọn `verifyTokenParam` so `timingSafeEqual` với `verifyTokenEnc`), `body-echo` (`when` = `{field, equals}` HOẶC `{header, equals}` — E16, echo một trường cấp một), `header-echo` (trả lại đúng header, header được che khi lưu), `hmac-echo` (Zoom: `{tokenField, tokenParent?, macField}`), `manual-url` (SNS: lưu SubscribeURL vào meta, console hiện link). Không biểu thức.
- `verifyToken` gửi RÕ một lần lúc tạo source; `parseSourceInput` mã hoá AES-GCM (master key) thành `handshake.verifyTokenEnc` (E13) — KHÔNG phải SourceSecret (ingest thử mọi SourceSecret làm khoá HMAC). Client gửi `verifyTokenEnc` → 422; response nguồn thay bằng `verifyTokenSet: true`. Ingest mở bằng `AdapterContext.openSealed` (lõi cài, không đọc config); giải mã hỏng → từ chối.
- Thứ tự ingest (E9): 2h — sau QT3 + `checkPair`, TRƯỚC verify — `adapter.handshake(…, 'before-verify')` cho query/body/header-echo + manual-url; 3h — SAU verify qua, trước EG3 — `'after-verify'` cho hmac-echo, ký bằng ĐÚNG secret đã verify request (xoay khoá). Kết quả `respond` → một dòng REJECTED `signature_valid=true` + `__hub_meta.reason='handshake'` qua `storeRejected` (≤4KB, ≤20/phút/source), EG4 outcome REJECTED (không thêm enum, E8); không event, không outbox, không SET NX, không EG3 → **0 lệnh Redis** (`redis-budget.spec`). `reject` (sai verify token) → đúng đường chữ ký sai (rejectStatus + `recordBadSignature`). `invalid` → 400 không ghi DB, không phạt.
- E3: `hmac-echo` chỉ trả lời khi request bắt tay verify QUA theo scheme của source (tài liệu Zoom 2026-10-14: request `endpoint.url_validation` mang `x-zm-signature` + `x-zm-request-timestamp`); `plainToken` khớp `^[A-Za-z0-9_-]{1,128}$` (không `:`/`{`/`.` → không trùng khuôn chuỗi ký sự kiện), sai → 400. Adapter tự verify lại từng secret để chọn khoá — hai khoá độc lập (lõi chỉ gọi sau verify; adapter không ký khi không secret nào verify).
- E27: echo chỉ `^[\x21-\x7E]{1,256}$`, `text/plain; charset=utf-8` + `X-Content-Type-Options: nosniff`; ngoài tập → 400. Trần query 8KB ở ingest → 414.
- GET: `@Get(':provider/:sourceKey')` là method RIÊNG gọi cùng handler (hai decorator route trên một method thì cái sau ghi đè). `ProviderAdapter.acceptsMethod?(method, ctx, req)` — không cài = chỉ POST; GenericAdapter nhận GET CHỈ khi `query-echo` + đúng một tham số `param`. HEAD (Express gửi vào route GET) luôn 405. Ngoài ra 405 `{error:"method_not_allowed"}` đặt TRƯỚC `trace.tenantId`: không ghi DB, không phạt, không vào lưu lượng. Chốt thứ hai: GET không được bắt tay xử lý → 405, không bao giờ tới verify/persist. Hộp phạt (PK0) đã chặn mọi method trước body parser.
- `ack`: `successStatus` 200|202|204, `rejectStatus` 401|403|503 (2xx hay mã lạ → 422 lúc lưu config). `buildAck(result, ctx?)`; lõi KẸP: từ chối chữ ký chỉ nhận 401/403/503 từ adapter (adapter trả 2xx → 401), thành công chỉ 200/202/204, 422 thiếu khoá chống trùng giữ nguyên. 204 → `res.status(204).end()`. 2xx vẫn chỉ sau COMMIT (BB-3).
- `countSignatureBySource` loại `__hub_meta.reason IN ('handshake','not_configured')` — dòng bắt tay không mở/che cảnh báo `source.signature_failing`. Inspect trả `diagnosis {ok:true, reason:'handshake'}` + `handshake {kind, subscribeUrl?}` (ngoại lệ có chủ đích duy nhất của "không trả giá trị"); console hiện "Đã bắt tay với nhà cung cấp ✓", và link SubscribeURL chỉ khi `https://sns.<vùng>.amazonaws.com` (ngoài ra chữ thường + cảnh báo đỏ).
- `adoptSecret` (E20) chỉ có nghĩa ở chế độ thu (PK6, secret ở trạng thái chờ, dev xác nhận). Ở PK4 mọi source đã có secret → `adoptSecret` 422; header-echo không bao giờ ghi SourceSecret. Asana, Notion vẫn pending (chờ PK6).
- Danh mục: slack, twitch sang `entries/` (23 mục). Meta, Dropbox, Zoom hết vướng PK4 nhưng còn vướng khoá chống trùng (không có id sự kiện cấp một/được cam kết); Okta (GET + header + JSON), Graph (validationToken trên POST + clientState trong body), monday (echo JSON) ngoài 5 kiểu; Intercom/Trello đòi HEAD 200 — mâu thuẫn E27, chờ phòng.
- `[PK:T10]`–`[PK:T13]`, `[PK:T35]`.
**Đánh đổi:**
- Bắt tay trước verify (2h) không qua EG3 và không phạt: kẻ biết `sourceKey` ghi được dòng REJECTED `handshake` (trần 20/phút/source, ≤4KB) và nhận lại echo của chính giá trị mình gửi (đã khoá tập ký tự, text/plain + nosniff). Trần thật sự của nhánh này là hộp phạt theo IP + nginx `limit_req`. Chấp nhận: không có nhánh này thì provider không cho lưu URL.
- E21: `rejectStatus: 503` chỉ cứu được tới lần phạt đầu tiên — sau vài chữ ký sai liên tiếp, hộp phạt trả **429** (EG2 giữ nguyên ngữ nghĩa); trước verify còn có 404/413/507. Console nói rõ khi chọn 503. Không thêm `ack.blockedStatus` (đổi ngữ nghĩa EG2 — cần phòng quyết).
- E27 chốt HEAD → 405 nên Intercom/Trello (đòi HEAD 200 khi tạo) chưa nối được; mở HEAD cần quyết định riêng.
- Echo luôn `text/plain`: bên đòi JSON (monday, Okta) không vào được tới khi có ADR thêm khuôn trả lời.
- Một ngoại lệ "trả giá trị" trong inspect (SubscribeURL, chứa token xác nhận của SNS) — chỉ thành viên project thấy, hub không bao giờ gọi nó.

**Bổ sung (review PK4, 2026-10-14 — phòng quyết lệch §16):**
- **Kiểu thứ sáu `{kind: 'head-ok'}` — sửa E27 cho HEAD.** Vấn đề: Intercom (và Trello) kiểm URL bằng HEAD lúc tạo, đòi 200; E27 trả 405 nên không nối được. Chọn: source khai `head-ok` thì `acceptsMethod('HEAD')` = true; HEAD vẫn qua hộp phạt (trước body parser), `checkIp`, PK0, QT3, `checkPair`, rồi lõi trả **200 rỗng** ngay — không giải mã secret, không verify, không ghi DB, không phạt, 0 Redis, không vào lưu lượng/trace (metric `HEAD_OK`). Source không khai → 405 như cũ. Lõi bỏ chốt `method === 'HEAD'` riêng; HEAD vẫn không bao giờ tới verify/persist (trả trước bước 2h). Đánh đổi: thêm một bề mặt cho người biết `sourceKey` (chỉ xác nhận URL tồn tại — đã lộ qua 401 của POST), không phản chiếu gì. Trello vẫn pending (chữ ký HMAC-SHA1 trên body + URL callback, PK5).
- **`body-echo` `respond: 'json'`** → `application/json` `{<echo.field>: v}` + nosniff, cùng `ECHO_RE`, khoá JSON là tên trường đã khai (không phản chiếu cấu trúc tuỳ ý). monday vẫn pending: body bắt tay chỉ có `challenge` (không có cặp `when` hằng), phần lớn request không ký (PK5). Okta (GET + header, JSON) và Graph (POST `?validationToken`) giữ pending — mở thêm bề mặt GET cần ADR riêng khi có người dùng thật.
- **`afterVerify: true`** (body-echo, manual-url; review T-1): bắt tay chỉ trả lời ở pha 3h (sau verify qua, trước EG3, 0 Redis) — cho provider KÝ request bắt tay. Bật cho slack, twitch trong danh mục. Không ký → đường chữ ký sai (rejectStatus + phạt), không echo, không dòng handshake. Console hiện `TopicArn` của SubscribeURL. **PK5 aws-sns phải ghim `TopicArn` theo cấu hình source** khi verify RSA (link `ConfirmSubscription` thật của topic người khác vẫn qua kiểm tên miền).
- **TB-2 — bắt tay không nuốt sự kiện thật:** `validateGenericConfig` trả 422 khi header của `header-echo` hoặc `when.header` là header mọi sự kiện của config mang (chữ ký, `signature.headers`, timestamp, `idHeader`, khoá chống trùng, bộ `webhook-*`/`svix-*`, `authorization` của basic) hoặc header chung (`COMMON_REQUEST_HEADERS`, tiền tố `accept-`/`x-forwarded-`/`cf-`); khi `when.field` = trường chống trùng. Ingest: `header-echo` không áp khi request mang chữ ký của config (`extractSignature` ≠ null) — request đó đi verify như sự kiện.
- **T-2:** dòng bắt tay chỉ lưu meta (`body = {}`, `body_raw` rỗng, `bodyOmitted`, SubscribeURL ≤ 1024 ký tự) với trần riêng **5 dòng/phút/source** (vượt vẫn trả lời, không ghi). Trần 20/phút của đường ký sai không bị bắt tay tiêu.
- **T-3:** gate `sig-compare` phủ `libs/providers/src` + `apps/hub-api/src/modules/ingest`, bắt `===`/`!==` trên định danh chứa từ signature|sig|hmac|digest|token|secret|expected|presented (tách camelCase), bỏ qua so với hằng và tên trường config (`…Field`, `…Param`, `…Header`…). Bỏ hằng `AFTER_VERIFY_KIND` (né gate). Hai ngoại lệ có lý do: so TÊN khoá kv (`kv.sig`).
- **T-4:** Twitch `toleranceSec` 600 (dev.twitch.tv/docs/eventsub: "isn't older than 10 minutes", đọc 2026-10-14).
- Mã lỗi `/hooks` vào catalog DX1 + `docs/ERRORS.md`: `method_not_allowed` (405), `handshake_invalid` (400), `uri_too_long` (414; body 414 đổi từ câu tiếng Việt sang `{error:"uri_too_long", message}`).
- Danh mục: intercom sang `entries/` (head-ok, HMAC-SHA1 `sha1=`, khoá `id`; tài liệu chưa nói `id` giữ nguyên khi gửi lại — cùng rủi ro slack/typeform) → 24 mục / 67 pending.

## ADR-208 — Danh mục provider là dữ liệu; `identify()` chạy ở trình duyệt; đoán tên kèm bằng chứng (PK9, 2026-10-14)

**Vấn đề:** dev thấy tên provider của mình thì yên tâm, nên danh mục phải lớn (nghiên cứu có 91 bên, mỗi bên kèm nguồn). Có ba cách làm hỏng việc này. (1) Viết mỗi bên một nhánh code: phá luận điểm "provider thứ 100 không sửa lõi". (2) Gửi mẫu dev dán (có thể chứa secret, PII thật) lên server để nhận diện: bản 1 phải đặt luật "đừng log", tức là đã có thứ để lộ. (3) Đoán bừa tên khi không khớp: dev tin một cái tên sai.
**Chọn:**
- Danh mục là `libs/providers/src/catalog/entries/<id>.json` (fingerprint + `handler` = `config` / `native` / `unsupported`), cộng `fixtures/<id>/*.http` có dòng `# origin`.
- `npm run catalog:build` kiểm từng mục rồi sinh `catalog.data.ts`. `CATALOG` được kiểm lại lúc import: config qua `validateGenericConfig`, native có trong `ProviderRegistry`, unsupported chỉ đường `POST /v1/p/:project/events`, sha1 phải có lý do. Sai thì hub-api không lên.
- Mục độ tin cậy `thấp`, mục có chi tiết "chưa xác minh", và mục cần scheme chưa có (PK4 bắt tay, PK5 `unverified`) nằm ở `entries-pending/` kèm `blockedBy` + lý do, và không được build.
- `identify()` là hàm thuần, không import Node API. Web import qua alias riêng `@hub/providers/catalog` (E28), lấy dữ liệu từ `GET /api/v1/catalog`, rồi chạy ①②③ ngay ở trình duyệt.
- Parse lỏng 7 khuôn body F15, không dựa content-type.
- Luật khớp: đủ mọi required thì là ứng viên; `score = khớp / tổng`; cùng điểm thì mục cụ thể hơn đứng trước; cùng `group` thì trả cả nhóm.
- Không khớp gì thì `guess` lấy tên từ tiền tố header chữ ký, User-Agent và tên miền trong trường URL cấp một, **kèm bằng chứng**. Header chung không sinh tên. Không fuzzy.
- `[PK:T19]` chạy bài A trên mọi fixture, và đỏ khi `catalog.data.ts` lệch `entries/`.
**Đánh đổi:**
- Danh mục nhỏ hơn mục tiêu ~80: **20 mục** (13 config, 4 native, 3 unsupported) và 71 pending. Lý do: phần lớn bên cần PK4/PK5, hoặc có khoá chống trùng / header ghi "chưa xác minh" mà config bắt buộc khoá chống trùng. Nới luật nguồn để đẩy số lên là đổi sự yên tâm lấy một cái tên sai. Mỗi mục pending ghi rõ thiếu gì, nên muốn chuyển sang thì chỉ cần dữ liệu, không cần code.
- Fixture `constructed` không phải request thật: chữ ký là placeholder, body là mẫu tài liệu hoặc chỉ gồm trường tài liệu định nghĩa. Bài A chỉ chứng minh **nhận tên**; bài B (§13, stack LOCAL) mới chứng minh nối được.
- Dữ liệu danh mục nằm trong bundle hub-api (`catalog.data.ts`): thêm mục phải build lại và deploy. Bù lại không đọc đĩa lúc chạy và không có đường nạp dữ liệu chưa kiểm.
- Client tải toàn bộ danh mục (vài chục KB): rẻ hơn mọi phương án gửi mẫu lên server.

**Bổ sung (review PK9, 2026-10-14):** (a) TB-1: `identify` chỉ xét 64 KB đầu và đọc thẻ gốc XML bằng một lượt quét `indexOf` — ba `replace` cũ bậc hai (256 KB `<!<!…` = 28 s), mà server (PK6 ④) sẽ gọi cùng hàm trên body người ngoài gửi. (b) Tên miền trong body **không còn sinh tên** (URL `return_url` của chính shop thành "Myshop"); chỉ là bằng chứng phụ khi trùng tên đoán từ header/UA. UA thư viện HTTP so trên chuỗi nguyên; từ chung (client, payload, custom…) không thành tên; tên > 40 ký tự bỏ. (c) GitLab mặc định **static-token** + `Idempotency-Key` (≥ 17.4), Standard Webhooks là phương án phụ (signing token chỉ có từ 19.0) — đánh đổi: mặc định yếu hơn (token tĩnh không phủ body) để không 401 mãi trên bản self-managed phổ biến; ngưỡng phiên bản hiện ở `docsVersion`/note. (d) Shopify chống trùng theo `X-Shopify-Webhook-Id` (khuyến nghị chính chủ), không theo Event-Id. (e) Bài A trượt khi mục ngoài nhóm hoà điểm cao nhất.

## ADR-210 — Src phía server chỉ import barrel `@hub/<lib>`, không subpath; gate `server-lib-subpath` (PK9 hotfix, 2026-10-14)

**Vấn đề:** fa1874c import `@hub/providers/catalog/catalog` trong hub-api. tsc (tsconfig `paths`) và jest (`moduleNameMapper`) resolve được nên test xanh. Node lúc chạy thì không: `node_modules/@hub/providers` là symlink tới gốc package (không phải `dist/`), package không khai `exports`, nên subpath trỏ vào `libs/providers/catalog/catalog` không tồn tại → `MODULE_NOT_FOUND`, hub-api không khởi động trong Docker, CI e2e đỏ.
**Chọn:** (1) Barrel `@hub/providers` export `catalog/catalog` (`CATALOG`, `validateCatalog`…) + kiểu `CatalogEntry`; hub-api import từ barrel. Web giữ alias Next `@hub/providers/catalog` (E28, không kéo barrel Node). (2) Gate `server-lib-subpath` (`verify/lib/gates.ts`): mọi file src ở `apps/*` (trừ `apps/web`) và `libs/*` cấm `from`/`require`/`import()` chuỗi `@hub/<lib>/…`. (3) Bằng chứng: build từng workspace như Dockerfile rồi `require` mọi `.js` trong `dist` của hub-api/hub-worker và chạy `node dist/.../main.js` tới khi Nest nạp xong module (chỉ chết ở kết nối DB).
**Đánh đổi:** hub-worker (và mọi nơi import barrel) giờ cũng chạy `validateCatalog` lúc nạp — vài ms, và danh mục hỏng làm worker cũng không lên (chấp nhận: catalog đã được `[PK:T19]` + `catalog:build --check` chặn trước). Không chọn khai `exports` trong package.json: đổi cách resolve của mọi import `@hub/providers` (jest/tsc `moduleResolution: node` bỏ qua `exports`, lệch hành vi giữa test và runtime — đúng loại lỗi đang sửa). Gate chỉ bắt chuỗi tĩnh; test spec ở `apps/*/test` ngoài phạm vi vì chạy qua jest.

## ADR-206 — "Đích tự kiểm" (scheme `unverified`) với bốn khoá; thay `PresetHandler` của bản 1 — không có interface xử lý thứ hai (PK5, 2026-10-14)

**Vấn đề:** 26/91 bên (MoMo, Twilio, Square, PayPal, SendGrid, AWS SNS, GHN, GHTK…) ký theo kiểu hub không verify được bằng config: ghép trường đã parse (S5), ký cả URL (S6), khoá bất đối xứng / verify qua API (S8), hoặc không ký (S9). Bản 1 định viết `PresetHandler` cho từng bên — một interface thứ hai giống hệt `ProviderAdapter`, phá luận điểm "thêm provider = một adapter". Nhận không verify lại là chỗ DUY NHẤT hub nhận sự kiện chưa xác thực: lộ `sourceKey` (log, screenshot) là ai cũng bơm được.
**Chọn:** như Hookdeck — hub nhận nhờ URL bí mật, giữ nguyên bytes, giao đi kèm header chữ ký gốc (+ URL gốc khi cần); đích tự verify bằng SDK của provider (`@hub/sdk` `unwrapUnverified(event) → {rawBody, headers, url}`). Bốn khoá, thiếu một là bug:
1. **Project tự bật** — `projects.allow_unverified_sources` (mặc định false), chỉ owner (`manage:project`, `PUT /api/v1/projects/:id/unverified-sources`, audit `project.unverified_sources_changed`). Ingest nạp cờ CÙNG câu với source (`LEFT JOIN projects`, +0 lượt DB) và chuyển qua `AdapterContext.projectFlags` — lõi không đọc. Cờ tắt → `rejectStatus` (`source_unverified_disabled`), KHÔNG lưu mẫu REJECTED, KHÔNG `recordBadSignature`, không vào lưu lượng, metric INVALID (E14).
2. **Đánh dấu ở tầng raw** — `ProviderAdapter.verify` được trả `boolean | {ok:true, verified} | {ok:false, refusal}` (mọi chỗ gọi đi qua `verdictOf`; boolean cũ = `{ok, verified:true}`). `persistAccepted(…, {verified})` ghi `raw_events.verified=false`; `signature_valid` vẫn true ("không sai chữ ký" — không mở `source.signature_failing`). Normalize CHÉP `raw_events.verified` → `events.verified`, không suy từ config (đổi config sang hmac rồi renormalize raw cũ vẫn `false`, E5). Phong bì `toWebhookBody` luôn có `"verified"`; Telegram/Discord tiền tố "[Chưa xác thực]"; console gắn nhãn ở danh sách sự kiện.
3. **Không giả được kiểu chuẩn** — `eventType` của `unverified` không được `isReservedType` (payment.*, repo.*, hub.*, E24): 422 lúc lưu; worker kiểm lần hai — raw chưa xác thực mà ra kiểu chuẩn là lỗi normalize VĨNH VIỄN (DLQ, 0 event, 0 delivery).
4. **Đích tự đồng ý** — `subscriptions.accept_unverified` (mặc định false; tick ở console subscription/endpoint). Router bỏ subscription không có cờ (metric `hub_unverified_skipped_total`). Phủ cả polling (E4): `/v1/p/:project/events` lọc `AND e.verified` trừ `?includeUnverified=true` + scope mới `read:unverified` (chỉ bó owner; key chỉ người có scope đó cấp được — developer 403; xin mà thiếu scope → 403, không lọc im lặng); `hub listen` tự xin khi key có scope và in nhãn `[unverified]`; replay đơn kiểm lại cờ LÚC replay (409 `unverified_not_accepted`), replay hàng loạt loại khỏi tập (`destination_unavailable`).
- Khuôn: `{scheme:'unverified', forwardHeaders?[≤10, cấm authorization/proxy-authorization/cookie/set-cookie/x-api-key/x-hub-*], forwardUrl?, idempotency?, eventType, handshake?, ack?}` — không secret (E14: `parseSourceInput` 422 nếu gửi), không mapping, không hmac-echo / afterVerify. `data` khuôn cố định `{raw: base64, contentType, headers, url?, method}`.
- E6/E18: `url` CHỈ khi `forwardUrl` — lõi dựng lúc nhận bằng `publicIngestBase` (HUB_PUBLIC_URL, cùng hàm "Kết nối provider", tách sang `public-ingest-base.ts`) + path + query gốc, không từ `Host`; adapter khai qua hook mới `storedMeta` → `headers.__hub_meta.url`; worker chỉ đọc lại. Hub không có URL công khai → `url: null`.
- E7: khoá chống trùng LUÔN ghép `bodyHashKey(rawBody)` (`generic:<id>:<hash>` hoặc `generic:<hash>`) — chỉ bản trùng đúng từng byte mới là trùng.
- E17: body > 45KB → 413 `unverified_body_too_large` (kèm `fix`), không lưu, không phạt — base64 ×4/3 + phong bì phải lọt `SEND_MAX_BYTES` 64KB.
- Ngân sách Redis không đổi: nhận 3 lệnh như mọi nguồn; từ chối (cờ tắt / 413) 0 lệnh; normalize bỏ subscription trong bộ nhớ (`redis-budget.spec` `[PK:T14] (phần e)`).
- Danh mục: momo (ack 204, khoá `transId`), twilio (`forwardHeaders: x-twilio-signature`, `forwardUrl`) sang `entries/`; aws-sns giữ pending (chưa ghim được TopicArn theo cấu hình).
**Đánh đổi:**
- Kẻ biết `sourceKey` vẫn tiêu được EG3 (mọi request "ký đúng") và hạn mức dung lượng của source; E7 chặn việc NUỐT sự kiện thật (body giả cùng `transId` không làm bản thật thành DUPLICATE) nhưng đích nhận cả bản giả — đích phải verify trước khi tin, và chống trùng nghiệp vụ theo id provider SAU khi verify. Chuyện đó nói rõ ở console, SDK và nhãn.
- Dung lượng ≈ 2,33× body (`body_raw` + `data.raw` base64, E26) — console ghi rõ.
- `forwardUrl` phát `sourceKey` (bí mật duy nhất của nguồn) tới mọi đích/polling/`delivery_attempts` — chỉ bật cho bên ký cả URL (S6), console cảnh báo.
- Trần 45KB loại các bên gửi lô lớn (mảng SendGrid nhiều sự kiện) — không nâng `SEND_MAX_BYTES` trong đợt này.
- `[PK:T14]`–`[PK:T18]`, `[PK:T36]`–`[PK:T38]`.

**Bổ sung (review PK5, 2026-10-14):** (a) TB-1 — khoá 2 phủ hết console: chặng "Xác thực" của hành trình có raw `verified=false` là `warning` "Chưa xác thực — đích tự kiểm chữ ký" (lý do `unverified_source`), không bao giờ "hợp lệ"/xanh; Lắng nghe có lý do chẩn đoán `unverified` (không rơi về `ok`), dòng kết nối màu hổ phách; chặng định tuyến có lý do `unverified_not_accepted`; nhãn "Chưa xác thực" ở danh sách hành trình, trang chi tiết, xem nhanh, bảng sự kiện, lượt giao và DLQ. (b) T-1 — project tắt cờ thì `handshake()` của nguồn `unverified` trả null → lõi đi verify → `source_unverified_disabled`: bắt tay bị từ chối như sự kiện (không trả lời, không ghi dòng). Đánh đổi: bật cờ SAU khi dán URL thì phải bấm đăng ký lại ở phía provider. (c) T-2 — `markGood` ("cặp tốt") chỉ khi chữ ký được kiểm thật (`verdict.verified`); request `unverified` không nâng ngưỡng phạt của cặp. (d) T-3 — ngoài trần 45KB body, phong bì ước lượng (`estimateUnverifiedEnvelopeBytes`: base64 + `data.url` khi `forwardUrl` + header gửi kèm + 1KB cố định, không bao giờ thấp hơn `toWebhookBody` thật) phải ≤ 64KB, vượt → 413 cùng mã `unverified_body_too_large`. Đánh đổi: body gần 45KB kèm query dài bị từ chối dù trước đó được nhận (rồi DEAD mãi). (e) T-6 — cờ project là cổng NHẬN, không phải cổng giao: raw đã ACCEPTED trước khi tắt cờ vẫn được normalize và giao tới subscription `acceptUnverified`. Bỏ tick `acceptUnverified` không dừng retry đang chạy (delivery consumer không kiểm lại cờ lúc gửi — cùng cách xử lý với `isActive`); chỉ replay kiểm lại. (f) T-7 — replay hàng loạt bỏ qua với lý do riêng `unverified_not_accepted` (thay `destination_unavailable`: người dùng đi bật cờ subscription, không đi kiểm đích). (g) T-4 — **rollback về bản trước PK5** (`2b38a8d`): polling cũ không lọc `verified` và phong bì/polling cũ không có trường `verified`, nên mọi key `read:events` sẽ poll thấy các event chưa xác thực đã có mà KHÔNG phân biệt được. Trước rollback: tắt cờ "Nhận nguồn chưa xác thực" của mọi project, rồi hoặc chặn polling của project có event `verified=false`, hoặc chấp nhận rủi ro (ghi vào biên bản rollback). (h) T-9 — trang Nguồn cảnh báo cạnh nguồn `unverified` khi project chưa bật cờ (request bị từ chối không vào lưu lượng / Lắng nghe), không ghi DB.

## ADR-207 — S10 không nối: hub không trả lời nghiệp vụ thay shop (PK5/§8.3, 2026-10-14)

**Vấn đề:** VNPay, ZaloPay, OnePay, Discord (interaction), Adobe Commerce đòi bên nhận trả lời NGHIỆP VỤ đồng bộ: xác nhận đơn tồn tại, đúng số tiền (`RspCode`, `return_code`), hoặc trả interaction response. `unverified` không cứu được: hub vẫn chỉ trả ack chung.
**Chọn:** mục danh mục `unsupported` với `reason` + `workaround` "shop nhận IPN trực tiếp, xác nhận đơn, rồi đẩy `payment.received` vào hub qua `POST /v1/p/:project/events`" (E22). Console hiện tên, lý do, cách đi vòng; không có nút tạo source. Twilio voice/SMS muốn trả TwiML đồng bộ cũng thuộc nhóm này (mục twilio ghi rõ: hub chỉ trả 200 rỗng).
**Đánh đổi:** dev phải viết điểm nhận riêng cho các bên S10. Trả "00 Confirm Success" thay shop là nói dối provider và phá BB-1 (hub không biết "đơn hàng") — không làm.

## ADR-230 — Chống trùng theo id lồng (`idempotency.path`) và theo băm nội dung (`idempotency.bodyHash`) cho nguồn generic (PK10/E31, 2026-10-14)

**Số ADR:** PK giữ 201–210 (209 dành cho PK6/E8, chưa ghi). SPEC-hub-sap giữ "từ ADR-211" không nêu trần và đã nhắc tới ADR-220, nên lấy 230 để không đụng dải đang mở của hub-sap.
**Dải số PK đã dùng (review PK10 T-d):** **201–210 và 230**. 211–229 để trống cho hub-sap. Số PK kế tiếp lấy từ 231, grep trước khi ghi.
**Vấn đề:** `validateGenericConfig` chỉ nhận khoá `{header}` hoặc `{field}` cấp một. Bên có id nằm lồng (Heroku `webhook_metadata.event.id`, Pipedrive `meta.id`) hoặc không có id thì không nạp được (REVIEW-PK9 §2). Dev buộc phải bỏ provider đó, vì khoá ngẫu nhiên bị cấm (BB-2: gửi lại sẽ thành 2 sự kiện).
**Chọn:**
- **`{path: "a.b.c"}`:** 1–3 cấp, mỗi cấp `^[A-Za-z0-9_-]{1,64}$`. Cấm `__proto__` / `prototype` / `constructor`. Không biểu thức, không chỉ số mảng (§15).
  - Đọc chỉ thuộc tính riêng của object thường.
  - Khoá là `generic:<giá trị>`.
  - Thiếu giá trị thì dùng `generic:body:<bodyHashKey(rawBody)>`.
- **`{bodyHash: true}`:** khoá là `generic:body:<bodyHashKey(rawBody)>`. Tiền tố `body:` để khoá không bao giờ trùng với id thật của provider.
  - Body rỗng (cả khi `path` phải rơi về băm) bị REJECTED, `signature_valid=true`, trả 422 `empty_body` kèm `fix`.
  - Chẩn đoán "Lắng nghe" trả `empty_body`.
  - `standard-webhooks` không nhận `bodyHash` (luôn có `webhook-id` đã ký).
  - `unverified` + `bodyHash` hành xử như bỏ trống (E7 giữ nguyên, kể cả body rỗng).
- **Lõi ingest không đổi luồng.** Chỉ trả `err.code` của lỗi chung `IdempotencyKeyMissingError`, có lớp con `EmptyBodyIdempotencyError`. Không có `if provider`.
- **Danh mục:**
  - Mục dùng `bodyHash` bắt buộc có `bodyHashReason` trích URL nằm trong `sources`.
  - Không được dùng `bodyHash` khi body luôn rỗng.
  - Đợt này nạp 5 mục sau khi WebFetch tài liệu chính thức: heroku (path), pipedrive (path, Basic), circleci / squarespace / checkout-com (field `id` đã xác minh).
  - 10 mục còn lại giữ pending kèm lý do. Không mục nào đạt điều kiện `bodyHash`, vì không tài liệu nào xác nhận gửi lại giữ nguyên body. Docusign, Pipedrive, Heroku, Coinbase còn có trường đổi theo lần gửi.
- **Console:** form có bốn kiểu khoá. Chọn "băm nội dung" thì hiện câu đánh đổi. Luật `path` của form là bản sao của server, test đối chiếu.
**Đánh đổi:**
- `bodyHash`: gửi lại mà đổi một byte (timestamp, số lần thử trong body) sẽ thành sự kiện mới. Vì vậy chỉ dùng khi tài liệu xác nhận body giữ nguyên, và ưu tiên id khi có.
- Với scheme chỉ ký body (S1), `bodyHash` lại mạnh hơn header id không được ký (T-e).
- Với `static-token`, body không được ký: ai có token thì giả được mọi thứ, nhưng khoá vẫn tất định.
- `path` thiếu giá trị rơi về băm body thay vì 422. Đổi lại, bản ghi sai khuôn của provider vẫn vào luồng (chống trùng theo bytes) thay vì kẹt 422 mãi.
- Tài liệu Heroku / Pipedrive / Checkout không nói rõ id giữ nguyên khi gửi lại. Điều này được ghi ở `docsVersion` của từng mục.
**Bổ sung sau review (REVIEW-PK10, 2026-10-14):**
- **Pipedrive chỉ cho webhook v2.**
  - Vấn đề: ở v1, `meta.id` là id ĐỐI TƯỢNG. Lần cập nhật thứ hai của cùng deal bị báo DUPLICATE, nên sự kiện mất vĩnh viễn.
  - Chọn: fingerprint đòi `data` cấp một — khoá chỉ v2 có (v1 dùng `current`; `identify` chỉ đọc khoá cấp một). Nhãn field và `docsVersion` ghi "CHỈ webhook v2; v1 hãy tạo lại webhook v2". Có test: body v1 không khớp mục.
  - Đánh đổi: dev vẫn chọn tay mục này cho webhook v1 được; chỉ có cảnh báo chặn.
- **`path` không nhận cấp toàn số** (`items.0.id`), ở cả server lẫn form. Lý do: lúc đọc không đi qua mảng, nên cấu hình kiểu này sẽ âm thầm rơi về băm body.
- **`path` trỏ vào object / mảng / boolean:**
  - Vẫn rơi về băm body như trước.
  - Thêm log warn có nhịp: một dòng mỗi nguồn mỗi 30s, `LogThrottle` dời về `@hub/common`, 0 lệnh Redis.
  - "Lắng nghe" chẩn đoán `idempotency_path_not_scalar`, chỉ kèm TÊN path.
- **Id dạng số ngoài `Number.isSafeInteger`** (cả `path` lẫn `field`):
  - Đọc lại đúng chữ số từ bytes gốc (reviver `JSON.parse` có `source`, Node 22), chỉ ở nhánh hiếm này.
  - Không đọc được thì `path` rơi về băm body, `field` giữ cách cũ.
  - Đánh đổi: source có id số lớn đổi khoá một lần, từ dạng đã làm tròn sang dạng đúng. Sự kiện đang được gửi lại qua lúc deploy có thể vào hai lần (nhận trùng, không mất).
- **Đổi kiểu khoá của nguồn đang chạy** từ `field`/`path` sang `bodyHash`: dải khoá khác, nên sự kiện đang được gửi lại có thể vào hai lần (nhận trùng, không mất). Chấp nhận.
- **`empty_body`** vào catalog lỗi và `docs/ERRORS.md`. `EMPTY_BODY_FIX` của adapter lấy từ catalog (một nguồn câu).

## ADR-211 — Tách `HUB_INGEST_PUBLIC_URL` (URL provider gọi vào) khỏi `HUB_PUBLIC_URL` (API, console) (SPEC-hub-sap §9 + H4, `[LH:T17]`, 2026-10-14)

**Vấn đề:** Một biến `HUB_PUBLIC_URL` dùng cho cả API/connection string lẫn URL ingest (F9: `projects.controller.ts`, `source-connection.service.ts`, `stripe.connector.ts`; H4 thêm `publicHooksUrl()` và `public-ingest-base.ts` do PK5 đưa vào, dùng cho `unverified` + `forwardUrl` và provider ký trên URL như Twilio). URL hiện thuộc domain Render (`*.onrender.com`), Cloudflare không đứng trước được domain mình không sở hữu, nên muốn lưới hứng (U-A `workers.dev` + U-C chạy song song, ADR-220) thì URL ingest phải đổi một lần sang domain khác — trong khi API và connection string vẫn ở Render. Không tách thì đổi URL ingest kéo theo đổi host trong mọi connection string đã phát cho service.
**Chọn:** biến mới `HUB_INGEST_PUBLIC_URL`; thiếu/rỗng → rơi về `HUB_PUBLIC_URL` y như cũ (tương thích ngược tuyệt đối). Một hàm duy nhất `publicIngestBase()` (`public-ingest-base.ts`) trả base ingest cho mọi chỗ: đăng ký PayOS/Stripe, so DRIFTED `public_url_changed`, `publicHooksUrl()`, `ingestUrl` console hiện cho dev copy (`sourceIngestUrl`). Connection string / API / seed giữ `HUB_PUBLIC_URL`. Lỗi `public_url_required` và lời nhắc DRIFTED gọi đúng tên biến đang có hiệu lực (`ingestPublicUrlVar`). Có đặt mà không công khai (localhost/IP nội bộ) → 422, KHÔNG rơi về `HUB_PUBLIC_URL`.
**Đánh đổi:** đổi `HUB_INGEST_PUBLIC_URL` thì mọi kết nối PayOS/Stripe báo DRIFTED và phải bấm "Kết nối lại"; GitHub/SePay/generic đổi tay (cơ chế F8 có sẵn). Tới khi LH3 xong, `publicHooksUrl()` dùng base ingest cho MỌI request kể cả request đi thẳng Render (H4 chỉ đúng sau LH3: có chữ ký lưới → base lưới, không có → `HUB_PUBLIC_URL`); vì vậy chưa đặt biến này trên Render trước khi LH3 lên. Móc LH3 nằm ở `publicIngestBase` — một chỗ. Không rơi về khi biến mới sai: chọn lộ cấu hình sai thay vì âm thầm đăng ký URL Render cho source mới.

## ADR-217 — Header lưới hứng có HMAC hai lớp; `receivedAt` của Worker làm "bây giờ" khi verify; IP cho hộp phạt lấy từ header đã ký (LH3, SPEC-hub-sap §5 + H3/H4/H5, `[LH:T11]`–`[LH:T13]`, `[LH:T19]`, `[LH:T20]`, `[LH:T22]`, 2026-10-14)

**Vấn đề:** Phát lại sau 20 phút → Stripe/Standard Webhooks/signed-template trả 401 (cửa sổ ±5 phút): lưới cứu được request rồi hub tự vứt. Mọi request qua Worker mang IP Cloudflare → hộp phạt EG2 và cầu chì EG1 khoá chung cả lưới. Không tin thẳng `CF-Connecting-IP`/XFF (ai gọi Render cũng đặt được; dải Cloudflare quá rộng cho `TRUST_PROXY`, ADR-176), không cho Worker đặt `received_at` không ký (= phát lại sự kiện Stripe cũ). Cổng phạt chạy trước body parser (ADR-177) nên chữ ký có `sha256(body)` không kiểm được ở cổng (H3).
**Chọn:** `CATCHNET_FORWARD_SECRET` (1–2 giá trị ≥ 32 ký tự, `,` để xoay; trống/ngắn = tắt). Chữ ký đầu `v1=HMAC(id.received_at.client_ip.mode.METHOD.target)` kiểm ở cổng phạt → IP đã ký cho mọi kiểm tra hộp phạt; chữ ký body `v1=HMAC(id.hex(sha256(body)))` kiểm sau parser — **chỉ khi khớp** request mới là "qua lưới" ở ingest (IP đã ký cho chấm điểm, `ctx.verifyAt` = `received_at` — Stripe `constructEvent(…, receivedAt)` stripe 22.6.2, NaN fail-closed —, `raw_events.received_at`, `via` forward/replay, URL công khai `HUB_INGEST_PUBLIC_URL`); body lệch = gọi thẳng (lệch H3 có chủ ý: Worker luôn ký body khớp, body lệch là chép chữ ký đầu). Hạn: quá khứ ≤ `CATCHNET_RETENTION_DAYS` (kẹp ≤ `EVENT_RETENTION_DAYS`), tương lai ≤ 5 phút. So bằng `timingSafeCompare`, sai khuôn → bỏ cả bộ header, không 401. `raw_events.headers` bỏ `x-catchnet-*` trừ `x-catchnet-id`. nginx (EG1) không kiểm được chữ ký nên không đọc header lưới; lưới bật → tắt cầu chì + `limit_conn` theo IP của nginx cho `/hooks/*` (DEPLOYMENT §3.6). Test vector cố định `libs/crypto/test/fixtures/catchnet-vectors.json` dùng chung với Worker. Thứ tự §3.1 và idempotency không đổi.
**Đánh đổi:** +≤ 4 HMAC/request có header lưới (0 Redis, 0 DB, `[LH:T11]`). Ai có secret đặt được IP/`received_at` trong hạn — secret chỉ ở hub + Worker. `/hooks/*` mất `limit_conn`/cầu chì theo IP ở nginx khi lưới bật (còn `client_body_timeout`, cổng phạt theo IP đã ký). `received_at` lùi về giờ Worker nên các chỗ đọc coi nó ≈ lúc INSERT lệch: mồ côi (`findOrphanRawEvents`, 120s) có thể nháy khi phát lại hàng loạt, tab Lắng nghe lọc `since` có thể bỏ sót — nợ §16 (đề xuất cột `committed_at DEFAULT now()` cho mồ côi/Lắng nghe).

## ADR-221 — `x-hub-outcome` trên mọi phản hồi cố ý của `/hooks/*`; 429 là `refused` (LH3, SPEC-hub-sap H1, `[LH:T18]` phía hub, `[LH:T21]`, `[LH:T22]`, 2026-10-14)

**Vấn đề:** Source đặt `ack.rejectStatus: 503` khi chữ ký sai (ADR-205); nếu Worker coi mọi 5xx là "hub vắng" thì request chữ ký rác được ghi D1 + 2xx, vòng qua EG2 và làm đầy D1. Status một mình không phân biệt "hub từ chối" với "hub vắng".
**Chọn:** header `x-hub-outcome`: `accepted` · `duplicate` · `handshake` · `rejected` (request sai: chữ ký kể cả 503 `rejectStatus`, 404, 400, 405, 413, 414, 422) · `refused` (chính sách: 429 cổng phạt/rate limit, 507, cờ unverified tắt) · `unavailable` (5xx tạm thời). Đặt ở: `outcomeOf(trace)` → controller; cổng phạt 429; lưới đỡ theo status ở gốc app (trước guard/cổng/parser; OPTIONS bỏ qua); nginx tự sinh trên `/hooks*` (429 refused, 413/404 rejected, 503 unavailable).
**Đánh đổi:** Không phủ được phản hồi Node `clientError` (431/400 trước Express) — luật cho Worker LH2: 408/429 luôn retry (H2); 5xx không outcome hoặc `unavailable` = hub vắng; 4xx không outcome khác 404 = retry có hạn rồi `inbox_dead`; 404 hoặc 4xx `rejected`/`refused` = `inbox_dead`; 507 `refused` khi phát lại nên retry (LH2 quyết). Worker không chuyển header ra provider. Kết quả `ingestWebhook` có thêm trường `outcome`.

## ADR-193 — Chaos BP chạy thật trên `hubv` nhưng KHÔNG vào nightly; đồ nghề "giết Postgres dưới tải" dùng chung ở `verify/lib/chaos.ts` (BP chaos phần b, 2026-10-15)

**Vấn đề:** `[BP:T4]`/`[BP:T16]`/`[BP:T21]` mới có mô phỏng L0/L1. Spec đòi số đo LOCAL thật (C8), nhưng ba kịch bản cần khoảng 35–40 phút, trong khi job nightly có trần 45 phút. Muốn phá "dưới tải" thì cả hai lane phải có hàng thật, mà relay lại nằm trong worker. LH6 sẽ cần đúng các thao tác này.
**Chọn:** `verify/scenarios/chaos-bp.ts` gắn tag `chaos-bp`, không gắn `chaos`; chạy tay bằng `npm run verify:chaos:bp`. Đồ nghề dùng chung đặt ở `verify/lib/chaos.ts` và chaos-l3 cũng dùng: `holdDown`, `preloadBacklog` (dừng worker → bắn N → bật lại → phá khi AMQP thấy READY ở cả hai lane), `MetricsSampler`, sổ cái Postgres, sink `PUT /_mode`. Mọi lệnh đi qua `docker compose -p hubv`. Kết quả ghi ở `CHAOS-BP-KET-QUA.md`.
**Đánh đổi:** không có lưới nightly cho ba kịch bản này, hồi quy chỉ bị bắt khi có người chạy tay (L0/L1 phần a vẫn chạy mỗi push). "Lần chạm DB" đếm bằng bộ đếm lỗi của lane: bộ đếm tăng lúc lỗi chứ không phải lúc bắt đầu, nên cửa sổ dò tính từ mốc factor = 1 cộng 6 s. Cách đếm này không gồm truy vấn của scheduler (§7.5).

## ADR-194 — `P2010` bọc SQLSTATE mất kết nối (57P0x, lớp 08) là lỗi hạ tầng `transient` (chaos `[BP:T4]` phần b, 2026-10-15)

**Vấn đề:** chaos `[BP:T4]` phần b (giết Postgres giữa transaction) cho `$executeRaw` ném `PrismaClientKnownRequestError` **P2010** "Raw query failed. Code: `57P01`". `classifyInfraError` trả `unknown` cho mọi mã Prisma ngoài bảng — bảng 57P0x/lớp 08 của BP5 (C12) chỉ xét `UnknownRequestError` và lỗi driver — nên normalize coi là lỗi dữ liệu → `q.normalize.dlq` ngay lượt 0 (1/2000 event kẹt, phải renormalize tay), delivery đi nhánh `unknown` (hoãn 1 phút, 5 lần → DLQ).
**Chọn:** P2010 có `meta.code` dạng SQLSTATE (`/^[0-9A-Z]{5}$/`) thì quyết **chỉ** theo nó: 57P01/57P02/57P03 hoặc lớp 08 → `transient`, mọi mã khác → `unknown`/`permanent`. Chỉ khi thiếu `meta.code` mới dò câu lỗi, và dò theo mẫu có neo đúng khuôn engine Prisma ghi: ``Code: `(57P0[123]|08\d{3})` `` (review TB-1). Lý do: câu lỗi của lỗi dữ liệu có thể chứa "08006" trong giá trị của người dùng, và nếu xếp nhầm thành transient thì delivery lặp mãi vì nhánh transient không có trần. Chỉ sửa một chỗ trong `classifyInfraError`; normalize, delivery và bộ điều khiển `db` đổi theo.
**Đánh đổi:** cách này dựa vào `meta.code` và khuôn câu lỗi của Prisma 6. Nếu bản Prisma sau đổi khuôn thì lỗi sẽ quay về `unknown`. Test L1 `apps/hub-worker/test/infra-errors-db.spec.ts` (Postgres thật: `pg_terminate_backend(pg_backend_pid())` trong `$executeRaw` → `transient`; `'08006'::uuid` → `unknown`) sẽ đỏ ở `verify:db` khi chuyện đó xảy ra. Test L0 chỉ dùng lỗi dựng tay nên không bắt được việc đổi khuôn.

## ADR-231 — Warn "Lỗi tạm ở normalize" gộp tối đa 1 dòng / 30s / tiến trình (thuộc BP, F2 của chaos `[BP:T4]` phần b; số BP 193/194 đã hết nên lấy số kế tiếp còn trống của dải PK, 2026-10-15)

**Vấn đề:** chaos `[BP:T4]` phần b đo được 225 dòng warn/s. Khi Postgres vừa chết, factor vẫn còn 0 cho tới nhịp tick đầu tiên (khoảng 1 s), nên toàn bộ prefetch normalize lỗi cùng lúc và mỗi message ghi một dòng warn: 293 dòng trong khoảng 1 s. Delivery đã có `LogThrottle` từ BP1, normalize thì chưa.
**Chọn:** nhánh transient của normalize dùng `LogThrottle` riêng cho mỗi consumer, tức mỗi tiến trình: tối đa 1 dòng warn mỗi 30 s, kèm `suppressedSinceLastLog`. Từng message vẫn ghi dòng debug (có `rawEventId`). Nhánh DLQ (`log.error`) và nhánh "hoãn quá NORMALIZE_MAX_DEFER_MS" giữ nguyên, không gộp. Metric `hub_normalize_retries_total` vẫn đếm đủ. Có test L0 cho đợt đầu khi factor = 0.
**Đánh đổi:** một lỗi tạm lẻ tẻ của message cụ thể chỉ hiện ở mức warn nếu rơi đúng vào khe 30 s; muốn truy `rawEventId` thì phải bật debug. Đây là cùng đánh đổi mà delivery đã chấp nhận ở ADR-195.

## ADR-232 — Khoá `:ramp` sống thêm một bậc và kẹp ở trần cuối (thuộc BP, F3 của chaos `[BP:T16]` phần b; số kế tiếp còn trống của dải 230+, 2026-10-15)

**Vấn đề:** chaos `[BP:T16]` phần b đo được 60 s ramp chỉ xả 256/500 delivery, vì hàng về theo nhịp `retry.10s` và mỗi bậc chỉ dùng được khoảng 2 giây có trần. Khoá `:ramp` hết hạn thì 243 delivery còn lại dội vào đích với 123 và 120 rps, gần gấp đôi trần cuối 64. Đích chỉ chịu được khoảng 64 rps thì có thể sập lại ngay sau khi vừa hồi phục.
**Chọn:** (Admin chọn hướng b) `LUA_CLOSE_AND_RAMP` đặt TTL `:ramp` = `seconds + stepSeconds` (70 s), và `LUA_GATE` kẹp bậc ở `ceil(seconds/step) − 1`, nên bậc thêm vẫn giữ 64 rps. Không thêm lệnh Redis nào: chỉ có thêm một ARGV và đổi TTL. `DELIVERY_RAMP_STEP_SECONDS` từ env chỉ được kẹp THẤP hơn mặc định (C2). Cửa sổ retry cộng 6 × 10 s, thành khoảng 7h23m10s. Có test L1 trên Redis thật: 500 message về theo nhịp `retry.10s`, rải 2 giây mỗi vòng như số đo chaos; sau khi khoá hết hạn không giây nào vượt 64.
**Đánh đổi:** cách này chỉ thêm một bậc 64 rps, tức khoảng 128 message nữa với nhịp đo được. Hàng tồn lớn hơn nhiều, hoặc dồn hết vào một giây, vẫn dội về sau 70 s. Muốn chặn hẳn thì phải kéo ramp theo kích thước hàng, việc đó chưa làm. Lệnh dọn `olderThan` dưới khoảng 7h24m bị 400.
**Đo lại (chaos `[BP:T16]` phần b, 2026-10-15, HEAD `9717787`):** cả 70 s không giây nào vượt trần, nhưng tiêu chí "sau ramp ≤ 64/s" **trượt**: 192 delivery còn lại về ở giây +70 và +71 với 43 và **149/s**. Lần chạy này mỗi vòng `retry.10s` dồn vào khoảng 1 giây (giây +60 có 64, giây +61 chỉ 4), nên bậc kẹp chỉ xả thêm 64. Mô hình "rải 2 giây/vòng" của test L1 lạc quan hơn thực tế. Hướng (b) chưa đủ cho 500 hàng tồn; cần Admin quyết hướng tiếp (ramp theo kích thước hàng, hoặc giữ trần cuối tới khi hàng hết).

## ADR-233 — Gate báo "probe đang bị giữ": bên thua probe HALF_OPEN chỉ tốn 1 lệnh; đính chính ADR-196 (thuộc BP, R1, 2026-10-15)

**Vấn đề:** ADR-196 ghi rằng HALF_OPEN không giành được probe thì hoãn với 1 lệnh Redis. Code thực tế tốn 2 lệnh: `LUA_GATE` + `LUA_ACQUIRE_PROBE` thua (`delivery.consumer.ts`, cả gate trước khi nạp lẫn gate sau khi nạp). Mỗi message trong hàng hoãn quay về đúng lúc một worker khác đang dò sẽ đốt thêm 1 lệnh, vi phạm R1 ("đường hoãn ≤ 1 lệnh", ADR-062/196). `DEPLOYMENT.md` cũng viết sai thành "thêm 1 EVAL giành probe nếu thắng".
**Chọn:**
- `LUA_GATE` nhận thêm `KEYS[5]` = `:probe` và trả cờ `probeHeld`. Cờ = 1 chỉ khi đang HALF_OPEN (hết `:open`, `:failures` ≥ ngưỡng) và `:probe` tồn tại.
- Consumer: `probeHeld` → hoãn ngay, không gọi `tryAcquireProbe`. Kết quả là 1 lệnh và 0 truy vấn đọc.
- Probe trống thì vẫn giành bằng `LUA_ACQUIRE_PROBE` riêng (nguyên tử). Giữ đúng C11/ADR-198: không gộp việc giành probe vào gate.
- Test: `redis-budget.spec` `[BP:T22]` (phần d) khoá chuỗi lệnh `['eval']` cho bên thua; Redis thật kiểm cờ (có/không, OPEN không báo).
**Đánh đổi:** vẫn có ca hiếm tốn 2 lệnh. Gate thấy probe trống nhưng worker khác giành mất ngay trước khi mình gọi `LUA_ACQUIRE_PROBE`, tức là tranh nhau đúng khe giữa hai lệnh. Gate đọc thêm một `EXISTS` trong script, nhưng số lệnh client không đổi.

## ADR-214 — Lưới hứng Cloudflare Worker `hub-hooks` + D1, ghi xuyên timeout 4s; BB-3: COMMIT = lần ghi bền đầu tiên; Worker không giữ secret, không verify (LH2, SPEC-hub-sap §4 + H1/H6/H10, `[LH:T4]`–`[LH:T7]`, `[LH:T10]`, `[LH:T18]`, 2026-10-15)

**Vấn đề:** Hub (Render) ngủ/sập thì webhook mất trừ khi provider tự retry; luôn hứng thì mọi sự kiện thêm một nhịp và mọi số k6 phải đo lại; status một mình không tách "hub từ chối" khỏi "hub vắng" (H1).
**Chọn:** Worker `apps/catchnet` (ngoài workspaces, H10) chuyển tiếp `/hooks/*` đã ký (ADR-217); hub vắng (timeout, lỗi mạng, 5xx/2xx không outcome, `unavailable`) mới ghi D1 rồi 2xx, mọi nhánh chưa ghi bền trả 503; trần và ngân sách ở ADR-224, luồng chi tiết ở SPEC §16 "LH2".
**Đánh đổi:** Thêm một chặng Cloudflare → Render; Worker + D1 cùng chết mà provider không retry thì vẫn mất; `CATCHNET_RETENTION_DAYS` phải ≤ `EVENT_RETENTION_DAYS` của hub (provider không ký timestamp có thể được giao lại lần hai nếu raw gốc đã bị dọn — DEPLOYMENT §3.6); **cổng: không deploy Worker thật, không trỏ source nào vào `workers.dev` trước khi LH2b ĐẠT** (sources_sync rỗng = Worker tệ hơn gọi thẳng).

## ADR-215 — Ack "đã nhận" của source khi hub vắng, trả trước khi verify (LH2, SPEC-hub-sap §4.3 + H6, `[LH:T5]`, 2026-10-15)

**Vấn đề:** Hub vắng thì Worker phải trả đúng khuôn provider mong đợi (MoMo 204, VNPay 200 `RspCode 00`, còn lại 200 JSON) mà không giữ secret để verify.
**Chọn:** Hub đẩy `ack_status` (2xx), `ack_type`, `ack_body`, `catch_methods` vào `sources_sync` qua `/_admin/sources/*` (Bearer, constant-time; resync theo trang dọn key cũ); Worker trả nguyên ack đó sau khi ghi D1; GET/HEAD không hứng trừ khi source khai GET (H6). Phía hub đẩy dữ liệu là story **LH2b** (cổng ở ADR-214).
**Đánh đổi:** Request chữ ký sai cũng nhận ack khi hub vắng (VNPay `00` thay `97`), vẫn bị hub từ chối khi phát lại (`inbox_dead` `rejected`); bắt tay trong body (Slack) bị hứng — provider báo xác minh lỗi, dev bấm lại; source chưa sync = 503 khi hub vắng.

## ADR-216 — Worker tự phát lại vào `/hooks/*` bằng Cron, ≤ 10 dòng/phút có lease; hub không có đường ingest thứ hai (LH2, SPEC-hub-sap §4.4 + H2/T-5, `[LH:T8]`, `[LH:T9]`, 2026-10-15)

**Vấn đề:** Hàng trong D1 phải về hub không qua cửa ingest thứ hai và không dội hub vừa thức; 429 `refused` không được thành hàng chết (H2); một lượt cron bị giết không được giữ đầu hàng (REVIEW-LH2 TB-3).
**Chọn:** Cron mỗi phút: chọn ≤ 10 id theo index `next_at` (≤ 2 MB body), lease cả lô +5 phút, nạp + gửi từng dòng (song song 5, dừng khi hub vắng); 408/429/507 → retry trước outcome; accepted/duplicate/handshake → xoá; 404 hoặc rejected/refused → dead; 4xx không outcome retry 3 lần; lùi 1/2/5/10/30 phút, ≥ `Retry-After`; quá hạn giữ → dead `expired`.
**Đánh đổi:** 10/phút: 5.000 dòng ≈ 8,3 giờ (spec cũ 25/phút vượt trần 50 truy vấn D1 của gói free, ADR-224); thứ tự không giữ (ADR-034); dòng bị 429 cổng phạt (IP gốc đang bị phạt) retry tới 7 ngày, giữ chỗ trong trần của key và tốn 1 subrequest/30 phút (REVIEW-LH2 L8); chọn và lease là hai câu (tài liệu D1 không xác nhận `UPDATE … RETURNING`, tra 2026-10-15) nên hai lượt chồng nhau (`__scheduled` bấm tay, lượt > 5 phút) có thể gửi trùng một dòng — `UNIQUE(source_id, idempotency_key)` của Postgres nuốt, hub trả `duplicate` → xoá.

## ADR-222 — Phát lại gặp 507 thì thử lại, không chuyển `inbox_dead` (LH2, ADR-221 để ngỏ, `[LH:T8]`, 2026-10-15)

**Vấn đề:** Hub trả 507 `refused` khi project vượt hạn mức lưu trữ. Coi như `refused` khác (→ dead) thì sự kiện thật bị vứt chỉ vì dung lượng tạm đầy — trong khi cleanup của hub-worker và việc dev nâng hạn mức đều giải phóng được.
**Chọn:** 507 xét cùng nhóm 408/429, TRƯỚC outcome: retry theo lùi dần (tôn trọng `Retry-After`) tới hết hạn giữ, rồi `expired`. Chuyển tiếp (provider gọi lúc hub sống) vẫn trả nguyên 507 cho provider như cũ.
**Đánh đổi:** 507 kéo dài chiếm chỗ trong trần `CATCHNET_MAX_PER_KEY` của source đó tới 7 ngày và đốt một subrequest mỗi 30 phút mỗi dòng; source bị 507 lâu có thể tự làm đầy trần của chính nó (503 cho request mới khi hub vắng) — chấp nhận, vì trần theo key không ảnh hưởng source khác.

## ADR-223 — nginx chỉ nới cầu chì + `limit_conn` của `/hooks/*` cho dải IP Cloudflare (`geo`) khi lưới bật (LH2, REVIEW-LH3-R2 R2-L1, `[LH:T22]`, 2026-10-15)

**Vấn đề:** ADR-217 tắt cầu chì + `limit_conn` theo IP cho `/hooks/*` với MỌI IP khi lưới bật. Source cũ vẫn gọi thẳng Render (U-C), nên một IP đơn lẻ giữ được tới `worker_connections` kết nối chậm vào `/hooks/*` → `/health` và `/api` chết theo.
**Chọn:** khối `geo $edge_cf_ip` (dải Cloudflare công bố, IPv4 + IPv6) trong `nginx.conf.template`; khoá của cả hai map là `"<EDGE_HOOKS_IP_LIMITS>:<geo>"` — chỉ `0:1` (lưới bật + IP Cloudflare) rỗng, `0:0` vẫn đếm theo `$binary_remote_addr` như EG1. nginx vẫn không đọc header lưới.
**Đánh đổi:** Danh sách dải là dữ liệu tĩnh — Cloudflare đổi thì phải sửa template (đối chiếu trước khi bật, DEPLOYMENT §3.6). IP egress của Worker nằm ngoài dải công bố thì request lưới bị đếm chung như trước (an toàn, dễ 429 hơn) — phải đo trong log edge. Kẻ xấu chạy Worker riêng trên Cloudflare vẫn được nới (còn `client_body_timeout` + cổng phạt hub-api).


## ADR-224 — Trần của lưới hứng theo dòng, byte và lượt/ngày; ngân sách mỗi lượt cron theo giới hạn gói free (LH2, REVIEW-LH2 TB-2/TB-3, `[LH:T8]`, `[LH:T10]`, 2026-10-15)

**Vấn đề:** Trần chỉ đếm dòng (2.000/key × 1 MB = 2 GB) vượt dung lượng D1 free và đốt hết quota ghi trước khi chạm trần — kẻ biết `sourceKey` xả rác lúc Render ngủ là đủ làm chết lưới cho mọi source; một lượt cron 25 dòng vượt trần truy vấn D1 rồi lặp lại mãi.
**Chọn:** Số liệu tra 2026-10-15 trên developers.cloudflare.com (`/d1/platform/limits/`, `/d1/platform/pricing/`, `/workers/platform/limits/`): D1 free 500 MB/DB, dòng/BLOB ≤ 2 MB, 5M rows read + 100k rows written/ngày (index tính thêm, reset 00:00 UTC), 50 truy vấn D1/invocation; Workers free 50 subrequest/invocation, CPU 10 ms (cả Cron), 128 MB/isolate. Trần (bộ đếm bằng trigger, byte = body + header + target theo UTF-8; dòng chết vẫn tính vào trần toàn bảng và trần của key tới khi bị dọn): `MAX_BYTES` 300 MB, `MAX_KEY_BYTES` 50 MB, `MAX_ROWS` 15.000, `MAX_PER_DAY` 5.000 lần hứng; header > 16 KB hoặc target > 4 KB không hứng (Workers nhận tới 128 KB header + 16 KB URL); cron ≤ 10 dòng và ≤ 2 MB body/lượt (4 + 4×10 = 44 < 50 truy vấn).
**Đánh đổi:** Ngày bị xả rác thì sự kiện thật thứ 5.001 nhận 503 (provider tự retry, đúng BB-3); trần theo key không bảo vệ trần chung khỏi nhiều key bị lộ; key có nhiều dòng bị hub từ chối bị khoá tới 7 ngày; 11 rows written/sự kiện chỉ là đường suôn sẻ — cron còn tốn lease ≈ 2, `markRetry` ≈ 2, `moveDead` ≈ 6–7 mỗi dòng: hub vắng cả ngày ≈ 43k + 25k lần hứng vẫn dưới 100k, nhưng ngày hub trở lại với 15.000 dòng tồn (≈ 86k) cộng lần hứng mới có thể vượt quota → `INSERT` 503 (BB-3 giữ), `deleteRow` lỗi thì dòng gửi lại sau lease và hub nuốt bản trùng — chậm, không mất; CPU 10 ms của một lượt chưa đo trên workerd thật (LH2-VIEC-MAY-CONG-TY).

## ADR-241 — Ramp: gia hạn `:ramp` ở bậc cuối khi còn bị chặn, trần RAMP_MAX 180 s, trần cuối tuyệt đối 64 rps; đính chính ADR-232 (thuộc BP, F3 + Thấp-9 của review chaos-bp lượt 2, 2026-10-15)

> (đổi số từ ADR-234 trên nhánh feat/bp-f3 — trùng số với ADR-234 phân cấp console trên master)

**Vấn đề:** ADR-232 (khoá `:ramp` cố định 70 s) chưa đủ: chaos `[BP:T16]` đo lại còn 192 delivery dội về ở +70 s với 149/s, vì hàng `retry.10s` dồn vào 1–2 giây nên mỗi bậc chỉ dùng được 1–2 giây trần. Thêm Thấp-9: env bước ramp nhỏ (1 s) đẩy bậc cuối lên 59, Lua kẹp 20 → trần cuối ≈ 2M rps.
**Chọn:** (Admin chốt "làm luôn") trong CÙNG `EVAL` `LUA_GATE`, CHỈ KHI ở bậc cuối VÀ lần gate này bị trần ramp chặn (count > rampCap) → `PEXPIRE :ramp` = min(gia hạn, rampStart + RAMP_MAX − now), chỉ khi dài hơn PTTL hiện tại (không rút ngắn); gia hạn = max(2 × step, 10 s + step) để không hết hạn trước vòng `retry.10s` kế (mặc định 20 s). `DELIVERY_RAMP_MAX_SECONDS` mặc định min(180, 3 × (ramp + một bậc)) — 180 với mặc định, hạ ramp thì trần hạ theo; env chỉ kẹp thấp hơn, sàn = ramp + một bậc, env ≤ 0/bậy → mặc định. Quá RAMP_MAX (tính bằng đồng hồ worker từ mốc trong khoá) thì gate coi như hết ramp; script không dùng `TIME` (deterministic), nên lệch đồng hồ D giữa worker cho phép ramp sống tới RAMP_MAX + D. Thấp-9: kẹp số lần nhân đôi ≤ 5 (`DELIVERY_RAMP_MAX_DOUBLINGS`) và `DELIVERY_RAMP_START_RPS` chỉ kẹp thấp hơn 2 → trần cuối tuyệt đối ≤ 64 rps; không chặn step < 10 để giữ env bước nhỏ cho test/demo. `:ramp` hỏng giá trị → không ramp (như mất khoá). `TOTAL_RETRY_WINDOW_MS` thay 6 × (70 s + 10 s) bằng 6 × (180 s + 10 s): +11 phút, = 27.250.000 ms ≈ 7h34m10s. Vẫn 1 lệnh client trên đường throttle/ramp (`redis-budget` `[BP:T22]` phần f); PEXPIRE/PTTL nằm trong script.
**Đánh đổi:** đích nhận 64 rps tối đa thêm 110 s nếu hàng tồn vẫn còn (hồi phục chậm hơn khi backlog lớn); hàng > ~64 × 180 vẫn dội về sau 180 s — ramp theo kích thước backlog không làm (đụng ngân sách R1), queue hoãn 1–2 s phải đổi topology (sau đồ án). Lệnh dọn `olderThan` dưới ≈ 7h35m bị 400. **Kỳ vọng (tính tay, CHƯA chạy):** 500 hàng dồn 1 giây/vòng xả hết ở +110 s, không giây nào > 64; 100 rps đều thì ramp hết đúng ở 180 s.
**Đo lại:** L1 Redis thật (`circuit-breaker.spec` `[BP:T16]` phần c/d + F3 500 hàng) — **xanh**, CI run `38753284031` (`4aa3710`, db L1 275/275, 0 skip) · chaos `[BP:T16]` phần b — **chưa** (máy công ty).

## ADR-234 — Phân cấp console Hub ⊃ Tài khoản ⊃ Dự án: đăng nhập vào thẳng dự án gần nhất (phương án a), trang "Tất cả dự án" ở `/projects` (2026-10-16)

**Vấn đề:** Mục "Dự án" (`/dashboard/projects`, có nút "Tạo dự án") nằm TRONG sidebar của một dự án, nên người dùng đọc thành "dự án tạo ra dự án". Không có nơi nào ở tầng tài khoản để xem mọi dự án của mình cùng lúc.
**Chọn:** (Admin chốt phương án a)
- Đăng nhập vẫn vào thẳng dự án gần nhất (`ensureProject` trong `project-store.ts` giữ nguyên).
- Đổi dự án bằng bộ chọn dự án ở sidebar header / thanh trên. Bộ chọn có thêm hai dòng: "+ Tạo dự án mới" (mở `CreateProjectDialog` dùng chung) và "Tất cả dự án" (sang `/projects`).
- `/projects` là trang thật ở tầng tài khoản, nằm ngoài layout dashboard nên không có sidebar dự án. Trang là lưới thẻ; bấm thẻ thì `setProjectId` rồi vào `/dashboard`. `?demo=1` vẫn dùng được với dữ liệu giả, không cần hub-api.
- Bỏ mục `projects` khỏi sidebar dự án. Trang `/dashboard/projects` giữ nguyên chức năng (operator: cột mức sử dụng + ghi đè hạn mức; owner: "Nhận nguồn chưa xác thực") và vào được từ nút "Quản lý & hạn mức" trên `/projects`.

**Đánh đổi:** Trang quản lý dạng bảng vẫn nằm dưới `/dashboard` (còn sidebar dự án), không chuyển hẳn sang tầng tài khoản. Lý do là để không phải viết lại các chức năng của operator/owner trong lần này. Người dùng phải mở thêm một lần bấm mới tới được trang đó.

## ADR-235 — `GET /api/v1/projects?include=stats`: số đếm xuyên dự án theo membership, một lượt đọc, 0 lệnh Redis; định nghĩa "sức khoẻ" của thẻ dự án (2026-10-16)

**Vấn đề:** Mỗi thẻ ở "Tất cả dự án" cần các con số: số source, số đích, số sự kiện nhận trong 24h, số lần gửi lỗi trong 24h, số tin trong DLQ, số thành viên, ngày tạo, cùng viền xanh/đỏ theo sức khoẻ. Nếu trình duyệt gọi N lần (mỗi dự án một lượt, mỗi lượt qua `ProjectScopeGuard`) thì vừa chậm vừa tốn kết nối. Còn đọc xuyên tenant mà không có lối có tên thì phạm BB-5.

**Chọn:**
- **API.** `GET /api/v1/projects?include=stats` trả lại đúng danh sách cũ (người thường thấy dự án mình là thành viên; operator thấy mọi dự án, như trước). Mỗi phần tử có thêm `stats: {createdAt, sources, endpoints, members, events24h, failedAttempts24h, dlq, circuitOpen, storageLevel, openAlerts:{critical,warning,info}}`, hoặc `null` khi thiếu dòng số liệu. `include` lạ thì trả 422 `validation_failed`.
- **Escape hatch.** Có hai lối có tên trong `prisma.service.ts`, cùng khuôn `ownerAlertsAcrossTenants` (`systemTx`, lọc cứng trong SQL):
  - `memberProjectStatsAcrossTenants(userId)` JOIN `project_members` của chính user;
  - `operatorProjectStatsAcrossTenants()` lấy mọi project.
  Gate `project-stats-cross-tenant` chỉ cho gọi hai hàm này từ `projects.controller.ts`.
- **Truy vấn.** Một câu SQL, mỗi chỉ số là một CTE `GROUP BY tenant_id`, chạy trên index đã có:
  - events `(tenant_id, received_at DESC)`;
  - deliveries DEAD (index một phần `(tenant_id, updated_at)`);
  - `delivery_attempts(created_at)` rồi JOIN deliveries theo PK (cùng khuôn với AlertEvaluator);
  - alerts `(tenant_id, state, opened_at)`;
  - PK của `project_members`.
  Vì vậy không cần migration index. `sources` không có index theo tenant, nhưng mỗi dự án có trần 20 source nên bảng nhỏ.
- **Định nghĩa từng số.**
  - Source và đích: chỉ đếm cái chưa lưu trữ.
  - "Gửi lỗi": attempt không trả 2xx, kể cả mất kết nối, đúng với `classifyHttpOutcome !== 'success'`.
  - DLQ: cùng điều kiện với `countDeadDeliveries` (DEAD và chưa bị replay).
  - `circuitOpen`: đích đang dùng có cột `circuit_state` ≠ CLOSED. Số này đọc từ DB, 0 lệnh Redis.
- **Sức khoẻ.** Hàm thuần `projectHealth` ở `apps/web/src/lib/hub/project-health.ts` xếp mỗi thẻ vào một trong ba màu:
  - **Đỏ** khi có ít nhất một điều sau: có đích circuit ≠ CLOSED; DLQ > 0; nấc dung lượng `LOCKED`/`HARD_LOCKED`; có cảnh báo OPEN mức critical hoặc warning.
  - **Xám** (trung tính) khi không đỏ mà dự án chưa có source lẫn đích nào, hoặc khi `stats` là null.
  - **Xanh** trong mọi trường hợp còn lại.
  Nhãn trên thẻ nói lý do đỏ, ví dụ "2 tin trong DLQ".

**Đánh đổi:**
- Phần đếm "gửi lỗi 24h" quét mọi attempt của cả hub trong 24h rồi mới lọc theo tenant (attempt không mang `tenant_id`). Chi phí tăng theo lưu lượng toàn hub, không theo số dự án của user. Nếu bảng lớn thì cần thêm `tenant_id` vào `delivery_attempts` hoặc một bảng đếm theo giờ.
- Cảnh báo mức info (ví dụ dung lượng 70%) và số lần gửi lỗi 24h không làm thẻ đỏ. Số lỗi 24h chỉ để tham khảo: lỗi đã được retry thành công thì không phải sự cố đang mở.
- Viền dựa trên trạng thái tại lúc đọc (staleTime 60s), không cập nhật realtime.

## ADR-236 — Console hiển thị logo thương hiệu thật (Simple Icons CC0 + logo chính thức), nhúng SVG đã làm sạch; nguồn không có logo -> chữ tắt theo tên (2026-10-16)

**Vấn đề:** `ProviderIcon` vẽ glyph tự chế cho payos/sepay/github/stripe, còn mọi nguồn khác (GenericAdapter, provider lạ) cùng một icon chung — dev không nhận ra nguồn bằng mắt; đích Discord/Telegram cũng chỉ là icon Lucide.

**Chọn:**
- Logo thật nhúng tĩnh trong `apps/web/src/components/flow/brand-logos.ts` (SVG inline: `d`/`fill`/`fillRule`/`transform`, không ảnh, không dependency npm). Nguồn: Simple Icons `simple-icons@16.35.0` (CC0) cho github, stripe, discord, telegram và các mục catalog có sẵn; logo chính thức (cắt phần biểu tượng) cho PayOS, SePay, VNPAY, Checkout.com, Slack, Svix, Postmark, Twilio. Bảng nguồn + giấy phép ở đầu file.
- SVG tải về coi là không tin cậy: dựng trong trình duyệt headless sau khi bỏ script/foreignObject/image/use/a/on*/href, chỉ trích `d` (regex lệnh path), fill (#hex), fill-rule, ma trận transform; `brand-logos.spec.ts` khoá khuôn này.
- Logo đơn sắc tô màu thương hiệu, tự chuyển sang `--foreground` khi tương phản với nền theme < 2:1 (GitHub/Vercel đen -> trắng ở dark).
- Nguồn không có logo + có tên source -> ô chữ tắt (1–2 ký tự) màu ổn định theo hash của tên (cùng công thức với ô dự án ở `/projects`); không có tên -> icon Lucide chung như cũ.
- **Không bao giờ tải favicon/logo từ domain provider lúc chạy, không lưu URL ảnh do user nhập:** (1) riêng tư — trình duyệt của admin sẽ báo cho domain bên thứ ba biết họ dùng nguồn đó, (2) phụ thuộc ngoài — console vỡ/chậm khi domain đó chết hoặc chặn hotlink, (3) ảnh do user/bên thứ ba kiểm soát — có thể đổi thành nội dung lừa đảo/giả mạo thương hiệu khác hoặc dùng làm pixel theo dõi.

**Đánh đổi:**
- Thêm ~36 KB path vào bundle client của các trang flow/events; thêm provider mới phải tải + sinh lại logo bằng tay (không tự có).
- Một số thương hiệu chưa có logo dùng được (heroku, momo, pipedrive, zalopay; typeform/woocommerce chỉ có logo chữ) -> rơi về chữ tắt/icon chung.
- Logo là nhãn hiệu của chủ sở hữu (kể cả bản CC0 của Simple Icons): dùng để nhận diện, không ngụ ý liên kết.

## ADR-237 — Cảnh báo + Cài đặt lên tầng tài khoản (`/alerts`, `/settings`), lối vào ở menu tài khoản; đường cũ `/dashboard/*` chuyển hướng (2026-10-16)

**Vấn đề:** Sidebar thuộc MỘT dự án (ADR-234) nhưng còn hai mục không thuộc dự án: "Cảnh báo" (API `/api/v1/alerts*` xuyên dự án — operator thấy mọi cảnh báo, owner thấy cảnh báo dung lượng các dự án mình là owner, ADR-190) và "Cài đặt" (email cảnh báo của người vận hành, CB5). Đặt trong sidebar dự án làm người dùng tưởng nội dung đổi theo dự án đang chọn.

**Chọn:** Hai trang chuyển sang nhóm route `(admin)/(account)` — layout tầng tài khoản như `/projects` (thanh trên dùng chung `components/admin/account-menu.tsx`: chuông, ngôn ngữ, giao diện, avatar; không sidebar). Lối vào: menu avatar ở thanh trên của CẢ dashboard dự án lẫn trang tầng tài khoản, nhóm "Xuyên dự án" — điều kiện hiện giữ nguyên như sidebar cũ, gom vào hàm thuần `accountMenuItems` (`lib/hub/account-routes.ts`): Cảnh báo = operator hoặc owner ít nhất một dự án; Cài đặt = chỉ operator. Chuông "Xem tất cả" / "+N" trỏ `/alerts`. `/dashboard/alerts`, `/dashboard/settings` thành trang `redirect()` giữ nguyên query (link trong email đã gửi); link email (`libs/common/src/alerts/email.ts`) đổi sang đường mới. Không đổi hub-api.

**Đánh đổi:** Mất một cú bấm thẳng từ sidebar (giờ là avatar -> Cảnh báo, hoặc chuông -> Xem tất cả); trang tầng tài khoản không có banner/toast cảnh báo của dashboard (chỉ chuông). Redirect chạy ở server component (một vòng 307) thay vì `next.config` redirects — để test được bằng jest; đường cũ phải giữ hai file page nhỏ đến khi bỏ hẳn.

## ADR-238 — AuthGuard không ẩn cây nữa: khung app + khung chờ shimmer render ngay, dữ liệu giữ ở "cổng" hubFetch; `/auth/me` ‖ `/api/v1/projects` song song, timeout 90s + "Thử lại" (2026-10-16)

**Vấn đề:** Sau khi hub-api (Render free) ngủ, mọi trang console trắng 10–60s. Lý do: `AuthGuard` trả `null` khi chưa có phiên, gọi `/auth/me` rồi mới tới `/api/v1/projects` (tuần tự, có thể thêm refresh và một lượt thử lại, tức tới 4 vòng), `hubFetch` không có timeout, và không có `loading.tsx` nào.

**Chọn:** Guard render cây con ngay. Không có dữ liệu bảo vệ nào hiện ra trước khi auth xong, vì mọi request `/api/v1/*` bị giữ ở cổng `lib/hub/auth-gate.ts`. Cổng đóng trong layout effect của guard, chạy trước effect của react-query. Nó mở sau khi `ensureProject` và `me` đã nạp, và request được gắn `?projectId=` lúc thực sự gửi đi. `/auth/*` và request project của chính guard đi qua cổng. Không có guard thì cổng mở. Vì query đang chờ nên các thành phần hiện khung chờ có sẵn, đúng bố cục của mình. `<Skeleton>` đổi sang shimmer, tắt khi bật giảm chuyển động. Thêm khung chờ theo hình cho bộ chọn dự án, avatar, badge realtime, ô DataTable, thẻ sức khoẻ, bảng khoá API/dự án, và `loading.tsx` cho dashboard, (account), projects. `/auth/me` và `/api/v1/projects` chạy song song bằng `Promise.all`. Không suy danh sách từ `memberships`, vì operator thấy cả project không là thành viên. Không đổi hub-api. `hubFetch` có timeout 90s (một lần cold start ~60s cộng dư), bỏ qua được bằng `timeoutMs`. Sau 5s hiện ghi chú "Máy chủ đang khởi động". Gặp timeout, lỗi mạng hoặc 5xx thì hiện "Thử lại" thay vì về /login. 401 và các 4xx khác giữ như cũ. Thêm bộ đếm refresh: một 401 về sau khi refresh của request song song đã xong thì chỉ thử lại, không refresh lần hai.

**Đánh đổi:** Cây con mount trước khi có phiên. Chỗ nào quyết định theo `me` hay project mà không qua query (chỉ operator, chưa chọn dự án) phải tự hỏi `useAuthBooting()`, và chỗ quên hỏi sẽ nháy kết luận sai trong lúc chờ (không lộ dữ liệu). Cache react-query của chính phiên này vẫn hiện ngay khi chuyển giữa các layout có guard. Danh sách dự án bị đọc thêm một lần sau khi mở cổng (query của bộ chọn đã xếp hàng từ trước). Timeout 90s áp cho mọi request, nên một thao tác thật sự lâu hơn 90s sẽ báo lỗi.

## ADR-239 — Ghim Vercel Functions của `apps/web` ở Singapore (`apps/web/vercel.json` `regions: ["sin1"]`) (2026-10-16)

**Vấn đề:** Function của Vercel (proxy `/api/*`, `/auth/*`, server component) chạy ở `iad1` (mặc định, Washington), trong khi Render, Neon, Upstash, CloudAMQP đều ở Singapore. Mỗi lượt console gọi hub-api vì vậy đi vòng Mỹ↔Singapore.

**Chọn:** Thêm `apps/web/vercel.json` với `"regions": ["sin1"]`. Root Directory của Vercel là `apps/web` nên Vercel đọc file này. Cấu hình nằm trong mã để truy được, không chỉnh tay ở dashboard. `docs/DEPLOYMENT.md` §2 và checklist ghi file này là nguồn sự thật. Bước kiểm tra: sau redeploy, header `x-vercel-id` phải có dạng `hkg1::sin1::…`, không được là `::iad1::`.

**Đánh đổi:** Gói Hobby chỉ cho một region, nên người dùng ở xa Singapore chịu độ trễ tới function (edge vẫn gần họ). Thay đổi chỉ có hiệu lực sau lần redeploy kế tiếp. Ai đặt region trong dashboard thì file này vẫn thắng, nên muốn đổi phải sửa file.

## ADR-240 — Keep-alive `hub-all` chỉ trong giờ thức (cron-job.org `*/5 7-22 * * *`, giờ Việt Nam), tạm dừng UptimeRobot, không ping shop (2026-10-16)

**Vấn đề:** Render free cho 750 giờ instance/tháng, **dùng chung cho cả workspace** chứ không phải mỗi service 750 giờ. Giữ `hub-all` thức 24/7 (UptimeRobot ping 5 phút) đã tốn ~744 giờ/tháng, không còn giờ cho `shop`, và chỉ cần lố một chút là Render tạm dừng **mọi** service free tới hết tháng.

**Chọn:** Ping keep-alive bằng cron-job.org, lịch `*/5 7-22 * * *`, múi giờ `Asia/Ho_Chi_Minh`, gọi `GET https://hub-api-c9hg.onrender.com/health`. Lượt ping cuối lúc 22:55, service ngủ khoảng 23:10, tức thức ~16 giờ/ngày, khoảng 500 giờ/tháng. Monitor UptimeRobot để ở trạng thái **tạm dừng** (không xoá, bật lại được). **Không ping `shop`:** trước buổi demo thì đánh thức tay (mở trang shop, chờ ~1 phút).

**Đánh đổi:** Ngoài khung 7:00–23:10 giờ Việt Nam, người đầu tiên vào sẽ chờ một lần cold start (~80s, đo ngày 2026-10-16 được 83,6s). Webhook provider gửi vào lúc đó có thể timeout ở lần đầu và trông vào lượt gửi lại của provider. Phía console thì khung chờ + thông báo "Máy chủ đang khởi động" + "Thử lại" của ADR-238 làm nhẹ đi. cron-job.org là phụ thuộc bên ngoài, không nằm trong repo: lịch và URL chỉ được ghi ở đây và ở `docs/DEPLOYMENT.md` §8, đổi URL Render thì phải sửa job bằng tay.

## ADR-242 — Bỏ thẻ "Sức khoẻ hệ thống" khỏi dashboard console; `GET /health` ở hub-api giữ nguyên (2026-10-16)

**Vấn đề:** Thẻ gọi thẳng `${HUB_API_URL}/health` (cross-origin, không qua cổng/timeout của `hubFetch`) mỗi 15s và gộp mọi lỗi (kể cả 502 HTML khi Render cold start) thành badge đỏ "Không kết nối" — báo động giả rất thường xuyên, mâu thuẫn với thông báo "Máy chủ đang khởi động" của ADR-238, làm người dùng hoang mang.

**Chọn:** Xoá phía web: `health-card.tsx`, `useHealth`, `hubKeys.health`, type `Health`/`HealthDependency`, khoá i18n `page.dashboard.health.*` (vi + en); cột phải dashboard chỉ còn `RealtimeCard` giãn theo chiều cao biểu đồ. Endpoint `GET /health` của hub-api không đổi (cron-job.org ping keep-alive — ADR-240; `demo:warm`; demo BB-2 bằng curl).

**Đánh đổi:** Mất cảnh demo BB-2 trên giao diện (tắt Redis → thẻ "Suy giảm", vai trò từng dependency); thay bằng `curl -s localhost:4000/health` (LOCAL) trong lúc tắt Redis. Người dùng không còn chỉ báo trạng thái dependency trong console — chỉ còn badge realtime và thông báo khởi động/"Thử lại" của ADR-238.

## ADR-243 — Badge realtime ba mức (`connecting`/`connected`/`disconnected`), chỉ đỏ sau 90s đứt liên tục; xin vé socket lỗi tạm thời thì tự thử lại thay vì handshake vô vé (2026-10-16)

**Vấn đề:** Badge "Thời gian thực" chỉ có xanh/đỏ theo `socket.connected`, nên đỏ "Mất kết nối" suốt lúc hub-api (Render free) cold start ~80s hoặc redeploy dù Socket.IO đang tự nối lại — báo động giả cùng loại ADR-242. Tệ hơn (đã xác nhận bằng mã nguồn socket.io-client 4.8.3 `onpacket(CONNECT_ERROR) -> destroy()` và probe: 1 handshake, 0 lượt nối lại trong 15s): xin vé `/auth/socket-ticket` lỗi (502 lúc cold start, timeout, mạng) thì `cb({})` -> middleware từ chối `UNAUTHORIZED` -> client không tự nối lại sau lỗi middleware -> đỏ mãi tới khi reload.

**Chọn:** Tách vòng nối lại thành hàm thuần `apps/web/src/lib/hub/realtime-connector.ts` (test jest như `auth-boot.ts`); store giữ `status` thay `connected`. Đỏ chỉ khi đứt LIÊN TỤC ≥ `REALTIME_RED_AFTER_MS` = 90s (= `HUB_FETCH_TIMEOUT_MS`, ADR-238), hoặc vé bị từ chối thật (401 — hubFetch tự về /login như cũ; 403/4xx khác). Vé lỗi tạm thời (status 0, 5xx, 408, 429, lỗi mạng) -> KHÔNG gửi handshake, huỷ lượt nối, thử lại sau backoff 1s·2^n trần 10s có jitter; `connect_error` khi socket đã bị huỷ (middleware) và `io server disconnect` -> chủ động `connect()` lại (mỗi lượt Socket.IO gọi `auth` -> vé MỚI, vé 60s). Tab hiện lại / `online` -> thử ngay nếu không đang xin vé và Manager không đang tự nối. Bộ đếm thế hệ bỏ vé về muộn (đổi project/dispose) — không handshake hộ socket cũ; `dispose` gỡ mọi timer + listener khi unmount/logout. Badge: vàng nhạt "Đang kết nối…" (nhấp nháy `motion-safe`), title + `sr-only` giải thích máy chủ có thể đang khởi động; vẫn skeleton lúc booting (ADR-238).

**Đánh đổi:** Mất kết nối thật bị báo trễ tới 90s (trong lúc đó chỉ xám). Vé lỗi tạm thời kéo dài tốn tối đa ~1 request/10s/tab tới hub-api. Sau 403 (mất quyền project) không tự thử lại — chỉ khi tab hiện lại/online/đổi project/reload. Ngưỡng 90s gắn với đo cold start hiện tại (ADR-240); Render chậm hơn thì phải chỉnh hằng số.

## ADR-244 — Dropdown chạy animation theo `data-[state]` của Radix, Select mặc định `popper`; tooltip ô bảng (`CellTooltip`) qua Radix Portal, chỉ mở khi chữ thật sự bị cắt (2026-10-17)

**Vấn đề:** Các khối Select/DropdownMenu/Popover/Dialog/Sheet bị nghi "không có animation mở/đóng" (~~chỉ có variant `data-open`/`data-closed` của Base UI nên không khớp `data-state` của Radix~~ — **đính chính 2026-10-17: sai**; `shadcn/tailwind.css` định nghĩa `data-open:`/`data-closed:` khớp cả `[data-state=open|closed]`, animation vốn đã chạy; các class `data-[state=…]` thêm ở PR #7 là thừa và đã gỡ ở ADR-245. Ngoại lệ thật: tooltip Radix có `data-state="instant-open"` không khớp — đã thêm). Select `item-aligned` nhảy đè lên trigger. Ô bảng truncate chỉ có `title=` (trễ, không xem được trên cảm ứng); bản tooltip tự chế đầu tiên nằm trong ô nên bị `overflow-hidden` cắt, clamp `transform` thủ công làm mất `-50%`, và Select popper ép `w-(--radix-select-trigger-width)` cắt mục dài khi trigger hẹp.

**Chọn:** (đính chính 2026-10-17: phần thêm variant `data-[state=open|closed]` là thừa, đã gỡ ở ADR-245; các thay đổi còn lại giữ nguyên.) ~~Thêm variant `data-[state=open|closed]` (giữ cả `data-open` cũ) cho năm khối;~~ Duration 150ms ease-out cho năm khối; Select mặc định `position="popper"`, `align="start"`, `sideOffset=4`, mũi tên xoay khi mở, content chỉ `min-w-(--radix-select-trigger-width)` + `max-w-[min(24rem,calc(100vw-1rem))]` để rộng theo nội dung. `CellTooltip` dựng trên `ui/tooltip.tsx` (Portal + collision của Radix, màu theme `bg-foreground`/`text-background`, `whitespace-pre-wrap break-words` max 20rem), controlled: chỉ mở khi `[data-cell-text]` có `scrollWidth > clientWidth`; prop `always` cho thông tin thêm (`reason.message` ở cột "Hỏng ở"). Thay `title=` ở audit reason, delivery lastError, subscription template, event subject/type, FailedAt. Bỏ `styles/cell-tooltip.css` (gradient).

**Đánh đổi:** Mỗi ô có tooltip thêm một Radix Tooltip root (nhẹ, chỉ mount Content khi mở) và một lần đo layout lúc hover. Ô không bị cắt thì không còn gợi ý gì khi hover (trước có `title` luôn hiện). Tooltip vẫn chỉ mở bằng hover/focus — trên cảm ứng phải mở chi tiết dòng để xem đủ.

## ADR-245 — Component dùng chung cho console: primitives Radix mới, ConfirmDialog/IconButton/StatusBadge, bộ tone trạng thái, `Alert` cho callout (2026-10-17)

**Vấn đề:** Có `ui/*` nền nhưng thiếu tầng nghiệp vụ nên mỗi trang tự chế: `<input type="checkbox">` trần + `accent-primary`, `<select>` gốc, tab dựng bằng `<button role="tab">`, `window.confirm` (5 chỗ), AlertDialog chép tay (5 chỗ), `title=` trên nút icon, ba bảng màu trạng thái chép tay (emerald/amber/rose) và hộp cảnh báo `border-amber-500/..` rải rác; nút phải vá `cursor-pointer` từng chỗ.

**Chọn:** Thêm `ui/{checkbox,switch,radio-group,tabs,alert}` (Radix, `data-slot`); `Button` có `cursor-pointer` mặc định, prop `loading`, variant `replay` (thay `.flow-replay-btn`); `admin/confirm-dialog` (`ConfirmDialog` + `useConfirm()` Promise), `admin/icon-button` (Button + Tooltip + aria-label), `StatusBadge`/`toneBadgeClass`/`toneTextClass` với một bộ tone `ok|warn|bad|info|idle|progress` dựa trên `--flow-*` (có dark) và `httpTone()` một chuẩn (2xx ok, 408/429 warn, còn lại bad, không phản hồi idle); callout đổi sang `Alert`; token motion + khối `prefers-reduced-motion` chung ở `globals.css`; gỡ class `data-[state=…]` thừa của ADR-244; trang `/dashboard/ui-kit` (dữ liệu tĩnh) liệt kê mọi component để agent sau copy; biome khai `inputComponents` cho `a11y/noLabelWithoutControl` để `<label>` bọc `Checkbox/Switch/RadioGroupItem` hợp lệ.

**Đánh đổi:** Màu 5xx/3xx ở cột HTTP đổi từ vàng sang đỏ, "không phản hồi" ở dòng thời gian đổi từ vàng sang xám (theo chuẩn `HttpPill`). `SIGNATURE_VIEW.unverified.className` là chuỗi trùng với `toneBadgeClass("warn")` vì lib thuần TS không import React (có test giữ khớp). `StorageBanner` (palette `--warning-*` riêng, viền trái) và `Select` tự dựng nơi khác chưa đổi vỏ sang Alert để không vỡ layout. Đợt 2/3 (EmptyState/ErrorState, TimeCell, MonoId, DataTable sort, SimpleTable/GridList…) làm sau.

## ADR-246 — Tầng dữ liệu của console: EmptyState/ErrorState, TimeCell, MonoId, DataTable sắp xếp/phím, SimpleTable, GridList (2026-10-17)

**Vấn đề:** Mỗi trang tự dựng trạng thái rỗng/lỗi (`<p className="text-muted…">`, lỗi lúc đỏ lúc xám, không có "Thử lại"), cột thời gian ráp `formatDateTime`/`formatRelative`/`title=` mỗi kiểu một vẻ, mã id cắt bằng `slice(0, 8)` tay, bảng tự dựng (`<Table>` trần) lệch khung/tiêu đề với `DataTable`, `DataTable` không sắp xếp được và hàng bấm được không với tới bằng bàn phím, hai danh sách lưới (trang Sự kiện, ngăn Nhật ký) chép nhau khung/tiêu đề/hàng. Biểu đồ sự kiện ép `Asia/Ho_Chi_Minh` mà không nói cho người xem.

**Chọn:** `admin/state` (`EmptyState` md/sm + `ErrorState` dựa trên `Alert destructive`, `onRetry` → nút Thử lại, `inline`); `admin/time-cell` (`relative|absolute|both`, tooltip là phần còn lại, 24 giờ ở mọi ngôn ngữ) + `lib/hub/format` thêm `formatNumber/formatDate/chartTimeFormatters`; `admin/mono-id` (mono, mặc định 8 ký tự, tooltip đủ mã, copy tuỳ chọn); `DataTable`: sắp xếp bấm tiêu đề (`aria-sort`, `enableSorting:false` tắt), hàng `onRowClick` có `tabIndex`/Enter/Space/`focus-visible`, prop `footer` đặt `CursorPager` dưới bảng kèm ghi chú "tìm/sắp xếp trong trang này", `rowClassName`, `aria-label` ô tìm; `admin/simple-table` cùng token khung với `DataTable`; `admin/grid-list` (`GridList` + `GridListRow`) chỉ rút khung/tiêu đề/hàng/rỗng/tải/lỗi — cuộn vô hạn, viền tone, unroll, `content-visibility` vẫn do trang; `CardSkeleton`/`DetailSkeleton`, Suspense fallback = `PageSkeleton`; `FormDialog` có `footer`/`submitDisabled`/`submittingLabel`; `errorTextOf` (ui-logic) thay `toast.error(e.message)` để lỗi hub dịch theo mã. **Múi giờ biểu đồ:** server cắt bucket sự kiện THEO giờ Việt Nam (`TIMESERIES_TZ = 'Asia/Ho_Chi_Minh'`, `tenant-scoped.repository.ts`) → `events-chart` GIỮ ép `Asia/Ho_Chi_Minh` (nếu theo giờ máy thì ranh giới ngày của bucket 7 ngày lệch ở máy khác múi) và ghi nhãn "giờ Việt Nam (GMT+7)" dưới tiêu đề; bucket lưu lượng nguồn cắt theo epoch (`floor(epoch / bucketSec)`, không múi giờ) nên `traffic-sheet` đổi sang giờ máy.

**Đánh đổi:** Sắp xếp của bảng cursor chỉ trong trang đang xem (nói rõ bằng ghi chú, không giả làm sắp xếp toàn cục). Mốc tuyệt đối ở nhiều bảng đổi từ `formatDateTime` (ngày/giờ theo locale) sang `formatStamp` (`dd/MM HH:mm:ss`, không năm). Ngăn Nhật ký: trạng thái đang tải đổi từ chữ "Đang tải…" sang khung chờ. Cột `locale` bị bỏ khỏi các hàm dựng cột vì `TimeCell` tự lấy ngôn ngữ. Nhãn thời gian ở trang Sự kiện (đồng hồ có mili-giây) giữ nguyên, không đưa vào `TimeCell`. `traffic-sheet` đổi nhãn sang giờ máy nhưng bucket NGÀY (range 7d) vẫn cắt theo epoch UTC (`floor(epoch/bucketSec)`), nên ở máy khác múi UTC ranh giới ngày trên nhãn có thể lệch so với ranh giới bucket. `formatStamp`/`TimeCell` thêm năm khi mốc khác năm hiện tại.

## ADR-247 — Tinh chỉnh console đợt 3: cỡ chữ `text-2xs`, `SearchInput`, `Spinner`, `UsageMeter`, `SecretOnce`, `PageHeader`/`Card inset`, màu token (2026-10-17)

**Vấn đề:** Sau đợt 1–2 vẫn còn phần "mỗi trang một kiểu": Badge dùng `text-[11px]`/`[10px]` ngẫu nhiên, ô tìm kiếm ráp tay 6 chỗ (lệch icon/chiều cao), `Loader2` + `animate-spin` rải 5 nơi, thanh mức dùng dung lượng chép 3 bản (màu "ok" mỗi nơi một kiểu), hộp secret một-lần và nút Copy cục bộ trùng nhau, `PageHeader` thiếu `back`/`meta` nên trang chi tiết tự dựng h1, `div rounded-md border p-3` rải rác, một số chữ màu `text-rose-*`/`text-emerald-600` không có bản dark, biểu đồ dùng `oklch(...)` cứng không đổi theo theme, hai bộ lọc chọn-một ở bản đồ luồng dùng DropdownMenu radio, hai kiểu hiển thị JSON (`<pre>` và `JsonViewer`).

**Chọn:** Token `--text-2xs` (11px, line-height 1rem) + `Badge size="sm"`; `admin/icon.ts` giữ `ICON`/`ICON_SM` (flow re-export) và CSS `.lucide { stroke-width: 1.75 }`; `admin/search-input` (`size` default|sm, icon `pointer-events-none`); `admin/spinner` (Button `loading`, ConfirmDialog, sonner, auth-guard, settings, storage dùng chung); `storage/usage-meter` (`inline|bar|card`, một bảng màu `--ok/--warning/--danger` có bản dark); `CopyButton variant="icon|labeled"` + `admin/secret-once` (endpoint và api-key); `PageHeader` thêm `back`/`adornment`/`meta`/`className` (dashboard có h1, chi tiết sự kiện); `Card variant="inset"` cho ô phụ (trang dữ liệu = Card, canvas/flow = `flow-surface`); lỗi dùng `text-destructive`, ok/warn dùng `toneTextClass`, biểu đồ dùng `TONE_VAR`; flow chọn-một (khoảng thời gian, nguồn) → `Select`; `JsonBlock` = `JsonViewer` + nút chép.

**Đánh đổi:** `.lucide { stroke-width }` là CSS nên thắng thuộc tính `strokeWidth` truyền vào icon Lucide (không ai đang truyền khác 1.75; SVG tay/recharts/canvas không có class `.lucide` nên không đổi). Badge/nhãn `10px` lên `11px`. Thanh mức dùng ở thẻ dự án đổi màu "ok" từ `--primary` sang `--ok` (xanh) cho khớp trang Dung lượng. `BLOCKED` ở biểu đồ lưu lượng đổi từ tím sang tone `progress` (xanh dương) và `STORAGE_FULL` sang tone `idle` vì bộ `--chart-*` hiện là thang xám. `JsonBlock` dựng một div mỗi dòng (JsonViewer) nên payload rất dài nặng hơn `<pre>` cũ; chỉ hiển thị trong ô cuộn `maxHeight`. Canvas (topology/journey) giữ `text-[11px]`/`[10px]` có chủ đích vì kích thước gắn với toạ độ node.

## ADR-248 — Tách liveness/readiness cho `/health`; heartbeat cho hub-worker (2026-10-18)

**Vấn đề:** `/health` trả 503 khi BẤT KỲ phụ thuộc nào rớt, kể cả Redis (BB-2: được phép sai) và RabbitMQ (ingest vẫn COMMIT được nhờ outbox) — Render dùng nó làm health check nên một cú chớp Redis có thể restart oan cả hub-api. Ngoài ra hub-worker không có tín hiệu sống nào: worker kẹt/chết im thì `/health` (chỉ ở hub-api) vẫn xanh trong khi không ai normalize/giao.

**Chọn:** hub-api thêm `/health/live` (không I/O) và `/health/ready`; `/health` cũ = `/ready`. Phụ thuộc CỨNG chỉ Postgres (BB-3: không COMMIT được thì không được ACK; ingest chỉ ghi `raw_events` + outbox, không publish thẳng). Redis và RabbitMQ MỀM: rớt -> 200 + `status:"degraded"` + chi tiết; Postgres rớt -> 503 `unhealthy`. Mềm cache 30s trong bộ nhớ, mỗi phép kiểm có timeout 3s. hub-worker thêm gauge `hub_worker_heartbeat_timestamp_seconds` (chỉ trong bộ nhớ, đặt khi một lượt outbox relay THÀNH CÔNG — đọc Postgres + publish + COMMIT), `:9101/health/live` (không I/O) và `/health/ready` (consumer đã subscribe + Postgres), cộng `HEARTBEAT_URL` tắt mặc định: GET mỗi `HEARTBEAT_INTERVAL_MS` chỉ khi heartbeat nội bộ ≤45s, lỗi mạng chỉ log. Render health check path nên là `/health/live`; cron-job.org giữ `/health` (vẫn ấm Neon). Việc đổi cấu hình Render là của Admin (DEPLOYMENT §7b).

**Đánh đổi:** `/health/live` xanh không nói gì về DB — dựa vào `/ready` + monitor ngoài để thấy Postgres rớt, và Render sẽ không tự restart khi DB chết (restart cũng không chữa được DB). Trạng thái Redis/RabbitMQ trên `/ready` có thể cũ tới 30s. Heartbeat chỉ phản ánh outbox relay, không phản ánh consumer riêng lẻ bị kẹt (channel đóng thì worker đã tự thoát). Ở `hub-all` (`WORKER_METRICS_PORT=0`) worker không có cổng health nên chỉ `HEARTBEAT_URL` báo được worker kẹt.

**Bổ sung (review):** `SELECT 1` ở `/health` (hub-api) và readiness worker là `$queryRaw` không qua `TenantScopedRepository` — ngoại lệ BB-5 có chủ đích: không đụng bảng nghiệp vụ nào, không trả dữ liệu tenant. `/health/ready` của worker tính cả heartbeat cũ (>45s) là not ready; "consumer" chỉ nghĩa là chưa tắt, vì consumer đóng bất thường thì tiến trình đã tự thoát. `HEARTBEAT_URL` được validate một lần lúc khởi động (http/https), không bao giờ log giá trị hay message lỗi thô, `redirect:'error'`, chu kỳ tối thiểu 5s. `/health` cache mềm 30s nên mới khởi động có thể báo `degraded` tới 30s dù Redis đã lên; timeout Postgres 8s để Neon cold-start không 503 oan cron-job.org.

## ADR-250 — Log tự nói nguyên nhân: enum `cause`, canonical log line, `trace_id` W3C = `correlationId` bỏ dấu `-` (2026-10-18)

**Vấn đề:** Log là câu tự do + `err.message`; đường từ chối ở ingest không có log, lần giao thất bại không ghi `status/error`, không có thời gian theo chặng, `queue_wait` không đo, `x-request-id` không tới worker. Admin nhìn log không biết sơ bộ "chậm vì đâu / sai do ai / tăng do đâu" nên phải đào trace cho mọi ca.

**Chọn:** (1) Một enum đóng `cause` (~30 giá trị, nhóm `slow.*` / `wrong.*` / `fail.*` / `growth.*`, kèm `blame`), một bảng `libs/common/src/causes.ts` tham chiếu `docs/ERRORS.md` và `REASON_CODES` chứ không chép — không thêm catalog thứ ba. (2) Một dòng log chuẩn mỗi lần ingest / normalize / delivery attempt, có `stage_ms` đo bằng đồng hồ trong bộ nhớ quanh lời gọi sẵn có (0 lệnh Redis, 0 truy vấn DB thêm); ngưỡng "chậm" ở env. (3) `trace_id` = `correlationId` bỏ `-` (UUID v4 = 128 bit, hợp lệ W3C), `traceparent` đi bằng payload outbox JSON + header AMQP, không đổi schema; replay = trace mới có link về trace gốc. OTel để đợt sau. Chi tiết: `docs/LOGGING.md`.

**Đánh đổi:** Thêm một bảng phải giữ đồng bộ (có test khoá). Thành công lấy mẫu nên log không đủ đếm — số đếm lấy từ metric. `queue_wait` qua hai tiến trình dính lệch đồng hồ (clamp + cờ `clock_skew`). Ngưỡng mặc định là đoán, phải chỉnh sau khi đo local. Phụ thuộc giai đoạn 2 đụng `outbox.relay.ts`, `metrics.ts`, `main.ts` của worker nên phải chờ agent khác xong.

## ADR-251 — Sentry chỉ bắt lỗi CHƯA biết tên của hub (`blame = hub`); tracing Sentry tắt, `trace_id` W3C của hub là nguồn sự thật (2026-10-18)

**Vấn đề:** Log có `cause` (ADR-250) chỉ bắt lỗi đã biết tên; exception bất ngờ cần stack trace. Sentry là dịch vụ ngoài (dữ liệu rời hệ thống, gói Developer chỉ 5k errors, 1 user — sentry.io/pricing, đọc 2026-10-18), và retry/đích hỏng có thể bắn hàng nghìn sự kiện. SDK mặc định gửi HTTP body/query và user/IP (docs `@sentry/nestjs`).

**Chọn:** Một cửa `reportUnexpected(err, ctx)` ở `libs/common`, chỉ gửi khi `CAUSES[cause].blame === 'hub'` và cause thuộc nhóm "chưa biết" (đích 5xx, chữ ký sai, hạ tầng tạm thời KHÔNG đẩy); không capture trong vòng lặp retry; fingerprint `[svc,cause,err.class,err.code,chặng]` + trần `SENTRY_MAX_PER_MIN` + dedupe trong bộ nhớ. `beforeSend`/`beforeBreadcrumb` dùng chung bộ luật `redact` + allowlist; tắt body/cookie/header/user; test envelope không chứa secret. Mỗi tiến trình (hub-api, hub-worker, kể cả trong `hub-all`) init riêng với DSN riêng (`SENTRY_DSN_HUB_API/HUB_WORKER/WEB`), trống = no-op và không import SDK; `instrument.ts` import đầu `main.ts`, không đụng `rawBody:true`, chạy sau quyết định ACK (BB-3), không Redis/DB. Không bật tracing Sentry (không đặt `tracesSampleRate` ở backend); tag `trace_id` của hub để nối với log. Khi OTel vào đợt sau dùng `openTelemetryIntegration` (tài liệu ghi từ v11.0.0) — không phải thiết kế lại `trace_id`.

**Đánh đổi:** Hạn mức 5k errors buộc phải lọc chặt (lỗi lạ có thể bị dedupe che mất tần suất thật — đọc số đếm ở metric `hub_sentry_events_total`). Trước khi OTel vào, UI Sentry có hai khái niệm trace_id (của Sentry và của hub). Chưa xác minh: phiên bản SDK sẽ cài, Node SDK có nhận `traceparent` đến không (PR #17509/#18476 chưa rõ bản phát hành), SDK có tự cài instrumentation OTel khi không bật tracing (đo RSS trên Render free), chu kỳ của 5k errors. Chi tiết: `docs/LOGGING.md` §11.

## ADR-252 — Frontend/RUM của console: Sentry cho cả lỗi và Web Vitals, Session Replay TẮT ở đợt đầu (2026-10-18)

**Vấn đề:** RUM là nơi duy nhất thấy dev bị treo màn hình (cold start Render, CORS, chunk lỗi). Nhưng console hiện secret một lần (`SecretOnce`: `whsec_`, API key, connection string), payload webhook và email; Session Replay với `maskAllText:false, blockAllMedia:false` (mẫu bài học) tắt mọi bảo vệ mặc định và sẽ đưa secret ra ngoài vĩnh viễn. Speed Insights free của Vercel chỉ có Real Experience Score (từng Core Web Vital cần gói Plus của Pro), 10.000 event/30 ngày cuốn chiếu, chạm hạn mức thì tạm dừng ≥ 14 ngày; Vercel Hobby giới hạn "non-commercial personal use only" (docs Vercel, đọc 2026-10-18).

**Chọn:** Một công cụ — Sentry (`@sentry/nextjs`) — cho cả exception và vitals; không thêm Speed Insights ở đợt đầu. **Session Replay tắt** (không đăng ký `replayIntegration`); nếu bật sau: mask/block mặc định giữ nguyên, `replaysSessionSampleRate:0`, chỉ `replaysOnErrorSampleRate` thấp, `data-sentry-block` bắt buộc cho `SecretOnce`/JsonViewer/ô nhập secret/email; test quét mã cấm `maskAllText:false`/`blockAllMedia:false`. `tracesSampleRate` web mặc định 0.1 (env), `tracePropagationTargets` chỉ hub-api, URL bỏ query/hash, breadcrumb input bị loại. Nối backend bằng `request_id` (hub-api thêm `exposedHeaders:['x-request-id']`, không mở rộng origin) và `trace_id`; tag `frontend_cause` (enum đóng: `cold_start|suspected_cold_start|slow_api|slow_frontend|network_or_cors|chunk_load|js_exception`), cold start xác định chỉ khi hub-api trả cờ (cùng cờ `slow.cold_start`), còn lại ghi rõ là suy đoán. Thêm `global-error.tsx`/`error.tsx`; source map upload chỉ ở build Vercel; không `tunnelRoute`; CSP chưa có, khi thêm phải cho `connect-src` đúng host ingest lấy từ DSN.

**Đánh đổi:** Mất replay nghĩa là một số lỗi giao diện khó tái hiện hơn; ad-blocker có thể chặn Sentry (không dùng tunnel); vitals tiêu span nên phụ thuộc `tracesSampleRate` thấp (mẫu có thể thưa); phụ thuộc thêm `exposedHeaders` ở hub-api. Chưa xác minh: con số Vercel Analytics 50.000 event/tháng (coordinator nêu, trang tôi đọc không có), bản phát hành `propagateTraceparent`, tên tuỳ chọn ẩn source map ở bản cài, định dạng host ingest theo vùng. Chi tiết: `docs/LOGGING.md` §11.9.

## ADR-249 — Bộ theo dõi hạ tầng cho môi trường LOCAL: exporter + luật + Alertmanager + dashboard "Hạ tầng", retention 15 ngày (2026-10-18)

**Vấn đề:** Compose chỉ có Prometheus + Grafana scrape hai tiến trình app. Chưa ai đo CPU/RAM/disk/container, Postgres, Redis, RabbitMQ, nên không trả lời được câu hỏi "thời điểm" (giờ RAM bao nhiêu) lẫn "giai đoạn" (tuần này disk tăng thế nào, bao giờ đầy). Prometheus cũng không lưu bền (mất số đo khi recreate) và không có cảnh báo.

**Chọn:** Thêm vào `docker-compose.yml` (image ghim phiên bản, exporter chỉ `expose` trong mạng compose): `node-exporter` v1.8.2, `cAdvisor` v0.52.1, `postgres-exporter` v0.15.0, `redis-exporter` v1.62.0, `alertmanager` v0.27.0 + `alert-sink` (echo ghi log). RabbitMQ dùng plugin `rabbitmq_prometheus` (bật bằng `infra/rabbitmq/enabled_plugins`, KHÔNG đụng queue/topology; số tin + consumer theo queue lấy ở `/metrics/detailed` nên không phải bật `return_per_object_metrics` toàn cục). Prometheus: volume `promdata`, `--storage.tsdb.retention.time=15d` + `retention.size=2GB`, `rule_files`, trỏ Alertmanager; exporter scrape 15s (hai job app giữ 5s). Luật ở `infra/prometheus/rules/infra.yml` (recording + 21 alert, mỗi luật có `for:`/severity/mô tả tiếng Việt, gồm `predict_linear` disk 7 ngày/24 giờ và `WorkerSilent`). Receiver Alertmanager CHƯA chốt: `default` = webhook về `alert-sink`, chừa bình luận Telegram/email. Dashboard "Hạ tầng" provisioning cùng khuôn "Webhook Hub". Chi tiết và giới hạn: `docs/MONITORING.md`.

**Đánh đổi:** Chỉ cho LOCAL: `redis-exporter` đọc `INFO` 15s mỗi lần, ở deployed sẽ ăn quota lệnh Upstash (R1) nên KHÔNG chạy ở đó (deployed dùng đo của nền tảng; chỗ chừa trong MONITORING.md). `node-exporter` đo VM WSL2 của Docker Desktop chứ không phải Windows host. Docker Desktop dùng containerd image store nên cAdvisor không gắn được tên container: phải tắt `docker factory` (`--docker=unix:///nonexistent.sock`, `--docker_only=false`) để đọc cgroup thô, đổi lại chỉ có id (nhãn `container` = 12 ký tự, tra bằng `docker ps`); cAdvisor chạy `privileged`. Retention 15d tốn khoảng vài chục MB đến vài trăm MB (ước tính trong MONITORING.md), đủ cho `predict_linear` 7 ngày; dài hơn thì tốn đĩa thêm tuyến tính. Thêm ~100 MiB RAM cho 6 container mới + Prometheus phình theo TSDB. `WorkerSilent` và panel heartbeat phụ thuộc metric `hub_worker_heartbeat_timestamp_seconds` do tác vụ khác thêm: chưa có thì luật im, không báo giả.

**Bổ sung (review ADR-249, 2026-10-18):** (1) Sáu service theo dõi mới nay thuộc `profiles: ["monitoring"]` (chạy bằng `docker compose --profile monitoring up -d`): `container_name: webhook-hub-*` cố định + cổng 9093 sẽ đụng stack `hubv` của `npm run verify:up` vì `docker-compose.verify.yml` chỉ `!reset` service cũ; Prometheus bỏ `depends_on` Alertmanager nên thiếu profile thì target hạ tầng DOWN chứ stack không kẹt. Alertmanager publish `127.0.0.1:9093` (không để LAN tạo silence). (2) Câu "chưa có metric thì luật im, không báo giả" ở trên là **điểm yếu**, không phải ưu điểm: gauge `hub_worker_heartbeat_timestamp_seconds` và `hub_db_size_bytes` xuất 0 trước lần set đầu nên luật lọc `> 0`, và thêm `WorkerHeartbeatMissing` + `RabbitQueueMissing` (`absent` + target UP) để luật không mù lặng lẽ. (3) Thêm `Watchdog` (luôn bắn) + receiver `watchdog` riêng: Prometheus/Alertmanager chết thì chỉ kênh ngoài (Healthchecks.io qua `url_file`) báo được. (4) `/usr/lib/wsl/drivers` trong node-exporter chính là ổ C: Windows (VHDX Docker phình đến khi C: đầy mà `predict_linear` trên `/var/lib` không thấy): thêm nhóm luật theo ngưỡng GB tuyệt đối. (5) Số liệu đo thật: ~590 sample/s, ~11,9k series, Prometheus RSS ~148 MiB, 15 ngày ~1,1 GB (có thể chạm trần 2 GB) — số "vài chục MB" ở trên sai; giảm series bằng drop + cAdvisor 30s (ước tính còn ~0,5 GB, chưa đo lại). Số alert đúng là 27 (+5 recording). (6) cAdvisor không cần `privileged` và `/var/run` (đã thử). (7) `postgres-exporter` dùng `hub_user` SUPERUSER: giới hạn đã biết, môi trường thật phải dùng role `pg_monitor`.

## ADR-253 — Dockerfile mặc định không build `apps/web` (`BUILD_WEB`) (2026-10-18)

**Vấn đề:** Render deploy hub-api FAILED "Ran out of memory (used over 8GB)" ở `npm run build --workspaces` -> `next build` (35 worker thu thập trang). Image này phục vụ hub-api/worker/hub-all/shop, không cần web (web ở Vercel).
**Chọn:** `ARG BUILD_WEB=0`; Dockerfile chạy `npm run build:server` (libs trước, rồi hub-api, hub-worker, shop) và chỉ `npm run build -w apps/web` khi `BUILD_WEB=1`. Service `web` trong `docker-compose.yml` và `docker-compose.verify.yml` truyền `BUILD_WEB: "1"`.
**Đánh đổi:** Image mặc định không chạy được `docker-entrypoint.sh web` (thiếu `.next`); thêm workspace server mới phải thêm vào `build:server`.

## ADR-254 — Giai đoạn 2A log: chỗ lệch thiết kế LOGGING.md khi triển khai (2026-10-18)

**Vấn đề:** Triển khai `docs/LOGGING.md` (ADR-250) chạm vài chỗ mà thiết kế viết chưa tính tới: `logger` pino tạo một lần ở import nên không có "base" theo tiến trình; `/hooks` là đường CHƯA xác thực; thay đổi mã HTTP/nhãn metric làm vỡ vài test; bão lỗi hạ tầng làm "luôn ghi lỗi" thành bão log; `classifyInfraError` nằm ở hub-worker mà ingest (hub-api) cần.

**Chọn:** (1) `svc` đặt bằng `mixin` + `setServiceName()` ở `main.ts` thay vì `base` (base cố định lúc tạo pino, mà module nào cũng import `logger` ở top-level); dòng canonical vẫn mang `svc` tường minh. (2) `traceparent` đến từ client chỉ được nhận ở `POST /v1/p/:project/events` (đã xác thực API key); `/hooks` LUÔN sinh trace mới — provider chưa xác thực không được chọn `trace_id`/`correlation_id` (§4 viết "nếu request có traceparent hợp lệ thì dùng" cho cả hai). (3) Lỗi hạ tầng tạm thời trong tx ingest (`classifyInfraError` = transient: P2024/P1001/ECONNRESET…) trả **503 `service_unavailable`** (khuôn ERRORS.md) + `fail.hub_db`; lỗi lạ giữ **500** + `fail.hub_unknown` (test cũ ingest-catchnet/invariants đòi 500 cho lỗi thường). `classifyInfraError` dời về `@hub/database` (worker re-export). (4) Gộp dòng lặp (`LOG_DEDUPE_WINDOW_MS`, kèm `suppressed`) áp cho `wrong.signature|unknown_source|payload_shape|policy_blocked`, `slow.deferred_*` VÀ `fail.hub_db|hub_broker|hub_redis` (DB rớt làm MỌI message lỗi mỗi nhịp retry — đã đo 225 dòng/s, ADR-231); `fail.hub_unknown|poison_message|dest_*|exhausted` và `slow.*` còn lại luôn ghi. Metric `hub_log_events_total` vẫn đếm đủ. (5) `growth.window` lấy dữ liệu từ CHÍNH các canonical line qua observer (kể cả dòng bị mẫu bỏ) — không thêm điểm đo ở đường nóng, 0 Redis/DB; `growth.storage` chưa có tốc độ byte/giờ (chỉ ánh xạ `ALERT_RULES` → cause). (6) Nhãn `cause` thêm vào `hub_ingest_requests_total` và `hub_deliveries_total` đúng §7 nên regex 3 test cũ (penalty-box/penalty-gate) cho phép nhãn thừa; hai test khoá khoá-payload outbox (`normalize-consumer`, `replay-message`, `replay-bulk`) thêm `traceparent` (xem ADR-255). (7) Header `x-hub-cold` đặt cho phản hồi đầu tiên KHÔNG phải health/metrics/OPTIONS sau khi khởi động (nếu tính health thì cờ bị Render tiêu trước người dùng) và cùng cờ với `slow.cold_start`; `exposedHeaders` = `x-request-id`, `x-hub-cold` (§11.9d đòi, không mở rộng origin/credentials).

**Đánh đổi:** Bảng cause/log có thêm bề mặt phải giữ đồng bộ (đã có test khoá). 503 thay 500 cho lỗi DB tạm thời đổi mã HTTP provider thấy (đều không phải 2xx — BB-3 giữ; hầu hết provider retry cả hai). Gộp dòng hạ tầng nghĩa là log không đếm được số lần — dùng metric. Chưa làm: bảng `StageReason` (console) thêm `cause`/`blame` (đợt 2B, frontend), Sentry, k6 đo p95 trước/sau (§6 "đồng bộ").

## ADR-255 — Ngữ cảnh trace/thời gian đi bằng HEADER AMQP, không vào body message delivery (2026-10-18)

**Vấn đề:** §4 cần `traceparent`, mốc publish, tuổi outbox đi relay → normalize → delivery → retry, nhưng `DeliveryMessage` bị khoá đúng 7 khoá (S1-1/ADR-042, `DELIVERY_MESSAGE_KEYS`) và thêm khoá vào message là phá hợp đồng "chỉ tham chiếu".

**Chọn:** Payload outbox là JSON tự do nên `traceparent` (+ `replayOf` cho replay, `ingestedAt` cho ingest) nằm TRONG payload outbox; relay đọc rồi đặt vào header AMQP `traceparent` / `x-replay-of` (+ `x-outbox-age-ms` từ `age_s` đã SELECT sẵn, thuộc tính `timestamp` = lúc publish) và **bỏ khỏi body của message `delivery.*`** (body vẫn đúng 7 khoá; test `log-contract` khoá điều này). Consumer republish (retry/hoãn/DLQ) giữ `traceparent` (span chặng này làm cha), đặt `x-due-at` = lúc tầng hoãn hết hạn và bỏ `x-outbox-age-ms`; `queue_wait = now − max(published_ts, due_ts)` nên chờ cố ý của tầng retry không bị tính là sự cố. Replay (`api.controller`, đơn lẻ và hàng loạt) sinh trace MỚI + `replayOf` = trace_id gốc. `webhook.sender` gửi thêm header `traceparent` ra đích, KHÔNG nằm trong chuỗi ký. Header là thứ mất được (message cũ, replay thủ công) → worker sinh trace mới và ghi `trace_origin` (`correlation` nếu suy được từ `correlationId` UUID, `orphan` nếu không), không bao giờ lỗi.

**Đánh đổi:** Dòng outbox `delivery.*` trong Postgres có 8 khoá (thêm `traceparent`) — test khoá khoá-payload của outbox (không phải của message trên dây) phải cập nhật. AMQP `timestamp` chuẩn tính bằng giây; ta ghi mili-giây (số lớn) và bên đọc tự nhận ra đơn vị — RabbitMQ không diễn giải thuộc tính này. Retry tầng 1m/5m: broker đẩy lại message qua dead-letter nên `timestamp` của relay mất, chỉ còn `x-due-at` (đủ cho công thức).

**Bổ sung ADR-254 (review 2A, 2026-10-18; ADR append-only):** (a) Mục (6) đếm thiếu: số test cũ phải chỉnh là **2 spec regex nhãn metric** (`penalty-box`, `penalty-gate` — nay siết đúng `cause="wrong.policy_blocked"`) và **3 spec khoá khoá-payload outbox** (`normalize-consumer`, `replay-message`, `replay-bulk`). (b) Scrub đệ quy: `formatters.log` của pino chạy `scrubDeep` (chuỗi ở mọi cấp object/mảng thuần, sâu ≤ 8, ≤ 60 phần tử/mảng, ≤ 200 khoá/object; Error/Buffer/lớp lạ giữ nguyên) — lưới thứ hai, không thay việc không đưa dữ liệu vào; mọi `{ err }`/`err.message` thô trên đường ingest/delivery đổi sang `errInfo` (Prisma chỉ code + model). Giới hạn: văn bản tự do trong message lỗi KHÔNG phải Prisma chỉ được scrub theo mẫu (`whsec_`, `hk_`, Bearer, số ≥ 9 chữ số, URL chỉ giữ host, bỏ userinfo), không phát hiện được bí mật không theo mẫu. (c) 503 `service_unavailable` của ingest dùng `x-request-id` hợp lệ (nếu có) hoặc correlationId làm `requestId`, kèm `Retry-After: 5`; dòng `ingest.done` mang `request_id` đó.

## ADR-256 — `scrubDeep` không bao giờ giữ nguyên phần chưa scrub (review 2A lần 2, 2026-10-19)

**Vấn đề:** `scrubDeep` (pino `formatters.log`, mọi dòng log) trả NGUYÊN giá trị khi sâu ≥ 8 và với mọi lớp lạ — kể cả `Error` (message + stack chứa `hk_live_…` ra log vì `formatters.log` chạy trước serializer `err`), instance class có field secret.

**Chọn:** Vượt trần sâu -> `'[deep]'`; `Error` -> `{class, message, code, stack, meta}` qua `errInfo` + `scrubSecrets` (Prisma: chỉ code + model, bỏ stack/message vì chứa tham số truy vấn); Buffer/TypedArray/Map/Set -> nhãn; Date -> ISO; lớp lạ khác duyệt như object (own enumerable, có scrub); mảng/object bị cắt có dấu `'[truncated N]'` / `__truncated`. Khoá `class` thay vì `type` vì serializer `err` của pino ghi đè `type` bằng tên lớp của object thuần (`Object`).

**Đánh đổi:** Mất `cause`/thuộc tính tuỳ ý của Error (chỉ giữ code/meta) và `stack` bị cắt 4000 ký tự; Error ra log có thêm khoá `class`. Test bãi mìn khoá cả 5 trường hợp; các chỗ log `{ err }` thô (main.ts, realtime.gateway, redis.service, alert-email.sender, storage.job) nay an toàn mà không phải sửa từng chỗ.

**Bổ sung ADR-256 (review 2A lượt 3, 2026-10-19):** (a) `scrubDeep` bọc try/catch TỪNG nút — getter ném, Proxy trap ném/đã revoke, Error có getter ném -> nhánh đó thành `'[unserializable]'`, `log.*()` không bao giờ ném (gốc không đọc được -> `{scrub:'[unserializable]'}`). (b) `class` và `code` của lỗi qua `scrubSecrets` TRƯỚC khi cắt (`errInfo`); khoá object cũng scrub. (c) `Error.cause` được giữ ở khoá `causedBy` (không phải `cause`: serializer `err` của pino bỏ khoá `cause` của object thuần), đi qua scrubDeep cấp +1, trần sâu 8 chặn cause vòng. (d) Bindings của `logger.child({...})` KHÔNG qua `formatters` (pino reset `formatters.bindings` cho child) nên `createLogger` bọc `child` và `setBindings` MỘT lần trên logger gốc (con kế thừa bản bọc qua prototype và gọi `child` gốc của pino với đúng `this` — lần đầu dùng `bind(cha)` làm con của con mất bindings của cha, review lượt 4); `createLoggerWithContext` nhờ đó an toàn. (e) Test khoá trần 60 phần tử/200 khoá (dấu `[truncated N]`/`__truncated`). Đánh đổi: thêm try/catch từng nút + scrub stack Error + scrub khoá object (khoá < 8 ký tự bỏ qua regex): reviewer bench 100k dòng (10 trường, 1 Error có secret) HEAD 33,5 µs/dòng, bản lượt 3 44,9 µs/dòng (+~11,5 µs, +35%, chủ yếu scrub stack và khoá). Đối số format object (`log.info('m %j', {...})`) cũng qua scrubDeep; nợ còn lại: `child()` gọi bằng `logger.child` của pino con tạo qua API khác (vd `pino.child` trên prototype) không được bọc — hub chỉ tạo child qua `logger.child`.

**Bổ sung ADR-256 (review 2A lượt 5, 2026-10-19):** (a) `logMethod` không bao giờ ném: lần 1 gọi pino với đối số đã scrub, nếu pino ném (vd `'m %s', {toString(){…}}`) thì gọi lại với đối số format thành chuỗi an toàn (`JSON.stringify(scrubDeep)` / `String`, rồi `scrubSecrets`; lỗi -> `'[unserializable]'`), vẫn ném thì nuốt (mất dòng log, không ném vào nghiệp vụ). (b) Đối số ĐẦU là `Error`: chuyển thành `[{err}, msg-đã-scrub, …]` (pino lấy `msg` từ `err.message` thô — lọt có sẵn từ HEAD); đối số Error ở vị trí format -> `${class}: ${message}` đã scrub. (c) Cơ sở tối ưu khoá < 8 ký tự bỏ qua regex: mọi mẫu của `PATTERNS` khớp tối thiểu >= 8 (nhỏ nhất là `hub_csrf=` + 1 ký tự = 10); `MIN_SECRET_MATCH_LEN` + `PATTERN_MIN_SAMPLES` trong `auth/redact.ts` và test `redact-min-match.spec.ts` đỏ nếu ai thêm mẫu ngắn hơn hoặc quên đăng ký mẫu. (d) Bench reviewer lượt 5 (100k dòng, 10 trường, 1 Error có secret): HEAD 27,75 µs/dòng, bản mới 35,95 µs/dòng (+~8,2 µs, +30%). (e) Nợ Thấp: `err.type` của Error thô giờ là `Object` (serializer `err` của pino ghi đè `type`), tên lớp ở `err.class`. Object ném ở vị trí 1 trước khi tới hook formatters (`logger.info(<getter ném>, 'x')`) nay bị nuốt thay vì ném, nhưng nội dung dòng đó mất — hub không dùng dạng này.

## ADR-257 — Telegram cho Alertmanager LOCAL: template + entrypoint, secret là file gitignored

**Vấn đề:** Nối Telegram vào Alertmanager mà không đưa token/chat_id vào git. `bot_token_file` đọc được file, nhưng `chat_id` là số nguyên và Alertmanager không đọc env/file cho nó; thiếu token thì receiver Telegram không được làm Alertmanager chết.
**Chọn:** `alertmanager.yml` là template có hai khối đánh dấu (`TELEGRAM-ROUTE`, `TELEGRAM-RECEIVER`); `infra/alertmanager/entrypoint.sh` đọc `secrets/telegram_bot_token` + `secrets/telegram_chat_id` (thư mục gitignored, chỉ `*.example` vào git), đủ cả hai thì điền `chat_id` và giữ khối, thiếu/sai thì cắt khối rồi `exec alertmanager` -> vẫn lên với alert-sink. Route Telegram chỉ nhận `severity=~"warning|critical"` + `continue: true` (Watchdog bị route riêng chặn, không bao giờ tới Telegram); lặp 4h (critical 1h). Văn bản tiếng Việt, parse_mode HTML mặc định (Alertmanager tự escape).
**Đánh đổi:** Config chạy thật là bản render ở `/tmp` trong container (không phải file trong repo); đổi secret phải restart container; giờ trong tin nhắn là UTC (template không đổi múi giờ). Chỉ LOCAL; deployed vẫn chưa có kênh báo (xem MONITORING TODO).

**Bổ sung ADR-257 (review độc lập, 2026-10-19):** (a) Secret hướng dẫn `chown 65534 && chmod 600`, không dùng 644 (mọi user host đọc được token); file tồn tại nhưng không đọc được log riêng, kèm cách sửa. (b) Entrypoint bỏ dòng `#`/trống, đòi đúng 1 dòng giá trị, token khớp `^[0-9]+:[A-Za-z0-9_-]+$`, chat_id `^-?[0-9]+$`; sai thì TẮT + log lý do (không bao giờ in giá trị). (c) Sau render chạy `amtool check-config`; marker lệch hoặc lỗi thì rơi về bản TẮT, cuối cùng về template gốc, không crash-loop. (d) Tin nhắn bỏ dòng Tóm tắt/Mô tả khi annotation rỗng.

## ADR-258 — Sentry backend (giai đoạn 2B): một project dùng chung hub-api + hub-worker, một cửa `reportUnexpected`, `@sentry/node` 11.8.0 (2026-10-19)

**Vấn đề:** Triển khai ADR-251 cho backend. Cần stack trace của lỗi lạ mà không để dữ liệu khách rời hệ thống, không vượt 5k errors free, không thêm lệnh Redis (R1), không làm đường hot chậm đi, và local/CI không tốn gì.
**Chọn:** (1) **Lệch ADR-251:** MỘT project Sentry, MỘT biến `SENTRY_DSN` cho cả hai tiến trình (region EU, DSN do Admin cấp), phân biệt bằng tag `svc` (không còn `SENTRY_DSN_HUB_API/_HUB_WORKER`); `SENTRY_DSN_WEB` của apps/web vẫn riêng (đợt frontend). (2) SDK **`@sentry/node` 11.8.0** (ghim đúng, `libs/common`; `engines` `>=22.12 <23` khớp Node 22.22 của repo; không dùng `@sentry/nestjs`: filter của repo đã có sẵn, không cần module/interceptor của SDK). `defaultIntegrations:false` — SDK không tự bắt uncaught/unhandled (sẽ bỏ qua cổng blame), không breadcrumb, không OTel (`enableOpenTelemetrySetup` mặc định false ở v11; không đặt `tracesSampleRate`). (3) **Một cửa** `reportUnexpected(err, ctx)` (`libs/common/src/sentry.ts`): chỉ gửi khi `CAUSES[cause].blame==='hub'` VÀ cause ∈ `SENTRY_CAUSES` (`fail.hub_unknown`, `fail.poison_message`); lỗi hạ tầng tạm thời bên gọi phân loại (`infra`) thì bỏ. Nối ở đúng 4 chỗ: móc `setUnexpectedHook` trong `CanonicalLogger.emit` (phủ ingest 500, normalize, delivery — một điểm, nhận lỗi thô còn stack), nhánh `status>=500 && !==503` của `ServiceExceptionFilter` (+ lỗi lạ ngoài đường dev-facing), catch ngoài cùng của outbox relay (chỉ `fail.hub_unknown`), `uncaughtException` (cũng hứng `unhandledRejection`; giữ hành vi cũ: log, flush ≤2s, `exit(1)`). (4) **Không bộ lọc thứ hai:** lỗi vào Sentry qua "thế thân" (message = `errInfo(err).msg`, class = `errInfo.class`, chỉ giữ dòng frame của stack qua `scrubSecrets`; Prisma chỉ code+model); `beforeSend` bỏ `request/user/breadcrumbs/extra/server_name/modules`, tag theo allowlist, context chỉ `trace|runtime`, rồi `scrubDeep` cả event (ADR-256); bỏ `ECONNRESET/EPIPE/abort`; `sendDefaultPii:false` + `dataCollection` tắt hết (body, header, cookie, query, user). (5) Fingerprint `[svc, cause, class, chặng]` (chặng ổn định từ `msg` của canonical line: ingest|normalize|delivery, hoặc relay|http|process) — thêm `svc` so với đề bài vì dùng chung project; dedupe `SENTRY_DEDUPE_WINDOW_MS` (5 phút) + trần `SENTRY_MAX_PER_MIN` (10) đếm trong bộ nhớ; vượt trần -> `dropped++` + một dòng warn/phút. (6) Không `SENTRY_DSN` -> `initSentry` return ngay: không `require` SDK, không handler toàn cục, hook không đặt; SDK nạp bằng `require` có điều kiện. Flush ≤ 2s: hub-api qua `onShutdownFlush`, hub-worker trước `process.exit(0)` (nằm trong `SHUTDOWN_TIMEOUT_MS=25000`).
**Đánh đổi:** Cô lập theo `svc` chỉ bằng tag/fingerprint, hạn mức 5k errors dùng chung hai tiến trình (một tiến trình bão lỗi có thể ăn hết phần của tiến trình kia — trần/dedupe giảm rủi ro, không loại bỏ). Chưa làm: metric `hub_sentry_events_total` (hiện `sentryStats()` + log warn), `sentry_event_id` trên canonical line, thẻ `release` tự động từ git sha (Admin đặt `SENTRY_RELEASE`). Chưa đo RSS có/không SDK ở local (LOGGING.md §11.5c) — việc cần làm khi Admin bật DSN thật. Đã kiểm bằng test L0 (transport giả + server local 127.0.0.1): secret giả không lọt, blame≠hub không gửi, trần, fingerprint, no-op khi không DSN.

**Bổ sung ADR-258 (review độc lập 2B, 2026-10-19; ADR append-only):** (0) **Phụ thuộc:** `npm ls` trước/sau giống nhau — `@sentry/node@11.8.0` -> `@sentry/bundler-plugins@11.8.0` (dependency THẬT, khai báo trong `package.json` của nó) -> `oxc-parser@0.152.0` + `sentry@0.45.0`. Gói không scope `sentry` là **Sentry CLI chính chủ** (repo getsentry/cli, maintainer `sentry-bot`/zeeg), do bundler-plugins kéo vào; KHÔNG phải do `npm i sentry`/wizard. Không có install script ở 3 gói này; 18 binding `@oxc-parser/*` chỉ là entry `optionalDependencies` trong lock (máy linux-x64 chỉ cài `binding-linux-x64-gnu`); chạy thật `require('@sentry/node')` KHÔNG nạp bundler-plugins/oxc/sentry (kiểm bằng hook `Module._load`) — chúng là công cụ build (upload source map) nằm trong cây cài đặt, không vào runtime. Phương án thay thế v10.76.2 không có nhóm này nhưng bật OTel mặc định (nặng RAM Render free) nên không chọn. Việc nên làm sau: cân nhắc `npm ci --omit=optional`/`--ignore-scripts` ở Dockerfile nếu muốn thu gọn bề mặt. (1) **PII:** `fail.poison_message` và mọi `SyntaxError` (JSON.parse lộ vài ký tự đầu body) chỉ gửi class + code, bỏ message; email bị che (`***@***`) ở message, frame stack và lớp cuối của `beforeSend` (mẫu email NGẮN hơn `MIN_SECRET_MATCH_LEN` nên KHÔNG thêm vào `scrubSecrets` — giữ nguyên bất biến của `redact-min-match` và log). **Giới hạn thừa nhận:** tên người trong message tự do của lỗi "lạ" khác không phát hiện được bằng regex; rủi ro còn lại thấp vì hub không đưa dữ liệu khách vào message lỗi, nhưng không bằng 0. (2) Test khoá trần `seen` = 500 (bơm 600). (3) Dedupe + trần chạy TRƯỚC khi dựng thế thân, fingerprint dùng `errClass` rẻ (test khoá `errClass === errInfo().class`). (4) Handler crash log `err` thô (logger scrub và ghi cả stack) TRƯỚC flush. **Không** tạm ngừng consumer trong 2s flush: sau `uncaughtException` trạng thái tiến trình không còn đáng tin, không có handle consumer ở `libs/common`, và message đang xử lý chưa ack sẽ được RabbitMQ giao lại khi tiến trình chết (BB-3 giữ nguyên) — cửa sổ 2s chấp nhận. (5) hub-worker: `shutdownWithinBudget` đưa flush vào TRONG `SHUTDOWN_TIMEOUT_MS` (flush ≤ min(2s, phần còn lại)); quá hạn flush thêm tối đa 300 ms (tổng ≤ 25,3s < SIGKILL 30s). (6) Thẻ `trace_id`/`request_id`/`tenant_id`/`provider`/`attempt`/`http_status`/`origin` kiểm định dạng; sai thì BỎ thẻ (không "làm sạch").

## ADR-259 — Dải pipeline: giữ 6 ô nhưng mờ sau điểm dừng; "không có đích" là dừng có chủ đích, không phải "Thành công" (2026-10-19)

**Vấn đề:** `repo.push` không có subscription khớp hiện pill "Succeeded" xanh + `✓✓✓✓⊘⊘` — người dùng tưởng hai bước cuối hỏng/thiếu; ping và bị từ chối cũng bày ⊘ xám như lỗi.

**Chọn:** Chỉ ở `apps/web` (không đổi backend): `noDestination()` nhận biết từ summary (type chuẩn, Normalize không skipped, Định tuyến skipped, Giao total 0, không lỗi, không phải probe). `pipelineRoles()` giữ 6 ô cho thẳng cột; ô skipped SAU điểm dừng là chấm nhỏ mờ + nối nét đứt; Định tuyến của "không có đích" là ◐ trung tính kèm `0`, pill "Đã nhận · không có đích" (idle, Info); node ROUTING ở trang Chi tiết cùng quy tắc, gợi ý tạo Subscription. ⊘ chỉ còn cho dừng có chủ đích trùng/adapter bỏ qua. Màu các ca đúng (succeeded có giao, failed, in_progress, rejected) giữ nguyên.

**Đánh đổi:** Nhận biết dựa suy luận trên summary (nếu server đổi hình dạng summary phải sửa `event-notes.ts` + test); chấm mờ mất phân biệt "chưa chạy" với "không áp dụng" — tooltip ghi "không áp dụng".

## ADR-260 — Trang Nguồn có hành động "Lưu trữ nguồn" (nguồn tạo tay không còn ngõ cụt)
**Vấn đề:** hộp "Kết nối provider" của nguồn tạo tay chỉ có một câu giải thích; Admin không tìm được chỗ ngắt/xoá nguồn (UI lưu trữ chỉ có ở bản đồ luồng, ADR-161).
**Chọn:** thêm nút lưu trữ ở mọi dòng trang Nguồn (owner/operator) và trong hộp nguồn tạo tay, dùng lại `POST /sources/:id/archive` qua `useFlowArchive` — không đổi backend. Archive KHÔNG gỡ URL ở provider (chỉ xoá credentials đã lưu): nguồn có kết nối hub quản lý thì hộp xác nhận nhắc "Ngắt" trước, nguồn tạo tay thì nhắc gỡ URL ở dashboard provider.
**Quyền:** nút hiện cho developer/owner/operator (route đòi `manage:sources` + `manage:endpoints`, `roles.ts`); không copy điều kiện owner của cờ "Giữ lâu" (cần `storage:write`). Hộp xác nhận khoá nút khi đang/không đọc được kết nối (`archiveWarningMode`): chỉ 404 mới coi là tạo tay.
**Đánh đổi:** không có unarchive trên UI; archive không tự ngắt remote (đổi ngữ nghĩa backend là việc khác). Hạn chế: nguồn payos/github... tạo tay mà provider có connector thì popup kết nối chuyển sang form "Kết nối" — lưu trữ qua icon ở dòng.

## ADR-261 — Console responsive: tầng A + B, tầng C chặn bằng màn xin lỗi; chuẩn đo 360/375/390 (2026-10-19)

**Vấn đề:** Console `apps/web` chỉ ổn trên desktop; người trực sự cố mở link từ cảnh báo Telegram trên điện thoại thì bảng 7–10 cột và canvas hành trình `@xyflow` không dùng được. Làm responsive toàn bộ là quá sức, và các trang cấu hình nặng (canvas kéo thả, form JSON song song) không có ý nghĩa trên màn hẹp.

**Chọn:** Phạm vi **A + B**: A = trực sự cố (Tổng quan, Sự kiện + chi tiết, Deliveries, DLQ, Cảnh báo), B = trang cấu hình đọc/sửa nhẹ (làm ở pha sau). Chuẩn đo: Chrome DevTools device mode **360 / 375 / 390px**, không làm hỏng ≥ 1024px. Nền chung: sidebar thành ngăn kéo + nút ☰ 40px; `DataTable` nhận `mobile: MobileCardSpec` (chọn cột theo id, hàm thuần `planMobileCard`) và dưới `md` vẽ **danh sách thẻ**, từ `md` giữ bảng; `GridList stack` cho trang Sự kiện; canvas hành trình dưới `md` thay bằng `JourneyList` (cùng `stages`/`branches`, render có điều kiện — không dựng canvas ẩn); nút Replay vẫn đi qua đúng `onAction`/`ConfirmDialog` như desktop. **Tầng C** (Playground, Flow, Cài đặt dự án, API keys, Cài đặt tài khoản) KHÔNG làm responsive: `ScreenGuard minWidth` đo bằng `innerWidth` (resize + orientationchange, không đọc user-agent), hẹp hơn thì thay cả trang bằng màn xin lỗi dạng 404 (`StatusScreen`, dùng chung với `app/(admin)/not-found.tsx`), có "Về Tổng quan", "Sao chép liên kết", "Vẫn tiếp tục" (nhớ theo trang trong sessionStorage). Ngưỡng: Playground + Flow **1024px** (canvas / hai cột JSON), Cài đặt + API keys **768px** (form một cột, bảng khoá đủ từ tablet dọc).

**Đánh đổi:** Thẻ trên mobile mất sắp xếp theo cột và nút "Cột" (chỉ còn tìm kiếm); mobile đo một lần sau hydrate nên có một khung chờ ngắn thay vì nháy layout. Tầng C không dùng được trên điện thoại dọc (chủ đích — "Vẫn tiếp tục" là lối thoát). ScreenGuard giữ khung chờ lúc đo viewport: render children ẩn bằng CSS sẽ vẫn mount + gọi API ở màn hẹp, trái yêu cầu "màn hẹp không mount trang"; `DataTable` có `mobile` cũng chờ đo thay vì nháy bảng rộng. Ô thời gian: dưới `sm` "Từ"/"Đến" xếp 2 hàng full-width (giữ `datetime-local` gốc, không thêm thư viện); nếu picker gốc vẫn văng khỏi khung trong DevTools thì đó là hạn chế của DevTools (picker vẽ ở toạ độ desktop), kiểm trên máy thật. `not-found` chỉ áp cho nhóm `(admin)` vì `(shop)` có root layout riêng; URL không khớp route nào vẫn dùng 404 mặc định của Next.

**Bổ sung ADR-261 (pha 2, tầng B) (2026-10-19):** Làm xong phần B: Nguồn (+ popup Kết nối / Lưu trữ / Lưu lượng), Đích (+ popup endpoint), Đăng ký, Dung lượng, Nhật ký thao tác, Dự án (`/projects` và `/dashboard/projects`). Dùng lại nền pha 1, không chế mới: `DataTable mobile` cho 5 bảng — khai báo thẻ ở MỘT file `components/admin/mobile-card-specs.ts` (Next không cho `page.tsx` export thứ khác ngoài default), test `mobile-card-specs.spec.ts` khoá id cột trong spec trùng id cột thật của trang; hàng nút icon thao tác (Kết nối, Lưu trữ, Xoá…) lên cuối thẻ, cao ≥ 40px, vẫn qua `ConfirmDialog` như desktop. Chân Dialog/AlertDialog dưới `sm`: nút cao ≥ 40px (`max-sm:[&_button]:min-h-10`, chung cho mọi hộp thoại — desktop y cũ). Bộ lọc Nhật ký full-width dưới `sm`; Dung lượng giữ các thẻ sẵn có (nút gợi ý/lưu chính sách full-width), bảng chính sách tự động 4 cột để `overflow-x-auto`; bảng Top IP trong Lưu lượng ẩn cột "Lần cuối". Không đổi quyền, không đổi backend. Rà `(account)`: chỉ có Cảnh báo (đã tầng A) và Cài đặt (đã tầng C 768px) — không có trang Thành viên; không đưa thêm trang nào vào tầng C nên không cần ADR mới.

## ADR-262 — Tổng quan: chọn khoảng trên biểu đồ lọc khối sự kiện, vùng chọn ở URL (2026-10-19)

**Vấn đề:** Khối "10 sự kiện gần nhất" không cho xem sự kiện của một quãng trên biểu đồ (kiểu overview của Network tab). `/api/v1/events` chỉ có `before`/`after`/`limit`, không lọc theo thời gian; thêm backend phải qua `TenantScopedRepository` + test db.

**Chọn:** Không đổi backend. Có vùng chọn thì khối dưới dùng `GET /api/v1/flow/executions?from&to` (cùng endpoint, cùng `useExecutions` với trang Sự kiện, cursor 50/trang + "Xem thêm"); không có thì giữ `useEvents(undefined, 10)` trực tiếp. Vùng chọn là `?from=&to=` (ISO UTC, "đến" = hết bucket …:59.999) trên URL trang Tổng quan qua `useUrlParams` (replace, như list-url). Kéo chỉ vẽ lớp phủ cục bộ, nhả chuột mới ghi URL (mới truy vấn); bấm/kéo ngắn = trọn một bucket (1 giờ ở 24h, 1 ngày ở 7d), snap theo GMT+7 (không DST, mép ngày = 17:00Z) — logic thuần ở `_components/chart-selection.ts`. Đổi 24 giờ/7 ngày xoá vùng chọn. Rê dòng → vạch dọc trên biểu đồ. Mobile: chạm cột = chọn bucket (không kéo, `touch-action: pan-y`), chip bỏ chọn cao ≥ 40px. Bàn phím: mũi tên/Shift/Esc trên vùng vẽ.

**Đánh đổi:** Danh sách theo `receivedAt` còn biểu đồ đếm lượt giao theo trạng thái hiện tại nên số có thể lệch nhẹ; dòng khác kiểu (execution, không phải event thô) so với khối trực tiếp; khối theo khoảng KHÔNG có cơ chế trực tiếp riêng nhưng `useExecutions` bị invalidate qua socket nên vẫn refetch theo realtime khi khoảng gồm "bây giờ"; danh sách theo khoảng gồm cả request probe (không truyền `probes`), đúng mặc định trang Sự kiện nên "Xem tất cả" ra cùng tập; phím mũi tên gom 350ms mới ghi URL; đổi vùng chọn là replace nên Back rời trang chứ không lùi vùng chọn; trang Tổng quan phải bọc `Suspense` (useSearchParams) nên khung chờ thoáng qua.

## ADR-263 — Worker tự báo Telegram khi Neon/Upstash gần trần gói free (LOG-CAUSE 7, 2026-10-19)

**Vấn đề:** Gói free của Neon (0,5GB) và Upstash (500.000 lệnh/tháng) không có cảnh báo của nhà cung cấp; chạm trần là ingest dừng mà log chỉ nói "lỗi kết nối". Cần Admin biết TRƯỚC, ở DEPLOYED (một Web Service `hub-all`, tiến trình khởi động lại mỗi ngày do ngủ 23:10–7:00 giờ VN, ADR-240).

**Chọn:** Job nền thưa `QuotaAlertJob` trong `hub-worker` (không tiến trình mới; hub-api không chạy). Mỗi 15 phút (`QUOTA_CHECK_INTERVAL_MS`): Neon = `pg_database_size` (hàm sẵn của StorageJob) so `QUOTA_NEON_STORAGE_BYTES` (mặc định `DB_DISK_BUDGET_MB`=512MB); Upstash = MỘT lệnh `INFO` đọc `total_commands_processed` cộng dồn theo tháng UTC (delta; bộ đếm server giảm thì lấy phần mới) so `QUOTA_UPSTASH_COMMANDS_PER_MONTH`=500.000 (DEPLOYMENT §5.2); dung lượng Redis (`used_memory`) chỉ đo khi Admin đặt `QUOTA_UPSTASH_MEMORY_BYTES` (docs chưa ghi số — cần Admin xác nhận). Mức warning ≥ 80%, critical ≥ 95% (`QUOTA_WARN_PCT/CRIT_PCT`), hạ mức có đệm 2 điểm %. Chỉ gửi khi ĐỔI mức hoặc nhắc lại sau `QUOTA_REPEAT_MS` (24h). Gửi bằng `fetch` tới Bot API `sendMessage`, timeout 5s, văn bản thuần; lỗi chỉ log (token bị scrub), lần sau thử lại vì "đã báo" chỉ ghi khi gửi được. Thiếu `TELEGRAM_BOT_TOKEN` hoặc `TELEGRAM_CHAT_ID` = no-op, 1 dòng log lúc khởi động. Khoá nhịp `SET NX EX` như storage/cleanup (N worker = một lượt). Trạng thái "đã báo mức nào" + bộ cộng dồn lệnh nằm trong MỘT key Redis `quota:alert:state` (TTL 40 ngày, JSON): đọc 1 lần/lần khởi động, ghi khi gửi tin, đổi tháng, hoặc checkpoint 6h. Chi phí Redis ≈ 2 lệnh/nhịp (SET NX + INFO) ≈ 192/ngày ≈ 1,2% quota tháng + ≤ 5 lệnh/ngày cho state; đường nóng +0 lệnh (`redis-budget.spec` xanh).

**Đánh đổi:** (1) Chọn Redis thay vì bảng Postgres vì đây là trạng thái hệ thống không thuộc tenant (BB-5 không áp: không bảng nghiệp vụ, không migration/RLS) và chỉ quyết định "có nhắn thêm một tin không" — Redis mất key thì báo lại đúng một lần và bộ đếm lệnh bắt đầu lại, không bao giờ sai dữ liệu nghiệp vụ (BB-2). Đổi lại, nếu Redis chính là thứ hết hạn mức thì không ghi được state (Upstash chặn) -> bỏ lượt, không đoán. (2) Số lệnh Upstash là ƯỚC LƯỢNG: `INFO` đếm của server Redis, không phải bộ đếm billing; Upstash chưa xác nhận tính EVAL (DEPLOYMENT §5.2); lệnh dùng TRƯỚC lần đo đầu của tháng không biết (thấp hơn thật cho tới đầu tháng sau); nếu Upstash không trả `total_commands_processed` thì tài nguyên này bị bỏ qua với một dòng log cảnh báo. Không dùng bộ đếm trong bộ nhớ vì mất mỗi sáng và chỉ thấy lệnh của một tiến trình. (3) Compute-hours Neon KHÔNG đo: không có cách rẻ từ trong DB (cần API Neon + key), ghi là giới hạn. (4) Dùng chung bot/chat với đích Telegram của hệ thống là lựa chọn của Admin, hub không phân biệt. (5) Nhịp 15 phút nên phát hiện chậm tối đa 15 phút; không hạ xuống dưới 1 phút (kẹp) để không đốt quota Upstash. (6) **Giả định về `INFO` (TB-2):** `total_commands_processed` của Upstash được coi là bộ đếm ĐƠN ĐIỆU, RIÊNG cho từng database, NHẤT QUÁN giữa các lần gọi. Chưa kiểm chứng (Upstash có thể đa node/đa tenant, hai lần INFO rơi vào hai bộ đếm lệch nhau). Nếu sai: delta giữa hai lần INFO bị KẸP theo `giây trôi × QUOTA_UPSTASH_MAX_CMD_PER_SEC` (mặc định 200/s: dư >100 lần so với tải free-tier thật ≈ 0,2 lệnh/s trung bình, nhưng chặn số nhảy hàng triệu); bộ đếm GIẢM chỉ coi là reset thật khi giá trị mới ≤ mức kẹp, ngược lại BỎ mẫu, đặt lại mốc, đếm vào `anomalies` (lưu trong state, hiện trong tin nhắn) và log cảnh báo thưa 1 lần/giờ. Dao động 11M↔9M vì thế không làm `acc` phồng (test khoá). Hệ quả khi giả định sai thật: số lệnh thấp hơn thật (bỏ mẫu), không bao giờ cao giả. Kiểm chứng: chạy `INFO` vài lần cách nhau vài phút và so; theo dõi log "INFO total_commands_processed bất thường" — nhiều mẫu bất thường nghĩa là INFO không ổn định, tin vào dashboard Upstash thay vì cảnh báo này. (7) **Redis lỗi (L2):** đúng lúc Upstash hết hạn mức, khoá/đọc state thất bại; job vẫn đo Neon và dùng state TẠM trong bộ nhớ tiến trình (chỉ hub-worker chạy job nên không gửi đôi), tin kèm dòng "Redis không đọc được, đang dùng trạng thái tạm". Đánh đổi: state tạm mất khi khởi động lại nên có thể báo lại một lần sau khi Redis chưa sống lại; khi Redis sống lại thì nhập state (giữ bản ghi báo mới hơn). (8) **Trần khoảng kẹp:** mức kẹp dùng `min(giây trôi, QUOTA_UPSTASH_MAX_GAP_SEC=1800) × maxPerSec` chứ không phải toàn bộ giây trôi, vì sau khoảng ngủ đêm ~8h `elapsed × 200` lên tới ~5,76M và để lọt mẫu lệch bị coi là reset thật. Đánh đổi: bộ đếm tăng thật nhiều hơn 360k trong một khoảng ngủ dài bị coi là bất thường và bỏ (số lệnh thấp hơn thật, không cao giả; ngủ đêm thật chỉ tốn rất ít lệnh). (9) Khi đang dùng state tạm (degraded) job KHÔNG ghi Redis, để lỗi đọc tạm thời không đè state tốt; đọc lại được thì gộp (giữ bản ghi báo mới hơn) rồi ghi.

## ADR-264 — Sentry frontend (apps/web): `@sentry/nextjs` 11.4.0, một cửa, DSN trống = SDK không vào bundle, thẻ `svc=web` trong CÙNG project (2026-10-19)

**Vấn đề:** Triển khai LOGGING.md §11.9 / ADR-252 cho console (Next 16 trên Vercel). Lỗi JS trong trình duyệt không có stack trace nào ở backend; nhưng Sentry web chạy trên máy người dùng nên mọi thứ SDK thu (URL có `?token=`, header, cookie, body, breadcrumb console/fetch, Replay) đều có thể mang secret. Cần cùng triết lý ADR-258: một cửa, scrub trước khi rời, dedupe + trần, không DSN thì không gì chạy.
**Chọn:** (1) **`@sentry/nextjs` 11.4.0** ghim đúng (phát hành 2026-10-02; dòng 11.x như `@sentry/node` 11.8.0 của backend; peer `next ^16`). Bản mới nhất 11.5–11.8 đều < 2 tuần tuổi lúc chọn (11.8.0 là 15/10) nên theo quy tắc chỉ được lấy 11.4.0. Kiểm phụ thuộc: 48 mục lockfile mới, `@sentry/*` cùng 11.4.0 (cây riêng của web, song song `@sentry/node` 11.8.0 của backend vì hai nơi deploy khác nhau), `rollup` + gói native tuỳ chọn `@rollup/*`, `@rollup/plugin-commonjs`/`pluginutils`, `commondir`, `estree-walker`, `is-reference`, `stacktrace-parser`, `web-vitals` 6.2.3 (5/10), `@napi-rs/lzma-linux-x64-gnu`; KHÔNG script cài đặt mới (`hasInstallScript` chỉ còn `fsevents` sẵn có, mất cờ `dev`). `rollup` ghim `4.64.0` (2/10) làm devDependency của web vì bản trôi `4.64.10` mới 1 ngày tuổi. (2) **Một project Sentry, thẻ `svc=web`** (SDK không buộc project riêng; hạn mức 5k errors là của tổ chức nên project riêng cũng không bảo vệ hạn mức). DSN trình duyệt nằm trong JS công khai -> khuyến nghị tạo **Client Key riêng** trong cùng project (đặt rate limit, thu hồi không đụng key backend); tên biến DUY NHẤT `NEXT_PUBLIC_SENTRY_DSN` (bỏ `SENTRY_DSN_WEB` của ADR-251). (3) **Một cửa:** chỉ `lib/sentry/init.client.ts` import SDK/gọi `captureException` (test `single-door.spec.ts` quét mã); phần còn lại gọi `reportClientError`. (4) **No-op thật:** `NEXT_PUBLIC_SENTRY_DSN` được Next inline lúc build; `instrumentation-client.ts` và `report.ts` bọc `import()` SDK trong `if (process.env.NEXT_PUBLIC_SENTRY_DSN)` -> trống = nhánh chết, không chunk SDK; `next.config.mjs` chỉ bọc `withSentryConfig` khi có DSN. (5) **Scrub thuần** `lib/sentry/scrub.ts` dùng CHUNG `scrubSecrets` của libs/common + JWT/khoá nhà cung cấp/`token=…`/userinfo/email; request chỉ còn method + url bỏ query/hash/userinfo (bỏ body, cookie, header, query_string); tag theo allowlist và kiểm định dạng giá trị; context chỉ trace/browser/os/culture; chỉ giữ breadcrumb `navigation` (console/fetch/xhr/ui bị bỏ, bỏ cả integration HttpContext); lỗi `HubApiError` 4xx là có chủ đích -> không gửi. SDK 11 đã BỎ `sendDefaultPii`; tương đương là `dataCollection` tắt hết (test khoá). (6) **Dedupe 5 phút + trần 10/phút** trong bộ nhớ của tab (`gate.ts`). (7) **Replay TẮT**, không `tunnelRoute`, `tracesSampleRate` 0.1 deployed / 0 local (`SENTRY_TRACES_SAMPLE_RATE_WEB`), `sentry-trace`/`baggage` chỉ gắn vào `/api` và `/auth` (cùng origin, proxy). (8) **Nối với backend:** `HubApiError` mang `requestId` (`x-request-id`) và `cold` (`x-hub-cold: 1`) -> thẻ `request_id`, `cold`, `frontend_cause` (enum đóng: cold_start|slow_api|network_or_cors|chunk_load|js_exception); `exposedHeaders` ở hub-api đã có (cors.ts), thêm test. (9) **Source map:** chỉ khi có `SENTRY_AUTH_TOKEN` lúc build (Vercel); thiếu token -> `sourcemaps.disable`, build vẫn thành công, không sinh/ không upload; có token -> upload rồi XOÁ khỏi build (không lộ công khai), `telemetry:false`. (10) `global-error.tsx` + `(admin)/error.tsx` dùng `StatusScreen` (ADR-261), i18n vi/en, hiện `digest` chứ không hiện `error.message`.
**Đánh đổi:** (a) Hai cây `@sentry/*` (11.4.0 web, 11.8.0 backend) — nặng `node_modules` hơn, đổi lại đúng quy tắc tuổi bản phát hành; nâng cả hai lên cùng bản khi 11.8.0 đủ 2 tuần. Root vẫn còn `rollup` 4.64.10 như peer tuỳ chọn do npm tự cài cho `@sentry/bundler-plugins`, không dùng bởi build web. (b) DSN công khai dùng chung project: kẻ xấu có thể bắn event giả — giảm bằng Client Key riêng + rate limit phía Sentry, không loại bỏ. (c) Không bắt lỗi server component (`onRequestError`) và không init phía server/edge: console chủ yếu là client component; thêm sau nếu cần. (d) Ad-blocker có thể chặn ingest (không dùng tunnel). (e) Chưa đo bundle/RSS với DSN thật và chưa kiểm thủ công trên Sentry UI (cần DSN thật); việc "Bước 11 console: `cause`/`blame` vào StageReason, waterfall từ `stage_ms`" là việc RIÊNG, chưa làm.

**Bổ sung ADR-264 (sau review, 2026-10-19; append-only):** (1) `rollup` — root `package.json` có `overrides: { "rollup": "4.64.0" }` (thay devDependency của web). npm KHÔNG gỡ tự động bản 4.64.10 cũ khỏi lockfile/`node_modules` (báo `invalid ... overridden`), nên đã xoá tay các mục `node_modules/rollup` + `@rollup/rollup-*` 4.64.10 khỏi lock rồi `npm install`; kết quả: lock chỉ còn 4.64.0, `npm ls rollup` chỉ thấy 4.64.0 dưới `@sentry/nextjs` (cây `@sentry/node` 11.8.0 của backend chỉ khai rollup là peer tuỳ chọn nên không còn cài). Nâng `rollup` sau này phải sửa override. (2) `scrubSecrets` (libs/common, dùng chung backend + web) thêm `sk-ant-…`, `AIza…`, `session=|sessionid=|sid=|connect.sid=<giá trị>`; mẫu tối thiểu đã thêm vào `PATTERN_MIN_SAMPLES`. (3) **Ghi chú cho Admin khi tạo DSN thật:** trong project Sentry bật **Prevent Storing of IP Addresses** và **Data Scrubber** (Project Settings, Security & Privacy) — phòng thủ lớp hai ở phía Sentry, bổ sung cho `beforeSend`. (4) `single-door.spec` mở rộng bắt `import "…"`, `require`, `import x = require`, `export … from`.

## ADR-266 — Ô ngày giờ kiểu shadcn thay picker gốc; Ngôn ngữ + Sáng/Tối gộp vào menu bánh răng (2026-10-19)

**Vấn đề:** `datetime-local`/`date` gốc vẽ picker của trình duyệt: văng khỏi khung ở DevTools device mode, không theo màu/dark mode của giao diện, và định dạng theo locale của HỆ ĐIỀU HÀNH chứ không theo ngôn ngữ đang chọn (vi/en). Thanh trên dashboard có 4 nút icon rời (Ngôn ngữ, Sáng/Tối, bánh răng, avatar) — chật ở 360px, bánh răng bị ẩn dưới md.

**Chọn:** (1) Thêm `react-day-picker@10.0.2` (ghim chính xác, phát hành 2026-09-30; kéo `date-fns@4.4.0`, `@date-fns/tz@1.5.0` gián tiếp) và `ui/calendar.tsx`, `ui/input-group.tsx` lấy từ registry shadcn `radix-nova` (`npx shadcn add --view`), cộng `ui/date-picker-input.tsx` (Field + InputGroup + Popover `asChild` + Calendar, ↓ mở lịch, `collisionPadding`, cell 40px dưới `sm`). `TimeRange` = ô ngày + ô giờ `HH:mm` TỰ LÀM (không `type="time"`: giờ 12/24 theo hệ điều hành, bánh xe gốc trên điện thoại). Parse/format thuần ở `lib/hub/date-input.ts` (vi `dd/MM/yyyy`, en `MM/dd/yyyy`, có test). Hợp đồng `TimeRange` giữ nguyên: URL ISO UTC, "Đến" …:59.999, gom 500ms, chỉ ghi khi người xem sửa, sai khuôn / "Từ" sau "Đến" thì báo lỗi và không ghi URL. Storefront (ADR-025, không Tailwind) dùng `ShopDatePicker` = cùng `date-input.ts` + react-day-picker với CSS mặc định, không shadcn. (2) `DisplaySettings`: một DropdownMenu sau nút bánh răng ("Cài đặt hiển thị") có nhóm radio Ngôn ngữ, Giao diện (sáng/tối/theo hệ thống) và — chỉ dashboard dự án, từ md — mục "Tuỳ chỉnh bố cục…" mở `LayoutControlsPanel` cũ. Cơ chế lưu giữ nguyên (`useChangeLanguage` = thân cũ của LanguageSwitcher; `setPreference("theme_mode")`). Dùng chung ở `AccountTopBar`.

**Đánh đổi:** thêm 3 gói vào bundle console (lịch + date-fns, chỉ locale vi/en được import); mất nút đổi ngôn ngữ/theme một chạm (nay hai chạm); Nhật ký "Từ/Đến" rộng hơn ở desktop (ô ngày + ô giờ mỗi đầu); storefront có hai CSS lịch riêng thay vì dùng chung shadcn; ô giờ không có bánh xe cuộn của hệ điều hành, phải gõ.

---

ADR-267 trở đi: mỗi ADR một file trong `docs/adr/` (xem đầu file).
