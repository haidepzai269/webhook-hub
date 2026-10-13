# REVIEW PK1 (+ sửa review PK0): generic lên console, Lắng nghe, Svix, "request đầu tiên ✓"

- **Dải commit:** `10afed4..bd19625` trên `feat/pk` (worktree `C:\wt\pk`): `5c32c2c`, `904e021` (sửa review PK0), `bd19625` (PK1)
- **Người review:** Murat 🧪 + Grumbal ⚠️ + Sally 🎨 (console). Độc lập, chỉ đọc code, chạy jest có chọn lọc và đột biến tạm (đã trả lại bằng `git checkout --`)
- **Ngày:** 2026-10-14
- **Nguồn đối chiếu:** `SPEC-provider-khac.md` (ĐÍNH CHÍNH, E30, §3, §10, §16, §17), `REVIEW-PK0.md` (TB-1, TB-2, T-1), `CLAUDE.md`

## Kết luận: **ĐẠT** (0 Nặng · 1 Trung bình · 8 Thấp)

TB-1, TB-2 và T-1 của PK0 đã đóng thật: cả ba đột biến cũ giờ làm test đỏ. Phần Svix đúng: không thể ghép hai bộ header để verify qua, so sánh vẫn bằng `timingSafeEqual`, khoá chống trùng của nguồn standard-webhooks hiện có không đổi. Inspect của console dùng chung một hàm, scope theo tenant, không lộ giá trị. Không đụng đường nóng nên ngân sách Redis giữ nguyên.

Mục Trung bình duy nhất nằm ở **Playground**. Giờ nguồn generic tạo được từ console, nhưng Playground với nguồn này nạp body `undefined` và hiện nhãn "Khoá bí mật để ký" trong khi thực tế không ký gì. Kết quả là luôn 401, nằm ngay cạnh hành trình "request đầu tiên ✓". Sửa mất vài dòng, nên làm trước khi merge hoặc ngay đầu PK2.

Quy trình: `[ ] PK1` ở §17 vẫn để trống, đúng luật (PK0 từng bị đánh dấu sớm, lần này không).

---

## Kết quả chạy

| Lệnh | Kết quả |
|---|---|
| `jest --maxWorkers=2`: crypto `standard-webhooks`, providers `generic.adapter`, `apps/hub-api/test/ingest-*` (12 file), `service-sources`, `console-source-inspect`, `body-limit`, `redis-budget`, web `listen-logic`, i18n `dictionary` | **18 suite PASS, 1 skip** (`ingest-ratelimit-after-verify-db` cần docker) · **132 pass, 1 skip** |
| `tsc -p apps/hub-api/tsconfig.json --noEmit` | sạch (exit 0) |
| `apps/web`: `tsc --noEmit -p tsconfig.json` | sạch (exit 0) |
| `npm run verify:map` | 439 mã · 0 mồ côi · 0 ma · 0 trùng. `PK:T3` → `standard-webhooks.spec.ts:36,48` + `generic.adapter.spec.ts:69,207`. `PK:T4` → `console-source-inspect.spec.ts:11`. `PK:T5` → `listen-logic.spec.ts:9`. `PK:T33` (phần a/b) không còn trùng |

> `verify:map` ghi đè `docs/TEST-MAP.md`, reviewer đã `git checkout -- docs/TEST-MAP.md`. Mọi đột biến đã trả lại; `git status` cuối chỉ còn `M libs/hub-sdk/bin/hub.js`, file này đã ở trạng thái đó từ trước review và reviewer không đụng vào.

### Đột biến đã thử (sửa tạm, chạy test, rồi `git checkout --`)

| Đột biến | Test | Kết quả |
|---|---|---|
| Dời `if (source.provider !== req.provider)` xuống **sau** `trace.tenantId/sourceId` (`ingest.service.ts:376-381`) | `ingest-segment.spec.ts` | **đỏ** 1/2 → TB-1 PK0 đã đóng |
| Trả controller về `req.rawBody \|\| Buffer.from(JSON.stringify(req.body \|\| {}))` | `ingest-controller.spec.ts` | **đỏ** → TB-2 PK0 đã đóng |
| Trả `query` về cách tách bằng `indexOf('?')` | `ingest-controller.spec.ts` | **đỏ** → T-1 PK0 đã đóng |
| `swVerify` đọc từng header kiểu `webhook-x ?? svix-x` (trộn bộ) | `standard-webhooks.spec` + `generic.adapter.spec` | **đỏ** 2 test |
| `idempotencyHeader` luôn trả `h` (không ánh xạ sang `svix-id`) | `generic.adapter.spec` | **đỏ** 2 test |

