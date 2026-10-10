# WEBHOOK HUB — Tài liệu kiến trúc (bản chốt)

> **Trạng thái:** CHỐT · **Ngày chốt:** 2026-09-17 · **Ngày 1 bắt đầu:** 2026-09-18
> Tài liệu này là **nguồn sự thật** về kiến trúc. File ý tưởng gốc `webhook-hub-y-tuong.md`
> chỉ còn giá trị tham khảo — chỗ nào mâu thuẫn, **file này thắng**.
>
> Liên quan: [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) · [`docs/adr/README.md`](adr/README.md) · [`docs/ROADMAP-14D.md`](ROADMAP-14D.md) · [`CLAUDE.md`](../CLAUDE.md)
>
> **Triển khai:** Render (hub-api, hub-worker) · Vercel (web, shop) · Neon · Upstash · CloudAMQP — **tất cả region Singapore**. Chi tiết và ràng buộc free tier ở `DEPLOYMENT.md`.

---

## 0. Bốn bất biến (không được vi phạm)

Mọi quyết định code phải thoả cả bốn. Phá một trong bốn = bug kiến trúc, không phải đánh đổi.

| # | Bất biến | Lý do tồn tại |
|---|---|---|
| **BB-1** | **Hub không biết "đơn hàng" là gì.** Không có `orderCode`, regex `DH\d+`, hay bảng `orders` trong `apps/hub-*`. | Hub là hạ tầng generic. Nhét nghiệp vụ vào lõi là phá luận điểm Open/Closed của cả đề tài. |
| **BB-2** | **PostgreSQL là trọng tài duy nhất của idempotency.** Redis chỉ là đường tắt và **được phép sai**. | Redis mất dữ liệu → hệ thống chậm đi, **không sai**. |
| **BB-3** | **Không bao giờ trả 2xx cho provider trước khi `COMMIT` thành công.** | ACK sớm = mất sự kiện vĩnh viễn, vì provider sẽ không retry nữa. |
| **BB-4** | **`hub-api` và `hub-worker` là hai tiến trình tách rời ngay từ Ngày 1.** | Khả năng mở rộng là *hình dạng* hệ thống, không phải tính năng cắm thêm ở tuần 2. |
| **BB-5** | **Mọi bảng nghiệp vụ mang `tenant_id`, mọi truy vấn đi qua guard scope.** Không truy vấn trực tiếp không scope. | Multi-tenancy là thứ thêm được trong 30 phút ở Ngày 1 và tốn nửa ngày ở Ngày 10. Xem ADR-015. |

---

## 1. Bài toán

Mỗi nền tảng gửi webhook theo định dạng riêng, xác thực riêng, cơ chế retry riêng. Tích hợp trực tiếp từng cái → code lặp, mất sự kiện khi đích sập, xử lý trùng, không có nơi tra cứu và phát lại.

**Webhook Hub** = trạm trung chuyển: **nhận** từ nhiều nguồn → **chuẩn hoá** về một schema chung → **phân phối** đến nhiều đích một cách **tin cậy** (không mất, không trùng, tự phục hồi, quan sát được).

**Triết lý:** *bề ngoài nhỏ gọn, bên trong chặt chẽ.* Toàn bộ giá trị nằm ở backend.

---

## 2. Ranh giới hệ thống (quyết định quan trọng nhất)

Hai domain tách bạch, giao tiếp **chỉ** qua outbound webhook có ký HMAC.

```
+-- DOMAIN A: HUB — hạ tầng generic ----------------------------+
|                                                               |
|   hub-api      Ingest + REST + Socket.IO        scale ngang V |
|   hub-worker   normalize+route | deliver        scale ngang V |
|                + outbox relay (SKIP LOCKED)                   |
|                + cleanup (Redis lock)           <- ADR-020    |
|                                                               |
|   DB schema: `hub`                                            |
|   Không biết: đơn hàng, tiền, khách hàng, nghiệp vụ           |
+---------------------------------------------------------------+
                      |
                      |  POST + X-Hub-Signature (HMAC-SHA256)
                      |  <- ranh giới thật, KHÔNG chia sẻ DB
                      v
+-- DOMAIN B: SHOP — nghiệp vụ, là KHÁCH HÀNG của Hub ----------+
|                                                               |
|   shop-api       orders · khớp mã đơn · đối soát PayOS        |
|   DB schema: `shop`   <- Hub KHÔNG BAO GIỜ chạm vào           |
|   Trần cứng: 1 bảng · 3 endpoint · 1 cron · ~300 dòng         |
+---------------------------------------------------------------+

   web (Next.js) --> hub-api   (dashboard quản trị)
                 --> shop-api  (storefront 3 trang)
```

### Tại sao tách (ADR-001)

Bản ý tưởng gốc để `Order Matcher` làm worker **bên trong hub** và `orders` nằm chung schema — hub vừa ghi thẳng vào `orders`, vừa gửi webhook cho Shop để Shop cũng ghi vào `orders`. **Hai writer, một bảng, không ranh giới.**

Tách ra mua được ba thứ:

1. **Giữ BB-1** — hub thật sự generic, trả lời được câu hỏi *"thêm GitHub thì Order Matcher làm gì?"*
2. **Shop trở thành bằng chứng sống** rằng hub là nhà cung cấp webhook thật (có ký, chống replay, idempotency phía nhận) — không phải đồ trang trí.
3. **Đối soát PayOS về đúng chỗ** — câu hỏi *"đơn này trả tiền chưa?"* là câu hỏi của Shop, không phải của Hub.

**Giá phải trả:** ~300 dòng. Chấp nhận.

### Chống phình Shop (trần cứng)

`apps/shop` **chỉ được có**:

- `GET  /products` — mảng 4 sản phẩm hardcode trong file (2.000đ – 10.000đ)
- `POST /orders` — tạo đơn, gọi PayOS tạo link thanh toán, trả QR
- `POST /hub-webhook` — verify chữ ký hub → chống replay theo timestamp → khớp `DH\d+` → so tiền → đổi trạng thái
- `cron 5 phút` — đơn `PENDING` quá 10 phút thì hỏi lại PayOS

**KHÔNG có:** giỏ hàng · đăng nhập · kho · khuyến mãi · trang admin · tìm kiếm.

> Vượt 300 dòng = đang lạc đề. Dừng lại.

---

## 3. Luồng xử lý — 2 hop, không phải 3

```
   INGEST (hub-api)              hub-worker              hub-worker
+-------------------+  outbox  +------------------+    +---------------+
| verify            | -------> | q.normalize      | -> | q.delivery    | --> đích
| persist raw       |  relay   |   normalize      |    | render + send |
| persist outbox    |          |   + route        |    | retry / DLQ   |
| ACK 200           |          |   (cùng 1 hop)   |    | circuit brkr  |
+-------------------+          +------------------+    +---------------+
```

**Tại sao gộp normalize + route (ADR-002):** route chỉ là hàm thuần trên `(event, subscriptions cache)`. Tách thành hop riêng chỉ thêm một chỗ nữa phải lo idempotency / ack / DLQ — không thêm khả năng scale nào. Vẫn còn **2 hop** để chứng minh luận điểm "tách nhận khỏi xử lý".

### 3.1. Ingest — thứ tự BẮT BUỘC (đã sửa lỗi nghiêm trọng của bản gốc)

