# REVIEW-PK9: sửa Thấp PK3 (`1d92367`) + PK9 danh mục / identify / `GET /api/v1/catalog` (`fa1874c`)

Reviewer độc lập (Mary 📊 dữ liệu provider · Grumbal ⚠️ bảo mật · Murat 🧪 test), 2026-10-14, nhánh `feat/pk`, worktree `C:\wt\pk`.
Chỉ đọc + jest chọn lọc + đột biến tạm (đã `git checkout --` trả lại hết; `libs/hub-sdk/bin/hub.js` là WIP có sẵn, không đụng).

## Kết luận: **ĐẠT** — 0 Nặng · 2 Trung bình · 10 Thấp

Hai mục Trung bình đều không chặn merge PK9, nhưng phải sửa trước khi chúng thành thật:
- TB-1 phải xong trước PK6 ④ (`POST /sources/:id/identify` chạy `identify` trên server).
- TB-2 phải xong trước PK7 (form hiện mục GitLab cho dev).

## Đã chạy (bằng chứng)

| Lệnh | Kết quả |
|---|---|
| `npx jest --maxWorkers=2` libs/providers/test, libs/crypto (crypto, standard-webhooks), hub-api (ingest-generic, service-sources, console-catalog, console-endpoints, console-lists, console-source-inspect, auth-scope), web `lib/hub` + `lib/i18n` | **32 suite / 405 test xanh**. Bài A: 20 mục, 20 fixture, official 1/1, constructed 19/19 |
| `tsc --noEmit` hub-api / hub-worker / web | sạch |
| `npm run verify:gates` | 20 luật, 0 vi phạm |
| `npm run catalog:build -- --check` | "catalog.data.ts khớp (20 mục)", exit 0 |
| `npm run verify:catalog` | in đủ 71 pending kèm `blockedBy` |

Đột biến tạm (mutation), đều bị test giết:
- Bỏ luật `{id}` sát `{body}` (`generic-config.ts:353`) → 1 đỏ.
- `unix` nhận lại số 0 đứng đầu (`signed-template.ts:33`) → 2 đỏ.
- Bỏ guard NaN (`generic.adapter.ts:28`) và trả `swVerify` về `> tol` → 1 đỏ.
- Sửa `entries/paddle.json` mà không build lại → `[PK:T19]` đỏ (drift).

## 1. Sửa PK3

**T-1 ranh giới token.** Đã brute-force mọi cách cắt lại `id‖ts‖body` (`scratchpad/bf.js`), với ts nằm trong cửa sổ:

| Trường hợp | Kết quả |
|---|---|
| unix, id UUID | 0 cách cắt khác |
| unix, body bắt đầu bằng chữ số | 0 |
| iso8601 Twitch (9 chữ số lẻ, `Z`) | 0 |
| iso, id có đuôi giống ISO | 0 |
| unix, id **cố ý** chứa tiền tố của ts (`x1700000` + `1700000123`) | **1** → `id'="x"`, `ts'="1700000170"`, `body'="0000123{…"` |

ISO an toàn vì hai đầu cứng: 4 chữ số năm và `Z`/`±hh:mm` bắt buộc. Luật đủ cho dữ liệu thực tế. Cách cắt còn lại cần id do provider sinh trùng chữ số với ts, và body sau khi cắt luôn có tiền tố rác. Xem **T-a**.

**T-2 fail-closed.**
- `generic.adapter.ts:28` có `Number.isFinite(nowMs)`.
- `withinTolerance` kiểm `nowSec`.
- `swVerify` dùng `!(… <= tol)`.
- Các nơi dùng `verifyAt` đã grep đủ. Đạt.

**T-4 vector độc lập.**
- Slack: secret, ts 1531420618 và chữ ký `v0=a2114d57…b503` khớp nguyên văn `docs.slack.dev/authentication/verifying-requests-from-slack` (WebFetch 2026-10-14). Test verify qua cấu hình điền nhanh, nên đáp án không tự-tròn.
- Stripe: header sinh bằng `stripe.webhooks.generateTestHeaderString` của SDK. Đạt.

