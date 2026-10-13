# REVIEW-PK2: sửa review PK1 (`a59f73e`) và PK2 (`4e8e0e2`)

- **Nhánh:** `feat/pk`, worktree `C:\wt\pk`. Gốc so sánh là `master` = `314ace0` (merge-base).
- **Người review:** Grumbal ⚠️ (bảo mật) và Murat 🧪 (test). Review độc lập: chỉ đọc code, chạy jest có chọn lọc và đột biến tạm. Mọi thay đổi tạm đã trả lại bằng `git checkout --` hoặc xoá file tạm.
- **Ngày:** 2026-10-14
- **Nguồn đối chiếu:** `SPEC-provider-khac.md` (ĐÍNH CHÍNH E6, E15, E24; §4; §16; §17), `REVIEW-PK1.md`, `CLAUDE.md` (timingSafeEqual, HMAC trên bytes gốc), ADR-203.

## Kết luận: **ĐẠT** (0 Nặng · 0 Trung bình · 7 Thấp)

- **Tương thích ngược:** đã chứng minh bằng thử vi sai, không chỉ đọc code. Source `hmac-sha256` và `static-token` cũ verify **y hệt master** trên 22 050 tổ hợp. Lệch duy nhất là cột `signature_header` của `static-token` có prefix (T-1), không ảnh hưởng chuyện nhận hay từ chối request.
- **So sánh bí mật:** mọi phép so đều qua `timingSafeCompare`, gồm sha1, basic và query. HMAC tính trên `req.rawBody`.
- **Token ở query:** không lọt vào `raw_events`, log pino, `diagnose`, error filter, metric hay access log nginx. Có một chỗ hở: **error_log của nginx** (T-2). Chỗ này cũng làm câu trong ADR-203 và câu nhắc ở console nói quá.
- **Mục của REVIEW-PK1:** TB-1 và T-1 đến T-6 đã đóng. T-7 đã ghi §16. T-8 đóng phần docstring, còn phép ép kiểu `Control` (T-7 dưới đây).

## Kết quả chạy

| Lệnh | Kết quả |
|---|---|
| `jest --maxWorkers=2`, 34 suite: `libs/providers/test/*`, `libs/crypto/test/{crypto,standard-webhooks}`, `apps/hub-api/test/{ingest-controller,ingest-duplicate-count,ingest-generic,ingest-invariants,ingest-payos-probe,ingest-redact,ingest-reject-ack,ingest-segment,ingest-trace,ingest-traffic,service-sources,console-source-inspect,source-connections,redis-budget,body-limit}`, `apps/web/src/lib/hub/listen-logic`, `apps/web/src/lib/i18n/dictionary`, `apps/hub-worker/test/normalize-{canonical,consumer}` | **34/34 PASS, 335 test** |
| `tsc --noEmit -p apps/hub-api/tsconfig.json` | sạch |
| `tsc --noEmit -p apps/web/tsconfig.json` | sạch |
| Không chạy: toàn bộ suite, suite cần DB (`*-db.spec.ts`), docker, `next build` | theo yêu cầu |

### Thử vi sai với master (file tạm, đã xoá)

Cách làm: chép `generic.adapter.ts`, `generic-config.ts`, `provider.interface.ts`, `normalize-helpers.ts` và `errors.ts` từ `master` vào một thư mục tạm, rồi chạy song song bản cũ và bản mới.

Không gian thử:
- **scheme:** `hmac-sha256`, `static-token`;
- **prefix:** không có, `""`, `sha256=`, `<algo>=`, `v1=`, `Bearer `, `hmac-sha256=`;
- **encoding:** không có, `hex`, `base64`;
- **secret:** 5 loại, gồm secret có dấu cách và secret trông như hex hoặc base64;
- **chữ ký trình ra:** sha1, sha256 và sha512 ở cả hex lẫn base64; có hoặc không có tiền tố `<algo>=`; hex viết HOA; có khoảng trắng cuối; rỗng; rác; chính secret;
- **bộ secret:** `[đúng]`, `[sai, đúng]`, `[sai]`.