> ⚠️ **Bản ý tưởng gốc (mục 6.2) làm MẤT sự kiện.** Nó `SET NX` vào Redis **trước** transaction. Postgres chết giữa chừng → Redis key vẫn còn → provider retry → hub trả "200 duplicate" → sự kiện biến mất vĩnh viễn và provider tưởng đã giao thành công.

```
1.  Giữ nguyên raw bytes (rawBody middleware) · chặn payload > 1MB
2.  Rate limit theo source (cửa sổ CỐ ĐỊNH 60s, 1 lệnh EVAL INCR+EXPIRE, trần INGEST_RATE_LIMIT_PER_MIN;
    Redis chết -> fail-OPEN + log cảnh báo)
3.  Nạp source + secrets (Postgres, escape hatch duy nhất không scope tenant) · adapter.verify(rawBytes, headers, secrets[])
       sai chữ ký -> lưu MẪU raw_events(status=REJECTED, ≤4KB, ≤20/phút/source) -> 401 -> DỪNG
    Header nhạy cảm che trước khi lưu (ADR-051); signature_header = adapter.extractSignature(req) (S3-1)
4.  key = adapter.extractIdempotencyKey(req)
5.  GET idem:{sourceId}:{key}          <- đường tắt, chỉ ĐỌC
       hit -> trả ACK duplicate -> DỪNG (không chạm DB)
6.  BEGIN
      INSERT raw_events (...)          <- UNIQUE(source_id, idempotency_key)
         unique violation -> ROLLBACK -> TRÙNG THẬT -> trả ACK duplicate
      INSERT outbox (topic='event.received', payload={rawEventId, correlationId})
    COMMIT                              <- BB-3: chỉ SAU dòng này mới được ACK
7.  SET idem:{sourceId}:{key} NX EX 86400    <- SAU COMMIT. Lỗi ở đây: mặc kệ.
8.  adapter.buildAck() -> trả đúng định dạng provider mong đợi
```

**Nguyên tắc:** ingest **không gọi bất kỳ dịch vụ ngoài nào**. Chỉ verify → lưu → trả lời. Mục tiêu p95 < 100ms.

Rollback vì lý do khác (không phải unique) → trả **5xx** để provider retry. (Không cần `DEL idem`: `SET NX` chỉ chạy SAU `COMMIT`, nên rollback thì khoá Redis chưa từng được ghi.)

**Khoá chống trùng dự phòng** (thiếu id của provider) = `sha256(rawBody)` 32 hex — **không bao giờ ngẫu nhiên** (S3-1, ADR-058).

### 3.2. Normalize + Route

1. Nhận `{rawEventId, correlationId}` từ `q.normalize`.
2. Kiểm `processed_messages(consumer='normalize', message_id=rawEventId)` → đã xử lý thì `ack`, bỏ qua.
3. Đọc `raw_events` qua `TenantScopedRepository` · `adapter.normalize(rawEvent)` → 1..n `NormalizedEvent` theo **catalog kiểu chuẩn** (`docs/EVENT-CATALOG.md`, ADR-053/059).
4. Kiểu thuộc không gian dành riêng (`payment.*`, `repo.*`) mà `data` sai khuôn → **lỗi vĩnh viễn**, không ghi gì (metric `hub_normalize_schema_errors_total`).
5. **Một transaction:** INSERT `events` · tìm `subscriptions` khớp `event.type` (khớp chính xác hoặc mẫu `payment.*`/`*`, S3-3 — truy vấn Postgres, không cache) · INSERT `deliveries` · INSERT `outbox(topic='delivery.requested')` cho từng delivery · INSERT `processed_messages`. Rồi `ack`.
6. **Không publish thẳng** lên `x.hub.delivery`: relay đọc outbox `delivery.requested` và publish (S1-2, ADR-043). Một PUBLISH Redis `hub:realtime:events` sau COMMIT (best-effort).
7. Lỗi **tạm** (Prisma P1001/P1002/P1008/P1017/P2024/P2028/P2034, lỗi mạng) → `q.normalize.retry.30s`, tối đa 5 lần; lỗi **vĩnh viễn** hoặc hết lượt → `nack(requeue=false)` → `q.normalize.dlq` (ADR-044). Phát lại dựa trên Postgres: `GET /api/v1/raw-events/orphans` + `POST /raw-events/renormalize`.

### 3.3. Deliver

0. Message chỉ mang tham chiếu (ADR-042); nạp delivery + event + subscription + destination bằng **một** truy vấn đã scope tenant, giải mã cấu hình đích lúc gửi. Giành **lease** `claimForSend` (ADR-043).
1. Kiểm **circuit breaker** (1 MGET). `OPEN`, hoặc `HALF_OPEN` mà không giành được probe → hoãn vào `q.delivery.retry.1m`, không tăng `attemptCount`, có trần `CIRCUIT_MAX_DEFERRALS` (ADR-048/054).
2. Kiểm **outbound throttle** (cửa sổ cố định 1 giây, chỉ khi `rate_limit_rps > 0`). Vượt → `q.delivery.retry.10s`, `ack`. *(§5.4b)*
3. Render template → gọi HTTP, timeout cứng 5s (`AbortSignal.timeout`), đọc phản hồi ≤ 64KB, **không follow redirect**, qua SSRF guard (§7.3).
4. INSERT `delivery_attempts` (status code, duration_ms, response body cắt 2KB, error).
5. `2xx` → `SUCCEEDED`, reset circuit (0 lệnh Redis nếu chưa từng lỗi), `ack`. Chỉ `5xx`/`408`/`429`/lỗi mạng tính vào circuit.
6. Lỗi **retryable** (`5xx`, `408`, `429`, timeout, lỗi mạng) → tăng `x-attempt` → publish vào tầng retry tương ứng → `ack` message cũ.
7. Lỗi **non-retryable** (`4xx` trừ 408/429 — lỗi cấu hình, retry vô nghĩa) → `DEAD` ngay, không đốt 5 lần retry.
8. Quá tầng cuối → trạng thái `DEAD` trong Postgres (**nguồn sự thật của DLQ**) + một bản sao vào `q.delivery.dlq` để quan sát.
9. Mọi đổi trạng thái → publish Redis pub/sub → Socket.IO đẩy lên dashboard.

---

## 4. RabbitMQ topology

> Khai báo topology **bằng code, một chỗ duy nhất**: `libs/messaging/topology.ts`. Không rải rác — xem Cạm bẫy #3.

```
x.hub.events (topic, durable)
   rk: event.received  ---------> q.normalize
                                     | nack(requeue=false)
                                     v
                                  x.hub.normalize.dlx --> q.normalize.dlq   <- BẢN GỐC THIẾU
   lỗi tạm -> q.normalize.retry.30s (TTL 30s, dead-letter về x.hub.events/event.received)

x.hub.delivery (direct, durable)
   rk: deliver ------------------> q.delivery.main
                                     | fail (retryable)
                                     v
   +--------------------------------------------------------------+
   | q.delivery.retry.10s    x-message-ttl = 10000                |
   | q.delivery.retry.1m     x-message-ttl = 60000                |
   | q.delivery.retry.5m     x-message-ttl = 300000               |
   | q.delivery.retry.30m    x-message-ttl = 1800000              |
   | q.delivery.retry.2h     x-message-ttl = 7200000              |
   |   mỗi queue: x-dead-letter-exchange     = x.hub.delivery      |
   |              x-dead-letter-routing-key  = deliver             |
   |   -> TTL hết thì TỰ ĐỘNG quay về q.delivery.main              |
   +--------------------------------------------------------------+
                                     | quá tầng cuối
                                     v
                       x.hub.delivery.dlx --> q.delivery.dlq  (BẢN SAO để quan sát; nguồn sự thật = deliveries.status='DEAD')

Cả hai DLQ broker bị chặn trần bằng POLICY `hub-dlq-bounded` (5000, drop-head — ADR-052).
```

