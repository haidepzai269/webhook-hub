# SPEC PK — "Provider khác": nhận diện bên thứ ba và lấp ba khuôn còn thiếu

> Phòng party viết ngày 2026-10-13. Spec chỉ mô tả việc cần làm, **chưa có code**. Admin giao cho phiên dev.
> Tiền tố mã test là `PK:`. Phải thêm namespace `PK` vào `verify/spec-sources.json` **trước** khi viết test đầu tiên, theo dạng khai báo của `BP`.
> **Số ADR bắt đầu từ ADR-201.** BP giữ 195–200 (master đang có tới 196, `feat/bp` tới 197). Grep lại trước khi ghi: `git grep -oh "ADR-2[0-9][0-9]" master feat/bp -- docs _bmad-output | sort -u`.
> Thứ tự giao dev ở §11. **PK0 là vá lỗi**, làm trước.
> **Mỗi mục có khối "Vì sao sửa"**: chuyện gì hỏng, kịch bản cụ thể, vì sao chọn cách này mà không chọn cách khác. Agent dev phải dùng khối này làm dòng **Vấn đề / Đánh đổi** của ADR tương ứng và làm thân commit message. Không viết lại lý do theo trí nhớ. Nếu lúc code thấy lý do không còn đúng thì dừng lại và báo phòng, không âm thầm làm khác.
> **Chi tiết chữ ký của provider thật** (MoMo, VNPay, Twilio, Slack, Paddle, Shopify…) trong spec này là **bản phòng nhớ**, không phải nguồn sự thật. Dev phải đối chiếu tài liệu chính thức và sandbox của provider, ghi **phiên bản tài liệu** vào ADR, và chỉ commit fixture sinh từ payload mẫu chính thức. Lệch với spec thì tài liệu provider thắng, ghi vào §16.

## 0. Bối cảnh và mong muốn của Admin

Phụ lục viết: *"Tiếp nhận webhook từ nhiều nền tảng (PayOS, SePay, GitHub) qua endpoint riêng cho từng nguồn, URL khó đoán dạng `/hooks/:provider/:sourceKey`."* Admin hỏi: dev của shop dùng một bên **không phải** ba bên đó thì sao? Admin không muốn người dùng vào console rồi gặp câu "hub không hỗ trợ provider này".

**Mong muốn đã chốt (Admin, 2026-10-13):**

1. Người dùng là **dev của shop**.
2. Chọn **"Provider khác"** → có form để nhập → nhập xong hub **báo đây là bên thứ ba nào**, rồi điền sẵn cấu hình.
3. Form nhận **cả cách ① (gõ tên provider) và cách ② (dán webhook mẫu)**. Phòng giữ thêm ③ (gõ tên header chữ ký) và ④ (dán URL vào provider, bấm "Send test"), vì ④ là cách duy nhất khi provider không có payload mẫu trong tài liệu.
4. **Lấp cả ba khuôn còn thiếu**: HMAC trên `timestamp + body` (Slack, Paddle), HMAC trên các trường ghép lại (MoMo, VNPay), HMAC trên URL + tham số form (Twilio).
5. Source **chưa cấu hình** mà nhận request thì **trả 200**, không báo lỗi.

Phụ lục **không cần sửa chữ nào**: `generic` là một giá trị của `:provider`. `:provider` chọn khuôn xử lý, còn `:sourceKey` là một kết nối cụ thể của một project. "Endpoint riêng cho từng nguồn" là nói về `sourceKey`.

**Ba nghĩa phải tách bạch** (đây là nguyên tắc của cả spec):

| Việc | Câu hỏi nó trả lời | Ai quyết | Có được tin không |
|---|---|---|---|
| **Nhận diện** | "Trông như bên nào?" | `identify()`, hàm thuần trên danh mục | **Không.** Chỉ là nhãn, header và body ai cũng giả được |
| **Xử lý** | "Verify, lấy khoá chống trùng, normalize, ack thế nào?" | Handler của mục danh mục (config hoặc code) | Có, có fixture + test |
| **Kích hoạt** | "Có được nhận sự kiện vào luồng không?" | Secret khớp chữ ký trên **đúng bytes đã lưu** | Là thứ duy nhất được tin |

## 1. Những gì đọc được trong code (2026-10-13, master `8758c8c`)

| # | Ở đâu | Thực tế | Hệ quả |
|---|---|---|---|
| F1 | `libs/providers/src/generic.adapter.ts`, `generic-config.ts` | `GenericAdapter` (S8) **đã có**: 3 scheme `hmac-sha256`, `static-token`, `standard-webhooks`; `diagnose()` cho chế độ lắng nghe; ack có `fix` | Hub không bỏ xó provider lạ ở backend. Thiếu ở chỗ khác (F2, F3) |
| F2 | `apps/web/src/lib/hub/types.ts:6` | `PROVIDERS = ["github","sepay","payos","stripe"]` | `generic` **vô hình** ở console. Chỉ tạo được qua API. Đây là lý do Admin thấy "vứt xó" |
| F3 | `apps/web/src` | Không có màn chế độ lắng nghe. `GET sources/:id/inspect` chỉ có ở service API (`service-resources.controller.ts:422`), không có ở `/api/v1` của console | Dev cấu hình sai chỉ thấy 401, không thấy chẩn đoán |
| F4 | `libs/crypto/src/standard-webhooks.ts:44-46` | `swVerify` chỉ đọc `webhook-id/-timestamp/-signature` | **Đính chính bảng của phòng:** Clerk, Resend và các bên dùng Svix gửi `svix-id/-timestamp/-signature`. Hiện scheme `standard-webhooks` **không** verify được họ |
| F5 | `apps/hub-api/src/modules/ingest/ingest.controller.ts:12` | Chỉ `@Post(':provider/:sourceKey')` | VNPay gọi IPN bằng **GET**, dữ liệu và chữ ký nằm trên query string → không vào được hub |
| F6 | `libs/providers/src/provider.interface.ts:160` | `buildAck(result)` không nhận `ctx` | Generic không trả ack theo cấu hình được. MoMo cần 204, VNPay cần body `{"RspCode":"00",…}` |
| F7 | `ingest.service.ts:341` + `:355` | Adapter lấy theo **segment URL** (`req.provider`), source lấy theo `sourceKey`. **Không** kiểm `source.provider === req.provider` | `POST /hooks/github/<key-của-source-sepay>` chạy adapter GitHub với secret của SePay. Hiện không khai thác được (vẫn cần secret), nhưng sai hình dạng và cản thiết kế PK (§7) |
| F8 | `ingest.service.ts:540-575` | Request bị từ chối lưu **mẫu ≤ 4KB**, header **đã che** (ADR-051) | Không verify lại được về sau. Chế độ thu (PK4) phải lưu khác |
| F9 | `source-input.ts:27` | Tạo source bắt buộc `secret` 8–512 ký tự; `generic` bắt buộc `verificationConfig` | Source "chưa cấu hình" hiện không tạo được |
| F10 | `generic-config.ts` | `mapping` chỉ một `eventType` cố định, không rẽ nhánh | MoMo `resultCode = 0` → `payment.received`, khác 0 → `payment.failed`: config không tả được. Phải là handler code |

