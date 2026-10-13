# REVIEW-PK3: sửa Thấp của review PK2 (`c8cc816`) và PK3 signed-template (`b7201ae`)

- **Nhánh:** `feat/pk`, worktree `C:\wt\pk`.
- **Người review:** Grumbal ⚠️ (bảo mật) và Murat 🧪 (test). Review độc lập: chỉ đọc code, chạy jest có chọn lọc, đột biến tạm và file probe tạm. Mọi đột biến đã trả lại bằng `git checkout --`; file probe (`libs/providers/test/zz-review-pk3-*.spec.ts`) đã xoá. `git status` sau review chỉ còn `libs/hub-sdk/bin/hub.js`. File này là WIP có từ trước, review không chạm vào.
- **Ngày:** 2026-10-14
- **Nguồn đối chiếu:** `SPEC-provider-khac.md` (ĐÍNH CHÍNH E2, E15, E16; §5; §16; §17), `REVIEW-PK2.md`, `CLAUDE.md`, ADR-203 (phần bổ sung) và ADR-204. Tài liệu chính thức đọc ngày 2026-10-14: Slack, Paddle, Box, Twitch.

## Kết luận: **ĐẠT** (0 Nặng · 0 Trung bình · 7 Thấp)

T-1 và T-2 là hai chỗ hở có thật, đã chứng minh bằng probe. Hiện chưa khai thác được, vì không fixture provider thật nào và không đường gọi nào trên production chạm tới chúng. Cả hai sửa rẻ, nên sửa trước khi PK6 nối `verifyAt`.

- **`{body}` đúng một lần:** khoá chặt. `{{body}}`, `{bo}{dy}`, `{Body}`, `{body }`, `｛body｝` (ngoặc toàn khổ) và `{body}{BODY}` đều bị 422 `template`. Client và server dùng cùng regex không cờ `u`, nên cùng đếm đơn vị UTF-16: 63 emoji cộng `{body}` thì qua, 64 emoji thì bị chặn, ở cả hai phía.
- **Bytes gốc:** `Buffer.concat`, trong đó `{body}` là `req.rawBody`. Không có `toString`.
- **So sánh:** chỉ qua `timingSafeCompare`. Độ dài khác thì trả false, không ném. Vòng secret × chữ ký không dừng sớm.
- **Khớp provider thật, kiểm độc lập:**
  - **Slack:** vector chính thức của Slack (secret `8f742231…85a5`, ts `1531420618`, chữ ký `v0=a2114d57…b503`, lấy từ docs.slack.dev) verify **true** qua `GenericAdapter` với config điền nhanh Slack.
  - **Stripe:** chữ ký sinh bằng SDK `stripe` (`webhooks.generateTestHeaderString`) verify **true** qua config điền nhanh Stripe.
  - Hai probe trên đã xoá. Đề xuất giữ lại làm test, xem T-4.
- **E2:** ingest không truyền `verifyAt`, nên dùng `Date.now()` như cũ. `swVerify` nhận `nowSec`. Lõi và ngân sách Redis không đổi (`redis-budget` xanh).

## Kết quả chạy

| Lệnh | Kết quả |
|---|---|
| `jest --maxWorkers=2` trên `libs/providers/test`, `libs/crypto/test`, `apps/hub-api/test/{ingest-*,service-sources,console-source-inspect,redis-budget,source-connections*}`, `normalize-*`, `apps/web/src/lib/hub/listen-logic`, `apps/web/src/lib/i18n/dictionary` | **38 PASS, 2 skipped** (suite DB `*-db`): 416 test qua, 8 skip |
| `tsc --noEmit -p apps/{hub-api,hub-worker,web}/tsconfig.json` | sạch cả ba |
| `npm run verify:gates` | 20 luật · 0 vi phạm · 12 ngoại lệ có lý do |
| Không chạy: toàn bộ suite, docker, `next build` | theo yêu cầu |

### Đột biến tạm trên `generic-signed-template.spec.ts` (44 test)

| Đột biến | Kết quả |
|---|---|
| M1: `{body}` thành `Buffer.from(rawBody.toString('utf8'))` | **SỐNG** (44/44 xanh), xem T-3 |
| M2: bỏ kiểm độ lệch (chỉ đòi timestamp có mặt) | chết (8 đỏ) |
| M3: độ lệch một chiều (`now - ts <= tol`) | chết (6 đỏ) |
| M4: chỉ thử chữ ký đầu tiên | chết (2 đỏ) |
| M5: chỉ thử secret đầu tiên | chết (6 đỏ) |
| M6: bỏ qua `verifyAt` (luôn `Date.now()`) | chết (10 đỏ) |