**Tại sao mỗi tầng trễ một queue riêng:** RabbitMQ chỉ hết hạn message ở **đầu queue**. Per-message TTL trong một queue chung → message 2h chặn message 10s phía sau (head-of-line blocking). Mỗi tầng một queue là cách duy nhất đúng.

| Tham số | Giá trị | Lý do |
|---|---|---|
| `prefetch` | 20 | Cân bằng throughput / phân phối đều khi scale |
| ack | **manual** | Worker chết → RabbitMQ trả message về queue |
| publisher confirms | **bật** | Relay chỉ đánh dấu `published_at` sau khi broker xác nhận |
| `x-attempt` | header | Đếm số lần thử |
| jitter | **không có ở tầng retry** (xem §5.9 "Cố tình không làm") · relay ±100ms, sweeper ±10s, cleanup ±10% | TTL của queue không cho jitter theo từng message |
| durable | queue + message | Broker restart không mất |

---

## 5. Độ tin cậy

### 5.1. Transactional Outbox

Có **hai** chặng qua outbox: ingest (`raw_events` + `outbox(event.received)` cùng transaction) và normalize (`events` + `deliveries` + `outbox(delivery.requested)` cùng transaction, ADR-043). Relay chạy **bên trong mọi `hub-worker`** (ADR-020), poll mỗi ~500ms, định tuyến theo bảng `TOPIC_ROUTES`, và đọc:

```sql
SELECT * FROM hub.outbox
WHERE published_at IS NULL
ORDER BY id
LIMIT 50
FOR UPDATE SKIP LOCKED;
```

→ publish với publisher confirms → `UPDATE published_at = now()`.

`SKIP LOCKED` khiến relay **an toàn với nhiều instance** — nên **không cần Redis lock** cho relay (bản gốc nói cả hai, dư thừa), và đó chính là lý do relay chạy được trong mọi worker thay vì cần một tiến trình `scheduler` riêng. Thêm **jitter** vào chu kỳ poll để N worker không cùng đập vào bảng `outbox` một nhịp. Redis lock chỉ dùng cho job `cleanup`.

**Sweeper** (60s ± 10s) ghi lại outbox cho delivery PENDING/DELIVERING kẹt > 10 phút và RETRYING quá hạn; lease `claimForSend` đảm bảo bản trùng không gửi hai lần. **Cleanup** (mỗi giờ, khoá `cleanup:lock`) xoá theo lô outbox đã publish, `processed_messages`, `raw_events` REJECTED cũ hơn 7 ngày — **không** xoá `raw_events` ACCEPTED (ADR-045).

Kết quả: **at-least-once delivery**.

### 5.2. Idempotency — 5 chốt (khớp code sau S1-2)

| Chốt | Nơi | Ràng buộc | Vai trò |
|---|---|---|---|
| 1 | Redis | `SET idem:{src}:{key} NX EX 86400` | Đường tắt. **Được phép sai.** |
| 2 | PG `raw_events` | `UNIQUE(source_id, idempotency_key)` | **Trọng tài** (BB-2) |
| 3 | PG `events` | `UNIQUE(raw_event_id)` + `UNIQUE(idempotency_key)` | Một raw event chỉ normalize ra một bộ event, kể cả khi message normalize bị giao lại |
| 4 | PG `deliveries` | `UNIQUE(event_id, subscription_id, attempt_generation)` | Chặn fan-out trùng, **vẫn cho replay** |
| 5 | PG `processed_messages` | `UNIQUE(consumer, message_id)` | Consumer xử lý lại không gây tác dụng phụ — ghi CÙNG transaction với kết quả |
| + | PG lease `claimForSend` | `UPDATE … WHERE status/generation/attempt_count` | Chỉ một worker gửi một lần thử (chặn bản sao do sweeper/redeliver) |

Chốt 1 thực tế là hai lệnh: `GET` trước transaction (đường tắt, trả duplicate không chạm DB) và `SET NX` **sau** `COMMIT`.

**Khoá chống trùng theo provider:**

| Provider | `idempotency_key` |
|---|---|
| PayOS | `payos:{data.orderCode}:{data.reference ?? data.paymentLinkId ?? sha256(body)}` |
| SePay | `sepay:{id ?? referenceCode ?? sha256(body)}` |
| GitHub | `github:{X-GitHub-Delivery ?? head_commit.id ?? sha256(body)}` |
| Stripe | `stripe:{event.id}` (thiếu → `stripe:no-id:{sha256(body)}`) |

`sha256(body)` = 32 ký tự hex đầu của sha256 trên **bytes gốc** — provider gửi lại thì y hệt (S3-1).

**Event từ webhook:** `idempotency_key = event.id`; chống normalize lặp nhờ `processed_messages` + `UNIQUE(raw_event_id)` trong cùng transaction. *(Sự kiện phái sinh `sha256(parentEventId:type)` là thiết kế ban đầu, hiện chưa có luồng nào sinh sự kiện phái sinh.)*

> at-least-once + idempotent consumer = **effectively-once**.

### 5.3. Replay

`attempt_generation` là chìa khoá. Bản gốc dùng `UNIQUE(event_id, subscription_id)` → replay event = chạy lại routing = đụng unique = chết.

- **Replay 1 delivery** → `attempt_generation + 1`, INSERT bản ghi mới, publish. Lịch sử cũ giữ nguyên.
- **Replay 1 event** → chạy lại routing với generation mới cho mọi subscription.
- **Replay hàng loạt** → lọc DLQ theo destination / khoảng thời gian / lý do lỗi.

Mọi replay ghi `audit_logs` (ai, lúc nào, lý do).

### 5.4. Circuit breaker

**3 trạng thái thật** (S2-1, ADR-048/054). Redis là nguồn chạy, `destinations.circuit_state` chỉ để hiển thị (ghi khi đổi):

| Trạng thái | Điều kiện | Hành vi |
|---|---|---|
| `CLOSED` | bình thường | gửi |
| `OPEN` | ≥ 5 lỗi phía đích (5xx/408/429/mạng) trong cửa sổ `:failures` | ngừng 60s (`:open` EX 60); message hoãn vào `q.delivery.retry.1m`, không tăng `attemptCount`, trần 30 lần hoãn |
| `HALF_OPEN` | `:open` hết hạn mà `failures ≥ 5` (trạng thái **suy ra**, không lưu) | đúng **1** probe (Lua `SET NX` có token); thành công → `CLOSED` (DEL 3 khoá), thất bại → `OPEN` lại; probe nhận 4xx → nhả probe, giữ `HALF_OPEN` |

