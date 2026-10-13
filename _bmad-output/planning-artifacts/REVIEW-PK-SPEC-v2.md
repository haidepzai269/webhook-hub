# REVIEW SPEC PK bản 2 (Grumbal ⚠️, reviewer độc lập)

- Đối tượng: `_bmad-output/planning-artifacts/provider-khac/SPEC-provider-khac.md` (bản 2, chưa commit)
- Nền: master `57c81ad`. Chỉ đọc code. Không chạy npm, jest hay docker.
- Mỗi phát hiện đều dẫn file:dòng. Chỗ nào chưa xác minh được thì ghi rõ "chưa xác minh".

**Tổng:** 7 Nặng · 15 Trung bình · 11 Thấp.

---

## 0. Kiểm khẳng định về code (F1–F15)

| # | Kết luận | Bằng chứng |
|---|---|---|
| F1 | Đúng | `libs/providers/src/generic-config.ts:7,23`; `generic.adapter.ts` có `diagnose` (dòng 243 trong file adapter) |
| F2 | Đúng | `apps/web/src/lib/hub/types.ts:6` |
| F3 | Đúng | `service-resources.controller.ts:422` |
| F4 | Đúng | `libs/crypto/src/standard-webhooks.ts:44-46` |
| F5 | Đúng | `ingest.controller.ts:12` |
| F6 | Đúng | `provider.interface.ts:160` |
| F7 | Đúng | `ingest.service.ts:344` (registry) và `:355` (nạp source). Không có chỗ nào so `source.provider` |
| F8 | Đúng, lệch ±1 dòng | `ingest.service.ts:536-576`; `rejected-sample.ts:11-12` |
| F9 | Đúng | `source-input.ts:27` (secret bắt buộc) và `:31-37` |
| F10 | Đúng | `generic-config.ts:16` |
| F11 | Đúng | `penalty-gate.ts:54` (`if (req.method !== 'POST') return next();`) |
| F12 | Đúng | `prisma.service.ts:175-189` (retention chỉ xoá `REJECTED`); `tenant-scoped.repository.ts:1563-1640` (junk = REJECTED, ACCEPTED mồ côi); `measureStorage` đếm `octet_length(body_raw)` của mọi dòng (`:1451-1455`) |
| F13 | Đúng | `schema.prisma` `RawEvent`: `idempotencyKey` NOT NULL, `@@unique([sourceId, idempotencyKey])` |
| F14/F15 | Lấy từ nghiên cứu, không kiểm bằng code | Xem **N1**: phần lớn khuôn ở F15 **không vào tới ingest** |

Ghi chú thêm cho PK1.4: `swVerify` **đã** khớp nhiều chữ ký và không dừng sớm (`standard-webhooks.ts:50-55`). Phần mới chỉ là đọc bộ `svix-*`.

---

## NẶNG

### N1. Body không phải JSON hay form bị mất bytes trước khi vào ingest. F15, `unverified`, chế độ thu và `manual-url` (SNS) đều hỏng

**Vấn đề.** `/hooks` chỉ gắn parser `json` và `urlencoded`. Các content-type khác thì `req.rawBody` không được gán. Controller khi đó tự dựng lại body bằng `JSON.stringify(req.body || {})`, ra `"{}"`. Bytes gốc mất hẳn. Bị ảnh hưởng:
- SNS (`text/plain`), WebSub (XML), Wix (JWT), Auth0 (JSON lines), Google Drive (body rỗng);
- mọi content-type lạ.

Với JSON lines gắn `application/json`, parser json trả **400 trước ingest**, nên request không bao giờ có dòng `raw_events`.

**Bằng chứng.**
- `apps/hub-api/src/body-parsers.ts:91-96`: chỉ có `nestExpress.json` và `nestExpress.urlencoded`.
- `ingest.controller.ts:20`: `const rawBodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));`

**Hệ quả.**
- `[PK:T17]` ("đúng từng byte") chỉ qua với JSON hoặc form.
- `[PK:T23]` của `identify` qua, nhưng ingest thật thì trượt.
- Bài B ở §13 trượt mọi mục có khuôn F15.
- Dòng thu ở chế độ thu (PK6) không verify bù được.

**Sửa spec.** Thêm vào PK1 (hoặc thành PK0b) câu sau:

> "`/hooks/*` thêm `express.raw({ type: () => true, limit: MAX_INGEST_PAYLOAD_BYTES, verify: keepRawBody })` SAU parser json/urlencoded, để mọi content-type khác vẫn có `req.rawBody`. Controller bỏ fallback `JSON.stringify` cho `/hooks`: không có `rawBody` thì dùng `Buffer.alloc(0)`. Parser json lỗi cú pháp ở `/hooks/generic/*` không được trả 400 trước ingest. Hoặc chuyển `/hooks` sang chỉ dùng raw rồi parse lỏng trong ingest. Test `[PK:T23b]`: SNS `text/plain`, XML, JWT, JSONL, body rỗng đi vào ingest với `rawBody` đúng từng byte."

---

### N2. Kích hoạt (PK6) verify bù sẽ trượt với mọi scheme có timestamp, và không còn đường kích hoạt khi header đã bị xoá

**Vấn đề 1.** Verify bù chạy `adapter.verify` lúc kích hoạt. Standard Webhooks so timestamp với **giờ hiện tại**, cửa sổ 300 giây. `signed-template` (PK3) cũng đòi `toleranceSec`. Cửa sổ thu mặc định 15 phút, tối đa 60 phút. Vậy dev kích hoạt sau khi request tới quá 5 phút thì mọi dòng S3/S4 (Stripe, Slack, Svix…) đều `failed`, và kích hoạt nhận 422 `activation_unverified`.

**Bằng chứng.**
- `libs/crypto/src/standard-webhooks.ts:47-49`: `now = opts.nowSec ?? Date.now()`, rồi `if (Math.abs(now - ts) > tolerance) return false`.
- `ProviderAdapter.verify(req, secrets, ctx)` không có tham số thời điểm (`ingest.service.ts:405`).

**Vấn đề 2.** §9.3.7 xoá `captured_headers_enc` sau khi hết hạn thu 1 giờ. Sau mốc đó mọi dòng thu không còn header để verify. §9.3.3 chỉ miễn 422 khi **không có dòng nào**. Kết quả: dev quay lại sau 2 giờ thì không kích hoạt được, chỉ còn cách "Lắng nghe lại" mà spec không nói ra.

**Sửa spec.**
- Thêm `ctx.verifyAt?: Date`, hoặc truyền `nowSec` xuống `swVerify` và `signed-template`. Verify bù dùng `received_at` của dòng thu làm "bây giờ". `received_at` do DB đặt nên không giả được.
- Câu thêm vào §9.3.2: "Dòng thu không còn `captured_headers_enc` → kết quả `n/a (headers_purged)`, không tính là failed. Không còn dòng nào verify được → cho kích hoạt kèm `acknowledgeUnverified: true`, và không được promote dòng nào."
- Test `[PK:T27b]`: dòng Stripe thu lúc t, kích hoạt lúc t+20 phút → `verified`.

---

### N3. `hmac-echo` (Zoom) là một máy ký hộ: kẻ biết `sourceKey` xin được chữ ký hợp lệ cho body giả

**Vấn đề.** Zoom dùng **cùng** secret, cùng thuật toán HMAC-SHA256 và cùng mã hex cho hai việc:
- bắt tay: `encryptedToken = HMAC(secret, plainToken)`;
- ký sự kiện: `x-zm-signature = v0=HMAC(secret, "v0:{ts}:{body}")`.

Nghiên cứu ghi Zoom ở S4+S7, `x-zm-signature`, hmac-sha256, hex, tiền tố `v0=` (`research/PROVIDER-FINGERPRINTS.md:198`, chuỗi ký `v0:{ts}:{body}` ở `:90`). §6.1 trả `HMAC(secret, plainToken)` với `plainToken` lấy từ body mà **không verify request bắt tay trước**. Kẻ xấu gửi `plainToken = "v0:<ts>:<body giả>"` thì nhận lại đúng chữ ký của một sự kiện giả. Sự kiện đó sau đó vào hub với `verified` **thật**. Lỗ này phá cột "Tin cậy" ở §0.

Chưa xác minh: tài liệu Zoom có ký request `endpoint.url_validation` bằng `x-zm-signature` hay không. Theo hiểu biết chung là có, cần đối chiếu.

**Sửa spec** (§6.1, dòng `hmac-echo`):

> "`hmac-echo` chỉ trả lời khi request bắt tay **verify qua** theo scheme của source (Zoom: `signed-template`). Không verify được thì trả `rejectStatus` và gọi `recordBadSignature`. `plainToken` phải khớp `^[A-Za-z0-9_-]{1,128}$`, sai thì 400. Cấm `hmac-echo` ở chế độ thu."

Thêm test `[PK:T10b]`: `plainToken` chứa `:` hoặc `{` thì không có chữ ký trả ra; request không ký thì không có echo.

---

### N4. Khoá 4 ("đích tự đồng ý") lọt qua polling `/v1/p/:project/events` và `hub listen`. Envelope cũng chưa mang `verified`