Kết quả:
- **`verify`: 0 lệch / 22 050 ca.** Trong đó có ca config cũ mang tiền tố tĩnh `"<algo>="`: bí danh cũ vẫn coi chuỗi này là tiền tố tĩnh, đúng như ADR-203.
- **`sensitiveHeaders`:** không lệch.
- **`extractSignature`:** 1 470 lệch, xem T-1.

Nguồn native (PayOS, SePay, Stripe, GitHub) không bị đụng. PK2 chỉ sửa `generic*`, `provider.interface.ts` (thêm trường tuỳ chọn) và `source-input.ts` (chỉ chạy khi `provider === 'generic'`). Các suite canonical và adapters đều PASS.

### Đột biến (sửa tạm, chạy suite generic, rồi `git checkout --`)

| Đột biến | Kết quả |
|---|---|
| `splitAlgoPrefix` bỏ kiểm `HMAC_ALGOS` (`md5=` ký đúng sẽ qua) | **đỏ** 1 |
| query: `all.length >= 1` thay cho `=== 1` (tham số lặp) | **đỏ** 1 |
| `decodeHmacKey` hex lỏng (`Buffer.from(secret,'hex')`) | **đỏ** 3 |
| `decodeHmacKey` base64 bỏ regex | **đỏ** 1 |
| Bí danh `hmac-sha256` hiểu `"<algo>="` là thuật toán động | **đỏ** 1 |
| basic: so trực tiếp với secret, không qua base64 | **đỏ** 1 |
| `extractSignature` trả token thật thay cho `***` | **đỏ** 4 (`[PK:T7]`) |
| `secretProblem` bỏ kiểm `:` của basic | **đỏ** 3 |
| Bí danh cũ nhận `algo` | **đỏ** 2 |

Cả 9 đột biến đều bị bắt. Không thử đột biến `===` thay `timingSafeCompare`: phép so đó không quan sát được bằng jest, và gate `sig-compare` của verify mới là chỗ bắt nó.

---

## 1. Tương thích ngược

- **Đọc config `hmac-sha256` cũ.** `hmacParams` (`generic-config.ts:87-92`) đọc config cũ thành sha256, khoá utf8, prefix tĩnh. `decodeHmacKey(secret,'utf8')` cho ra `Buffer.from(secret,'utf8')`, đúng bằng khoá mà `createHmac('sha256', secret)` dùng trước đây. Secret rỗng giờ thành `null`, nhưng `parseSourceInput` vẫn bắt secret từ 8 đến 512 ký tự, nên source cũ không thể có secret rỗng.
- **Validate lại ở mỗi request.** `configOf` (`generic.adapter.ts:283-287`) chạy lại `validateGenericConfig` trên config đã lưu. Luật mới (`location`, `param`, `algo`, `keyEncoding`) chỉ từ chối khi có trường mới. Config cũ trong DB là object do validator **dựng lại** (`generic-config.ts:222-233`), không phải input thô, nên không mang trường lạ. Không có source cũ nào bị biến thành `null` (401 vĩnh viễn).
- **Config `hmac` mới lưu xuống DB.** Luôn có `algo`, trừ khi prefix là `<algo>=`. Luôn có `keyEncoding`. Validate lại không đổi nghĩa.

## 2. `"<algo>="`: kẻ gửi tự chọn thuật toán

- **Kịch bản.** Config `scheme:"hmac", prefix:"<algo>="`, provider thật ký bằng sha256. Kẻ tấn công gửi `x-sig: sha1=<HMAC-SHA1(key, body)>`. `splitAlgoPrefix` (`generic.adapter.ts:219-224`) nhận sha1 vì nó nằm trong `HMAC_ALGOS`.
- **Đánh giá.** Đây là hạ cấp thuật toán, nhưng **không** thành giả mạo được. Muốn tạo HMAC-SHA1 hợp lệ vẫn phải có khoá. HMAC-SHA1 chưa có tấn công giả mạo hay khôi phục khoá thực tế, vì HMAC không phụ thuộc vào tính chống va chạm của SHA-1. `md5=` và `sha384=` bị từ chối mà không ném lỗi, đã có test bắt.
- **Hồ sơ.** ADR-203 phần "Đánh đổi" đã ghi rủi ro này.
- **Mức: Thấp (T-3).** Đề xuất phòng sâu ở mục T-3.

## 3. Khoá, độ dài, constant-time

