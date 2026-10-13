# SPEC PK (bản 2): "Provider khác". Trục chính là đường truyền, trục phụ là nhận diện tên

> **Bản 2, phòng party, 2026-10-13 tối.** Bản này thay hoàn toàn bản 1 (commit `3254196`, xem lịch sử git). Chưa có code. Admin giao cho phiên dev.
>
> Bản 1 bị đổi trục vì ba lý do:
> 1. Admin chốt: **"đường truyền là cốt lõi; không nhận ra tên nhưng nối được là được"**.
> 2. Phản biện của phòng tìm ra lỗi thật trong bản 1 (§1, F11–F15).
> 3. Đã có số liệu nghiên cứu 91 provider: `research/PROVIDER-FINGERPRINTS.md` + `research/provider-fingerprints.json`.
>
> - **Tiền tố mã test:** `PK:`. Thêm namespace `PK` vào `verify/spec-sources.json` **trước** test đầu tiên, khai báo theo dạng của `BP`.
> - **ADR bắt đầu từ ADR-201.** Đã grep: lớn nhất trên master là ADR-200. Grep lại trước khi ghi.
> - **Mỗi story có khối "Vì sao".** Dev dùng khối này làm dòng Vấn đề / Đánh đổi của ADR và thân commit. Lúc code mà thấy lý do không còn đúng thì **dừng lại, báo phòng**.
> - **Chi tiết chữ ký của provider thật** lấy từ `research/`. Mục nào ghi "chưa xác minh", "kiến thức chung" hoặc độ tin cậy `thấp` thì **không** được vào danh mục hay fixture nếu chưa đối chiếu lại tài liệu. Lệch với nghiên cứu thì tài liệu provider thắng, ghi vào §16.
> - **RAM máy yếu:** tối đa 2 agent nặng; jest `--maxWorkers=2` (đã khoá trong config); tsc chạy từng project; commit ngay sau mỗi story.

## ĐÍNH CHÍNH SAU REVIEW BẢN 2 (2026-10-13 đêm). Mục này thắng phần thân

Reviewer độc lập (`_bmad-output/planning-artifacts/REVIEW-PK-SPEC-v2.md`) tìm ra **7 Nặng, 15 Trung bình, 11 Thấp**, mục nào cũng có file:dòng. Phòng nhận **toàn bộ** và chốt cách sửa như dưới đây. Dev đọc **file review** để có bằng chứng và đọc **mục này** để biết quyết định. Chỗ nào thân spec nói khác thì mục này thắng.

### Nặng

- **E1 (N1): bytes gốc với mọi content-type. Làm ở PK0, trước mọi thứ khác.**
  - `body-parsers.ts`: `/hooks/*` thêm `express.raw({ type: () => true, limit: MAX_INGEST_PAYLOAD_BYTES, verify: keepRawBody })` **sau** parser json/urlencoded.
  - `ingest.controller.ts:20`: bỏ fallback `JSON.stringify`. Không có `rawBody` thì dùng `Buffer.alloc(0)`.
  - JSON lỗi cú pháp: **riêng `/hooks/generic/*`** không trả 400 ở parser. Coi như body không parse được (`body = null`), bytes vẫn giữ. Provider native giữ hành vi 400 như cũ, để không đổi hợp đồng đã test.
  - `[PK:T33]`: SNS `text/plain`, XML, JWT, JSON lines, body rỗng đều vào ingest với `rawBody` đúng từng byte.
- **E2 (N2): verify bù theo giờ nhận.**
  - `AdapterContext` thêm `verifyAt?: Date`. `swVerify` và `signed-template` dùng nó làm "bây giờ". Verify bù truyền `received_at` của dòng thu (DB đặt, không giả được).
  - Dòng thu không còn `captured_headers_enc` → kết quả `n/a (headers_purged)`, không tính là failed. Không còn dòng nào verify được → cho kích hoạt kèm `acknowledgeUnverified: true`, và **không promote** dòng nào.
  - `[PK:T34]`: dòng Stripe thu lúc t, kích hoạt lúc t+20 phút → `verified`.
- **E3 (N3): `hmac-echo` không được thành máy ký hộ.**
  - Chỉ trả lời khi request bắt tay **verify qua** theo scheme của source. Không qua → `rejectStatus` + `recordBadSignature`.
  - `plainToken` phải khớp `^[A-Za-z0-9_-]{1,128}$`, sai thì 400.
  - **Cấm `hmac-echo` ở chế độ thu.**
  - Dev đối chiếu tài liệu Zoom: request `endpoint.url_validation` có mang `x-zm-signature` không. **Không** mang → Zoom vào `entries-pending/`, không làm `hmac-echo` (ghi §16).
  - `[PK:T35]`: `plainToken` chứa `:` hoặc `{` → không có chữ ký trả ra; request bắt tay không ký → không echo.
- **E4 (N4): khoá 4 phủ cả polling, listen, replay.**
  - Polling `/v1/p/:project/events` **không** trả event `verified=false`, trừ khi có `?includeUnverified=true` **và** API key có scope mới `read:unverified` (owner cấp, có audit).
  - `pollEvents` SELECT thêm `verified`. `toWebhookBody` thêm `verified`. `hub listen` hiện nhãn.
  - Replay (`api.controller.ts:617-711`) kiểm lại `acceptUnverified` **lúc replay**.
  - Đích Telegram/Discord: tin nhắn có tiền tố "[Chưa xác thực]".
  - `[PK:T36]`: key thường poll ra 0 event chưa xác thực; key có scope thì ra, kèm `verified:false`. Tắt `acceptUnverified` rồi replay → không giao.
- **E5 (N5): `verified` lưu ở tầng raw, không suy từ config.**
  - Migration PK5 thêm `raw_events.verified boolean NOT NULL DEFAULT true`.
  - `ProviderAdapter.verify` được trả `boolean | { ok: boolean; verified: boolean }`. Adapter cũ giữ `boolean`, lõi hiểu `true` là `{ok:true, verified:true}`.
  - `persistAccepted(…, { verified })` ghi `raw_events.verified`. `signature_valid` vẫn là `true`, theo nghĩa "không sai chữ ký".
  - Normalize chép `raw_events.verified` sang `events.verified`, **không** đọc config.
  - `[PK:T37]`: đổi config sang `hmac` rồi renormalize raw cũ → event vẫn `verified=false`. Source `unverified` không làm mở cảnh báo `source.signature_failing`.
- **E6 (N6): query và URL.**
  - PK0 thêm `RawWebhookRequest.query: string` (chuỗi thô sau `?`) và `method`. PK2 (token ở query) và PK4 (`query-echo`) dùng trường này.
  - Token ở query bị che **trước** khi lưu (`headers.__hub_meta.query` lưu bản đã che).
  - Source `unverified` có `forwardUrl: true`: ingest dựng URL **lúc nhận**, bằng hàm sẵn có ở `source-connection.service.ts:41-49` (`HUB_PUBLIC_URL`), rồi lưu vào `headers.__hub_meta.url`. Worker chỉ đọc giá trị đã lưu, **không** đọc env.
  - Dòng thu: query gốc nằm trong `captured_headers_enc`.
- **E7 (N7): `unverified` chống trùng theo nội dung.** Khoá **luôn** là `${field|header value}:${bodyHashKey(rawBody)}`, hoặc chỉ `bodyHashKey` nếu không khai. Chỉ bản trùng **đúng từng byte** mới là trùng. Shop chống trùng nghiệp vụ sau khi tự verify. Rủi ro còn lại ghi ADR-206: kẻ biết `sourceKey` vẫn tiêu được EG3 và hạn mức của source. `[PK:T38]`: hai body khác nhau cùng `transId` → cả hai vào ACCEPTED.

### Trung bình

- **E8 (M1): dòng `handshake` và `not_configured` không làm bẩn cảnh báo.**
  - Ghi `signature_valid = true` + `__hub_meta.reason`. `countSignatureBySource` loại `reason IN ('handshake','not_configured')`.
  - EG4 ghi outcome `REJECTED`. **Không** thêm giá trị enum `TrafficOutcome`, vì `ALTER TYPE … ADD VALUE` không rollback được, mà Admin cần mốc rollback `57c81ad`.
  - Nhãn bảng IP EG5 đổi thành "bị từ chối / chưa cấu hình". Ghi ADR-209.
- **E9 (M2, M15): bảng thứ tự ingest**, đánh số khớp `ingest.service.ts:326-454`:

  | Bước | Việc |
  |---|---|
  | 0 | `checkIp` |
  | 1 | 413 |
  | 2 | nạp source, rồi **PK0** so segment (**trước** `trace.tenantId = …`, `:372`) |
  | 2q | QT3 |
  | 2a | `checkPair` |
  | **2t** | thu (PK6) |
  | **2h** | bắt tay `query-echo` / `body-echo` / `header-echo` / `manual-url` |
  | 3 | verify, rồi **3h** `hmac-echo` (chỉ khi verify qua) |
  | 3c | EG3 |
  | 4–7 | như hiện tại |

  Đường thu (2t) và bắt tay (2h) **không** qua EG3. Trần của chúng là `CAPTURE_MAX_*`, cùng `penalty-gate` và nginx `limit_req`.
- **E10 (M3): tách `persistAccepted`** thành `persistAcceptedTx(tx, …)` + vỏ bọc giữ nguyên hành vi cũ.
  - Promote gọi bản `Tx` rồi xoá dòng thu trong **cùng** tx.
  - P2002 (trùng) → tx thứ hai chỉ xoá dòng thu.
  - Mọi lần xoá dòng thu trừ `project_usage.used_bytes`, như `deleteExpiredRejectedBatchAccounted`.
  - Promote ghi `__hub_meta.capturedAt` (mốc gốc). Normalize dùng nó làm `receivedAt` dự phòng.