**Vấn đề.** Khoá 4 chỉ đặt ở router. Còn ba chỗ lọt:
- Polling (A) trả **mọi** event của project cho bất kỳ API key nào có `read:events`, không lọc `verified`.
- `hub listen` đi qua polling, nên cũng lọt.
- Cột trả về và envelope dùng chung không có trường `verified`, nên service đang poll không phân biệt được sự kiện chưa xác thực.

Tiền lệ `probe` (KQ1) có lọc ở polling. Spec không làm tương tự.

**Bằng chứng.**
- `libs/database/src/tenant-scoped.repository.ts:523-535`: `WHERE ... AND NOT e.probe`, không có điều kiện verified. SELECT có `e.normalized`, không có `verified`.
- `service-resources.controller.ts:331-375`.
- `libs/common/src/webhook-body.ts:28-40`: `toWebhookBody` không có `verified`.

**Sửa spec** (§7.1, khoá 4):

> "Polling: event `verified=false` **không** trả, trừ khi request có `?includeUnverified=true` **và** API key có scope mới `read:unverified`, do owner cấp và có audit. SELECT của `pollEvents` và `toWebhookBody` thêm `verified`. `hub listen` hiện nhãn."

Test `[PK:T16b]`: polling bằng key thường thì 0 event chưa xác thực; có scope thì trả về kèm `verified:false`.

Nên rà thêm hai đường giao khác, chưa xác minh hết:
- replay (`api.controller.ts:617-711`) không kiểm lại `acceptUnverified` nếu cờ subscription bị tắt sau đó;
- đích Telegram/Discord không hiện nhãn.

---

### N5. `verified` không có chỗ lưu ở tầng raw. Suy ra từ config **hiện tại** là sai, còn mượn `signature_valid` thì bật cảnh báo critical

**Vấn đề 1: suy từ config hiện tại.** Worker normalize chỉ thấy `source.verificationConfig` **lúc chạy**. Nếu source đổi từ `unverified` sang `hmac` (qua kích hoạt hoặc sửa config sau này), rồi renormalize các raw cũ (nhận khi chưa verify), thì ra event `verified=true`.

Bằng chứng:
- `normalize.consumer.ts:179` đọc config hiện tại;
- `api.controller.ts:903-951`: renormalize dựng lại payload rồi chạy normalize lại.

**Vấn đề 2: `persistAccepted` ghi cứng `signatureValid: true`.** Dòng `raw_events` của source `unverified` sẽ nói dối. Bằng chứng: `ingest.service.ts:249`.

**Vấn đề 3: không có kênh báo "nhận mà không verify".** `verify()` chỉ trả `boolean`. Với `unverified`, adapter phải trả `true` thì ingest mới đi tiếp. `GenericAdapter.verify` hiện trả `false` khi không có secret (`generic.adapter.ts:21`: `if (!c || secrets.length === 0) return false;`).

**Vấn đề 4: mượn `signature_valid=false` thì gây cảnh báo sai.** Luật `source.signature_failing` (critical, mặc định gửi email) đếm `NOT r.signature_valid`. Một source `unverified` sẽ mở cảnh báo critical vĩnh viễn. Bằng chứng: `tenant-scoped.repository.ts:1338-1346`; `libs/common/src/alerts/rules.ts:58-62,108`.

**Sửa spec.** Thêm vào migration PK5:
- `raw_events.verified boolean NOT NULL DEFAULT true`, ghi lúc ingest;
- `ProviderAdapter.verify` được trả `{ ok: true, verified: false }` (hoặc thêm hook `verifiedBy?(ctx): boolean`);
- `persistAccepted(…, { verified })` ghi `raw_events.verified`. `signature_valid` vẫn là `true`, theo nghĩa "không sai chữ ký";
- normalize chép `raw_events.verified` sang `events.verified`, **không** đọc config.

Test `[PK:T15b]`: đổi config sang `hmac` rồi renormalize raw cũ thì event vẫn `verified=false`.

---

### N6. `data.url` và query không dựng được: `RawWebhookRequest` không có query/URL, `raw_events` không có cột lưu

**Vấn đề.** §7.2 bắt worker dựng `url = PUBLIC_HOOKS_BASE_URL + path + query gốc`. Nhưng:
- controller không đưa query hay URL vào `RawWebhookRequest`;
- `raw_events` không có cột URL hay query;
- normalize chạy trong `hub-worker`, chỉ có headers đã che và body.

PK2 (`static-token location=query`) và PK4 (`query-echo` đọc `param`, `verifyTokenParam`) cũng cần query. PK6 cần query để verify bù, kể cả với token ở query.