- **`decodeHmacKey` giải mã chặt.**
  - hex: dùng `^(?:[0-9a-fA-F]{2})+$`.
  - base64: dùng regex chuẩn (có hoặc không có padding).
  - Sai khuôn thì trả `null`. Khi verify, secret đó bị bỏ qua (`continue`), không ném. Lúc tạo source, `secretProblem` trả 422 với `field: secret`.
  - Còn một chỗ chưa chặt về lý thuyết, xem T-4.
- **`timingSafeCompare`** (`libs/crypto/src/index.ts:60-70`).
  - Hai chuỗi khác độ dài thì trả `false` sớm. Với HMAC, độ dài là công khai (độ dài digest). Với token, chỗ này lộ độ dài token, giống mọi bản cài đặt thông thường và đã có từ trước PK2.
  - sha1 đi qua cùng hàm này.
- **Không dừng sớm.** Vòng lặp secret ở cả `verifyMac` lẫn `verify` đều không `break`.

## 4. `static-token`: basic và query

### basic

- **Cách so.** So `m[1]` (phần sau `Basic `) với `base64(utf8("user:pass"))` bằng `timingSafeCompare`. Đây là so cả cặp user:pass đã mã hoá, không giải mã lỏng.
- **Che header.** `authorization` có trong danh sách cố định `SENSITIVE_HEADERS` (`redact-headers.ts:10`), và `sensitiveHeaders` khai lại lần nữa. Giá trị lưu là `Basic ***`. Test `ingest-redact` PASS.
- **Diagnose.** Chỉ trả tên `authorization`.

### query

- **Đọc token.** Lấy `req.query` từ `hooksQueryOf` (parseurl, khớp router), đọc bằng `URLSearchParams.getAll`. Tham số xuất hiện khác đúng một lần thì trả `null`; có test và đột biến.
- **Rà mọi chỗ có thể in URL hoặc query:**

| Chỗ | Kết quả |
|---|---|
| `raw_events.headers` | Không có query; lõi không lưu query ở đâu cả. |
| `signature_header` | `***`. |
| Log pino trong `ingest.service.ts` | Chỉ có `correlationId`, `provider`, `sourceId`. |
| `ServiceExceptionFilter` (`service-exception.filter.ts:26`) | Cắt `?` trước khi log. `/hooks` không phải đường dev-facing, nên rơi vào `BaseExceptionFilter`, vốn không log URL. |
| `x-request-id` | Không liên quan. |
| Metric | Nhãn `path` là `hooks`/`publish`, không có URL. |
| `traffic.record` | Chỉ có IP và outcome. |
| Access log nginx | Dùng `$uri`, không có query. |
| inspect và `diagnose` | Chỉ có `expectedQueryParam` (tên tham số). |

- **Hai lỗ hổng tìm thấy:**
  - **error_log của nginx** in nguyên request line, xem **T-2**.
  - **Giải mã URL:** dấu `+` bị đổi thành dấu cách, xem **T-5**.

## 5. `bodyRaw` thành tuỳ chọn (T-4 của PK1)

`StoredRawEvent.bodyRaw` chỉ được đọc ở một chỗ: `diagnoseMapping` (`generic.adapter.ts:170`), có `?? []`.

- **Nhánh không lỗi.** Nhánh này chỉ chạy khi có `mapping`. `normalize` có mapping chỉ đọc `body` (`generic.adapter.ts:81` trở đi). `rawBody` chỉ được dùng ở nhánh **không** mapping (`:79`), mà nhánh đó không đi qua `diagnoseMapping`.
- **Không adapter nào khác cài `diagnose`.**
- **Đối chiếu secret KN** (`source-connection.service.ts:511-518`) vẫn dùng `findRecentRawEventsForSource`, nạp đủ `bodyRaw`.
- **Worker** đọc `rawEvent.bodyRaw` từ một truy vấn khác (`normalize.consumer.ts:167`).
- **tsc sạch.**

Kết luận: không có chỗ nào gặp `undefined`.

## 6. Web