- **E11 (M4): bảo vệ và giới hạn dòng thu.**
  - Lệnh dọn `junk` (QT) **bỏ qua** dòng có `captured_headers_enc IS NOT NULL`. Sau khi job xoá header, dòng thành junk thường.
  - Thêm cột `sources.capture_bytes int DEFAULT 0` và `CAPTURE_MAX_BYTES` (mặc định 2MB/source), kiểm trong cùng câu `UPDATE` có điều kiện.
- **E12 (M5): che header dòng thu.** Chỉ giữ giá trị của danh sách an toàn (`content-type`, `user-agent`, `content-length`, `accept`, `accept-encoding`). Mọi header khác giữ **tên**, giá trị thay bằng `***`. Giá trị gốc chỉ nằm trong `captured_headers_enc`. Bổ sung vào `[PK:T26]`.
- **E13 (M6): cấu hình chế độ thu.** `verification_config = { mode: 'capture', handshake?: {...} }`. `validateGenericConfig` có nhánh riêng. Token bắt tay (`verifyTokenParam`) lưu mã hoá ở `verification_config.handshake.verifyTokenEnc` (AES-GCM), **không** phải `SourceSecret`, để nó không bao giờ thành khoá HMAC.
- **E14 (M7): `unverified` không có secret, cờ project tới adapter.**
  - `parseSourceInput`: `scheme:'unverified'` thì **không nhận** `secret`.
  - `AdapterContext` thêm `projectFlags: { allowUnverified }`, nạp cùng câu với source (+0 lượt DB, như `storageLevel`).
  - Cờ tắt → `rejectStatus`, **không** `storeRejected`, **không** `recordBadSignature`, metric outcome `INVALID`.
- **E15 (M8): `prefix` giữ ≤ 32 ký tự**, như hiện tại. Thân spec ghi 16 là sai.
- **E16 (M9): `signed-template` thêm ba thứ.**
  - `timestampFormat: "unix" | "unix-ms" | "iso8601"`.
  - `signature.headers: string[]` (≤ 2, khớp một là đủ; Box).
  - `when` của bắt tay nhận `{ header, equals }` **hoặc** `{ field, equals }` (Twitch).
  - Zendesk, Box, Twitch: có fixture thì vào `[PK:T9]`, không có thì vào `entries-pending/`.
- **E17 (M10): trần gửi 64KB.** Source `unverified` có body > 45KB → **413** lúc ingest, kèm `fix`. Không nâng `SEND_MAX_BYTES` trong đợt này. Test với body 60KB.
- **E18 (M11): không phát URL bí mật.**
  - `data.url` **chỉ** có khi `forwardUrl: true` (nhóm S6 cần). Console cảnh báo rằng URL chứa `sourceKey`.
  - **Bỏ env `PUBLIC_HOOKS_BASE_URL`**, dùng lại `HUB_PUBLIC_URL`.
- **E19 (M12): định dạng cho `verify/spec-sources.json`.** §17 (cuối file) có **bảng test mỗi mã một dòng** và **checklist `- [ ] **PKn**`** theo đúng `pattern`/`checklist` của BP.
- **E20 (M13): `adoptSecret` không còn "ai tới trước thắng".**
  - Secret nhận được nằm ở trạng thái **chờ**. Console hiện thời điểm, IP và User-Agent của request bắt tay. Dev bấm xác nhận thì mới thành `SourceSecret` (audit).
  - "Lắng nghe lại" xoá secret đang chờ.
  - Đổi `[PK:T13]`: chưa xác nhận thì không verify được gì; xác nhận rồi mới verify.
- **E21 (M14): `rejectStatus: 503` chỉ cứu được tới lần phạt đầu tiên** (hộp phạt vẫn trả 429). **Không** đổi mã của hộp phạt: EG2 giữ nguyên ngữ nghĩa. Ghi rõ giới hạn này vào ADR-205 và vào câu giải thích ở console khi chọn 503.

### Thấp

- **E22:** câu đi vòng của S10 dùng `POST /v1/p/:project/events` (`service-api.controller.ts:68`), không phải `/publish`.
- **E23:** ZaloPay là `unsupported` (S10), **bỏ** khỏi danh sách `unverified`. Nhóm `unverified` = **25** bên. Cách đếm 91 bên:
  - 60 S1–S4;
  - 25 `unverified`;
  - 4 S10 thuần (VNPay, ZaloPay, OnePay, Adobe Commerce; **Discord** đếm trong S8/S10, đi `unsupported`);
  - 2 chưa xếp mã (sapo, zalo-oa).

  Dev đếm lại theo `research/provider-fingerprints.json` rồi ghi số thật vào §16.
- **E24:** khoá 3 dùng `RESERVED_NAMESPACES` / `isReservedType` sẵn có (`libs/common/src/canonical/index.ts:23-28`), gồm cả `hub.*`.
- **E25:** `captured_headers_enc` kiểu **`text`** (khớp `aesGcmEncrypt`), không phải `bytea`.
- **E26:** dung lượng của `unverified` ≈ **2,33 lần** body (cả `body_raw` lẫn `data.raw`). Console ghi rõ.
- **E27:** GET và HEAD.
  - `acceptsMethod` coi `HEAD` là **405**.
  - Trần query 8KB kiểm ở ingest (`req.originalUrl`), và nginx giữ mặc định.
  - Echo: `text/plain; charset=utf-8`, ≤ 256 ký tự, tập ký tự `^[\x21-\x7E]+$`. Ngoài tập → 400.
- **E28:** phụ thuộc story.
  - PK5 cần `ack` của PK4, nên PK5 làm **sau** PK4 (thứ tự §16 đã đúng).
  - §8 cần alias riêng `@hub/providers/catalog` trong `apps/web/tsconfig.json`, **không** qua barrel `@hub/providers` (barrel import `crypto` của Node).
  - `POST /sources/:id/identify` thuộc PK6.
- **E29:**
  - `__hub_meta.reason: 'handshake' | 'not_configured'`.
  - Cột `body` (Json NOT NULL) của dòng thu: JSON đã parse lỏng, hoặc `null` (JSON) nếu không parse được.
  - Nhãn metric của 503 đường thu là `CAPTURE_FULL`. Đây là nhãn Prometheus, không phải enum DB.
- **E30:** PK1.4: `swVerify` đã khớp nhiều chữ ký (`standard-webhooks.ts:50-55`), chỉ cần thêm bộ `svix-*`.

### Thứ tự giao dev đêm nay (RAM 16GB, chỉ ~1,4GB trống)

Chỉ **một** agent nặng mỗi lúc. §8 (danh mục) **không chạy song song**; làm sau PK3, khi các scheme S1–S4 đã có.

Thứ tự: **PK0 (+E1, E6 phần query/method) → PK1 → PK2 → PK3 → §8 danh mục + `identify` (mục S1–S4 + native + unsupported) → PK4 → PK5 → PK6 → PK7 → PK8**.

Mỗi story: dev → review → sửa → (Trung bình trở lên thì review lại) → commit → CI. Gộp master theo từng chặng, kèm gitleaks.

## 0. Mong muốn đã chốt (Admin, 2026-10-13)

1. Người dùng là **dev của shop**. Chọn **"Provider khác"** thì có form để nhập.
2. **Đường truyền là cốt lõi.** Mục tiêu: dù không nhận ra tên, request đầu tiên của provider vẫn vào được **ACCEPTED**.
3. **Nhận diện tên đi song song.** Bên nào nhận ra thì hiện tên, vì dev thấy tên provider thì yên tâm hơn. Danh mục phải lớn: dựa trên 91 bên đã nghiên cứu.
4. **Đồng ý chế độ "đích tự kiểm"** (scheme `unverified`, §7), có đủ các khoá an toàn. Đây là đường để nối các bên mà hub không tự verify được (S5, S6, S8, S9).
5. **Fixture dựng được tính** vào bài nghiệm thu "nhận tên". Báo cáo phải **tách hai cột**: chính thức và dựng (§13).
6. Source **chưa cấu hình** mà nhận request thì **trả 200** (trong giới hạn ở §9).
7. Review sau khi dev xong phải **chạy bài nghiệm thu trên toàn bộ danh mục** (§13), không chọn mẫu.

**Ba nghĩa phải tách bạch** (giữ nguyên từ bản 1):

| Việc | Câu hỏi | Ai quyết | Có được tin không |
|---|---|---|---|
| **Nhận diện** | "Trông như bên nào?" | `identify()`, hàm thuần chạy **trong trình duyệt** | **Không.** Chỉ là nhãn |
| **Đường truyền** | "Verify, bắt tay, khoá chống trùng, ack thế nào?" | Config của source (hoặc adapter native) | Có, kèm fixture và test |
| **Tin cậy** | "Sự kiện này có thật từ provider không?" | Chữ ký khớp trên đúng bytes. Không có chữ ký thì `verified: false` (§7) | Là thứ duy nhất được tin |

## 1. Đọc từ code và nghiên cứu (2026-10-13, master `57c81ad`)

**F1–F10 lấy từ bản 1, đã kiểm lại trên master mới.** BP3–BP6 không đụng vào phạm vi PK. Mọi số dòng vẫn đúng.