## 2. PK0 — Segment URL phải khớp provider của source (vá lỗi, làm trước)

> **Vì sao sửa**
> - **Chuyện gì hỏng:** lõi chọn adapter theo chữ trong URL nhưng chọn source theo `sourceKey`, và không đối chiếu hai thứ. Một source có thể bị gọi qua adapter của provider khác.
> - **Kịch bản:** dev sao chép nhầm URL thành `/hooks/github/<key-sepay>`. Hub chạy HMAC kiểu GitHub với secret SePay, luôn 401, và dev không hiểu vì sao. Tệ hơn, nếu sau này có adapter nào verify lỏng thì một `sourceKey` lộ ra là đủ để đi vòng qua adapter chặt.
> - **Vì sao cần cho PK:** PK2 đặt mọi provider mới dưới `generic`. Khoá chặt "URL generic chỉ vào source generic" thì logic delegation trong `GenericAdapter` không bị gọi với source sai loại.
> - **Vì sao trả 404 mà không 400:** cùng body với source không tồn tại (ADR-161), không lộ source có tồn tại hay không. **Không** tính điểm phạt EG2 (luật (a) chỉ tính `!source`). URL sai của provider thật không được làm khoá IP dùng chung.

**Phạm vi:** `ingest.service.ts`, ngay sau bước nạp source (`:358`).
1. `if (source.provider !== req.provider)` → 404 cùng body, không `recordUnknownSource`, metric `hub_ingest_requests_total{outcome="NOT_FOUND"}`. Đây là so sánh hai giá trị, không phải `if (provider === 'x')`, nên không phá luận điểm adapter.
2. `[PK:T1]`: URL sai segment → 404, không ghi `raw_events`, không gọi `verify`, không cộng điểm phạt.

## 3. PK1 — Lộ `generic` ra console + chế độ lắng nghe ở console + Svix

> **Vì sao sửa**
> - **Chuyện gì hỏng:** backend có `generic` từ S8 nhưng console chỉ liệt kê 4 provider (F2). Dev mở dropdown không thấy bên mình dùng thì kết luận hub không hỗ trợ.
> - **Svix (F4):** bảng của phòng ghi Clerk/Resend "✅" nhưng code chỉ đọc `webhook-*`. Đây là lỗi thật, phải sửa trước khi đưa Clerk/Resend vào danh mục.
> - **Vì sao nhận `svix-*` mà không thêm scheme mới:** thuật toán giống hệt Standard Webhooks, chỉ khác tên header. Thêm scheme là nhân đôi code verify.

1. `types.ts`: thêm lựa chọn **"Provider khác"** (giá trị `generic`). Chọn nó thì mở dialog PK3, không hiện form secret cũ.
2. Console: thêm `GET /api/v1/sources/:id/inspect`, dùng **cùng hàm** với service API (tách ra hàm dùng chung, không chép). Màn chi tiết source generic có tab **Lắng nghe**, gọi lại mỗi 2s như S9.
3. `swVerify`: nếu không có bộ `webhook-*` thì đọc bộ `svix-*` (cả ba phải cùng một bộ, không trộn). `diagnose` báo `missing_header` theo bộ đang có.
4. `[PK:T2]` fixture Svix (`svix-*`) verify qua; trộn `webhook-id` + `svix-signature` → false. `[PK:T3]` console inspect trả đúng khuôn của service API, không có giá trị header/body.

## 4. PK2 — Danh mục provider (dữ liệu) + `identify()`

> **Vì sao sửa**
> - **Mong muốn của Admin:** nhập xong thì hub báo bên nào. Muốn vậy hub phải **biết** các bên, nghĩa là cần một danh mục.
> - **Vì sao danh mục là dữ liệu, không phải code:** thêm một bên vào danh mục không được sửa lõi, không deploy lại logic. Đây là luận điểm "provider thứ 100" trước hội đồng.
> - **Vì sao tách nhận diện khỏi xử lý (`handler`):** mỗi mục tự chọn được xử lý bằng config (Shopify, Slack) hay bằng code (MoMo, VNPay). Cuộc cãi "(A) adapter hay (B) config" không phải chọn một lần cho tất cả.
> - **Vì sao không bịa tên khi không khớp:** provider mới mở tuần trước thì hub không thể biết tên. Báo **khuôn** (vd "HMAC-SHA256, chữ ký ở header `x-acme-signature`") vẫn cho dev kết nối được, và đúng sự thật.
> - **John:** mục nào không có fixture thì không vào danh mục. Danh mục lớn lên theo người dùng xin, không theo kiểu đoán "bên nào hay bắn webhook".