**Allowlist `.gitleaks.toml` (3 dòng):** đều là hằng số công khai trong tài liệu Slack, có chú thích nguồn và ngày xác minh. **Chấp nhận.** Allowlist áp toàn repo, nhưng ba chuỗi này không thể là secret thật của ai, nên không có rủi ro.

## 2. Danh mục: 20 mục, đối chiếu từng handler

| Mục | Handler | Đối chiếu | Kết luận |
|---|---|---|---|
| shopify | hmac sha256 base64, raw body | đúng (shopify.dev) | Verify đúng. Khoá chống trùng: xem **T-b** |
| woocommerce | hmac sha256 base64 | đúng | Ping form `webhook_id=` không ký → **T-c** |
| razorpay | hmac sha256 hex, `x-razorpay-event-id` | đúng theo nghiên cứu (nguồn chính chủ) | OK |
| jira | `x-hub-signature`, `<algo>=`, hex | đúng (developer.atlassian.com, có vector) | OK |
| linear | hmac hex `linear-signature`, `linear-delivery` | đúng | Không kiểm `webhookTimestamp` → **T-d** |
| vercel | sha1 hex + `sha1Reason` | đúng; luật bắt `sha1Reason` có test | OK |
| render / svix / resend | standard-webhooks | đúng; group `svix` trả cả nhóm | OK |
| telegram | static-token header | đúng (core.telegram.org) | OK |
| postmark | static-token basic, `x-pm-webhook-trace-id` | **đã WebFetch**: trace id "stays stable across retries", Basic `user:pass@` | OK |
| paddle | signed-template kv `;` `h1`/`ts`, `{timestamp}:{body}`, tol 5 | đúng | OK |
| gitlab | standard-webhooks + phương án phụ token tĩnh | **đã WebFetch**: signing token chỉ có từ **GitLab 19.0** (GA 19.1); `Idempotency-Key` từ **17.4** | **TB-2** |
| github, stripe, payos, sepay | native | có trong registry | OK |
| vnpay, zalopay, discord | unsupported | workaround đúng `POST /v1/p/:project/events` (E22), có test chặn `/publish` | OK |

Không mục nào sai tới mức 401 mãi trên bản provider hiện hành. Riêng GitLab self-managed bản cũ thì sẽ bị: xem **TB-2**.

**Câu hỏi về khoá chống trùng:**
- `validateGenericConfig` **bắt buộc** `idempotency` (`generic-config.ts:249-266`), chỉ nhận `{header}` hoặc `{field}` cấp một. Ngoại lệ duy nhất là standard-webhooks (mặc định `webhook-id`). Không có fallback `bodyHashKey`, nên dev không tự nạp được mục thiếu id.
- Đề xuất an toàn, không ngẫu nhiên: thêm `idempotency: { bodyHash: true }`.
  - Khoá = `bodyHashKey(rawBody)`, đúng quy tắc trong CLAUDE.md và cùng cơ chế E7.
  - Với scheme chỉ ký body (S1), đây còn là khoá **xác thực được**: header id không được ký, nên kẻ bắt được request có thể đổi header để vượt chống trùng (T-e).
  - Điều kiện nạp: tài liệu xác nhận provider gửi lại **đúng bytes**. Cấm cho body rỗng hoặc hằng (google-drive).
  - Cần một ADR + luật 422 khi scheme là `static-token` (token không phủ body thì bodyHash vẫn đúng, nhưng phải ghi rõ).
- Mục lồng (heroku `webhook_metadata.event.id`, webflow `payload.id`, coinbase `event.id`): cần `field` dạng đường dẫn ≤ 2 cấp. Đó là thay đổi code kèm ADR, không phải dữ liệu.

## 3. `identify.ts`

**Thuần.**
- Chỉ `import type './types'`.
- Dùng `atob`/`TextDecoder`, không dùng `Buffer`.
- `[PK:T22]` chạy trong `vm`.
- Không gọi mạng.

Đạt.

**Đo input ác ý** (`scratchpad/adv.js`, `adv2.js`):