**Bằng chứng.**
- `ingest.controller.ts:22-30`: chỉ có provider, sourceKey, headers, rawBody, body, contentType, ip.
- `schema.prisma` `RawEvent`: không có cột url hay query.
- `normalize.consumer.ts:163-170`: `req` dựng lại không có url.

**Sửa spec.**
- PK0 (hoặc PK2) thêm `RawWebhookRequest.query: string` (chuỗi thô sau `?`) và `method`.
- Ingest của source `unverified` dựng `url` **lúc nhận** và lưu vào `raw_events.headers.__hub_meta.url`, cùng khoá meta với `REJECTED_META_KEY` ở `rejected-sample.ts:15`.
- Query token của PK2 bị che **trước** khi lưu.
- Worker chỉ đọc lại giá trị đã lưu, không đọc env. Lý do: đổi env rồi renormalize thì URL không được đổi.
- Với dòng thu, lưu query trong `captured_headers_enc`.

---

### N7. `unverified` cộng chống trùng theo `field`/`header` cho phép **nuốt** sự kiện thật

**Vấn đề.** Ở chế độ `unverified`, hub chống trùng **trước** khi có ai verify. Kẻ biết `sourceKey` (đúng mối đe doạ mà §7 đặt ra) có thể:
1. gửi trước một body giả mang `orderId`/`transId` = X, hub nhận làm ACCEPTED;
2. khi IPN thật của MoMo mang X tới, hub coi là DUPLICATE và trả 200, MoMo không gửi lại;
3. shop nhận bản giả, verify trượt nên vứt đi. **Giao dịch thật mất**.

Bốn khoá ở §7.1 chỉ chống *tin nhầm*, không chống *nuốt*.

**Bằng chứng.**
- `ingest.service.ts:229-234` (Redis GET → duplicate) và `:266-270` (unique của Postgres → duplicate, trả 200 qua `ackFor`, `:289-291`).
- `generic.adapter.ts:154-166`: khoá là `generic:${v}`, không gắn với nội dung.

**Sửa spec** (§7.2):

> "Với `unverified`, khoá chống trùng **luôn** là `${field|header}:${bodyHashKey(rawBody)}`. Có `field` thì ghép, không thì chỉ `bodyHashKey`. Chỉ bản trùng **đúng từng byte** mới bị coi là trùng. Shop tự chống trùng nghiệp vụ theo id của provider sau khi verify."

Thêm test `[PK:T14b]`: hai body khác nhau cùng `transId` thì cả hai vào ACCEPTED.

Ghi rủi ro còn lại vào ADR-206: kẻ biết `sourceKey` vẫn tiêu được hạn mức EG3 của source, vì với `unverified` mọi request đều "ký đúng".

---

## TRUNG BÌNH

### M1. Dòng REJECTED `handshake` và `not_configured` làm bẩn cảnh báo và lưu lượng

- `source.signature_failing` đếm mọi raw `NOT signature_valid`, và `storeRejected` nhận `signatureValid` từ người gọi (`ingest.service.ts:545`, `:566`). Một source mới đang thu 10 request trong 15 phút, nếu ghi `signature_valid=false`, sẽ thành 100% "ký sai" và mở cảnh báo **critical kèm email** (`rules.ts:58-62`, `tenant-scoped.repository.ts:1340`).
- EG4: spec cho outcome `REJECTED` (§9.2). Bảng IP của EG5 gọi `REJECTED` là "request sai chữ ký" (`tenant-scoped.repository.ts:1918-1925`).

**Sửa spec.** "Dòng `handshake` và `not_configured` ghi `signature_valid = true` (nghĩa: không có chữ ký sai) **và** `__hub_meta.reason`. `countSignatureBySource` loại `reason IN ('handshake','not_configured')`. Lưu lượng: thêm outcome `CAPTURED` vào enum `TrafficOutcome` (`schema.prisma:417`, migration chỉ thêm giá trị), hoặc chấp nhận và ghi ADR."

### M2. Mâu thuẫn về vị trí EG3 và số lệnh Redis

§9.2 nói đường thu "**có** qua EG3" và "**0 lệnh Redis**". §6.2.3 nói GET đi qua "EG3". Thực tế EG3 chạy **sau verify** (`ingest.service.ts:424-432`, 1 EVAL). Đường thu đặt **trước** verify. Bắt tay không verify.

**Sửa spec.** Ghi rõ "Đường thu và đường bắt tay **không** qua EG3. Trần là `CAPTURE_MAX_REQUESTS` (thu) và `penalty-gate` + nginx `limit_req` (bắt tay)." Sửa §6.2.3 cho khớp. Thêm một bảng thứ tự ingest đầy đủ cho cả ba nhánh (xem M15).

