# Lộ trình 14 ngày — Webhook Hub

> **Ngày 1 = 2026-09-18.** Điều kiện: làm toàn thời gian, **không đổi thứ tự**.
> Kiến trúc: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Quyết định: [`adr/README.md`](adr/README.md)

## Nguyên tắc: LÁT CẮT DỌC, không phải tầng ngang

Bản kế hoạch 12 tuần gốc xây theo **tầng ngang** — tuần 3 làm cả 3 adapter, tuần 6 mới có delivery. Nghĩa là **tuần 6 mới biết các tầng có khớp nhau không**.

Đổi sang **lát cắt dọc**: Ngày 3 có **một** đường đi xuyên hết hệ thống (GitHub → Discord), xấu nhưng thật. PayOS và SePay sau đó chỉ là *thêm một class* — mà đó đúng là điều đề tài đang tuyên bố. Vừa giảm rủi ro, vừa **tự chứng minh luận điểm Open/Closed bằng chính lịch sử commit**.

---

## Mục tiêu tuần 1 — định nghĩa "xong" (đã chốt: nghĩa B)

> Một webhook GitHub **thật**, ký HMAC **thật**, đi qua outbox → RabbitMQ → worker → Discord **thật**.
> Xấu như địa ngục, không dashboard. Nhưng **kill worker giữa chừng thì không mất message.**

Không phải nghĩa A ("có UI, bấm nút thì có chuyện xảy ra"). Nghĩa A cho cảm giác xong 70% trong 3 ngày rồi 30% còn lại ăn 6 tuần, và với đề tài chấm nặng logic core thì nghĩa A **không có điểm nào**.

---

## TUẦN 1 — Xương sống (chưa có dashboard)