---

## 1. Ba mục của review PK0

- **TB-1 (đóng).** `ingest-segment.spec.ts:69-94` spy `recordTraffic` và `recordMetrics`, rồi khẳng định trên chính đối số `trace` (index 1 ở cả hai hàm, `ingest.service.ts:307,466`) rằng `tenantId`, `sourceId`, `outcome` đều `undefined`. Đột biến dời dòng làm test đỏ.
- **TB-2 (đóng).** `ingest-controller.spec.ts` (L0) gọi `handleWebhook` với `req` không có `rawBody` và `body` lần lượt là `undefined`, `{}`, `{a:1}`, rồi khẳng định `rawBody.length === 0`. Cách này làm đúng một trong hai lựa chọn mà review PK0 đề xuất. Đường HTTP thô (không có `Content-Length` lẫn `Transfer-Encoding`) chưa được test, nhưng chấp nhận được.
- **T-1 (đóng).** `hooksQueryOf` (`hooks-path.ts:34-42`) dùng đúng bản `parseurl` mà router dùng. Test có các ca `#frag`, `?a=1#b` và absolute-form.
- `904e021`: đã tách nhãn `[PK:T33] (phần a)` / `(phần b)`, và `verify:map` báo 0 trùng.

## 2. Svix

- **Chọn bộ header (`standard-webhooks.ts:48-53`).** Chỉ cần có **bất kỳ** header `webhook-*` nào là dùng bộ chuẩn. Cả ba header id/timestamp/signature luôn đọc từ cùng một bộ.
  - Kịch bản trong đề bài, `webhook-id` cộng đủ ba `svix-*`: bộ chuẩn được chọn, thiếu `webhook-timestamp` và `webhook-signature`, nên kết quả là `false`. Không lách được.
  - Chiều ngược lại, đủ bộ `webhook-*` cộng một `svix-id` lạ: verify theo bộ chuẩn, khoá chống trùng lấy `webhook-id`, tức giá trị đã được ký. `svix-id` chèn thêm bị bỏ qua.
  - Kẻ tấn công không thể tự chọn bộ để ghép id hoặc timestamp chưa ký vào chữ ký hợp lệ: chữ ký phủ `id.ts.body` của chính bộ đó.
- **So sánh.** Phần so khớp không đổi: `timingSafeEqual`, khớp một chữ ký là đủ, không dừng sớm (`standard-webhooks.ts:74-79`). Đạt E30.
- **Hồi quy dedupe: không có.** `idempotencyHeader` (`generic.adapter.ts:193-200`) chỉ đổi khi scheme là standard-webhooks, header khoá là `webhook-id` **và** request mang bộ `svix-*`.
  - Request `webhook-*` của nguồn hiện có vẫn ra `generic:<webhook-id>` như cũ.
  - Request `svix-*` trước PK1 luôn 401, nên chưa có khoá cũ nào để xung đột.
  - Replay một request chuẩn sau khi đổi tên header sang `svix-*` vẫn trùng khoá (`generic:<id>`) và bị dedupe. Đây là lựa chọn đúng.
- **Phạm vi ảnh hưởng.** `swVerify` chỉ được dùng ở `GenericAdapter`. SDK (`libs/hub-sdk/src/webhook.ts`) và Shop có bản riêng, chỉ đọc `webhook-*`, nên phía nhận push của hub **không** bị nới thêm cửa `svix-*`. Docstring đầu `standard-webhooks.ts:4-5` vẫn ghi file này dùng chung cho "SDK và Shop", điều này không còn đúng (xem T-8).
- **Chẩn đoán không lộ giá trị.** `diagnose` chỉ trả tên header (`set.id/timestamp/signature`) và `candidateHeaders` (tên). Với ca trộn bộ, chẩn đoán báo `missing_header webhook-timestamp`, kèm gợi ý `svix-signature` trong danh sách ứng viên. Đủ dùng, dù không nói thẳng là "trộn bộ".

## 3. Inspect của console