### 4.1. Khuôn một mục

```
libs/providers/src/catalog/
  entries/<id>.json
  fixtures/<id>/*.http        # request HTTP thật: dòng đầu, header, dòng trống, body
  catalog.ts                  # nạp + kiểm toàn bộ entries lúc khởi động (sai -> app không lên)
  identify.ts                 # hàm thuần
```

```jsonc
{
  "id": "shopify",
  "name": "Shopify",
  "aliases": ["shopify"],                  // so sau khi bỏ dấu + viết thường
  "group": null,                           // vd "svix": nhiều bên cùng dấu vân tay
  "fingerprint": {
    "method": "POST",
    "headers": { "required": ["x-shopify-hmac-sha256"], "optional": ["x-shopify-topic", "x-shopify-shop-domain"] },
    "body":    { "required": [], "optional": [] },     // tên trường CẤP MỘT
    "query":   { "required": [], "optional": [] }
  },
  "handler": {                             // MỘT trong ba
    "config":  { "scheme": "hmac-sha256", "header": "x-shopify-hmac-sha256", "encoding": "base64", "idempotency": { "header": "x-shopify-webhook-id" }, "eventType": "shopify.event" }
    // "preset": "momo-ipn"                // handler code (PK5)
    // "native": "github"                  // đã có adapter riêng -> console chuyển sang luồng provider đó
  },
  "fields": [ { "name": "secret", "label": "API secret key (Shopify admin → Notifications → Webhooks)", "secret": true } ],
  "secretSource": "provider",              // "provider" | "hub" (static-token: hub tự sinh, dev dán sang)
  "docs": "https://…",                     // tài liệu webhook chính thức
  "docsVersion": "2026-07"
}
```

Kiểm lúc nạp: `id` khớp `^[a-z0-9-]{2,32}$`; `handler.config` qua `validateGenericConfig`; `handler.preset` có trong registry PK5; `handler.native` có trong `ProviderRegistry`; mỗi mục ≥ 1 fixture.

### 4.2. `identify(input)`

```ts
identify(input: {
  name?: string;                                    // ①
  sample?: string;                                  // ② ≤ 64KB, request HTTP dạng text HOẶC chỉ JSON body
  headerName?: string;                              // ③
  captured?: { method; headers; query; body };      // ④ dựng từ raw_event CAPTURED (PK4)
}): {
  matches: Array<{ id; name; score; matched: string[]; handlerKind: 'config'|'preset'|'native' }>;  // xếp theo score
  shape: { scheme?: string; signatureHeader?: string; candidateHeaders: string[] } | null;          // khi matches rỗng
}
```

- **Thuần:** không DB, không Redis, không mạng, không log nội dung `sample` (có thể chứa secret/PII thật dán từ máy dev).
- **Luật khớp:** đủ mọi `required` thì là ứng viên; `score = (required + optional khớp) / tổng`. Mục trong cùng `group` cùng điểm → trả cả nhóm (vd "Standard Webhooks / Svix: Clerk, Resend…"). Không chọn bừa một cái.
- **① tên:** khớp alias chính xác hoặc tiền tố (≥ 3 ký tự) sau khi bỏ dấu. Không fuzzy Levenshtein: "mom" → MoMo là đủ; "moomo" không ra gì thì báo không thấy, không đoán.
- **② mẫu:** parse lỏng. Có dòng `METHOD /path` thì lấy method + query; có khối header thì lấy tên header (viết thường); phần còn lại parse JSON hoặc form. Chỉ JSON thì chỉ khớp `body`. Parse lỗi → `matches: []`, `shape: null`, kèm lý do, không ném.
- **Không khớp:** `shape` suy từ tên header theo `CANDIDATE_HEADER_RE` sẵn có (`generic.adapter.ts`), cộng gợi ý scheme (có `*-timestamp` đi kèm → `signed-template`; có `webhook-*`/`svix-*` → `standard-webhooks`; còn lại → `hmac-sha256`).
- Endpoint: `POST /api/v1/catalog/identify` (scope `manage:sources`), body ≤ 64KB, **0 Redis, 0 ghi DB**. Với ④: `{ rawEventId }`, server tự đọc raw_event CAPTURED của đúng tenant qua `TenantScopedRepository`.
- `GET /api/v1/catalog` trả danh sách mục (id, name, handlerKind, fields, docs) cho ô gõ tên ở client.

### 4.3. Danh mục ban đầu

| id | handler | Ghi chú |
|---|---|---|
| `github`, `stripe`, `payos`, `sepay` | `native` | Dán mẫu GitHub vào "Provider khác" → "Đây là GitHub, hub có adapter riêng" → chuyển sang luồng GitHub |
| `shopify` | config `hmac-sha256` base64 | |
| `gitlab` | config `static-token` `x-gitlab-token`, `secretSource: hub` | |
| `clerk`, `resend` | config `standard-webhooks`, `group: svix` | Cần PK1.3 |
| `slack`, `paddle` | config `signed-template` | Cần PK3a |
| `momo` | preset `momo-ipn` | PK5 |
| `vnpay` | preset `vnpay-ipn` | PK5 + PK6 (GET) |
| `twilio` | preset `twilio` | PK5 |

### 4.4. Test

- `[PK:T4]` **tự nhất quán:** với **mọi** mục, `identify({sample: fixture})` trả mục đó đứng đầu (hoặc cùng nhóm `group`). Thêm mục mới mà fixture của nó làm mục khác đổi hạng đầu → đỏ. Đây là cổng của John.
- `[PK:T5]` với mọi mục `config`/`preset`: fixture verify **qua** với secret test, sửa 1 byte body → **trượt**.
- `[PK:T6]` ① "mom", "MoMo", "ví momo" → momo; "zzz" → rỗng, không ném. ③ `x-shopify-hmac-sha256` → shopify.
- `[PK:T7]` provider lạ (fixture `acme` không có trong danh mục) → `matches: []`, `shape.signatureHeader = "x-acme-signature"`.
- `[PK:T8]` endpoint identify: 0 lệnh Redis, 0 câu ghi (spy), `sample` không xuất hiện trong log (spy logger).