- **Playground.** `playgroundSources` lọc `generic` ra và hiện dòng "Ẩn N nguồn…". Đóng TB-1.
- **`RESERVED_NAMESPACES`.** Bản sao trong `listen-logic.ts` có test so với `@hub/common` (`listen-logic.spec.ts:145-146`). Lệch thì đỏ.
- **`genericFormIssues`.** Dùng cùng regex với server (`HEADER`, `FIELD`, `PARAM`, `EVENT_TYPE`, `HEX`, `B64`, `PREFIX_MAX`), và có test đối chiếu từng ca với `validateGenericConfig` + `secretProblem`. Còn hai lệch nhỏ, xem T-6.
- **Poll khi 404.** `listenRefetchInterval` đọc `HubApiError.status` (`client.ts:5-7`). 404 thì dừng; lỗi khác thì tiếp tục poll và giữ bảng cũ.
- **i18n.** Vi/en đủ khoá; `dictionary.spec` PASS.

## 7. ADR-203 và các lệch ở §16

ADR-203 có đủ ba phần vấn đề / chọn / đánh đổi và khớp code. Có một chỗ sai: câu "log không in URL (nginx log `$uri` không query)" chỉ đúng với access log (T-2).

| Lệch ghi ở §16 | Ý kiến |
|---|---|
| Chuỗi đúng `"<algo>="`, không lưu `algo`; bí danh cũ không hiểu chuỗi này | **Đồng ý.** Đây chính là điều giữ tương thích ngược, đã thử vi sai. |
| sha1 chưa có lý do theo danh mục, ràng buộc dời sang PK9 | **Đồng ý có điều kiện.** PK9 phải thật sự thêm luật này. Đề xuất ở T-3 giảm rủi ro trong lúc chờ. |
| Không có `__hub_meta.query` | **Đồng ý.** Không lưu gì thì không cần che. Nhắc PK6: theo E6, "query gốc nằm trong `captured_headers_enc`", tức phải **mã hoá**, không được rơi vào `headers` rõ. |
| `secretProblem` (thêm ngoài spec) | **Đồng ý.** Đúng tinh thần "422 bây giờ thay vì 401 mãi". |
| Form chỉ tạo `hmac` | **Đồng ý.** |
| prefix ≤ 32 (E15) | Khớp. |

---

## Thấp

### T-1. `signature_header` của static-token có prefix đổi từ `***` thành `null`

- **Chỗ:** `generic.adapter.ts:58`, `if (isStaticToken(c)) return presentedToken(c, req) ? '***' : null;`.
- **Kịch bản:** source `static-token` có `prefix:"Bearer "`, request gửi header nhưng thiếu tiền tố. Master lưu `***`, PK2 lưu `null`. Thử vi sai thấy 1 470 ca lệch, tất cả đều thuộc dạng này. `verify` không đổi.
- **Đề xuất:** chấp nhận được (`null` không lộ gì). Nếu muốn giữ đúng hành vi cũ ở location `header`, dùng `headerOf(req, c.header!) !== null ? '***' : null`; basic và query giữ như hiện tại. Nên ghi một dòng vào §16.

### T-2. Token ở query vẫn lọt vào error_log của nginx; ADR-203 và câu nhắc ở console nói quá

- **Chỗ:** `docker/nginx/nginx.conf.template:18` (`error_log stderr warn`), `:68` (`limit_req_log_level warn`), `:110,129` (`limit_req` ở `/hooks`).
- **Kịch bản:** IP bị cầu chì chặn, hoặc upstream timeout hay 502. Khi đó nginx ghi `... request: "POST /hooks/generic/<key>?token=<SECRET> HTTP/1.1"`: request line đầy đủ, có cả query. Dòng này ra stderr rồi lên log Render. Access log `$uri` sạch, nhưng error_log thì không.
- **Câu nói quá:**
  - ADR-203 (5): "log không in URL (nginx log `$uri` không query)".
  - Câu nhắc ở console `page.sources.generic.location-query-hint`: "Hub không lưu và không ghi log query".
  - Comment `generic.adapter.ts` `sensitiveHeaders`.
- **Đề xuất:** sửa ba câu trên thành "access log không in query; error_log của nginx (cầu chì, lỗi upstream) vẫn in request line". Nginx không có cách che query trong error_log, nên đây là đánh đổi phải ghi lại, cùng nhóm với log của proxy Render. Có thể thêm một test tĩnh khoá `log_format` không chứa `$request`, `$request_uri` hay `$args`, để access log không tự dưng bị đổi.