- **Hàm dùng chung thật.** `source-inspect.ts` được cả `api.controller.ts:204-208` lẫn `service-resources.controller.ts:419` gọi. Code cũ đã xoá hẳn, không chép. Test `[PK:T4]` spy đúng export của module, và kết quả từ console bằng kết quả từ service API.
- **RLS và BB-5.** `this.prisma.forTenant(tenantId)`, với `tenantId` lấy qua `SessionGuard` + `ProjectScopeGuard`. `findSourceById` đã được scope theo tenant. Nguồn thuộc project khác cho kết quả `null`, tức 404 với cùng body `{error:'not_found'}` như service API. Test chỉ dùng mock trả `null`; RLS thật nằm ở tầng repo và đã có từ trước.
- **Scope `read:project`: đồng ý.** Viewer vốn đã thấy `verificationConfig`, gồm tên header và tên trường, qua `GET /api/v1/sources` (`api.controller.ts:142-153`). Inspect chỉ thêm `status`, thời điểm, lý do trượt và **tên** header ứng viên, không có giá trị header hay body. Test khẳng định bằng regex `SIGVAL|TOKVAL|BODYVAL|bodyRaw|headers` và đọc metadata scope.
- **Ngân sách Redis không đổi.** Inspect không dùng Redis, đường ingest không thêm lệnh nào, và `redis-budget.spec.ts` PASS.

## 4. Console web (Sally)

- **Payload đúng API.** Chỉ `generic` gửi `verificationConfig` (`page.tsx:279-280`). Provider khác giữ nguyên body cũ. `buildGenericConfig` khớp luật `validateGenericConfig`:
  - standard-webhooks không có `header`/`encoding`; bỏ trống khoá thì server mặc định `webhook-id`;
  - `encoding` chỉ đi với hmac;
  - tên header được đổi sang chữ thường.
- **Validate phía client.** `superRefine` (`page.tsx:119-133`) dùng lại `HEADER_RE`, `FIELD_RE`, `EVENT_TYPE_RE` y như server, và bỏ qua hoàn toàn khi provider không phải generic. Còn thiếu: chặn kiểu chuẩn (T-2) và giới hạn `eventType` ≤128 ký tự (server vẫn bắt).
- **Poll 2s không rò.** `ListenBlock` chỉ mount khi `source` khác null. Đóng sheet thì observer của `useQuery` bị huỷ và `refetchInterval` dừng theo. `refetchIntervalInBackground: false`.
- **i18n.** vi/en đủ khoá, `dictionary.spec` PASS. Nhãn vi là "Nhà cung cấp khác".
- **Secret.** Không có `console.log` nào. Toast lỗi chỉ hiện `message` của server. Secret chỉ nằm trong body `POST`, như các provider khác.
- **Logic "✓".** Có một ACCEPTED trong 10 dòng gần nhất thì là ✓; dòng mới nhất bị REJECTED thì hiện thêm "Request mới nhất trượt". Chấp nhận được, và đúng §3.3: ACCEPTED nghĩa là request thật đã vào. Ngoài ra, `RawStatus` chỉ có ACCEPTED/REJECTED, nên nhánh "chỉ DUPLICATE thì chờ" là code chết vô hại. Rủi ro "✓ nhưng dữ liệu rỗng" xem T-7.

---

## Trung bình

### TB-1. Playground với nguồn generic: body mẫu `undefined`, nhãn "Khoá bí mật để ký" nhưng không ký, nên luôn 401

- **Chỗ:**
  - `apps/web/src/app/(admin)/dashboard/playground/page.tsx:47-48` (`SECRET_LABEL.generic = "page.playground.secret.sign"`), `:87` và `:201` (`setBody(JSON.stringify(samplePayload(source.provider), null, 2))`);
  - `playground/_components/build-request.ts:19-87` (`samplePayload` không có nhánh `generic`, trả `undefined`) và `:90-140` (`buildRequest` không có nhánh `generic`, gửi đi không chữ ký).
- **Kịch bản:**
  1. Dev tạo "Nhà cung cấp khác" ở trang Nguồn, rồi mở Playground (danh sách nguồn chọn sẵn nguồn đầu tiên).
  2. `JSON.stringify(undefined)` cho ra `undefined`, nên `setBody(undefined)`: textarea chuyển từ controlled sang uncontrolled (React cảnh báo), và `fetch` gửi đi không có body.
  3. Dev nhập "Khoá bí mật để ký", bấm Gửi, nhận 401. Sheet Lắng nghe báo "Trượt: thiếu tiêu đề x-…".

  Dev sẽ kết luận cấu hình của mình sai, trong khi thực ra Playground không ký. Đúng kiểu hiểu nhầm F2/F3 mà PK1 muốn xoá. Lỗi runtime đã có từ trước, vì nguồn generic tạo qua service API cũng hiện ở Playground. Nhưng PK1 đưa generic vào luồng chính, và commit chủ động gán nhãn "ký".