## 5. PK3 — Form "Provider khác" ở console

> **Vì sao sửa**
> - Đây là chỗ mong muốn của Admin hiện ra trước mắt dev. Bốn ô vào, cùng một ô kết quả, cùng một form điền sẵn.
> - **Vì sao ② (dán mẫu) là ô chính:** tài liệu webhook của provider nào cũng có payload mẫu. Dev báo được tên **trước khi** provider bắn request thật, không phụ thuộc mạng hay tunnel.
> - **Vì sao kết quả là "Trông như", không phải "Đây là":** Amelia: mẫu dán vào ai cũng bịa được. UI không được gợi cảm giác đã xác thực.

```
┌─ Provider khác ──────────────────────────────────────────┐
│ ① Tên provider:     [ mom|            ]  ↳ MoMo          │
│ ② Hoặc dán webhook mẫu (từ tài liệu của họ): [ …… ]     │
│ ③ Hoặc header chữ ký họ gửi: [ x-shopify-hmac-sha256 ]   │
│ ④ Hoặc dán URL này vào provider, bấm Send test           │
│    https://hub…/hooks/generic/k7Qx…   ● đang chờ…        │
├──────────────────────────────────────────────────────────┤
│ Trông như: MoMo (khớp partnerCode, transId, signature)   │
│ Partner secret key: [____]  Access key: [____]           │
│                                   [Tạo nguồn / Kích hoạt]│
└──────────────────────────────────────────────────────────┘
```

1. ①②③ gọi `identify` (debounce 400ms cho ①, gọi khi bấm cho ②). Chưa có source nào được tạo.
2. Kết quả `config`/`preset` → form dựng từ `fields` của mục → **Tạo nguồn** = `POST /api/v1/sources` sẵn có với `provider: "generic"` + `verificationConfig` từ handler (preset: `{ scheme: "preset", preset: "momo-ipn" }`, PK5). `secretSource: hub` → hub sinh token, hiện **một lần** để dev dán sang provider.
3. Kết quả `native` → nút "Dùng kết nối GitHub" mở luồng provider đó (dialog sẵn có).
4. Không khớp → hiện `shape` + form generic tay (scheme, header, encoding, idempotency, eventType), điền sẵn theo `shape`. Kèm nút **"Đề xuất thêm vào danh mục"**: chỉ mở liên kết tạo issue với tên + tài liệu do dev gõ. **Không** gửi mẫu đi đâu.
5. ④ = PK4. Ô kết quả dùng chung.
6. `[PK:T9]` (e2e hoặc component) dán fixture MoMo → hiện "Trông như: MoMo" + đúng hai ô secret; dán fixture `acme` → hiện form tay có `header = x-acme-signature`.

## 6. PK3a — Scheme thứ tư `signed-template` (Slack, Paddle)

> **Vì sao sửa**
> - **Khuôn hàng 4 của bảng:** chuỗi ký vẫn dựa trên body thô, chỉ ghép thêm timestamp (và có bên ghép id). Ba token cố định là đủ, không cần code riêng cho từng bên.
> - **Vì sao chỉ 3 token và khoá bằng regex (Winston):** John cảnh báo "mẫu 3 token sang tuần thành 5". Token mới chỉ thêm khi có ADR + fixture của provider thật cần nó.
> - **Vì sao `{body}` bắt buộc đúng một lần:** template không có `{body}` thì chữ ký không phủ body, kẻ xấu giữ chữ ký cũ và thay body tuỳ ý. Đây là lỗ giả mạo, không phải lỗi cấu hình.
> - **Vì sao có `{timestamp}` thì bắt buộc kiểm độ lệch:** không kiểm thì một request bắt được hôm nay phát lại được mãi. Timestamp chỉ có ý nghĩa khi có cửa sổ.

```jsonc
{
  "scheme": "signed-template",
  "template": "v0:{timestamp}:{body}",           // ^([^{}]|\{(timestamp|body|id)\}){1,128}$, {body} đúng 1 lần
  "algo": "sha256",                              // sha256 | sha512
  "encoding": "hex",                             // hex | base64
  "signature": { "header": "x-slack-signature", "prefix": "v0=" },
  //   hoặc dạng khoá=giá trị trong MỘT header (Paddle):
  //   { "header": "paddle-signature", "kv": { "sep": ";", "sig": "h1", "timestamp": "ts" } }
  "timestampHeader": "x-slack-request-timestamp", // bỏ khi timestamp nằm trong kv
  "idHeader": null,                              // bắt buộc nếu template có {id}
  "toleranceSec": 300,                           // 60..900, bắt buộc khi có {timestamp}
  "idempotency": { "header": "…" } | { "field": "…" },
  "eventType": "slack.event"
}
```

- `kv.sep` chỉ `;` hoặc `,`. Nhiều giá trị `sig` (xoay khoá, vd `h1=a,h1=b`) → khớp một là được, vẫn không dừng sớm như `verify` hiện tại.
- So bằng `timingSafeCompare`. HMAC tính trên `Buffer.concat` các phần, `{body}` là **bytes gốc**, không phải `toString()` (tránh lệch UTF-8).
- `diagnose`: thêm lý do `timestamp_out_of_range` (đã có kiểu), `missing_header` cho `timestampHeader`.
- Thiếu `idempotency` với Slack: Slack có `event_id` trong body → `{ field: "event_id" }`. Paddle có `event_id`. Lấy theo tài liệu.
- `[PK:T10]` thiếu `{body}`, `{body}` hai lần, token lạ `{foo}`, có `{timestamp}` mà không có `toleranceSec` → 422 với đúng tên trường.
- `[PK:T11]` fixture Slack + Paddle verify qua; lệch timestamp 301s → false; phát lại cùng request sau 10 phút → false.