| Input | Thời gian | Kết luận |
|---|---|---|
| JSON lồng 64K `[` / `{"a":` | 8 ms / 4 ms, không ném | OK |
| Form `a[b]…` 21K cấp | 0 ms | OK |
| Request line / header nhiều khoảng trắng | ≤ 1 ms | OK |
| JWT-like, `a.` lặp | ≤ 2 ms | OK |
| XML lớn hợp lệ | 1 ms | OK |
| jsonl 32K dòng hỏng | 351 → 728 → 1907 ms (64 → 128 → 256 KB) | gần tuyến tính, chấp nhận |
| **`<` + `<!`×n / `<?`×n / `<!--`×n** | **1,0 s (64 KB) → 6,8 s (128 KB) → 28 s (256 KB)** | **bậc hai: TB-1** |

**Luật khớp, score, group, guess, shape** khớp §8.2. Lệch so với thân spec đã ghi §16: UA tính là optional; format chỉ chặn khi có body. Header chung không sinh tên (T21 xanh).

Lỗ ở `guess` (T-f): User-Agent của thư viện HTTP và từ chung vẫn sinh tên.

## 4. `catalog.ts` fail-fast

- Dữ liệu được biên dịch vào bundle (`catalog.data.ts`), không đọc JSON lúc chạy. Production chỉ chết nếu **code** đổi (luật `validateGenericConfig` chặt hơn, adapter bị gỡ khỏi registry) mà dữ liệu chưa sửa.
- Trường hợp đó bị CI bắt trước: `[PK:T19]` import `CATALOG` và chạy trong `verify:unit` (`.github/workflows/verify.yml:59`). Test này cũng so `catalog.data.ts` với `renderCatalogData(entries)`, nên `catalog:build --check` không nằm trong CI cũng không sao.
- **Giữ fail-fast.** hub-worker không import catalog.

## 5. `GET /api/v1/catalog`

- Guard `SessionGuard` + `ProjectScopeGuard`, scope `read:project`, có test metadata.
- Đòi `?projectId=`. Dữ liệu là toàn cục nên điều kiện này dư nhưng vô hại.
- Không có fixture trong phản hồi (test).
- Kích thước 17,3 KB, gzip 3,9 KB; ước ~70 KB khi có 80 mục.
- Không có cache: **T-g**.

## 6. Web alias

- `@hub/providers/catalog` trỏ `catalog/index.ts` → `identify` + `types`, không kéo barrel.
- Không file web nào ngoài spec import `@hub/providers`.
- `catalog.spec.ts` (web) import `catalog/catalog`, nhưng spec bị loại khỏi tsconfig web và next build.

Đạt (kiểm tĩnh, không next build).

## 7. Bài A

- Chạy đủ mọi fixture của mọi mục, có kiểm mỗi mục ≥ 1 fixture đã chạy.
- Thực tế **mỗi fixture chỉ khớp đúng 1 mục**, trừ cặp svix/resend (`scratchpad/ties.js`). Vì vậy bài A không bao giờ gặp va chạm thật.
- Fixture "chỉ có header" (razorpay, shopify, woocommerce, svix, resend) **không làm sai kết quả**, vì fingerprint của các mục đó vốn chỉ dựa header. Nhưng chúng không phủ đường body. Shopify kèm body thật ra điểm 0,333, vẫn đứng đầu.
- Bài A gần như tự-tròn: fingerprint và fixture cùng một tác giả, cùng một nguồn. Xem **T-h**.

## Danh sách lỗi

### Trung bình

**TB-1. `identify` bậc hai với XML ác ý.**
- Vị trí: `libs/providers/src/catalog/identify.ts`, khối `t[0] === '<'`, chuỗi `replace(/<\?[\s\S]*?\?>/g)`, `/<!--[\s\S]*?-->/g`, `/<![^>]*>/g`.
- Kịch bản:
  - Trình duyệt: dev dán 64 KB → tab đơ ~1 s.
  - Server (PK6 ④, ADR-208 nói "server gọi cùng hàm"): kẻ biết `sourceKey` bắn vào source chế độ thu một body ≤ 1 MB (`MAX_INGEST_PAYLOAD_BYTES`) dạng `<<!<!<!…`. Khi dev bấm nhận diện, event loop hub-api bị chặn ước ~7 phút (đo 256 KB = 28 s, ×16).