| # | Ở đâu | Thực tế | Hệ quả |
|---|---|---|---|
| F1 | `libs/providers/src/generic.adapter.ts`, `generic-config.ts` | `GenericAdapter` có 3 scheme: `hmac-sha256`, `static-token`, `standard-webhooks`. Có `diagnose()` | Phần lõi để nối provider lạ đã có |
| F2 | `apps/web/src/lib/hub/types.ts:6` | `PROVIDERS = ["github","sepay","payos","stripe"]` | Console không thấy `generic` |
| F3 | `apps/web/src` | Không có màn lắng nghe. `inspect` chỉ có ở service API (`service-resources.controller.ts:422`) | Dev cấu hình sai chỉ thấy 401 |
| F4 | `libs/crypto/src/standard-webhooks.ts:44-46` | Chỉ đọc `webhook-*` | Không verify được nhóm Svix (`svix-*`) |
| F5 | `ingest.controller.ts:12` | Chỉ có `@Post` | Bắt tay kiểu GET (Meta, Dropbox, WebSub) không vào được |
| F6 | `provider.interface.ts:160` | `buildAck(result)` không nhận `ctx` | Không trả ack theo cấu hình được (MoMo cần 204) |
| F7 | `ingest.service.ts:341,355` | Không kiểm `source.provider === req.provider` | URL sai segment vẫn chạy adapter sai |
| F8 | `ingest.service.ts:535-575` | Mẫu REJECTED: body ≤ 4KB, header đã che, khoá `rejected_${correlationId}`, ≤ 20 mẫu/phút/source | Không verify lại được về sau |
| F9 | `source-input.ts:27` | Tạo source phải có `secret`; `generic` phải có `verificationConfig` | Chưa có source "chưa cấu hình" |
| F10 | `generic-config.ts` | `mapping` chỉ có một `eventType` | Không rẽ nhánh được |

**Phát hiện mới khi phản biện bản 1:**

| # | Ở đâu | Thực tế | Hệ quả |
|---|---|---|---|
| **F11** | `apps/hub-api/src/modules/ingest/penalty-gate.ts:54` | `if (req.method !== 'POST') return next();` | Mở GET ở `/hooks` mà không sửa dòng này thì GET **đi vòng qua hộp phạt D3**. Bản 1 chỉ kiểm nginx |
| **F12** | `prisma.service.ts:181`, `tenant-scoped.repository.ts:1563-1640` | Retention chỉ xoá `REJECTED`; lệnh dọn QT chỉ đụng `REJECTED` và `ACCEPTED` mồ côi; `measureStorage` đếm mọi `body_raw` | Một status mới (vd `CAPTURED` của bản 1) sẽ **bị đếm dung lượng mà không đường dọn nào chạm tới**. Bẫy 507 mà QT §13 đã cấm. **Bản 2 không thêm status mới** |
| **F13** | `schema.prisma` `RawEvent` | `idempotency_key` NOT NULL, `@@unique([sourceId, idempotencyKey])` | Dòng thu được phải có khoá xác định. Đưa vào luồng không được INSERT thêm một dòng trùng byte |
| **F14** | nghiên cứu §1 | Chỉ 9/91 bên có mẫu chính thức kèm header | Fixture của 82 bên phải **dựng** (§13 tách cột) |
| **F15** | nghiên cứu §1 | Body không phải object JSON: mảng (SendGrid, HubSpot), JSON lines (Auth0), JWT (Wix), XML (WebSub), rỗng (Google Drive), form (7 bên), JSON gắn `text/plain` (SNS) | `identify()` phải parse được hết, không được dựa vào content-type |

**Bảng phủ đường truyền** (91 bên, tính theo cơ chế chính; nghiên cứu §2):

| Mã | Hình dạng | Số bên | Story nối được |
|---|---|---|---|
| S1 | HMAC trên body thô, chữ ký ở header | 29 | PK2 (mở rộng config) |
| S2 | Token tĩnh / basic auth | 13 | PK2 |
| S3 | Standard Webhooks / Svix | 5 | PK1 |
| S4 | HMAC trên timestamp (+id) + body | 13 | PK3 |
| S5 | HMAC trên các trường ghép lại | 8 | PK5 (`unverified`) |
| S6 | HMAC có URL nhận | 4 | PK5 (`unverified` + URL công khai) |
| S7 | Bắt tay lúc đăng ký (đi kèm với mã khác) | 15 bên có | PK4 |
| S8 | Bất đối xứng / verify qua API / dataless | 9 | PK5 (`unverified`) |
| S9 | Không ký | 5 | PK5 (`unverified`) |
| S10 | Đòi phản hồi nghiệp vụ đồng bộ | 5 bên có (VNPay, ZaloPay, OnePay, Discord, Adobe Commerce) | **Không nối.** Danh mục ghi "nhận ra, chưa xử lý" kèm cách đi vòng (§8.3) |

Sau đợt này: **S1–S4 = 60 bên** đi bằng config có verify; **S5/S6/S8/S9 = 26 bên** đi bằng `unverified`; S10 nhận ra tên và chỉ cách khác; 2 bên chưa xếp được mã (sapo, zalo-oa).

## 2. PK0: Segment khớp provider, và GET không lách được cổng phạt

> **Vì sao**
> - **F7:** lõi chọn adapter theo segment URL nhưng chọn source theo `sourceKey`. `/hooks/github/<key-sepay>` chạy HMAC kiểu GitHub với secret SePay, luôn 401 mà dev không hiểu vì sao. Nếu sau này có adapter verify lỏng thì một `sourceKey` lộ ra là đủ để đi vòng qua adapter chặt.
> - **Trả 404, không 400:** cùng body với source không tồn tại (ADR-161), không lộ source có tồn tại hay không. **Không cộng điểm phạt EG2**, vì URL sai của provider thật không được làm khoá IP dùng chung.
> - **F11:** PK4 sẽ mở GET. Cổng phạt phải chặn GET trước khi GET tồn tại, không thì cửa sau mở ra đúng ngày merge.

1. `ingest.service.ts`, ngay sau bước nạp source: `source.provider !== req.provider` → 404 cùng body, không `recordUnknownSource`, metric `outcome="NOT_FOUND"`. Đây là so sánh hai giá trị, không phải `if (provider === 'x')`.
2. `penalty-gate.ts:54`: đổi thành áp cho **mọi method** trên `/hooks/*`, trừ `OPTIONS`. Test cũ cho POST phải giữ nguyên.
3. `[PK:T1]` URL sai segment → 404, không ghi `raw_events`, không gọi `verify`, không cộng điểm phạt.
4. `[PK:T2]` IP đang trong hộp phạt gửi `GET /hooks/generic/<key>` → bị chặn **trước** body parser, giống hệt POST.

## 3. PK1: `generic` lên console, màn lắng nghe, Svix, "request đầu tiên ✓"

> **Vì sao**
> - **F2:** backend có `generic` từ S8 nhưng console không có. Dev không thấy bên mình dùng thì kết luận hub không hỗ trợ.
> - **F4:** Clerk, Resend và các bên gửi qua Svix dùng `svix-*`. Thuật toán giống hệt Standard Webhooks, chỉ khác tên header, nên **không** thêm scheme mới.
> - **"Request đầu tiên ✓" là thước đo của Admin** ("nối được là được"). Tạo source xong chưa phải là nối được. Chỉ khi request thật đầu tiên vào ACCEPTED mới là nối được.

1. Console, `apps/web/src/app/(admin)/dashboard/sources/page.tsx` (giao diện mới): thêm lựa chọn **"Provider khác"** (`generic`). Chọn nó thì mở form PK7 (§10). Trước khi có PK7, form chỉ có các ô tay: scheme, header, encoding, khoá chống trùng, eventType.
2. `GET /api/v1/sources/:id/inspect`: tách **hàm dùng chung** với `service-resources.controller.ts:422`, không chép. Màn chi tiết source generic có tab **Lắng nghe**, gọi lại mỗi 2s.
3. Tab Lắng nghe có một dòng trạng thái kết nối, lấy từ `raw_events` gần nhất của source:
   - "Chờ request đầu tiên…";
   - "**Đã nhận request đầu tiên ✓**", khi có một ACCEPTED;
   - "Trượt: thiếu header `x-acme-signature`", hiện `diagnose` của mẫu REJECTED gần nhất, chỉ tên header/trường, **không** có giá trị.
4. `swVerify`: không có bộ `webhook-*` thì đọc bộ `svix-*`. Ba header phải **cùng một bộ**, không trộn. `diagnose` báo `missing_header` theo bộ đang có. Nhiều chữ ký cách nhau bằng dấu cách (Svix) → khớp một là đủ, không dừng sớm.
5. `[PK:T3]` fixture Svix verify qua; trộn `webhook-id` với `svix-signature` → false. `[PK:T4]` inspect của console trả đúng khuôn của service API, không có giá trị header hay body. `[PK:T5]` trạng thái kết nối chuyển "chờ → ✓" khi có ACCEPTED đầu tiên.

## 4. PK2: Mở rộng config cho S1 và S2

> **Vì sao**
> - Nghiên cứu §1: `hmac-sha256` hiện chỉ phủ khoảng 60% nhóm S1. Phần còn lại vướng **sha1** (Vercel, Intercom, Trello), **sha512**, **tiền tố** (`sha256=`, `v1=`, `hmac-sha256=`), **thuật toán ghi trong tiền tố** (`method=sig`: Bitbucket, Jira, WebSub), hoặc **khoá phải giải mã trước khi HMAC** (Squarespace hex, Airtable base64, Adyen hex).
> - S2 có thêm basic auth (Chargebee, Pipedrive, Azure DevOps, Postmark) và token ở query.
> - **Vì sao vẫn là config, không phải code:** đây đều là **tham số** của cùng một thuật toán HMAC trên bytes body. Cấm JSONPath, biểu thức, vòng lặp (§15).

1. Scheme `hmac` (giữ `hmac-sha256` là bí danh để tương thích ngược, đọc ra `{algo:"sha256"}`), các trường:
   - `algo`: `sha1 | sha256 | sha512`;
   - `encoding`: `hex | base64`;
   - `prefix`: chuỗi tĩnh ≤ 16 ký tự, **hoặc** `"<algo>="`, nghĩa là thuật toán đọc từ tiền tố, chỉ nhận `algo` trong tập trên;
   - `keyEncoding`: `utf8 | hex | base64`;
   - `header`;
   - `idempotency`.