### Probe đã chạy (file tạm, đã xoá)

- **parseTimestamp:**
  - Trả `null`: `2024-13-01`, giờ `25`, giây `60`, offset `+99:99`, năm `275760`, `1e10`, `" 123"`, số toàn khổ `１２３`, `-1`.
  - **Không** ném ở ca nào.
  - V8 nhận `2024-02-30` (lăn sang 01/03) và `T24:00:00`. Vô hại: chữ ký phủ đúng chuỗi nhận được, và giá trị vẫn phải nằm trong cửa sổ.
  - Năm `0000` và số unix 12 chữ số parse được, nhưng lệch xa nên trả false.
  - `00001` (unix) parse ra `1`, xem T-1.
- **kv:**
  - Khoảng trắng quanh khoá/giá trị (` t = 1000 , v1 = … `), phần rỗng (`,,`) và `=x` vẫn verify đúng.
  - Hai `t` trả false. `T=` viết hoa trả false. Hex chữ hoa trả false: tất cả provider đã đối chiếu đều gửi chữ thường.
  - Header dạng mảng thì lấy phần tử đầu.
- **DoS:** 5 000 `v1` với 3 secret mất 16 ms. Mỗi secret chỉ tính HMAC một lần; vòng chữ ký chỉ là so sánh. Node chặn header ở 16 KB. Không cần trần riêng.
- **`verifyAt` = `new Date(NaN)`:** `signed-template` trả false (an toàn). **`standard-webhooks` trả true** với chữ ký có ts=1000 (năm 1970), xem T-2.

## Phát hiện

### T-1 (Thấp, bảo mật): chuỗi ký mơ hồ ở ranh giới token. Phát lại với khoá chống trùng mới, hoặc dời byte giữa `{id}` và `{body}`

- **File:**
  - `libs/providers/src/signed-template.ts:31-32` (unix và unix-ms nhận số 0 đứng đầu)
  - `libs/providers/src/generic-config.ts:338-346` (validator cho `{id}` đứng sát `{body}`)
- **Kịch bản (đã chứng minh bằng probe):**
  1. Template `{id}{timestamp}{body}`, unix, `idempotency: {header: idHeader}`. Request gốc có `id=evt-10`, `ts=1700000000`. Kẻ phát lại gửi `id=evt-1`, `ts=01700000000`. Bytes được ký giữ nguyên, và `parseTimestamp("01700000000")` cũng ra 1700000000. Kết quả: **verify true** với khoá chống trùng **mới**, nên lọt qua dedupe PG trong cửa sổ `toleranceSec`. Event giao lần hai.
  2. Template `{id}{body}`, không timestamp. Kẻ xấu dời ký tự cuối của id sang đầu body (`evt-1` + `{"a":1}` thành `evt-` + `1{"a":1}`). **Verify true** mãi mãi, body bị đổi, khoá chống trùng đổi.
  - Ca tương tự: `{body}{timestamp}` unix khi body kết thúc bằng `0`.
- **Phạm vi:**
  - Không fixture thật nào bị ảnh hưởng. Twitch dùng ISO (năm cố định 4 chữ số, kết thúc bằng `Z`/offset nên không dời được). Box là `{body}` + ISO. Stripe, Slack và Paddle có ký tự ngăn cách.
  - Ca 2 là lỗi trong thiết kế của chính provider (verifier nào cũng chịu). Ca 1 thì do hub nới lỏng: không provider nào gửi số 0 đứng đầu.
- **Đề xuất:**
  - (a) unix `^(0|[1-9]\d{0,11})$`, unix-ms tương tự. Đây là cách chặn rẻ nhất cho ca 1.
  - (b) validator 422 `template` khi `{id}` đứng sát `{body}` mà không có ký tự chữ ở giữa (hai token đều không có khuôn cố định).
  - (c) Thêm 2 test cho hai kịch bản trên.

### T-2 (Thấp, bảo mật, ngầm): `verifyAt` không hợp lệ làm `standard-webhooks` bỏ qua kiểm độ lệch

- **File:**
  - `libs/providers/src/generic.adapter.ts:26-29`
  - `libs/crypto/src/standard-webhooks.ts:72-73`