## 7. PK5 — Handler code dưới `generic`: `momo-ipn`, `vnpay-ipn`, `twilio`

> **Vì sao sửa**
> - **Hàng 5 và 6 của bảng không cấu hình được an toàn.** MoMo ký chuỗi `accessKey=…&amount=…&…` theo thứ tự cố định, mà `accessKey` **không có trong body** (là credential thứ hai). VNPay ký trên query đã sắp xếp, có quy tắc mã hoá ký tự riêng. Twilio ký trên URL công khai + tham số form, SHA1. Tả bằng config là viết một ngôn ngữ chữ ký, đúng thứ John cấm từ vụ JSONPath. Dev của shop gõ thiếu `exclude: ["signature"]` thì verify không bao giờ khớp và họ sẽ tìm cách tắt verify (Amelia).
> - **MoMo còn cần rẽ nhánh normalize** (F10): `resultCode = 0` → `payment.received`, khác 0 → `payment.failed`.
> - **Vì sao đặt dưới `generic` mà không thêm `momo` vào `ProviderEnum`:** ở luồng ④ dev **đã dán URL `/hooks/generic/<key>` sang provider trước khi hub nhận ra đó là MoMo**. Nếu nhận diện xong lại đổi `source.provider` thành `momo` thì URL phải đổi theo (PK0 khoá segment) và dev phải dán lại. URL đã đưa cho provider phải bất biến. Ngoài ra mỗi provider mới không cần migration enum.
> - **Luận điểm vẫn giữ:** thêm một khuôn ký dị dạng = viết **một class** `PresetHandler` + đăng ký registry. Không sửa ingest, worker, DB. Thêm một provider có khuôn sẵn = thêm **một file JSON**.

### 7.1. Interface

```ts
// libs/providers/src/presets/preset-handler.ts
export interface PresetHandler {
  readonly id: string;                                   // "momo-ipn"
  readonly methods: ReadonlyArray<'POST' | 'GET'>;
  readonly credentialFields: string[];                   // ["secretKey", "accessKey"] — lưu như SourceSecret (mã hoá)
  verify(req: RawWebhookRequest, creds: Record<string, string>[]): boolean;   // mảng = xoay khoá
  extractIdempotencyKey(req: RawWebhookRequest): string; // thiếu id -> bodyHashKey(rawBody), KHÔNG ngẫu nhiên
  extractSignature(req: RawWebhookRequest): string | null;
  normalize(req: RawWebhookRequest, ctx: NormalizeContext): NormalizedEvent[];  // ra kiểu chuẩn theo EVENT-CATALOG
  buildAck(result: IngestResult): { status: number; body: unknown; contentType?: string };
  diagnose?(raw: StoredRawEvent): Diagnosis;
}
```

- `GenericAdapter`: `verificationConfig = { scheme: "preset", preset: "<id>" }` → mọi phương thức uỷ quyền cho handler. `validateGenericConfig` nhận scheme `preset` khi `preset` có trong registry. Lõi ingest **không** biết preset tồn tại.
- **Nhiều credential:** một `SourceSecret` lưu JSON `{"secretKey":"…","accessKey":"…"}` đã mã hoá AES-GCM như mọi secret. Xoay khoá = thêm version mới, như hiện tại. `secret` trong `parseSourceInput` cho phép object khi scheme `preset` (validate theo `credentialFields`).
- `normalize` của `momo-ipn`, `vnpay-ipn` phải ra `payment.*` đúng khuôn `EVENT-CATALOG.md`. Sai khuôn là lỗi normalize vĩnh viễn (luật CLAUDE.md). Sửa catalog nếu cần trường mới + test U50.

### 7.2. Ba handler (bản phòng nhớ, dev phải đối chiếu tài liệu)

| Handler | Verify | Khoá chống trùng | Ack | Normalize |
|---|---|---|---|---|
| `momo-ipn` | HMAC-SHA256 hex trên `accessKey=…&amount=…&extraData=…&…&transId=…` (khoá theo thứ tự tài liệu, `accessKey` từ credential, `signature` lấy ở body) | `momo:{partnerCode}:{transId}`; thiếu `transId` → `bodyHashKey` | **204** không body | `resultCode = 0` → `payment.received`, khác → `payment.failed` (`reason` = `message`) |
| `vnpay-ipn` | HMAC-SHA512 hex trên query đã sắp xếp theo tên, **bỏ** `vnp_SecureHash` và `vnp_SecureHashType`, giá trị mã hoá đúng như mã mẫu chính thức của phiên bản đang dùng | `vnpay:{vnp_TxnRef}:{vnp_TransactionNo}` | 200 `{"RspCode":"00","Message":"Confirm Success"}`; chữ ký sai → 200 `{"RspCode":"97",…}` (theo tài liệu VNPay, **không** phải 401) | `vnp_ResponseCode = "00"` → `payment.received`, khác → `payment.failed` |
| `twilio` | HMAC-SHA1 base64 trên **URL công khai đầy đủ** + các tham số POST sắp theo tên (key+value nối liền), header `x-twilio-signature` | `twilio:{MessageSid|CallSid}` | 200, body rỗng hoặc `<Response/>` `text/xml` | `twilio.event` (không phải `payment.*`), `data = { raw }` |

