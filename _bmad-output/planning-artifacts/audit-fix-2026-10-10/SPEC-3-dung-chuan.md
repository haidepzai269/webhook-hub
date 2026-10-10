> ⚠️ **10/10 tối:** SPEC-3 được gộp vào đợt hub-multi-service. Xem `../hub-multi-service/DINH-CHINH-2026-10-10.md` §4 — **S3-2 bị thay bằng S14** (một đầu ra duy nhất); S3-3 gộp vào S5.

# SPEC-3 — Đúng chuẩn

> Đợt 3/3. Cần SPEC-1 và SPEC-2 đã xong.
> **Mục tiêu demo:** mỗi câu trong phụ lục kỹ thuật đều có code, lệnh kiểm và số đo khớp. Không còn câu nào "đúng một phần".

---

## S3-1 · Xác thực chữ ký: đúng câu chữ, chống trùng không ngẫu nhiên

**BB09:** câu 1.

**Làm:**
1. **PayOS** (`libs/providers/src/payos.adapter.ts:15-38`): bỏ `payos.webhooks.verify()`, vì SDK so sánh bằng `!==` ở `webhook.js:53`.
   - Với mỗi `checksumKey`, gọi `const expected = await new PayOS({...}).crypto.createSignatureFromObj(body.data, checksumKey)`. API này đã có trong `@payos/node` 2.0.5, xem `lib/crypto/node-crypto.d.ts:13`.
   - Rồi `timingSafeCompare(expected, body.signature)` từ `@hub/crypto`.
   - Giữ canonicalization của SDK chính chủ, nhưng phép so sánh phải là của ta.
2. **SePay** (`sepay.adapter.ts:113-116`): **bắt buộc** đúng dạng `Authorization: Apikey <key>`.
   - Không phân biệt hoa thường ở chữ `Apikey`, nhưng **không có tiền tố thì trả false**.
   - Sửa comment cho trung thực: "SePay không ký nội dung; đây là API key dùng chung".
3. **Khoá chống trùng không bao giờ ngẫu nhiên.** Ở `payos.adapter.ts:45` và `sepay.adapter.ts:127`, thay nhánh dự phòng `ulid()` bằng `sha256(rawBody)`, dạng hex rút gọn 32 ký tự.
   - Lý do: provider gửi lại thì body giống hệt, nên khoá cũng giống hệt (BB-2).
4. **Lưu đúng chữ ký vào `raw_events.signature_header`:**
   - Thêm vào `ProviderAdapter` (`provider.interface.ts`) phương thức `extractSignature(req): string | null`.
   - Từng adapter tự trả chữ ký của mình:
     - GitHub: header `x-hub-signature-256`;
     - Stripe: `stripe-signature`;
     - PayOS: `body.signature`;
     - SePay: `'Apikey ***'`, **che** key, không lưu key thật.
   - `ingest.service.ts:92,134` gọi `adapter.extractSignature(req)` thay cho `x-hub-signature-256 || authorization`.
   - Đây là cách thêm provider bằng adapter mà **không sửa lõi**, đúng luận điểm chính của đề tài.
5. **ADR:** "PayOS: chữ ký tính bằng SDK, so sánh bằng `timingSafeEqual` của ta; khoá chống trùng dự phòng = hash của body".

**Test** (`libs/providers/test`):
- PayOS: chữ ký đúng → true; sai một ký tự → false.
- Spy `crypto.timingSafeEqual` để chứng minh nó **được gọi**.
- SePay: thiếu tiền tố → false.
- Thiếu `id` hoặc `reference` → hai lần gọi trên cùng body ra **cùng** khoá.
- `extractSignature` của SePay không chứa key thật.

---

## S3-2 · Sự kiện chuẩn hoá: trường CloudEvents + phân loại chung cho tiền

**BB09:** câu 2.

**Hợp đồng mới cho `NormalizedEvent`** (`libs/common/src/types.ts`):