- Đề xuất:
  1. Cắt input của `identify` ở 64 KB (`sample.slice(0, 65536)`; captured body cũng vậy). Đổi lại, bài A vẫn chạy được.
  2. Bỏ ba `replace`. Thay bằng một vòng quét tuyến tính: từ `indexOf('<')`, bỏ qua `<?…?>`, `<!--…-->`, `<!…>` bằng `indexOf` của dấu đóng (không có dấu đóng thì dừng, báo `problems`), rồi đọc tên thẻ.
  3. Thêm test thời gian: 1 MB `<!`×n < 200 ms.

**TB-2. GitLab: thiếu điều kiện phiên bản; self-managed bản cũ sẽ 401 hoặc 422 mãi.**
- Vị trí: `entries/gitlab.json`, `docsVersion: null` (dòng ~65); nhãn field dòng ~59.
- Kịch bản:
  - GitLab self-managed 18.x: không có `webhook-signature`, handler mặc định standard-webhooks → 401 mãi.
  - Bản < 17.4 dùng phương án phụ: không có `Idempotency-Key` → 422 mãi.
- Nguồn: docs.gitlab.com (WebFetch 2026-10-14): `webhook-*` và signing token từ 19.0 (GA 19.1); `Idempotency-Key` từ 17.4.
- Đề xuất:
  - `docsVersion: "signing token ≥ 19.0; Idempotency-Key ≥ 17.4"`.
  - `alternatives[0].note` nêu ngưỡng 17.4.
  - PK7 hiện câu này cạnh nút tạo.
  - Bản < 17.4 không có đường nào hợp lệ ngoài `bodyHash` (§2), hoặc ghi rõ "không hỗ trợ".

### Thấp

**T-a. `{id}` + ký tự ngăn cách vẫn dời được byte nếu id chứa chính ký tự đó** (`generic-config.ts:353`).
- Ví dụ: `{id}.{body}` với id `a.b`, cắt lại thành `a` + `b.{…}`.
- Cũng vậy với `{id}{timestamp}`, khi id chứa chữ số trùng tiền tố ts (brute-force ra 1 cách cắt).
- Body sau khi cắt luôn có tiền tố rác, nên tác động thực tế thấp: chỉ đổi khoá chống trùng sang id mới, kèm body hỏng.
- Đề xuất: ghi giới hạn vào ADR-204. Hoặc khi template có `{id}` không có `{timestamp}` thì đòi `idempotency` là `field` (thuộc body đã ký).

**T-b. Shopify chống trùng bằng `x-shopify-event-id`.**
- shopify.dev nói: "Use `X-Shopify-Webhook-Id` to deduplicate individual deliveries"; Event-Id dùng để gom các delivery của cùng hành động (nhiều subscription cùng topic). Trang cũng không cam kết Event-Id có mặt ở mọi webhook.
- Đề xuất: đổi sang `x-shopify-webhook-id` theo khuyến nghị chính chủ. Nếu cố ý "một hành động một event" thì ghi lý do vào ADR-208.

**T-c. WooCommerce gửi ping form `webhook_id=<id>` không chữ ký khi tạo webhook.**
- Nguồn: nghiên cứu, "chưa xác minh".
- Hub trả 401, Woo báo lỗi "Delivery URL returned 401", và mục cũng không nhận diện được (format `form` không nằm trong fingerprint).
- Đề xuất: ghi chú trong `fields[].label`, hoặc chờ PK4 rồi thêm bắt tay.

**T-d. Linear: chống phát lại chỉ dựa `webhookTimestamp` trong body, mà config `hmac` không kiểm được.**
- Hiện không có cửa sổ thời gian.
- Ghi vào ghi chú mục hoặc ADR. Về sau có thể dùng tham số "trường thời gian body + tol".

**T-e. S1 chống trùng bằng header không được ký** (shopify, woocommerce, razorpay, jira, linear).
- Ai bắt được một request có thể đổi header id để phát lại thành event mới, không giới hạn thời gian.
- GitHub native vốn đã như vậy, nên đây là đánh đổi chung, chưa có ADR nói rõ.
- Đề xuất: ghi vào ADR. Ưu tiên `field` (body đã ký) khi có, hoặc `bodyHash` (§2).