- **Đề xuất (vài dòng):** thêm `case "generic"` vào `samplePayload` (ví dụ `{}` hoặc mẫu nhỏ). Đổi nhãn sang một khoá mới kiểu "Playground chưa ký cho Nhà cung cấp khác. Dùng `hub trigger` hoặc gửi thử từ nhà cung cấp", và ẩn ô secret. Cách khác: lọc nguồn generic khỏi Playground tới PK7.

---

## Thấp

### T-1. Gợi ý `svix-id` trong ô khoá chống trùng dễ dẫn sai

- **Chỗ:** `generic-fields.tsx:107` (`placeholder={sw ? "svix-id" : "transId"}`), `page.tsx:273` (`idKind: "field"` mặc định).
- **Kịch bản:**
  - Với standard-webhooks, ô mặc định là "Trường cấp một của body". Dev chép placeholder `svix-id` vào thì `FIELD_RE` từ chối (`-`), và lỗi chỉ ghi "Nhập tên tiêu đề hoặc trường…".
  - Nếu dev chuyển sang "Tiêu đề" rồi gõ `svix-id`, config lưu `{header:'svix-id'}`. Header khai tay **không** được ánh xạ theo bộ (`generic.adapter.ts:199` chỉ ánh xạ `webhook-id`). Nguồn này sau đó nhận request `webhook-*` (Standard Webhooks thật) sẽ bị 422 `missing_idempotency_key`.
  - Ngoài ra `svix-id` lúc đó **không** nằm trong phần được ký nếu request mang bộ `webhook-*`. Kẻ replay có thể chèn `svix-id` ngẫu nhiên để né dedupe trong cửa sổ 5 phút. Kịch bản này cần cấu hình lệch, nên không nặng.
- **Đề xuất:**
  - Khi chọn standard-webhooks: placeholder để trống kèm câu "bỏ trống = webhook-id / svix-id", và đặt `idKind = "header"`.
  - Hoặc coi cả `svix-id` lẫn `webhook-id` khai tay là "id của bộ đang dùng", để khoá luôn là giá trị đã ký.

### T-2. Kiểu chuẩn (`payment.*`, `repo.*`) dẫn tới ngõ cụt

- **Chỗ:** `page.tsx:130` (client chỉ kiểm `EVENT_TYPE_RE`), `generic-config.ts:96` (server: "là kiểu chuẩn: bắt buộc có mapping").
- **Kịch bản:** dev ngân hàng gõ `payment.received`, rất tự nhiên. Server trả 422, toast báo cần mapping, nhưng form không có ô mapping nào.
- **Đề xuất:** chặn ở client bằng `isReservedType`, với câu giải thích "kiểu chuẩn cần ánh xạ trường, có ở PK7 hoặc qua API; tạm dùng tên riêng, vd `bank.transaction.received`".

### T-3. Tạo nguồn generic xong không tự mở sheet Lắng nghe

- **Chỗ:** `page.tsx:281-290`.
- **Kịch bản:** thước đo của Admin là "request đầu tiên ✓", nhưng sau "Tạo nguồn" dev chỉ thấy một toast. Muốn thấy trạng thái, dev phải tự tìm biểu tượng tai nghe trên dòng nguồn. §10 giao việc này cho PK7, nhưng ở PK1 chỉ cần một dòng.
- **Đề xuất:** `if (src.provider === "generic") setListenId(src.id)` trong `onSuccess`.

### T-4. Mỗi lần poll inspect đọc cả `body_raw` của 10 dòng

- **Chỗ:** `tenant-scoped.repository.ts:945-950` (`findMany` lấy hết cột), `source-inspect.ts:166`.
- **Kịch bản:** sheet mở 5 phút là 150 lượt, mỗi lượt kéo tối đa 10 × 1MB `body_raw` từ Neon. Body thật thường vài KB nên ổn, nhưng trường hợp xấu nhất tốn quota truyền dữ liệu của môi trường deployed. Chuyện này đã có từ S9, nhưng giờ console gọi đều đặn.
- **Đề xuất:** `select` bỏ `bodyRaw`, chỉ nạp cho dòng ACCEPTED khi nguồn có `mapping` (`diagnoseMapping` cần nó). Hoặc UI gửi `since`.

### T-5. Sheet Lắng nghe khi gặp lỗi

- **Chỗ:** `listen-sheet.tsx:61-63`.
- **Kịch bản:**
  - Một lượt poll lỗi tạm thời (mạng) làm cả bảng và dòng trạng thái bị thay bằng dòng đỏ, dù `data` cũ vẫn còn.
  - Nguồn bị lưu trữ ở tab khác thì nhận 404, nhưng `refetchInterval` vẫn gọi mỗi 2s.
