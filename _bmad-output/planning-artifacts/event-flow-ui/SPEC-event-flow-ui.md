# SPEC — Giao diện Event Flow: nhìn vào là biết event đi từ đâu, qua bước nào, đang ở đâu, hỏng ở đâu

> **Đường dẫn:** `C:\webhook-hub\_bmad-output\planning-artifacts\event-flow-ui\SPEC-event-flow-ui.md`
> **Ngày:** 2026-10-10 tối muộn, party mode (Sally chủ trì, Winston, Amelia, John, Mary cùng Admin).
> **Trạng thái:** sẵn sàng để dev. Một **agent riêng** làm, trong **git worktree** nhánh `feat/event-flow-ui`, **song song** với agent đa service. Merge sau khi đa service xong review (§9).
> **Ai đọc:** phiên DEV đọc §0 → §10; phiên REVIEW đọc §1, §3, §4, §8, §9.

---

## 🎯 0A. ẢNH MẪU ADMIN ĐƯA: thước đo "đẹp như vậy" (10/10 16:35, **thắng mọi mô tả hình thức bên dưới**)

> Admin: "giao diện nó cần UI đẹp như n8n theo kiểu workflow này: luồng này đang chạy, crash hay không crash, hiểu không?"

Hai ảnh mẫu nằm trong `reference/`. **Mở ra xem trước khi code**, và so ảnh chụp của mình với hai ảnh này sau mỗi màn.

### A. `reference/ref-service-map.png` → **V3 Bản đồ luồng** (màn đầu tiên khi mở dashboard)

- **Nền tối** dạng canvas có lưới chấm mờ. Tiêu đề "Bản đồ luồng" ở góc trái trên. Góc phải trên có các bộ lọc dạng nút: `1H ▾` (cửa sổ thời gian), `Tất cả source ▾`, `Tuỳ chọn ▾` (bật/tắt chấm chạy, gộp subscription).
- **Node** là thẻ bo góc, nền kính mờ, **viền phát sáng theo trạng thái sức khoẻ**:
  - **Healthy** — viền và glow xanh lá;
  - **Warning** — vàng (tỉ lệ lỗi > 2%, có RETRYING, circuit HALF_OPEN, throttle đang chặn);
  - **Crashed/Down** — đỏ (circuit OPEN, tỉ lệ lỗi > 20%, DLQ tăng trong cửa sổ, source bị chặn hàng loạt);
  - **Idle** — xám (không có event trong cửa sổ).
  - Nội dung thẻ: icon trong ô vuông (logo provider hoặc loại đích), tên, dòng trạng thái `● Healthy`; hàng dưới có `● 99.1%` (tỉ lệ thành công) và `105ms lat` (p95).
- **Cạnh** cong mềm, có mũi tên, cùng màu với trạng thái của nhánh. Khi có traffic thì **nét đứt chuyển động** chạy dọc cạnh. Giữa cạnh có **nhãn** dạng `5k req/s · 15ms lat` (trong hub: `120 ev/15m · 12ms`).
- Bố cục trái → phải: Sources → Cổng xác thực → Normalize/Queue → Subscriptions → Destinations (Shop, Discord, Telegram…).
- Node hỏng phải **nổi bật từ xa**: đỏ, glow mạnh hơn, badge `CRASHED` hoặc `CIRCUIT OPEN · 00:42`.

### B. `reference/ref-event-detail.png` → **V1 Chi tiết một event**

Bố cục trên xuống, nền tối, card bo góc:

1. Dòng trên cùng: `← Quay lại Events` · tiêu đề **Event Detail** + id event (mono, có nút copy) · bên phải nút **Replay ▾** (màu cam; menu: replay tất cả đích / chọn đích) và nút phụ **"Tạo từ event này"** (mở playground điền sẵn payload).
2. Hàng 3 thẻ thông tin: **Event Type** (dạng pill, ví dụ `payment.received`), **Source** (provider + IP), **Received** (thời gian đầy đủ).
3. **Dải hành trình** (phần riêng của hub, ảnh mẫu không có, đặt ngay dưới hàng thẻ): 5–6 node nhỏ nối nhau theo phong cách của ảnh A: `Nhận → Xác thực → COMMIT → Normalize → Định tuyến → toả nhánh theo đích`. Mỗi node có màu, icon và `+ms`. Node hỏng đỏ, kèm lý do.
4. Hai card cạnh nhau:
   - **Payload**: JSON viewer có tô màu cú pháp, gập/mở từng khối (`{ 8 props }`), số dòng, nút **Copy**. Có tab "Gốc (raw)" và "Chuẩn hoá (data)".
   - **Headers**: danh sách khoá–giá trị dạng bảng, nút **Copy**. Header nhạy cảm hiện `***` (ADR-051).
5. Card **Delivery Attempts** (đếm tổng ở góc phải), mỗi đích một nhóm. Mỗi attempt một dòng: icon ✓/✗, `Attempt #1`, pill trạng thái (`success` xanh / `failed` đỏ / `retrying` vàng), pill `HTTP 204`, thời lượng `220ms`, giờ. Bên phải có `Response ▾` và `Payload ▾` để mở ra xem body phản hồi (đã cắt) và body đã gửi. Attempt đang chờ thì có đếm ngược `thử lại sau 04:12 (tầng 5m)`.

### C. Thêm: **Nhật ký sự kiện trực tiếp** (Admin: "có thêm cả log event")

- Trên V3: một **ngăn dưới có thể thu gọn** (kiểu console), hoặc cột phải. Các dòng log chảy realtime, ví dụ:
  `16:32:04.120  payos  ✓ verified · COMMIT 8ms · payment.received · → Shop 200 (84ms) · → Discord ✗ 500 (retry 10s)`.
- Mỗi dòng có màu theo kết quả, bấm vào → V1. Có ô lọc và nút Tạm dừng. Đây cũng là V2 rút gọn. V2 đầy đủ vẫn là trang danh sách.

### D. Hệ thống hình ảnh

- Dark là mặc định của các màn Flow, vẫn hỗ trợ light. Font chữ của template. Số dùng `tabular-nums`. Id và hash dùng font mono.
- Bảng màu trạng thái dùng một bộ token chung cho canvas, pill, log, cạnh: healthy / warning / crashed / idle / in-progress.
- Hiệu ứng: glow bằng `box-shadow`/`filter: drop-shadow`; cạnh chuyển động bằng `stroke-dasharray` + animation (React Flow `animated` hoặc custom edge). Tôn trọng `prefers-reduced-motion`.
- **Hai ảnh mẫu là thước đo nghiệm thu:** ảnh chụp V1 và V3 của agent đặt cạnh ảnh mẫu phải cho cảm giác cùng đẳng cấp. Review sẽ so trực tiếp.

- **Icon (Admin dặn 10/10): chỉ dùng Lucide** (`lucide-react`, có sẵn). Không dùng icon mặc định của React Flow, emoji, hay ký tự ✓/✗ làm icon. Logo provider không có trong Lucide thì dùng SVG inline cùng kích thước và nét. Toàn màn dùng một cỡ và một độ dày nét thống nhất.

### E. Ngưỡng sức khoẻ: một nguồn sự thật

Viết trong `libs/common/src/flow/health.ts`: `healthOf({successRate, p95, circuit, retrying, dlqDelta, events}) → 'healthy'|'warning'|'crashed'|'idle'`, có unit test. Server trả `health` cho mỗi node và cạnh. UI **không** tự tính.

---

## 0. Đọc trước