**Cạm bẫy phải xử lý:**
- **VNPay trả 200 khi chữ ký sai** là yêu cầu của VNPay, không phải hub ACK sớm: hub **không** lưu ACCEPTED, không vào luồng. BB-3 nói về "2xx khi sự kiện **hợp lệ** chưa COMMIT"; request sai chữ ký vẫn đi đường REJECTED như cũ, chỉ có mã HTTP do handler quyết. Ghi rõ trong ADR. Lõi hiện ép 401/422 qua `rejectAck` (ADR-139): thêm ngoại lệ có kiểm soát, handler được trả `status` khác cho ca từ chối **chỉ khi** mục danh mục khai `rejectStatus`. Test chặn mọi handler khác trả 2xx khi từ chối.
- **Twilio cần URL công khai:** **không** dựng từ header `Host` (giả được). Dựng từ `PUBLIC_BASE_URL` (env, bắt buộc khi có source twilio) + path + query gốc. Sau tunnel/proxy mà URL lệch là 401 vĩnh viễn → `diagnose` báo `public_url_mismatch` kèm URL hub đang dùng (không phải bí mật).
- Twilio là SMS, dev của shop ít gặp → làm **sau cùng** (§11).

### 7.3. Test

- `[PK:T12]` mỗi handler: fixture từ payload mẫu chính thức (ký lại bằng secret test) verify qua; sửa 1 byte → trượt; thiếu `accessKey` (MoMo) → trượt, không ném.
- `[PK:T13]` MoMo `resultCode` 0 và 1006 ra đúng hai kiểu, cả hai qua `validateCanonical`.
- `[PK:T14]` VNPay chữ ký sai → HTTP 200 `RspCode 97`, raw_event REJECTED, **không** outbox, **không** SET NX. Handler khác cố trả 2xx khi từ chối → test đỏ.
- `[PK:T15]` Twilio với `Host: evil.com` vẫn verify theo `PUBLIC_BASE_URL`.
- `[PK:T16]` grep: không có `momo|vnpay|twilio` trong `apps/hub-api/src/modules/ingest`, `apps/hub-worker/src`.

## 8. PK6 — Ingest nhận GET + ack theo ngữ cảnh (sửa lõi một lần)

> **Vì sao sửa**
> - **VNPay gọi IPN bằng GET** (F5). Không sửa thì VNPay không bao giờ vào được, dù chọn adapter hay config.
> - **Vì sao sửa tổng quát mà không `if (provider === 'vnpay')`:** lõi chỉ hỏi adapter "anh có nhận method này không". Lần sau một bên khác dùng GET thì không sửa lõi nữa.
> - **Vì sao `rawBody` của GET là bytes query string gốc:** HMAC luôn tính trên bytes gốc (CLAUDE.md). Parse rồi dựng lại query là lệch thứ tự và mã hoá, chữ ký sai 100% mà log không nói gì, đúng cạm bẫy #1.
> - **`buildAck` nhận `ctx`** (F6): cùng lý do `verify` đã nhận `ctx` ở S8. Không có `ctx` thì `GenericAdapter` không biết preset nào để trả 204 hay `RspCode`.

1. `ingest.controller.ts`: thêm `@Get(':provider/:sourceKey')` gọi cùng `handleWebhook`. `RawWebhookRequest` thêm `method: 'POST' | 'GET'`. GET: `rawBody = Buffer.from(<phần sau '?' của originalUrl, nguyên văn>)`, `body = ` query đã parse.
2. `ProviderAdapter.acceptsMethod?(method, ctx): boolean`. Không cài = chỉ POST. Lõi gọi **sau khi nạp source** (cần `ctx`), method không nhận → **405** `{error:"method_not_allowed"}`, không ghi DB, không phạt.
3. `buildAck(result, ctx?)` và `rejectAck` truyền `ctx`. Adapter cũ bỏ qua tham số. Controller: ack có `contentType` thì `res.type(...)`, `status 204` thì `res.status(204).end()`.
4. GET đi **cùng mọi tầng chắn** như POST: nginx (`location` hiện không lọc method, đã kiểm), EG2 phạt, QT3 khoá ghi, EG3 rate limit. Trần query 8KB (GET không qua body parser 1MB).
5. `[PK:T17]` GET vào source GitHub → 405, 0 ghi. GET vào preset VNPay với fixture → 200 `RspCode 00`, raw_event ACCEPTED, `body_raw` bằng **đúng** bytes query gốc (kể cả `%20` và `+`).
6. Ngân sách Redis: GET đi cùng đường nóng, **không** thêm lệnh. `redis-budget.spec.ts` thêm ca GET.

## 9. PK4 — Chế độ thu: source chưa cấu hình, trả 200, kích hoạt bằng verify lại

> **Vì sao sửa**
> - **Luồng ④:** có provider không có payload mẫu trong tài liệu, cách duy nhất để nhận diện là để họ bắn một request thật. Muốn vậy phải có URL **trước khi** có cấu hình và secret.
> - **Admin chốt trả 200** khi chưa cấu hình: chưa cấu hình không phải lỗi. Có provider coi 401 ở nút "Send test" là thất bại, hiện chữ đỏ hoặc không cho lưu URL, làm dev kẹt ngay bước đầu.
> - **Vì sao 200 vẫn giữ BB-3:** hub chỉ trả 200 **sau khi COMMIT** bytes gốc vào `raw_events`. Hub không làm mất gì: request đã nằm trong Postgres và được **verify bù** lúc kích hoạt, rồi đưa vào luồng nếu dev chọn. BB-3 cấm ACK trước COMMIT, không cấm ACK request chưa verify mà đã được giữ bền.
> - **Vì sao phải có hạn và trần (Winston):** source chưa cấu hình mà nhận vô hạn là một cái xô mở. Ai biết URL cũng đổ rác vào, ăn hạn mức dung lượng của project (noisy neighbor, 12/10).
> - **Vì sao header gốc phải lưu mã hoá (Amelia):** verify bù cần header gốc. Với `static-token`, token **chính là** bí mật, mà ADR-051 cấm lưu bí mật dạng rõ. Mã hoá AES-GCM bằng master key, xoá ngay khi kích hoạt hoặc hết hạn.
> - **Vì sao đưa vào luồng là tuỳ chọn, mặc định tắt:** request bắt được ở bước này thường là "Send test" với dữ liệu giả. Tự đưa vào luồng là bắn đơn giả vào đích của shop.
> - **Vì sao chỉ kích hoạt khi verify khớp ít nhất một request đã thu:** đây là bằng chứng duy nhất secret dev dán là đúng secret mà provider đang ký. Nhận diện "Trông như MoMo" không chứng minh gì.

