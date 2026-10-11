# Review độc lập: MS-P2-1..6 + Event Flow UI (master `1a43972`, 10/10 tối)

Người review: phiên review độc lập (chỉ đọc mã nguồn, không sửa, không commit). Stack `hubv` được **build lại từ HEAD `1a43972`** bằng `npm run verify:reset` (image cũ chưa có module flow). Stack dev `webhook-hub` không bị đụng.

## 0. Kết quả cổng tự động

| Lệnh | Kết quả |
|---|---|
| `npm run verify:unit` | L0 **550 pass / 0 fail / 0 skip** (= baseline) |
| `npm run verify:db` (hubv) | L1 **91 pass / 0 fail / 0 skip** (= baseline) |
| `npm run verify:map` | 198 mã · 0 mồ côi · 0 ma · 0 trùng |
| `npm run verify:gates` | 12 luật · 0 vi phạm · 7 ngoại lệ có lý do |
| `verify:reset` trên volume sạch | seed: default có `src_github_main`, `src_payos_main`, `src_sepay_main` + Discord/Telegram + 2 subscription; cafe/bookstore có đủ; Shop tự đăng ký, sub `shop` ghim 2 source |

## 1. Bảng kết luận

| Mục | Kết luận | Ghi chú ngắn |
|---|---|---|
| MS-P2-1 Shop tin source operator | **FAIL** | Đường vòng cũ đã đóng (đơn PENDING), nhưng key có thêm `manage:endpoints` gắn subscription KHÔNG ghim vào endpoint của Shop → đơn **PAID** (R-1). Key cũng tắt được subscription đã ghim của Shop (R-2) |
| MS-P2-2 seed DB rỗng | **PASS** | Đúng trên `verify:reset` thật; L1 `seed-fresh-db` chạy migrate + seed thật hai lần. Ghi chú R-7 (Thấp) |
| MS-P2-3 Redis chết fail-open nhanh | **PASS** | Đo dưới đây; dedupe đúng qua Postgres |
| MS-P2-4 SSRF allowlist | **PASS** | 16 dạng địa chỉ thêm đều bị chặn ở production |
| MS-P2-5 backfill migration idempotent | **PASS** | `ON CONFLICT DO NOTHING`, test L1 chạy SQL hai lần |
| MS-P2-6 cleanup lock / CORS | **PASS** | Lock TTL 0,9 chu kỳ, không nhả; CORS không còn `*`+credentials |
| T14.4 Socket.IO cô lập project | **PASS** | E2E: socket JWT (default) nhận 0 tin khi cafe có traffic; đối chứng default nhận đúng 1 tin |
| DNS rebinding khi delivery | **PASS** (đọc code + test sẵn có) | `createSsrfSafeAxiosConfig` pin IP cho webhook/Discord/Telegram sender và challenge `/verify`; `maxRedirects:0` |
| Cửa sổ lắng polling > 2s | **FAIL (đã biết, ADR-087 để lại)** | Tái hiện mất event vĩnh viễn (R-3) |
| Event Flow: chỉ đọc + BB-5 | **PASS-có-điều-kiện** | Mọi truy vấn có `tenant_id`; nhưng lấy client bằng ép kiểu vào field private (R-9) |
| Event Flow: phạm vi project qua ProjectScopeGuard | **PASS** | `FlowProjectScopeGuard` bọc đúng `ProjectScopeGuard`, không đọc query ở chỗ khác |
| Event Flow: không lộ chéo project | **PASS** | 404 body giống hệt (xem §3) |
| Event Flow: `buildEventFlow` trên dữ liệu thật | **PASS** | OK, DEAD 4xx, source_filtered, endpoint_unverified, origin api đều đúng; R-6 (Thấp) |
| Lucide icons | **PASS** | Chỉ `lucide-react` + SVG inline cho logo provider (spec §0A.D cho phép) |
| Không `X-Hub-*` khi push | **PASS** | Chỉ còn `X-Hub-Signature-256` của GitHub **đầu vào** (adapter, playground, smoke, k6) — đúng |
| Workaround (1) dropdown V2 chỉ project default | **PASS-có-điều-kiện** | Không lộ dữ liệu, nhưng lọc sai project ra danh sách rỗng (R-4) |
| Workaround (2) socket chỉ tenant JWT | **PASS-có-điều-kiện** | Cô lập đúng, nhưng V3 của cafe nhấp nháy theo traffic default (R-5) |
| Workaround (3) nhãn cạnh Shop chồng nhau | **PASS** (chấp nhận) | Chỉ hình thức, không chấm giao diện (R-10) |
| Workaround (4) `verification` ở destinations | **PASS** | Code đọc `destinations.verification` khớp schema S1; §6A bảng cũng ghi đúng `destinations.verification` — chỉ là lệch câu chữ |

## 2. Phát hiện