1. `CLAUDE.md`: BB-1..BB-5. Đặc biệt **BB-5**: mọi truy vấn mới đi qua `TenantScopedRepository`.
2. `docs/ARCHITECTURE.md`: luồng ingest §3.1, luồng 2 chặng, retry có tầng, DLQ, circuit. Đây là **những bước mà UI phải vẽ ra**. Đọc kỹ mục "Khác gì Zapier/n8n?" (khoảng dòng 756).
3. `_bmad-output/planning-artifacts/ui-revamp/SPEC-A-admin.md`: khung dashboard hiện có (sidebar, template, `lib/hub/*`).
4. `_bmad-output/planning-artifacts/verification/SPEC-verification.md` §3 và §6: luật test và commit. Mã test của spec này là `[UI:Fx]`.
5. `docs/adr/README.md`: ADR-047 (trace), ADR-048 và ADR-054 (circuit), ADR-049 (realtime), ADR-050 (audit, replay), ADR-051 (che header).

## 1. Vì sao (Admin chốt 10/10)

> Admin: "giao diện có thể hiển thị rõ hết tất cả các luồng … theo hướng Visual Workflow / Event Flow Dashboard. Không chỉ hiển thị danh sách webhook, mà phải nhìn vào là hiểu ngay một event đi từ đâu, qua những bước nào, đang ở trạng thái gì và thất bại ở đâu. Hãy học hỏi của n8n."

**Học gì của n8n và không học gì** (Winston và John chốt):

| n8n | Hub | Học hay không |
|---|---|---|
| Canvas: node nối bằng cạnh, nhìn là thấy dữ liệu chảy qua đâu | **Bản đồ luồng** của project: Source → Cổng xác thực → Normalize → Subscription (bộ lọc) → Destination | **Học** |
| Execution: mở một lần chạy, mỗi node có dấu ✓ hoặc ✗, bấm vào node thì xem input/output | **Hành trình một event**: từng chặng có trạng thái, thời gian, dữ liệu vào/ra, lý do lỗi | **Học**. Đây là màn quan trọng nhất |
| Danh sách executions có trạng thái | **Danh sách hành trình**: mỗi dòng có một "đường ống mini" chỉ chỗ hỏng | **Học** |
| Retry từ node lỗi | Replay delivery / renormalize raw event ngay trên node lỗi | **Học**, dùng API sẵn có |
| Số item đi qua mỗi cạnh | Số event và tỉ lệ lỗi trên cạnh, cập nhật realtime | **Học** |
| **Trình dựng workflow kéo thả** (logic tuỳ ý, code node) | — | **Không học.** ARCHITECTURE nói rõ: đề tài khác n8n ở chỗ tập trung **độ tin cậy của tầng webhook**. Cấu hình vẫn qua form. Chỉ có tuỳ chọn F6: kéo cạnh Source→Destination để **mở form** tạo subscription |

**Câu Admin phải nói được trước hội đồng khi chỉ vào màn hình:**
*"Event này từ PayOS vào, chữ ký hợp lệ, đã COMMIT lúc 10:02:37.120, normalize ra `payment.received`, khớp 2 subscription. Shop nhận 200 sau 84ms. Discord lỗi 500 ba lần, đang chờ thử lại tầng 5 phút, lúc 10:08. Bấm Replay ở đây."*

Màn hình nào không cho nói được câu này là chưa đạt.

## 2. Từ vựng chặng: một nguồn sự thật duy nhất

Viết ở `libs/common/src/flow/stages.ts`, thuần TS. API và web cùng import (web import qua path alias, hoặc copy tự sinh; phiên dev chọn và ghi ADR).

```ts
export type StageKey =
  | 'received'      // request tới /hooks (provider, IP, size, correlationId)
  | 'verified'      // chữ ký: ok | invalid | missing → REJECTED
  | 'persisted'     // raw_events ACCEPTED + outbox trong cùng tx (BB-3); duplicate → dừng ở đây
  | 'normalized'    // adapter → event chuẩn (type, normalized flag) | schema error | DLQ normalize
  | 'routed'        // subscriptions khớp / bị bỏ qua kèm lý do
  | 'delivering'    // MỘT nhánh cho mỗi delivery: các attempt, tầng retry, circuit, throttle
  | 'done';         // SUCCEEDED | DEAD | RETRYING(next_attempt_at) | DEFERRED(circuit)

export type StageStatus = 'ok' | 'failed' | 'skipped' | 'pending' | 'in_progress' | 'warning';

export interface StageView {
  key: StageKey;
  status: StageStatus;
  startedAt: string | null;   // ISO
  endedAt: string | null;
  durationMs: number | null;
  title: string;              // "Chữ ký PayOS hợp lệ"
  reason?: { code: string; message: string };   // code thuộc REASON_CODES bên dưới
  detail?: Record<string, unknown>;             // dữ liệu panel "vào/ra", ĐÃ che bí mật
  actions?: ('replay_delivery' | 'renormalize' | 'open_dlq' | 'open_config')[];
  branchId?: string;          // deliveryId, với chặng 'delivering' và 'done'
}
```