### Ngày 1 — Móng
- [ ] `docker-compose.yml`: postgres:16 · redis:7 · rabbitmq:3-management · cloudflared **named tunnel** (URL cố định!)
- [ ] NestJS monorepo: `apps/hub-api` · `apps/hub-worker` · `libs/*` *(không có `hub-scheduler` — ADR-020, relay+cleanup nằm trong worker)*
- [ ] `NestFactory.create(AppModule, { rawBody: true })` — **Cạm bẫy #1, làm ngay hôm nay**
- [ ] Prisma schema đầy đủ (§6 ARCHITECTURE) + migration đầu tiên, schema `hub` và `shop` tách riêng
- [ ] ⭐ **`tenant_id` trên 5 bảng** (`sources` · `destinations` · `subscriptions` · `events` · `deliveries`) + `TenantScopedRepository` (~40 dòng) — **ADR-015. Hôm nay hoặc không bao giờ.** Unique scope theo tenant. Seed 1 tenant.
- [ ] `libs/crypto`: `hmacSha256` · `timingSafeCompare` · `aesGcmEncrypt/Decrypt`
- [ ] `libs/messaging/topology.ts` — khai báo **toàn bộ** exchange/queue/TTL ở **một chỗ** (Cạm bẫy #3)
- [ ] `/health` kiểm Postgres · Redis · RabbitMQ

**DoD:** `docker compose up` → `/health` trả 200 với cả 3 xanh. Tunnel có URL cố định. **Không truy vấn nào trong codebase đi vòng qua `TenantScopedRepository`.**

### Ngày 2 — Ingest + adapter đầu tiên
- [ ] `libs/providers/provider.interface.ts`
- [ ] `github.adapter.ts`: `verify` (HMAC trên **raw bytes**) · `extractIdempotencyKey` (`X-GitHub-Delivery`) · `normalize` · `buildAck`
- [ ] Unit test verify với **fixture payload thật** copy từ GitHub Recent Deliveries
- [ ] `POST /hooks/:provider/:sourceKey` — đúng thứ tự §3.1 (Redis `SET NX` **SAU COMMIT**)
- [ ] `raw_events` + `outbox` trong **một transaction**; lưu `body_raw` bytea
- [ ] Sai chữ ký → `status=REJECTED` + 401

**DoD:** Push code lên repo test → có 1 dòng trong `raw_events` với `signature_valid=true` và 1 dòng trong `outbox`.

### Ngày 3 — ⭐ XƯƠNG SỐNG SỐNG
- [ ] Outbox relay trong `hub-scheduler`: `FOR UPDATE SKIP LOCKED` + **publisher confirms**
- [ ] Consumer `q.normalize` trong `hub-worker`: normalize → INSERT `events` → tìm subscriptions → INSERT `deliveries` → publish
- [ ] Seed 1 destination Discord + 1 subscription `repo.push`
- [ ] Consumer `q.delivery.main` + `discord.sender`
- [ ] Template render `{{path}}` thuần (~20 dòng, KHÔNG pipe filter)

**DoD:** 🚨 **`git push` → tin nhắn hiện trong Discord.**
**Đây là cột mốc trung thực nhất. Hết ngày 3 chưa thấy tin nhắn Discord = kế hoạch 14 ngày đã hỏng, và bạn cần biết điều đó HÔM NAY, không phải ngày 11.**

### Ngày 3½ — ⭐ DEPLOY RỖNG (ADR-023) — checklist đầy đủ ở [`DEPLOYMENT.md`](DEPLOYMENT.md) §10
- [ ] Tạo 5 tài khoản, **TẤT CẢ region Singapore**: Render · Neon · Upstash · **CloudAMQP** · Vercel
- [ ] `render.yaml` Blueprint · một Dockerfile multi-stage · hai `dockerCommand`
- [ ] `prisma migrate deploy` lên Neon bằng `DIRECT_URL`
- [ ] `hub-api` (free) + `hub-worker` (Starter ~$7) lên, `/health` xanh cả 3 phụ thuộc
- [ ] Đổi webhook GitHub từ tunnel → URL Render
- [ ] UptimeRobot ping `/health` **mỗi 5 phút** (chống Render ngủ) + bật status page
- [ ] `web` lên Vercel, Socket.IO kết nối được qua CORS

**DoD:** `git push` → Discord, **đi qua hạ tầng thật**.

> Deploy lần đầu **luôn** mất một ngày. Sáu cái bẫy (region lệch · thiếu `DIRECT_URL` · không nghe `PORT` · CORS chặn handshake · CloudAMQP hết connection · SIGTERM 25s) mất **nửa giờ mỗi cái** ở đây, **nửa ngày mỗi cái** ở Ngày 13.

### Ngày 4 — Chống đạn
- [ ] 5 tầng retry queue + `x-dead-letter-exchange` quay về main + jitter ±20%
- [ ] `q.delivery.dlq` **và** `q.normalize.dlq`
- [ ] Phân loại lỗi: 4xx (trừ 408/429) → `DEAD` ngay · 5xx/timeout/mạng → retry
- [ ] Manual ack + `prefetch=20` khắp nơi
- [ ] Graceful shutdown (SIGTERM → drain → timeout 30s)
- [ ] Circuit breaker trong Redis (CLOSED/OPEN/HALF_OPEN)
- [ ] `processed_messages` + job cleanup > 7 ngày

**DoD:** `docker kill hub-worker` giữa lúc đang xử lý → restart → **đếm được 0 message mất**.

### Ngày 5 — Adapter #2, #3 + outbound có ký ⏱️
- [ ] `payos.adapter.ts` — **bấm giờ, ghi lại số phút**
- [ ] `sepay.adapter.ts` — **bấm giờ, ghi lại số phút**
- [ ] `webhook.sender` ký Standard Webhooks (`X-Hub-Event-Id` / `X-Hub-Timestamp` / `X-Hub-Signature`)
- [ ] SSRF guard: resolve → kiểm IP → **pin IP** → `maxRedirects: 0` (§7.3)
- [ ] `telegram.sender`
- [ ] Đăng ký webhook PayOS (Cạm bẫy #4 — làm SAU khi adapter chạy)

**DoD:** 3 nguồn vào được, 3 đích ra được. **Hai con số thời gian viết adapter đã ghi vào ADR** — đây là bằng chứng định lượng cho luận điểm Open/Closed.

### Ngày 6 — Shop (TRẦN 300 DÒNG) — Vercel route handlers, ADR-022
- [ ] `apps/shop`: schema `shop`, bảng `orders`, optimistic locking bằng `version`, Neon **pooled** connection
- [ ] `GET /products` (hardcode) · `POST /orders` (tạo link PayOS)
- [ ] `POST /hub-webhook`: verify chữ ký → timestamp lệch > 5 phút thì từ chối → chống trùng theo `X-Hub-Event-Id` → khớp `DH\d+` → so tiền → PAID/UNDERPAID/unmatched
- [ ] `POST /api/internal/reconcile` (có `X-Internal-Token`) + **GitHub Actions cron `*/5`** gọi vào — Vercel Hobby cron không đủ (ADR-022)

**DoD:** Chuyển 2.000đ **thật** qua PayOS → đơn tự chuyển PAID. **Đếm dòng `apps/shop` ≤ 300.**

### Ngày 7 — Realtime + dashboard tối thiểu
- [ ] Socket.IO gateway + JWT trên handshake + room theo user/order + client ép `transports: ['websocket']`
- [ ] `RealtimeNotifier` interface + `RedisNotifier` (ADR-021, ~30 dòng) — worker publish qua đây mỗi lần đổi trạng thái
- [ ] `metrics.tick` **5s, đếm trong bộ nhớ**, không chạm Redis mỗi tick (DEPLOYMENT §5.2)
- [ ] **Live Events** — dòng sự kiện chảy, lọc theo nguồn/loại/trạng thái
- [ ] **Event Detail** — tab Raw / Normalized / Deliveries (timeline từng lần thử) + nút **Replay** (`attempt_generation + 1`)
- [ ] **DLQ** — danh sách, lý do, replay đơn lẻ + hàng loạt

**DoD:** Push code → thấy sự kiện xuất hiện realtime, bấm Replay → Discord nhận lại.

---

## TUẦN 2 — Chịu tải, đo đạc, chống đạn

> ⚠️ Tuần 2 **không phải** "chỉ fix bug". Nó là đo đạc + chaos test + 4 trang dashboard. Công việc thật, kín lịch.

### Ngày 8 — Quan sát
- [ ] `prom-client` → `/metrics` (5 metric ở §8)
- [ ] Prometheus + Grafana vào compose, commit sẵn 1 dashboard JSON
- [ ] `correlation_id` xuyên suốt qua AMQP headers + pino JSON
- [ ] Trang **Overview** + `metrics.tick` mỗi 2s

### Ngày 9 — Đo tải
- [ ] Script k6 (bắn **localhost**, KHÔNG qua tunnel — Cạm bẫy #6)
- [ ] Đo p95 ingest · throughput · p95 end-to-end
- [ ] `--scale hub-worker=1 → 3 → 5`, chụp RabbitMQ UI + Grafana mỗi mốc
- [ ] **Ghi số thật + cấu hình máy vào báo cáo**

### Ngày 10 — Chaos
- [ ] Kill worker giữa chừng → đếm mất mát (kỳ vọng 0%)
- [ ] Tắt Shop → RETRYING → bật lại → tự giao
- [ ] Đích lỗi liên tục → circuit OPEN → DLQ → Replay
- [ ] **Tắt Redis** → hệ thống vẫn đúng, chỉ chậm (chứng minh BB-2)
- [ ] Tắt RabbitMQ → outbox giữ lại, bật lại thì đẩy tiếp
- [ ] Ghi kết quả từng cái vào báo cáo

### Ngày 11 — Dashboard còn lại + storefront
- [ ] **Unmatched Payments** — gán tay vào đơn *(trang duy nhất có người dùng thật lúc 2h sáng)*
- [ ] **Poison Events** — `q.normalize.dlq`
- [ ] **Sources** (copy URL, xoay secret, lần nhận gần nhất) · **Destinations & Subscriptions** (Gửi thử)
- [ ] Storefront 3 trang: sản phẩm · thanh toán (QR) · trạng thái đơn đổi realtime

### Ngày 12 — Siết + khép khoảng cách với Svix (ADR-016, ~2,5h)
- [ ] ⭐ **Outbound throttle per destination** (~1h) — token bucket Redis, dùng lại code rate limit inbound, đổi key. `destinations.rate_limit_rps`
- [ ] ⭐ **Polling endpoint** `GET /api/v1/events?after=<cursor>` (~1h) — cursor = `events.id` (ULID), scope theo tenant
- [ ] ⭐ **Tự cảnh báo** (~30') — circuit OPEN → hub bắn Telegram bằng chính `telegram.sender` của nó
- [ ] "Send Example" payload mẫu theo event type trên trang Destinations
- [ ] Xoay secret inbound (`source_secrets` nhiều version) + outbound (2 chữ ký)
- [ ] `audit_logs` cho mọi replay / sửa cấu hình
- [ ] Unit test: adapter verify+normalize · tính backoff · state machine · template
- [ ] Integration test Testcontainers: ingest → DB → RabbitMQ

**DoD:** Bảng đối chiếu Svix (§16 ARCHITECTURE) không còn ô vàng nào.

### Ngày 13 — Hoàn thiện deploy + tập demo
> Deploy đã làm từ Ngày 3½ — hôm nay chỉ là đồng bộ bản cuối, không phải deploy lần đầu.
- [ ] Push bản cuối lên Render + Vercel, chạy lại checklist `DEPLOYMENT.md` §10
- [ ] Kiểm ngân sách: dung lượng Neon · lệnh Upstash · message CloudAMQP còn lại
- [ ] Chụp status page UptimeRobot vào báo cáo
- [ ] Tập demo **bấm giờ**, theo thứ tự §12 ARCHITECTURE — **nhớ: kịch bản 1–4 chạy ở LOCAL, kịch bản 5–9 chạy ở DEPLOYED** (ADR-019)

### Ngày 14 — Dự phòng
Bạn **sẽ** cần. Đừng lên lịch gì vào đây.

---

## ⚠️ Chưa tính vào 14 ngày

Báo cáo · slide · tập dượt trước hội đồng = **thêm ít nhất 3–4 ngày nữa**. Cộng vào lịch bảo vệ ngay từ bây giờ.

## Việc làm mỗi ngày, tốn 2 phút

Mỗi khi quyết định một thứ → ghi **3 dòng** vào [`adr/README.md`](adr/README.md): vấn đề — chọn gì — đánh đổi gì.

Ghi lúc đang làm: 2 phút. Ghi lại sau khi xong: hai ngày, và bạn sẽ bịa — **bịa sai**, vì người ta quên lý do thật của quyết định của chính mình sau đúng bốn ngày. Đề tài này chấm nặng *architecture và hiểu bản chất*: thứ được chấm không phải code bạn viết, mà là **lý do bạn viết như thế**.