### R-1 — **Cao** — MS-P2-1 vẫn đi vòng được: key `manage:endpoints` + `manage:sources` của project default làm đơn Shop PAID

- **Ở đâu:** `apps/hub-api/src/modules/service-api/service-resources.controller.ts:263-293` (`createSubscription`): endpoint chỉ cần thuộc project (`repo.findDestinationById`, dòng 268), không cần là endpoint **do key này tạo**. `apps/shop/src/payment.ts` (`readPayment`) vẫn chỉ tin tên provider `source ∈ {payos,sepay}`. Body push (`apps/hub-worker/src/senders/webhook.sender.ts:28-40`) **không** mang `sourceId`, nên Shop không tự kiểm được nguồn.
- **Tái hiện (hubv, script `scratchpad/p21.mjs`):**
  1. Console tạo key project default, scopes `manage:sources, manage:endpoints, publish:events`.
  2. Key: `POST /v1/p/default/sources {"provider":"sepay","secret":"attacker_apikey_…"}` → 201.
  3. (A — đường vòng của review cũ) ký SePay bằng secret của mình, đơn mới → hub 200, đơn **PENDING** ✓ (fix có tác dụng).
  4. (B) Key `GET /v1/p/default/endpoints` → thấy endpoint `shop`; `POST /v1/p/default/subscriptions {"endpointId":<shop>,"eventTypes":["payment.received"]}` (không ghim) → **201**.
  5. Ký SePay giả cho đơn mới → hub 200 → hub ký Standard Webhooks bằng secret của Shop → **đơn PAID**.
  6. Shop chỉ tắt sub lạ (`exclusive`) **lúc khởi động**; giữa hai lần restart lỗ luôn mở.
- **Test hiện có không bắt được:** `service-resources.spec.ts` MS-P2-1 chỉ kiểm resolve `sourceKeys`; `sdk.spec.ts` chỉ kiểm `ensure` tắt sub cũ.
- **Sửa đề xuất (chọn một, tốt nhất là 1+2):**
  1. Endpoint có chủ: cột `destinations.created_by_key_id`; `/v1/p` chỉ cho key đã tạo endpoint tạo/sửa subscription của nó (khác → 404 như MS-R3).
  2. Phòng thủ ở Shop: thêm `sourceId` vào body push (sửa EVENT-CATALOG + U50), Shop nhớ `subscription.sourceIds` trả về từ `ensure` và bỏ qua event có `sourceId` ngoài danh sách.
  3. Test L0 (đỏ trước khi sửa): key B gắn subscription vào endpoint của key A → 404; E2E: lặp lại bước 4–5, đơn phải PENDING.

### R-2 — **Trung bình** — Key bất kỳ có `manage:endpoints` tắt được subscription đã ghim của Shop (DoS thanh toán)

- **Ở đâu:** `service-resources.controller.ts:299` (`updateSubscription`) chỉ kiểm đích là `webhook` và cùng project.
- **Tái hiện:** cùng key ở R-1, `PATCH /v1/p/default/subscriptions/<sub shop> {"isActive":false}` → 200 `isActive:false`. Từ đó tiền thật không tới Shop tới khi Shop restart (đã bật lại ngay trong phiên review).
- **Sửa:** cùng cơ chế chủ sở hữu như R-1 (chỉ key tạo endpoint mới PATCH được subscription của endpoint đó); audit đã có.

### R-3 — **Trung bình (đã biết, ADR-087 để lại)** — Polling mất event vĩnh viễn khi transaction normalize dài hơn cửa sổ lắng 2s

- **Ở đâu:** `libs/database/src/tenant-scoped.repository.ts:223,238` (`created_at <= clock_timestamp() - 2s`, cursor theo `seq`).
- **Tái hiện (hubv, `scratchpad/settle.mjs`):** psql mở transaction chèn event cafe (seq 10042) rồi `pg_sleep(5)`; trong lúc đó `/events` tạo event B (seq 10043, commit ngay). Poll sau 3s → nhận `[10043]`, `nextCursor=10043`. Sau khi transaction commit, poll `after=10043` → `[]`. Poll lại từ đầu thấy 10042 → consumer polling **mất** 10042.
- **Sửa:** lọc theo snapshot thay vì đồng hồ: chỉ trả event có `xmin < pg_snapshot_xmin(pg_current_snapshot())` (hoặc lưu `txid_current()` vào cột và so với xmin), hoặc dừng trả ở seq đầu tiên mà còn transaction đang mở có seq nhỏ hơn. Tối thiểu: đo p99 INSERT→COMMIT và ghi giới hạn vào báo cáo.
- Dòng thử `evt_review_settle_125` còn trong DB hubv (vô hại).

### R-4 — **Thấp** — V2: dropdown source/đích luôn của project default