**T-f. `guess` sinh tên từ User-Agent thư viện HTTP và từ chung** (`identify.ts`, `nameFromUa`, `nameFromHeader`).

| Input | Tên đoán ra |
|---|---|
| `Go-http-client/1.1` | "Go Http" (hậu tố `-client` bị cắt trước khi so `GENERIC_UA`) |
| `Apache-HttpClient` | "Apache Http" |
| `Python/3.11 aiohttp` | "Python" |
| `ReactorNetty`, `RestSharp` | đều sinh tên |
| `x-client-signature` | "Client" |
| `x-payload-signature` | "Payload" |
| `x-timestamp-signature` | "Timestamp" |
| `x-custom-token` | "Custom" |
| `x-access-token` | "Access" |
| URL trả về của chính shop (`myshop.vn`) | "Myshop" |

- Đề xuất:
  - So `GENERIC_UA` trên chuỗi **trước** khi cắt hậu tố; thêm `go`, `python`, `reactornetty`, `restsharp`, `vert.x`.
  - Thêm `client`, `payload`, `timestamp`, `body`, `content`, `custom`, `access`, `shared` vào `STOP_NAMES`.
  - Thêm test T21 cho các trường hợp trên.

**T-g. `GET /api/v1/catalog` không có `Cache-Control`/`ETag`.**
- Dữ liệu chỉ đổi khi deploy.
- Đề xuất: `Cache-Control: private, max-age=300` + ETag = hash của `CATALOG_DATA`.

**T-h. Bài A chưa phủ va chạm.**
- Đề xuất: thêm khẳng định "fixture của mục X không đưa mục Y (khác group) lên **cùng điểm cao nhất**". Hiện hoà ngoài nhóm sẽ được phân xử bằng `req` rồi thứ tự chữ cái, và test vẫn xanh.

**T-i. Fixture github ghi `origin: official` nhưng chữ ký bị thay bằng số 0 và body bị rút gọn.**
- Nhãn đúng phải là "official (header), body rút gọn".
- Đề xuất: đổi thành `constructed` hoặc ghi rõ trong dòng `# origin`, để cột official không bị thổi phồng.

**T-j. `identify.ts`: `headers` là `{}` thường.**
- Header `constructor:` bị bỏ qua vì `'constructor' in {}` là true; `__proto__:` bị nuốt.
- Tên đoán không có trần độ dài: một header 64 KB sinh ra `guess.name` 64 KB.
- Đề xuất: `Object.create(null)` (hoặc `Map`); cắt tên đoán ≤ 32 ký tự.

Ghi nhận thêm (không tính lỗi): `shape` coi mọi header chứa `timestamp` là `signed-template`, nên Linear (`linear-timestamp`) bị gợi ý sai scheme. Đây chỉ là gợi ý khi không khớp danh mục.

## Pending nạp được ngay (chỉ cần dữ liệu + fixture)

**typeform.** Đã WebFetch 2026-10-14:
- `Typeform-Signature`, HMAC-SHA256 trên payload thô, base64, tiền tố `sha256=` (developers/webhooks/secure-your-webhooks).
- `event_id` cấp một, "Unique ID for the webhook. Automatically assigned by Typeform" (developers/webhooks/example-payload).
- Config: `{scheme:"hmac", header:"typeform-signature", prefix:"sha256=", algo:"sha256", encoding:"base64", idempotency:{field:"event_id"}}`.
- Fixture constructed: body mẫu chính thức `{event_id, event_type, form_response}`.

**Không thấy mục nào khác** nạp được mà không cần code:
- box: trang chữ ký không nêu `box-delivery-id` lẫn định dạng timestamp.
- circleci: trang tham chiếu 404.
- bitbucket: WebFetch không đọc được trang.

Các mục chỉ thiếu khoá chống trùng sẽ mở được hàng loạt khi có `idempotency: {bodyHash: true}` + ADR (§2). Điều kiện: từng mục phải đối chiếu "gửi lại đúng bytes", và google-drive bị loại. Danh sách: lemon-squeezy, clickup, calendly, brevo, haravan, docusign, pipedrive, squarespace, checkout-com, azure-devops, xendit, circleci.