### 9.1. Schema (một migration)

```
sources.capture_until   timestamptz NULL    -- khác NULL = đang ở chế độ thu
sources.capture_count   int NOT NULL DEFAULT 0
raw_events.status       + 'CAPTURED'
raw_events.captured_headers_enc  bytea NULL -- header GỐC, AES-GCM; chỉ dòng CAPTURED; xoá khi kích hoạt / hết hạn
```

`verification_config` được phép NULL khi `capture_until` khác NULL (sửa ràng buộc ở `parseSourceInput`, không ở DB).

### 9.2. Tạo

`POST /api/v1/sources { provider: "generic", name, mode: "capture" }`: không cần `secret`, không cần `verificationConfig`. `capture_until = now + 15 phút`. Trả `webhookUrl`. Vẫn qua `assertSourceLimit` (QT9) và audit `source.create`.

### 9.3. Ingest (vị trí trong thứ tự §3.1)

Ngay **sau** QT3 (khoá ghi khi đầy) và hộp phạt theo cặp (2a), **trước** verify:

```
if (source.captureUntil !== null):              // thuộc tính của SOURCE, không phải provider
   hết hạn (captureUntil < now)    -> 401 rejectAck "source_not_configured", không ghi
   trong một transaction:
     UPDATE sources SET capture_count = capture_count + 1
       WHERE id = $1 AND capture_until > now() AND capture_count < 10 RETURNING id
     không có dòng                 -> ROLLBACK -> 429 + Retry-After: <giây tới capture_until>
     INSERT raw_events (status CAPTURED, signature_valid false, body_raw = bytes ĐẦY ĐỦ,
                        headers = bản đã che, captured_headers_enc = AES-GCM(header gốc))
   COMMIT -> 200 {"ok":true,"captured":true}
```

- **0 lệnh Redis** (trần đếm bằng câu `UPDATE` có điều kiện, an toàn nhiều instance). `redis-budget.spec.ts` thêm ca thu.
- Không outbox, không SET NX, không normalize. Worker không bao giờ thấy dòng CAPTURED.
- `trace.bytes` cộng như ACCEPTED (QT đếm đúng dung lượng). Trường hợp xấu nhất 10 × 1MB = 10MB/cửa sổ, QT3 vẫn chặn khi project đầy.
- Console: **"Lắng nghe lại"** = đặt lại `capture_until = now + 15 phút`, `capture_count = 0` (audit).

### 9.4. Kích hoạt

`POST /api/v1/sources/:id/activate { verificationConfig, secret, promote?: boolean, acknowledgeUnverified?: boolean }`

1. Validate `verificationConfig` + `secret` như tạo source thường.
2. Nạp các dòng CAPTURED của source (của đúng tenant). Giải mã header gốc, dựng `RawWebhookRequest` từ `body_raw` + header gốc + method/query đã lưu, chạy `adapter.verify` với config + secret mới.
3. **Không dòng nào khớp** → 422 `activation_unverified` + `diagnose` từng dòng (chỉ tên header/trường, không giá trị). Ngoại lệ: không có dòng CAPTURED nào **và** `acknowledgeUnverified: true` → cho kích hoạt (giống tạo source thường hôm nay).
4. Có ít nhất một dòng khớp → **một transaction:**
   `UPDATE sources SET verification_config, capture_until = NULL … WHERE id = $1 AND capture_until IS NOT NULL` (0 dòng → 409, hai người bấm cùng lúc), tạo `SourceSecret` v1, xoá `captured_headers_enc` của mọi dòng CAPTURED, audit `source.activate` (metadata: số dòng khớp, `promote`).
5. `promote: true` → mỗi dòng khớp, theo `received_at` tăng dần, đi qua **chính `persistAccepted`** (không chép logic): raw_event ACCEPTED + outbox, SET NX sau COMMIT. Khoá chống trùng do adapter trích. Trùng thì bỏ qua. Lỗi một dòng không làm hỏng kích hoạt; trả `{ promoted, skipped }`.
6. Dọn: job cleanup sẵn có của `hub-worker` thêm bước xoá `captured_headers_enc` của source đã hết hạn thu quá 1 giờ (Redis lock như cleanup hiện tại).

### 9.5. Test

- `[PK:T18]` source thu: 10 request đầu → 200 + 10 dòng CAPTURED; request 11 → 429 có `Retry-After`; hết hạn → 401, không ghi. Hai instance bắn song song 30 request → đúng 10 dòng.
- `[PK:T19]` 200 chỉ sau COMMIT: giả lỗi INSERT → 500, không 200.
- `[PK:T20]` `captured_headers_enc` không đọc được bằng mắt (không chứa token rõ); `headers` đã che; sau kích hoạt cột này NULL ở mọi dòng.
- `[PK:T21]` kích hoạt secret sai → 422 kèm chẩn đoán, source vẫn ở chế độ thu. Secret đúng → active, `verification_config` đã ghi. Bấm hai lần song song → một 200, một 409.
- `[PK:T22]` `promote: false` → 0 outbox. `promote: true` với 3 dòng (2 khớp, 1 trùng khoá) → 1 sự kiện vào luồng, 1 skipped, đi qua `persistAccepted` (spy).
- `[PK:T23]` ngân sách Redis: đường thu = 0 lệnh; identify = 0; activate (không promote) = 0.
- `[PK:T24]` RLS: tenant B gọi activate/identify với `rawEventId` của tenant A → 404.