- **Ở đâu:** `apps/web/src/app/(admin)/dashboard/events/page.tsx:62-63` (`useSources()`, `useDestinations()` không gửi `?projectId=`).
- **Hậu quả:** chọn project cafe rồi lọc theo một source → server (đúng scope) trả 0 dòng; người dùng tưởng không có dữ liệu. Không lộ dữ liệu (server scope đúng, đã thử `?source=<uuid default>` trong project khác).
- **Sửa:** cho `useSources/useDestinations` nhận `projectId` (dùng `withProject`, route `/api/v1/sources|destinations` đã qua ProjectScopeGuard); xoá bộ lọc source/đích khi đổi project.

### R-5 — **Thấp** — Socket chỉ room của tenant JWT: V3 project khác nhấp nháy theo traffic của default

- **Ở đâu:** `apps/web/src/components/flow/topology-canvas.tsx:482-488` — khi không có `trace.ingested`, `event.received` của **default** làm chấm chạy trên source cùng provider của bản đồ **cafe** (vd SePay). `socket.ts` cũng invalidate `flow` cho mọi project.
- **Đánh giá:** cô lập dữ liệu đúng (T14.4 PASS), nhưng hình ảnh "realtime" trên project khác là sai. V2 của project khác không tự cập nhật (không `refetchInterval`).
- **Sửa:** client bỏ qua payload có `tenantId !== projectId đang xem` (payload đã có `tenantId`); với project ≠ default, V2 thêm `refetchInterval` ~10s và hiện nhãn "không realtime". Lâu dài: socket join room project sau khi kiểm như ProjectScopeGuard.

### R-6 — **Thấp** — Chặng `routed` liệt kê cả subscription tạo SAU event

- **Ở đâu:** `apps/hub-api/src/modules/flow/flow.repository.ts:270` (`findSubscriptionsMatching` không lọc theo thời gian).
- **Tái hiện:** event `evt_01M4KA0245EVC2MG6E6HPQVF3V` (default) hiện `atk-1791649384329 = subscription_inactive`, trong khi subscription đó được tạo sau event. Nhãn "trạng thái hiện tại" có, nhưng vẫn dễ đọc nhầm khi demo.
- **Sửa:** thêm `createdAt: { lte: event.createdAt }` vào candidate.

### R-7 — **Thấp** — Seed default "đã có chưa" dựa trên đếm mọi source của default

- **Ở đâu:** `libs/database/src/seed.ts:219`. `ensureShopKey()` chạy trước; nếu sau này `SEED_SHOP_API_KEY` được cấp `publish:events` thì sinh source `api_*` trong default → seed default bị bỏ qua, quay lại đúng lỗi P2-2.
- **Sửa:** kiểm theo `sourceKey IN ('src_payos_main','src_sepay_main','src_github_main')` hoặc chạy `seedDefaultWorld()` trước `ensureShopKey()`.

### R-8 — **Thấp** — Shop `ensure` thất bại thì sub cũ không ghim vẫn bật

- **Ở đâu:** `libs/hub-sdk/src/client.ts` `ensure`: `exclusive` chỉ chạy sau khi tạo sub ghim thành công. Nếu thiếu `src_payos_main`/`src_sepay_main` (deploy dùng sourceKey khác) → 422 `unknown_source`, Shop thử 6 lần rồi dừng, sub cũ (nếu có, DB nâng cấp từ trước MS-P2-1) vẫn nhận mọi `sepay`.
- **Sửa:** khi `exclusive` mà tạo lỗi thì vẫn tắt sub không ghim của endpoint, hoặc Shop không trả 200 cho event khi chưa ghim xong.

### R-9 — **Thấp (vệ sinh BB-5)** — `flowRepoFor` lấy client bằng ép kiểu vào field private

- **Ở đâu:** `apps/hub-api/src/modules/flow/flow.repository.ts` cuối file (`svc.forTenant(t) as unknown as { prisma }`). Mọi câu SQL đều lọc `tenant_id`, nên không có lỗ. Nhưng đây là lối thoát không tên; đổi tên field trong `TenantScopedRepository` sẽ vỡ lúc chạy, không phải lúc biên dịch. ADR nháp EF-2 đã hẹn chuyển vào repo gốc.
- **Sửa:** chuyển các hàm vào `TenantScopedRepository` (đã merge xong đa service nên hết lý do né file đó), hoặc thêm hàm có tên `PrismaService.flowRepo(tenantId)`.

### R-10 — **Thấp** — Ghi nhận hình thức / hợp đồng

- Nhãn cạnh `payment.received · PayOS, SePay Bank Mo…` của Shop bị cắt và đè lên cạnh (ảnh `screens/v3-flow-map-light.png`). Chấp nhận được (không chấm giao diện).
- §6A dòng "Header gửi đi Standard Webhooks — tab Payload/Response hiển thị header đã gửi, che chữ ký": **chưa làm** (`delivery_attempts` không lưu header gửi đi). Nên ghi lệch vào §10 của spec.
- `verifyWebhook`-style regex che header ở UI (`detail-cards.tsx:86`) không có `webhook-signature`; server đã che lúc lưu nên chỉ là phòng thủ thêm.