- `REASON_CODES` là catalog lý do có message tiếng Việt, ví dụ:
  - `signature_invalid`, `duplicate`, `rate_limited`, `schema_mismatch`;
  - `no_subscription`, `subscription_inactive`, `endpoint_unverified`, `source_filtered`;
  - `http_5xx`, `http_4xx`, `timeout`, `circuit_open`, `throttled`, `max_attempts`.
- Mỗi trạng thái trong DB ánh xạ về **đúng một** `StageStatus`. Viết **hàm thuần** `buildEventFlow(rows) → StageView[]`, dữ liệu vào là các dòng DB đã nạp, kèm unit test cho từng ánh xạ. Đây là trái tim của spec: UI chỉ vẽ, không tự suy ra trạng thái.
- Lý do đến từ code đa service (`endpoint_unverified`, `source_filtered`) khai báo sẵn. Trước khi đa service merge, chúng không bao giờ xuất hiện.

## 3. API đọc (module mới, chỉ đọc)

Đặt trong **module mới** `apps/hub-api/src/modules/flow/` (controller + service). **Không sửa** `api.controller.ts`, vì agent đa service đang sửa file đó. Chỉ thêm đúng **một dòng** đăng ký module trong `app.module.ts`. Guard và decorator dùng y hệt `api.controller.ts`: JWT, `@CurrentTenant()`. Đọc qua `TenantScopedRepository`; thêm hàm repo nào thì có test.

| Method | Path | Trả về |
|---|---|---|
| GET | `/api/v1/flow/events/:id` | `{event, stages: StageView[], branches: {deliveryId, destination:{id,name,type}, stages: StageView[]}[]}`. `:id` nhận **event id hoặc raw_event id**: raw_event bị REJECTED hoặc trùng thì không có event, hành trình dừng ở `verified`/`persisted` |
| GET | `/api/v1/flow/executions?status=failed\|in_progress\|succeeded\|rejected&source=&destination=&type=&cursor=&limit=` | danh sách hành trình, mỗi dòng có `summary: {stage: StageKey, status}[]` (đủ để vẽ đường ống mini) và `failedAt?: {stage, reason, destinationName}`. Phân trang bằng cursor, giới hạn 50 |
| GET | `/api/v1/flow/topology?window=15m\|1h\|24h` | `{nodes: FlowNode[], edges: FlowEdge[]}`. Node gồm: source (counter accepted / rejected / duplicate), ingest gate, normalize (lag, lỗi schema, số trong DLQ normalize), subscription (pattern, active), destination (type, circuit state, tỉ lệ thành công, p95, đang RETRYING, DEAD). Edge có `count`, `failed`. Đếm bằng **một vài truy vấn GROUP BY có index**; không N+1 |

- **Rejected:** raw_events REJECTED đọc qua repo (đã che header theo ADR-051). Mẫu rejected trong bộ nhớ (S1-4) **không** dùng, vì không bền.
- **Không chạm Redis** trên các route này, trừ khi đọc circuit state đã có sẵn qua cách mà `destinations` đang làm. Ngân sách R1 chỉ áp cho đường ingest, nhưng đừng thêm vòng lặp gọi Redis cho từng node.
- Không bao giờ trả `bodyRaw` đầy đủ của raw_event ra UI nếu lớn hơn 16KB: cắt bớt và kèm cờ `truncated`. Header đã che. Secret của đích không bao giờ xuất hiện.
- Hiệu năng: `topology` ≤ 300ms và `executions` ≤ 200ms trên 10k event local (đo, ghi số). Nếu thiếu index thì thêm **migration mới**.