### T-3. Phòng sâu cho `"<algo>="`: tập thuật toán theo config

- **Chỗ:** `generic.adapter.ts:219-224`, `generic-config.ts:51`.
- **Kịch bản:** xem §2. Chỉ là hạ cấp, kẻ tấn công không giả mạo được nếu không có khoá.
- **Đề xuất:** thêm trường tuỳ chọn `algos?: HmacAlgo[]`, chỉ dùng khi prefix là `<algo>=`.
  - Mặc định `["sha256","sha512"]`.
  - sha1 chỉ được dùng khi khai rõ, và tới PK9 thì phải kèm lý do trong danh mục.
  - `splitAlgoPrefix` kiểm theo `algos`.
  - Bitbucket và Jira (sha256) sẽ không còn nhận sha1. WebSub thì khai `["sha1","sha256","sha512"]`.
  - Đây không phải điều kiện để ĐẠT, có thể làm cùng PK9.

### T-4. base64 "chặt" vẫn nhận bit thừa khác 0

- **Chỗ:** `generic-config.ts:95` (`B64_KEY_RE`).
- **Kịch bản:** `"AB=="` và `"AA=="` cùng giải mã ra `0x00`. Bản không padding cũng vậy, ví dụ `"AB"` và `"AC"`. Hai secret khác nhau cho cùng một khoá, trái với lời comment ở `:97-99`.
- **Tác động:** không có tác động bảo mật, vì secret do provider cấp và người dùng chỉ dán vào. Chỉ là comment nói quá.
- **Đề xuất:** kiểm `Buffer.from(s,'base64').toString('base64').replace(/=+$/,'') === s.replace(/=+$/,'')` (khứ hồi), hoặc sửa comment cho đúng.

### T-5. Token ở query chứa `+`, `%`, `&` hay `#` không khớp

- **Chỗ:** `generic.adapter.ts:262-264` (`URLSearchParams` giải mã `+` thành dấu cách).
- **Kịch bản:** secret `abc+def/ghi=`. Người dùng dán URL `...?token=abc+def/ghi=` vào trang của provider mà không mã hoá. Hub nhận `abc def/ghi=` và trả 401 mãi. Nhanh: `new URLSearchParams('token=a+b%2Bc').getAll('token')` cho ra `["a b+c"]`.
- **Đề xuất:** chọn một trong hai.
  - `secretProblem` với location query chỉ nhận ký tự không cần mã hoá (`^[A-Za-z0-9._~-]+$`), và trả 422 kèm `fix: dùng token không có + / = & #`.
  - Hoặc console hiện URL đã `encodeURIComponent` sẵn để dev chép.

### T-6. `genericFormIssues` và server còn hai lệch nhỏ

- **Secret dài hơn 512 ký tự.** Client chỉ kiểm `min(8)` (`page.tsx:131`), server kiểm cả `> 512`.
- **Gõ tay tiền tố `<algo>=`.** Người dùng chọn algo `sha256` rồi gõ tiền tố tĩnh `<algo>=`. Client thấy hợp lệ, server trả 422 trên `algo` với câu "bỏ trường algo", mà form không có cách bỏ trường đó.
- **Server vẫn là trọng tài, nên hai lệch này không gây hại.**
- **Đề xuất:** thêm `max(512)`. Khi `prefix === ALGO_IN_PREFIX` thì báo lỗi ở ô tiền tố, câu "chọn 'Đọc từ tiền tố' ở ô thuật toán".

### T-7. Phần T-8 của PK1 còn sót

- **Chỗ:** `page.tsx:441`, `form.control as unknown as Control<GenericFormValues>`.
- **Vì sao cần làm:** PK2 thêm 5 trường vào form, nên phép ép kiểu này giờ che nhiều chỗ hơn. tsc không bắt được trường hợp hai schema lệch nhau.
- **Đề xuất:** dùng `useFormContext` hoặc tách sub-form. Có thể làm ở PK7.

---

## Ghi chú cho người điều phối

- Worktree đang có `M libs/hub-sdk/bin/hub.js`. Thay đổi này **không** thuộc hai commit được review, cũng không do reviewer tạo. Reviewer không đụng vào.
- Không commit, không push. File này nằm trong worktree và chưa được commit.