- **Đề xuất:** hiện lỗi dạng banner và giữ `data`. Với 404 thì tắt `refetchInterval` (`refetchInterval: (q) => q.state.error ? false : 2000`).

### T-6. Khe hở nhỏ trong test

- `[PK:T3]` phần b chưa có đúng ca "`webhook-id` + đủ **ba** `svix-*`". Logic là cùng một nhánh, và đột biến đọc từng header đã đỏ. Nên thêm một dòng để khoá ý đồ.
- `listen-logic.spec.ts` kiểm `buildGenericConfig` bằng object viết tay, không cho qua `validateGenericConfig`. Một vòng round-trip (nếu jest web import được `@hub/providers`) sẽ bắt lệch khuôn khi PK2 mở rộng config.
- `[PK:T4]`: 404 cho "project khác" mới chỉ dùng mock `null`. RLS thật cần docker, chấp nhận được.

### T-7. "✓" có thể đi kèm dữ liệu rỗng (T-5/T-6 cũ của PK0)

- **Kịch bản:** nguồn generic không có mapping nhận `text/plain`, XML hoặc `application/cloudevents+json`. Request vẫn ACCEPTED và sheet hiện ✓, nhưng `raw_events.body = {}` nên sự kiện ra có `data.raw = {}`. Dev tưởng đã nối xong.
- **Đánh giá:** đồng ý dời sang PK5 (E29) như §16 ghi. Tuy vậy, khi console đã mở generic thì rủi ro này lộ ra với người dùng. Nên ghi ở ADR-202 hoặc §16 rằng ✓ chưa bảo đảm nội dung với body không phải JSON tới khi xong PK5, và PK5 không được trượt.

### T-8. Văn bản

- Comment code vẫn gọi "Provider khác": `generic-fields.tsx:19`, `page.tsx:77,97,105`, `queries.ts`, `playground/page.tsx:47`. Spec §3 và §10 cũng vậy. Việc đồng bộ để cho PK8 docs-sync.
- `standard-webhooks.ts:4-5`: docstring ghi "dùng chung cho … SDK (S11) và Shop", nhưng SDK và Shop có bản riêng. Nên sửa để không ai tưởng phía nhận cũng đã nhận `svix-*`.
- `page.tsx:408`: ép kiểu `form.control as unknown as Control<GenericFormValues>`. Chạy được, nhưng làm mất kiểm tra kiểu giữa hai schema. Có thể tách sub-form hoặc dùng `useFormContext`.
- ADR-202 đủ ba phần vấn đề / chọn / đánh đổi, khớp code (thứ tự chọn bộ, ánh xạ `svix-id`, scope, ✓ tính ở client). Đạt.

---

## 7. Các lệch dev ghi ở §16

| Lệch | Ý kiến | Lý do |
|---|---|---|
| Sheet thay cho tab (chưa có trang chi tiết nguồn) | **Đồng ý** | Cùng kiểu với sheet Lưu lượng (EG5). Mở được bằng code, nên PK7 vẫn "chuyển sang Lắng nghe sau khi tạo" được (xem T-3). Dựng trang chi tiết chỉ để có tab thì vượt phạm vi PK1. |
| Nhãn "Nhà cung cấp khác" thay "Provider khác" | **Đồng ý** | `dictionary.spec.ts` cấm từ tiếng Anh trong bản vi; bản en là "Other provider". Chỉ cần đồng bộ comment và spec (T-8). |
| Inspect của console dùng `read:project` (rộng hơn `manage:sources`) | **Đồng ý** | Viewer vốn đã thấy `verificationConfig` qua GET sources. Inspect chỉ thêm tên header, lý do và trạng thái, không có giá trị. Đã ghi ở ADR-202. Mô hình scope của API key service khác mô hình role của console, nên lệch giữa hai bên là hợp lý. |
| Khoá mặc định `webhook-id` thành "id của bộ đang dùng" (`svix-id`) | **Đồng ý** | Khoá luôn là giá trị đã ký, replay đổi tên header vẫn bị dedupe, và không đổi khoá của nguồn cũ. Nên mở rộng cho `svix-id` khai tay (T-1). |
| Playground thêm nhãn cho `generic` để tsc qua | **Không đồng ý với cách làm** | Nhãn "ký" sai sự thật (TB-1). Nên dùng nhãn hoặc nhánh riêng. |
| T-5/T-6 của PK0 dời sang PK5 | **Đồng ý có điều kiện** | Đúng E29. Nhưng cần ghi rủi ro "✓ mà rỗng" (T-7) để PK5 không trượt. |