- **Kịch bản:**
  - `verifyAt = new Date(NaN)` cho `nowSec = NaN`. Khi đó `Math.abs(NaN - ts) > tol` là `false`, nên **không** chặn. Chữ ký từ năm 1970 cũng verify true: phát lại không giới hạn thời gian.
  - `signed-template` thì an toàn, vì nó so bằng `<=`.
  - Hiện chưa có đường gọi nào truyền `verifyAt`. PK6 sẽ truyền `received_at`.
- **Đề xuất:**
  - Trong adapter: `if (!Number.isFinite(nowMs)) return false`.
  - Trong `swVerify`: đổi thành `!(Math.abs(now - ts) <= tol)` (fail-closed).
  - Thêm test `verifyAt: new Date(NaN)` ra false cho cả hai scheme. Nên làm trước PK6.

### T-3 (Thấp, test): không test nào bắt được việc `{body}` bị khứ hồi UTF-8

- **File:** `libs/providers/test/generic-signed-template.spec.ts:239-247`
- **Vấn đề:** đột biến M1 sống. Ca "bytes gốc" dùng `đ`, là UTF-8 hợp lệ, nên `toString` rồi `Buffer.from` ra y hệt. Quy tắc CLAUDE.md "HMAC trên `body_raw` (bytes)" vì thế chưa có test giữ.
- **Đề xuất:** thêm body có byte không phải UTF-8 hợp lệ (vd `Buffer.from([0x61, 0xff, 0xfe, 0x62])`), ký trên bytes, rồi khẳng định verify true. M1 sẽ chết.

### T-4 (Thấp, test): fixture `[PK:T9]` không có vector nào biết trước đáp án

- **File:** `libs/providers/test/generic-signed-template.spec.ts:52-172`
- **Hiện trạng:** chữ ký tính lúc chạy bằng `createHmac` viết tay theo tài liệu, không gọi code của hub. Cách này không tự-tròn theo nghĩa hẹp. Nhưng người viết hàm ký và người viết cấu hình là một, nên nếu hiểu sai tài liệu thì cả hai sai giống nhau.
- **Đối chiếu tài liệu (2026-10-14):** cả sáu fixture khớp.
  - Slack: `v0:ts:body`, `v0=` hex, cửa sổ 5 phút.
  - Stripe: `t.body`, `v1`; khoá là nguyên chuỗi `whsec_…`, không giải mã.
  - Paddle: `ts=…;h1=…`, `ts:body`, mặc định 5 s, có thể có nhiều `h1` khi xoay khoá.
  - Box: bytes body rồi tới bytes timestamp, base64, PRIMARY/SECONDARY, 10 phút. Tài liệu chỉ kiểm "quá cũ"; hub kiểm hai chiều, chặt hơn và chấp nhận được.
  - Twitch: `id + ts + body`, `sha256=` hex. Trang tài liệu không nêu cửa sổ, đúng như §16 ghi.
  - Calendly: `t.body`, `v1`.
- **Đề xuất:** thêm 2 test với đáp án cố định:
  - Vector chính thức của Slack (body slash-command `token=xyzz0WbapA4vBCDEFasx0q6G&…`, secret `8f742231b10e8888abcd99yyyzzz85a5`, ts `1531420618`, chữ ký `v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503`).
  - Header sinh bằng `stripe.webhooks.generateTestHeaderString`, dùng SDK đã có trong repo. Có thể dựng lúc chạy.
  - Reviewer đã chạy cả hai: verify **true**.

### T-5 (Thấp, vận hành): điền nhanh Paddle đặt `toleranceSec: 5`, lệch với Render ngủ đông

- **File:** `apps/web/src/lib/hub/listen-logic.ts:113`
- **Kịch bản:** trên DEPLOYED, request đầu tiên sau khi dịch vụ Render ngủ phải chờ khởi động lạnh hàng chục giây. Khi tới hub, `ts` của Paddle đã lệch hơn 5 s, nên trả 401. Paddle gửi lại nên không mất sự kiện, nhưng console và metric ghi chữ ký sai giả.
- **Đề xuất:** giữ 5 (khớp SDK) và thêm một câu ở `preset-hint`. Hoặc đặt điền nhanh 30 s và ghi lý do vào ADR-204 phần đánh đổi.

### T-6 (Thấp, chẩn đoán): kv thiếu khoá timestamp báo `timestamp_out_of_range`, không báo `missing_header`