2. `sha1` chỉ được chọn khi có ghi chú lý do trong mục danh mục (provider quy định). Vẫn so bằng `timingSafeEqual`. CLAUDE.md ghi ngoại lệ có chủ đích (§12).
3. Scheme `static-token` thêm `location`: `header` (mặc định) | `basic` (so cả cặp user:pass) | `query` (tên tham số; giá trị **không** lưu vào `headers`/log, che như header bí mật).
4. `[PK:T6]` ma trận: mỗi tổ hợp `algo × encoding × prefix × keyEncoding` có một vector test cố định. Sửa 1 byte → trượt. `prefix` thuật toán lạ (`md5=`) → trượt, không ném.
5. `[PK:T7]` token ở query không xuất hiện trong `raw_events.headers`, log, `diagnose`.

## 5. PK3: Scheme `signed-template` cho S4

> **Vì sao**
> - S4 có 13 bên (Stripe, Slack, Zoom, Paddle, Calendly, Zendesk, Box, Webflow, Twitch, Recurly, Sanity, SePay HMAC…). Theo nghiên cứu §6.2, cả nhóm chỉ khác nhau ở **dấu phân cách, vị trí timestamp, và chỗ đặt timestamp**.
> - **Chỉ có 3 token, khoá bằng regex:** muốn thêm token phải có ADR kèm fixture của provider thật.
> - **`{body}` bắt buộc đúng một lần:** template không có `{body}` thì chữ ký không phủ body, kẻ xấu giữ chữ ký cũ rồi thay body. Đây là lỗ giả mạo.
> - **Có `{timestamp}` thì bắt buộc kiểm độ lệch:** không kiểm thì request bắt được hôm nay phát lại được mãi.
> - **Casso không vào đây:** Casso ký trên JSON đã sắp xếp khoá, không trên bytes gốc. Đi bằng `unverified` (§7).

```jsonc
{
  "scheme": "signed-template",
  "template": "v0:{timestamp}:{body}",     // ^([^{}]|\{(timestamp|body|id)\}){1,128}$, {body} đúng 1 lần
  "algo": "sha256", "encoding": "hex", "keyEncoding": "utf8",
  "signature": { "header": "x-slack-signature", "prefix": "v0=" },
  //   hoặc khoá=giá trị trong MỘT header (Stripe, Paddle): { "header": "stripe-signature", "kv": { "sep": ",", "sig": "v1", "timestamp": "t" } }
  "timestampHeader": "x-slack-request-timestamp", // bỏ khi timestamp nằm trong kv
  "idHeader": null,                              // bắt buộc nếu template có {id}
  "toleranceSec": 300,                           // 5..900, bắt buộc khi có {timestamp}
  "idempotency": { "header": "…" } | { "field": "…" },
  "eventType": "slack.event"
}
```

- `kv.sep` chỉ là `;` hoặc `,`. Nhiều giá trị `sig` (xoay khoá) → khớp một là đủ, không dừng sớm.
- HMAC tính trên `Buffer.concat` các phần, trong đó `{body}` là **bytes gốc**. So bằng `timingSafeCompare`.
- `toleranceSec` cho xuống 5 vì Paddle SDK chỉ chấp nhận lệch 5s (nghiên cứu §1.5). Mặc định 300.
- `[PK:T8]` thiếu `{body}`, `{body}` hai lần, token lạ, có `{timestamp}` mà không có `toleranceSec` → 422, có đúng tên trường. `[PK:T9]` fixture Slack, Stripe, Paddle, Zendesk verify qua; lệch `toleranceSec + 1` giây → false; phát lại sau 10 phút → false.

## 6. PK4: Bắt tay khai báo được (S7), GET cho bắt tay, ack theo cấu hình

> **Vì sao**
> - **Lỗ lớn nhất của bản 1:** Slack, Meta, Dropbox, Graph, Zoom, Twitch… đòi bắt tay **lúc dán URL**. Hub trả 401 thì provider **không cho lưu URL**, dev kẹt ngay bước một, chưa kịp tới chữ ký.
> - **Nghiên cứu §1: có 6 biến thể.** 5 biến thể khai báo được. Biến thể "hub tự gọi ra ngoài" (SNS `SubscribeURL`) **không** làm tự động: hub gọi một URL lấy từ body request là SSRF. Console hiện URL đó để dev tự bấm (§6.2).
> - **GET chỉ để bắt tay, không để nhận sự kiện:** VNPay là lý do duy nhất của bản 1 để nhận sự kiện qua GET, mà VNPay đã ra khỏi phạm vi (S10). Mở GET rộng hơn mức cần là mở bề mặt tấn công vô ích.
> - **Ack theo cấu hình:** MoMo đòi 204. KiotViet **ngừng gửi ngay** khi nhận 4xx. Haravan và Shopify xoá subscription sau 19 và 8 lần lỗi. Hub phải trả được mã khác 401 khi sai chữ ký, nhưng **không bao giờ là 2xx** (bảo đảm BB-3 và EG2, xem mục 3 bên dưới).
> - **`buildAck(result, ctx)`:** cùng lý do `verify` đã nhận `ctx` ở S8.

### 6.1. Khai báo

```jsonc
"handshake": {
  "kind": "query-echo",       // GET ?<param>=X -> 200 text/plain X (Meta hub.challenge, Dropbox challenge, WebSub hub.challenge)
  "param": "hub.challenge",
  "verifyTokenParam": "hub.verify_token"   // tuỳ chọn: so timingSafeEqual với secret thứ hai của source trước khi echo
}
// "body-echo":   POST, body.<when.field> == when.equals -> 200 JSON/text <echo.field> (Slack url_verification, monday)
// "header-echo": POST có header <name> -> 200, trả lại đúng header đó (Asana X-Hook-Secret, Okta)
// "hmac-echo":   POST body.<when> -> 200 {"plainToken":…, "encryptedToken": HMAC(secret, plainToken)} (Zoom endpoint.url_validation)
// "manual-url":  POST body.Type == SubscriptionConfirmation -> lưu mẫu, console hiện SubscribeURL cho dev tự bấm (AWS SNS). Hub KHÔNG gọi ra.
```

- Request bắt tay **không** tạo event, không outbox, không SET NX, không cộng `trace.bytes` vào ACCEPTED. Ghi một dòng `raw_events` REJECTED với lý do `handshake`, theo đường `storeRejected` sẵn có (F8), để tab Lắng nghe hiện "Đã bắt tay với provider ✓".
- `when` của `body-echo` và `hmac-echo` là **một** cặp trường cấp một = giá trị hằng. Không biểu thức.
- **Asana và Notion gửi secret trong request đầu tiên** (nghiên cứu §1). `header-echo` có tuỳ chọn `adoptSecret: true`: lúc source đang ở chế độ thu (§9), secret nhận được lưu thành `SourceSecret` v1 (mã hoá như mọi secret, audit `source.secret_adopted`), **chỉ lần đầu**, rồi tắt. Notion gửi token trong body và đòi dev dán lại vào UI của Notion: console hiện **một lần**, như khi hub sinh token.

### 6.2. GET

1. `ingest.controller.ts`: thêm `@Get(':provider/:sourceKey')`, gọi cùng `handleWebhook`. `RawWebhookRequest` thêm `method`.
2. `ProviderAdapter.acceptsMethod?(method, ctx)`: không cài thì chỉ nhận POST. `GenericAdapter` nhận GET **chỉ khi** `handshake.kind === "query-echo"` **và** request mang đúng `param`. Ngoài trường hợp đó → **405** `{error:"method_not_allowed"}`, không ghi DB, không phạt.
3. GET đi qua mọi tầng chắn như POST (PK0 đã sửa F11): nginx, EG2, QT3, EG3. Trần query 8KB.

### 6.3. Ack theo cấu hình

```jsonc
"ack": {
  "successStatus": 200,        // 200 | 202 | 204
  "rejectStatus": 401          // 401 (mặc định) | 403 | 503. KHÔNG có 2xx
}
```

- `buildAck(result, ctx?)`, `rejectAck(…, ctx?)`. Adapter cũ bỏ qua tham số. Controller: `204` thì `res.status(204).end()`; ack có `contentType` thì `res.type(…)`.
- `rejectStatus: 503` cho KiotViet và các bên tự tắt khi gặp 4xx: provider sẽ gửi lại và không tắt webhook. Request vẫn đi đường REJECTED và **vẫn gọi `recordBadSignature`**. Mã HTTP đổi, còn luật phạt thì không.
- **Cấm 2xx khi từ chối.** Bản 1 cho VNPay trả 200 khi sai chữ ký. Bản 2 bỏ: một mã 2xx cho request sai chữ ký là một lối đi vòng qua EG2, và VNPay đã ra khỏi phạm vi.
- `[PK:T10]` 5 biến thể bắt tay, mỗi biến thể một fixture: trả đúng khuôn, 0 outbox, 0 SET NX, có dòng REJECTED `handshake`. `manual-url`: không có request ra ngoài nào (spy `fetch`/http agent).
- `[PK:T11]` GET vào source không có `query-echo` → 405, 0 ghi. GET `query-echo` sai `verify_token` → `rejectStatus`, gọi `recordBadSignature`.
- `[PK:T12]` `rejectStatus: 503` + chữ ký sai → 503, REJECTED, điểm phạt tăng. Cấu hình `rejectStatus: 200` → 422 lúc lưu config.
- `[PK:T13]` `adoptSecret` chỉ nhận lần đầu: request thứ hai mang secret khác thì không đổi `SourceSecret`, có audit.

## 7. PK5: Chế độ "đích tự kiểm" (scheme `unverified`) cho S5, S6, S8, S9