## 4. Ba màn hình

### V1. Hành trình một event (màn quan trọng nhất), `/dashboard/events/[id]`

- **Canvas trái → phải**: `Provider → Xác thực → Lưu (COMMIT) → Normalize → Định tuyến`, rồi **toả nhánh**, mỗi delivery một nhánh: `Delivery → Attempt 1 → Attempt 2 … → Kết thúc`.
- **Node:**
  - icon theo chặng, viền màu theo `StageStatus` (ok xanh, failed đỏ, in_progress xanh dương nhấp nháy nhẹ, pending xám, skipped gạch ngang, warning vàng);
  - **thời gian của chặng** ghi ngay trên cạnh nối, ví dụ `+12ms`;
  - node `failed` có nhãn lý do bằng tiếng Việt và nút hành động (Replay, Renormalize, Mở DLQ).
- **Bấm vào node** mở panel phải (kiểu n8n) với ba tab:
  - "Vào": header đã che, body có cắt, đối với chặng `received`/`verified`;
  - "Ra": event chuẩn `data`, đánh dấu `normalized`, đối với chặng `normalized`;
  - "Chi tiết": attempt (HTTP status, `duration_ms`, response đã cắt, tầng retry, `next_attempt_at` với đếm ngược), circuit, throttle.
- **Dải thời gian** (waterfall) dưới canvas: mỗi chặng một thanh. Nhìn là biết chậm ở đâu.
- **Realtime:** đang mở hành trình của event đang chạy thì cập nhật theo socket (`event.received`, `delivery.attempt`). Mỗi lần có thông báo mới thì gọi lại `GET /flow/events/:id`, có debounce. Không tự ghép trạng thái ở client.
- Đường dẫn cũ: sheet "Dấu vết" hiện có (S2) giữ làm bản xem nhanh, kèm nút "Mở hành trình đầy đủ".

### V2. Danh sách hành trình, nâng cấp `/dashboard/events`

- Mỗi dòng có thời gian, provider, type, subject, **đường ống mini**: 6 chấm theo `summary`, chấm hỏng màu đỏ, nhánh delivery gộp thành "2/3 đích ✓".
- Có cột **"Hỏng ở"**, ví dụ `Giao → Discord · http_500 · lần 3/5`.
- Tab lọc nhanh: **Tất cả · Đang chạy · Thất bại · Bị từ chối · Thành công**. Lọc theo source, destination, type (có wildcard). Cuộn vô hạn theo cursor.
- Dòng mới chảy vào realtime, có nút tạm dừng luồng.
- Bấm dòng → V1.

### V3. Bản đồ luồng của project, `/dashboard/flow` (đặt làm mục đầu sidebar "Luồng dữ liệu")

- Canvas cấu hình **đang sống**: các Source bên trái → cổng xác thực → normalize → các Subscription (nhãn pattern, ví dụ `payment.*`) → các Destination bên phải. Bố cục tự động (dagre hoặc elkjs), người dùng kéo node thì vị trí được nhớ trong `localStorage`.
- **Cạnh** dày theo `count`, đỏ dần theo tỉ lệ lỗi. Mỗi event đi qua thì một **chấm sáng chạy dọc cạnh** (socket), tối đa 30 chấm/giây; vượt thì gộp lại.
- **Node Destination** có badge circuit (CLOSED/OPEN/HALF_OPEN kèm đếm ngược), badge throttle, số RETRYING và DEAD (bấm vào → V2 đã lọc).
- **Node Source** có số accepted/rejected/dup trong cửa sổ thời gian; rejected > 0 thì có chấm đỏ (bấm vào → V2 tab "Bị từ chối").
- Bộ chọn cửa sổ thời gian 15 phút / 1 giờ / 24 giờ.
- Bấm node → mở trang cấu hình tương ứng (sources, destinations, subscriptions).