Redis chết → circuit breaker **fail-open** + log cảnh báo. 4xx khác không tính vào circuit (lỗi cấu hình của ta, đích vẫn sống).

### 5.4b. Outbound throttle — khác circuit breaker, và đi thành một cặp (ADR-016)

**Cửa sổ cố định 1 giây** (không phải token bucket) trong Redis, **theo từng destination**: khoá `throttle:destination:{id}:{epochGiây}`, một `EVAL` INCR+EXPIRE; `destinations.rate_limit_rps` (mặc định 0 = không giới hạn, 0 lệnh Redis). Vượt → message đẩy sang `q.delivery.retry.10s`, không gọi HTTP. Sai số: ở mép hai cửa sổ có thể lọt tối đa **2× RPS** trong một giây — chấp nhận được vì mục đích là bảo vệ đích khỏi bị dội, không phải tính cước chính xác.

> **Cặp khái niệm nên trình bày cùng nhau khi bảo vệ:**
> **Throttle** là *phòng ngừa* — giữ nhịp để **không làm đích quá tải**.
> **Circuit breaker** là *phản ứng* — khi đích **đã** hỏng thì ngừng đập vào nó.
> Thiếu throttle: worker scale lên 5 sẽ bắn gấp 5 lần vào một đích yếu và **tự tay tạo ra sự cố mà circuit breaker phải đi dọn**.

Cùng script Lua với rate limit inbound (cửa sổ 60s), chỉ đổi key và độ dài cửa sổ.

### 5.4c. Cố tình không làm (và vì sao)

| Không làm | Vì sao | Bù lại |
|---|---|---|
| **Jitter ở tầng retry delivery** | Retry dùng TTL của **queue** (mỗi tầng một queue, §4) — RabbitMQ không cho TTL ngẫu nhiên theo từng message mà không quay về head-of-line blocking | Relay ±100ms, sweeper ±10s, cleanup ±10%; circuit breaker chặn retry storm vào đích chết |
| **Token bucket** cho rate limit / throttle | Cửa sổ cố định 1 lệnh Redis, đủ để chống spam/bảo vệ đích | Sai số tối đa 2× ở mép cửa sổ (§5.4b) |
| **DLQ broker là nguồn sự thật** | Broker không truy vấn/lọc được, có trần policy (ADR-052) | Postgres `deliveries.status='DEAD'` + `raw_events` là nguồn; trang DLQ và replay đọc DB |
| **Tự cảnh báo Telegram khi circuit OPEN** | Kênh `hub:alerts` đã bỏ ở ADR-048; chưa làm lại | `circuit.changed` realtime trên dashboard + metric `hub_circuit_transitions_total` |

### 5.5. Máy trạng thái

```
Delivery:  PENDING -> DELIVERING -> SUCCEEDED
                         |-> RETRYING -> DELIVERING ...
                         `-> DEAD --(replay: generation+1)--> PENDING

Order:     PENDING -> PAID
             |-> UNDERPAID -> PAID
             |-> EXPIRED
             `-> CANCELLED
```

Mọi chuyển trạng thái không hợp lệ bị **từ chối ở tầng service** (không phải ở DB, không phải ở controller).

### 5.6. Graceful shutdown

`SIGTERM` → ngừng consume → chờ in-flight xong (**timeout 25s**) → đóng channel → đóng connection. Message chưa `ack` được RabbitMQ trả lại queue.

> ⚠️ **25s, không phải 30s.** Render gửi `SIGTERM` rồi `SIGKILL` sau ~30s — để timeout đúng 30s là đứng ngay mép vực. Sai chỗ này lộ ra dưới dạng *"thỉnh thoảng mất message sau khi deploy"*, loại lỗi khó debug nhất. Cấu hình qua `SHUTDOWN_TIMEOUT_MS`.

> Đây là kịch bản demo mạnh nhất — phải chạy đúng từ **Ngày 4**.

### 5.7. Đối soát (thuộc Shop, không thuộc Hub)

Cron 5 phút trong `shop-api`: đơn `PENDING` tạo quá 10 phút → gọi API PayOS kiểm trạng thái thật → nếu đã trả mà chưa nhận webhook → POST vào endpoint nội bộ của hub với `origin=reconciliation` → hub xử lý như sự kiện bình thường (idempotency đảm bảo không trùng).

→ Hệ thống **tự phục hồi** kể cả khi webhook mất trên đường truyền.

---

## 6. Mô hình dữ liệu

### 6.0. Multi-tenancy — làm Ngày 1, không bao giờ làm sau (BB-5, ADR-015)

**Năm bảng mang `tenant_id uuid NOT NULL`:** `sources` · `destinations` · `subscriptions` · `events` · `deliveries`.
(`raw_events` suy ra tenant qua `source_id`; `delivery_attempts` qua `delivery_id`.)

```sql
ALTER TABLE hub.sources ADD COLUMN tenant_id uuid NOT NULL;
CREATE INDEX ON hub.events     (tenant_id, received_at DESC);
CREATE INDEX ON hub.deliveries (tenant_id, status, next_attempt_at);
-- unique cũng phải scope theo tenant:
--   UNIQUE(tenant_id, source_id, idempotency_key)
```

**Guard bắt buộc:** mọi truy vấn đi qua một `TenantScopedRepository` nhận `tenant_id` từ JWT (hoặc từ `source.tenant_id` ở luồng ingest). **Không repository nào được phép query không scope.** Một helper, ~40 dòng, viết Ngày 1.

Hiện tại chạy **một tenant** (một admin). Cột luôn mang cùng một giá trị. Đó không phải lãng phí — đó là **đường kẻ có sẵn**:

- Ngày 1: ~30 phút.
- Ngày 10: migration + sửa từng query + sửa từng test → nửa ngày, và sẽ bị bỏ qua vì hết giờ.

**Câu trả lời hội đồng:** *"Mọi bảng đều scope theo `tenant_id`, guard đặt ở tầng repository. Hiện chạy một tenant; kiến trúc không cản trở nhiều tenant."*

### 6.1. Schema `hub`

```sql
CREATE TYPE hub.provider_enum    AS ENUM ('payos','sepay','github');
CREATE TYPE hub.raw_status       AS ENUM ('ACCEPTED','REJECTED','DUPLICATE');
CREATE TYPE hub.event_origin     AS ENUM ('webhook','reconciliation','replay','derived');
CREATE TYPE hub.destination_type AS ENUM ('webhook','telegram','discord');
CREATE TYPE hub.delivery_status  AS ENUM ('PENDING','DELIVERING','RETRYING','SUCCEEDED','DEAD');
CREATE TYPE hub.circuit_state    AS ENUM ('CLOSED','OPEN','HALF_OPEN');
```

**`sources`** — nguồn webhook

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid ⭐ MỚI | BB-5 · §6.0 |
| `provider` | provider_enum | |
| `name` | varchar | |
| `source_key` | varchar UNIQUE | nằm trong URL, ngẫu nhiên 32 ký tự |
| `is_active` | boolean | |
| `created_at` | timestamptz | |

**`source_secrets`** ⭐ MỚI — cho phép xoay secret inbound

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `source_id` | uuid FK | |
| `secret_encrypted` | text | AES-256-GCM |
| `version` | int | |
| `valid_from` | timestamptz | |
| `valid_until` | timestamptz NULL | NULL = đang hoạt động |