### M3. Không tái dùng nguyên `persistAccepted` được cho promote

`persistAccepted` tự mở transaction, không nhận `tx` hay hook (`ingest.service.ts:221-280`). Có hai việc nó không làm được:
- Không chèn được "xoá dòng `captured_`" vào **cùng** transaction.
- Khi trùng (P2002), transaction rollback (`:266-271`), nên "trùng thì vẫn xoá dòng thu" không thể nằm trong cùng transaction đó.

Xoá dòng thu cũng không trừ `project_usage`, trong khi retention và lệnh dọn đều trừ (`prisma.service.ts:181-186`).

**Sửa spec.** "Tách `persistAccepted` thành `persistAcceptedTx(tx, …)` + vỏ bọc. Promote gọi bản `Tx` rồi xoá dòng thu trong cùng tx. P2002 → tx thứ hai chỉ xoá dòng thu. Mọi lần xoá trừ `project_usage.used_bytes` như `deleteExpiredRejectedBatchAccounted`." Đây là thay đổi lõi, ghi vào ADR-209.

### M4. Dòng thu (có thể là giao dịch thật) nằm trong `junk`, nên bị dọn trước khi kích hoạt. Trần 20 × 1MB lại quá lớn

- Lệnh dọn `junk` xoá **mọi** REJECTED chỉ theo `received_at < before` (`tenant-scoped.repository.ts:1563-1570`). Chính sách tự dọn (`StoragePolicy`, có `trigger`) có thể xoá dòng thu khi dev chưa kịp kích hoạt. Điều này trái với lý do giữ đủ body ở §9 ("BB-3 qua đường vòng").
- `CAPTURE_MAX_REQUESTS ≤ 20` × body ≤ 1MB = 20MB cho mỗi source, so với hạn mức mặc định 50MB/project (`schema.prisma` `Project.storageQuotaMb`, "mặc định 50").

**Sửa spec.**
- "Lệnh dọn `junk` bỏ qua dòng có `captured_headers_enc IS NOT NULL`. Sau khi job xoá header (hết hạn + 1h), dòng trở thành junk thường."
- Thêm trần tổng byte thu: `CAPTURE_MAX_BYTES` mặc định 2MB/source, kiểm trong cùng câu `UPDATE` có điều kiện (thêm cột `capture_bytes`).

### M5. "headers đã che" ở chế độ thu không che được token tĩnh trong header riêng

`redactHeaders` chỉ che danh sách cố định cộng `sensitiveHeaders(ctx)` (`redact-headers.ts:10`, `:31-36`). Source chưa có config thì không có `ctx`. Token như `x-gitlab-token`, `x-webhook-token`, hay basic auth của Chargebee nằm trong header riêng thì được lưu **rõ** vào `raw_events.headers` (xem được qua API events và inspect).

**Sửa spec** (§9.1): "Dòng thu: `headers` chỉ giữ **tên** header, giá trị thay bằng `***` cho mọi header khớp `CANDIDATE_HEADER_RE` (`generic.adapter.ts:313`) **và** mọi header không thuộc danh sách an toàn (content-type, user-agent, content-length…). Giá trị gốc chỉ nằm trong `captured_headers_enc`." Thêm vào `[PK:T26]`.

### M6. Chưa có chỗ lưu cấu hình bắt tay ở chế độ thu. "Secret thứ hai" cũng chưa tồn tại

- Tạo source ở chế độ thu: `{provider, name, mode}`, không có `verificationConfig` (§9.2). Nhưng §6.1 và PK7 cần `handshake.adoptSecret` **lúc đang thu**. `validateGenericConfig` bắt buộc `scheme` và `eventType` (`generic-config.ts:46`, `:83`), nên không lưu `{handshake}` riêng được.
- `verifyTokenParam` "so với secret thứ hai của source": `SourceSecret` là các **phiên bản xoay** (`version`, `validUntil`), và ingest giải mã rồi thử **mọi** secret (`ingest.service.ts:392-399`). Token của Meta mà lưu thành một secret thì nó cũng thành khoá HMAC hợp lệ, và ngược lại.

**Sửa spec.**
- "Chế độ thu lưu `verification_config = { mode: 'capture', handshake?: {...} }`. `validateGenericConfig` có nhánh riêng cho `mode:'capture'`."
- "`verifyToken` lưu mã hoá trong `verification_config.handshake.verifyTokenEnc` (AES-GCM, master key), **không** phải `SourceSecret`."