## 3. Bằng chứng E2E (hubv build từ `1a43972`)

**MS-P2-3, Redis** (`scratchpad/p23.mjs`, mỗi request gửi 2 lần):

| Trạng thái Redis | `/hooks/sepay` (mới / trùng) | `/v1/p/cafe/events` (mới / trùng) |
|---|---|---|
| chạy | 23 / 10 ms | 18 / 8 ms |
| `docker stop` | 99 / 25 ms | 13 / 14 ms |
| `docker pause` (kết nối treo) | 1028 / 622 ms | 925 / 620 ms |

Postgres: mỗi khoá (`sepay:<id>`, `api:rv-…`) đúng 1 `raw_events`; 6 event cafe cho 3 vòng × 2 đường. Lúc `pause`, độ trễ ≈ 2–3 × `commandTimeout` 300ms, dưới ngưỡng 10s của provider. Trước sửa: 8,6–18,3s.

**MS-P2-4**, `validateAndPinUrl` với `NODE_ENV=production`: chặn `[::ffff:7f00:1]`, `[0:0:0:0:0:ffff:127.0.0.1]`, `[::127.0.0.1]`, `[::ffff:0:127.0.0.1]`, `[64:ff9b:1::7f00:1]`, Teredo `2001:0:…`, `fec0::1`, `2130706433`, `0x7f000001`, `127.1`, `[::]`, `0`, `[2002:a00:1::]`, `localhost`, `[::ffff:a9fe:a9fe]`, `192.0.0.170`; cho qua `8.8.8.8` và `[2606:4700:4700::1111]`.

**Event Flow** (`scratchpad/flow.mjs`, `flow2.mjs`, project cafe + default):
- Event `/events` origin `api` kèm 1 đích console trỏ `http://hub-api:4000/nope-404` và 1 endpoint `/v1/p` FAILED (`http_500`): executions `failed`, `failedAt = delivering · http_4xx · HTTP 404 · lần 1/6`. Chi tiết: `verified` = "API key hợp lệ", `origin=api`, `provider=api`, routed skipped = `endpoint_unverified`, nhánh `failed:http_4xx`.
- Event SePay cafe → `cafe-endpoint` (sink): `succeeded`, mọi chặng ok, "Chữ ký SePay hợp lệ".
- Event SePay từ source của kẻ tấn công trong default: routed skipped `shop = source_filtered` (đúng với fix P2-1), Telegram ok.
- Chéo project: event cafe gọi không `projectId` (default), với `projectId=bookstore`, raw id cafe với `projectId=bookstore`, và id không tồn tại → đều `404 {"message":"Hành trình không tồn tại","error":"Not Found","statusCode":404}`, giống hệt nhau. Executions của bookstore lọc type đó → 0 dòng. `projectId` lạ → 404 `not_found` từ ProjectScopeGuard. Response không chứa `configEncrypted`/`signingSecret`/`whsec_`/`hk_`.

**T14.4** (`scratchpad/sock.cjs`, `sock2.cjs`): socket JWT admin (tenant default) trong 6s cafe `/events` 202 + SePay cafe 200 → 0 tin `event.received`/`delivery.attempt`/`trace.ingested`. Đối chứng: `/events` vào default → 1 `event.received` với `tenantId` default.

## 4. Đánh giá test của từng fix (có đỏ khi bỏ fix không)

| Fix | Test | Đỏ khi bỏ fix? |
|---|---|---|
| P2-1 | `service-resources.spec.ts`, `sdk.spec.ts` | Có, cho phần đã sửa. **Không** có test cho R-1/R-2 |
| P2-2 | `seed-fresh-db.spec.ts` (L1, migrate + seed thật) | Có |
| P2-3 | `redis-down.spec.ts` (host không định tuyến được) | Có (cấu hình cũ treo > 30s). Không có ca "kết nối có nhưng treo" (đo tay ở trên) |
| P2-4 | `ssrf-ipv6.spec.ts` (19 dạng + link-local NAT64/6to4) | Có |
| P2-5 | `backfill-projects-db.spec.ts` | Có (chạy SQL hai lần) |
| P2-6 | `cleanup-job.spec.ts` (TTL 3240, không `eval`), `cors.spec.ts` | Có |

## 5. Dấu vết để lại trên hubv / máy

- hubv: key `attacker-*` (đã revoke), 2 source `src_sepay_01m4k9…`/`src_sepay_01m4ka02…` và 2 subscription `atk-*` (đã tắt) trong default; trong cafe: đích `rv-dead-*`, endpoint `rv-unver-*` + 2 subscription chỉ khớp `review.t*`, key `flowrv-*`/`review-*` đã revoke; event `evt_review_settle_125`. Subscription `shop` đã bật lại. Muốn sạch: `npm run verify:reset`.
- File tạm của review: `C:\webhook-hub\node_modules\.cache\review-sock.cjs` (bản sao trong scratchpad; nằm trong `node_modules`, không bị track; xoá tay được). Script còn lại ở scratchpad của phiên.