→ `adapter.verify()` nhận **mảng** secret còn hiệu lực, thử lần lượt. Trong cửa sổ xoay, cả secret cũ và mới đều được chấp nhận.

**`raw_events`** — bản gốc, không bao giờ sửa

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | cũng là `correlation_id` gốc |
| `source_id` | uuid FK | |
| `idempotency_key` | varchar | **`UNIQUE(source_id, idempotency_key)`** |
| `headers` | jsonb | |
| `body` | jsonb | để query cho tiện |
| `body_raw` | **bytea** ⭐ MỚI | **byte gốc** — HMAC và replay thật cần cái này |
| `content_type` | varchar ⭐ MỚI | |
| `signature_header` | text ⭐ MỚI | lưu lại để tra khi debug chữ ký |
| `signature_valid` | boolean | |
| `status` | raw_status | |
| `origin` | event_origin | |
| `received_at` | timestamptz | index |

> Bản gốc chỉ lưu `body jsonb`. Parse JSON rồi vứt bytes đi → **vĩnh viễn không xác thực lại được, không replay được request thật**. Chính bản gốc (mục 8.1) viết *"HMAC phải tính trên byte gốc"* rồi mục 9.2 vứt nó đi.

**`events`** — sự kiện chuẩn hoá

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | ULID — tăng dần theo thời gian, dùng làm cursor cho polling (§8.1) |
| `tenant_id` | uuid ⭐ MỚI | BB-5 |
| `raw_event_id` | uuid FK **NULL** ⭐ SỬA | sự kiện phái sinh không có raw |
| `parent_event_id` | uuid FK NULL ⭐ MỚI | |
| `idempotency_key` | varchar UNIQUE ⭐ MỚI | |
| `correlation_id` | uuid ⭐ MỚI | index — truy vết cả hành trình |
| `type` | varchar | index, vd `payment.received` (catalog: `docs/EVENT-CATALOG.md`) |
| `source` | varchar | |
| `subject` | varchar | vd `payment:<providerTxnId>`, `repo:<fullName>` |
| `data` | jsonb | index GIN |
| `origin` | event_origin | |
| `occurred_at` / `received_at` | timestamptz | |

**`destinations`**

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `type` | destination_type | |
| `tenant_id` | uuid ⭐ MỚI | BB-5 |
| `config_encrypted` | text | URL / bot token / chat id — AES-256-GCM |
| `signing_secret_encrypted` | text | cho type `webhook` |
| `rate_limit_rps` | int default 0 ⭐ MỚI | outbound throttle, 0 = không giới hạn (§5.4b) |
| `circuit_state` | circuit_state | đồng bộ từ Redis để hiển thị |
| `alert_on_open` | boolean ⭐ MỚI | bật cảnh báo Telegram khi circuit OPEN |

**`subscriptions`**

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid ⭐ MỚI | BB-5 |
| `destination_id` | uuid FK | |
| `event_types` | text[] | **khớp theo đây là đủ** — xem §9 phần cắt |
| `template` | text | `{{path.to.field}}` thuần, KHÔNG pipe filter |
| `is_active` | boolean | |

**`deliveries`**

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid ⭐ MỚI | BB-5 |
| `event_id` / `subscription_id` | uuid FK | |
| `attempt_generation` | int default 1 ⭐ MỚI | **`UNIQUE(event_id, subscription_id, attempt_generation)`** |
| `status` | delivery_status | |
| `attempt_count` | int | |
| `next_attempt_at` | timestamptz | |
| `last_error` | text | |

**`delivery_attempts`** — `id bigserial` · `delivery_id` · `attempt_no` · `request_body jsonb` · `response_status int` · `response_body text` (cắt 2KB) · `duration_ms int` · `error text` · `created_at`

**`outbox`** — `id bigserial` · `topic varchar` · `payload jsonb` · `published_at timestamptz NULL` · `attempts int` ⭐ · `created_at`

```sql
CREATE INDEX ON hub.outbox (id) WHERE published_at IS NULL;
```

**`processed_messages`** ⭐ MỚI — `consumer varchar` · `message_id varchar` · `created_at` · `UNIQUE(consumer, message_id)`
→ job `cleanup` xoá bản ghi > 7 ngày (không thì phình vô hạn).

**`audit_logs`** — thao tác quản trị: replay, sửa cấu hình, xoay secret.

### 6.2. Schema `shop` (Hub không truy cập)

**`orders`** — `id uuid PK` · `order_code varchar UNIQUE` (vd `DH10234`) · `amount bigint` · `paid_amount bigint` · `status` · `payment_provider` · `payos_payment_link_id varchar` · `version int` (optimistic locking) · `created_at`

Cập nhật dùng optimistic locking: `UPDATE ... WHERE id = ? AND version = ?` — tránh webhook PayOS và job đối soát ghi đè nhau.

---

## 7. Bảo mật

### 7.1. Inbound

| Biện pháp | Chi tiết |
|---|---|
| Xác thực | PayOS: checksum HMAC-SHA256 trên `data` đã sort key (tính bằng SDK, **so bằng `timingSafeEqual` của ta**, S3-1) · SePay: **không ký nội dung** — chỉ là **API key dùng chung** trong `Authorization: Apikey <key>` (bắt buộc tiền tố) · GitHub: `X-Hub-Signature-256` HMAC-SHA256 trên **raw body** · Stripe: `Stripe-Signature` (SDK, raw body) |
| Raw body | `NestFactory.create(AppModule, { rawBody: true })` — **cấu hình NGÀY 1** |
| So sánh | `crypto.timingSafeEqual` — luôn luôn, kể cả khi so API key |
| URL khó đoán | `/hooks/:provider/:sourceKey`, `sourceKey` ngẫu nhiên 32 ký tự |
| Giới hạn | payload ≤ 1MB · rate limit cửa sổ cố định 60s theo source (mặc định 100/phút) |
| Lưu cả request hỏng | chữ ký sai vẫn INSERT `status=REJECTED` để điều tra — chỉ 4KB đầu, ≤ 20 bản/phút/source; header nhạy cảm đã che (ADR-045, ADR-051) |

### 7.2. Outbound (hub ký webhook gửi đi)

