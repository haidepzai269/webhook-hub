# REVIEW — KQ1 (`30c8cf5`) + Flow UI (`c9cc1d5`) — 2026-10-12

Reviewer độc lập. Phạm vi: hai commit local chưa push trên `master`. Không sửa source, không commit, không restart container, không đụng production.

## Kết luận

| Commit | Verdict | Blocker | High |
|---|---|---|---|
| A `30c8cf5` KQ1 PayOS confirm probe | **GO** | 0 | 0 |
| B `c9cc1d5` Flow UI kiểu n8n | **GO-with-fixes** (fix sau push được) | 0 | 0 |
| **Push cả hai** | **GO-with-fixes** — đẩy được ngay; M-B1 nên vá ở commit kế | 0 | 0 |

## Bằng chứng đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx jest -w 2` | 123 suite pass, 885 test pass, 156 skip (L1 không đặt `RUN_DB_TESTS`). **2 suite đỏ: `libs/database/test/seed-fresh-db.spec.ts`, `poll-seq-migration-db.spec.ts` — `TypeError: Invalid URL`** do dựng `new URL(testDbUrl('owner'))` ngay lúc nạp file khi không có env DB. Có từ trước, hai commit này không đụng (lần sửa cuối `33a9c3f`). Không chặn. |
| Spec liên quan (`redis-budget`, `payos-confirm-probe`, `ingest-payos-probe`, `normalize-consumer`, 3 spec `components/flow`) | 7/7 suite, 63/63 test pass. **Ngân sách Redis R1 không đổi** (probe không thêm lệnh; nhánh `continue` chỉ bỏ tra subscription). |
| `npm run verify:gates` | 14 luật · 0 vi phạm · 11 ngoại lệ có lý do (bb1 `orderCode` trong `payos.adapter.ts` thuộc ngoại lệ sẵn có ADR-058). |
| `tsc --noEmit` hub-api / hub-worker / web | 0 lỗi cả ba. |
| `npm run build --workspace=apps/web` | Build OK, đủ route (`/dashboard/flow`, `/shop`, `/shop/settings`…). |
| L1 `apps/hub-api/test/polling-db.spec.ts` trên hubv (`RUN_DB_TESTS=1`, `DATABASE_URL` = `hub_app` theo `verify/lib/compose.hostUrls()`, fixture bằng owner) | **10/10 pass**, gồm `[KN:U16] (phần j)`. `pg_roles`: `hub_app` `rolsuper=f`, `rolbypassrls=f`. Migration `20261012030000_event_probe` đã áp trên hubv, cột `hub.events.probe` có. |

## A — KQ1: kiểm 5 tiêu chí của spec owner

| # | Tiêu chí | Kết quả | Ghi chú |
|---|---|---|---|
| 1 | Khớp ĐỦ ba trường, chỉ sau verify; âm tính từng trường vẫn ra `payment.received` | ✅ | `isPayosConfirmProbe`: `orderCode === 123` (số), `description === "VQRIO123"`, `reference === "TF230204212323"`. Chỉ gọi trong `PayosAdapter.normalize` (worker, sau raw ACCEPTED). Test (b): orderCode 124, orderCode `"123"` chuỗi, reference `FT…`, description khác → `payment.received`, `probe` undefined. Test (c)/(i): chữ ký sai → verify false / 401, không ACCEPTED, không outbox. Body lạ (null, chuỗi, `data` không phải object) → false. |
| 2 | Raw ACCEPTED + 200 (BB-3); không `if provider` trong lõi | ✅ | Ingest không đổi (test g: ACCEPTED + outbox cùng tx, 200 `code "00"`). Lõi (`normalize.consumer.ts`, `pollEvents`) chỉ đọc cờ `probe`; từ vựng PayOS chỉ ở adapter (BB-1). Cờ `probe` dùng chung được cho provider khác. |
| 3 | Không rò tới service | ✅ | Xem bảng đường ra bên dưới. |
| 4 | Confirm lặp → duplicate, 200/"00", không 4xx | ✅ | Khoá `payos:123:TF230204212323` cố định; test (h) cả Redis trúng lẫn PG `P2002` → 200 `"00"`, không bản ghi thứ hai. |
| 5 | ADR có đánh đổi | ✅ | ADR-159 đủ vấn đề / chọn / đánh đổi (phụ thuộc bộ mẫu tài liệu; PayOS đổi mẫu → quay về hành vi cũ; giao dịch thật trùng cả ba bị nuốt nhưng raw còn). EVENT-CATALOG §2 mục 10 + SPEC §8.1/§11 cập nhật. |