---

# Vòng 2 (11/10, master `5358103`)

hubv build lại từ `5358103` (`verify:reset`, volume sạch). Chỉ đọc mã nguồn, không commit.

## V2.0 Cổng tự động

| Lệnh | Kết quả |
|---|---|
| `verify:unit` | L0 **557 / 0 / 0** (= baseline) |
| `verify:db` (hubv) | L1 **93 / 0 / 0** (= baseline) |
| `verify:map` | 198 mã · 0 mồ côi · 0 ma · 0 trùng |
| `verify:gates` | 12 luật · 0 vi phạm · 7 ngoại lệ có lý do |
| `verify:reset` | seed: "đã có 3 source seed"; default đủ thế giới; Shop đăng ký xong, `trustedSourceIds` = 2 id (`src_payos_main`, `src_sepay_main`) |

## V2.1 Kết luận từng mục

| Mục | Commit | Kết luận cuối |
|---|---|---|
| R-1 endpoint có chủ + `sourceId` trong body + Shop tin id đã ghim | 91157b6 | **PASS** (lỗ đã đóng; R2-1, R2-2 là hệ quả phụ) |
| R-2 PATCH theo chủ | 59a8c9d | **PASS** |
| R-3 `poll_seq` theo thứ tự COMMIT | 9f1a25d | **PASS** (ghi chú R2-3, R2-4) |
| R-7 seed theo sourceKey | 40418f6 | **PASS** |
| R-9 `prisma` protected + `extend(Sub)` | 2d9d627 | **PASS-có-điều-kiện** (R2-5) |
| R-6 routed chỉ xét sub tồn tại lúc event | 414e208 | **PASS** (L1 `[UI:R6-01]`) |
| R-4 dropdown V2 theo project | ffd25f4 | **PASS** (đọc code: `useSources/useDestinations(projectId)`, xoá lọc khi đổi project) |
| R-5 socket vào room project | d622299 + dea7f62 | **PASS** |
| §6A header gửi đi | 4186715 | **PASS (chấp nhận lệch)**: UI nói thẳng là không lưu, không bịa; thêm che `webhook-signature` |
| R-8 (Shop chưa ghim) | trong 91157b6 | **PASS-có-điều-kiện**: an toàn (503), nhưng hỏng tính sống (R2-1) |
| Merge `5358103` | — | **PASS**: L0/L1/map/gates xanh trên cây đã merge |

## V2.2 Bằng chứng E2E

**R-1/R-2: chạy lại đúng kịch bản cũ** (`scratchpad/p21.mjs`) với key default `manage:sources, manage:endpoints, publish:events`:
- Source sepay riêng + webhook giả: hub 200, đơn **PENDING**.
- `GET /v1/p/default/endpoints` của key tấn công **không thấy** endpoint `shop`; `GET /subscriptions` rỗng.

**Biến thể** (`scratchpad/p21b.mjs`, id endpoint/sub của Shop lấy thẳng từ DB, coi như kẻ tấn công đoán được):

| Thao tác | Kết quả |
|---|---|
| Key default: gắn sub vào endpoint Shop | 404 `{"error":"not_found"}` |
| Key default: PATCH tắt sub đã ghim của Shop | 404, sub `shop` vẫn `is_active=t` |
| Key default: `/endpoints/<shop>/verify` | 404 |
| Key default: poll `?endpointId=<shop>` / UUID ngẫu nhiên | 404 / 404 (giống hệt) |
| Key **cafe**: gắn/PATCH qua `/v1/p/cafe/...` và gọi `/v1/p/default/...` | 404 / 404 / 404 |
| **Operator** tạo sub KHÔNG ghim từ console tới endpoint Shop + webhook từ source của kẻ tấn công | delivery tới Shop **SUCCEEDED 200 `{"status":"IGNORED"}`**, đơn **PENDING** (lớp 2 ở Shop chạy đúng) |
| Đối chứng: SePay thật vào `src_sepay_main` | đơn **PAID 69000** |

**R-3** (`scratchpad/settle.mjs`, transaction psql giữ 6s): poll lần 1 trả `[15,16,17]` (`next 17`); sau khi transaction commit, poll `after=17` trả event chậm với `seq 18`. **Không mất.** Trước đây event này mất vĩnh viễn.

**R-3 đồng thời** (`scratchpad/conc.mjs`): 300 `POST /events` (30 song song mỗi đợt, 1,3s) trong lúc **3 poller** chạy `limit=50`. Mỗi poller nhận **300/300**, 0 trùng, `seq` tăng nghiêm ngặt; cả 3 thấy **cùng một chuỗi**. Thời gian poll p50 15–16ms, p95 66–97ms. Polling vẫn không chạm Redis (`redis-budget.spec.ts` trong L0 xanh).

