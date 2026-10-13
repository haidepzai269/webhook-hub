# REVIEW PK0: segment khớp provider, cổng phạt mọi method, bytes gốc mọi content-type, method/query

- **Commit:** `10afed4` (nhánh `feat/pk`, worktree `C:\wt\pk`, so với `master` @ `314ace0`)
- **Người review:** Murat 🧪 + Grumbal ⚠️ (độc lập, chỉ đọc code và chạy jest có chọn lọc)
- **Ngày:** 2026-10-13
- **Nguồn đối chiếu:** `SPEC-provider-khac.md` (ĐÍNH CHÍNH E1, E6, E9; §2; §16; §17), `REVIEW-PK-SPEC-v2.md` (N1, N6, Thấp 9), `CLAUDE.md` (BB-1..5, cạm bẫy #1)

## Kết luận: **ĐẠT** (0 Nặng · 2 Trung bình · 8 Thấp)

Code đúng phạm vi PK0 và đúng thứ tự E9. Không phá BB nào. Không gặp lỗi hành vi nào ở mức Nặng. Hai mục Trung bình đều nằm ở **test**: có hai câu khẳng định mà test ghi là đã kiểm nhưng thực ra không bắt được khi code bị đổi ngược. Nên vá hai mục này trước khi merge. Mỗi mục chỉ cần khoảng 10–20 dòng test, không phải sửa code.

**Ghi nhận quy trình:** dev đánh `[x] PK0` ở §17 ngay trong commit, **trước** khi review. Luật của checklist là "đánh `[x]` khi story đã review ĐẠT và CI xanh". Việc này coordinator xử lý.

---

## Kết quả chạy

| Lệnh | Kết quả |
|---|---|
| `jest --maxWorkers=2`, 16 file: ingest-segment, body-limit, penalty-gate, penalty-box, redis-budget, ingest-generic/invariants/reject-ack/trace/traffic/payos-probe/redact/duplicate-count, metrics, storage-lock, storage-bytes | **16/16 suite, 126/126 test PASS** |
| `jest --maxWorkers=2`: error-filter, archive-flow-items, edge-nginx, auth-scope | **4/4 suite PASS** (59 pass, 3 skip vì cần docker) |
| `tsc -p apps/hub-api/tsconfig.json --noEmit` | sạch (exit 0) |
| `npm run verify:map` | 439 mã · 0 mồ côi · 0 ma · 0 trùng. `PK:T1` → `ingest-segment.spec.ts:13`, `PK:T2` → `penalty-gate.spec.ts:154,287`, `PK:T33` → `body-limit.spec.ts:161` |

> `verify:map` ghi đè `docs/TEST-MAP.md` trong worktree. Reviewer đã `git checkout -- docs/TEST-MAP.md` để trả lại bản đã commit. `libs/hub-sdk/bin/hub.js` đã ở trạng thái `M` (chỉ khác CRLF/mode, mtime 23:12) từ **trước** khi review bắt đầu, reviewer không đụng vào.

---

## Trung bình

### TB-1. `[PK:T1]` không bắt được khi phép so segment bị dời xuống **sau** `trace.tenantId` (E9, Thấp 9)

- **Chỗ:** `apps/hub-api/test/ingest-segment.spec.ts:82-83`, đối chiếu với `ingest.service.ts:187-213` (`traced`) và `recordTraffic`.
- **Kịch bản đột biến:** dời khối `if (source.provider !== req.provider)` xuống dưới `trace.tenantId = …; trace.sourceId = …`. Test vẫn xanh:
  - `notifier.traceIngested` chỉ được gọi khi có `trace.tenantId` **và** `trace.outcome`. Nhánh 404 không đặt `outcome`, nên notifier vẫn không được gọi.
  - `recordTraffic` gặp `outcome` null thì `return`, và nó cũng không bao giờ gọi `prisma.forTenant` một cách đồng bộ (lưu lượng nằm trong bộ nhớ, flush theo chu kỳ).
  - Vì vậy hai assert ghi chú "trước `trace.tenantId`: không mang tenant" và "không lưu lượng của tenant" đều đúng một cách trống rỗng.
- **Vì sao đáng lo:** E9 và Thấp 9 bắt **vị trí** này một cách tường minh. PK4 và PK6 sẽ chèn nhánh 2t/2h ngay quanh chỗ này và đặt `trace.outcome`. Khi đó, nếu vị trí bị sai, 404 lệch segment sẽ vào lưu lượng và trace của tenant, mà test hiện tại không báo đỏ.
- **Đề xuất:** khẳng định trực tiếp trên trace, ví dụ `const spy = jest.spyOn(svc as any, 'recordTraffic')` rồi `expect(spy.mock.calls[0][1].tenantId).toBeUndefined()`. Hoặc spy `recordMetrics` và đọc `trace`. Khi đó đột biến dời dòng sẽ làm test đỏ.

### TB-2. Không test nào bắt được nếu controller quay lại fallback `JSON.stringify` (E1, "bỏ fallback")

- **Chỗ:** `apps/hub-api/src/modules/ingest/ingest.controller.ts:30`, test `body-limit.spec.ts` ("body rỗng (Google Drive)…", khoảng dòng 312-320 của file test).
- **Kịch bản đột biến:** trả dòng 30 về `req.rawBody || Buffer.from(JSON.stringify(req.body || {}))`. Test vẫn xanh:
  - `fetch` (undici) gửi `POST` không body kèm `Content-Length: 0`. `type-is.hasBody` thấy có header nên coi là có body, và body-parser 2.3.0 vẫn đọc rồi gọi `verify` với `Buffer(0)` (`read.js:141-145`).
  - Kết quả là `req.rawBody` là một Buffer rỗng nhưng **truthy**, nên `||` giữ nguyên nó. Nhánh fallback không bao giờ chạy trong test.
  - Thử ngược lại: nếu bỏ parser raw thì các case text/plain/XML/JWT **có** đỏ. Nếu bỏ `tolerateGenericJsonError` thì case JSONL **có** đỏ. Chỉ riêng thay đổi ở controller là chưa được phủ.
- **Vì sao đáng lo:** request **không có** header body (không có `Content-Length`, không có `Transfer-Encoding`) chính là GET bắt tay của PK4. Nếu fallback quay lại thì `rawBody` của GET sẽ thành `"{}"`, đúng lỗi mà N1/E1 muốn xoá.
- **Đề xuất:** thêm một test L0 gọi `IngestController.handle` trực tiếp với `req` không có `rawBody` (và một `req` có `body = { a: 1 }`), rồi assert `rawBody.length === 0`. Cách khác: dùng `http.request` thô, `POST` không có `Content-Length` lẫn `Transfer-Encoding`, rồi assert rằng không có parser nào chạy và `rawBody` rỗng.

---

## Thấp

### T-1. `query` tách bằng `indexOf('?')`, lệch với `parseurl` mà router và gate dùng

- **Chỗ:** `ingest.controller.ts:8-12` (`rawQueryOf`), so với `hooks-path.ts` (`hooksPathOf` dùng `parseurl` chính vì lý do lệch router, xem review EG lượt 6 TB-1).
- **Kịch bản:** request-target `/hooks/generic/k#x?tok=1`. `parseurl` cho pathname `/hooks/generic/k`, query rỗng (`#…` là fragment). `rawQueryOf` lại trả `tok=1`. Với `/hooks/generic/k?a=1#b` thì `rawQueryOf` trả `a=1#b`. Client chuẩn không gửi fragment, nhưng PK2 (token ở query) sẽ đọc trường này.
- **Đề xuất:** `query = (parseurl(req)?.query ?? '') as string`, dùng đúng bản `parseurl` của `hooks-path.ts`. Không đáng chặn PK0, nhưng nên sửa trước PK2.

### T-2. Nhánh lệch segment không phạt và không giới hạn tốc độ ở tầng app

- **Chỗ:** `ingest.service.ts:376-379`.
- **Kịch bản:** kẻ biết một `sourceKey` thật bắn liên tục `/hooks/<provider-khác>/<key>`. Mỗi request tốn một batch DB (2 câu SQL, `findSourceBySourceKeyForIngest`) cộng với việc đọc tới 1MB body. Không có EG2 (cả luật a lẫn b) và không có EG3, vì EG3 nằm sau verify. Trước PK0, cùng kẻ đó dùng đúng segment thì bị luật (b) phạt theo cặp.
- **Giảm nhẹ:** cầu chì nginx `limit_req zone=hooks_ip` (`nginx.conf.template:110`) vẫn áp dụng. Nguồn đã tắt hoặc đã lưu trữ cũng có cùng lối không phạt (đã có từ trước, ADR-161). Spec §2 chốt "không cộng điểm phạt EG2", và ADR-201 đã ghi phần đánh đổi.
- **Đề xuất (cho coordinator cân nhắc, không bắt buộc PK0):** nếu muốn, đếm lệch segment vào **luật (b) theo cặp (ip, sourceKey)**. Luật này không khoá IP dùng chung của tenant khác, nên lý do của spec vẫn giữ được.
- **Phụ:** có một oracle tồn tại khác biệt. Key không tồn tại bị tính luật (a), key tồn tại nhưng lệch segment thì không. Đây là ghi nhận, không nặng, vì đường đúng segment vốn đã lộ qua 401 và 404.

### T-3. Đo thời gian (timing) 404 lệch segment so với 404 source không tồn tại

- **Chỗ:** `ingest.service.ts:358-379`.
- **Quan sát:** body giống hệt nhau. Cả hai đều trả `{ status: 404, body: { error: 'Source webhook không hợp lệ hoặc đã tắt' } }` qua cùng `res.status().json()`, nên byte giống nhau. Cả hai cùng đi qua một lần DB. Nhánh không tồn tại có thêm `unknownSourceTotal.inc()` và `recordUnknownSource` (thao tác bộ nhớ, cỡ micro giây). Nhánh lệch có thêm `log.warn`. Không có giải mã secret, không có HMAC. Chênh lệch không đáng kể so với độ nhiễu của DB.
- **Kết luận:** chỉ ghi nhận.

### T-4. Provider native nhận content-type lạ: hành vi đổi từ 401 sang "verify qua nhưng body rỗng"

- **Chỗ:** `body-parsers.ts` (parser raw) cùng `github.adapter.ts:21-27`.
- **Kịch bản:** một request GitHub ký đúng nhưng mang `Content-Type: text/plain`. Trước PK0, `rawBody` thành `"{}"` nên HMAC sai và trả 401. Sau PK0, `rawBody` đúng byte nên HMAC qua. `githubPayload` trả `body` (`undefined`), `raw_events.body = {}` được ACCEPTED, rồi normalize sai khuôn thành lỗi vĩnh viễn.
- **Đánh giá:** kẻ xấu không ký được, và GitHub/Stripe/PayOS/SePay thật không gửi kiểu này. Thực tế không xảy ra. Ghi nhận để biết là có đổi hành vi. Với JSON hỏng thì provider native vẫn trả 400 (đã có test), form vẫn parse như cũ.

### T-5. Body không phải JSON ở `generic`: DB lưu `{}`, normalize mất nội dung

- **Chỗ:** `ingest.service.ts:245` (`body: typeof req.body === 'object' && req.body !== null ? req.body : {}`), `generic.adapter.ts:67-70`, `normalize.consumer.ts:167-168`.
- **Kịch bản:** source generic không có mapping nhận text/XML/JSONL. `body_raw` được giữ đúng (E1 đạt). Nhưng `raw_events.body = {}`, và worker dựng lại `body = {}`. Khi đó `isObj({})` là true, nên `data.raw = {}` thay vì `rawBody.toString()`. Nhánh dự phòng của luật 3 không bao giờ chạy.
- **Đánh giá:** ngoài phạm vi PK0. E1 chỉ yêu cầu byte tới được ingest. Cần xử lý ở PK1/PK5 (E29: cột `body` là `null` JSON khi không parse được).

### T-6. `application/*+json` và `text/json` rơi vào parser raw

- **Chỗ:** `body-parsers.ts:117` (`nestExpress.json` dùng `type` mặc định `application/json`).
- **Kịch bản:** CloudEvents (`application/cloudevents+json`) và JSON:API (`application/vnd.api+json`) vào ingest với `body = undefined`. Generic có mapping khi đó trả 422 hoặc gặp `MappingFieldMissingError('body')`. Trước PK0 cũng y như vậy (không có parser nào chạy), nên đây **không phải hồi quy**.
- **Đề xuất:** để PK1/PK5 cân nhắc, ví dụ dùng `type: ['application/json', 'application/*+json']` cho riêng `/hooks/generic`.

### T-7. Parser raw đọc tới 1MB với mọi content-type trên mọi path `/hooks/*`

- **Chỗ:** `body-parsers.ts:117-120`.
- **Kịch bản:** `/hooks/a/b/c` (sai khuôn, gate không khớp) với `text/plain` 1MB: hub-api đọc hết rồi router mới trả 404. Trước PK0, request này không được đọc. JSON thì đã bị đọc như vậy từ trước. Ở môi trường deployed, nginx đã chặn path sai khuôn (`nginx.conf.template:109,120`). Ngoài ra, content-type lạ kèm `Content-Encoding` không hỗ trợ giờ trả 415 ở parser, trong khi trước đây vào ingest với `"{}"`.
- **Kết luận:** ghi nhận. ADR-201 đã nêu ý chính.

### T-8. Tài liệu và quy trình

- ADR-201 có đủ ba phần vấn đề / chọn / đánh đổi và khớp code. Nội dung dài hơn "3 dòng" nhưng vẫn đúng khuôn ba mục.
- `docs/ARCHITECTURE.md` §3.1 chưa có bước PK0. Spec dời việc này sang docs-sync (PK8, dòng 570), nên chấp nhận được, chỉ ghi để không quên.
- `verify/spec-sources.json`: `pattern` khớp đúng dòng bảng §17. `checklist` khớp `- [x] **PK0**`. `groups` khớp bảng: PK0 = T1, T2, T33; PK4 = T10-T13, T35; PK5 = T14-T18, T36-T38; PK6 = T24-T31, T34; PK7 = T32; PK8 = T39; PK9 = T19-T23. `verify/lib/map.ts` `TAG_RE` đã thêm `PK`, và `verify:map` cho 0 mồ côi.
- `[x] PK0` được đánh trước review (xem phần Kết luận).

---

## Đối chiếu từng điểm được giao

1. **Phạm vi và test.** Đúng phạm vi PK0: E1 đầy đủ, E6 chỉ phần `method`/`query`, chưa lưu DB, chưa `@Get`. Có đủ `[PK:T1]`, `[PK:T2]` (phần a qua HTTP thật, phần b ở L0), `[PK:T33]`. Kết quả thử đột biến:
   - Bỏ phép so segment: T1 **đỏ**, vì verify được gọi, nhận 401 và metric khác.
   - Trả gate về `!== 'POST'`: T2(a) **đỏ**. GET qua gate thì parser chờ đủ 1MB nên treo, hoặc router trả 404 thay vì 429. T2(b) đếm `checkIp` 2 lần, cũng đỏ.
   - Bỏ ngoại lệ `OPTIONS`: **đỏ** (`opt.status` thành 429).
   - Bỏ parser raw: T33 **đỏ**.
   - Bỏ `tolerateGenericJsonError`: **đỏ** (JSONL thành 400).
   - Gọi `recordUnknownSource` ở nhánh lệch: **đỏ**.
   - Dời phép so xuống sau `trace.tenantId`: **xanh** (TB-1).
   - Trả lại fallback `JSON.stringify`: **xanh** (TB-2).
2. **`body-parsers.ts`.**
   - Thứ tự json, rồi form, rồi raw là đúng. body-parser 2.3.0 bỏ qua khi `onFinished.isFinished(req)`, nên raw không đọc lại. Khi JSON lỗi đã được tha ở generic thì stream cũng đã đọc xong, nên form và raw cũng bỏ qua.
   - `keepRawBody` chạy **trước** `parse` (`read.js:141-158`), nên `rawBody` có sẵn khi gặp `entity.parse.failed`.
   - Raw chỉ gắn ở `/hooks`, các route khác giữ 100KB (đã có test).
   - Trần 1MB cho raw và 413 cùng `TOO_LARGE` dùng chung `countingOversize`, đã có test 413 cho text/plain.
   - Lách bằng đường dẫn: `matchHookRoute(pathnameOfUrl(originalUrl))` decode từng đoạn, không phân biệt hoa thường ở tiền tố, chấp nhận một `/` cuối, giống router. Các biến thể đã soát:
     - `/hooks/generic/../github/k` có 4 đoạn, router không khớp, không bị tha.
     - `%2F` trong đoạn provider bị decode thành `generic/x`, khác `generic`.
     - `/hooks/GENERIC/k` không được tha. Router vẫn giao cho ingest, và `ProviderRegistry.get('GENERIC')` trả 400.
     - `/hooks/%67eneric/k` được tha, và router cũng giao cho `generic`, nên nhất quán.
     - `/HOOKS/…` bị `rejectNonCanonicalHooksPath` chặn trước.
     - Cuối cùng, nếu tha nhầm thì phép so segment ở ingest vẫn chặn source không phải generic.

     **Không thấy đường lách.**
3. **Controller.** `req.body` là Buffer thì đổi thành `undefined`, giống như trước PK0 khi không có parser nào chạy. Không vỡ adapter nào:
   - PayOS, SePay, Stripe chỉ nhận JSON thật.
   - `generic` ở bước verify dùng `rawBody`. `diagnose` dùng `raw.body` đã lưu, tức `{}`.
   - JSON hợp lệ vẫn có `rawBody` đúng byte (đã có test).
   - `rawBody` rỗng chỉ xuất hiện khi không có body.
4. **Ingest PK0.**
   - Đặt sau nạp source, trước `trace.tenantId` (`ingest.service.ts:376-381`), đúng E9.
   - Body 404 giống hệt về byte.
   - Không phạt, có metric `NOT_FOUND` (đã có test).
   - Timing: xem T-3.
5. **Gate mọi method.**
   - CORS (`enableCors`, `main.ts:78`) đứng trước gate (`main.ts:86`), nên preflight được trả ngay ở CORS. `OPTIONS` không preflight thì đi qua gate.
   - `HEAD` bị chặn bằng 429. Node bỏ body của phản hồi HEAD, và §16 đã ghi E27 (405) thuộc PK4.
   - Route không phải `/hooks` không bị ảnh hưởng (đã có test GET/POST `/api/v1/sources`).
6. **Hồi quy.** Xem bảng "Kết quả chạy": không có gì đỏ, `tsc` sạch.
7. **ADR, spec-sources, map.** Đúng khuôn (T-8).
8. **Mock source cũ được thêm `provider`.**
   - Đã soát mọi file mock `findSourceBySourceKeyForIngest`. `provider` luôn bằng `req.provider` của chính test đó.
   - Các file chưa sửa (`storage-lock`, `ingest-reject-ack`, `archive-flow-items`) đã có `provider` khớp từ trước.
   - Không test nào dựa vào 404 mà có thể bị 404 lệch segment che mất. Test 404 của source đã lưu trữ (`archive-flow-items.spec.ts:211-212`) dùng `sepay`/`sepay`, và nhánh lưu trữ đứng **trước** phép so segment.
   - `ingest-segment.spec.ts` có test đối chứng (segment khớp thì đi tới verify).

   **Không thấy mock nào che giấu lỗi.**