### M7. Tạo source `unverified` vẫn bị đòi `secret`. Cờ project chưa có đường tới adapter

- `source-input.ts:27-29` bắt buộc secret 8–512 ký tự với mọi provider.
- `GenericAdapter.verify` trả `false` khi `secrets.length === 0` (`generic.adapter.ts:21`).
- Khoá 1 (cờ project) phải kiểm ở ingest, nhưng lõi "không đọc" config (`ingest.service.ts:401-402`) và `findSourceBySourceKeyForIngest` chưa JOIN `projects`.
- Spec cũng không nói `source_unverified_disabled` có gọi `recordBadSignature` hay không. Nếu đi nhánh `!isSignatureValid` thì sẽ ghi REJECTED **và** phạt, trái với "không ghi".

**Sửa spec.**
- "`parseSourceInput`: `scheme:'unverified'` thì không nhận `secret`."
- "`AdapterContext` thêm `projectFlags: { allowUnverified }`, nạp cùng câu với source (+0 lượt DB, như `storageLevel`)."
- "Cờ tắt → trả `rejectStatus`, không `storeRejected`, không `recordBadSignature`, metric outcome `INVALID`."

### M8. PK2 thu hẹp `prefix` từ 32 xuống 16 ký tự làm source cũ chết im lặng

`generic-config.ts:59` hiện cho tới 32 ký tự. `configOf` kiểm **lại** config mỗi lần dùng (`generic.adapter.ts:332-336`). Config cũ có prefix 17–32 ký tự thành `null`, `verify` trả false, và **mọi** request bị 401.

**Sửa spec.** "Giữ ≤ 32 cho tương thích ngược." Hoặc: "migration kiểm dữ liệu hiện có; có dòng vượt thì không đổi."

### M9. `signed-template` thiếu định dạng timestamp và header chữ ký thứ hai. Bắt tay Twitch không khai báo được

- `toleranceSec` chỉ dùng được khi biết timestamp là giây unix, mili-giây, hay ISO 8601/RFC 3339. Theo hiểu biết chung (chưa đối chiếu tài liệu), Zendesk, Twitch và Box dùng chuỗi ISO. Nghiên cứu chỉ ghi tên header (`PROVIDER-FINGERPRINTS.md:1107,1120,1176`).
- Box có hai header `box-signature-primary/secondary` (`:1176`). Spec chỉ có một `signature.header`.
- Bắt tay Twitch phân biệt bằng **header** `twitch-eventsub-message-type`, còn `challenge` nằm trong body. `when` của `body-echo` chỉ xét trường body cấp một (§6.1).

**Sửa spec.**
- Thêm `timestampFormat: "unix" | "unix-ms" | "iso8601"`.
- `signature.headers: string[]` (≤ 2, khớp một là đủ).
- `when` cho phép `{ header: name, equals }` **hoặc** `{ field, equals }`.
- `[PK:T9]` thêm fixture Zendesk, Box và Twitch, hoặc ghi rõ cả ba ở `entries-pending/`.

### M10. Payload `unverified` vượt trần gửi 64KB của worker

`SEND_MAX_BYTES = 64 * 1024` được áp vào `axios.post` (`apps/hub-worker/src/senders/http-limits.ts:29`, `:37`, `:110`). `data.raw` là base64, cộng envelope. Body gốc trên khoảng 45KB (vd mảng SendGrid, payload GitHub/Shopify) thì giao **không bao giờ** thành công. Spec §7.2 chỉ xét QT.

Chưa xác minh: axios ném lỗi gì và delivery consumer xếp lỗi đó là tạm hay vĩnh viễn.

**Sửa spec.** "Source `unverified`: body > 45KB → 413 lúc ingest (kèm `fix`), **hoặc** nâng `SEND_MAX_BYTES` theo ADR." Thêm test với body 60KB.

### M11. `data.url` mang `sourceKey` (chính URL bí mật) tới mọi đích. Biến env bị trùng

- §7 coi `sourceKey` là bí mật duy nhất của `unverified`. `data.url` lại phát nó tới mọi subscription, vào polling, vào `delivery_attempts.request_body` và tới đích Telegram/Discord.
- Hub đã có `HUB_PUBLIC_URL` và hàm dựng URL ingest công khai (`apps/hub-api/src/modules/console/source-connection.service.ts:41-49`, `projects.controller.ts:53-55`). Spec hub-sap lại đề xuất `HUB_INGEST_PUBLIC_URL`. PK thêm `PUBLIC_HOOKS_BASE_URL`, thành **ba tên** cho một khái niệm.