- **File:** `libs/providers/src/generic.adapter.ts`, nhánh `diagnoseTemplate`
- **Hiện trạng:** §16 đã ghi đây là chủ ý. Chấp nhận. Nên thêm `expectedKvKey` (vd `t`) để console nói "thiếu khoá `t` trong `stripe-signature`" thay vì "lệch giờ". Làm ở PK sau cũng được.

### T-7 (Thấp, tài liệu): lệch spec chưa ghi §16

- `SPEC-provider-khac.md:279` ghi "`toleranceSec` mặc định 300". Code lại **bắt buộc** khai khi có `{timestamp}` (không có mặc định), và form điền sẵn `"300"`. Hai dòng trong spec tự mâu thuẫn; code chọn cách an toàn. Ghi một dòng vào §16.
- Ví dụ JSON ở §5 dùng `signature: {header, prefix}`, nhưng code chỉ nhận `{headers: [...]}` theo E16 (ĐÍNH CHÍNH thắng). Gửi đúng ví dụ ở §5 sẽ nhận 422 `signature.headers`. Nên sửa ví dụ hoặc ghi §16.
- Zendesk "để `entries-pending/`": thư mục này chưa tồn tại (thuộc story catalog sau). Ghi nhớ để PK catalog nạp vào.

## Mục 4: sửa Thấp của PK2 (`c8cc816`)

| Mục | Đánh giá |
|---|---|
| T-3 `algos` | Mặc định là `sha256 + sha512`. `splitAlgoPrefix` vừa kiểm `HMAC_ALGOS` vừa kiểm tập của config. Validator chỉ cho `algos` đi cùng `"<algo>="`, mảng khác rỗng, không trùng. Có test cho config cũ không khai `algos` (sha1 bị từ chối). Production: ADR-203 bổ sung ghi config `"<algo>="` chỉ tồn tại "vài phút/vài giờ". Review **không kiểm được** có source nào trên production đang dùng `sha1=`, chỉ ghi nhận: nếu có thì source đó sẽ 401 cho tới khi khai lại `algos`. |
| T-4 base64 khứ hồi | Server (`decodeHmacKey`) và client (`isCanonicalBase64`, atob/btoa) cùng luật, có test đối chiếu. Áp dụng cho cả `signed-template` (`keyed`). |
| T-5 token query | `QUERY_TOKEN_RE` unreserved RFC 3986, server và client giống nhau, 422 `secret`. |
| T-2 câu chữ error_log | ADR-203 (5), comment `sensitiveHeaders` và câu nhắc console đã sửa đúng. |
| T-6 form | Secret 8–512 (mọi provider). Gõ tay `<algo>=` thì coi là "Đọc từ tiền tố" và không gửi `algo`. |
| T-7 typing | Không còn `as unknown as Control`. tsc web sạch. |

## Mục 5: form console signed-template

- Ba nút điền nhanh ghi đè đúng các ô ký (`form.reset({...getValues(), ...preset})`). Ô tên, khoá chống trùng và kiểu sự kiện được giữ nguyên. Giá trị khớp tài liệu (Stripe `,`/`v1`/`t`/300; Slack `v0=`/`x-slack-request-timestamp`/300; Paddle `;`/`h1`/`ts`/5).
- Test `listen-logic.spec.ts` dựng config từ từng preset, đưa qua `validateGenericConfig` và `secretProblem` của server, kèm các ca đối chiếu lỗi.
- Có hai lệch nhỏ, không ảnh hưởng an toàn vì server là trọng tài:
  - client `trim()` template, server không;
  - client tolerance dùng `^\d{1,3}$`.

## Mục 7: ADR

- **ADR-203 bổ sung:** đúng khuôn (vấn đề → chọn → đánh đổi), ghi rõ cái giá cho config cũ.
- **ADR-204:** đúng khuôn, ghi đủ các điểm: 3 token, `{body}` một lần, bytes gốc, timestamp ký nguyên chuỗi, tolerance 5..900, `verifyAt`, giới hạn (URL, JSON đã sắp khoá, Recurly).
- **§16:** việc Recurly và Zendesk nằm ngoài `[PK:T9]` **chấp nhận được**. E16 cho phép "không có fixture thì `entries-pending/`". Recurly `<ts>,<sig>` không có tên khoá, đúng là ngoài khuôn kv.
- Đề xuất ADR-204 thêm một câu đánh đổi về T-1 sau khi sửa: token liền nhau không có ký tự ngăn cách.