### Mọi đường đọc `hub.events` / đẩy ra ngoài

| Đường | Ai nhận | Probe ra không? | Căn cứ |
|---|---|---|---|
| Delivery (subscription, gồm `*`, `payos.*`) | Service | **Không** | `continue` trước `findActiveSubscriptionsForEvent` → 0 delivery, 0 outbox `delivery.requested` (test e). |
| Polling `/v1/p/:project/events` (không lọc, `*`, `payos.*`, đúng kiểu, `readTypes ['*']`, `status=failed`) | Service (API key) | **Không** | `AND NOT e.probe` trong `pollEvents`, vẫn `tenant_id = …` + RLS hub_app (BB-5). L1 (j) chạy thật. `failedOnly` cũng qua cùng WHERE. Poll_seq vẫn cấp cho probe (chỉ là vị trí, không lộ nội dung) — đúng. |
| `after=latest` | Service | Không lộ nội dung | Chỉ trả cursor max. |
| Replay đơn / replay hàng loạt | Console | Không áp dụng | Chỉ thao tác trên delivery DEAD; probe không có delivery. |
| Renormalize (`raw-events/renormalize`) | Console | Không | Chỉ raw mồ côi; đi lại qua adapter → vẫn `probe:true`. |
| Outbox relay / delivery sweeper | Hạ tầng | Không | Chỉ đọc `outbox` / `deliveries`; probe không tạo dòng nào. |
| Cleanup/retention | Hạ tầng | Không ra ngoài | Chỉ xoá. |
| Realtime `event.received` (Redis pub → Socket.IO) | **Console** | Có (chấp nhận) | Gateway đòi vé socket + session sống, room `project:<tid>`. Không phải kênh service. `deliveries: []`. |
| `/api/v1/events`, `/api/v1/events/:id`, flow trace | **Console** | Có (chấp nhận) | `SessionGuard` (cookie người), không nhận API key. |
| `/v1/p/:project/sources/:id/inspect` | Service (`manage:sources`) | Chỉ chẩn đoán raw | Không trả body/chữ ký; không phải event chuẩn. Chấp nhận. |
| `@hub/sdk` / `hub listen` | Service | Không | Đi qua polling. |

### Migration + triển khai

- `ALTER TABLE "hub"."events" ADD COLUMN "probe" BOOLEAN NOT NULL DEFAULT false` — PG ≥ 11 chỉ ghi metadata, không viết lại bảng. Grants của `hub_app` là cấp bảng (`GRANT … ON ALL TABLES` + default privileges) → cột mới tự có quyền; RLS theo `tenant_id` không đổi. Prisma `probe Boolean @default(false)` khớp. Không phải migration dữ liệu → gate `data-migration-rls` không áp.
- Render `hub-all`: `docker-entrypoint.sh` chạy `prisma migrate deploy` (có `set -e`) **trước** khi supervisor bật cả api lẫn worker → không có cửa sổ "code mới + cột cũ". Migrate lỗi → container chết, Render giữ bản cũ. Cửa sổ "code cũ + cột mới" (instance cũ còn chạy lúc zero-downtime, hoặc rollback): an toàn — Prisma cũ không chọn/ghi cột này, INSERT nhận DEFAULT false. Rủi ro duy nhất: probe PayOS tới đúng lúc instance cũ còn xử lý → hành vi cũ (như trước), không hỏng.