**R-5** (`scratchpad/sock3.cjs`):
- Handshake `projectId` là UUID không tồn tại → `PROJECT_NOT_FOUND`.
- Chuỗi tiêm `' OR 1=1` → `PROJECT_NOT_FOUND`.
- Thiếu token hoặc token sai kèm `projectId` cafe → `UNAUTHORIZED`.
- Socket `projectId=cafe` chỉ nhận `event.received` của cafe; socket không có `projectId` chỉ nhận của default.
- Mảng `[cafeId]` được nhận như HTTP guard (lấy phần tử đầu), nhất quán.
- "Vào chéo tenant" bằng `projectId` hợp lệ là **chủ ý**: admin env là operator (ADR-056). AU3 phải thay luật trong `resolveProjectScope`, chỗ duy nhất.

## V2.3 Phát hiện mới

### R2-1 — **Trung bình** — Shop bỏ cuộc sau 6 lần đăng ký, sau đó trả 503 vĩnh viễn

- **Ở đâu:** `apps/shop/src/main.ts:218` (`if (attempt < 6) setTimeout(…, 10_000)`) kết hợp `main.ts:131` (`trustedSourceIds.length === 0` → 503).
- **Tái hiện (hubv):** `docker stop hubv-hub-api-1`, `docker restart hubv-shop-1`, chờ 75s, `docker start hubv-hub-api-1`. Log Shop: 6 lần "Đăng ký endpoint với hub lỗi", 0 lần VERIFIED. Gửi SePay thật vào `src_sepay_main` → delivery tới Shop **RETRYING 503 "Shop chưa đăng ký xong với hub"**. Shop không tự lành; mọi khoản thanh toán đi vào retry, rồi DLQ, tới khi có người restart Shop.
- **Vì sao đáng kể:** trước R-8, hub chết lúc Shop khởi động chỉ làm Shop không tự đăng ký. Giờ nó chặn hẳn nhận tiền. Trên Render free, hub autosuspend và cold start ~30–60s, sát mức ~50s mà Shop chịu được.
- **Sửa:** thử lại vô hạn với backoff có trần (10s → 60s), hoặc khi nhận webhook mà `trustedSourceIds` rỗng thì gọi `ensure` (một lần, có khoá) trước khi trả 503. Test: Shop khởi động lúc hub chết > 60s vẫn phải VERIFIED sau khi hub lên.
- Đã restart Shop trên hubv để trả lại trạng thái.

### R2-2 — **Thấp** — Đổi key Shop / DB nâng cấp: Shop sinh endpoint thứ hai, endpoint cũ vẫn nhận

- **Ở đâu:** `GET /v1/p/:project/endpoints` lọc theo `created_by_key_id`, còn SDK `ensure` tìm endpoint theo URL **trong danh sách đó**.
- **Tái hiện (hubv):** đặt `created_by_key_id=NULL` cho endpoint `shop` (giống DB nâng cấp từ trước R-1, hoặc key Shop đã xoay). Restart Shop → tạo endpoint `shop` **thứ hai** cùng URL, kèm sub ghim mới. Endpoint cũ và sub cũ (`shop:true:2`) vẫn bật. Mỗi khoản tiền gửi 2 lần tới Shop. Không sai tiền vì Shop chống trùng bằng `webhook-id`, nhưng tải gấp đôi, và không key nào dọn được qua `/v1/p` (chỉ operator).
- **Sửa:** migration gán `created_by_key_id` cho endpoint `/v1/p` cũ theo audit `endpoint.create` (`actor = key:<id>`); thêm "chuyển chủ endpoint" ở console. Ghi vào DEPLOYMENT: xoay key Shop thì operator tắt endpoint cũ.
- Trên hubv đã tắt sub của endpoint cũ.

### R2-3 — **Thấp** — `seq` của polling giờ là `poll_seq`, khác `seq` của dashboard

- **Ở đâu:** `libs/database/src/tenant-scoped.repository.ts`: `pollEvents` trả `e.poll_seq AS seq`, trong khi `findEventsAfterSeq` (dashboard `?after=`, dòng 277) vẫn theo `events.seq`. Trên DB mới hai dãy lệch xa (đo: poll `seq` 15–18 trong khi `events.seq` ≈ 10037).
- **Hậu quả:** dev lấy "seq" thấy trên dashboard làm cursor polling sẽ bỏ sót hoặc nhận lại. Dashboard `after=<seq>` vẫn có lỗi R-3 cũ (chỉ là màn xem, không phải consumer).
- **Sửa:** đổi tên trường API thành `cursor`, hoặc ghi rõ trong EVENT-CATALOG/SDK "seq là cursor polling, không phải events.seq".