> **Vì sao**
> - **Admin đã đồng ý (2026-10-13).** 26/91 bên (MoMo, ZaloPay, Casso, Twilio, Square, PayPal, SendGrid, AWS SNS, GHN, GHTK, Docker Hub…) ký theo kiểu hub không verify được bằng config: ghép trường, ký cả URL, khoá bất đối xứng, hoặc không ký gì. Viết code cho từng bên là thứ bản 1 định làm ở PK5 (`PresetHandler`). Phòng đã phản biện: cách đó đẻ ra **interface thứ hai giống hệt `ProviderAdapter`** và phá luận điểm "thêm provider = một adapter".
> - **Làm như Hookdeck:** hub nhận dựa vào **URL bí mật** (`sourceKey`), giữ nguyên bytes, rồi giao đi **kèm header chữ ký gốc và URL gốc**. Shop tự verify bằng SDK của provider. Một cơ chế phủ cả bốn nhóm, lõi không phải biết gì.
> - **Vì sao cần bốn khoá (Grumbal):** đây là chỗ **duy nhất** hub nhận sự kiện chưa xác thực. Lộ `sourceKey` (log, screenshot) là ai cũng bơm được. Bốn khoá bảo đảm sự kiện chưa xác thực **không bao giờ trông như sự kiện đã xác thực**, và không tự chảy tới đích chưa đồng ý nhận.
> - **BB-3 không đổi:** vẫn 2xx sau COMMIT.

### 7.1. Bốn khoá (thiếu một khoá là bug, không phải đánh đổi)

1. **Project tự bật:** `projects.allow_unverified_sources boolean NOT NULL DEFAULT false`. Owner hoặc operator bật, có audit. Tắt cờ thì source `unverified` của project trả `rejectStatus` (`source_unverified_disabled`), không ghi.
2. **Đánh dấu:** `events.verified boolean NOT NULL DEFAULT true`. Source `unverified` ghi `false`. Envelope giao đi có `"verified": false`. Console hiện nhãn "Chưa xác thực" ở mọi nơi có event.
3. **Không giả được kiểu chuẩn:** `eventType` của source `unverified` **không được** thuộc namespace của `docs/EVENT-CATALOG.md` (`payment.*`, `repo.*`, cùng mọi namespace thêm sau). Kiểm ở **cả hai chỗ**: lúc lưu config (422) và trong worker normalize (lỗi normalize vĩnh viễn). Không bao giờ có `payment.received` chưa xác thực.
4. **Đích tự đồng ý:** subscription thêm `acceptUnverified boolean DEFAULT false`. Router chỉ tạo delivery cho event `verified=false` tới subscription có cờ này. Ngoài ra: không tạo delivery, metric `hub_unverified_skipped_total`.

### 7.2. Đường truyền

```jsonc
{
  "scheme": "unverified",
  "forwardHeaders": ["x-twilio-signature"],   // ≤ 10 tên, chữ thường, không được là authorization/cookie/x-hub-*; giá trị gửi nguyên văn
  "idempotency": { "header": "…" } | { "field": "…" },   // thiếu -> bodyHashKey(rawBody). KHÔNG ngẫu nhiên
  "eventType": "momo.ipn",
  "ack": { "successStatus": 204 }
}
```

- `event.data` của source `unverified` có khuôn cố định: `{ "raw": "<base64 bytes gốc>", "contentType": "…", "headers": { <forwardHeaders> }, "url": "<URL công khai đầy đủ>", "method": "POST" }`. `url` dựng từ env **`PUBLIC_HOOKS_BASE_URL`** + path + query gốc, **không** dựng từ `Host` (giả được). Thiếu env thì `url: null` kèm `diagnose` `public_url_missing`. Nhóm S6 (Twilio, Square, Trello, HubSpot v3) cần biến này để shop verify được.
- Hub vẫn ký lại bằng Standard Webhooks khi giao. Shop kiểm **hai lớp**: chữ ký hub (đến từ hub) và chữ ký gốc (đến từ provider, qua `data.headers` + `data.raw` + `data.url`).
- `@hub/sdk`: thêm `unwrapUnverified(event)` → `{ rawBody: Buffer, headers, url }` để đưa thẳng vào SDK của provider. Không verify thay.
- Ngân sách Redis: không thêm lệnh nào so với đường generic hiện tại. `redis-budget.spec.ts` thêm ca `unverified`.
- QT: `raw` base64 làm `events.data` to khoảng 1,33 lần. `measureStorage` đếm như mọi event, không cần đổi.

### 7.3. Test

- `[PK:T14]` cờ project tắt → `rejectStatus`, 0 ghi. Bật → ACCEPTED, `events.verified=false`.
- `[PK:T15]` `eventType: "payment.received"` với `unverified` → 422 khi lưu. Ép qua DB (fixture) → worker normalize ném lỗi vĩnh viễn, 0 delivery.
- `[PK:T16]` subscription không có `acceptUnverified` → 0 delivery cho event chưa xác thực, metric tăng; có cờ → giao, envelope `verified:false`.
- `[PK:T17]` `data.raw` giải base64 ra **đúng từng byte** body gốc (kể cả form `a+b%20c`). `data.url` không đổi khi gửi kèm `Host: evil.com`.
- `[PK:T18]` vòng tròn đầy đủ trên stack LOCAL: fixture Twilio (dựng) qua `unverified` → endpoint test dùng `unwrapUnverified` + thuật toán Twilio verify **qua**; sửa 1 byte `raw` → trượt.

## 8. Danh mục, `identify()` và S10 (trục phụ, nền cho PK7)

> **Vì sao**
> - **Admin:** dev thấy tên provider thì yên tâm. Danh mục phải lớn. Đã có 91 bên nghiên cứu, mỗi bên kèm nguồn.
> - **Danh mục là dữ liệu, không phải code:** thêm một bên không sửa lõi. Đây là luận điểm "provider thứ 100".
> - **`identify()` chạy trong trình duyệt (Amelia):** hàm thuần trên dữ liệu thì không cần server. Mẫu dev dán vào (có thể chứa secret, PII thật) **không bao giờ rời máy dev**. Bản 1 gửi 64KB lên server rồi đặt luật "đừng log". Bản 2 không có gì để log.
> - **Không bịa tên, nhưng đọc bằng chứng:** không khớp danh mục thì vẫn trích tên từ header (`x-acme-signature` → "Acme"), User-Agent, và tên miền trong body. Hiện kèm căn cứ.

### 8.1. Khuôn và vị trí

```
libs/providers/src/catalog/
  entries/<id>.json
  fixtures/<id>/*.http           # dòng đầu, header, dòng trống, body. Dòng đầu file: "# origin: official|constructed; source: <url>"
  catalog.ts                     # nạp + kiểm toàn bộ lúc khởi động (sai -> app không lên) + build ra JSON cho web
  identify.ts                    # hàm thuần, KHÔNG import Node API (chạy được ở trình duyệt)
```

```jsonc
{
  "id": "shopify", "name": "Shopify", "aliases": ["shopify"], "group": null,
  "fingerprint": {
    "method": "POST",
    "headers": { "required": ["x-shopify-hmac-sha256"], "optional": ["x-shopify-topic", "x-shopify-shop-domain"] },
    "userAgent": null,                       // regex ngắn, vd "^GitHub-Hookshot/"
    "body":  { "format": "json-object", "required": [], "optional": [] },   // json-object|json-array|jsonl|form|xml|jwt|empty
    "query": { "required": [], "optional": [] }
  },
  "handler": { "config": { /* scheme PK2/PK3/PK5 + handshake/ack PK4 */ } },
  //  hoặc { "native": "github" }  -> console chuyển sang luồng provider đó
  //  hoặc { "unsupported": { "reason": "…", "workaround": "…" } }   -> S10 (§8.3)
  "fields": [ { "name": "secret", "label": "API secret key (Shopify admin → Notifications → Webhooks)", "secret": true } ],
  "secretSource": "provider",                // provider | hub | first-request (adoptSecret, §6.1)
  "docs": "https://…", "docsVersion": "…", "confidence": "cao"
}
```

Kiểm lúc nạp:
- `id` khớp `^[a-z0-9-]{2,32}$`;
- `handler.config` qua `validateGenericConfig`; `handler.native` có trong `ProviderRegistry`;
- **mỗi mục có ≥ 1 fixture**;
- mục `confidence: "thấp"` **không** được nạp. Đưa vào `entries-pending/`, không build.

### 8.2. `identify(input)`

```ts
identify(input: { name?: string; sample?: string; headerName?: string; captured?: CapturedSample }): {
  matches: Array<{ id; name; score; matched: string[]; handlerKind: 'config'|'native'|'unsupported' }>;
  guess: { name: string; evidence: string[] } | null;      // khi matches rỗng: tên đoán từ bằng chứng
  shape: { scheme?: string; signatureHeader?: string; candidateHeaders: string[] } | null;
}
```

- **Parse lỏng mọi khuôn ở F15.** Không dựa vào content-type. Parse lỗi → kết quả rỗng kèm lý do, không ném.
- **Luật khớp:** đủ mọi `required` (header, UA, body, query) thì là ứng viên. `score = (required + optional khớp) / tổng`. Cùng `group` mà cùng điểm → trả cả nhóm (Svix: Clerk, Resend…). Không chọn bừa.
- **Tên (①):** alias chính xác hoặc tiền tố (≥ 3 ký tự) sau khi bỏ dấu. Không fuzzy.
- **`guess`:** tiền tố của header chữ ký (bỏ `x-`, bỏ đuôi `-signature|-hmac-sha256|-token|-webhook-…`), User-Agent (phần trước `/`), tên miền trong các trường URL cấp một. Header chung (`x-signature`, `x-webhook-signature`, `authorization`, `signature`; nghiên cứu §3) **không** sinh tên.
- **`shape`:** suy scheme từ header, theo `CANDIDATE_HEADER_RE` sẵn có: có `*-timestamp` → `signed-template`; có `webhook-*`/`svix-*` → `standard-webhooks`; không có header chữ ký nào → gợi ý `unverified`; còn lại → `hmac`.
- Endpoint: `GET /api/v1/catalog` trả danh mục đã build (không có fixture). ①②③ chạy **ở client**. Chỉ ④ (§9) gọi `POST /api/v1/sources/:id/identify`: server đọc mẫu của đúng tenant qua `TenantScopedRepository` rồi chạy **cùng hàm** `identify`.