### Phát hiện A

| ID | Mức | Nội dung | Đề xuất |
|---|---|---|---|
| L-A1 | Low | Flow trace (`/flow/events/:id`) của event probe: `classifySkippedSubscriptions` không biết `probe`, subscription `*`/`payos.*` đang bật không có delivery → chặng routed hiện `skipped` với lý do `no_subscription` — sai nghĩa (có subscription, cố ý không định tuyến). Chỉ console. | Truyền `probe` vào `EventFlowInput`, thêm reason `provider_probe` ("Request kiểm tra của provider — không định tuyến"). |
| L-A2 | Low | `ADD COLUMN` vẫn lấy `ACCESS EXCLUSIVE` thoáng qua; không có `SET lock_timeout`. Với tải Neon đồ án là không đáng kể. | Tuỳ chọn: `SET lock_timeout = '5s';` đầu migration cho các migration DDL sau này. |
| I-A3 | Info | `raw_events` unique `(source_id, idempotency_key)`: probe production ngày 11/10 trên `src_payos_main` đã nằm sẵn với khoá `payos:123:TF230204212323`. Sau deploy, "Kết nối lại" **cùng source** → DUPLICATE ở ingest → không normalize lại → **không thấy `payos.webhook_test` trên production**; event `payment.received` 3000 cũ (đã giao cho Shop) vẫn nằm đó. | Khi lấy bằng chứng sau deploy / demo hồi 3: dùng source PayOS mới (hoặc project mới), và nói rõ event ma cũ là trước ADR-159. |
| I-A4 | Info | Probe khớp cả khi `code ≠ "00"` → vẫn `webhook_test` (không thành `payment.failed`). Hợp lý. | — |

## B — Flow UI

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| Timer / rò bộ nhớ | ✅ | Một `setTimeout` duy nhất cho prune, đặt theo `nextWakeAt`, `clearTimeout` trong cleanup của effect (cả unmount). `livePrune` xoá token/kết quả hết hạn; `nextWakeAt === null` → không timer. TTL 15 s + trần 50 token/chặng → bộ nhớ bị chặn. Listener `resize` gỡ khi unmount; socket `off*` gỡ như cũ. (`setTimeout(pulse…)` 450/500/900 ms có từ trước, không clear khi unmount — vô hại, ngắn.) |
| Bão render khi burst | ⚠ | Xem L-B2. |
| localStorage có rào | ✅ | `viewerStorage()` bọc `window.localStorage` trong try/catch; `readLogHeight`/`writeLogHeight` try/catch, rác/âm → mặc định; đọc sau mount (không lệch hydrate); chỉ ghi khi thả chuột. |
| Đích không dùng không bị ẩn lặng lẽ | ✅ | Mặc định `showUnused = true` (vẽ mờ "KHÔNG DÙNG"); ẩn chỉ khi người dùng bấm pill/tuỳ chọn; pill luôn hiện số kèm "(đang ẩn)". Bỏ luật cũ `orphanIdle` (trước đây ẩn lặng lẽ đích idle mồ côi) — tốt hơn. Cạnh ảo `normalize → dst` chỉ cho dagre. |
| Đếm ở header | ✅ (có ngoại lệ M-B1) | Đích không dùng loại khỏi cả bốn ô crashed/warning/healthy/idle và đếm riêng ở pill → tổng vẫn = số node. Page và canvas cùng dùng `unusedDestinationIds` trên cùng `data`. |
| Tay kéo (a11y) | Đạt mức tối thiểu | `role="separator"`, `aria-orientation`, `aria-label`, `title`, pointer capture, `touch-none`, `onPointerCancel`. Không có bàn phím (yêu cầu ghi là tuỳ chọn). |
| Trang khác | ✅ | Chỉ đổi file trong `components/flow/*` + `dashboard/flow/page.tsx`; `EventLog`/`TopologyCanvas` chỉ dùng ở trang flow. Build + tsc web sạch. `prefers-reduced-motion` đã tắt `flow-spin`/`flow-edge-animated`. |