### Màn demo (dùng trong SPEC-verification §9)

Bắn PayOS từ playground → V3 thấy chấm chạy từ PayOS tới Shop và Discord → Discord đỏ (dùng `/mock/fail`) → bấm vào → V1 thấy attempt 1 lỗi 500, đếm ngược tới lần sau → circuit OPEN trên V3 → bấm Replay sau khi sửa → xanh.

## 5. Kỹ thuật

- Canvas: **`@xyflow/react`** (React Flow 12, hỗ trợ React 19). Ghi **phiên bản cụ thể**, không dùng `^`/`latest`. Bố cục: `@dagrejs/dagre` hoặc `elkjs`, cũng ghim phiên bản. Kiểm tương thích với Next 16 và React 19 trước khi chọn; nếu không tương thích thì ghi ADR và chọn phương án khác.
- Gọi API **chỉ qua lớp sẵn có** `apps/web/src/lib/hub/client.ts` và `queries.ts` (TanStack Query). **Không** gọi `fetch` riêng: auth (AU3) sẽ thay lớp này bằng cookie và `projectId`, nên chỉ được có một chỗ để thay.
- Socket: dùng store sẵn có `lib/hub/socket.ts`. Không mở kết nối thứ hai.
- Theme sáng/tối theo template hiện có. Màu trạng thái lấy từ token chung, đủ tương phản. Ngoài màu còn phải có **icon**, để người mù màu đọc được.
- Hiệu năng: V1 ≤ 40 node; V3 ≤ 60 node, nếu nhiều hơn thì gộp các subscription cùng đích. Bảng V2 dùng ảo hoá khi > 200 dòng.
- Không thêm thư viện state mới.

## 6. Tương thích với hai đợt đang và sẽ chạy

| Đợt | Ảnh hưởng | Spec này làm gì trước |
|---|---|---|
| **Đa service** (agent khác, đang chạy trên `master`) | Thêm project, `endpoint.verification` (PENDING/FAILED), `subscriptions.sourceIds`, `events.normalized`/`seq`, header Standard Webhooks; S7 đổi nghĩa `after` của `GET /api/v1/events` | `FlowNode`/`StageView` có sẵn trường **tuỳ chọn** `projectId`, `verification`, `sourceIds`. Lý do `endpoint_unverified`, `source_filtered` khai báo sẵn. V2 dùng `/flow/executions` của module mới, **không** dùng `/api/v1/events`, để khỏi vướng S7 |
| **Auth AU1–AU6** (sau đa service) | Cookie, `?projectId=` bắt buộc, scope theo role, RLS | Mọi gọi API qua `client.ts`. Route `flow` được gắn guard giống các route `/api/v1/*` khác, để AU3 thêm `@RequireScope('read:project')` một lần cho cả module. Nút hành động (Replay…) để AU3 ẩn theo scope `replay:deliveries` |

## 7. Stories (làm theo thứ tự)

| ID | Nội dung | Ước lượng |
|---|---|---|
| **F1** | `libs/common/src/flow/stages.ts` (từ vựng, `REASON_CODES`) + `buildEventFlow` thuần + unit test mọi ánh xạ trạng thái DB → chặng | 3h |
| **F2** | Module `flow`: `GET /flow/events/:id` (event id hoặc raw_event id) + repo + test (kể cả cô lập tenant: event của tenant khác → 404) | 2.5h |
| **F3** | V1 Hành trình một event: canvas, panel 3 tab, waterfall, nút hành động, realtime | 5h |
| **F4** | `GET /flow/executions` + V2 danh sách có đường ống mini, tab lọc, cuộn cursor, realtime | 4h |
| **F5** | `GET /flow/topology` + V3 bản đồ luồng, chấm chạy realtime, badge circuit/throttle, cửa sổ thời gian | 5h |
| **F6** | (tuỳ chọn) Kéo cạnh Source/Subscription → Destination trên V3 để **mở form** tạo subscription điền sẵn. Không tự tạo | 1.5h |