```ts
{
  specversion: '1.0',
  id: 'evt_<ulid>',
  source: '/sources/<sourceId>',          // URI theo CloudEvents
  provider: 'payos' | 'sepay' | 'github' | 'stripe',   // trường cũ `source` đổi tên thành trường này
  type: string,
  subject?: string,
  time: string,                           // = occurredAt (giữ occurredAt làm alias để không vỡ code cũ)
  datacontenttype: 'application/json',
  data: {...},
  // mở rộng của hub: tenantId, sourceId, correlationId, rawEventId, origin, receivedAt
}
```

- **DB:**
  - Migration thêm cột `events.provider VARCHAR(32)`, rồi backfill `provider = source`.
  - Sau đó `source` lưu URI.
  - Cập nhật `TenantScopedRepository`, UI (cột "Nguồn" hiện `provider`) và body gửi tới đích webhook (`webhook.sender.ts`) để có thêm `specversion` và `provider`.

**Phân loại type cho nhóm tiền:**

| Provider | Điều kiện | `type` |
|---|---|---|
| PayOS | `body.code === '00' && body.success !== false` | `payment.succeeded` |
| PayOS | còn lại | `payment.failed` |
| Stripe | `payment_intent.succeeded` | `payment.succeeded` |
| Stripe | `payment_intent.payment_failed` | `payment.failed` |
| Stripe | khác | `stripe.<type gốc>` |
| SePay | `transferType === 'in'` | `bank.transfer.received` |
| SePay | `transferType === 'out'` | `bank.transfer.sent` |
| GitHub | giữ như cũ | `repo.push`, `repo.pull_request.opened` |

**`data` bắt buộc cho mọi sự kiện tiền** (`payment.*`, `bank.transfer.*`):
```ts
data: { amount: number, currency: 'VND' | string, reference: string, description: string, raw: <payload gốc của provider> }
```
- SePay: `amount = transferAmount`, `description = content`, `reference = referenceCode || String(id)`.
- PayOS: `amount = data.amount`, `reference = data.reference`, `description = data.description`, và giữ `orderCode` của PayOS **bên trong `raw`**.
  - Theo BB-1, hub không đưa `orderCode` lên tầng chuẩn. Đó là từ vựng của PayOS, không phải của hub.
- GitHub: `data` rút gọn còn `{ repository: {name, fullName}, ref, sender: {login}, commits: số lượng, headCommit: {id, message} }`. Body gốc đầy đủ vẫn ở `raw_events`.

**Shop** (`apps/shop/src/main.ts:128-136`):
- Đọc `data.amount` và chuỗi tìm kiếm gồm `subject + data.description + data.reference`. Bỏ `transferAmount`, `content`, `orderCode`.
- Giữ trần ~300 dòng (thay dòng, không thêm).
- Cập nhật `apps/shop/test`.
- Nếu Shop có nút giả lập chuyển khoản (ADR-027) thì kiểm lại nút vẫn chạy.

**ADR:** "NormalizedEvent theo CloudEvents 1.0 (`source` là URI, thêm `provider`); `data` bắt buộc cho sự kiện tiền; PayOS phân loại theo `code`".

**Test:**
- Adapter test cho từng dòng trong bảng phân loại.
- Snapshot `data` của SePay và PayOS.
- Test Shop với payload mới.

---

## S3-3 · Định tuyến: wildcard, seed sạch, template có nghĩa

**BB09:** câu 3 ("khớp chính xác, chưa có wildcard… seed có type `order.paid`… template `{{data.amount}}` SePay trống").

**Làm:**
1. `findActiveSubscriptionsForEventType(type)`:
   - Tính danh sách mẫu ứng viên. Ví dụ `'payment.succeeded'` → `['payment.succeeded', 'payment.*', '*']`, còn `'a.b.c'` → `['a.b.c', 'a.b.*', 'a.*', '*']`.
   - Truy vấn `eventTypes: { hasSome: candidates }`.
   - Đặt hàm tính mẫu trong `libs/common/src/event-pattern.ts` (hàm thuần, có test).