### Phát hiện B

| ID | Mức | Nội dung | Đề xuất |
|---|---|---|---|
| **M-B1** | Medium | `unusedDestinationIds` chỉ xét subscription bật, `count`, `retrying` — **bỏ qua `dead` (DLQ) và `circuitState`**. Đích đã tắt hết subscription nhưng còn delivery DEAD trong DLQ (việc thật cần replay/dọn) hoặc circuit OPEN bị gắn "KHÔNG DÙNG": mất badge CRASHED/CIRCUIT OPEN, không tính vào `crashed` ở header, và bị ẩn hẳn nếu người dùng tắt "Hiện đích không dùng". Đúng loại tín hiệu mà bản đồ phải làm nổi. | Thêm `dead > 0` (và `circuitState !== 'CLOSED'`) vào điều kiện "đang dùng"; thêm 1 case vào `unused-destinations.spec.ts`. |
| L-B2 | Low | Mỗi sự kiện socket → `setLive` → effect map lại **toàn bộ** nodes/edges với object `data` mới → mọi `TopologyCard`/`TopologyEdge` (memo) render lại. k6 trên LOCAL vài trăm ev/s với console mở = vài trăm lần render toàn bản đồ/giây (chỉ tốn CPU trình duyệt, không ảnh hưởng số đo server). | Gom `setLive` theo `requestAnimationFrame` (hoặc 100 ms), và giữ nguyên object `data` khi `liveView` của node/cạnh không đổi. |
| L-B3 | Low | Tay kéo không focus được bằng bàn phím (không `tabIndex`, không `aria-valuenow/min/max`, không ↑/↓); pill "N đích không dùng" là toggle nhưng thiếu `aria-pressed`. | Tuỳ chọn: `tabIndex=0` + ↑/↓ 5% + `aria-valuenow`; `aria-pressed={!showUnused}`. |

## Câu hỏi quyết định: fixture hub-sim cho probe vs gate VF3 §14.3

Gate `fixture-account` (`/(?<![\d.])\d{9,14}(?![\d.])/` trên `tools/hub-sim/fixtures/`) bắt `TF230204212323` (12 chữ số sau `TF`). Cơ chế ngoại lệ hiện có đã hỗ trợ **file + regex `match` theo dòng** (`verify/lib/gates.ts`, `gate.exceptions.find(e => e.file === file && (!e.match || new RegExp(e.match).test(hit.text)))`).

**Khuyến nghị: thêm ngoại lệ hẹp, không nới luật** — nhưng **không chặn push**:

- Ngoại lệ đúng một file (vd `tools/hub-sim/fixtures/payos-confirm-probe.json`) + `match: '"reference":\\s*"TF230204212323"'`, `reason`: "Hằng số công khai trong tài liệu PayOS (bộ mẫu confirm-webhook), không phải số tài khoản thật; nhận diện probe đòi đúng nguyên văn — ADR-159". Fixture viết JSON nhiều dòng để dòng đó không chứa dãy số nào khác; `accountNumber "12345678"` (8 chữ số) vốn không chạm gate.
- Lý do nên làm: unit test của consumer dùng Prisma giả, L1 chỉ phủ `pollEvents`. Chỉ L2 (hub-sim → hubv, image thật) chứng minh trọn chuỗi ingest → worker → cột `probe` → 0 delivery → polling rỗng — và đây là chỗ ăn điểm "hiểu bản chất webhook" khi bảo vệ (request kiểm tra của provider). Luật vẫn bắt mọi dãy 9–14 chữ số khác trong mọi fixture.
- Nếu không làm: giữ unit + L1 vẫn đủ cho push; ghi `KN:U16` phần L2 là mồ côi có lý do.

## Không làm trong review này

Không sửa source, không commit, không worktree/junction/symlink, không git phá huỷ, không restart container, không chạm production/Neon. Bỏ qua thay đổi đồng thời của agent khác ở `apps/shop` và trang cài đặt shop của `apps/web`.