Tổng khoảng 20 giờ (cộng 1,5 giờ nếu làm F6).

## 8. Test và bằng chứng

- **Unit**:
  - `buildEventFlow` cho mọi tổ hợp: REJECTED, duplicate, schema error, không có subscription nào khớp, 1 đích ok + 1 đích lỗi, RETRYING có `next_attempt_at`, DEAD, circuit DEFERRED, replay (generation > 1, nhánh hiện generation mới nhất, lịch sử thì gập lại).
  - Mã test `[UI:F1-…]`.
- **API**: test DB (`RUN_DB_TESTS=1`) cho 3 route, gồm cô lập tenant và che bí mật (không có `signingSecret`/`botToken`/`authorization` thô trong response).
- **Web**: `npx tsc --noEmit` và `next build` cho `apps/web` sạch.
- **Nhìn bằng mắt** (bắt buộc, vì đây là spec giao diện):
  - chạy stack dev hoặc `hubv`, bắn đủ 5 kịch bản: PayOS ok, SePay ok, chữ ký sai, đích `/mock/fail`, trùng;
  - **chụp màn hình** V1 (một ca thành công, một ca hỏng), V2, V3, ở cả sáng lẫn tối, lưu vào `_bmad-output/planning-artifacts/event-flow-ui/screens/`;
  - Playwright headless nếu cài được (ghim phiên bản, chỉ là devDependency của `apps/web`). Không được thì ghi rõ và mô tả cách đã kiểm.
- **Không gửi Telegram/Discord thật**. Đích thử dùng `/mock/*` hoặc sink của `hubv`.
- Commit theo SPEC-verification §6 nếu runner VF2 đã có trên nhánh: khối `Verify:`, mã test.

## 9. Cách làm song song và merge

- Agent làm trong **git worktree** nhánh `feat/event-flow-ui`, tách từ `master` lúc bắt đầu. Cài `npm ci` riêng trong worktree.
- **File được sửa:**
  - `apps/web/**`;
  - `libs/common/src/flow/**`;
  - `apps/hub-api/src/modules/flow/**`;
  - **một dòng** trong `app.module.ts`;
  - migration index mới, nếu cần;
  - test của những file trên.
- **Không sửa:**
  - `api.controller.ts`, `schema.prisma` (trừ index qua migration riêng), seed, compose, `package.json` gốc (trừ thêm dependency của `apps/web`), `docs/adr/README.md` (§ dưới);
  - file planning của các spec khác.
- **ADR:** đừng sửa `docs/adr/README.md` trên nhánh, vì sẽ xung đột với `master`. Ghi ADR nháp vào `_bmad-output/planning-artifacts/event-flow-ui/ADR-DRAFT.md`, rồi lúc merge mới cấp số và chép vào.
- **Docker:**
  - không `down -v` stack dev, không dựng lại `hubv` (agent đa service đang dùng);
  - để xem UI: chạy `next dev` của worktree ở **cổng 3100**, trỏ vào hub-api của stack dev (4000), hoặc của `hubv` (14000) nếu `hubv` đang lên. Chỉ đọc và bắn sự kiện thử.
- **Merge:**
  - **sau** khi đa service xong review: rebase `feat/event-flow-ui` lên `master`, sửa xung đột (chủ yếu ở `apps/web`), chạy lại test + build, rồi fast-forward;
  - việc merge do phiên điều phối làm, **không** phải agent này;
  - agent chỉ commit trên nhánh của mình, **không push, không merge**.

## 10. Kết quả (dev điền)

| Story | Commit | Bằng chứng | Ảnh | Lệch |
|---|---|---|---|---|
| F1 | | | — | |
| F2 | | | — | |
| F3 | | | | |
| F4 | | | | |
| F5 | | | | |
| F6 | | | | |

## 11. Kết quả review (phiên review điền)

| Phát hiện | Mức | Trạng thái |
|---|---|---|