**Sửa spec.**
- "`url` chỉ gửi khi config `forwardUrl: true` (cần cho S6: Twilio, Square, Trello, HubSpot)."
- "Dùng lại `HUB_PUBLIC_URL` qua cùng hàm của `source-connection.service.ts`. Không thêm env mới. Thống nhất tên với SPEC-hub-sap trước khi code."

### M12. Khai báo `PK` "theo dạng BP" trong `spec-sources.json` sẽ bắt được 0 test

- Namespace BP dùng `pattern` `^\|\s*`\[BP:(T\d+)\]`\s*\|` (dòng bảng) và `checklist` `\[x\] \*\*(BP\d+)\*\*` (`verify/spec-sources.json:276-288`).
- Spec PK khai test trong bullet, có dòng chứa ba mã (`[PK:T3]…[PK:T4]…[PK:T5]`). Spec không có checklist `- [ ] **PK0**`.

**Sửa spec.** Thêm một bảng test `| `[PK:Tn]` | story | mô tả |` (mỗi mã một dòng) và một checklist `- [ ] **PK0** …` ở §16. Hoặc nói rõ `pattern` riêng cho PK.

### M13. `adoptSecret` theo kiểu "ai tới trước thắng" cho kẻ biết `sourceKey` cấy secret của mình

Trong cửa sổ thu, request `header-echo` đầu tiên **quyết** `SourceSecret` (§6.1, `[PK:T13]`). Kẻ cấy trước sẽ ký được sự kiện **`verified=true`** giả, còn Asana thật thì bị từ chối mãi. Khi Asana đăng ký lại webhook, nó gửi secret mới, và hub không có đường nhận.

**Sửa spec.** "Secret nhận được nằm ở trạng thái *chờ*. Console hiện thời điểm, IP và User-Agent của request bắt tay. Dev bấm xác nhận thì mới thành `SourceSecret` (audit). 'Lắng nghe lại' xoá secret đang chờ."

### M14. `rejectStatus: 503` không cứu được KiotViet

Sau vài lần ký sai, hộp phạt trả **429**, tức vẫn là 4xx (`ingest.service.ts:384-388`, `blocked-ack.ts`). Trước verify còn có 404, 413 và 507. Vậy lý do ở §6.3 ("provider sẽ gửi lại và không tắt webhook") chỉ đúng tới lần phạt đầu tiên.

**Sửa spec.** Ghi rõ giới hạn này vào ADR-205. Hoặc thêm `ack.blockedStatus: 429 | 503` cho cả phản hồi của hộp phạt và EG3. Cách này có đánh đổi với EG2, cần phòng quyết.

### M15. Thiếu bảng thứ tự ingest cho ba nhánh mới

Nhánh bắt tay (PK4) cho source **đã cấu hình** không có vị trí trong pipeline: trước hay sau verify, trước hay sau hộp phạt theo cặp, có `storeRejected` hay không. `hmac-echo` bắt buộc phải sau verify (N3). `query-echo` phải sau QT3 hay không cũng chưa nói. Dev sẽ phải đoán. Các bước hiện có nằm ở `ingest.service.ts:326-454`.

**Sửa spec.** Thêm một bảng ở §6.2 đánh số khớp với `ingest.service.ts`:

| Bước | Việc |
|---|---|
| 0 | `checkIp` |
| 1 | 413 |
| 2 | nạp source, rồi **PK0** so segment |
| 2q | QT3 |
| 2a | `checkPair` |
| **2t** | thu (PK6) |
| **2h** | bắt tay `query-echo`/`body-echo`/`header-echo`/`manual-url` |
| 3 | verify, rồi **3h** `hmac-echo` |
| 3c | EG3 |
| 4–7 | như hiện tại |

---

## THẤP