2. Validate khi tạo hoặc sửa subscription: mỗi pattern khớp `^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$`, sai thì 400.
   - Form ở `dashboard/subscriptions` thêm gợi ý "`payment.*` = mọi sự kiện thanh toán".
3. **Seed** (`libs/database/src/seed.ts:150-175`):
   - Bỏ `order.paid`.
   - Telegram: `eventTypes: ['payment.*', 'bank.transfer.received']`, template văn bản thuần:
     `Giao dịch mới\nNguồn: {{provider}}\nSố tiền: {{data.amount}} {{data.currency}}\nNội dung: {{data.description}}\nMã tham chiếu: {{data.reference}}`.
   - Shop: `['payment.*', 'bank.transfer.received']`.
   - `--sync-destinations` (S1-7) **không** sửa subscription. Ghi chú rằng muốn đổi subscription của DB đang chạy thì sửa qua dashboard, hoặc reset DB.

**Test:**
- `event-pattern.spec.ts`.
- Repo test: subscription `payment.*` khớp `payment.failed` và không khớp `paymentx.y`.

---

## S3-4 · Quan sát: `/metrics`, Grafana có dashboard, k6 có script

**BB09:** công cụ ("`/metrics` trả 404, Grafana chưa có dashboard, k6 không có script").

**Làm:**
1. **hub-api** dùng `prom-client` (đã có trong `package.json`). Dựng module `metrics` với:
   - `GET /metrics`, **không** cần JWT. Chặn bằng `METRICS_TOKEN` nếu biến này được đặt, dành cho môi trường deployed.
   - Các chỉ số:
     - `hub_ingest_requests_total{provider,outcome}`;
     - `hub_ingest_duration_seconds{provider}` (histogram: 5, 10, 25, 50, 100, 250, 500ms, 1s);
     - `collectDefaultMetrics()`.
2. **hub-worker:** dựng `http.createServer` tối giản trên `WORKER_METRICS_PORT` (mặc định 9101), chỉ phục vụ `/metrics`. Các chỉ số:
   - `hub_deliveries_total{destination_type,status}`;
   - `hub_delivery_duration_seconds{destination_type}`;
   - `hub_circuit_transitions_total{to}`;
   - `hub_outbox_lag_seconds` (gauge: tuổi của dòng outbox chưa publish lâu nhất, đo mỗi lượt relay);
   - `hub_normalize_retries_total`.
3. **`prometheus.yml`:** scrape `hub-api:4000` và `hub-worker:9101`. Compose mở cổng 9101 trong mạng nội bộ, **không** publish ra host.
4. **Grafana provisioning:**
   - `infra/grafana/provisioning/datasources/prometheus.yml`;
   - `infra/grafana/provisioning/dashboards/{dashboards.yml, webhook-hub.json}`.
   - Dashboard có 6 panel: RPS ingest theo provider, p50/p95/p99 ingest, tỉ lệ ACCEPTED/REJECTED/DUPLICATE, delivery theo trạng thái, outbox lag, số lần chuyển trạng thái circuit.
   - Mount vào service `grafana` trong compose.
   - Ghim phiên bản image Prometheus và Grafana, **không dùng `:latest`**.
5. **k6** (`k6/ingest-github.js`):
   - Ký HMAC đúng bằng `k6/crypto`. Mỗi VU dùng `X-GitHub-Delivery` riêng.
   - Các giai đoạn: 10 → 50 → 100 RPS. Ngưỡng: `http_req_duration p(95)<200`, `http_req_failed<1%`.
   - **Bắn vào `http://localhost:4000`**, không qua tunnel (cạm bẫy số 5).
   - Viết `k6/README.md` gồm cách chạy (`docker run --rm -i --network host grafana/k6 run - < k6/ingest-github.js`) và nơi đọc kết quả.
6. **ADR:** "Metrics: api qua Nest, worker qua http server tối giản; Grafana provisioning trong repo".