### 8.3. S10: "nhận ra, chưa xử lý"

VNPay, ZaloPay, OnePay, Discord và Adobe Commerce **đòi bên nhận trả lời nghiệp vụ đồng bộ**: xác nhận đơn tồn tại, đúng số tiền (`RspCode`, `return_code`), hoặc trả interaction response. Hub theo BB-1 không biết đơn hàng. Trả "00 Confirm Success" thay shop tức là **nói dối provider**. Mục danh mục của các bên này là `unsupported`, kèm:
- `reason`: một câu nêu đúng lý do trên;
- `workaround`: "Để shop nhận IPN trực tiếp, xác nhận đơn, rồi đẩy `payment.received` vào hub qua `POST /v1/p/:project/publish`."

Console hiện tên provider, lý do và cách đi vòng. **Không** có nút tạo source.

### 8.4. Nạp danh mục từ nghiên cứu

- Nguồn: `research/provider-fingerprints.json`. **Mọi chi tiết vào entry phải có nguồn trong `sources`.** Chi tiết ghi "chưa xác minh" thì bỏ trống hoặc để mục ở `entries-pending/`.
- **Fixture:**
  - **official**: mẫu chính thức có header (9 bên: ghtk, github, gitlab, circleci, microsoft-graph, aws-sns, twitch, google-drive…) hoặc bắt từ "Send test" thật;
  - **constructed**: body mẫu chính thức + header theo tên trong tài liệu + chữ ký tính bằng secret test.

  Dòng đầu file fixture **bắt buộc** ghi `origin`. Không có nguồn cho body thì không được dựng.
- **Đính chính so với bản 1:**
  - `gitlab`: mặc định là `standard-webhooks` (signing token), `static-token` là phương án phụ; tách khỏi nhóm `webhook-*` bằng `x-gitlab-event`;
  - `sepay`: `native` (xem §14, việc tách riêng);
  - `casso`: `unverified` (ký trên JSON sắp xếp lại);
  - `vnpay`: `unsupported`.
- Mục tiêu nạp: **mọi mục `cao` + `trung bình` có đủ thông tin** (khoảng 80/91). Mục nào bị loại thì ghi lý do vào §16.

### 8.5. Test

- `[PK:T19]` **nghiệm thu nhận tên, chạy trên toàn danh mục:** với **mọi** fixture của **mọi** mục, `identify({sample})` trả mục đó đứng đầu (hoặc cùng nhóm `group`). Thêm mục mới mà làm mục khác đổi hạng đầu → đỏ. Báo cáo in hai cột `official` và `constructed` (§13).
- `[PK:T20]` tên: "mom", "MoMo", "ví momo" → momo; "zzz" → rỗng. Header: `x-shopify-hmac-sha256` → shopify.
- `[PK:T21]` provider lạ (`acme`, ngoài danh mục): `matches: []`, `guess.name = "Acme"` kèm bằng chứng header và UA, `shape.signatureHeader = "x-acme-signature"`. Chỉ có `x-signature` → `guess = null`.
- `[PK:T22]` `identify.ts` không import `fs`, `crypto` của Node, hay `process` (grep), và chạy được trong jsdom.
- `[PK:T23]` mỗi khuôn body ở F15 có một fixture parse được.

## 9. PK6: Chế độ thu: source chưa cấu hình trả 200, kích hoạt bằng verify lại

> **Vì sao**
> - **Luồng ④:** có bên không có mẫu kèm header (82/91), có bên gửi secret trong request đầu tiên (Asana, Notion). Cách chắc nhất là để provider bắn request thật, và muốn vậy thì phải có URL **trước** cấu hình.
> - **Trả 200 (Admin):** KiotViet ngừng gửi khi gặp 4xx. Nhiều bên coi 401 ở nút "Send test" là thất bại và không cho lưu URL.
> - **Không thêm status mới (F12, F13):** bản 1 thêm `CAPTURED`, nên dòng thu được nằm ngoài mọi đường dọn của QT và retention (bẫy 507), lại vướng unique `idempotency_key`. Bản 2 dùng **chính đường `REJECTED`**, chỉ thêm lý do `not_configured`. Retention, dọn QT (`junk`), đếm dung lượng đều chạy sẵn.
> - **Vì sao vẫn giữ body đầy đủ và header gốc mã hoá (Amelia):** request thu được có thể là **giao dịch thật** (Grumbal: dev dán URL production). Hub trả 200 thì provider không gửi lại. Nếu hub chỉ giữ mẫu 4KB đã che thì sự kiện đó **mất**, tức là BB-3 bị phá qua một đường vòng. Giữ đủ bytes và header gốc thì lúc kích hoạt hub verify bù được và đưa vào luồng được.
> - **Vì sao có hạn và trần (Winston):** source chưa cấu hình mà nhận vô hạn là một cái xô mở, ăn hạn mức dung lượng của project.

### 9.1. Schema (một migration)

```
sources.capture_until   timestamptz NULL   -- khác NULL = đang ở chế độ thu
sources.capture_count   int NOT NULL DEFAULT 0
raw_events.captured_headers_enc  bytea NULL   -- header GỐC, AES-GCM (master key); chỉ dòng thu được; xoá khi kích hoạt / hết hạn
projects.allow_unverified_sources  (PK5, có thể chung migration nếu PK5 làm trước)
```

Dòng thu được: `status = 'REJECTED'`, `idempotency_key = 'captured_' || correlationId` (cùng dạng với `rejected_…`, F8, không đụng unique), meta lý do `not_configured`, `body_raw` **đầy đủ** (≤ 1MB, không cắt 4KB), `headers` là bản **đã che**.

### 9.2. Tạo, ingest, giới hạn

- `POST /api/v1/sources { provider: "generic", name, mode: "capture" }`: không cần `secret` hay `verificationConfig`. `capture_until = now + CAPTURE_WINDOW_MIN`. Vẫn qua `assertSourceLimit` và audit.
- Trong ingest: **sau** QT3 (khoá ghi khi đầy) và hộp phạt theo cặp, **trước** verify:

```
if source.captureUntil !== null:                       // thuộc tính của SOURCE, không phải provider
   handshake khai trong form (§6.1) khớp -> xử lý bắt tay như PK4 (adoptSecret nếu có)
   trong MỘT transaction:
     UPDATE sources SET capture_count = capture_count + 1
       WHERE id=$1 AND capture_until > now() AND capture_count < CAPTURE_MAX_REQUESTS RETURNING id
     không có dòng -> ROLLBACK -> 503 + Retry-After (giây tới capture_until, hoặc 60 nếu đã hết hạn), KHÔNG ghi
     INSERT raw_events (REJECTED, not_configured, body đầy đủ, headers đã che, captured_headers_enc)
   COMMIT -> 200 {"ok":true,"captured":true}
```

- **Vượt trần hoặc hết hạn thì 503, không phải 200 và không phải 401.** Trả 200 mà không COMMIT là ACK sớm (BB-3). 401 làm KiotViet ngừng gửi. 503 khiến provider gửi lại sau, và nghiên cứu cho thấy không bên nào tự tắt vì 5xx ngay lần đầu.
- **0 lệnh Redis** (trần đếm bằng câu `UPDATE` có điều kiện, an toàn nhiều instance). Không outbox, không SET NX. Worker không bao giờ thấy dòng này.
- `trace.bytes` và EG4 ghi outcome `REJECTED` (đã có trong `TrafficOutcome`) cùng số byte thật, nên QT đo đúng.
- **Không** gọi `recordBadSignature` (chưa có cấu hình thì không có "sai chữ ký"). **Có** qua EG3 rate limit như mọi request.
- Console: **"Lắng nghe lại"** đặt lại `capture_until`, `capture_count = 0` (audit). Banner đỏ cố định: *"Đang thu: request được giữ lại nhưng CHƯA vào luồng. Đừng dùng URL này cho giao dịch thật trước khi kích hoạt."*

### 9.3. Kích hoạt

`POST /api/v1/sources/:id/activate { verificationConfig, secret?, promoteIds?: string[], acknowledgeUnverified?: boolean }`

1. Validate như tạo source thường. Riêng scheme `unverified` thì cần cờ project bật (§7.1).
2. Nạp các dòng `not_configured` của source (đúng tenant). Giải mã header gốc, dựng `RawWebhookRequest`, chạy `adapter.verify`. Kết quả từng dòng là `verified | failed | n/a` (`unverified` luôn là `n/a`).
3. Không dòng nào `verified` (với scheme có verify) → 422 `activation_unverified`, kèm `diagnose` từng dòng (chỉ tên). Ngoại lệ: không có dòng nào **và** `acknowledgeUnverified: true`.
4. **Một transaction:**
   - `UPDATE sources SET verification_config, capture_until = NULL … WHERE id=$1 AND capture_until IS NOT NULL` (0 dòng → 409);
   - `SourceSecret` v1 (hoặc giữ secret đã `adoptSecret`);
   - xoá `captured_headers_enc` của mọi dòng;
   - audit `source.activate`.
5. **Đưa vào luồng (`promoteIds`)** chỉ nhận id có kết quả `verified` (hoặc `n/a` với `unverified`). Mỗi id, theo `received_at` tăng dần, đi qua **chính `persistAccepted`** (không chép logic): INSERT dòng ACCEPTED với khoá do adapter trích, outbox, SET NX sau COMMIT, rồi **xoá dòng `captured_…` trong cùng transaction**, nên không nhân đôi byte (F13). Trùng khoá thì bỏ qua, vẫn xoá dòng thu. Trả `{ promoted, skipped }`.
6. Console hiện danh sách dòng thu kèm ✓/✗ verify. **Mặc định không chọn dòng nào** (dữ liệu "Send test" thường là đơn giả). Có dòng `verified` chưa đưa vào luồng thì hiện banner *"N request đã xác thực chưa vào luồng. Nếu có giao dịch thật, hãy chọn."*
7. Dọn: job cleanup của `hub-worker` xoá `captured_headers_enc` của source đã hết hạn thu quá 1 giờ (Redis lock như cleanup hiện tại). Body đi theo retention `REJECTED` sẵn có.