### R2-4 — **Thấp (ghi nhận hiệu năng / test)** — Mỗi lần poll (kể cả mỗi giây của long-poll) là một transaction ghi

- **Ở đâu:** `assignPollSeq` (`tenant-scoped.repository.ts:257`) chạy trước mỗi `pollEvents`; `longPoll` gọi lại mỗi lượt. N client chờ = N transaction `pg_advisory_xact_lock` + `UPDATE` mỗi giây, xếp hàng theo tenant.
- Đo được p50 15ms / p95 ≤ 97ms với 3 poller + 300 publish, ổn ở quy mô đồ án. Trên Neon pooled vẫn hợp lệ (lock theo transaction).
- **Gợi ý:** bỏ qua UPDATE khi một SELECT rẻ trên index một phần không thấy dòng `poll_seq IS NULL`.
- Migration backfill `poll_seq = seq` + `setval(max(seq))` đúng khi đọc code, nhưng **không có test** chạy migration trên DB có dữ liệu.

### R2-5 — **Thấp (BB-5)** — `prisma` protected: mọi lớp con có client trần

- **Ở đâu:** `libs/database/src/tenant-scoped.repository.ts:14,27`. Hiện chỉ có **một** lớp con (`FlowScopedRepository`), mọi câu đều lọc tenant (đã kiểm ở vòng 1), không còn ép kiểu. So với ép kiểu vào field private trước đây, đây là cải thiện. Nhưng `protected` + `extend()` mở cửa cho lớp con mới viết truy vấn không scope mà gates không bắt.
- **Sửa:** thêm luật gate: `extends TenantScopedRepository` chỉ được ở danh sách file cho phép (hiện là `apps/hub-api/src/modules/flow/flow.repository.ts`), kèm lý do, giống luật `rls-system`.

## V2.4 Dấu vết vòng 2 trên hubv

Mọi key của review (`attacker-*`, `atk2-*`, `atkc-*`, `s3-*`, `review-*`, `flowrv-*`) **đã revoke**. Còn lại:
- source `src_sepay_01m4kca2…`, `src_sepay_01m4kcb2…`;
- sub `op-unpinned-*` (đã tắt);
- endpoint `shop` thứ hai (do R2-2; sub của endpoint cũ đã tắt);
- event `evt_review_settle2_*` và 300 event `conc.r*` trong cafe.

Dọn sạch: `npm run verify:reset`.

---

# Vòng 3 (11/10, master `2f1eb63`)

hubv build lại từ `2f1eb63`. Chỉ đọc mã nguồn, không commit.

## V3.0 Cổng tự động

| Lệnh | Kết quả |
|---|---|
| `verify:unit` | L0 **564 / 0 / 0** (= baseline) |
| `verify:db` | L1 **95 / 0 / 0** (= baseline) |
| `verify:map` | 198 mã · 0 mồ côi · 0 ma · 0 trùng |
| `verify:gates` | **13** luật (thêm `repo-subclass`) · 0 vi phạm · 7 ngoại lệ có lý do |

## V3.1 Kết luận

| Mục | Commit | Kết luận |
|---|---|---|
| R2-1 Shop tự lành | 2956f31 | **PASS** |
| R2-2 gán chủ từ audit + nhận lại endpoint | 3174447 | **PASS-có-điều-kiện** (R3-1) |
| R2-3 trường `cursor` | fb07d78 | **PASS** (R3-2: còn sót chữ "seq" trong tài liệu) |
| R2-4 test migration + bỏ transaction ghi khi không có dòng chờ | 33a9c3f | **PASS**: không đưa lại lỗi R-3 |
| R2-5 gate `repo-subclass` | 2f1eb63 | **PASS** (R3-3) |

## V3.2 Bằng chứng

**R2-1.** Tắt hub-api, restart Shop, chờ 90s, bật hub-api lại. Log Shop: 5 lần lỗi, 5 lần "Sẽ thử đăng ký lại", rồi **VERIFIED**, không cần ai can thiệp. SePay thật sau đó → delivery tới Shop **SUCCEEDED 200**. Vòng 2 cùng kịch bản thì 503 vĩnh viễn.

**R-3 sau 33a9c3f.**
- Transaction psql giữ 6s: poll 1 trả `cursor 17`; sau khi commit, poll `after=17` trả event chậm với `cursor 18`. Không mất.
- 3 poller + 300 publish song song: mỗi poller **300/300**, 0 trùng, tăng nghiêm ngặt, cùng một chuỗi; p50 14ms, p95 33–49ms.
- Response chỉ còn `cursor`, không còn `seq`.
- Lý lẽ an toàn: SELECT `EXISTS(poll_seq IS NULL)` ngoài lock chỉ có thể bỏ lỡ dòng commit sau nó. Dòng đó được gán ở lần poll sau với giá trị lớn hơn mọi giá trị đã thấy, nên không mất. Đọc không chờ lock cũng an toàn vì các lần gán vẫn nối tiếp nhau.