**Cách kiểm:**
```bash
curl -s localhost:4000/metrics | grep -c hub_ingest_requests_total      # ≥ 1
docker compose exec prometheus wget -qO- hub-worker:9101/metrics | grep -c hub_deliveries_total   # ≥ 1
# mở localhost:3001 -> dashboard "Webhook Hub" có dữ liệu sau khi chạy k6
```

---

## S3-5 · Ngân sách Redis: đếm bằng test, giảm, ghi số thật

**Ràng buộc:**
- `CLAUDE.md` và `DEPLOYMENT.md` §5.2 đặt ngân sách **≤ 4 lệnh Redis cho mỗi sự kiện**.
- Thực đo theo code ngày 10/10: **8–11 lệnh** cho sự kiện có 1 đích, **13–17 lệnh** cho sự kiện có 2 đích.

**Giảm (làm cả 4):**

| # | Chỗ | Trước | Sau |
|---|---|---|---|
| 1 | Rate limit ingest (`redis.service.ts:46-53`) | INCR + EXPIRE = 2 lệnh | **1 `EVAL`** (Lua `INCR` + `EXPIRE` khi = 1) = 1 lệnh. Upstash tính `EVAL` là 1 lệnh |
| 2 | Circuit `getState` + `recordSuccess` | GET + DEL + SET = 3 lệnh mỗi delivery | MGET = 1. Thành công khi `failures = 0` thì **0 lệnh** (S2-1) |
| 3 | Throttle | luôn gọi khi `rps > 0` | giữ nguyên (chỉ tính khi đích có cấu hình), dùng 1 `EVAL` |
| 4 | Realtime | — | ingest emit in-process, 0 lệnh (S2-2). Normalize **1** publish cho mỗi raw event |

**Kỳ vọng sau khi giảm:**
- ingest 3 lệnh: rate limit, GET idem, SET NX.
- normalize 1 lệnh.
- mỗi delivery 2 lệnh: MGET và PUBLISH.
- Vậy **1 đích = 6 lệnh, 2 đích = 8 lệnh**.

**Đếm bằng test:**
- `apps/hub-api/test/redis-budget.spec.ts` (hoặc một bộ chung) bọc client Redis bằng Proxy đếm số lệnh.
- Chạy luồng ingest → normalize → delivery thành công với 1 đích, rồi với 2 đích.
- `expect` đúng con số trong bảng trên. Như vậy ai thêm một lệnh Redis là test đỏ.

**✅ Admin chốt R1 (10/10):**
- Định nghĩa lại ngân sách thành "**≤ 4 lệnh cố định cho mỗi sự kiện** (ingest + normalize) **+ ≤ 2 lệnh cho mỗi delivery**".
- Ghi ADR, sửa `CLAUDE.md` và `DEPLOYMENT.md` §5.2.
- Đưa phép tính quota Upstash vào báo cáo: 10k lệnh/ngày ÷ 6 ≈ 1.600 sự kiện/ngày. Kiểm lại hạn mức free tier hiện tại của Upstash trước khi ghi con số.
- **Giữ** GET idem trước transaction, không làm R2. Lý do: request trùng trả lời từ Redis thì không phải mở transaction hay chịu P2002 + rollback. Bỏ nó cũng không sai về logic (BB-2), nhưng không đáng để đổi lấy 1 lệnh.

---

## S3-6 · Tài liệu nói đúng điều code làm

**BB09:** câu 1, 5, 6 và lộ trình P2 ("Sửa phụ lục cho khớp").