1. **Sai route trong câu "đi vòng" của S10** (§8.3). Spec ghi `POST /v1/p/:project/publish`, route thật là `POST /v1/p/:project/events` (`service-api.controller.ts:68`). Câu này hiện thẳng cho người dùng.
2. **Số liệu không cộng ra 91.** 60 + 26 + 5 (S10) + 2 = 93. ZaloPay vừa nằm trong nhóm `unverified` (§7 "Vì sao") vừa là `unsupported` (§8.3). Nghiên cứu xếp ZaloPay ở S5+S10 (`PROVIDER-FINGERPRINTS.md:63,68`). Phải bỏ ZaloPay khỏi danh sách ở §7 và tính lại 26.
3. **Khoá 3 nên dùng lại hằng có sẵn.** `RESERVED_NAMESPACES = ['payment','repo','hub']` và `isReservedType` (`libs/common/src/canonical/index.ts:23-28`). Spec chỉ nêu `payment.*`/`repo.*`, bỏ sót `hub.*`.
4. **Kiểu cột không khớp helper.** `captured_headers_enc bytea`, nhưng `aesGcmEncrypt` trả `string` (`libs/crypto/src/aes.ts:15`) và `source_secrets.secret_encrypted` là `Text`. Đổi thành `text`.
5. **Hệ số dung lượng.** "`events.data` to khoảng 1,33 lần" bỏ sót `raw_events.body_raw` vẫn giữ một bản. Tổng khoảng 2,33 lần body (`measureStorage` đếm cả hai, `tenant-scoped.repository.ts:1451-1458`).
6. **GET, HEAD và echo.** `@Get` của Express cũng nhận **HEAD** (theo hành vi của router Express, chưa chạy thử), nên `acceptsMethod` phải tính tới HEAD. "Trần query 8KB" chưa nói chặn ở đâu (nginx `large_client_header_buffers`? ingest?). Echo phải ép `text/plain; charset=utf-8`, giới hạn độ dài và tập ký tự (chống phản chiếu nội dung).
7. **Phụ thuộc story.**
   - Ví dụ ở PK5 dùng `ack` (của PK4), trong khi PK5 chỉ phụ thuộc PK2.
   - §8 "song song, chỉ đụng `catalog/`" nhưng cần `GET /api/v1/catalog` (hub-api), `POST /sources/:id/identify` (phụ thuộc PK6) và alias import ở `apps/web/tsconfig.json:17`. Web hiện chỉ import lib qua alias từng file, nên `identify.ts` phải có alias riêng, không qua barrel `@hub/providers` vốn import `crypto` của Node.
8. **Meta và metric.**
   - `__hub_meta` hiện chỉ có `{bodyTruncated, originalBytes}` (`rejected-sample.ts:20`). Spec nên ghi trường `reason: 'handshake'|'not_configured'`.
   - Dòng thu ghi gì vào cột `body` (Json NOT NULL)?
   - 503 của đường thu rơi vào nhãn metric `INVALID` (`ingest.service.ts:310`). Nên ghi rõ, hoặc thêm `CAPTURE_FULL`.
9. **Vị trí kiểm của PK0.** Phải đặt **trước** `trace.tenantId = source.tenantId` (`ingest.service.ts:372`), để 404 do lệch segment không mang tenant hay lưu lượng.
10. **Câu chữ PK1.4.** Viết như việc mới, nhưng phần nhiều chữ ký đã có (`standard-webhooks.ts:50-55`). Dev chỉ cần thêm bộ `svix-*`.
11. **Promote mất mốc thời gian gốc.** Dòng ACCEPTED mới có `received_at = now()`. `receivedAt` dự phòng của normalize (`normalize.consumer.ts:177`) và thứ tự polling sẽ là lúc kích hoạt, không phải lúc provider gửi. Nên ghi mốc gốc vào `__hub_meta.capturedAt`, hoặc chấp nhận và ghi ADR.

---

## Kiểm nhanh các mục khác

- **ADR 201–209:** còn trống. `docs/adr/README.md` lớn nhất là ADR-200. SPEC-hub-sap tự giữ 211+ và ghi "PK giữ 201–210".
- **Test ID:** T1–T32 không trùng nhau. PK8 không có test.
- **Migration:** chỉ thêm cột nullable hoặc có default (`capture_until NULL`, `capture_count DEFAULT 0`, `verified DEFAULT true`, `acceptUnverified DEFAULT false`, `allow_unverified_sources DEFAULT false`, `captured_headers_enc NULL`), nên rollback an toàn. Nếu theo M1 thêm giá trị vào enum `TrafficOutcome`, thì `ALTER TYPE … ADD VALUE` **không** rollback được trong transaction. Cần ghi chú.
- **RLS:** kích hoạt, identify và inspect đều đi qua `forTenant`, ổn. Spec không đụng bảng mới nên không phát sinh policy RLS mới.
- **BP:** router chỉ thêm một bộ lọc. `buildDeliveryMessage` (`route-event.ts:37-45`) không đổi, nên không va BP2.
- **nginx:** location `/hooks` hợp lệ không có `limit_except`, nên GET đi qua được. Log dùng `$uri`, không có query (`docker/nginx/nginx.conf.template:40-43`), nên token ở query không lọt vào access log của edge. Log của nền tảng Render chưa xác minh.
- **PK0, đường ghép URL `/hooks`:** console ghép theo `src.provider` (`sources/page.tsx:233`, `connect-dialogs.tsx:256`), nên không gãy. Script k6 và kịch bản verify chưa rà.