## 10. PK7 — Giấy phải khớp code

1. `docs/ARCHITECTURE.md`: §3.1 thêm nhánh chế độ thu (vị trí ở 9.3) và bước kiểm segment PK0; mục GenericAdapter thêm `signed-template`, `preset`, danh mục, `identify`; §15 Q&A thêm câu "provider thứ 100".
2. `docs/EVENT-CATALOG.md`: nguồn `momo-ipn`, `vnpay-ipn` ra `payment.*`; `twilio.event`, `slack.event`, `shopify.event`… là kiểu tự do.
3. `docs/ERRORS.md`: `method_not_allowed`, `source_not_configured`, `activation_unverified`.
4. `CLAUDE.md`, mục "Quy tắc khi code": thêm *"Thêm provider có khuôn sẵn = thêm một mục danh mục JSON + fixture. Thêm khuôn ký mới = một `PresetHandler` + registry. Không sửa ingest/worker/DB."* Mục so chữ ký: liệt kê SHA1 của Twilio là ngoại lệ có chủ đích (Twilio quy định), vẫn so bằng `timingSafeEqual`.
5. `docs/FOR-EXAMINERS.md`: bậc thang ba tầng (dữ liệu → cấu hình → code), dẫn `[PK:T4]` làm bằng chứng.

## 11. Story và thứ tự

| Thứ tự | Story | Phụ thuộc | Ghi chú |
|---|---|---|---|
| 1 | **PK0** segment khớp provider | — | Vá lỗi, nhỏ |
| 2 | **PK1** lộ generic + inspect console + Svix | PK0 | Admin thấy kết quả ngay |
| 3 | **PK2** danh mục + `identify()` | PK1 | Mục ban đầu chỉ gồm `native` + config đã có scheme |
| 4 | **PK3a** `signed-template` | PK2 | Thêm mục Slack, Paddle |
| 5 | **PK3** form "Provider khác" (①②③) | PK2 | |
| 6 | **PK6** GET + `buildAck(ctx)` | PK0 | Sửa lõi, review kỹ |
| 7 | **PK5** preset: `momo-ipn` → `vnpay-ipn` → `twilio` | PK2, PK6 | Mỗi handler một commit + một ADR |
| 8 | **PK4** chế độ thu + kích hoạt (④) | PK2, PK3 | Migration |
| 9 | **PK7** giấy | tất cả | |

Mỗi story xong mới sang story sau. Review từng story như BP.

## 12. ADR (ghi khi làm, mỗi ADR 3 dòng)

| ADR | Story | Tiêu đề |
|---|---|---|
| 201 | PK0 | Segment `:provider` phải bằng `source.provider`; lệch → 404 không phạt |
| 202 | PK1 | `standard-webhooks` nhận bộ header `svix-*` (cùng thuật toán, không trộn bộ) |
| 203 | PK2 | Danh mục provider là dữ liệu; nhận diện là gợi ý, không phải tin cậy; không khớp thì báo khuôn, không bịa tên |
| 204 | PK3a | `signed-template`: 3 token, `{body}` đúng một lần, `{timestamp}` kéo theo cửa sổ bắt buộc |
| 205 | PK5 | Khuôn ký dị dạng = `PresetHandler` dưới `generic`, không thêm `ProviderEnum` (URL đã đưa provider phải bất biến) |
| 206–208 | PK5 | Mỗi handler (`momo-ipn`, `vnpay-ipn`, `twilio`) một ADR kèm **phiên bản tài liệu** provider; VNPay ghi ngoại lệ `rejectStatus` 200 |
| 209 | PK6 | Ingest nhận GET theo khai báo adapter, `rawBody` = query gốc; `buildAck(result, ctx)` |
| 210 | PK4 | Chế độ thu: 200 sau COMMIT, 15 phút / 10 request, header gốc mã hoá, 0 Redis; kích hoạt chỉ khi verify bù khớp; đưa vào luồng là tuỳ chọn |

## 13. Biến môi trường mới

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `PUBLIC_BASE_URL` | — | Bắt buộc khi có source `twilio` (kiểm lúc kích hoạt, không lúc khởi động) |
| `CAPTURE_WINDOW_MIN` | 15 | Kẹp 5..60 |
| `CAPTURE_MAX_REQUESTS` | 10 | Kẹp 1..20 |

## 14. Cố tình không làm

- **JSONPath, biểu thức, vòng lặp trong config.** Khuôn nào cần thì viết `PresetHandler`.
- **Tự động thêm mục danh mục từ request người dùng.** Nút "Đề xuất" chỉ mở issue, không gửi mẫu.
- **Fuzzy matching tên** (Levenshtein…). Sai tên thì báo không thấy.
- **Kích hoạt chỉ dựa trên nhận diện.** Không bao giờ.
- **Tự đưa request thu được vào luồng.** Luôn là lựa chọn của dev.
- **Trả 200 cho source đã cấu hình mà chữ ký sai** (trừ `rejectStatus` khai rõ trong danh mục như VNPay).
- **Đo hiệu năng ở môi trường deployed** (ADR-019).

## 15. Câu hỏi mở cho Admin

- **Q1:** `promote` mặc định **tắt**. Admin có muốn mặc định bật khi mọi request thu được đều verify khớp không?
- **Q2:** cửa sổ thu 15 phút / 10 request có hợp với demo trước hội đồng không?
- **Q3:** Twilio có cần trong đợt này, hay để danh mục ghi "sắp có" và làm khi có người xin?
- **Q4 (Mary còn nợ):** danh sách provider tự tắt webhook khi "Send test" lỗi. Đã đỡ được một phần nhờ quyết định trả 200 ở chế độ thu, nhưng vẫn cần biết cho `fix` trong ack.

## 16. Ghi chú / nợ phát hiện khi code

_(dev ghi vào đây; lệch với tài liệu provider thì tài liệu thắng)_