**Làm:**
1. `docs/ARCHITECTURE.md`:
   - **Throttle là fixed window 1 giây**, không phải token bucket. Lỗi lệch tối đa là 2× RPS ở mép cửa sổ; chấp nhận được với mục đích bảo vệ đích.
   - **Retry không có jitter**: queue TTL của RabbitMQ không cho jitter theo từng message. Bù lại, relay và sweeper có jitter. Ghi vào bảng "Cố tình không làm".
   - **Nguồn sự thật của DLQ là Postgres** (`deliveries.status='DEAD'`). `q.delivery.dlq` và `q.normalize.dlq` chỉ là bản sao trong broker.
   - SePay xác thực bằng **API key dùng chung**, không có HMAC.
   - Circuit có 3 trạng thái (S2-1). Normalize đi qua outbox (S1-2). Có cleanup (S1-4).
   - Sửa mục §5.2 "5 lớp chống trùng" cho khớp code sau S1-2.
2. Sửa comment trong code có chữ "token bucket": `circuit-breaker.service.ts:63` và `redis.service.ts`.
3. Viết `_bmad-output/planning-artifacts/audit-fix-2026-10-10/PHU-LUC-SUA.md`.
   - Nội dung: danh sách câu cần sửa trong file phụ lục Admin đã nộp (`C:\Users\admin\Downloads\PhuLuc_MoTaYeuCauKyThuat_WebhookHub.docx`), theo dạng **câu cũ → câu mới → bằng chứng (file:dòng hoặc lệnh)**.
   - **Không sửa file .docx.** Admin tự sửa.

---

## Lệch khi làm

*(phiên dev ghi vào đây)*

- **S3-1 (2026-10-10):**
  - ADR ghi là **ADR-058** (không phải 057): phiên song song đã ghi ADR-057 (xác thực) trong lúc làm.
  - `signature_header` lưu chuỗi trần (`sha256=…`, `Apikey ***`), không còn `JSON.stringify` như trước; dòng cũ giữ nguyên định dạng cũ (không migrate — cột chỉ để điều tra).
  - Khoá dự phòng hash body áp cho cả GitHub (thay `ulid()`) và Stripe (thay `stripe-signature` — header có timestamp nên lần gửi lại khác khoá).
  - SePay `extractSignature` trả `***` (không phải `Apikey ***`) khi header không có tiền tố, để không bao giờ lưu key.
  - Bỏ hàm `signatureHeaderFor` (`redact-headers.ts`) vì lõi không còn đoán header.
- **S3-2 (2026-10-10) — làm theo DINH-CHINH §0 (lõi S14), không theo S3-2 gốc:**
  - Không CloudEvents, không cột `events.provider`; ánh xạ CloudEvents chỉ ở `docs/EVENT-CATALOG.md` §6. ADR-059.
  - Seed: Telegram và Shop đều `['payment.received']` ngay ở S3-2 (bỏ `order.paid`, `payment.succeeded`, `bank.transfer.*`); Telegram đổi sang `payment.*` ở S3-3 khi có wildcard. Template Discord đổi sang `{{data.repo.fullName}}`/`{{data.actor.login}}`.
  - DB docker đang chạy: subscription Shop + Telegram đổi `eventTypes` qua `PATCH /api/v1/subscriptions/:id` (Telegram vẫn `isActive=false` trong lúc kiểm); template Discord cũng sửa qua API.
  - Validator từ chối cả khoá lạ (không chỉ khoá thiếu) — chặt hơn spec để giữ luật 7.
  - Thiếu `transactionDateTime`/`transactionDate` → dùng thời điểm nhận (không từ chối). SePay thiếu `id` → `providerTxnId = referenceCode`. Stripe `charge.refunded` lấy `method` từ `payment_method_details.type` (charge không có `payment_method_types`).
  - Metric `hub_normalize_schema_errors_total` nằm ở registry riêng của worker (`apps/hub-worker/src/metrics.ts`); đến S3-4 mới phục vụ qua `/metrics`.
  - Payload mẫu Playground (GitHub thêm `html_url`, `commits`; Stripe thêm `amount_received`, `payment_method_types`) và `scripts/e2e-smoke.sh` (GitHub thêm `html_url`, `commits`) sửa để qua validator.