### 9.4. Test

- `[PK:T24]` 10 request đầu → 200 + 10 dòng `not_configured`. Request 11 → 503 có `Retry-After`. Hết hạn → 503, không ghi. Hai instance bắn song song 30 request → đúng 10 dòng.
- `[PK:T25]` 200 chỉ sau COMMIT: giả lỗi INSERT → 5xx, không 200.
- `[PK:T26]` `captured_headers_enc` không đọc được bằng mắt; `headers` đã che; sau kích hoạt cột này là NULL ở mọi dòng.
- `[PK:T27]` kích hoạt secret sai → 422 kèm chẩn đoán, source vẫn ở chế độ thu. Secret đúng → active. Hai lần bấm song song → một 200, một 409.
- `[PK:T28]` `promoteIds` gồm 3 dòng (2 verify, 1 trùng khoá) → 1 sự kiện vào luồng, 1 skipped, đi qua `persistAccepted` (spy). Sau đó không còn dòng `captured_` nào của 3 id. Tổng `octet_length(body_raw)` của source không tăng.
- `[PK:T29]` QT: dòng thu nằm trong lệnh dọn `junk` và retention `REJECTED` (test DB thật).
- `[PK:T30]` ngân sách Redis: đường thu 0 lệnh; activate (không promote) 0 lệnh.
- `[PK:T31]` RLS: tenant B gọi activate/identify với id của tenant A → 404.

## 10. PK7: Form "Provider khác" ở console

> **Vì sao**
> - Đây là chỗ mong muốn của Admin hiện ra. Bốn cách vào, một ô kết quả, một form điền sẵn.
> - **Ô kết quả có 4 trạng thái, không bao giờ trống trơn (Sally):** "không nhận ra" không được là ngõ cụt.
> - **Kết quả là "Trông như", không phải "Đây là":** mẫu dán vào ai cũng bịa được.

```
┌─ Provider khác ───────────────────────────────────────────────┐
│ ① Tên provider:   [ mom|          ]  ↳ MoMo                    │
│ ② Dán webhook mẫu (header + body, hoặc chỉ body): [ …… ]      │
│ ③ Header chữ ký họ gửi: [ x-shopify-hmac-sha256 ]              │
│ ④ Chưa biết gì? Dán URL này vào provider rồi bấm Send test     │
│    https://hub…/hooks/generic/k7Qx…   ● đang chờ…   (§9)       │
├───────────────────────────────────────────────────────────────┤
│ Trông như: Shopify (khớp x-shopify-hmac-sha256, x-shopify-topic)│
│ API secret key: [____]                         [Tạo nguồn]    │
│ Sau khi tạo: ● Chờ request đầu tiên… → ✓ Đã nhận               │
└───────────────────────────────────────────────────────────────┘
```

| Kết quả | Ô hiện |
|---|---|
| Khớp, `config` | "Trông như **X**" + form dựng từ `fields` → `POST /api/v1/sources` (`generic` + `verificationConfig` của mục) |
| Khớp, `native` | "Đây là **GitHub**, hub có kết nối riêng" + nút mở luồng sẵn có |
| Khớp, `unsupported` | Tên + `reason` + `workaround` (§8.3), không có nút tạo |
| Không khớp | "Chưa có trong danh mục. **Có thể là Acme** (đoán từ …)" hoặc "Không đoán được tên" + `shape` + form tay điền sẵn + nút **"Đề xuất thêm vào danh mục"** (chỉ mở link tạo issue với tên và link tài liệu do dev gõ; **không gửi mẫu đi đâu**) |

- ①③ debounce 400ms; ② gọi khi bấm. **Tất cả chạy ở client.** Chưa tạo source nào.
- `secretSource: hub` → hub sinh token, hiện **một lần**. `first-request` → tạo ở chế độ thu với `handshake.adoptSecret`.
- Mục cần `unverified` mà cờ project đang tắt → hiện giải thích và nút đi tới cài đặt project (owner), không tạo được.
- Sau "Tạo nguồn" luôn chuyển sang tab Lắng nghe (PK1), chờ ✓.
- `[PK:T32]` (component hoặc e2e) dán fixture Shopify → "Trông như Shopify" + đúng ô secret. Dán fixture VNPay → lý do + cách đi vòng, không có nút tạo. Dán `acme` → "Có thể là Acme" + form tay có `header = x-acme-signature`. Mạng tab DevTools: ①②③ **không** gửi request nào chứa mẫu (spy `fetch`).

## 11. PK8: Giấy khớp code

1. `docs/ARCHITECTURE.md`:
   - §3.1 thêm bước PK0, nhánh bắt tay (PK4), nhánh thu (PK6, vị trí ở §9.2);
   - mục GenericAdapter thêm `hmac` mở rộng, `signed-template`, `unverified`, `handshake`, `ack`;
   - thêm mục "Danh mục provider + nhận diện chạy ở client";
   - §15 Q&A thêm "provider thứ 100", "vì sao không nhận VNPay", "sự kiện chưa xác thực đi đâu".
2. `docs/EVENT-CATALOG.md`: namespace chuẩn là danh sách đóng. Source `unverified` cấm dùng namespace chuẩn. Ghi khuôn `data` của event `verified:false`.
3. `docs/ERRORS.md`: thêm `method_not_allowed`, `source_not_configured`, `activation_unverified`, `source_unverified_disabled`.
4. `docs/DEPLOYMENT.md`: env mới (§12).
5. `docs/FOR-EXAMINERS.md`: bậc thang **dữ liệu → cấu hình → đích tự kiểm → không nối (S10, có lý do)**, kèm số liệu nghiệm thu (§13).

## 12. CLAUDE.md, ADR, env

**CLAUDE.md, "Quy tắc khi code"** (PK8 sửa):
- *"Thêm provider có khuôn sẵn = một mục danh mục JSON + fixture. Khuôn ký mới = tham số config, hoặc `unverified` (đích tự kiểm). Không sửa ingest/worker/DB. Không có interface xử lý thứ hai bên cạnh `ProviderAdapter`."*
- *"Sự kiện `verified:false` không bao giờ mang kiểu chuẩn và chỉ tới đích đã đồng ý."*
- Mục so chữ ký: SHA1 là ngoại lệ có chủ đích do provider quy định, vẫn so bằng `timingSafeEqual`.

| ADR | Story | Tiêu đề |
|---|---|---|
| 201 | PK0 | Segment `:provider` phải bằng `source.provider`, lệch → 404 không phạt; cổng phạt áp cho mọi method |
| 202 | PK1 | `standard-webhooks` nhận bộ `svix-*` (không trộn bộ); "request đầu tiên ✓" là thước đo kết nối |
| 203 | PK2 | `hmac` mở rộng thành tham số (algo, prefix, keyEncoding); không biểu thức |
| 204 | PK3 | `signed-template`: 3 token, `{body}` đúng một lần, `{timestamp}` kéo theo cửa sổ bắt buộc |
| 205 | PK4 | Bắt tay khai báo được (5 kiểu); hub không tự gọi URL lấy từ request (SSRF); GET chỉ cho bắt tay; `rejectStatus` không bao giờ là 2xx |
| 206 | PK5 | Đích tự kiểm: bốn khoá; thay cho `PresetHandler` của bản 1 (không có interface thứ hai) |
| 207 | PK5/§8.3 | S10 không nối: hub không trả lời nghiệp vụ thay shop (BB-1) |
| 208 | §8 | Danh mục là dữ liệu; `identify` chạy ở client; không bịa tên, `guess` phải kèm bằng chứng |
| 209 | PK6 | Chế độ thu dùng đường REJECTED (không status mới); 200 sau COMMIT, 503 khi vượt; kích hoạt khi verify bù khớp; promote đổi dòng, không nhân đôi |

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `PUBLIC_HOOKS_BASE_URL` | — | URL công khai của `/hooks` (sau tunnel/Render). Không có thì `data.url = null` + `diagnose` |
| `CAPTURE_WINDOW_MIN` | 15 | Kẹp 5..60 |
| `CAPTURE_MAX_REQUESTS` | 10 | Kẹp 1..20 |

## 13. Nghiệm thu của review (Admin yêu cầu chạy trên toàn danh mục)

Review sau khi dev xong chạy **hai bài trên mọi mục danh mục**, không chọn mẫu, rồi ghi vào `REVIEW-PK-NGHIEM-THU.md`:

| Bài | Cách làm | Đạt khi |
|---|---|---|
| **A. Nhận tên** (`[PK:T19]`) | Mọi fixture → `identify()` | Đúng mục (hoặc đúng nhóm `group`) đứng đầu |
| **B. Nối được** | Stack LOCAL (hubv). Mọi mục `config`/`unverified`: tạo source theo `handler` của mục, ký lại fixture bằng secret test, bắn vào ingest thật. Mục có `handshake`: chạy bắt tay trước | Bắt tay đúng khuôn; request vào **ACCEPTED**; sửa 1 byte → REJECTED (với scheme có verify). `unverified`: event `verified:false` tới được endpoint test đã bật `acceptUnverified` |

Báo cáo in:
- **Bài A tách hai cột:** `official` và `constructed`, dạng "X/N". Không gộp.
- **Bài B theo hình dạng:** S1, S2, S3, S4, S7, `unverified`, mỗi dòng "X/N".
- Danh sách **từng mục trượt** kèm lý do. S10 và các mục `entries-pending/` liệt kê riêng, không tính vào mẫu số, có lý do từng mục.
- Ước tính: N ≈ 80 mục đã nạp. Không làm tròn, không bỏ mục trượt ra khỏi mẫu số.