**R2-2: thử lạm dụng việc nhận lại endpoint** (`scratchpad/adopt.mjs`, `adopt2.mjs`):

| Thử | Kết quả |
|---|---|
| Key khác, **cùng** serviceName, khi key chủ **còn sống** | tạo endpoint mới, không nhận |
| Key khác serviceName, khi key chủ đã revoke | tạo mới |
| Key cùng serviceName ở **project khác** (cafe) | tạo mới |
| Key cùng serviceName, cùng project, key chủ đã revoke | **nhận lại** (đúng thiết kế), VERIFIED |
| Key cùng tên tạo khi người nhận lại còn sống | tạo mới |
| Key cũ còn sống cùng tên, sau khi người nhận lại bị revoke | nhận lại (vẫn đúng luật "cùng service") |
| **Revoke key `shop`, operator tạo key mới tên `shop`, POST url Shop với `signingSecret` SAI** | `201 adopted:true` nhưng **`verification FAILED http_401`**; endpoint `shop` của Shop thành FAILED → Shop ngừng nhận tiền (xem R3-1) |

Kẻ tấn công **không tự tạo được** key tên `shop`: key chỉ sinh từ console operator, key service không có `manage:keys`. Vì vậy việc chiếm endpoint đòi hỏi operator đặt trùng serviceName (do nhầm, hoặc do người trong nội bộ).

## V3.3 Phát hiện

### R3-1 — **Thấp** — Nhận lại endpoint chuyển chủ TRƯỚC khi chứng minh sở hữu; challenge hỏng thì endpoint đang chạy thành FAILED

- **Ở đâu:** `apps/hub-api/src/modules/service-api/service-resources.controller.ts` `adoptEndpoint` (gọi từ `createEndpoint:182`): `updateDestination(createdByKeyId)` và audit chạy trước `verifier.challenge`; kết quả FAILED được ghi đè lên endpoint đang VERIFIED.
- **Tái hiện:** ở bảng trên (hàng cuối). Sau đó `shop|FAILED|http_401`, delivery thanh toán bị normalize bỏ qua (endpoint chưa VERIFIED).
- **Điều kiện:** key mới phải cùng serviceName, cùng project, và key chủ đã revoke. Chỉ operator tạo được key như vậy, nên mức Thấp. Nhưng một lần xoay key mà secret cấu hình sai cũng làm Shop ngừng nhận tiền mà không có cảnh báo rõ.
- **Sửa:** challenge trước (bằng `signingSecret` mới nếu có, không thì secret đã lưu). Chỉ khi VERIFIED mới chuyển chủ và ghi audit. FAILED thì trả `409 {error:"adoption_failed", verificationError}` và giữ nguyên chủ cũ lẫn trạng thái cũ. Thêm test L0 cho ca "secret sai → không đổi chủ, endpoint vẫn VERIFIED".

### R3-2 — **Thấp (tài liệu)** — Còn sót "seq" cho polling `/v1/p`

- `docs/ARCHITECTURE.md:550` và `:822` vẫn ghi `GET /v1/p/…/events?after=<seq>`.
- `service-resources.controller.ts:370` (comment "seq là CHUỖI") và `:377` (thông báo 422 "after là seq (chuỗi số ≥ 0)").
- SDK (`libs/hub-sdk/src/client.ts:53,135`) và EVENT-CATALOG §5a đã đúng `cursor`. Sửa: đổi các chỗ trên thành `<cursor>` / "after là cursor".

### R3-3 — **Thấp** — Gate `repo-subclass` chỉ khớp một mẫu chữ

- **Ở đâu:** `verify/lib/gates.ts:128` (`/\bclass\s+\w+\s+extends\s+TenantScopedRepository\b/`). Import đổi tên (`import { TenantScopedRepository as Base }` … `extends Base`) hoặc xuống dòng giữa `extends` và tên lớp sẽ lọt.
- Chấp nhận được cho một luật lint. Có thể thêm luật cấm `TenantScopedRepository as`.

## V3.4 Kết luận cuối cho phạm vi đa service + UI Event Flow

**PASS-có-điều-kiện.** Mọi phát hiện Cao/Trung bình của ba vòng đã đóng và đã kiểm lại E2E trên hubv:
- MS-P2-1..6, R-1, R-2, R-3, R2-1.
- Cô lập project: HTTP, Socket.IO, `/v1/p`, `/api/v1/flow/*`.
- BB-2/BB-3: Redis chết vẫn đúng và nhanh.
- Polling không mất event.
- Shop chỉ nhận tiền từ đúng source của operator.

Còn mở 3 mục **Thấp** (R3-1..R3-3), không chặn bảo vệ. Nên sửa R3-1 trước demo xoay key.

hubv đã `verify:reset` về trạng thái sạch sau khi thử R3-1 (key `shop` đã bị revoke trong lúc thử).