- **S3-3 (2026-10-10):**
  - Lỗi 400 trả object `{error:'invalid_event_pattern', message, fix}` (kiểu ADR-055) thay vì chuỗi; `eventTypes` bắt buộc 1–50 mẫu và khử trùng lặp (trước đây POST cho mảng rỗng).
  - Telegram seed `['payment.*']` (không có `bank.transfer.received` như SPEC-3 gốc — kiểu đó không còn, DINH-CHINH §0); Shop `['payment.received']`, không `payment.*` (Shop không xử lý failed/sent/refunded).
  - Form UI kiểm cùng regex phía client + gợi ý `payment.*`/`*`. ADR-060.
- **S3-4 (2026-10-10):**
  - Thêm `INGEST_RATE_LIMIT_PER_MIN` (mặc định 100): trần cứng 100/phút/source làm k6 chỉ nhận 429. Đo xong trả về mặc định.
  - k6 dùng event `k6_load` (không khớp subscription) để không gửi Discord/Telegram thật; thời lượng bậc chỉnh bằng `STAGE_S` (mặc định 60s). Trên Docker Desktop Windows dùng `--network webhook-hub_default` + `HUB_URL=http://hub-api:4000` (vẫn là local) thay cho `--network host`.
  - Nhãn outcome thêm `NOT_FOUND`/`TOO_LARGE`/`INVALID` cho request không tới được bước verify; `provider` lạ gom về `unknown`.
  - Phát hiện khi đo: ở bậc 100 RPS outbox lag lên ~21s (relay 50 dòng/500ms, một transaction, publish tuần tự có confirm) — chưa tối ưu trong đợt này.
  - Image Prometheus/Grafana ghim đúng phiên bản đang chạy local (đã `docker tag` từ `:latest`, không pull lại).
- **S3-5 (2026-10-10):**
  - Test đặt ở `apps/hub-api/test/redis-budget.spec.ts` nhưng chạy cả class của hub-worker (import tương đối) — một chỗ đếm cả đường.
  - Chỉ cần sửa rate limit ingest (INCR+EXPIRE → 1 EVAL); circuit MGET/0 lệnh khi `failures=0`, throttle 1 EVAL, realtime gộp đã có từ đợt 9/10 (S2-1, S2-2, ADR-054).
  - Quota Upstash ghi theo số kiểm 10/10 (500K lệnh/tháng), không phải "10k/ngày" như SPEC-3: ≈ 2.700 sự kiện/ngày (1 đích), ≈ 2.000 (2 đích).
  - Đích có `rateLimitRps` tốn thêm 1 EVAL/delivery (3 thay vì 2) — vượt "≤ 2/delivery" của R1 khi bật throttle; ghi trong DEPLOYMENT §5.2, không đổi.
- **S3-6 (2026-10-10):**
  - File phụ lục `.docx` không tìm thấy ở `C:/Users/admin/Downloads/` (và Documents/Desktop) → `PHU-LUC-SUA.md` lấy câu cũ từ trích dẫn trong BB09 (9 câu tính năng); phần thông số kỹ thuật chưa đối chiếu câu chữ, chỉ đưa số đo mới.
  - ARCHITECTURE sửa rộng hơn danh sách S3-6 (§3.1–3.3, §5.2 khoá chống trùng theo provider, §7.2 xoay secret outbound ghi "chưa làm", §8 metrics + "tự cảnh báo" ghi "chưa làm", §11 theo catalog) vì các câu đó cũng sai so với code.
  - `.env.example` thêm `INGEST_RATE_LIMIT_PER_MIN`, `METRICS_TOKEN`, `WORKER_METRICS_PORT`, `CLEANUP_RETENTION_DAYS`, `CIRCUIT_MAX_DEFERRALS`, `SHUTDOWN_TIMEOUT_MS`; CLAUDE.md thêm `EVENT-CATALOG.md` vào bảng tài liệu + 2 quy tắc (khoá chống trùng không ngẫu nhiên, adapter ra kiểu chuẩn). Không đụng phần auth của `.env.example` (ADMIN_*), dù câu "không có bảng users" sẽ cũ khi ADR-056 làm xong.