Hai bài là **cổng merge** của PK7/PK8. Bài A đỏ thì không merge. Bài B có mục trượt thì hoặc sửa, hoặc chuyển mục đó về `entries-pending/` kèm lý do (cần phòng duyệt).

## 14. Việc tách riêng (không thuộc PK, phòng đề xuất)

- **SePay HMAC (native):** tài liệu SePay nay có `X-SePay-Signature: sha256=<hex>` trên `{ts}.{raw_body}` (nghiên cứu §1.2), còn adapter chỉ nhận `Authorization: Apikey`. Kiểm lại tài liệu rồi thêm nhánh S4 vào adapter native. Spec nhỏ riêng, ADR riêng.

## 15. Cố tình không làm

- **`PresetHandler` / code riêng cho từng provider dưới `generic`** (bản 1, PK5). Thay bằng `unverified`. Bên nào sau này cần verify **ở hub** thì viết `ProviderAdapter` native như GitHub/Stripe.
- **Nhận sự kiện qua GET** (VNPay). GET chỉ để bắt tay.
- **Trả lời nghiệp vụ thay shop** (S10).
- **Hub tự gọi URL lấy từ request** (SNS `SubscribeURL`): SSRF.
- **2xx cho request sai chữ ký**, kể cả khi provider đòi.
- **JSONPath, biểu thức, vòng lặp trong config.**
- **Fuzzy matching tên.** Không gửi mẫu dán vào lên server (①②③). Không tự thêm mục danh mục từ request người dùng.
- **Kích hoạt chỉ dựa trên nhận diện.** Không tự đưa request thu được vào luồng.
- **Đo hiệu năng ở môi trường deployed** (ADR-019).

## 16. Story, thứ tự, ghi chú

| Thứ tự | Story | Phụ thuộc | Ghi chú |
|---|---|---|---|
| 1 | **PK0** segment + cổng phạt mọi method | — | Vá lỗi, nhỏ |
| 2 | **PK1** generic lên console + Lắng nghe + Svix + "request đầu tiên ✓" | PK0 | Admin thấy kết quả ngay |
| 3 | **PK2** `hmac` mở rộng + `static-token` basic/query | PK1 | |
| 4 | **PK3** `signed-template` | PK2 | |
| 5 | **PK4** bắt tay + GET bắt tay + ack/rejectStatus | PK0, PK3 | Sửa lõi, review kỹ |
| 6 | **PK5** `unverified` (bốn khoá) | PK2 | Migration (cờ project, `events.verified`, `acceptUnverified`) |
| 7 | **PK6** chế độ thu + kích hoạt | PK4, PK5 | Migration |
| ∥ | **§8 danh mục + `identify`** (trục phụ) | PK1 | **Song song** với PK2–PK6, do một agent nhẹ làm: chỉ đụng `libs/providers/src/catalog/` + `research/`. Entry dùng scheme chưa có thì để `entries-pending/` tới khi story đó merge |
| 8 | **PK7** form "Provider khác" | §8, PK6 | |
| 9 | **PK8** giấy + nghiệm thu §13 | tất cả | |

Mỗi story đi theo VF (RED → PROBED → REVIEWED), review riêng, CI xanh rồi mới gộp. Lỗi từ Trung bình trở lên thì review lại.

### Ghi chú / nợ phát hiện khi code

_(dev ghi vào đây; lệch với tài liệu provider thì tài liệu thắng)_

## 17. Bảng test và checklist (nguồn cho `verify/spec-sources.json`, E19)

Mục §8 (danh mục + `identify`) mang mã story **PK9** để checklist bắt được. Dòng nào khác với mô tả trong thân spec thì mục ĐÍNH CHÍNH thắng.

| Mã | Story | Kiểm cái gì |
|---|---|---|
| `[PK:T1]` | PK0 | URL sai segment → 404, không ghi raw, không verify, không phạt |
| `[PK:T2]` | PK0 | IP trong hộp phạt gửi GET `/hooks/...` bị chặn trước body parser như POST |
| `[PK:T33]` | PK0 | SNS text/plain, XML, JWT, JSONL, body rỗng vào ingest với `rawBody` đúng từng byte (E1) |
| `[PK:T3]` | PK1 | Svix `svix-*` verify qua; trộn bộ header → false |
| `[PK:T4]` | PK1 | Inspect của console = khuôn service API, không có giá trị header/body |
| `[PK:T5]` | PK1 | Trạng thái kết nối "chờ → ✓" khi có ACCEPTED đầu tiên |
| `[PK:T6]` | PK2 | Ma trận algo × encoding × prefix × keyEncoding; sửa 1 byte trượt; prefix lạ trượt không ném |
| `[PK:T7]` | PK2 | Token ở query không xuất hiện trong headers/log/diagnose |
| `[PK:T8]` | PK3 | Template sai luật → 422 đúng tên trường |
| `[PK:T9]` | PK3 | Fixture Slack/Stripe/Paddle(/Zendesk/Box/Twitch nếu có) qua; lệch tolerance+1 → false; phát lại → false |
| `[PK:T10]` | PK4 | 5 biến thể bắt tay đúng khuôn, 0 outbox/SET NX, dòng REJECTED `handshake`; `manual-url` không gọi ra ngoài |
| `[PK:T11]` | PK4 | GET vào source không `query-echo` → 405; sai verify token → rejectStatus + phạt; HEAD → 405 |
| `[PK:T12]` | PK4 | rejectStatus 503 + chữ ký sai → 503, REJECTED, điểm phạt tăng; cấu hình 2xx → 422 |
| `[PK:T13]` | PK4 | adoptSecret ở trạng thái chờ; chưa xác nhận không verify; xác nhận mới thành SourceSecret (E20) |
| `[PK:T35]` | PK4 | hmac-echo: plainToken có `:`/`{` → không ký; bắt tay không ký → không echo (E3) |
| `[PK:T14]` | PK5 | Cờ project tắt → rejectStatus, 0 ghi, không phạt; bật → ACCEPTED, verified=false |
| `[PK:T15]` | PK5 | eventType namespace chuẩn (payment/repo/hub) → 422; ép qua DB → normalize lỗi vĩnh viễn |
| `[PK:T16]` | PK5 | Subscription không acceptUnverified → 0 delivery + metric; có cờ → giao, envelope verified:false |
| `[PK:T17]` | PK5 | data.raw đúng từng byte; data.url chỉ khi forwardUrl, không đổi theo Host |
| `[PK:T18]` | PK5 | Vòng tròn LOCAL: fixture Twilio qua unverified → unwrapUnverified + verify Twilio qua; sửa 1 byte trượt |
| `[PK:T36]` | PK5 | Polling key thường 0 event chưa xác thực; scope read:unverified thì có; replay tôn trọng acceptUnverified (E4) |
| `[PK:T37]` | PK5 | Renormalize sau đổi config giữ verified=false; không mở cảnh báo signature_failing (E5) |
| `[PK:T38]` | PK5 | Hai body khác nhau cùng transId đều ACCEPTED (E7); body > 45KB → 413 (E17) |
| `[PK:T24]` | PK6 | Trần thu theo số request và byte; vượt/hết hạn → 503 Retry-After; song song đúng trần |
| `[PK:T25]` | PK6 | 200 chỉ sau COMMIT |
| `[PK:T26]` | PK6 | captured_headers_enc không đọc được; headers che theo E12; sau kích hoạt NULL |
| `[PK:T27]` | PK6 | Kích hoạt sai secret 422; đúng → active; song song 200/409 |
| `[PK:T28]` | PK6 | Promote qua persistAcceptedTx, xoá dòng thu cùng tx, trùng → skipped, byte không tăng, usage trừ đúng |
| `[PK:T29]` | PK6 | Dòng thu còn header không bị dọn junk; hết header thì dọn được; retention REJECTED chạm tới |
| `[PK:T30]` | PK6 | Ngân sách Redis: đường thu 0, activate (không promote) 0 |
| `[PK:T31]` | PK6 | RLS: tenant B dùng id tenant A → 404 |
| `[PK:T34]` | PK6 | Verify bù theo received_at: Stripe thu lúc t, kích hoạt t+20 phút → verified (E2) |
| `[PK:T19]` | PK9 | Nghiệm thu nhận tên trên toàn danh mục, in cột official / constructed |
| `[PK:T20]` | PK9 | Nhận theo tên và theo header |
| `[PK:T21]` | PK9 | Provider lạ: guess kèm bằng chứng; header chung không sinh tên |
| `[PK:T22]` | PK9 | identify.ts không import Node API, chạy trong jsdom |
| `[PK:T23]` | PK9 | Mỗi khuôn body F15 có fixture parse được |
| `[PK:T32]` | PK7 | Form: Shopify / VNPay / acme ra đúng trạng thái; ①②③ không gửi mẫu lên mạng |
| `[PK:T39]` | PK8 | docs-sync: ARCHITECTURE/EVENT-CATALOG/ERRORS/CLAUDE.md có đủ mục PK (unverified, handshake, chế độ thu, mã lỗi mới) |

**Checklist** (đánh `[x]` khi story đã review ĐẠT và CI xanh):

- [ ] **PK0** — segment + cổng phạt mọi method + bytes gốc mọi content-type + `query`/`method`
- [ ] **PK1** — generic lên console + Lắng nghe + Svix + "request đầu tiên ✓"
- [ ] **PK2** — `hmac` mở rộng + `static-token` basic/query
- [ ] **PK3** — `signed-template`
- [ ] **PK9** — danh mục + `identify` (client)
- [ ] **PK4** — bắt tay + GET bắt tay + ack/rejectStatus
- [ ] **PK5** — `unverified` (bốn khoá + E4/E5/E7)
- [ ] **PK6** — chế độ thu + kích hoạt
- [ ] **PK7** — form "Provider khác"
- [ ] **PK8** — giấy + nghiệm thu §13