Theo chuẩn [Standard Webhooks](https://www.standardwebhooks.com):

```
X-Hub-Event-Id:   evt_01J9ZK...
X-Hub-Timestamp:  1789550431
X-Hub-Signature:  v1=<HMAC-SHA256(secret, "{id}.{timestamp}.{body}")>
```

Bên nhận (Shop) **bắt buộc**: (1) verify chữ ký · (2) từ chối nếu timestamp lệch > 5 phút (**chống replay attack**) · (3) chống trùng theo `X-Hub-Event-Id`.

Xoay secret outbound (gửi hai chữ ký `v1=<cũ>,v1=<mới>`): **chưa làm** — hiện gửi một chữ ký. Header theo Standard Webhooks thật (`webhook-id`/`webhook-signature`) để cho đợt đa service (ADR-040).

### 7.3. SSRF — chặn dải IP nội bộ là CHƯA ĐỦ

Bản gốc chỉ nói "chặn URL trỏ về `127.0.0.1`, `10.x`, `192.168.x`". Thiếu hai lỗ:

1. **DNS rebinding** — `evil.com` resolve về IP public lúc kiểm, về `169.254.169.254` lúc connect.
   → **resolve DNS → kiểm IP → connect vào ĐÚNG IP đã kiểm** (pin IP, đặt header `Host` thủ công).
2. **Redirect** — đích trả `301` sang `169.254.169.254/latest/meta-data/`.
   → **`maxRedirects: 0`**. Không follow, chấm hết.

Chặn: `127.0.0.0/8` · `10/8` · `172.16/12` · `192.168/16` · `169.254/16` · `::1` · `fc00::/7` · `0.0.0.0`.
Cho phép bỏ qua **chỉ** khi `NODE_ENV=development`.

### 7.4. Hệ thống

- Secret nguồn/đích **AES-256-GCM** trước khi vào DB; master key trong biến môi trường, **không commit**.
- Dashboard: JWT, **một admin user** (đã cắt refresh token rotation — xem §9).
- Mask trong log: token, số tài khoản, chữ ký.

---

## 8. Quan sát (Observability)

| Thứ | Cách làm | Ghi chú |
|---|---|---|
| **Correlation ID** | `correlation_id = raw_event.id`, truyền qua AMQP `properties.headers['x-correlation-id']`, gắn vào mọi log | Tra được toàn bộ hành trình một sự kiện qua mọi tiến trình |
| Log | `pino`, JSON có cấu trúc | |
| Metrics | `prom-client`, đếm trong bộ nhớ (0 lệnh Redis). hub-api `GET /metrics` (không JWT; `METRICS_TOKEN` nếu đặt); hub-worker http tối giản `:9101/metrics` (chỉ mạng nội bộ) — S3-4, ADR-061 | api: `hub_ingest_requests_total{provider,outcome}` · `hub_ingest_duration_seconds{provider}` · worker: `hub_deliveries_total{destination_type,status}` · `hub_delivery_duration_seconds` · `hub_circuit_transitions_total{to}` · `hub_outbox_lag_seconds` · `hub_normalize_retries_total` · `hub_normalize_schema_errors_total{source}` · default process metrics |
| Grafana | provisioning trong repo `infra/grafana/provisioning` (datasource + dashboard "Webhook Hub" 6 panel); Prometheus/Grafana ghim phiên bản | Đo bằng `k6/ingest-github.js` (`k6/README.md`) |
| Health | `/health` kiểm Postgres · Redis · RabbitMQ | |
| **Tự cảnh báo** | *Chưa làm* (bỏ cùng kênh `hub:alerts`, ADR-048) — xem §5.4c | Hiện có `circuit.changed` realtime + metric |

### 8.1. Polling endpoint — cho đích không nhận được push (ADR-016)

```
GET /api/v1/events?after=<cursor>&types=repo.push,payment.received&limit=100
→ { events: [...], nextCursor: "evt_01J..." }
```

Cursor = `events.id` (ULID, tăng dần theo thời gian). Scope theo `tenant_id`.

Lý do tồn tại — **không phải mọi đích đều nhận push được**: đích nằm sau firewall doanh nghiệp, đích là client di động, đích là script chạy theo lịch. Push và pull là hai mặt của cùng một bài toán phân phối. ~1 giờ.

**Sự kiện Socket.IO** (room theo user / theo order):

```
event.received · event.normalized · delivery.updated
order.updated  · metrics.tick (5s) · circuit.changed
```

> ⚠️ `metrics.tick` là **5 giây** và đếm **trong bộ nhớ** `hub-api`, **không** chạm Redis mỗi tick. Ở 2 giây và mỗi tick một lệnh Redis, hệ thống tiêu ~43.000 lệnh Upstash/ngày **chỉ để đứng yên**. Xem `DEPLOYMENT.md` §5.2 — ngân sách ≤ 4 lệnh Redis cố định/sự kiện + ≤ 2/delivery (ADR-062).

Kênh realtime đi qua interface **`RealtimeNotifier`** (ADR-021), mặc định `RedisNotifier`, dự phòng `RabbitFanoutNotifier`.

---

## 9. Phạm vi — đã cắt, không tiếc

Cắt để vừa 14 ngày. Ghi vào báo cáo ở mục "hướng phát triển", **không** làm trong 14 ngày.

| Cắt | Lý do |
|---|---|
| `filter: {"data.amount": {"$gte": 1000}}` | Đây là viết lại query language của MongoDB. Khớp theo `event_types` là đủ. |
| `{{data.amount \| vnd}}` pipe filter | = viết template engine. Dùng `String.replace` với `{{path}}` thuần, ~20 dòng. |
| JWT refresh token rotation | 1 admin, 1 token. |
| VNPAY · Gmail/Pub-Sub · Google Sheets · JSONata | Đã ở mục "mở rộng". Không chạm. |
| Website bán hàng đầy đủ | BB-1 + trần 300 dòng của Shop. |

> **GIỮ Grafana** — đề tài chấm nặng "chịu tải & scale". 30 phút công đổi lấy 3 phút demo mạnh nhất.

---

## 10. Cấu trúc thư mục

```
webhook-hub/
├── CLAUDE.md                      # bất biến — mọi phiên đọc trước
├── docs/
│   ├── ARCHITECTURE.md            # file này
│   ├── ROADMAP-14D.md             # lộ trình + DoD từng ngày
│   └── adr/README.md              # nhật ký quyết định (append-only)
├── apps/
│   ├── hub-api/                   # NestJS — ingest + REST + Socket.IO        -> Render
│   │   └── src/modules/{auth,ingest,sources,destinations,subscriptions,events,metrics,realtime}
│   ├── hub-worker/                # NestJS — consumer + relay + cleanup       -> Render
│   │   └── src/{normalize-route,delivery/senders,scheduler}
│   ├── shop/                      # !! TRẦN 300 DÒNG · schema riêng           -> Vercel (route handlers)
│   └── web/                       # Next.js — dashboard + storefront          -> Vercel
├── libs/
│   ├── providers/                 # Adapter pattern — trái tim tính mở rộng
│   │   ├── provider.interface.ts
│   │   ├── github.adapter.ts      # Ngày 2
│   │   ├── payos.adapter.ts       # Ngày 5
│   │   └── sepay.adapter.ts       # Ngày 5
│   ├── database/                  # Prisma schema + migrations
│   ├── messaging/topology.ts      # !! khai báo exchange/queue MỘT CHỖ DUY NHẤT
│   ├── crypto/                    # HMAC · AES-GCM · timingSafeEqual · SSRF guard
│   └── common/                    # DTO · event schema · logger · correlation id
├── k6/
└── docker-compose.yml
```

### Interface adapter

```ts
export interface ProviderAdapter {
  readonly provider: ProviderType; // 'payos' | 'sepay' | 'github' | 'stripe'

  /** Xác thực. Nhận MẢNG secret để hỗ trợ xoay secret. Tính trên raw bytes. */
  verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean>;

  /** Khoá chống trùng, ổn định giữa các lần provider gửi lại */
  extractIdempotencyKey(req: RawWebhookRequest): string;

  /** Chữ ký/bằng chứng để lưu raw_events.signature_header; bí mật dùng chung phải che (S3-1) */
  extractSignature(req: RawWebhookRequest): string | null;

  /** Payload gốc -> sự kiện chuẩn theo catalog (có thể ra nhiều sự kiện) */
  normalize(req: RawWebhookRequest, ctx: NormalizeContext): NormalizedEvent[];

  /** Phản hồi đúng định dạng provider mong đợi */
  buildAck(result: IngestResult): { status: number; body: unknown };
}
```

> Thêm provider mới = **viết một class + đăng ký vào registry**. Không sửa ingest, worker, hay DB.
>
> **Đo thời gian viết adapter #2 và #3 (Ngày 5) và ghi lại** — bằng chứng định lượng cho luận điểm Open/Closed, mạnh hơn một đoạn văn lý thuyết.

### Docker Compose

| Service | Image / build | Cổng |
|---|---|---|
| postgres | `postgres:16` | 5432 |
| redis | `redis:7` | 6379 |
| rabbitmq | `rabbitmq:3-management` | 5672, **15672** (UI — dùng khi demo) |
| prometheus + grafana | official | 9090, **3001** |
| hub-api | build | 4000 |
| hub-worker | build — `--scale hub-worker=5` (relay + cleanup nằm trong đây) | — |
| shop | build | 4001 |
| web | build | 3000 |
| tunnel | `cloudflared` **named tunnel** | URL cố định |

> Đây là **môi trường LOCAL** — nơi đo đạc và chaos test, nơi lấy **toàn bộ số liệu báo cáo**. Môi trường deployed (Render/Vercel/Neon/Upstash/CloudAMQP) có nhiệm vụ khác: xem `DEPLOYMENT.md` §1 và ADR-019.

---

## 11. Sự kiện chuẩn hoá — "vào nhiều kiểu, ra một kiểu" (ADR-053, ADR-059)

> **Hợp đồng chi tiết: [`docs/EVENT-CATALOG.md`](EVENT-CATALOG.md)** (catalog v1, bảng ánh xạ từng provider, luật ổn định hình dạng, ánh xạ sang CloudEvents). Body **không** theo CloudEvents; `source` = tên provider.

```json
{
  "id": "evt_01J9ZK...",
  "type": "payment.received",
  "source": "sepay",
  "subject": "payment:92704",
  "normalized": true,
  "occurredAt": "2026-10-10T07:02:37.000Z",
  "receivedAt": "2026-10-10T07:02:38.120Z",
  "data": {
    "amount": 50000, "currency": "VND", "method": "bank_transfer",
    "reference": "MBVCB.3278907687", "memo": "DH123456 thanh toan",
    "counterparty": null, "account": { "number": "0123499999", "bank": "Vietcombank" },
    "providerTxnId": "92704", "paidAt": "2026-10-10T07:02:37.000Z",
    "raw": { "...": "body gốc của SePay" }
  }
}
```

| Nguồn | Sự kiện gốc | → chuẩn |
|---|---|---|
| PayOS | `code = "00"` và `success ≠ false` / còn lại | `payment.received` / `payment.failed` |
| SePay | `transferType = in` (hoặc thiếu) / `out` | `payment.received` / `payment.sent` |
| Stripe | `payment_intent.succeeded` / `.payment_failed` / `charge.refunded` / khác | `payment.received` / `.failed` / `.refunded` / `stripe.<type>` (`normalized:false`) |
| GitHub | `push` | `repo.push` |
| GitHub | `pull_request` | `repo.pull_request.<action>` (closed + merged → `.merged`) |
| GitHub | `issues` | `repo.issue.<action>` |
| GitHub | khác (`ping`, `release`…) | `github.<event>[.<action>]` (`normalized:false`) |

`payment.*` và `repo.*` là không gian **dành riêng**: sai khuôn → lỗi normalize vĩnh viễn, không đẩy dữ liệu sai hình dạng ra ngoài.

> **Sự kiện nghiệp vụ** (đơn đã trả, trả thiếu, không khớp mã đơn) **thuộc Shop**, không phải Hub — BB-1. Hub không có `orderCode`: mã đơn nằm trong `data.memo`/`data.reference`, Shop tự tìm.

---

## 12. Kịch bản demo (thứ tự trình bày)

> Mở màn bằng cảnh hệ thống **gãy rồi tự lành** — đừng mở bằng mua hàng.

| # | Kịch bản | Chứng minh |
|---|---|---|
| **1** | k6 bắn 500 req/s → RabbitMQ UI queue phình → `--scale hub-worker=5` → Grafana tụt | **Chịu tải, scale ngang** |
| **2** | `docker kill hub-worker` giữa chừng → restart → 0 message mất | Manual ack, at-least-once |
| **3** | Tắt Shop → tạo giao dịch → dashboard `RETRYING` → bật lại → tự giao | Retry, chịu lỗi |
| **4** | Đích lỗi liên tục → circuit **OPEN** → vào **DLQ** → bấm **Replay** | Circuit breaker, DLQ, replay |
| 5 | Mua hàng PayOS **thật** 2.000đ → đơn tự PAID, Telegram báo | End-to-end thật |
| 6 | SePay Test Mode: chuyển **thiếu tiền** / **sai mã đơn** | Xử lý nghiệp vụ biên |
| 7 | GitHub "Redeliver" cùng một webhook 3 lần → xử lý 1 lần | Idempotency |
| 8 | `curl` sai chữ ký → 401, hiện trong log `REJECTED` | Bảo mật |
| 9 | Push code GitHub → Discord báo commit | Hub đa nền tảng |

---

## 13. Chỉ tiêu (phải ĐO, không được chép)

| Chỉ số | Mục tiêu | Đo bằng |
|---|---|---|
| p95 ingest | < 100ms | k6, gọi **trực tiếp** hub-api (**không qua tunnel**) |
| p95 end-to-end | < 1s khi đích khoẻ | `raw_events.received_at` → `delivery_attempts.created_at` |
| Throughput ingest | ≥ 500 rps | k6 |
| Mất sự kiện khi kill worker | **0%** | đếm `deliveries` trước/sau |
| Xử lý trùng khi gửi lặp | **0%** | đếm `delivery_attempts` |

> Ghi kèm **cấu hình máy** vào báo cáo. Số bịa là chỗ hội đồng bắt chết.

---

## 14. Cạm bẫy đã biết (mỗi cái ăn nửa ngày nếu không đề phòng)

| # | Bẫy | Phòng |
|---|---|---|
| 1 | **HMAC sai byte** — Nest parse JSON trước khi lấy raw body → chữ ký sai 100%, log không nói gì | `{ rawBody: true }` **Ngày 1**; viết unit test verify với fixture thật ngay |
| 2 | **Tunnel đổi URL** mỗi lần restart → provider trỏ vào hư không | cloudflared **named tunnel**, URL cố định, cấu hình Ngày 1 |
| 3 | **RabbitMQ `PRECONDITION_FAILED`** — declare queue với `x-message-ttl` khác lần trước → app không lên | Topology **một chỗ duy nhất** `libs/messaging/topology.ts`; đổi tham số thì xoá queue trước |
| 4 | **PayOS confirm webhook** — lúc đăng ký URL, PayOS bắn request kiểm tra đòi 200; endpoint chưa có adapter → trả 401 → đăng ký fail | Đăng ký PayOS **sau** khi adapter chạy (Ngày 5) |
| 5 | `processed_messages` phình vô hạn | Job cleanup > 7 ngày, có từ Ngày 4 |
| 6 | k6 bắn qua tunnel → đo ra độ trễ của Cloudflare, không phải của hub | Load test **localhost** |

---

## 15. Câu hỏi hội đồng — câu trả lời chốt

**Q: Tại sao không xử lý luôn trong request mà phải qua hàng đợi?**
Provider yêu cầu phản hồi nhanh (GitHub ~10s). Gọi Telegram ngay trong request mà đích chậm → provider timeout → gửi lại → trùng. Hàng đợi tách *nhận* khỏi *xử lý*: ingest luôn nhanh, và hai phần scale độc lập.

**Q: Tại sao dùng cả Redis lẫn RabbitMQ?**
RabbitMQ = giao message tin cậy (ack, retry có độ trễ, DLQ, routing). Redis = bộ nhớ nhanh độ trễ thấp (đường tắt chống trùng, rate limit, circuit breaker, cache subscription, pub/sub cho Socket.IO). Bổ trợ, không thay thế.

**Q: Làm sao đảm bảo không mất sự kiện?**
Transactional Outbox + publisher confirms + manual ack + đối soát PayOS. Và: **không bao giờ ACK trước khi COMMIT** (BB-3).

**Q: Nếu Redis sập?**
Trọng tài idempotency nằm ở Postgres (BB-2) nên vẫn **đúng**, chỉ **chậm hơn**. Rate limit và circuit breaker chuyển fail-open kèm cảnh báo — với một hub, nhận thừa còn hơn mất webhook thật.

**Q: Khác gì Zapier/n8n?**
Zapier/n8n bán **trình dựng workflow kéo thả**. Đề tài này tập trung vào **độ tin cậy của tầng webhook** — xác thực, chống trùng, retry có tầng, DLQ, đối soát, quan sát — cho các nền tảng Việt Nam (PayOS, SePay).

**Q: Thêm nền tảng mới thì sao?**
Viết một class implement `ProviderAdapter`, đăng ký vào registry. Không sửa ingest, worker, hay DB. *(Có số liệu thật: adapter #2 mất X giờ, #3 mất Y giờ.)*

**Q: Tại sao Demo Shop là service riêng?**
Vì Hub là hạ tầng generic (BB-1). Nếu Hub biết `orderCode` thì nó không còn là webhook hub, nó là dịch vụ đối soát thanh toán. Tách ra còn cho phép Hub **được kiểm chứng bằng chính một client độc lập của nó**.

---

## 16. Đối chiếu với Svix (sản phẩm thương mại cùng lĩnh vực)

[Svix](https://svix.com) là webhooks-as-a-service thương mại. Đối chiếu để **định vị**, không phải để chạy theo: Svix có đội ngũ nhiều năm, đề tài này có 14 ngày. Bảng dưới là phần **"so sánh với giải pháp hiện có"** của báo cáo.

| Tính năng Svix | Ta | Chi tiết |
|---|:---:|---|
| **Security** — signed payloads, secret rotation, SSRF, replay, forged events | ✅ **Ngang, một số điểm hơn** | Ký Standard Webhooks ✓ · xoay secret **cả inbound lẫn outbound** ✓ · chống replay theo timestamp 5' ✓ · `timingSafeEqual` ✓ · SSRF **có pin IP chống DNS rebinding + chặn redirect** (§7.3) — mức đa số triển khai bỏ qua |
| **Automatic & Manual Retries** | ✅ Ngang | 5 tầng TTL tự động qua DLX + Replay tay đơn lẻ/hàng loạt từ DLQ, có `attempt_generation` |
| **Event Filtering** | ✅ Ngang | `subscriptions.event_types[]` — đúng phạm vi Svix quảng cáo (lọc theo loại sự kiện). Lọc theo *nội dung payload* đã cắt có chủ đích (ADR-011) |
| **Logs and Monitoring** | ✅ Ngang | `raw_events` · `events` · `deliveries` · `delivery_attempts` (status code, duration, body cắt 2KB) · Live Events · Event Detail · Grafana + `/metrics` (§8) |
| **Development Experience** | ✅ Ngang | Gửi thử từ Destinations · Send Example payload mẫu · Replay · Inspect Raw/Normalized/Deliveries |
| **Throttling** | ✅ Ngang | Rate limit **inbound** per source + **outbound** per destination, cửa sổ cố định (§5.4b) |
| **Multi-tenancy** | ✅ Kiến trúc có | `tenant_id` trên 5 bảng + guard ở tầng repository (§6.0). Chạy 1 tenant, kiến trúc không cản trở nhiều tenant |
| **Advanced Endpoints** — Webhook, Polling, FIFO, S3/Azure/GCS, EventBridge | 🟡 Một phần | Có **Webhook · Polling · Telegram · Discord**. Thêm sender mới = một class, cùng pattern với `ProviderAdapter`. **FIFO không làm** — lý do bên dưới |
| **Payload Transformations** | ⚫ **Cố tình không** | Ta có template `{{path}}`. Svix chạy **JS người dùng viết**, tức là bài toán **thực thi code không tin cậy**: sandbox, timeout, giới hạn bộ nhớ, chống thoát sandbox. Đó là một đề tài riêng, không phải một tính năng |
| **Multi-region** | ⚫ **Cố tình không** | Kiến trúc **không cản trở** — `hub-api`/`hub-worker` stateless, toàn bộ state ở PostgreSQL/Redis/RabbitMQ. Nhưng multi-region là bài toán **replication + data residency + routing theo vùng**, không phải bài toán **độ tin cậy của tầng webhook** — trọng tâm đề tài |

### Tại sao KHÔNG làm FIFO ordering (câu trả lời phải học thuộc)

FIFO đòi **single-flight theo partition key**: trong mỗi key chỉ được một message đang xử lý, và khi message đó phải retry thì mọi message cùng key phải **chờ** — nếu không thì thứ tự vỡ.

Điều đó **mâu thuẫn trực tiếp** với việc scale worker ngang và với retry có độ trễ — chính hai thứ đề tài này đang chứng minh. Chọn một trong hai, không thể có cả hai bằng cùng một topology.

> Đây là ranh giới có chủ đích, không phải thiếu sót. *"Không làm vì nó mâu thuẫn với luận điểm chính"* là câu trả lời mạnh hơn nhiều so với *"chưa kịp làm"*.

### Định vị

> Svix bán **hạ tầng webhook đa vùng cho SaaS quốc tế**.
> Đề tài này làm **tầng webhook tin cậy cho các nền tảng Việt Nam (PayOS, SePay)** — trọng tâm là không mất sự kiện, không xử lý trùng, tự phục hồi và quan sát được, với ba cơ chế xác thực khác nhau trên ba nguồn thật.

---

## Tham khảo

PayOS https://payos.vn/docs · SePay https://developer.sepay.vn · SePay Test Mode https://docs.sepay.vn/test-mode.html · GitHub Webhooks https://docs.github.com/en/webhooks · Standard Webhooks https://www.standardwebhooks.com · CloudEvents https://cloudevents.io · RabbitMQ DLX https://www.rabbitmq.com/docs/dlx · Transactional Outbox https://microservices.io/patterns/data/transactional-outbox.html
