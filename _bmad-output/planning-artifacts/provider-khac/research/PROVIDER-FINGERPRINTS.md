# Dấu vân tay provider webhook — nghiên cứu cho PK2 (`identify()`)

> Ngày thu thập: **2026-10-13**. Người làm: agent nghiên cứu (chỉ đọc web).
> Dữ liệu máy đọc: [`provider-fingerprints.json`](provider-fingerprints.json) (91 mục, cùng nội dung với bảng và phần chi tiết bên dưới, phần chi tiết được sinh từ file JSON).
> Phục vụ: `SPEC-provider-khac.md` §4 (khuôn mục danh mục, `identify()`), §6 (PK3a `signed-template`), §7 (PK5 preset), §8 (PK6 GET + ack theo ngữ cảnh), §9 (PK4 chế độ thu).

**Quy ước độ tin cậy**
- `cao`: đã đọc trực tiếp trang tài liệu chính thức trong phiên.
- `trung bình`: chỉ đọc được một phần trang chính thức, hoặc đọc qua tóm tắt tìm kiếm của trang chính thức, SDK hay repo chính thức, hoặc ghép thêm nguồn thứ ba.
- `thấp`: chủ yếu dựa nguồn thứ ba hoặc không đọc được tài liệu.
- Trong một mục `cao`, chi tiết nào ghi **"chưa xác minh"** hoặc **"kiến thức chung"** là chưa đọc thấy trong phiên, **không được** đưa thẳng vào fixture hay entry. Muốn dùng thì phải đối chiếu lại tài liệu hoặc bắt request thật.
- Không ghi secret thật. Ví dụ khoá trong tài liệu, nếu có, đều đã lược.

---

## 1. Tóm tắt

- Đã ghi **91 provider**: 14 của Việt Nam (gồm 2 mục chưa xác minh được cơ chế ký), 77 quốc tế. Độ tin cậy: **61 cao, 24 trung bình, 6 thấp**.
- **S1 (HMAC trên body thô, chữ ký ở header) vẫn là đường truyền phủ nhiều nhất:** 32 provider mang mã S1, 29 trong đó lấy S1 làm cơ chế chính. Hub đã có `hmac-sha256` cho generic. Tuy vậy, theo ước lượng thô, config hiện tại chỉ bật được khoảng 60% số này, vì phần còn lại vướng một trong các biến thể sau: **sha1** (Vercel, Intercom, legacy GitHub), **tiền tố** (`sha256=`, `sha1=`, `v1=`, `hmac-sha256=`), **base64 thay vì hex**, **khoá phải giải mã hex/base64 trước khi HMAC** (Squarespace, Airtable, Adyen, Svix), hoặc **thuật toán ghi trong tiền tố** (Bitbucket/Jira/WebSub `method=sig`).
- **S4 (ký trên timestamp + body) đứng thứ hai về độ "đáng nối"**: 14 bên, gồm Stripe, Slack, Zoom, Paddle, Calendly, Zendesk, Box, Webflow, Twitch, HubSpot v3, Recurly, Sanity, cùng **SePay (HMAC mới)** và **Casso**. Cả nhóm chỉ khác nhau ở **3 tham số**: dấu phân cách (`.` `:` hoặc không có), vị trí timestamp (trước hay sau body), và chỗ đặt timestamp (header riêng hay khoá `t=` trong header chữ ký). Vì vậy một `signed-template` (PK3a) đủ tham số là phủ được gần hết nhóm này.
- **S7 (bắt tay lúc đăng ký) có ở 15 bên với ít nhất 6 biến thể khác nhau**: echo qua query GET (Meta, Dropbox, WebSub), echo qua body JSON (Slack, monday), echo qua header (Asana `X-Hook-Secret`), echo qua header kèm trả JSON (Okta), trả HMAC của token (Zoom), và **chủ động gọi ra ngoài** (AWS SNS `SubscribeURL`). Một cờ "challenge" chung không đủ cho cả nhóm này.
- **S8 (bất đối xứng hoặc verify qua API) có ở 15 bên.** Phần lớn thực chất là **"dataless"**: body chỉ chứa id, thật/giả do gọi API quyết định (Mollie, Dropbox, Airtable, BigCommerce, Google Drive, Gumroad, Render). Hub không chuẩn hoá được những bên này nếu không gọi ra ngoài.

### 5 phát hiện ảnh hưởng thiết kế nhiều nhất

1. **GitLab đã có Standard Webhooks.** Bên cạnh `X-Gitlab-Token` tĩnh, GitLab nay có *signing token* gửi `webhook-id` / `webhook-timestamp` / `webhook-signature` (`v1,base64`, ký `{id}.{ts}.{body}`). §4.3 đang xếp `gitlab` là `static-token`. Nên đổi sang `standard-webhooks` làm mặc định, giữ `static-token` làm phương án dự phòng. Đổi như vậy còn tạo va chạm với nhóm Svix/Render/Polar, nên `identify()` phải dùng `x-gitlab-event` để tách GitLab ra.
2. **SePay đã có HMAC kèm timestamp.** `X-SePay-Signature: sha256=<hex>` ký trên `{ts}.{raw_body}`, timestamp ở `X-SePay-Timestamp`, cửa sổ 300s lấy từ code mẫu. Adapter native hiện chỉ nhận `Authorization: Apikey`. Adapter này cần thêm nhánh S4. Đây là provider Việt Nam mà hub hỗ trợ native, vậy mà đang tụt sau tài liệu.
3. **Chữ ký không phủ toàn bộ body ở nhiều bên quan trọng.** Mailgun chỉ ký `timestamp+token`, nên `event-data` có thể bị sửa. MoMo, VNPay, PayOS, Adyen, ZaloPay ký trên **các trường đã parse** chứ không trên byte thô. Casso và Sentry ký trên **JSON đã chuẩn hoá lại** (Casso sắp xếp khoá; code mẫu của Sentry dùng `JSON.stringify(body)`). Các bên này không đi được bằng config HMAC-raw-body. Chúng phải dùng `preset` (PK5) và phải có fixture thật, nếu không sẽ trượt 1 byte.
4. **Ba bên ký cả URL nhận, gồm Twilio, Square và Trello (thêm HubSpot v3 ký method + URI).** Hub phải biết **URL công khai chính xác** mà provider gọi, tức URL sau cloudflared hoặc Render chứ không phải `req.url` nội bộ. Nên có một cấu hình kiểu `PUBLIC_BASE_URL` và một test riêng cho trường hợp này. Nếu không có, cả nhóm S6 sẽ báo "sai chữ ký" mà không ai hiểu vì sao.
5. **Giới hạn thời gian ACK rất chặt, và một số bên tự tắt webhook.** Sentry cho **1 giây**; Slack, Zoom, Graph, TikTok Shop và Okta cho **3 giây**; Shopify, Casso, KiotViet, Haravan, GHN và Linear cho 5 giây. Paddle SDK chỉ chấp nhận timestamp lệch **5 giây**. Về tự tắt: **KiotViet ngừng gửi ngay khi nhận 400/401/403/404/405**, nên lời khuyên "trả 401 khi sai chữ ký" trong chính tài liệu KiotViet là cái bẫy. Haravan và Shopify **xoá subscription** sau 19 và 8 lần lỗi liên tiếp. Woo tắt sau 5 lần. Render, Polar, Webflow, Zoom, GitLab, Airtable và Asana có ngưỡng riêng. Hệ quả cho Q4: ở chế độ thu (PK4) hub **phải trả 2xx**, và ingest không được trả 4xx cho lỗi chữ ký với các bên tự tắt. Nên có một cờ `failureResponse` theo từng entry.

Một số phát hiện phụ:
- `identify()` dựa "trường JSON cấp một" sẽ không nhận được những body không phải object JSON: **SendGrid và HubSpot gửi mảng**, **Auth0 gửi JSON lines**, **Wix gửi một chuỗi JWT**, **WebSub/YouTube gửi Atom XML**, **Google Drive gửi body rỗng** (mọi thông tin nằm ở header), còn **GHTK, Gumroad, Mailchimp, Braintree, PayPal IPN, Mollie và Twilio gửi form-urlencoded**.
- **AWS SNS gửi `Content-Type: text/plain`** dù body là JSON, nên parser không được dựa vào content-type.
- **Secret do provider gửi trong request đầu tiên** ở Notion (`verification_token`) và Asana (`X-Hook-Secret`). Dev không thể dán secret trước, nên đây đúng là ca dùng cho PK4 (chế độ thu).
- **Ba mã S10 thật sự đòi phản hồi nghiệp vụ đồng bộ**: VNPay (`RspCode`), ZaloPay (`return_code`) và Discord (interaction response). OnePay và Adobe Commerce cũng đòi nhưng mới ở mức chưa xác minh. MoMo đòi **204** thay vì 200.
- Code mẫu chính thức của **Vercel và PayOS so chữ ký bằng `!==`**, không constant-time. Điều này khớp với luật `timingSafeEqual` của dự án (ADR-058).

---

## 2. Thống kê S1..S10

Một provider có thể mang nhiều mã. Cột "chính" đếm mã đầu tiên trong `shapes`, tức cơ chế mặc định hoặc khuyến nghị.

| Mã | Ý nghĩa | Số provider mang mã | Chính | Hub hiện nối được? |
|---|---|---|---|---|
| S1 | HMAC trên body thô, chữ ký ở header | **32** | 29 | Có một phần (`hmac-sha256`). Thiếu sha1/sha512, tiền tố, base64, giải mã khoá, thuật toán trong tiền tố |
| S2 | Token tĩnh ở header / basic auth | **21** | 13 | Có (`static-token`). Basic auth và token nằm trong body (Graph `clientState`) cần thêm vị trí |
| S3 | Standard Webhooks / Svix | **6** | 5 | Đang làm (PK1.3) |
| S4 | HMAC trên timestamp (+id) + body | **14** | 13 | Chưa có, cần PK3a `signed-template` |
| S5 | HMAC trên các trường ghép theo thứ tự | **8** | 8 | Chưa có, cần PK5 preset (MoMo, VNPay) và native (PayOS) |
| S6 | HMAC trên URL + tham số | **4** | 4 | Chưa có (Twilio preset PK5). Cần biết URL công khai |
| S7 | Bắt tay lúc đăng ký | **15** | 3 | Chỉ có PayOS (native). Cần PK6 và nhiều biến thể |
| S8 | Bất đối xứng / verify qua API / dataless | **15** | 9 | Chưa có. Ed25519/RSA/ECDSA/JWT hoặc gọi ra ngoài |
| S9 | Không ký, chỉ dựa URL bí mật hoặc IP | **10** | 5 | Có, nhờ `sourceKey` trong URL đã là URL bí mật. Cần thêm scheme `none` minh bạch |
| S10 | Đòi phản hồi nghiệp vụ đồng bộ | **5** | 0 | Chưa có (PK6 "ack theo ngữ cảnh") |

Danh sách theo mã:
- **S1**: haravan, kiotviet, tiktok-shop, lemon-squeezy, adyen*, checkout-com, razorpay, shopify, woocommerce, github, bitbucket, jira, linear, sentry, vercel, netlify, circleci, heroku, meta, typeform, line, intercom, asana, dropbox, notion, airtable, clickup, docusign, coinbase-commerce, websub, squarespace, mailchimp
- **S2**: sepay*, ghn, adyen*, checkout-com*, xendit, chargebee, bigcommerce, gitlab, azure-devops, heroku*, telegram, microsoft-graph, postmark, monday, okta, docusign*, google-drive, supabase, pipedrive, brevo, auth0
- **S3**: polar, gitlab, render, resend, clerk, svix
- **S4**: sepay, casso, stripe, paddle, recurly, slack, zoom, hubspot, calendly, zendesk, twitch, box, webflow, sanity
- **S5**: payos, momo, vnpay, zalopay, onepay, braintree, adyen, mailgun
- **S6**: square, twilio, hubspot, trello
- **S7**: payos, slack, discord, microsoft-graph, zoom, meta, aws-sns, twitch, asana, trello, dropbox, notion, monday, okta, websub
- **S8**: paypal, paypal-ipn, mollie, bigcommerce, jira (Connect/OAuth JWT), discord, sendgrid, aws-sns, dropbox, airtable, plaid, wix, gumroad, google-drive, adobe-commerce
- **S9**: ghn, ghtk, mollie, chargebee, docker-hub, postmark, gumroad, mailchimp, supabase, brevo
- **S10**: vnpay, zalopay, onepay, discord, adobe-commerce
- Chưa xếp mã được (chưa xác minh): sapo, zalo-oa

(\* = phương án phụ của provider đó.)

**Nhận xét về độ phủ.** 49/91 provider (54%) mang S1 hoặc S2. Tính cả S3 và S4 (một `signed-template` tham số hoá) thì **67/91 (74%)** mang ít nhất một mã trong S1..S4; nếu chỉ tính cơ chế chính thì là 60/91 (66%). Phần còn lại cần code (S5, S6, S8) hoặc cần thay đổi ở lõi ingest (S7, S10).

---

## 3. Nhóm va chạm dấu vân tay

`identify()` phải trả **cả nhóm** khi chỉ khớp phần chung, rồi dùng các dấu tách dưới đây để phân định.

| Nhóm | Thành viên | Phần chung | Dấu tách |
|---|---|---|---|
| **Svix (`svix-*`)** | resend, clerk, svix (cùng mọi SaaS gửi qua Svix khác) | `svix-id`, `svix-timestamp`, `svix-signature` | Chỉ phân biệt được qua body: Resend có `created_at`; Clerk có `object:"event"` và `instance_id` (chưa xác minh). Nhiều khả năng **không tách được**, nên trả cả nhóm |
| **Standard Webhooks (`webhook-*`)** | polar, render, gitlab (signing token), svix (gói Pro) | `webhook-id`, `webhook-timestamp`, `webhook-signature` | GitLab có `x-gitlab-event`; Render có `webhook-id` dạng `evt-…` và body `{type,timestamp,data.serviceId}`; Polar có body `{type,data}`. **Xendit** cũng có `webhook-id` nhưng không có hai header kia |
| **`x-hub-signature`** | github (legacy `sha1=`), kiotviet, bitbucket, jira, intercom (`sha1=`), websub, meta (legacy) | tên header | GitHub có `x-github-event`; Bitbucket có `x-event-key`; Jira có `x-atlassian-webhook-identifier`; Intercom có body `type:"notification_event"`; KiotViet có body `Id/Attempt/Notifications`; WebSub có body Atom XML |
| **`x-hub-signature-256` + `sha256=` hex** | github, meta | tên header, tiền tố, encoding | GitHub có `x-github-event`, `x-github-delivery`, UA `GitHub-Hookshot/`; Meta có body `object` + `entry` |
| **`*-hmac-sha256` base64 trên raw body** | shopify, haravan, heroku | khuôn header | Tiền tố tên header: `x-shopify-`, `x-haravan-`, `heroku-webhook-` |
| **`x-signature` hex HMAC-SHA256** | lemon-squeezy, clickup (cùng kiểu đặt tên của nhiều bên nhỏ) | tên header và thuật toán | Lemon có body `meta`, `data`; ClickUp có body `event`, `webhook_id` |
| **Kiểu Stripe `t=…,v1=…` và `{t}.{body}`** | stripe, calendly, sanity (mô phỏng), casso (`t=,v1=` nhưng SHA-512 trên JSON đã sắp xếp) | định dạng header | Tên header khác nhau. Casso trông giống Stripe nhưng **verify khác hoàn toàn**, nên đặt riêng làm preset |
| **`v0:{ts}:{body}`** | slack, zoom | chuỗi ký | Header: `x-slack-*` và `x-zm-*` |
| **`authorization` mang bí mật** | sepay, tiktok-shop (là HMAC!), checkout-com, chargebee, azure-devops, heroku, postmark, okta, pipedrive, brevo, auth0, monday (JWT), docusign | tên header | Không dùng được để nhận diện. **TikTok Shop đặt HMAC hex vào `authorization`** nên dễ bị nhầm thành S2 |
| **Trường body `signature`** | payos (`signature` cấp một), mailgun (`signature` là object), momo (`signature`) | tên trường | PayOS có `code`, `desc`, `success`, `data`; MoMo có `partnerCode`, `resultCode`; Mailgun có `event-data` |
| **Form `id=` duy nhất** | mollie, woocommerce ping (`webhook_id=`) | form chỉ một trường | Tên trường |
| **`idempotency-key`** | gitlab, sanity | header | Header `sanity-*` hoặc `x-gitlab-*` |

Ghi chú cho `CANDIDATE_HEADER_RE`: những tên chung như `x-signature`, `x-webhook-signature` (Netlify), `authorization` và `signature` (trong body) không được coi là nhận diện. Chúng chỉ đủ để suy **khuôn** (`shape`).

---

## 4. Danh mục và bộ sưu tập công khai

| Nguồn | Nội dung | Giấy phép | Dùng lại được không |
|---|---|---|---|
| **Standard Webhooks spec** — github.com/standard-webhooks/standard-webhooks | Spec header `webhook-*`, chuỗi ký `msg_id.timestamp.payload`, `v1,` (HMAC) và `v1a,` (Ed25519), secret `whsec_`/`whsk_`/`whpk_` | **Apache-2.0** | **Có**, dẫn nguồn và giữ NOTICE. Nên trích spec làm tài liệu tham chiếu cho PK1.3 |
| **webhooks.fyi** — github.com/caseysoftware/webhooks.fyi | Thư mục "Webhook Directory", mỗi provider có cơ chế bảo mật (HMAC, asymmetric, mTLS, one-time verification…) | **MIT** (LICENSE.md) | **Có** về pháp lý. Dữ liệu ở dạng trang Markdoc, phải cào thủ công, chưa thấy file JSON. Dùng để đối chiếu, không dùng làm nguồn sự thật |
| **ngrok Traffic Policy `verify-webhook`** — ngrok.com/docs/traffic-policy/actions/verify-webhook/ | ~70 provider có verifier dựng sẵn (aftership, sns, bitbucket, box, calendly, clerk, coinbase, contentful, docusign, dropbox, facebook, github, gitlab, heroku, hubspot, intercom, jira, linear, mailchimp, mailgun, microsoft_teams, pagerduty, sendgrid, sentry, shopify, slack, square, stripe, svix, twilio, typeform, whatsapp, xero, zendesk, zoom…) | Tài liệu, **không nêu giấy phép**; code đóng | **Không chép được**. Dùng làm danh sách gợi ý "bên nào đáng có" |
| **Hookdeck Source Types** — hookdeck.com/docs/sources | ~190 mã source type (ADYEN, AIRTABLE, AWS_SNS, CHECKOUT_COM, LINEAR, PADDLE, POLAR, RAZORPAY, SHOPIFY, SLACK, STRIPE, TIKTOK_SHOP, WECHAT, WOOCOMMERCE, ZOOM…) và các bài "Guide to X webhooks" | **Không nêu giấy phép** | **Không chép được**. Các bài guide của Hookdeck là nguồn thứ ba, đã dùng cho Calendly, Checkout.com, Recurly, TikTok Shop và Pipedrive (ghi rõ trong `sources`) |
| **Svix docs** — docs.svix.com | Cách verify thủ công. Danh sách khách hàng không công khai dạng dữ liệu | Không nêu | Tham khảo |
| `@octokit/webhooks-methods`, `stripe-node` (đã có ADR-174) | Verifier chính thức | MIT | Đã dùng |

Kết luận: **không có bộ dữ liệu máy đọc nào vừa đủ mở vừa đủ chi tiết** để nạp thẳng. Chỉ có spec Standard Webhooks (Apache-2.0) và webhooks.fyi (MIT) là dùng lại được về pháp lý. File JSON đi kèm báo cáo này là dữ liệu tự thu, có link nguồn cho từng mục.

---

## 5. Không ghi hoặc chưa xác minh được

| Provider | Lý do |
|---|---|
| Spotify | Không có webhook công khai cho dev |
| Firebase | Không có webhook đi ra gốc (chỉ Extensions/Cloud Functions do dev tự viết) |
| Salesforce | Outbound Messages là SOAP/XML, ngoài phạm vi. Platform Events dùng CometD/Pub/Sub API, không phải webhook HTTP. Chưa thu thập |
| Freshdesk | Webhook trong Automation, header tuỳ chỉnh, không ký (kiến thức chung, **chưa xác minh**). Không ghi |
| Strapi | Tự host, header tuỳ chỉnh (kiến thức chung, chưa xác minh). Không ghi |
| Contentful | Trang `request-verification` trả 429 hai lần. Theo kiến thức chung có `x-contentful-signature` ký request chuẩn hoá (method, path, header được chọn, body), nhưng **chưa xác minh**, nên không ghi |
| Ecwid | Không tìm được tài liệu `X-Ecwid-Webhook-Signature` |
| Shopee Open Platform | Có Push Mechanism (HMAC-SHA256 trong `Authorization` trên `url|body` theo SDK cộng đồng), nhưng **không đọc được tài liệu chính thức** |
| Lazada Open Platform | Chưa tìm |
| Nhanh.vn | Không tìm thấy tài liệu webhook công khai |
| Viettel Post | Webhook key cấp qua liên hệ, không có tài liệu công khai (theo module Odoo cộng đồng) |
| Ngân Lượng, Bảo Kim | Chưa tìm được tài liệu IPN công khai đọc được trong phiên |
| Sapo, Zalo OA | **Có ghi** trong JSON nhưng `shapes: []` và `confidence: thấp`, vì không đọc được cơ chế ký |

---

## 6. Gợi ý cho spec (không phải quyết định, Admin chốt)

1. **Mở rộng `validateGenericConfig`** thêm các trường: `algo` (sha1|sha256|sha512), `encoding` (hex|base64), `prefix` (chuỗi, hoặc `method=` khi thuật toán nằm trong tiền tố), `keyEncoding` (utf8|hex|base64|whsec). Với bốn trường này, S1 phủ được khoảng 28/32 provider bằng config.
2. **`signed-template` (PK3a)** nên có 4 tham số: `timestampSource` (header riêng, hoặc khoá trong header chữ ký kiểu `t=`/`ts=`), `kvFormat` (`,` `=`, hoặc `;` `=`), `template` (`{ts}.{body}`, `v0:{ts}:{body}`, `{ts}:{body}`, `{id}{ts}{body}`, `{body}{ts}`), `toleranceSec`. Như vậy phủ được Stripe, Paddle, Slack, Zoom, Calendly, Webflow, Zendesk, Box, Twitch và SePay. HubSpot v3 thì không, vì ký cả URI (xếp vào S6).
3. **`ack` theo entry**: `successStatus` (200/204), `successBody` (JSON VNPay/ZaloPay/SePay `{success:true}`), `failureStatus` cho sai chữ ký (mặc định 401, nhưng KiotViet cần 2xx hoặc 5xx để không bị ngừng gửi). Bắt tay theo entry: `query-echo`, `body-echo`, `header-echo`, `hmac-echo`, `callout`.
4. **`identify()` nên parse được** mảng, JSON lines, form (gồm khoá lồng `data[...]`), XML (chỉ cần nhận diện thẻ gốc), body rỗng và JWT. Với body rỗng thì chỉ khớp header.
5. **Fixture `.http` thật dựng được từ tài liệu**, vì mẫu chính thức có kèm header: **ghtk, github, gitlab, circleci, microsoft-graph, aws-sns, twitch, google-drive**. Các bên khác chỉ có body mẫu, nên fixture cần bắt từ "Send test" thật qua PK4.

---

## 7. Bảng tổng (1 dòng / provider)

| # | id | Tên | Mã | Chữ ký (header · algo · enc · tiền tố) | Dấu vân tay bắt buộc | Khoá chống trùng | Mẫu kèm header | Tin cậy |
|---|---|---|---|---|---|---|---|---|
| 1 | `payos` | PayOS | S5+S7 | body.signature · hmac-sha256 · hex | B: code, desc, success, data | data.reference / data.orderCode (chưa có id sự kiện riêng) | không | cao |
| 2 | `sepay` | SePay | S4+S2 | `x-sepay-signature` · hmac-sha256 · hex · tiền tố sha256= | B: id, gateway, transactionDate, accountNumber | id | không | cao |
| 3 | `casso` | Casso | S4 | `x-casso-signature` · hmac-sha512 (repo mẫu gọi là SHA-512 có khoá) · hex | H: `x-casso-signature` · B: error, data | data.id | không | trung bình |
| 4 | `momo` | MoMo | S5 | body.signature · hmac-sha256 · hex | B: partnerCode, orderId, requestId, amount | transId (hoặc orderId+requestId) | không | cao |
| 5 | `vnpay` | VNPay | S5+S10 | query.vnp_SecureHash · hmac-sha512 · hex | Q: vnp_TmnCode, vnp_Amount, vnp_TxnRef | vnp_TransactionNo (hoặc vnp_TxnRef) | không | cao |
| 6 | `zalopay` | ZaloPay | S5+S10 | body.mac · hmac-sha256 mặc định (merchant đăng ký được thuật toán khác) · hex | B: data, mac, type | data.app_trans_id / data.zp_trans_id (trong chuỗi data) | không | cao |
| 7 | `ghn` | Giao Hàng Nhanh (GHN) | S9+S2 |  | B: OrderCode, Status, Type, ShopID | không có id sự kiện; ghép OrderCode+Status+Time | không | cao |
| 8 | `ghtk` | Giao Hàng Tiết Kiệm (GHTK) | S9 | query.hash | B: label_id, partner_id, status_id, action_time · Q: hash | không có; ghép label_id+status_id+action_time | có | cao |
| 9 | `haravan` | Haravan | S1 | `x-haravan-hmacsha256` · hmac-sha256 · base64 | H: `x-haravan-hmacsha256` | không nêu | không | cao |
| 10 | `kiotviet` | KiotViet | S1 | `x-hub-signature` · hmac-sha256 · chưa xác minh · tiền tố chưa xác minh | H: `x-hub-signature` · B: Id, Attempt, Notifications | Id (Attempt là số lần gửi) | không | cao |
| 11 | `sapo` | Sapo | — | chưa xác minh |  | chưa xác minh | không | thấp |
| 12 | `tiktok-shop` | TikTok Shop | S1 | `authorization` · hmac-sha256 · hex (thường) · tiền tố không có Bearer | H: `authorization` · B: type, shop_id, data, timestamp | tts_notification_id | ? | thấp |
| 13 | `zalo-oa` | Zalo Official Account | — | `x-zevent-signature (chưa xác minh)` · sha256 trên appId+data+timeStamp+OA secret (chưa xác minh — từ trí nhớ, không đọc được tài liệu) | B: app_id, event_name, timestamp | chưa xác minh | ? | thấp |
| 14 | `onepay` | OnePay | S5+S10 | query/form vpc_SecureHash · chưa xác minh (thường gặp: HMAC-SHA256 trên tham số vpc_ sắp xếp) · chưa xác minh | Q: vpc_SecureHash, vpc_MerchTxnRef, vpc_TxnResponseCode | vpc_MerchTxnRef (chưa xác minh) | ? | thấp |
| 15 | `stripe` | Stripe | S4 | `stripe-signature` · hmac-sha256 · hex | H: `stripe-signature` · B: id, object, type, created | id (evt_…); trường hợp 2 Event khác nhau: data.object.id + type | không | cao |
| 16 | `paypal` | PayPal (REST webhooks) | S8 | `paypal-transmission-sig` · SHA256withRSA (chứng chỉ tải từ paypal-cert-url) · base64 | H: `paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url` · B: id, event_type, resource_type, resource | H paypal-transmission-id (mỗi lần gửi) / body.id (sự kiện) | không | cao |
| 17 | `paypal-ipn` | PayPal IPN (legacy) | S8 | không ký; xác thực bằng POST ngược nguyên văn kèm cmd=_notify-validate, PayPal trả VERIFIED/INVALID | B: txn_id, payment_status, receiver_email | txn_id + payment_status (txn_id một mình không đủ) | không | cao |
| 18 | `paddle` | Paddle Billing | S4 | `paddle-signature` · hmac-sha256 · hex | H: `paddle-signature` · B: event_id, event_type, occurred_at, data | event_id (notification_id theo lần gửi) — tên trường body chưa xác minh trong phiên | ? | cao |
| 19 | `lemon-squeezy` | Lemon Squeezy | S1 | `x-signature` · hmac-sha256 · hex | H: `x-signature` · B: meta, data | chưa xác minh | ? | cao |
| 20 | `square` | Square | S6 | `x-square-hmacsha256-signature` · hmac-sha256 · base64 (mẫu kết thúc '=', trang không nói rõ) | H: `x-square-hmacsha256-signature` · B: merchant_id, type, event_id, created_at | event_id (chưa xác minh trong phiên) | không | trung bình |
| 21 | `braintree` | Braintree | S5 | form field bt_signature · HMAC-SHA1 (theo SDK; trang không nêu) · hex · tiền tố public_key\|chữ ký (theo SDK, chưa xác minh) | B: bt_signature, bt_payload | không có id riêng ngoài nội dung XML (chưa xác minh) | không | trung bình |
| 22 | `adyen` | Adyen | S5+S2+S1 | body notificationItems[].NotificationRequestItem.additionalData.hmacSignature · hmac-sha256, khoá hex-decode · base64 | B: live, notificationItems | pspReference + eventCode + success (chưa xác minh trong phiên) | không | cao |
| 23 | `checkout-com` | Checkout.com | S1+S2 | `cko-signature` · hmac-sha256 · hex | H: `cko-signature` · B: id, type, created_on, data | id (chưa xác minh trong phiên) | ? | trung bình |
| 24 | `mollie` | Mollie | S8+S9 | không ký (webhook cổ điển) — chỉ gửi id, dev tự GET API để lấy trạng thái thật | B: id | id (tr_…) + trạng thái lấy từ API | không | cao |
| 25 | `razorpay` | Razorpay | S1 | `x-razorpay-signature` · hmac-sha256 · hex | H: `x-razorpay-signature` · B: entity, event, payload | H x-razorpay-event-id | không | cao |
| 26 | `xendit` | Xendit | S2 | `x-callback-token` · so khớp token tĩnh lấy ở Dashboard | H: `x-callback-token` | id nghiệp vụ (payment_id, capture_id…) | ? | cao |
| 27 | `chargebee` | Chargebee | S2+S9 | header authorization (Basic) · basic auth username/password tuỳ chọn; hoặc khoá trong query URL | B: id, occurred_at, event_type, content | id (ev_…) | không | trung bình |
| 28 | `recurly` | Recurly | S4 | `recurly-signature` · hmac-sha256 · hex | H: `recurly-signature` · B: id, object_type, event_type | id | ? | trung bình |
| 29 | `polar` | Polar | S3 | `webhook-signature` · Standard Webhooks v1 (HMAC-SHA256) · base64 · tiền tố v1, | H: `webhook-id`, `webhook-timestamp`, `webhook-signature` · B: type, data | H webhook-id | ? | trung bình |
| 30 | `shopify` | Shopify | S1 | `x-shopify-hmac-sha256` · hmac-sha256 · base64 | H: `x-shopify-hmac-sha256` | H x-shopify-event-id (sự kiện) / x-shopify-webhook-id (lần gửi) | ? | cao |
| 31 | `woocommerce` | WooCommerce | S1 | `x-wc-webhook-signature` · hmac-sha256 · base64 | H: `x-wc-webhook-signature` | H x-wc-webhook-delivery-id (định dạng mâu thuẫn giữa các nguồn; chỉ dùng làm id) | không | trung bình |
| 32 | `bigcommerce` | BigCommerce | S2+S8 | header tuỳ chỉnh (headers object khi tạo webhook) · không ký; body 'thin' chỉ có id -> gọi API lấy dữ liệu | B: scope, store_id, data, hash | hash (SHA-1 của data, để phát hiện trùng) | không | trung bình |
| 33 | `github` | GitHub | S1 | `x-hub-signature-256` · hmac-sha256 · hex · tiền tố sha256= | H: `x-github-event`, `x-github-delivery` | H x-github-delivery (GUID) | có | cao |
| 34 | `gitlab` | GitLab | S2+S3 | `x-gitlab-token (token tĩnh, plain text)` | H: `x-gitlab-event` · B: object_kind | H webhook-id (= idempotency-key, giữ nguyên khi gửi lại) | có | cao |
| 35 | `bitbucket` | Bitbucket Cloud | S1 | `x-hub-signature` · hmac (hiện sha256, có thể đổi) · hex · tiền tố <method>= (vd sha256=) | H: `x-event-key` | H x-request-uuid (chưa xác minh trong phiên) | không | cao |
| 36 | `azure-devops` | Azure DevOps Service Hooks | S2 | header authorization (Basic) hoặc header HTTP tuỳ chỉnh · không ký nội dung | B: eventType, resource, publisherId | id (chưa xác minh trong phiên) | không | trung bình |
| 37 | `jira` | Jira Cloud (Atlassian) | S1+S8 | `x-hub-signature` · hmac (sha256 trong ví dụ) · hex · tiền tố <method>= | H: `x-atlassian-webhook-identifier` · B: timestamp, webhookEvent | H x-atlassian-webhook-identifier (giữ nguyên khi retry) | không | cao |
| 38 | `linear` | Linear | S1 | `linear-signature` · hmac-sha256 · hex | H: `linear-signature`, `linear-delivery`, `linear-event` · B: action, type, createdAt, webhookTimestamp | H linear-delivery (UUID v4) | không | cao |
| 39 | `sentry` | Sentry (Integration Platform) | S1 | `sentry-hook-signature` · hmac-sha256 · hex | H: `sentry-hook-resource`, `sentry-hook-signature` · B: action, installation, data, actor | H request-id | ? | cao |
| 40 | `vercel` | Vercel | S1 | `x-vercel-signature` · hmac-sha1 · hex | H: `x-vercel-signature` · B: id, type, createdAt, payload | id (id lần giao) | không | cao |
| 41 | `netlify` | Netlify (deploy notifications) | S1 | `x-webhook-signature` · JWS HS256; claim sha256 = SHA-256 hex của raw body; claim iss = netlify · JWT compact |  | id (deploy id; chưa xác minh) | không | cao |
| 42 | `render` | Render | S3 | `webhook-signature` · Standard Webhooks (HMAC-SHA256) · base64 · tiền tố v1, | H: `webhook-id`, `webhook-timestamp`, `webhook-signature` · B: type, timestamp, data | H webhook-id (evt-…, giữ nguyên khi retry) | không | cao |
| 43 | `circleci` | CircleCI | S1 | `circleci-signature` · hmac-sha256 · hex · tiền tố v1= (danh sách phân tách bởi dấu phẩy; chỉ kiểm v1) | H: `circleci-event-type` · B: id, type, happened_at, webhook | id | có | cao |
| 44 | `docker-hub` | Docker Hub | S9 | không ký, không xác thực | B: push_data, repository | không có; ghép repository.repo_name + push_data.tag + push_data.pushed_at | không | cao |
| 45 | `heroku` | Heroku App Webhooks | S1+S2 | `heroku-webhook-hmac-sha256` · hmac-sha256 · base64 | H: `heroku-webhook-hmac-sha256` · B: id, action, resource, data | webhook_metadata.event.id (delivery.id theo lần giao) | không | cao |
| 46 | `slack` | Slack (Events API / interactivity / slash commands) | S4+S7 | `x-slack-signature` · hmac-sha256 · hex · tiền tố v0= | H: `x-slack-signature`, `x-slack-request-timestamp` · B: type | event_id | không | cao |
| 47 | `discord` | Discord (Interactions endpoint) | S8+S7+S10 | `x-signature-ed25519` · Ed25519, khoá CÔNG KHAI của app · hex | H: `x-signature-ed25519`, `x-signature-timestamp` · B: type, application_id, token, id | id (interaction id) | không | cao |
| 48 | `telegram` | Telegram Bot API | S2 | `x-telegram-bot-api-secret-token` · so khớp token tĩnh (secret_token khi setWebhook, 1–256 ký tự A-Za-z0-9_-) | B: update_id | update_id (tăng dần) | không | cao |
| 49 | `microsoft-graph` | Microsoft Graph change notifications (Outlook/Teams/OneDrive/SharePoint) | S7+S2 | body value[].clientState · so khớp bí mật tĩnh clientState đặt lúc tạo subscription (S2 trong body); resource data mã hoá có validationTokens JWT (không đọc trong phiên) | B: value · Q: validationToken (chỉ lúc bắt tay) | value[].id (+subscriptionId) | có | cao |
| 50 | `zoom` | Zoom | S4+S7 | `x-zm-signature` · hmac-sha256 · hex · tiền tố v0= | H: `x-zm-signature`, `x-zm-request-timestamp` · B: event, payload | chưa xác minh (event + event_ts) | không | cao |
| 51 | `twilio` | Twilio | S6 | `x-twilio-signature` · hmac-sha1, khoá = Auth Token tài khoản · base64 | H: `x-twilio-signature` · B: AccountSid · Q: bodySHA256 (khi JSON) | MessageSid / CallSid (+ trạng thái) | không | cao |
| 52 | `sendgrid` | SendGrid Event Webhook | S8 | `x-twilio-email-event-webhook-signature` · ECDSA (khoá công khai do SendGrid cấp) · base64 |  | [].sg_event_id (chưa xác minh) | không | cao |
| 53 | `mailgun` | Mailgun | S5 | body.signature {timestamp, token, signature} · hmac-sha256, khoá Webhook Signing Key · hex | B: signature, event-data | event-data.id (chưa xác minh) / signature.token (khuyên cache để chống replay) | không | cao |
| 54 | `postmark` | Postmark | S2+S9 | Basic auth nhúng trong URL (user:pass@host) · không HMAC (tài liệu nói rõ) | B: RecordType | H x-pm-webhook-trace-id (giữ nguyên khi retry) hoặc MessageID | không | cao |
| 55 | `resend` | Resend | S3 | `svix-signature` · Svix v1 (HMAC-SHA256) · base64 · tiền tố v1, | H: `svix-id`, `svix-timestamp`, `svix-signature` · B: type, created_at, data | H svix-id | không | cao |
| 56 | `clerk` | Clerk | S3 | `svix-signature` · Svix v1 (HMAC-SHA256) · base64 · tiền tố v1, | H: `svix-id`, `svix-timestamp`, `svix-signature` · B: type, data | H svix-id | không | trung bình |
| 57 | `svix` | Svix (nền tảng gửi webhook, dùng bởi nhiều SaaS) | S3 | `svix-signature (hoặc webhook-signature với gói Pro/Enterprise)` · hmac-sha256, khoá = base64-decode phần sau whsec_ · base64 · tiền tố v1, (nhiều chữ ký cách nhau bằng dấu cách) | H: `svix-id`, `svix-timestamp`, `svix-signature` | H svix-id / webhook-id | không | cao |
| 58 | `meta` | Meta Webhooks (Facebook/Messenger/Instagram/WhatsApp Cloud API) | S1+S7 | `x-hub-signature-256` · sha256 với App Secret (trang không nói rõ HMAC; thực tế là HMAC-SHA256 — kiến thức chung) · hex · tiền tố sha256= | H: `x-hub-signature-256` · B: object, entry · Q: hub.mode, hub.challenge, hub.verify_token (chỉ khi bắt tay) | không có id sự kiện chung; entry[].id + entry[].time (+ messages[].id với WhatsApp) | không | cao |
| 59 | `aws-sns` | Amazon SNS (HTTP/S subscription) | S8+S7 | body.Signature · RSA; SignatureVersion 1 = SHA1, 2 = SHA256; chứng chỉ tải từ body.SigningCertURL (phải là domain SNS, HTTPS) · base64 | H: `x-amz-sns-message-type`, `x-amz-sns-message-id`, `x-amz-sns-topic-arn` · B: Type, MessageId, TopicArn, Timestamp | H x-amz-sns-message-id (giữ nguyên khi retry) | có | cao |
| 60 | `hubspot` | HubSpot | S6+S4 | `x-hubspot-signature-v3` · hmac-sha256, khoá client secret · base64 |  | [].eventId | không | cao |
| 61 | `typeform` | Typeform | S1 | `typeform-signature` · hmac-sha256 · base64 · tiền tố sha256= | H: `typeform-signature` · B: event_id, event_type, form_response | event_id (chưa xác minh trong phiên) | không | cao |
| 62 | `calendly` | Calendly | S4 | `calendly-webhook-signature` · hmac-sha256 · hex | H: `calendly-webhook-signature` · B: event, created_at, payload | chưa xác minh | ? | trung bình |
| 63 | `line` | LINE Messaging API | S1 | `x-line-signature` · hmac-sha256, khoá channel secret · base64 | H: `x-line-signature` · B: destination, events | events[].webhookEventId; events[].deliveryContext.isRedelivery | không | trung bình |
| 64 | `intercom` | Intercom | S1 | `x-hub-signature` · hmac-sha1, khoá client_secret của app · hex · tiền tố sha1= | H: `x-hub-signature` · B: type, topic, id, app_id | id (notification id) | không | trung bình |
| 65 | `zendesk` | Zendesk | S4 | `x-zendesk-webhook-signature` · hmac-sha256 · base64 | H: `x-zendesk-webhook-signature`, `x-zendesk-webhook-signature-timestamp` | H x-zendesk-webhook-invocation-id (chưa xác minh) | không | cao |
| 66 | `twitch` | Twitch EventSub | S4+S7 | `twitch-eventsub-message-signature` · hmac-sha256, khoá secret khai lúc tạo subscription · hex · tiền tố sha256= | H: `twitch-eventsub-message-id`, `twitch-eventsub-message-timestamp`, `twitch-eventsub-message-signature`, `twitch-eventsub-message-type` · B: subscription | H twitch-eventsub-message-id | có | cao |
| 67 | `asana` | Asana | S1+S7 | `x-hook-signature` · hmac-sha256, khoá = X-Hook-Secret nhận lúc bắt tay · hex (trang không nói rõ) | B: events | không có id sự kiện rõ; events[] gọn, phải gọi API | không | cao |
| 68 | `trello` | Trello | S6+S7 | `x-trello-webhook` · hmac-sha1, khoá app secret / OAuth2 client secret · base64 | H: `x-trello-webhook` · B: action, model, webhook | action.id (chưa xác minh trong phiên) | không | cao |
| 69 | `dropbox` | Dropbox | S1+S7+S8 | `x-dropbox-signature` · hmac-sha256, khoá app secret · hex | H: `x-dropbox-signature` · B: list_folder · Q: challenge (chỉ khi bắt tay) | không có; thông báo chỉ báo tài khoản nào đổi | không | cao |
| 70 | `box` | Box | S4 | `box-signature-primary / box-signature-secondary (2 khoá để xoay)` · hmac-sha256 · base64 | H: `box-delivery-timestamp` · B: trigger, source | H box-delivery-id (chưa xác minh trong phiên) | không | cao |
| 71 | `notion` | Notion | S1+S7 | `x-notion-signature` · hmac-sha256, khoá = verification_token · hex · tiền tố sha256= | H: `x-notion-signature` · B: type, entity, timestamp | id (chưa xác minh trong phiên) | không | cao |
| 72 | `airtable` | Airtable | S1+S8 | `x-airtable-content-mac` · hmac-sha256, khoá = base64-decode(macSecretBase64) · hex · tiền tố hmac-sha256= | H: `x-airtable-content-mac` · B: base, webhook, timestamp | không có; dùng transaction number khi gọi list payloads | không | cao |
| 73 | `monday` | monday.com | S7+S2 | header authorization · JWT ký bằng Signing Secret của app (chỉ khi webhook tạo bằng token app integration); webhook thường không ký | B: event | event.triggerUuid | không | cao |
| 74 | `clickup` | ClickUp | S1 | `x-signature` · hmac-sha256 · hex | H: `x-signature` · B: event, webhook_id | chưa xác minh | không | cao |
| 75 | `webflow` | Webflow | S4 | `x-webflow-signature` · hmac-sha256 · hex | B: triggerType, payload | payload.id (chưa xác minh) | không | cao |
| 76 | `sanity` | Sanity | S4 | `sanity-webhook-signature` · theo kiểu Stripe (HMAC-SHA256, t=…,v1=…) — chi tiết encoding chưa xác minh, dùng @sanity/webhook · chưa xác minh | H: `sanity-webhook-id`, `sanity-project-id`, `sanity-dataset` | H idempotency-key | không | trung bình |
| 77 | `plaid` | Plaid | S8 | `plaid-verification` · JWT ES256; khoá công khai lấy qua API /webhook_verification_key/get theo kid; claim request_body_sha256 = SHA-256 raw body; iat ≤ 5 phút · JWT | H: `plaid-verification` · B: webhook_type, webhook_code | chưa xác minh | ? | cao |
| 78 | `okta` | Okta Event Hooks | S2+S7 | header authorization · chuỗi bí mật tĩnh do dev chọn khi đăng ký (không HMAC trên trang đã đọc) | B: eventType, eventTypeVersion, cloudEventsVersion, source | eventId | không | cao |
| 79 | `docusign` | DocuSign Connect | S1+S2 | `x-docusign-signature-1 (… tới -100 khi có nhiều khoá)` · hmac-sha256 · base64 | H: `x-docusign-signature-1` · B: event, data | chưa xác minh | không | trung bình |
| 80 | `coinbase-commerce` | Coinbase Commerce | S1 | `x-cc-webhook-signature` · hmac-sha256, khoá shared secret · hex | H: `x-cc-webhook-signature` · B: event | event.id (chưa xác minh) | ? | trung bình |
| 81 | `websub` | WebSub / PubSubHubbub (YouTube push…) | S7+S1 | `x-hub-signature (chỉ khi subscriber gửi hub.secret)` · sha1/sha256/sha384/sha512 theo tiền tố (kiến thức về spec W3C — trang W3C trả 403 khi đọc) · hex · tiền tố <method>= | Q: hub.mode, hub.topic, hub.challenge | yt:videoId + updated trong Atom (YouTube) | không | trung bình |
| 82 | `squarespace` | Squarespace (Commerce webhooks) | S1 | `squarespace-signature` · hmac-sha256, khoá = hex-decode(secret) · hex | H: `squarespace-signature` · B: id, websiteId, subscriptionId, topic | id (chưa xác minh) | ? | trung bình |
| 83 | `wix` | Wix (app webhooks) | S8 | BODY là một JWT · RS256, khoá công khai lấy ở Dev Center (theo app) · JWT compact |  | chưa xác minh | không | trung bình |
| 84 | `gumroad` | Gumroad Ping | S9+S8 | không ký (không thấy tài liệu nhắc); xác thực bằng gọi sale API | B: sale_id, seller_id, product_id | sale_id | không | trung bình |
| 85 | `google-drive` | Google Drive push notifications (Workspace) | S2+S8 | `x-goog-channel-token` · so khớp token tĩnh do dev đặt khi watch (tuỳ chọn) | H: `x-goog-channel-id`, `x-goog-resource-id`, `x-goog-resource-state`, `x-goog-message-number` | H x-goog-channel-id + x-goog-message-number | có | cao |
| 86 | `mailchimp` | Mailchimp (audience webhooks) | S9+S1 | `x-mailchimp-signature (tuỳ chọn)` · HMAC (thuật toán/encoding chưa xác minh) | B: type, fired_at | không có; type + fired_at + data[id] | không | trung bình |
| 87 | `supabase` | Supabase Database Webhooks | S2+S9 | header tuỳ chỉnh do dev đặt · không ký | B: type, table, schema, record | không có; record.id + type | không | cao |
| 88 | `pipedrive` | Pipedrive | S2 | header authorization · Basic auth (http_auth_user/password khi tạo webhook); không HMAC | B: meta, data | meta.correlation_id / meta.attempt (v2) — chưa xác minh | không | trung bình |
| 89 | `brevo` | Brevo (Sendinblue) | S2+S9 | header authorization (Bearer token cấu hình qua API) hoặc Basic auth trong URL hoặc header tuỳ chỉnh · không ký | B: event, email | message-id + event (chưa xác minh) | không | trung bình |
| 90 | `auth0` | Auth0 (Log Streams - custom webhook) | S2 | header authorization · giá trị Authorization Token cấu hình, gửi nguyên văn; không ký |  | log_id | không | thấp |
| 91 | `adobe-commerce` | Adobe Commerce / Magento (Webhooks module) | S8+S10 | `x-adobe-commerce-webhook-signature` · RSA-SHA256 với cặp khoá sinh trong admin (tài liệu tự mâu thuẫn: ghi 'HMAC' nhưng code mẫu dùng createVerify + public key) · base64 |  | chưa xác minh | ? | thấp |

---

## 8. Chi tiết từng provider

> Sinh tự động từ `provider-fingerprints.json`. Trường nào ghi "chưa xác minh" thì chưa đọc thấy trong tài liệu ở phiên này.

### PayOS — `payos`

- **Alias:** payos, pay os, payos.vn · **Vùng:** VN · **Loại:** payment
- **Mã hình dạng:** S5, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: body.signature · algo: hmac-sha256 · encoding: hex · signedString: các trường của body.data sắp xếp a→z, key=value nối bằng & (null/undefined -> chuỗi rỗng, mảng -> JSON đã sort key)
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: code, desc, success, data, signature
- **Chống trùng:** data.reference / data.orderCode (chưa có id sự kiện riêng)
- **Bắt tay:** confirm-webhook: PayOS gọi thử URL khi đăng ký và đòi 200 (CLAUDE.md cạm bẫy 4; trang chữ ký không mô tả)
- **Ack / retry / tự tắt:** phản hồi: 2xx (chưa xác minh trên trang chữ ký)
- **Tài liệu:** https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Chữ ký nằm TRONG body, không ở header; ký trên trường đã parse (không phải byte thô). Payout dùng công thức khác (URL-encode giá trị). Hub đã có adapter native.
- **Nguồn:** <https://payos.vn/docs/tich-hop-webhook/kiem-tra-du-lieu-voi-signature/>

### SePay — `sepay`

- **Alias:** sepay, se pay, sepay.vn · **Vùng:** VN · **Loại:** bank-transfer
- **Mã hình dạng:** S4, S2 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-sepay-signature · algo: hmac-sha256 · encoding: hex · prefix: sha256= · signedString: {timestamp}.{raw_body} · timestampHeader: x-sepay-timestamp · toleranceSec: 300
- **Cơ chế phụ:** Authorization: Apikey <key> (S2); Authorization: Bearer <token> qua OAuth2 client_credentials; None (chỉ để test)
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-sepay-signature`, `x-sepay-timestamp`, `authorization` · body bắt buộc: id, gateway, transactionDate, accountNumber, transferType, transferAmount, referenceCode · body tuỳ chọn: code, content, accumulated, subAccount, description
- **Chống trùng:** id
- **Ack / retry / tự tắt:** phản hồi: HTTP 200/201 + JSON {"success": true} · timeout 30s · connect 5s · retry: tối đa 7 lần, khoảng cách Fibonacci, trong ≤ 5 giờ
- **Tài liệu:** https://developer.sepay.vn/en/sepay-webhooks/xac-thuc
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** SePay giờ có HMAC-SHA256 (khuyến nghị) với timestamp — adapter native hiện chỉ hỗ trợ Apikey. Cửa sổ 300s lấy từ code mẫu, không phải chính sách công bố.
- **Nguồn:** <https://docs.sepay.vn/tich-hop-webhooks.html> · <https://developer.sepay.vn/en/sepay-webhooks/xac-thuc>

### Casso — `casso`

- **Alias:** casso, casso.vn · **Vùng:** VN · **Loại:** bank-transfer
- **Mã hình dạng:** S4 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-casso-signature · algo: hmac-sha512 (repo mẫu gọi là SHA-512 có khoá) · encoding: hex · kv: t=<ts>,v1=<sig> · signedString: {t}.{JSON của body với key sắp xếp a→z} · timestampHeader: (trong header chữ ký, khoá t, mili-giây)
- **Cơ chế phụ:** Webhook cũ (legacy): khoá bảo mật gửi nguyên trong một header (S2) — tên header không ghi trong trang đã đọc
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-casso-signature` · body bắt buộc: error, data
- **Chống trùng:** data.id
- **Ack / retry / tự tắt:** phản hồi: HTTP 200; chế độ Strict đòi body có success = 1/true · timeout 5s · retry: 24 giờ, lần đầu sau 1 phút, giãn theo Fibonacci, ≤ 17 lần/sự kiện · **tự tắt:** lỗi liên tục 24h -> PAUSED (sự kiện mới HOLDING); PAUSED 7 ngày -> DISABLE
- **Tài liệu:** https://developer.casso.vn/webhook/thiet-lap-webhook-thu-cong (Webhook V2)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Ký trên JSON ĐÃ SẮP XẾP LẠI, không phải byte thô -> cần handler code, không config được. Chi tiết chữ ký lấy từ repo mẫu chính thức CassoHQ.
- **Nguồn:** <https://developer.casso.vn/webhook/thiet-lap-webhook-thu-cong> · <https://github.com/CassoHQ/casso-webhook-v2-verify-signature>

### MoMo — `momo`

- **Alias:** momo, ví momo, vi momo, momo ipn · **Vùng:** VN · **Loại:** wallet
- **Mã hình dạng:** S5 · **Độ tin cậy:** cao
- **Chữ ký:** location: body.signature · algo: hmac-sha256 · encoding: hex · signedString: accessKey=..&amount=..&extraData=..&message=..&orderId=..&orderInfo=..&orderType=..&partnerCode=..&payType=..&requestId=..&responseTime=..&resultCode=..&transId=.. (accessKey lấy từ cấu hình, KHÔNG có trong body)
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: partnerCode, orderId, requestId, amount, resultCode, transId, signature · body tuỳ chọn: orderInfo, orderType, message, payType, responseTime, extraData
- **Chống trùng:** transId (hoặc orderId+requestId)
- **Ack / retry / tự tắt:** phản hồi: HTTP 204 No Content, không cần body · timeout 15s · retry: không nêu
- **Tài liệu:** https://developers.momo.vn/v3/docs/payment/api/result-handling/notification (v3)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Mẫu là curl có JSON body. Ack đặc biệt 204 thay vì 200.
- **Nguồn:** <https://developers.momo.vn/v3/docs/payment/api/result-handling/notification> · <https://developers.momo.vn/v3/docs/payment/api/wallet/onetime>

### VNPay — `vnpay`

- **Alias:** vnpay, vn pay, vnpayment, cổng vnpay · **Vùng:** VN · **Loại:** payment
- **Mã hình dạng:** S5, S10 · **Độ tin cậy:** cao
- **Chữ ký:** location: query.vnp_SecureHash · algo: hmac-sha512 · encoding: hex · signedString: mọi tham số vnp_* trừ vnp_SecureHash/vnp_SecureHashType, sắp xếp tên tăng dần, name=value URL-encode, nối &
- **Dấu vân tay:** method GET · content-type — · query: vnp_TmnCode, vnp_Amount, vnp_TxnRef, vnp_TransactionNo, vnp_ResponseCode, vnp_TransactionStatus, vnp_SecureHash · query tuỳ chọn: vnp_BankCode, vnp_BankTranNo, vnp_CardType, vnp_PayDate, vnp_OrderInfo, vnp_SecureHashType
- **Chống trùng:** vnp_TransactionNo (hoặc vnp_TxnRef)
- **Ack / retry / tự tắt:** phản hồi: HTTP 200 + JSON {RspCode, Message}: 00 xác nhận, 01 không thấy đơn, 02 đã xác nhận, 04 sai số tiền, 97 sai chữ ký, 99 lỗi khác · retry: dừng khi 00/02; còn lại hoặc timeout -> gọi lại, tổng ≤ 10 lần, cách 5 phút
- **Tài liệu:** https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html (2.1.0)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** GET + query, không body. Mã RspCode quyết định VNPay có gọi lại không -> hub phải trả lời nghiệp vụ đồng bộ (S10).
- **Nguồn:** <https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html>

### ZaloPay — `zalopay`

- **Alias:** zalopay, zalo pay, ví zalopay · **Vùng:** VN · **Loại:** wallet
- **Mã hình dạng:** S5, S10 · **Độ tin cậy:** cao
- **Chữ ký:** location: body.mac · algo: hmac-sha256 mặc định (merchant đăng ký được thuật toán khác) · encoding: hex · signedString: chuỗi body.data nguyên văn (data là JSON dạng chuỗi), khoá key2
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: data, mac, type
- **Chống trùng:** data.app_trans_id / data.zp_trans_id (trong chuỗi data)
- **Ack / retry / tự tắt:** phản hồi: JSON {return_code: 1 thành công | 2 thất bại, return_message}; code mẫu trả 0 khi lỗi để ZaloPay gọi lại (≤ 3 lần) · retry: ≤ 3 lần (theo comment code mẫu); không nhận sau 15 phút -> tự gọi QueryOrder
- **Tài liệu:** https://docs.zalopay.vn/docs/developer-tools/knowledge-base/callback/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Ký trên một trường chuỗi, không trên cả body -> gần S1 nhưng vị trí chữ ký ở body. ZOD dùng returnCode/returnMessage.
- **Nguồn:** <https://docs.zalopay.vn/docs/developer-tools/knowledge-base/callback/>

### Giao Hàng Nhanh (GHN) — `ghn`

- **Alias:** ghn, giao hang nhanh, giao hàng nhanh · **Vùng:** VN · **Loại:** shipping
- **Mã hình dạng:** S9, S2 · **Độ tin cậy:** cao
- **Chữ ký:** notes: Không ký. Có thể cấu hình header tuỳ chỉnh (vd token) khi đăng ký webhook -> S2 nếu dev đặt.
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: OrderCode, Status, Type, ShopID, Time · body tuỳ chọn: ClientOrderCode, CODAmount, Weight, PaymentType, Fee
- **Chống trùng:** không có id sự kiện; ghép OrderCode+Status+Time
- **Ack / retry / tự tắt:** phản hồi: 2xx bất kỳ · timeout 5s · timeout cấu hình 1–60s · retry: 1–5 lần cấu hình được; 5xx/408/429/timeout -> backoff 30s → 12h; 4xx khác bỏ không gửi lại
- **Tài liệu:** https://developer.ghn.vn/en/docs/webhook/callback-order-status
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Trường PascalCase là dấu vân tay mạnh (26 khoá luôn có mặt).
- **Nguồn:** <https://developer.ghn.vn/en/docs/webhook/callback-order-status>

### Giao Hàng Tiết Kiệm (GHTK) — `ghtk`

- **Alias:** ghtk, giao hang tiet kiem, giao hàng tiết kiệm · **Vùng:** VN · **Loại:** shipping
- **Mã hình dạng:** S9 · **Độ tin cậy:** cao
- **Chữ ký:** location: query.hash · notes: URL callback có ?hash=XXX; tài liệu không giải thích cách sinh/kiểm -> coi như URL bí mật.
- **Dấu vân tay:** method POST · content-type application/x-www-form-urlencoded · body bắt buộc: label_id, partner_id, status_id, action_time · body tuỳ chọn: reason_code, reason, weight, fee, return_part_package · query: hash
- **Chống trùng:** không có; ghép label_id+status_id+action_time
- **Ack / retry / tự tắt:** phản hồi: chỉ HTTP 200 · retry: gửi lại 1 lần nếu không phải 200
- **Tài liệu:** http://api.ghtk.vn/en/docs/submit-order/webhook/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** có
- **Ghi chú:** Một trong ít mẫu có dòng đầu + header (POST /updateShipment?hash=XXX, Content-Type form) -> dựng fixture .http được. Body FORM, không JSON.
- **Nguồn:** <http://api.ghtk.vn/en/docs/submit-order/webhook/> · <https://pro-docs.ghtk.vn/5_webhook/>

### Haravan — `haravan`

- **Alias:** haravan · **Vùng:** VN · **Loại:** ecommerce
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-haravan-hmacsha256 · algo: hmac-sha256 · encoding: base64 · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-haravan-hmacsha256` · body tuỳ chọn: org_id, topic
- **Chống trùng:** không nêu
- **Ack / retry / tự tắt:** phản hồi: 2xx (3xx tính là lỗi, không theo redirect); sai HMAC nên trả 401 · timeout 5s · retry: 19 lần trong 48 giờ · **tự tắt:** 19 lần lỗi liên tiếp -> XOÁ subscription + email chủ shop
- **Tài liệu:** https://docs.haravan.com/docs/tutorials/webhooks/private-webhook/
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Bản sao kiểu Shopify (HMAC base64 trên raw body). Chỉ có code PHP mẫu, không có payload mẫu kèm header.
- **Nguồn:** <https://docs.haravan.com/docs/tutorials/webhooks/private-webhook/> · <https://github.com/Haravan/haravan-validate>

### KiotViet — `kiotviet`

- **Alias:** kiotviet, kiot viet · **Vùng:** VN · **Loại:** pos
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-hub-signature · algo: hmac-sha256 · encoding: chưa xác minh · prefix: chưa xác minh · signedString: raw body, khoá = Secret (chuỗi ≥ 8 ký tự đã base64 khi đăng ký)
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-hub-signature` · body bắt buộc: Id, Attempt, Notifications
- **Chống trùng:** Id (Attempt là số lần gửi)
- **Ack / retry / tự tắt:** phản hồi: không nêu body; phải trả trong 5s · timeout 5s · retry: có (trường Attempt) · **tự tắt:** trả 400/401/403/404/405 -> KiotViet NGỪNG gửi tới endpoint
- **Tài liệu:** https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/ (Public API Retail §2.11)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Dùng tên header x-hub-signature như GitHub cũ nhưng KHÔNG có tiền tố sha1= rõ ràng -> va chạm nhóm x-hub-signature. Cẩn thận: trả 401 khi sai chữ ký (như tài liệu khuyên) sẽ làm KiotViet ngừng gửi.
- **Nguồn:** <https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/>

### Sapo — `sapo`

- **Alias:** sapo, sapo.vn, sapo omni · **Vùng:** VN · **Loại:** ecommerce
- **Mã hình dạng:** chưa xếp (chưa xác minh) · **Độ tin cậy:** thấp
- **Chữ ký:** location: chưa xác minh · notes: API webhook kiểu Shopify (topic orders/create, /admin/webhooks); header chữ ký không tìm thấy trong tài liệu công khai.
- **Dấu vân tay:** method POST · content-type application/json (hoặc XML)
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://support.sapo.vn/sapo-webhook
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Chưa xác minh cơ chế ký. Không vào danh mục cho tới khi có fixture thật.
- **Nguồn:** <https://support.sapo.vn/sapo-webhook>

### TikTok Shop — `tiktok-shop`

- **Alias:** tiktok shop, tiktokshop, tts · **Vùng:** global/VN · **Loại:** marketplace
- **Mã hình dạng:** S1 · **Độ tin cậy:** thấp
- **Chữ ký:** location: header · header: authorization · algo: hmac-sha256 · encoding: hex (thường) · prefix: không có Bearer · signedString: {app_key}{raw_body}, khoá app_secret
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `authorization` · body bắt buộc: type, shop_id, data, timestamp · body tuỳ chọn: tts_notification_id
- **Chống trùng:** tts_notification_id
- **Ack / retry / tự tắt:** phản hồi: HTTP 200 body rỗng trong 3s · timeout 3s
- **Tài liệu:** https://partner.tiktokshop.com/docv2/page/tts-webhooks-overview
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Nguồn là Hookdeck (bên thứ ba). Tiền tố app_key trước body -> không phải HMAC thuần raw body. Khác hẳn TikTok for Developers (header TikTok-Signature).
- **Nguồn:** <https://hookdeck.com/webhooks/platforms/guide-to-tiktok-shop-webhooks-features-and-best-practices>

### Zalo Official Account — `zalo-oa`

- **Alias:** zalo, zalo oa, zalo official account · **Vùng:** VN · **Loại:** messaging
- **Mã hình dạng:** chưa xếp (chưa xác minh) · **Độ tin cậy:** thấp
- **Chữ ký:** location: header (chưa xác minh) · header: x-zevent-signature (chưa xác minh) · algo: sha256 trên appId+data+timeStamp+OA secret (chưa xác minh — từ trí nhớ, không đọc được tài liệu)
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: app_id, event_name, timestamp · body tuỳ chọn: user_id_by_app, sender, recipient, message
- **Chống trùng:** chưa xác minh
- **Bắt tay:** xác thực domain khi khai báo webhook URL (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developers.zalo.me/docs/official-account/webhook/tong-quan
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Trang tài liệu render bằng JS, không đọc được. Zalo Bot API (sản phẩm khác) dùng header X-Bot-Api-Secret-Token (S2) theo docs.openclaw.ai (bên thứ ba).
- **Nguồn:** <https://developers.zalo.me/docs/official-account/webhook/tong-quan>

### OnePay — `onepay`

- **Alias:** onepay, one pay, cổng onepay · **Vùng:** VN · **Loại:** payment
- **Mã hình dạng:** S5, S10 · **Độ tin cậy:** thấp
- **Chữ ký:** location: query/form vpc_SecureHash · algo: chưa xác minh (thường gặp: HMAC-SHA256 trên tham số vpc_ sắp xếp) · encoding: chưa xác minh
- **Dấu vân tay:** method GET hoặc POST (chưa xác minh) · content-type — · query: vpc_SecureHash, vpc_MerchTxnRef, vpc_TxnResponseCode
- **Chống trùng:** vpc_MerchTxnRef (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: body text responsecode=1&desc=confirm-success (thấy trong code plugin woo-viet, không phải tài liệu OnePay)
- **Tài liệu:** https://mtf.onepay.vn/developer/resource/documents/docx/quy_trinh_tich_hop-noidia.pdf
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Họ VPC (giống MIGS). Không đọc được tài liệu chính thức về IPN trong phiên.
- **Nguồn:** <https://mtf.onepay.vn/developer/resource/documents/docx/quy_trinh_tich_hop-noidia.pdf> · <https://hedgedoc.thuanbui.me/10h30/woo-viet/commit/4f73556b278a1eddc0912e9febeda4b012be37dd>

### Stripe — `stripe`

- **Alias:** stripe · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S4 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: stripe-signature · algo: hmac-sha256 · encoding: hex · kv: t=<ts>,v1=<sig>[,v1=<sig2>][,v0=<test>] · signedString: {t}.{raw_body} · timestampHeader: (khoá t trong stripe-signature, giây) · toleranceSec: 300
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `stripe-signature` · User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks) — chưa xác minh trong phiên · body bắt buộc: id, object, type, created, data · body tuỳ chọn: api_version, livemode, pending_webhooks, request, context
- **Chống trùng:** id (evt_…); trường hợp 2 Event khác nhau: data.object.id + type
- **Ack / retry / tự tắt:** phản hồi: 2xx nhanh; 3xx tính lỗi · retry: live: tới 3 ngày, backoff mũ; sandbox: 3 lần trong vài giờ · **tự tắt:** chưa xác minh trong phiên
- **Tài liệu:** https://docs.stripe.com/webhooks (API 2026-09-30.preview (trang có Thin/Snapshot events))
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Secret whsec_ (trùng tiền tố Standard Webhooks nhưng KHÔNG phải SW). Xoay secret: nhiều v1 trong 24h. Thin events (v2) cùng header. Hub đã có adapter native.
- **Nguồn:** <https://docs.stripe.com/webhooks>

### PayPal (REST webhooks) — `paypal`

- **Alias:** paypal, pay pal · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S8 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: paypal-transmission-sig · algo: SHA256withRSA (chứng chỉ tải từ paypal-cert-url) · encoding: base64 · signedString: {paypal-transmission-id}|{paypal-transmission-time}|{webhookId}|{crc32 thập phân của raw body} · timestampHeader: paypal-transmission-time
- **Verify thay thế:** POST /v1/notifications/verify-webhook-signature (postback, gửi lại webhook_event nguyên văn)
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url` · header tuỳ chọn: `paypal-auth-algo` · body bắt buộc: id, event_type, resource_type, resource, create_time · body tuỳ chọn: event_version, summary, links, resource_version
- **Chống trùng:** header paypal-transmission-id (mỗi lần gửi) / body.id (sự kiện)
- **Ack / retry / tự tắt:** phản hồi: 2xx, HTTPS cổng 443 · retry: tới 25 lần trong 3 ngày
- **Tài liệu:** https://developer.paypal.com/api/rest/webhooks/rest/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Cần webhookId (do PayPal cấp) như một 'secret' không bí mật + tải chứng chỉ qua mạng -> hub phải whitelist domain cert-url. paypal-auth-algo: trang chỉ ghi auth_algo trong postback, tên header là kiến thức chung (chưa xác minh).
- **Nguồn:** <https://developer.paypal.com/api/rest/webhooks/rest/>

### PayPal IPN (legacy) — `paypal-ipn`

- **Alias:** paypal ipn, ipn · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S8 · **Độ tin cậy:** cao
- **Chữ ký:** algo: không ký; xác thực bằng POST ngược nguyên văn kèm cmd=_notify-validate, PayPal trả VERIFIED/INVALID
- **Dấu vân tay:** method POST · content-type application/x-www-form-urlencoded · body bắt buộc: txn_id, payment_status, receiver_email · body tuỳ chọn: mc_gross, mc_currency, ipn_track_id, verify_sign
- **Chống trùng:** txn_id + payment_status (txn_id một mình không đủ)
- **Ack / retry / tự tắt:** phản hồi: HTTP 200 body rỗng trong 30s · timeout 30s · retry: tới 4 ngày, tối đa 15 lần
- **Tài liệu:** https://developer.paypal.com/api/nvp-soap/ipn/IPNIntro/ (legacy NVP/SOAP)
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Verify cần gọi mạng ra PayPal -> không làm được trong đường ingest đồng bộ nếu muốn 0 mạng.
- **Nguồn:** <https://developer.paypal.com/api/nvp-soap/ipn/IPNIntro/>

### Paddle Billing — `paddle`

- **Alias:** paddle · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S4 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: paddle-signature · algo: hmac-sha256 · encoding: hex · kv: ts=<ts>;h1=<sig> (có thể nhiều h1 khi xoay secret) · signedString: {ts}:{raw_body} · timestampHeader: (khoá ts trong paddle-signature) · toleranceSec: 5
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `paddle-signature` · body bắt buộc: event_id, event_type, occurred_at, data · body tuỳ chọn: notification_id
- **Chống trùng:** event_id (notification_id theo lần gửi) — tên trường body chưa xác minh trong phiên
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh trong phiên
- **Tài liệu:** https://developer.paddle.com/webhooks/signature-verification
- **Payload mẫu chính thức:** có · **mẫu kèm header:** ?
- **Ghi chú:** Dấu phân cách là ';' và ':' (khác Stripe ',' và '.'). Cửa sổ SDK chỉ 5 GIÂY — chặt nhất danh mục. Secret tiền tố pdl_ntfset_. Paddle Classic (alerts, RSA p_signature) là sản phẩm cũ, không ghi ở đây.
- **Nguồn:** <https://developer.paddle.com/webhooks/signature-verification>

### Lemon Squeezy — `lemon-squeezy`

- **Alias:** lemon squeezy, lemonsqueezy, ls · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-signature · algo: hmac-sha256 · encoding: hex · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-signature` · header tuỳ chọn: `x-event-name (chưa xác minh trong phiên)` · body bắt buộc: meta, data
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://docs.lemonsqueezy.com/help/webhooks/signing-requests
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Header x-signature quá chung -> va chạm (nhóm 'x-signature'). Cần kèm body meta.event_name để phân biệt.
- **Nguồn:** <https://docs.lemonsqueezy.com/help/webhooks/signing-requests>

### Square — `square`

- **Alias:** square, squareup · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S6 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-square-hmacsha256-signature · algo: hmac-sha256 · encoding: base64 (mẫu kết thúc '=', trang không nói rõ) · signedString: notification URL + raw body (thứ tự ghép theo SDK; trang không nêu)
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-square-hmacsha256-signature` · header tuỳ chọn: `square-version (chưa xác minh)` · body bắt buộc: merchant_id, type, event_id, created_at, data
- **Chống trùng:** event_id (chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: 200 (ví dụ); 403 khi sai chữ ký
- **Tài liệu:** https://developer.squareup.com/docs/webhooks/step3validate
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Ký trên URL nhận + body -> hub phải biết URL CÔNG KHAI chính xác (sau tunnel/proxy) -> cùng vấn đề Twilio. Trường body lấy theo kiến thức chung, chưa xác minh.
- **Nguồn:** <https://developer.squareup.com/docs/webhooks/step3validate>

### Braintree — `braintree`

- **Alias:** braintree · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S5 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: form field bt_signature · algo: HMAC-SHA1 (theo SDK; trang không nêu) · encoding: hex · prefix: public_key|chữ ký (theo SDK, chưa xác minh) · signedString: bt_payload (base64 của XML)
- **Dấu vân tay:** method POST · content-type application/x-www-form-urlencoded · body bắt buộc: bt_signature, bt_payload
- **Chống trùng:** không có id riêng ngoài nội dung XML (chưa xác minh)
- **Bắt tay:** Kiểm tra URL khi tạo webhook: GET với bt_challenge (theo kiến thức chung, chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 30s · timeout 30s · retry: mỗi giờ, tới 3h (sandbox) / 24h (production)
- **Tài liệu:** https://developer.paypal.com/braintree/docs/guides/webhooks/parse
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Payload là XML base64 trong form -> cần handler code (preset).
- **Nguồn:** <https://developer.paypal.com/braintree/docs/guides/webhooks/parse>

### Adyen — `adyen`

- **Alias:** adyen · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S5, S2, S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: body notificationItems[].NotificationRequestItem.additionalData.hmacSignature · algo: hmac-sha256, khoá hex-decode · encoding: base64 · signedString: pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success (rỗng -> chuỗi rỗng)
- **Cơ chế phụ:** Basic auth (cấu hình được) — S2; Webhook không phải thanh toán: header hmacsignature + protocol: HmacSHA256 trên raw body — S1
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `authorization`, `hmacsignature`, `protocol` · body bắt buộc: live, notificationItems
- **Chống trùng:** pspReference + eventCode + success (chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: trang HMAC không nêu; kiến thức chung: trả body [accepted] (chưa xác minh)
- **Tài liệu:** https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Một request có thể gom nhiều notificationItems, mỗi item có chữ ký riêng -> 1 HTTP = N sự kiện.
- **Nguồn:** <https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures.md>

### Checkout.com — `checkout-com`

- **Alias:** checkout.com, checkout com, cko · **Vùng:** global · **Loại:** payment
- **Mã hình dạng:** S1, S2 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: cko-signature · algo: hmac-sha256 · encoding: hex · signedString: raw body
- **Cơ chế phụ:** authorization: khoá tĩnh cấu hình (S2)
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `cko-signature` · header tuỳ chọn: `authorization` · body bắt buộc: id, type, created_on, data · body tuỳ chọn: _links
- **Chống trùng:** id (chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://www.checkout.com/docs/workflows/set-up-your-webhook-receiver
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Thông tin chữ ký đối chiếu tóm tắt tìm kiếm từ trang chính thức + Hookdeck.
- **Nguồn:** <https://www.checkout.com/docs/workflows/set-up-your-webhook-receiver> · <https://hookdeck.com/webhooks/platforms/guide-to-checkout-com-webhooks-features-and-best-practices>

### Mollie — `mollie`

- **Alias:** mollie · **Vùng:** EU · **Loại:** payment
- **Mã hình dạng:** S8, S9 · **Độ tin cậy:** cao
- **Chữ ký:** algo: không ký (webhook cổ điển) — chỉ gửi id, dev tự GET API để lấy trạng thái thật
- **Dấu vân tay:** method POST · content-type application/x-www-form-urlencoded · body bắt buộc: id
- **Chống trùng:** id (tr_…) + trạng thái lấy từ API
- **Ack / retry / tự tắt:** phản hồi: 200 OK trong 15s (200 trễ vẫn tính lỗi); 301/302 làm mất payload · timeout 15s · retry: 10 lần, giãn dần, ~26 giờ
- **Tài liệu:** https://docs.mollie.com/reference/webhooks (classic; next-gen đang beta)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Mẫu 'dataless notification': body chỉ có id -> hub không chuẩn hoá được gì nếu không gọi API Mollie. Next-gen (beta) có chữ ký — chưa xác minh.
- **Nguồn:** <https://docs.mollie.com/reference/webhooks>

### Razorpay — `razorpay`

- **Alias:** razorpay · **Vùng:** IN · **Loại:** payment
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-razorpay-signature · algo: hmac-sha256 · encoding: hex · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-razorpay-signature` · header tuỳ chọn: `x-razorpay-event-id` · body bắt buộc: entity, event, payload · body tuỳ chọn: account_id, contains, created_at
- **Chống trùng:** header x-razorpay-event-id
- **Ack / retry / tự tắt:** phản hồi: 2xx (chưa xác minh trong phiên) · retry: chưa xác minh · **tự tắt:** chưa xác minh
- **Tài liệu:** https://razorpay.com/docs/webhooks/validate-test/
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** không
- **Ghi chú:** Trường body cấp một theo kiến thức chung (entity:'event'), chưa xác minh.
- **Nguồn:** <https://razorpay.com/docs/webhooks/validate-test/>

### Xendit — `xendit`

- **Alias:** xendit · **Vùng:** SEA · **Loại:** payment
- **Mã hình dạng:** S2 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-callback-token · algo: so khớp token tĩnh lấy ở Dashboard
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-callback-token` · header tuỳ chọn: `webhook-id (chưa xác minh)`
- **Chống trùng:** id nghiệp vụ (payment_id, capture_id…)
- **Ack / retry / tự tắt:** phản hồi: 2xx nhanh · retry: tới 6 lần, backoff mũ
- **Tài liệu:** https://docs.xendit.co/docs/handling-webhooks
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Thanh toán phổ biến ở Indonesia/Philippines; S2 thuần.
- **Nguồn:** <https://docs.xendit.co/docs/handling-webhooks>

### Chargebee — `chargebee`

- **Alias:** chargebee · **Vùng:** global · **Loại:** billing
- **Mã hình dạng:** S2, S9 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header authorization (Basic) · algo: basic auth username/password tuỳ chọn; hoặc khoá trong query URL
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `authorization` · body bắt buộc: id, occurred_at, event_type, content · body tuỳ chọn: source, object, api_version, webhook_status, webhooks
- **Chống trùng:** id (ev_…)
- **Ack / retry / tự tắt:** phản hồi: 2xx · timeout 20s · retry: 7 lần: 2p, 6p, 30p, 1h, 5h, 1 ngày, 2 ngày (~3,3 ngày) · **tự tắt:** chỉ mô tả cho test site
- **Tài liệu:** https://www.chargebee.com/docs/billing/2.0/site-configuration/webhook_settings (Billing 2.0)
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Không có chữ ký HMAC. Trường body occurred_at/event_type/content theo kiến thức API Chargebee — trang đã đọc không liệt kê.
- **Nguồn:** <https://www.chargebee.com/docs/billing/2.0/site-configuration/webhook_settings>

### Recurly — `recurly`

- **Alias:** recurly · **Vùng:** global · **Loại:** billing
- **Mã hình dạng:** S4 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: recurly-signature · algo: hmac-sha256 · encoding: hex · kv: <timestamp_ms>,<sig1>[,<sig2>] · signedString: {timestamp}.{raw_body} · timestampHeader: (phần tử đầu của recurly-signature, mili-giây)
- **Dấu vân tay:** method POST · content-type application/json (XML cũ không ký) · header bắt buộc: `recurly-signature` · body bắt buộc: id, object_type, event_type · body tuỳ chọn: uuid, site_id, account_code
- **Chống trùng:** id
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://docs.recurly.com/recurly-subscriptions/v2.29/docs/signature-verification (v2.29)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** ?
- **Ghi chú:** Chuỗi ký {ts}.{body} lấy từ Hookdeck; tài liệu chính thức chỉ chắc định dạng header. Body fields theo kiến thức chung.
- **Nguồn:** <https://docs.recurly.com/recurly-subscriptions/v2.29/docs/signature-verification> · <https://hookdeck.com/webhooks/platforms/guide-to-recurly-webhooks-features-and-best-practices>

### Polar — `polar`

- **Alias:** polar, polar.sh · **Vùng:** global · **Loại:** billing
- **Mã hình dạng:** S3 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: webhook-signature · algo: Standard Webhooks v1 (HMAC-SHA256) · encoding: base64 · prefix: v1, · signedString: {webhook-id}.{webhook-timestamp}.{raw_body} · timestampHeader: webhook-timestamp
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `webhook-id`, `webhook-timestamp`, `webhook-signature` · body bắt buộc: type, data · body tuỳ chọn: timestamp
- **Chống trùng:** header webhook-id
- **Ack / retry / tự tắt:** phản hồi: 2xx, khuyên < 2s · timeout 10s · retry: tới 10 lần, backoff mũ · **tự tắt:** 10 lần non-2xx liên tiếp -> tắt endpoint + email
- **Tài liệu:** https://polar.sh/docs/integrate/webhooks/delivery
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** BẪY: secret whsec_ tạo trước 2026-09-08 phải base64-encode CẢ CHUỖI trước khi đưa vào thư viện Standard Webhooks; secret mới đưa thẳng. webhook-id/timestamp: trang chỉ xác nhận webhook-signature.
- **Nguồn:** <https://polar.sh/docs/integrate/webhooks/delivery>

### Shopify — `shopify`

- **Alias:** shopify · **Vùng:** global · **Loại:** ecommerce
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-shopify-hmac-sha256 · algo: hmac-sha256 · encoding: base64 · signedString: raw body, khoá = client secret của app
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-shopify-hmac-sha256` · header tuỳ chọn: `x-shopify-topic`, `x-shopify-shop-domain`, `x-shopify-api-version`, `x-shopify-webhook-id`, `x-shopify-event-id`, `x-shopify-triggered-at`
- **Chống trùng:** header x-shopify-event-id (sự kiện) / x-shopify-webhook-id (lần gửi)
- **Ack / retry / tự tắt:** phản hồi: 200 (3xx tính lỗi) · timeout 5s · connect 1s · retry: 8 lần trong ~4 giờ · **tự tắt:** 8 lần lỗi liên tiếp -> XOÁ subscription tạo qua Admin API + email
- **Tài liệu:** https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- **Payload mẫu chính thức:** có · **mẫu kèm header:** ?
- **Ghi chú:** Body là chính tài nguyên (order/product), không có phong bì -> nhận diện chỉ bằng header. Header topic/shop-domain/api-version theo kiến thức chung; trang đã đọc xác nhận hmac/webhook-id/event-id.
- **Nguồn:** <https://shopify.dev/docs/apps/build/webhooks/subscribe/https>

### WooCommerce — `woocommerce`

- **Alias:** woocommerce, woo commerce, woo · **Vùng:** global · **Loại:** ecommerce
- **Mã hình dạng:** S1 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-wc-webhook-signature · algo: hmac-sha256 · encoding: base64 · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-wc-webhook-signature` · header tuỳ chọn: `x-wc-webhook-source`, `x-wc-webhook-topic`, `x-wc-webhook-resource`, `x-wc-webhook-event`, `x-wc-webhook-id`, `x-wc-webhook-delivery-id` · User-Agent: WooCommerce/<ver> Hookshot (WordPress/<ver>) — chưa xác minh trong phiên
- **Chống trùng:** header x-wc-webhook-delivery-id (định dạng mâu thuẫn giữa các nguồn; chỉ dùng làm id)
- **Bắt tay:** Khi tạo webhook, Woo gửi ping form-encoded webhook_id=<id> KHÔNG có chữ ký (kiến thức chung, chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: 2xx · retry: không có lịch retry rõ · **tự tắt:** 5 lần non-2xx liên tiếp -> tắt webhook, bật lại qua REST API
- **Tài liệu:** https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/ (REST API v3)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Body là tài nguyên trần (order/product). Header source chứa URL shop. Ping không ký -> hub phải trả 200 cho request không chữ ký đầu tiên nếu không muốn Woo đánh dấu lỗi.
- **Nguồn:** <https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/> · <https://hookdeck.com/webhooks/platforms/guide-to-woocommerce-webhooks-features-and-best-practices>

### BigCommerce — `bigcommerce`

- **Alias:** bigcommerce, big commerce · **Vùng:** global · **Loại:** ecommerce
- **Mã hình dạng:** S2, S8 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header tuỳ chỉnh (headers object khi tạo webhook) · algo: không ký; body 'thin' chỉ có id -> gọi API lấy dữ liệu
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: scope, store_id, data, hash, created_at, producer
- **Chống trùng:** hash (SHA-1 của data, để phát hiện trùng)
- **Ack / retry / tự tắt:** phản hồi: HTTP 200 · retry: có cơ chế retry (chi tiết chưa xác minh) · **tự tắt:** subscription vô hiệu sau 90 ngày không hoạt động
- **Tài liệu:** https://docs.bigcommerce.com/developer/docs/integrations/webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** producer dạng stores/{store_hash} là dấu vân tay rất mạnh. Không có chữ ký -> dựa header tự đặt.
- **Nguồn:** <https://docs.bigcommerce.com/developer/docs/integrations/webhooks/event-reference> · <https://hookdeck.com/webhooks/platforms/guide-to-bigcommerce-webhooks-features-and-best-practices.md>

### GitHub — `github`

- **Alias:** github, git hub · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-hub-signature-256 · algo: hmac-sha256 · encoding: hex · prefix: sha256= · signedString: raw body · legacy: x-hub-signature: sha1=<hex>
- **Dấu vân tay:** method POST · content-type application/json hoặc application/x-www-form-urlencoded (payload=…) · header bắt buộc: `x-github-event`, `x-github-delivery` · header tuỳ chọn: `x-hub-signature-256`, `x-hub-signature`, `x-github-hook-id`, `x-github-hook-installation-target-type`, `x-github-hook-installation-target-id` · User-Agent: GitHub-Hookshot/<id> · body tuỳ chọn: action, repository, sender, installation, organization
- **Chống trùng:** header x-github-delivery (GUID)
- **Bắt tay:** sự kiện ping (x-github-event: ping) khi tạo webhook
- **Ack / retry / tự tắt:** phản hồi: 2xx; tài liệu best-practices: trả trong 10s (chưa xác minh trên trang đã đọc) · retry: không tự retry (redeliver thủ công) — chưa xác minh trong phiên
- **Tài liệu:** https://docs.github.com/en/webhooks/webhook-events-and-payloads
- **Payload mẫu chính thức:** có · **mẫu kèm header:** có
- **Ghi chú:** Payload tối đa 25 MB. Có mẫu 'Example webhook delivery' kèm header -> fixture .http tốt. Hub có adapter native.
- **Nguồn:** <https://docs.github.com/en/webhooks/webhook-events-and-payloads>

### GitLab — `gitlab`

- **Alias:** gitlab, git lab · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S2, S3 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-gitlab-token (token tĩnh, plain text) · altSigned: {"header":"webhook-signature","algo":"hmac-sha256","encoding":"base64","prefix":"v1,","signedString":"{webhook-id}.{webhook-timestamp}.{raw_body}","timestampHeader":"webhook-timestamp"}
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-gitlab-event` · header tuỳ chọn: `x-gitlab-token`, `x-gitlab-event-uuid`, `x-gitlab-webhook-uuid`, `x-gitlab-instance`, `idempotency-key`, `webhook-id`, `webhook-timestamp`, `webhook-signature` · User-Agent: GitLab/<VERSION> · body bắt buộc: object_kind · body tuỳ chọn: event_name, project, user
- **Chống trùng:** header webhook-id (= idempotency-key, giữ nguyên khi gửi lại)
- **Ack / retry / tự tắt:** phản hồi: 200/201 nhanh · retry: không có lịch retry tự động mô tả · **tự tắt:** 4 lỗi liên tiếp -> tạm tắt (1 phút → tối đa 24h); 40 lỗi liên tiếp -> tắt hẳn tới khi test 2xx
- **Tài liệu:** https://docs.gitlab.com/user/project/integrations/webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** có
- **Ghi chú:** PHÁT HIỆN: GitLab đã thêm signing token theo đúng Standard Webhooks (webhook-id/timestamp/signature, v1,base64). Một request có thể mang CẢ x-gitlab-token và webhook-signature -> va chạm với nhóm S3. body.object_kind theo kiến thức chung.
- **Nguồn:** <https://docs.gitlab.com/user/project/integrations/webhooks/>

### Bitbucket Cloud — `bitbucket`

- **Alias:** bitbucket, bit bucket · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-hub-signature · algo: hmac (hiện sha256, có thể đổi) · encoding: hex · prefix: <method>= (vd sha256=) · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-event-key` · header tuỳ chọn: `x-hub-signature`, `x-hook-uuid`, `x-request-uuid`, `x-attempt-number` · User-Agent: Bitbucket-Webhooks/2.0 (kiến thức chung, chưa xác minh trong phiên) · body tuỳ chọn: repository, actor
- **Chống trùng:** header x-request-uuid (chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Tên thuật toán nằm trong tiền tố -> verify phải đọc tiền tố (giống Jira). Trang có test vector secret/payload/chữ ký.
- **Nguồn:** <https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/>

### Azure DevOps Service Hooks — `azure-devops`

- **Alias:** azure devops, ado, vsts, tfs · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S2 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header authorization (Basic) hoặc header HTTP tuỳ chỉnh · algo: không ký nội dung
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `authorization` · body bắt buộc: eventType, resource, publisherId · body tuỳ chọn: subscriptionId, notificationId, id, message, detailedMessage, resourceVersion, resourceContainers, createdDate
- **Chống trùng:** id (chưa xác minh trong phiên)
- **Bắt tay:** Nút Test khi tạo subscription
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks (ms.date 2026-08-07)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Trang xác nhận basic auth cần HTTPS và mẫu có eventType/messages/detailedMessage/resource; các trường còn lại theo kiến thức chung.
- **Nguồn:** <https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks>

### Jira Cloud (Atlassian) — `jira`

- **Alias:** jira, atlassian, confluence · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1, S8 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-hub-signature · algo: hmac (sha256 trong ví dụ) · encoding: hex · prefix: <method>= · signedString: raw body
- **Cơ chế phụ:** Connect app: JWT ký bằng sharedSecret; OAuth 2.0 app: Bearer JWT trong authorization, ký bằng client secret
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-atlassian-webhook-identifier` · header tuỳ chọn: `x-hub-signature`, `x-atlassian-webhook-retry`, `x-atlassian-webhook-flow` · body bắt buộc: timestamp, webhookEvent · body tuỳ chọn: issue_event_type_name, user, issue, changelog, comment
- **Chống trùng:** header x-atlassian-webhook-identifier (giữ nguyên khi retry)
- **Ack / retry / tự tắt:** phản hồi: chỉ HTTP 200 là thành công · retry: ≤ 5 lần, trễ ngẫu nhiên 5–15 phút, khi 408/409/425/429/5xx/lỗi kết nối · **tự tắt:** 30 phút không thành công -> mỗi webhook chỉ thử 1 lần cho tới khi thành công
- **Tài liệu:** https://developer.atlassian.com/cloud/jira/platform/webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Cùng header x-hub-signature với Bitbucket/KiotViet/GitHub cũ. Có test vector công khai trên trang.
- **Nguồn:** <https://developer.atlassian.com/cloud/jira/platform/webhooks/>

### Linear — `linear`

- **Alias:** linear, linear.app · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: linear-signature · algo: hmac-sha256 · encoding: hex · signedString: raw body · timestampHeader: linear-timestamp (ms); khuyên kiểm body.webhookTimestamp trong ~60s · toleranceSec: 60
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `linear-signature`, `linear-delivery`, `linear-event` · header tuỳ chọn: `linear-timestamp` · User-Agent: Linear-Webhook · body bắt buộc: action, type, createdAt, webhookTimestamp · body tuỳ chọn: data, url, actor, updatedFrom, webhookId, organizationId
- **Chống trùng:** header linear-delivery (UUID v4)
- **Ack / retry / tự tắt:** phản hồi: HTTP 200 trong 5s · timeout 5s · retry: 3 lần: sau 1 phút, 1 giờ, 6 giờ · **tự tắt:** có thể tắt nếu URL không phản hồi (không nêu ngưỡng)
- **Tài liệu:** https://linear.app/developers/webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Timestamp KHÔNG nằm trong chuỗi ký (chống replay bằng trường body đã được ký trong raw body) -> vẫn là S1.
- **Nguồn:** <https://linear.app/developers/webhooks>

### Sentry (Integration Platform) — `sentry`

- **Alias:** sentry · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: sentry-hook-signature · algo: hmac-sha256 · encoding: hex · signedString: JSON.stringify(body) theo code mẫu (không nói rõ raw bytes) · timestampHeader: sentry-hook-timestamp (không nằm trong chuỗi ký theo trang)
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `sentry-hook-resource`, `sentry-hook-signature` · header tuỳ chọn: `sentry-hook-timestamp`, `request-id` · body bắt buộc: action, installation, data, actor
- **Chống trùng:** header request-id
- **Ack / retry / tự tắt:** phản hồi: trả trong 1 giây · timeout 1s
- **Tài liệu:** https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** ?
- **Ghi chú:** Timeout 1 GIÂY — chặt nhất danh mục; hub đã ACK sau COMMIT nên phải đo p95 ingest < 1s. Code mẫu ký JSON.stringify(body) — rủi ro lệch byte nếu hub verify trên raw (cần fixture thật).
- **Nguồn:** <https://docs.sentry.io/organization/integrations/integration-platform/webhooks/>

### Vercel — `vercel`

- **Alias:** vercel, zeit · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-vercel-signature · algo: hmac-sha1 · encoding: hex · signedString: raw body; khoá = secret webhook (account) hoặc Integration/Client Secret
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-vercel-signature` · body bắt buộc: id, type, createdAt, payload · body tuỳ chọn: region
- **Chống trùng:** id (id lần giao)
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 30s · timeout 30s · retry: tới 24 giờ, backoff mũ, sau đó bỏ
- **Tài liệu:** https://vercel.com/docs/webhooks/webhooks-api
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Vẫn SHA-1. Code mẫu chính thức so bằng !== (không constant-time) — hub phải tự so.
- **Nguồn:** <https://vercel.com/docs/webhooks/webhooks-api>

### Netlify (deploy notifications) — `netlify`

- **Alias:** netlify · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-webhook-signature · algo: JWS HS256; claim sha256 = SHA-256 hex của raw body; claim iss = netlify · encoding: JWT compact · signedString: JWT chứa băm body (không HMAC trực tiếp trên body)
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-webhook-signature` · User-Agent: Netlify (chưa xác minh) · body tuỳ chọn: id, site_id, state, deploy_url, branch
- **Chống trùng:** id (deploy id; chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://docs.netlify.com/site-deploys/deploy-notifications/#payload-signature
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Biến thể riêng (JWS bọc băm body) — không config được bằng hmac thường, cần handler code. Tên header x-webhook-signature quá chung.
- **Nguồn:** <https://docs.netlify.com/site-deploys/deploy-notifications/#payload-signature>

### Render — `render`

- **Alias:** render, render.com · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S3 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: webhook-signature · algo: Standard Webhooks (HMAC-SHA256) · encoding: base64 · prefix: v1, · signedString: {webhook-id}.{webhook-timestamp}.{raw_body} · timestampHeader: webhook-timestamp · toleranceSec: 300
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `webhook-id`, `webhook-timestamp`, `webhook-signature` · body bắt buộc: type, timestamp, data
- **Chống trùng:** header webhook-id (evt-…, giữ nguyên khi retry)
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 15s · timeout 15s · retry: tới 8 lần, backoff mũ, lần cuối ~33h sau lần đầu; email sau lần lỗi thứ 3 · **tự tắt:** hết 8 lần -> tắt webhook
- **Tài liệu:** https://render.com/docs/webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Payload tối giản (thin) -> gọi API lấy chi tiết. Hub đang deploy trên Render.
- **Nguồn:** <https://render.com/docs/webhooks>

### CircleCI — `circleci`

- **Alias:** circleci, circle ci · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: circleci-signature · algo: hmac-sha256 · encoding: hex · prefix: v1= (danh sách phân tách bởi dấu phẩy; chỉ kiểm v1) · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `circleci-event-type` · header tuỳ chọn: `circleci-signature` · User-Agent: CircleCI-Webhook/1.0 · body bắt buộc: id, type, happened_at, webhook · body tuỳ chọn: project, organization, pipeline, workflow, job
- **Chống trùng:** id
- **Ack / retry / tự tắt:** phản hồi: 2xx · timeout 10s · retry: retry sau (không nêu lịch)
- **Tài liệu:** https://circleci.com/docs/guides/integration/outbound-webhooks/
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** có
- **Ghi chú:** Định dạng 'v1=…' kiểu Stripe nhưng KHÔNG có timestamp. Trường body theo trang tham chiếu, chưa đọc trực tiếp.
- **Nguồn:** <https://circleci.com/docs/guides/integration/outbound-webhooks/>

### Docker Hub — `docker-hub`

- **Alias:** docker hub, dockerhub, docker · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S9 · **Độ tin cậy:** cao
- **Chữ ký:** algo: không ký, không xác thực
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: push_data, repository · body tuỳ chọn: callback_url, dhi_metadata
- **Chống trùng:** không có; ghép repository.repo_name + push_data.tag + push_data.pushed_at
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh · retry: không nêu
- **Tài liệu:** https://docs.docker.com/docker-hub/repos/manage/webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** S9 thuần — chỉ an toàn bằng URL bí mật (sourceKey của hub).
- **Nguồn:** <https://docs.docker.com/docker-hub/repos/manage/webhooks/>

### Heroku App Webhooks — `heroku`

- **Alias:** heroku · **Vùng:** global · **Loại:** dev
- **Mã hình dạng:** S1, S2 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: heroku-webhook-hmac-sha256 · algo: hmac-sha256 · encoding: base64 · signedString: raw body
- **Cơ chế phụ:** authorization: giá trị đặt bằng --authorization khi đăng ký, chuyển nguyên văn (S2)
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `heroku-webhook-hmac-sha256` · header tuỳ chọn: `authorization` · body bắt buộc: id, action, resource, data, webhook_metadata · body tuỳ chọn: actor, previous_data, created_at, updated_at, published_at, sequence, version
- **Chống trùng:** webhook_metadata.event.id (delivery.id theo lần giao)
- **Ack / retry / tự tắt:** phản hồi: 2xx bất kỳ, khuyên 204 body rỗng · retry: notify: không retry; sync: tới 72 giờ; thông báo có THỨ TỰ nên retry làm chậm sự kiện sau · **tự tắt:** lỗi liên tục 1 tuần -> email, tiếp tục lỗi -> XOÁ
- **Tài liệu:** https://devcenter.heroku.com/articles/app-webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Header tên chứa thuật toán, giống Shopify/Haravan (nhóm *-hmac-sha256, base64).
- **Nguồn:** <https://devcenter.heroku.com/articles/app-webhooks>

### Slack (Events API / interactivity / slash commands) — `slack`

- **Alias:** slack · **Vùng:** global · **Loại:** messaging
- **Mã hình dạng:** S4, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-slack-signature · algo: hmac-sha256 · encoding: hex · prefix: v0= · signedString: v0:{x-slack-request-timestamp}:{raw_body} · timestampHeader: x-slack-request-timestamp · toleranceSec: 300
- **Dấu vân tay:** method POST · content-type application/json (Events) / application/x-www-form-urlencoded (slash command, interactivity payload=…) · header bắt buộc: `x-slack-signature`, `x-slack-request-timestamp` · header tuỳ chọn: `x-slack-retry-num`, `x-slack-retry-reason` · User-Agent: Slackbot 1.0 (+https://api.slack.com/robots) — chưa xác minh trong phiên · body bắt buộc: type · body tuỳ chọn: token, team_id, api_app_id, event, event_id, event_time, challenge, authorizations
- **Chống trùng:** event_id
- **Bắt tay:** url_verification: body {type:'url_verification', token, challenge} -> trả lại challenge (chi tiết response chưa đọc được trên trang Events API; theo kiến thức chung: plain text hoặc JSON {challenge})
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 3s; có thể trả header x-slack-no-retry: 1 để chặn gửi lại · timeout 3s · retry: 3 lần: gần như ngay, +1 phút, +5 phút; Delayed Events: mỗi giờ trong 24h · **tự tắt:** >95% lỗi trong 60 phút -> tạm tắt (app < 1000 sự kiện/giờ không bị tắt)
- **Tài liệu:** https://docs.slack.dev/authentication/verifying-requests-from-slack
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Mẫu chuỗi ký giống Zoom gần như hệt (v0:{ts}:{body}) -> một template signed dùng cho 2 bên.
- **Nguồn:** <https://docs.slack.dev/authentication/verifying-requests-from-slack> · <https://docs.slack.dev/apis/events-api/>

### Discord (Interactions endpoint) — `discord`

- **Alias:** discord · **Vùng:** global · **Loại:** messaging
- **Mã hình dạng:** S8, S7, S10 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-signature-ed25519 · algo: Ed25519, khoá CÔNG KHAI của app · encoding: hex · signedString: {x-signature-timestamp}{raw_body} · timestampHeader: x-signature-timestamp
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-signature-ed25519`, `x-signature-timestamp` · User-Agent: Discord-Interactions/1.0 (+https://discord.com) — chưa xác minh trong phiên · body bắt buộc: type, application_id, token, id · body tuỳ chọn: data, guild_id, channel_id, member, user
- **Chống trùng:** id (interaction id)
- **Bắt tay:** PING: body {type:1} -> phải trả 200 với {type:1}; sai chữ ký phải trả 401 (Discord cố tình bắn chữ ký sai để kiểm)
- **Ack / retry / tự tắt:** phản hồi: phản hồi interaction đồng bộ (type 1/4/5…) — 3 giây theo kiến thức chung, chưa xác minh trong phiên
- **Tài liệu:** https://docs.discord.com/developers/interactions/overview
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Bất đối xứng + phản hồi nghiệp vụ đồng bộ -> hub kiểu ACK-sau-COMMIT không đủ, phải sinh body trả lời. Discord 'webhooks' kiểu incoming (hub GỬI vào Discord) là chiều ngược, không thuộc danh mục.
- **Nguồn:** <https://docs.discord.com/developers/interactions/overview>

### Telegram Bot API — `telegram`

- **Alias:** telegram, tele, telegram bot · **Vùng:** global · **Loại:** messaging
- **Mã hình dạng:** S2 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-telegram-bot-api-secret-token · algo: so khớp token tĩnh (secret_token khi setWebhook, 1–256 ký tự A-Za-z0-9_-)
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-telegram-bot-api-secret-token` · body bắt buộc: update_id · body tuỳ chọn: message, edited_message, callback_query, channel_post, my_chat_member, chat_member, poll, inline_query
- **Chống trùng:** update_id (tăng dần)
- **Ack / retry / tự tắt:** phản hồi: 2xx; có thể trả lời bằng method call trong body (kiến thức chung) · retry: retry số lần hữu hạn rồi bỏ
- **Tài liệu:** https://core.telegram.org/bots/api#setwebhook
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** secretSource có thể là 'hub' (hub sinh token, gọi setWebhook). Chỉ cho cổng 443/80/88/8443.
- **Nguồn:** <https://core.telegram.org/bots/api#setwebhook>

### Microsoft Graph change notifications (Outlook/Teams/OneDrive/SharePoint) — `microsoft-graph`

- **Alias:** microsoft graph, ms graph, outlook, teams, onedrive, sharepoint, office 365 · **Vùng:** global · **Loại:** productivity
- **Mã hình dạng:** S7, S2 · **Độ tin cậy:** cao
- **Chữ ký:** location: body value[].clientState · algo: so khớp bí mật tĩnh clientState đặt lúc tạo subscription (S2 trong body); resource data mã hoá có validationTokens JWT (không đọc trong phiên)
- **Dấu vân tay:** method POST · content-type application/json · body bắt buộc: value · query: validationToken (chỉ lúc bắt tay)
- **Chống trùng:** value[].id (+subscriptionId)
- **Bắt tay:** POST {notificationUrl}?validationToken=… (Content-Type text/plain) -> trả 200, Content-Type text/plain, body = token đã URL-decode, trong 10s
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 3s (202 khuyến nghị khi xếp hàng) · timeout 3s · retry: tới 4 giờ, backoff mũ; lần retry timeout 10s · **tự tắt:** >10% chậm/10 phút -> 'slow' (trễ 10 phút); >15% quá 10s -> 'drop' (MẤT thông báo không phục hồi)
- **Tài liệu:** https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks (updated 2026-04-22)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** có
- **Ghi chú:** Một POST gom nhiều thông báo (value[]). Mẫu bắt tay có header + dòng đầu -> fixture .http được. Subscription hết hạn phải gia hạn (hub phải gọi ra Graph).
- **Nguồn:** <https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks>

### Zoom — `zoom`

- **Alias:** zoom · **Vùng:** global · **Loại:** messaging
- **Mã hình dạng:** S4, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-zm-signature · algo: hmac-sha256 · encoding: hex · prefix: v0= · signedString: v0:{x-zm-request-timestamp}:{raw_body} · timestampHeader: x-zm-request-timestamp
- **Cơ chế phụ:** Basic auth; OAuth token; header tuỳ chỉnh
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-zm-signature`, `x-zm-request-timestamp` · body bắt buộc: event, payload · body tuỳ chọn: event_ts
- **Chống trùng:** chưa xác minh (event + event_ts)
- **Bắt tay:** event endpoint.url_validation: payload.plainToken -> trả JSON {plainToken, encryptedToken = HMAC-SHA256 hex(plainToken, secret)}; lặp lại mỗi 72 giờ
- **Ack / retry / tự tắt:** phản hồi: 200 hoặc 204 trong 3s · timeout 3s · retry: 3 lần sau 5, 20, 60 phút (chỉ 5xx/lỗi kết nối; không retry 3xx/4xx) · **tự tắt:** 6 lần tái xác thực thất bại liên tiếp -> tắt subscription
- **Tài liệu:** https://developers.zoom.us/docs/api/webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Bắt tay đòi body tính bằng HMAC -> hub phải có secret TRƯỚC khi Zoom gọi (thứ tự giống PayOS).
- **Nguồn:** <https://developers.zoom.us/docs/api/webhooks/>

### Twilio — `twilio`

- **Alias:** twilio · **Vùng:** global · **Loại:** messaging
- **Mã hình dạng:** S6 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-twilio-signature · algo: hmac-sha1, khoá = Auth Token tài khoản · encoding: base64 · signedString: URL đầy đủ (đúng như Twilio gọi) + các tham số POST sắp xếp a→z nối key+value; JSON: URL có ?bodySHA256=<sha256 hex body>
- **Dấu vân tay:** method POST (GET tuỳ cấu hình) · content-type application/x-www-form-urlencoded · header bắt buộc: `x-twilio-signature` · header tuỳ chọn: `i-twilio-idempotency-token (chưa xác minh)` · User-Agent: TwilioProxy/1.1 (chưa xác minh) · body bắt buộc: AccountSid · body tuỳ chọn: MessageSid, CallSid, From, To, Body, ApiVersion, SmsStatus · query: bodySHA256 (khi JSON)
- **Chống trùng:** MessageSid / CallSid (+ trạng thái)
- **Ack / retry / tự tắt:** phản hồi: TwiML (XML) cho voice/SMS nếu muốn phản hồi; status callback chỉ cần 2xx (kiến thức chung)
- **Tài liệu:** https://www.twilio.com/docs/usage/webhooks/webhooks-security
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Hub phải biết URL CÔNG KHAI chính xác (sau cloudflared) -> cần cấu hình publicBaseUrl. Webhook voice/SMS đòi TwiML đồng bộ (S10 tiềm ẩn).
- **Nguồn:** <https://www.twilio.com/docs/usage/webhooks/webhooks-security>

### SendGrid Event Webhook — `sendgrid`

- **Alias:** sendgrid, send grid, twilio sendgrid · **Vùng:** global · **Loại:** email
- **Mã hình dạng:** S8 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-twilio-email-event-webhook-signature · algo: ECDSA (khoá công khai do SendGrid cấp) · encoding: base64 · signedString: {x-twilio-email-event-webhook-timestamp}{raw_body} · timestampHeader: x-twilio-email-event-webhook-timestamp
- **Cơ chế phụ:** OAuth 2.0 client credentials: Bearer token trong authorization
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-twilio-email-event-webhook-signature`, `x-twilio-email-event-webhook-timestamp`, `authorization` · User-Agent: SendGrid Event API (chưa xác minh) · hình body: MẢNG JSON các sự kiện (mỗi phần tử có email, event, timestamp, sg_event_id, sg_message_id) — chưa xác minh trong phiên
- **Chống trùng:** [].sg_event_id (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: 2xx (chưa xác minh)
- **Tài liệu:** https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Body là MẢNG ở cấp gốc -> luật khớp 'trường cấp một' của identify() không áp dụng được; 1 HTTP = N sự kiện.
- **Nguồn:** <https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features>

### Mailgun — `mailgun`

- **Alias:** mailgun, mail gun · **Vùng:** global · **Loại:** email
- **Mã hình dạng:** S5 · **Độ tin cậy:** cao
- **Chữ ký:** location: body.signature {timestamp, token, signature} · algo: hmac-sha256, khoá Webhook Signing Key · encoding: hex · signedString: {timestamp}{token} (KHÔNG gồm event-data)
- **Dấu vân tay:** method POST · content-type application/json (event webhooks) / form (routes) · body bắt buộc: signature, event-data
- **Chống trùng:** event-data.id (chưa xác minh) / signature.token (khuyên cache để chống replay)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh trong phiên (kiến thức chung: 200; 406 = không gửi lại)
- **Tài liệu:** https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** CHỮ KÝ KHÔNG PHỦ BODY: chỉ chứng minh người gửi biết khoá, event-data có thể bị sửa. Subaccount có thêm parent-signature. mTLS: CN webhooks.mgsend.net.
- **Nguồn:** <https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks>

### Postmark — `postmark`

- **Alias:** postmark · **Vùng:** global · **Loại:** email
- **Mã hình dạng:** S2, S9 · **Độ tin cậy:** cao
- **Chữ ký:** location: Basic auth nhúng trong URL (user:pass@host) · algo: không HMAC (tài liệu nói rõ)
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `authorization`, `x-pm-retries-remaining`, `x-pm-webhook-trace-id` · body bắt buộc: RecordType · body tuỳ chọn: MessageID, ServerID, MessageStream, Recipient, Tag, Metadata
- **Chống trùng:** header x-pm-webhook-trace-id (giữ nguyên khi retry) hoặc MessageID
- **Bắt tay:** Khi tạo/sửa webhook Postmark kiểm endpoint trả 200
- **Ack / retry / tự tắt:** phản hồi: 200 · retry: 5xx/408/429/lỗi mạng: trễ 1, 5, 10, 10, 10, 15 phút; 4xx khác bỏ; theo redirect ≤ 10 · **tự tắt:** loại sự kiện lỗi liên tục -> 'unverified' và tạm dừng
- **Tài liệu:** https://postmarkapp.com/developer/webhooks/webhooks-overview
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** PascalCase (RecordType) là dấu vân tay. Basic auth trong URL -> hub phải chấp nhận header Authorization Basic như S2.
- **Nguồn:** <https://postmarkapp.com/developer/webhooks/webhooks-overview>

### Resend — `resend`

- **Alias:** resend · **Vùng:** global · **Loại:** email · **Nhóm:** svix
- **Mã hình dạng:** S3 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: svix-signature · algo: Svix v1 (HMAC-SHA256) · encoding: base64 · prefix: v1, · signedString: {svix-id}.{svix-timestamp}.{raw_body} · timestampHeader: svix-timestamp
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `svix-id`, `svix-timestamp`, `svix-signature` · User-Agent: Svix-Webhooks/<ver> (chưa xác minh) · body bắt buộc: type, created_at, data
- **Chống trùng:** header svix-id
- **Ack / retry / tự tắt:** phản hồi: 2xx (lịch retry theo Svix — chưa xác minh trên trang Resend)
- **Tài liệu:** https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Chuỗi ký/tolerance là của Svix (xem mục danh mục công khai); trang Resend chỉ xác nhận 3 header + raw body. Body fields theo kiến thức chung.
- **Nguồn:** <https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests>

### Clerk — `clerk`

- **Alias:** clerk, clerk.dev · **Vùng:** global · **Loại:** auth · **Nhóm:** svix
- **Mã hình dạng:** S3 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: svix-signature · algo: Svix v1 (HMAC-SHA256) · encoding: base64 · prefix: v1, · signedString: {svix-id}.{svix-timestamp}.{raw_body} · timestampHeader: svix-timestamp
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `svix-id`, `svix-timestamp`, `svix-signature` · body bắt buộc: type, data · body tuỳ chọn: object, timestamp, instance_id, event_attributes
- **Chống trùng:** header svix-id
- **Ack / retry / tự tắt:** phản hồi: 2xx dừng retry; 4xx/5xx/không phản hồi -> retry · retry: theo lịch Svix
- **Tài liệu:** https://clerk.com/docs/webhooks/sync-data
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Trang đã đọc chỉ nói verifyWebhook() + CLERK_WEBHOOK_SIGNING_SECRET; header svix-* theo kiến thức chung + ngrok liệt kê clerk riêng svix.
- **Nguồn:** <https://clerk.com/docs/webhooks/sync-data> · <https://ngrok.com/docs/traffic-policy/actions/verify-webhook/>

### Svix (nền tảng gửi webhook, dùng bởi nhiều SaaS) — `svix`

- **Alias:** svix, standard webhooks · **Vùng:** global · **Loại:** infra · **Nhóm:** svix
- **Mã hình dạng:** S3 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: svix-signature (hoặc webhook-signature với gói Pro/Enterprise) · algo: hmac-sha256, khoá = base64-decode phần sau whsec_ · encoding: base64 · prefix: v1, (nhiều chữ ký cách nhau bằng dấu cách) · signedString: {id}.{timestamp}.{raw_body} · timestampHeader: svix-timestamp / webhook-timestamp
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `svix-id`, `svix-timestamp`, `svix-signature`
- **Chống trùng:** header svix-id / webhook-id
- **Ack / retry / tự tắt:** phản hồi: 2xx
- **Tài liệu:** https://docs.svix.com/receiving/verifying-payloads/how-manual
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Mục 'nhóm' — khi chỉ thấy svix-* mà body không đặc trưng, hub nên trả cả nhóm. Spec Standard Webhooks: Apache-2.0, v1a = Ed25519 (bất đối xứng).
- **Nguồn:** <https://docs.svix.com/receiving/verifying-payloads/how-manual> · <https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md>

### Meta Webhooks (Facebook/Messenger/Instagram/WhatsApp Cloud API) — `meta`

- **Alias:** meta, facebook, messenger, instagram, whatsapp, fb · **Vùng:** global · **Loại:** messaging
- **Mã hình dạng:** S1, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-hub-signature-256 · algo: sha256 với App Secret (trang không nói rõ HMAC; thực tế là HMAC-SHA256 — kiến thức chung) · encoding: hex · prefix: sha256= · signedString: raw body
- **Dấu vân tay:** method POST (bắt tay: GET) · content-type application/json · header bắt buộc: `x-hub-signature-256` · header tuỳ chọn: `x-hub-signature` · User-Agent: facebookexternalua (chưa xác minh) · body bắt buộc: object, entry · query: hub.mode, hub.challenge, hub.verify_token (chỉ khi bắt tay)
- **Chống trùng:** không có id sự kiện chung; entry[].id + entry[].time (+ messages[].id với WhatsApp)
- **Bắt tay:** GET ?hub.mode=subscribe&hub.challenge=…&hub.verify_token=… -> kiểm verify_token, trả nguyên challenge (200)
- **Ack / retry / tự tắt:** phản hồi: 200 OK cho mọi thông báo · retry: ngay lập tức rồi giãn dần trong 36 giờ, sau đó BỎ · **tự tắt:** không nêu
- **Tài liệu:** https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Cùng header x-hub-signature-256 + tiền tố sha256= với GitHub -> va chạm; phân biệt bằng body object/entry vs header x-github-event. Batch tới 1000 cập nhật/POST. WhatsApp có mTLS tuỳ chọn (CN client.webhooks.fbclientcerts.com).
- **Nguồn:** <https://developers.facebook.com/docs/graph-api/webhooks/getting-started>

### Amazon SNS (HTTP/S subscription) — `aws-sns`

- **Alias:** aws sns, sns, amazon sns, aws · **Vùng:** global · **Loại:** infra
- **Mã hình dạng:** S8, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: body.Signature · algo: RSA; SignatureVersion 1 = SHA1, 2 = SHA256; chứng chỉ tải từ body.SigningCertURL (phải là domain SNS, HTTPS) · encoding: base64 · signedString: chuỗi chuẩn hoá từ các trường body (Message, MessageId, Subject, Timestamp, TopicArn, Type… theo thứ tự — chưa đọc chi tiết trong phiên)
- **Dấu vân tay:** method POST · content-type text/plain; charset=UTF-8 (body vẫn là JSON) · header bắt buộc: `x-amz-sns-message-type`, `x-amz-sns-message-id`, `x-amz-sns-topic-arn` · header tuỳ chọn: `x-amz-sns-subscription-arn` · User-Agent: Amazon Simple Notification Service Agent · body bắt buộc: Type, MessageId, TopicArn, Timestamp, SignatureVersion, Signature, SigningCertURL · body tuỳ chọn: Message, Subject, SubscribeURL, Token, UnsubscribeURL
- **Chống trùng:** header x-amz-sns-message-id (giữ nguyên khi retry)
- **Bắt tay:** SubscriptionConfirmation: hub phải GET body.SubscribeURL (gọi RA ngoài) để xác nhận
- **Ack / retry / tự tắt:** phản hồi: 2xx (chính sách retry cấu hình được — chưa đọc trong phiên)
- **Tài liệu:** https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
- **Payload mẫu chính thức:** có · **mẫu kèm header:** có
- **Ghi chú:** Content-Type text/plain dù body JSON -> parser hub phải không dựa content-type. Bắt tay đòi hub chủ động gọi ra ngoài (khác mọi S7 còn lại là 'echo').
- **Nguồn:** <https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html> · <https://docs.aws.amazon.com/sns/latest/dg/http-header.html>

### HubSpot — `hubspot`

- **Alias:** hubspot, hub spot · **Vùng:** global · **Loại:** crm
- **Mã hình dạng:** S6, S4 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-hubspot-signature-v3 · algo: hmac-sha256, khoá client secret · encoding: base64 · signedString: {method}{uri đầy đủ đã decode một số ký tự}{raw_body}{x-hubspot-request-timestamp} · timestampHeader: x-hubspot-request-timestamp · toleranceSec: 300 · legacy: v1: sha256(clientSecret + body) hex trong x-hubspot-signature; v2: sha256(secret+method+uri+body)
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-hubspot-signature`, `x-hubspot-signature-v3`, `x-hubspot-signature-version`, `x-hubspot-request-timestamp` · hình body: MẢNG sự kiện, mỗi phần tử có eventId, subscriptionType, objectId, portalId, occurredAt
- **Chống trùng:** [].eventId
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developers.hubspot.com/docs/api/webhooks/validating-requests (v1/v2/v3 (legacy apps))
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** v3 ký cả method + URI -> cần URL công khai chính xác (như Twilio/Square). v1 là SHA-256 KHÔNG HMAC (secret||body). Body là mảng.
- **Nguồn:** <https://developers.hubspot.com/docs/api/webhooks/validating-requests>

### Typeform — `typeform`

- **Alias:** typeform, type form · **Vùng:** global · **Loại:** forms
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: typeform-signature · algo: hmac-sha256 · encoding: base64 · prefix: sha256= · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `typeform-signature` · User-Agent: Typeform Webhooks (chưa xác minh) · body bắt buộc: event_id, event_type, form_response
- **Chống trùng:** event_id (chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://www.typeform.com/developers/webhooks/secure-your-webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** sha256= + BASE64 (khác GitHub sha256= + hex) -> cùng tiền tố, khác encoding: bẫy cho config.
- **Nguồn:** <https://www.typeform.com/developers/webhooks/secure-your-webhooks/>

### Calendly — `calendly`

- **Alias:** calendly · **Vùng:** global · **Loại:** scheduling
- **Mã hình dạng:** S4 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: calendly-webhook-signature · algo: hmac-sha256 · encoding: hex · kv: t=<ts>,v1=<sig> · signedString: {t}.{raw_body} · timestampHeader: (khoá t trong header) · toleranceSec: 180
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `calendly-webhook-signature` · body bắt buộc: event, created_at, payload · body tuỳ chọn: created_by
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Định dạng y hệt Stripe (t=,v1=; {t}.{body}) -> 1 template signed phủ Stripe/Calendly/Sanity. Cửa sổ 180s từ Hookdeck. Mất signing key phải email support.
- **Nguồn:** <https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures> · <https://hookdeck.com/webhooks/platforms/guide-to-calendly-webhooks-features-and-best-practices>

### LINE Messaging API — `line`

- **Alias:** line, line messaging · **Vùng:** JP/TH/TW · **Loại:** messaging
- **Mã hình dạng:** S1 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-line-signature · algo: hmac-sha256, khoá channel secret · encoding: base64 · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-line-signature` · User-Agent: LineBotWebhook/2.0 (chưa xác minh) · body bắt buộc: destination, events
- **Chống trùng:** events[].webhookEventId; events[].deliveryContext.isRedelivery
- **Bắt tay:** Nút Verify ở console gửi events rỗng (chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: 2xx · retry: chỉ khi bật redelivery; số lần không công bố
- **Tài liệu:** https://developers.line.biz/en/docs/messaging-api/receiving-messages/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Trang chữ ký (verify-webhook-signature) timeout khi đọc; header/thuật toán theo kiến thức chung.
- **Nguồn:** <https://developers.line.biz/en/docs/messaging-api/receiving-messages/>

### Intercom — `intercom`

- **Alias:** intercom · **Vùng:** global · **Loại:** support
- **Mã hình dạng:** S1 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-hub-signature · algo: hmac-sha1, khoá client_secret của app · encoding: hex · prefix: sha1= · signedString: raw body
- **Dấu vân tay:** method POST (HEAD khi kiểm URL) · content-type application/json · header bắt buộc: `x-hub-signature` · User-Agent: Intercom-Webhooks (chưa xác minh) · body bắt buộc: type, topic, id, app_id, data · body tuỳ chọn: delivery_attempts, first_sent_at, created_at, delivery_status
- **Chống trùng:** id (notification id)
- **Bắt tay:** URL phải chấp nhận HEAD để kiểm; khi lưu có gửi topic 'ping' (Hookdeck)
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 5s · timeout 5s · retry: 1 lần sau 1 phút (tài liệu 1.1) · **tự tắt:** nhiều lỗi -> bỏ thông báo 15 phút (1.1); nguồn thứ ba: lỗi > 7 ngày -> treo
- **Tài liệu:** https://developers.intercom.com/docs/references/1.1/webhooks/webhook-models (1.1 (cũ) + trang setup hiện tại)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** sha1= + x-hub-signature y hệt GitHub legacy -> va chạm mạnh; phân biệt bằng body type=notification_event.
- **Nguồn:** <https://developers.intercom.com/docs/webhooks/setting-up-webhooks> · <https://developers.intercom.com/docs/references/1.1/webhooks/webhook-models> · <https://hookdeck.com/webhooks/platforms/guide-to-intercom-webhooks-features-and-best-practices.md>

### Zendesk — `zendesk`

- **Alias:** zendesk · **Vùng:** global · **Loại:** support
- **Mã hình dạng:** S4 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-zendesk-webhook-signature · algo: hmac-sha256 · encoding: base64 · signedString: {x-zendesk-webhook-signature-timestamp}{raw_body} (nối liền, không dấu phân cách) · timestampHeader: x-zendesk-webhook-signature-timestamp
- **Dấu vân tay:** method POST (có thể GET/PUT/PATCH/DELETE tuỳ cấu hình) · content-type application/json (tuỳ cấu hình) · header bắt buộc: `x-zendesk-webhook-signature`, `x-zendesk-webhook-signature-timestamp` · header tuỳ chọn: `x-zendesk-webhook-id`, `x-zendesk-webhook-invocation-id (chưa xác minh)` · User-Agent: Zendesk Webhook (chưa xác minh)
- **Chống trùng:** header x-zendesk-webhook-invocation-id (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developer.zendesk.com/documentation/webhooks/verifying/
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Body do admin tự soạn template -> không có trường cố định. Webhook test trước khi tạo dùng secret tĩnh công khai.
- **Nguồn:** <https://developer.zendesk.com/documentation/webhooks/verifying/>

### Twitch EventSub — `twitch`

- **Alias:** twitch, eventsub · **Vùng:** global · **Loại:** streaming
- **Mã hình dạng:** S4, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: twitch-eventsub-message-signature · algo: hmac-sha256, khoá secret khai lúc tạo subscription · encoding: hex · prefix: sha256= · signedString: {message-id}{message-timestamp}{raw_body} (nối liền) · timestampHeader: twitch-eventsub-message-timestamp
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `twitch-eventsub-message-id`, `twitch-eventsub-message-timestamp`, `twitch-eventsub-message-signature`, `twitch-eventsub-message-type` · header tuỳ chọn: `twitch-eventsub-message-retry`, `twitch-eventsub-subscription-type`, `twitch-eventsub-subscription-version` · body bắt buộc: subscription · body tuỳ chọn: event, challenge
- **Chống trùng:** header twitch-eventsub-message-id
- **Bắt tay:** message-type webhook_callback_verification: trả 200, text/plain, body = challenge thô, Content-Length khớp
- **Ack / retry / tự tắt:** phản hồi: 2xx trong vài giây · retry: có (header retry) · **tự tắt:** revocation notification_failures_exceeded
- **Tài liệu:** https://dev.twitch.tv/docs/eventsub/handling-webhook-events/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** có
- **Ghi chú:** Giống Standard Webhooks về tư duy (id+ts+body) nhưng KHÔNG có dấu chấm phân cách và encoding hex + sha256= -> không dùng chung verifier SW.
- **Nguồn:** <https://dev.twitch.tv/docs/eventsub/handling-webhook-events/>

### Asana — `asana`

- **Alias:** asana · **Vùng:** global · **Loại:** productivity
- **Mã hình dạng:** S1, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-hook-signature · algo: hmac-sha256, khoá = X-Hook-Secret nhận lúc bắt tay · encoding: hex (trang không nói rõ) · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-hook-signature`, `x-hook-secret` · body bắt buộc: events
- **Chống trùng:** không có id sự kiện rõ; events[] gọn, phải gọi API
- **Bắt tay:** POST có header x-hook-secret -> trả 200/204 và ECHO header x-hook-secret; lưu secret để verify về sau (secretSource = provider-qua-bắt-tay)
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 10s; trả 410 để huỷ · timeout 10s · retry: tới 24 giờ; giao at-most-once, không replay · **tự tắt:** heartbeat mỗi 8 giờ; không phản hồi 24h -> XOÁ webhook
- **Tài liệu:** https://developers.asana.com/docs/webhooks-guide
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Secret được PROVIDER gửi trong bắt tay, hub phải bắt và lưu tự động — không dev nào dán được trước. Body events có thể rỗng (heartbeat).
- **Nguồn:** <https://developers.asana.com/docs/webhooks-guide>

### Trello — `trello`

- **Alias:** trello · **Vùng:** global · **Loại:** productivity
- **Mã hình dạng:** S6, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-trello-webhook · algo: hmac-sha1, khoá app secret / OAuth2 client secret · encoding: base64 · signedString: {raw_body}{callbackURL}
- **Dấu vân tay:** method POST (HEAD khi tạo) · content-type application/json · header bắt buộc: `x-trello-webhook` · header tuỳ chọn: `x-trello-client-identifier` · body bắt buộc: action, model, webhook
- **Chống trùng:** action.id (chưa xác minh trong phiên)
- **Bắt tay:** HEAD tới callbackURL khi tạo -> phải 200
- **Ack / retry / tự tắt:** phản hồi: 2xx; 410 để xoá webhook · retry: 3 lần sau 30, 60, 120 giây · **tự tắt:** chỉ khi CẢ 30 ngày lỗi VÀ > 1000 lỗi liên tiếp
- **Tài liệu:** https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Ký body + URL callback (URL ở SAU body) -> cần URL công khai chính xác. Ingest phải trả 200 cho HEAD. IP nguồn 104.192.142.240/28.
- **Nguồn:** <https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/>

### Dropbox — `dropbox`

- **Alias:** dropbox · **Vùng:** global · **Loại:** storage
- **Mã hình dạng:** S1, S7, S8 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-dropbox-signature · algo: hmac-sha256, khoá app secret · encoding: hex · signedString: raw body
- **Dấu vân tay:** method POST (GET khi bắt tay) · content-type application/json · header bắt buộc: `x-dropbox-signature` · User-Agent: DropboxWebhooks/1.0 (chưa xác minh) · body bắt buộc: list_folder · body tuỳ chọn: delta · query: challenge (chỉ khi bắt tay)
- **Chống trùng:** không có; thông báo chỉ báo tài khoản nào đổi
- **Bắt tay:** GET ?challenge=… -> trả nguyên challenge, Content-Type text/plain, X-Content-Type-Options: nosniff, trong 10s; không retry bắt tay
- **Ack / retry / tự tắt:** phản hồi: 200 nhanh · retry: backoff mũ khoảng 10 phút
- **Tài liệu:** https://docs.dropboxapi.com/dropbox-api/docs/webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Dataless: phải gọi /files/list_folder/continue (S8 theo nghĩa 'lấy dữ liệu thật qua API').
- **Nguồn:** <https://docs.dropboxapi.com/dropbox-api/docs/webhooks>

### Box — `box`

- **Alias:** box, box.com · **Vùng:** global · **Loại:** storage
- **Mã hình dạng:** S4 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: box-signature-primary / box-signature-secondary (2 khoá để xoay) · algo: hmac-sha256 · encoding: base64 · signedString: {raw_body}{box-delivery-timestamp} (timestamp đứng SAU body) · timestampHeader: box-delivery-timestamp · toleranceSec: 600
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `box-delivery-timestamp` · header tuỳ chọn: `box-signature-primary`, `box-signature-secondary`, `box-delivery-id`, `box-signature-version`, `box-signature-algorithm` · body bắt buộc: trigger, source · body tuỳ chọn: id, type, webhook, created_by, created_at, additional_info
- **Chống trùng:** header box-delivery-id (chưa xác minh trong phiên)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developer.box.com/guides/webhooks/v2/signatures-v2/ (V2)
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Thứ tự body-rồi-timestamp ngược mọi bên khác. Hai chữ ký song song = xoay khoá không gián đoạn.
- **Nguồn:** <https://developer.box.com/guides/webhooks/v2/signatures-v2/>

### Notion — `notion`

- **Alias:** notion · **Vùng:** global · **Loại:** productivity
- **Mã hình dạng:** S1, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-notion-signature · algo: hmac-sha256, khoá = verification_token · encoding: hex · prefix: sha256= · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-notion-signature` · body bắt buộc: type, entity, timestamp · body tuỳ chọn: id, workspace_id, subscription_id, integration_id, data, attempt_number, verification_token
- **Chống trùng:** id (chưa xác minh trong phiên)
- **Bắt tay:** POST một lần chứa verification_token -> dev DÁN token vào trang Notion để xác nhận (token cũng là khoá ký)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developers.notion.com/reference/webhooks (@notionhq/client ≥ 5.23.0 có verifyWebhookSignature)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Secret đến TRONG request đầu tiên -> hub cần 'chế độ thu' (PK4) để dev đọc verification_token từ raw_event. Đây là ca dùng hoàn hảo cho PK4.
- **Nguồn:** <https://developers.notion.com/reference/webhooks>

### Airtable — `airtable`

- **Alias:** airtable · **Vùng:** global · **Loại:** productivity
- **Mã hình dạng:** S1, S8 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-airtable-content-mac · algo: hmac-sha256, khoá = base64-decode(macSecretBase64) · encoding: hex · prefix: hmac-sha256= · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-airtable-content-mac` · body bắt buộc: base, webhook, timestamp
- **Chống trùng:** không có; dùng transaction number khi gọi list payloads
- **Ack / retry / tự tắt:** phản hồi: 200/204 body rỗng · timeout 25s · retry: tới 13 lần, backoff mũ từ 10s, ~1 ngày · **tự tắt:** hết retry -> tắt notification; webhook tạo bằng PAT/OAuth hết hạn sau 7 ngày nếu không refresh
- **Tài liệu:** https://airtable.com/developers/web/api/webhooks-overview
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Ping dataless -> phải gọi API lấy payload; webhook tự hết hạn 7 ngày -> hub cần job refresh (gọi ra ngoài).
- **Nguồn:** <https://airtable.com/developers/web/api/webhooks-overview>

### monday.com — `monday`

- **Alias:** monday, monday.com · **Vùng:** global · **Loại:** productivity
- **Mã hình dạng:** S7, S2 · **Độ tin cậy:** cao
- **Chữ ký:** location: header authorization · algo: JWT ký bằng Signing Secret của app (chỉ khi webhook tạo bằng token app integration); webhook thường không ký
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `authorization` · body bắt buộc: event · body tuỳ chọn: challenge
- **Chống trùng:** event.triggerUuid
- **Bắt tay:** POST {challenge} -> trả JSON {challenge} y nguyên
- **Ack / retry / tự tắt:** phản hồi: 2xx · retry: mỗi phút trong 30 phút
- **Tài liệu:** https://developer.monday.com/api-reference/reference/webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Phần lớn webhook monday KHÔNG có chữ ký -> thực tế là S9 + bắt tay.
- **Nguồn:** <https://developer.monday.com/api-reference/reference/webhooks>

### ClickUp — `clickup`

- **Alias:** clickup, click up · **Vùng:** global · **Loại:** productivity
- **Mã hình dạng:** S1 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-signature · algo: hmac-sha256 · encoding: hex · signedString: body (trang khuyên re-serialize không khoảng trắng nếu client đã parse)
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-signature` · body bắt buộc: event, webhook_id · body tuỳ chọn: task_id, history_items
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developer.clickup.com/docs/webhooksignature
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** x-signature trùng Lemon Squeezy (cũng hmac-sha256 hex raw body) -> chỉ phân biệt được bằng body.
- **Nguồn:** <https://developer.clickup.com/docs/webhooksignature>

### Webflow — `webflow`

- **Alias:** webflow · **Vùng:** global · **Loại:** cms
- **Mã hình dạng:** S4 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-webflow-signature · algo: hmac-sha256 · encoding: hex · signedString: {x-webflow-timestamp}:{raw_body} · timestampHeader: x-webflow-timestamp (ms theo ví dụ) · toleranceSec: 300
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-webflow-signature`, `x-webflow-timestamp` · body bắt buộc: triggerType, payload
- **Chống trùng:** payload.id (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: 200 (redirect tính lỗi) · retry: thêm 3 lần, cách 10 phút · **tự tắt:** lỗi lặp lại -> vô hiệu + email
- **Tài liệu:** https://developers.webflow.com/data/docs/working-with-webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Webhook tạo trong Dashboard KHÔNG có chữ ký (S9) — chỉ webhook OAuth app / site token sau 2025-04-14 mới ký. Dấu ':' như Paddle.
- **Nguồn:** <https://developers.webflow.com/data/docs/working-with-webhooks>

### Sanity — `sanity`

- **Alias:** sanity, sanity.io · **Vùng:** global · **Loại:** cms
- **Mã hình dạng:** S4 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: sanity-webhook-signature · algo: theo kiểu Stripe (HMAC-SHA256, t=…,v1=…) — chi tiết encoding chưa xác minh, dùng @sanity/webhook · encoding: chưa xác minh · signedString: chưa xác minh (mô phỏng Stripe: {t}.{body}) · timestampHeader: (trong header)
- **Dấu vân tay:** method POST (tuỳ cấu hình) · content-type application/json · header bắt buộc: `sanity-webhook-id`, `sanity-project-id`, `sanity-dataset` · header tuỳ chọn: `sanity-webhook-signature`, `idempotency-key`, `sanity-operation`, `sanity-document-id`, `sanity-transaction-id`, `sanity-transaction-time`
- **Chống trùng:** header idempotency-key
- **Ack / retry / tự tắt:** phản hồi: 2xx; 4xx (trừ 429) = không gửi lại · timeout 30s · retry: 2 lần cách 30s; 1 request đang bay/lúc
- **Tài liệu:** https://www.sanity.io/docs/webhooks
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Body do GROQ projection của dev quyết định -> không có trường cố định; nhận diện bằng header sanity-*.
- **Nguồn:** <https://www.sanity.io/docs/webhooks> · <https://github.com/sanity-io/webhook-toolkit>

### Plaid — `plaid`

- **Alias:** plaid · **Vùng:** US/EU · **Loại:** fintech
- **Mã hình dạng:** S8 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: plaid-verification · algo: JWT ES256; khoá công khai lấy qua API /webhook_verification_key/get theo kid; claim request_body_sha256 = SHA-256 raw body; iat ≤ 5 phút · encoding: JWT · signedString: JWT bọc băm body · timestampHeader: (iat trong JWT) · toleranceSec: 300
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `plaid-verification` · body bắt buộc: webhook_type, webhook_code · body tuỳ chọn: item_id, environment, error
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://plaid.com/docs/api/webhooks/webhook-verification/
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Verify cần gọi API Plaid (client_id + secret) để lấy JWK -> hub phải cache khoá. Trường body theo kiến thức chung, chưa xác minh.
- **Nguồn:** <https://plaid.com/docs/api/webhooks/webhook-verification/>

### Okta Event Hooks — `okta`

- **Alias:** okta · **Vùng:** global · **Loại:** auth
- **Mã hình dạng:** S2, S7 · **Độ tin cậy:** cao
- **Chữ ký:** location: header authorization · algo: chuỗi bí mật tĩnh do dev chọn khi đăng ký (không HMAC trên trang đã đọc)
- **Dấu vân tay:** method POST (GET khi bắt tay) · content-type application/json · header tuỳ chọn: `authorization`, `x-okta-verification-challenge` · body bắt buộc: eventType, eventTypeVersion, cloudEventsVersion, source, eventId, data · body tuỳ chọn: eventTime, contentType
- **Chống trùng:** eventId
- **Bắt tay:** GET một lần với header x-okta-verification-challenge -> trả JSON {"verification": <giá trị header>}
- **Ack / retry / tự tắt:** phản hồi: 200/204 body rỗng · timeout 3s · retry: tối đa 1 lần (5xx); 4xx không retry
- **Tài liệu:** https://developer.okta.com/docs/concepts/event-hooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Dạng CloudEvents (cloudEventsVersion). Bắt tay qua HEADER (không phải query/body) — biến thể S7 thứ 5.
- **Nguồn:** <https://developer.okta.com/docs/concepts/event-hooks/>

### DocuSign Connect — `docusign`

- **Alias:** docusign, docu sign · **Vùng:** global · **Loại:** esign
- **Mã hình dạng:** S1, S2 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-docusign-signature-1 (… tới -100 khi có nhiều khoá) · algo: hmac-sha256 · encoding: base64 · signedString: raw body
- **Cơ chế phụ:** Basic auth; mTLS
- **Dấu vân tay:** method POST · content-type application/json (hoặc XML với Connect cũ — chưa xác minh) · header bắt buộc: `x-docusign-signature-1` · header tuỳ chọn: `authorization` · body bắt buộc: event, data · body tuỳ chọn: apiVersion, uri, retryCount, configurationId, generatedDateTime
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: 2xx (retry có nhưng không nêu chi tiết)
- **Tài liệu:** https://developers.docusign.com/platform/webhooks/connect/hmac/
- **Payload mẫu chính thức:** không · **mẫu kèm header:** không
- **Ghi chú:** Nhiều header chữ ký đánh số (-1..-100) — config 1 header vẫn qua nếu khoá dev dán là khoá #1. Body fields theo kiến thức chung.
- **Nguồn:** <https://developers.docusign.com/platform/webhooks/connect/hmac/>

### Coinbase Commerce — `coinbase-commerce`

- **Alias:** coinbase commerce, coinbase · **Vùng:** global · **Loại:** crypto-payment
- **Mã hình dạng:** S1 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-cc-webhook-signature · algo: hmac-sha256, khoá shared secret · encoding: hex · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `x-cc-webhook-signature` · body bắt buộc: event · body tuỳ chọn: id, scheduled_for, attempt_number
- **Chống trùng:** event.id (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://docs.cdp.coinbase.com/commerce/api-arcitecture/webhooks-security
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Tóm tắt tìm kiếm trích trang chính thức; không mở được trang trực tiếp (404 ở URL cũ). Trường body theo kiến thức chung.
- **Nguồn:** <https://docs.cdp.coinbase.com/commerce/api-arcitecture/webhooks-security> · <https://hookdeck.com/webhooks/skills/coinbase-commerce-webhooks.md>

### WebSub / PubSubHubbub (YouTube push…) — `websub`

- **Alias:** websub, pubsubhubbub, youtube, youtube push · **Vùng:** global · **Loại:** protocol
- **Mã hình dạng:** S7, S1 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-hub-signature (chỉ khi subscriber gửi hub.secret) · algo: sha1/sha256/sha384/sha512 theo tiền tố (kiến thức về spec W3C — trang W3C trả 403 khi đọc) · encoding: hex · prefix: <method>= · signedString: raw body
- **Dấu vân tay:** method POST (GET khi xác minh) · content-type application/atom+xml (YouTube) · header tuỳ chọn: `x-hub-signature`, `link` · query: hub.mode, hub.topic, hub.challenge, hub.lease_seconds (chỉ khi xác minh)
- **Chống trùng:** yt:videoId + updated trong Atom (YouTube)
- **Bắt tay:** GET ?hub.mode=subscribe&hub.topic=…&hub.challenge=…&hub.lease_seconds=… -> trả 200 body = challenge; lease hết hạn phải đăng ký lại
- **Ack / retry / tự tắt:** phản hồi: 2xx
- **Tài liệu:** https://developers.google.com/youtube/v3/guides/push_notifications (W3C WebSub REC 2018)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Body XML Atom — identify() dựa JSON sẽ không khớp trường body. Lease buộc hub gia hạn định kỳ (gọi ra hub Google).
- **Nguồn:** <https://developers.google.com/youtube/v3/guides/push_notifications> · <https://www.w3.org/TR/websub/>

### Squarespace (Commerce webhooks) — `squarespace`

- **Alias:** squarespace · **Vùng:** global · **Loại:** ecommerce
- **Mã hình dạng:** S1 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: squarespace-signature · algo: hmac-sha256, khoá = hex-decode(secret) · encoding: hex · signedString: raw body
- **Dấu vân tay:** method POST · content-type application/json · header bắt buộc: `squarespace-signature` · body bắt buộc: id, websiteId, subscriptionId, topic, createdOn, data
- **Chống trùng:** id (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developers.squarespace.com/webhooks/verifying-notifications
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** BẪY: khoá phải hex-decode trước khi HMAC (giống Adyen) -> config cần cờ keyEncoding. Body fields theo kiến thức chung.
- **Nguồn:** <https://developers.squarespace.com/webhooks/verifying-notifications>

### Wix (app webhooks) — `wix`

- **Alias:** wix · **Vùng:** global · **Loại:** ecommerce
- **Mã hình dạng:** S8 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: BODY là một JWT · algo: RS256, khoá công khai lấy ở Dev Center (theo app) · encoding: JWT compact · signedString: toàn bộ body là JWT
- **Dấu vân tay:** method POST · content-type text/plain (chưa xác minh) · hình body: chuỗi JWT (eyJ…); giải ra {data, iat, exp}; data là chuỗi JSON {eventType, instanceId, data}
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://dev.wix.com/docs/build-apps/develop-your-app/api-integrations/events-and-webhooks/about-webhooks
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** không
- **Ghi chú:** Body KHÔNG phải JSON -> identify() 'parse JSON hoặc form' sẽ thất bại; cần nhận diện bằng mẫu eyJ… + 2 dấu chấm.
- **Nguồn:** <https://dev.wix.com/docs/build-apps/develop-your-app/api-integrations/events-and-webhooks/about-webhooks> · <https://hookdeck.com/webhooks/platforms/guide-to-wix-webhooks-features-and-best-practices.md>

### Gumroad Ping — `gumroad`

- **Alias:** gumroad · **Vùng:** global · **Loại:** ecommerce
- **Mã hình dạng:** S9, S8 · **Độ tin cậy:** trung bình
- **Chữ ký:** algo: không ký (không thấy tài liệu nhắc); xác thực bằng gọi sale API
- **Dấu vân tay:** method POST · content-type application/x-www-form-urlencoded · body bắt buộc: sale_id, seller_id, product_id · body tuỳ chọn: email, price, product_permalink, resource_name
- **Chống trùng:** sale_id
- **Ack / retry / tự tắt:** phản hồi: 200 · retry: mỗi giờ, tối đa 3 giờ
- **Tài liệu:** https://gumroad.com/ping
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Không thấy nguồn chính thức nói rõ 'không ký' — chỉ là vắng mặt.
- **Nguồn:** <https://gumroad.com/ping> · <https://www.mintlify.com/antiwork/gumroad/api/resource-subscriptions>

### Google Drive push notifications (Workspace) — `google-drive`

- **Alias:** google drive, drive, google workspace, gdrive · **Vùng:** global · **Loại:** storage
- **Mã hình dạng:** S2, S8 · **Độ tin cậy:** cao
- **Chữ ký:** location: header · header: x-goog-channel-token · algo: so khớp token tĩnh do dev đặt khi watch (tuỳ chọn)
- **Dấu vân tay:** method POST · content-type — · header bắt buộc: `x-goog-channel-id`, `x-goog-resource-id`, `x-goog-resource-state`, `x-goog-message-number` · header tuỳ chọn: `x-goog-channel-token`, `x-goog-channel-expiration`, `x-goog-resource-uri`, `x-goog-changed`
- **Chống trùng:** header x-goog-channel-id + x-goog-message-number
- **Bắt tay:** thông báo đầu tiên x-goog-resource-state: sync (không bắt tay đáp trả)
- **Ack / retry / tự tắt:** phản hồi: 200/201/202/204/102 · retry: backoff mũ khi 500/502/503/504 · **tự tắt:** kênh hết hạn (files ≤ 1 ngày, changes ≤ 1 tuần), không tự gia hạn
- **Tài liệu:** https://developers.google.com/workspace/drive/api/guides/push
- **Payload mẫu chính thức:** có · **mẫu kèm header:** có
- **Ghi chú:** BODY RỖNG — mọi thông tin ở header; idempotency/eventType phải lấy từ header. Google Forms watch dùng Pub/Sub, không ghi.
- **Nguồn:** <https://developers.google.com/workspace/drive/api/guides/push>

### Mailchimp (audience webhooks) — `mailchimp`

- **Alias:** mailchimp, mail chimp · **Vùng:** global · **Loại:** email
- **Mã hình dạng:** S9, S1 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header · header: x-mailchimp-signature (tuỳ chọn) · algo: HMAC (thuật toán/encoding chưa xác minh) · notes: Mặc định: secret nhúng trong URL
- **Dấu vân tay:** method POST · content-type application/x-www-form-urlencoded · header tuỳ chọn: `x-mailchimp-signature` · User-Agent: MailChimp (chưa xác minh) · body bắt buộc: type, fired_at · body tuỳ chọn: data[id], data[list_id], data[email]
- **Chống trùng:** không có; type + fired_at + data[id]
- **Bắt tay:** GET kiểm URL khi tạo (kiến thức chung, trang đã đọc không nói)
- **Ack / retry / tự tắt:** phản hồi: 2xx trong 10s · timeout 10s · retry: giãn dần trong 75 phút · **tự tắt:** có thể bị bỏ/tắt tuỳ Mailchimp
- **Tài liệu:** https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Form với khoá lồng data[...] -> parse form phẳng. Chữ ký mới (tuỳ chọn) chưa rõ thuật toán.
- **Nguồn:** <https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/>

### Supabase Database Webhooks — `supabase`

- **Alias:** supabase · **Vùng:** global · **Loại:** infra
- **Mã hình dạng:** S2, S9 · **Độ tin cậy:** cao
- **Chữ ký:** location: header tuỳ chỉnh do dev đặt · algo: không ký
- **Dấu vân tay:** method POST (tuỳ cấu hình) · content-type application/json · User-Agent: pg_net/<ver> (chưa xác minh) · body bắt buộc: type, table, schema, record, old_record
- **Chống trùng:** không có; record.id + type
- **Ack / retry / tự tắt:** phản hồi: không nêu
- **Tài liệu:** https://supabase.com/docs/guides/database/webhooks
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Bộ 5 trường type/table/schema/record/old_record là dấu vân tay rất mạnh. Auth webhooks (Supabase Auth hooks) dùng Standard Webhooks — chưa xác minh trong phiên.
- **Nguồn:** <https://supabase.com/docs/guides/database/webhooks>

### Pipedrive — `pipedrive`

- **Alias:** pipedrive · **Vùng:** global · **Loại:** crm
- **Mã hình dạng:** S2 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header authorization · algo: Basic auth (http_auth_user/password khi tạo webhook); không HMAC
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `authorization` · body bắt buộc: meta, data · body tuỳ chọn: previous, event, retry
- **Chống trùng:** meta.correlation_id / meta.attempt (v2) — chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: 2xx · retry: (Hookdeck) 3s, 30s, 150s, tối đa 4 lần · **tự tắt:** (Hookdeck) 3 ngày không giao thành công -> xoá
- **Tài liệu:** https://pipedrive.readme.io/docs/guide-for-webhooks-v2 (v2)
- **Payload mẫu chính thức:** có · **mẫu kèm header:** không
- **Ghi chú:** Lịch retry/xoá chỉ có ở nguồn thứ ba.
- **Nguồn:** <https://pipedrive.readme.io/docs/guide-for-webhooks> · <https://pipedrive.readme.io/docs/guide-for-webhooks-v2> · <https://hookdeck.com/webhooks/platforms/guide-to-pipedrive-webhooks-features-and-best-practices.md>

### Brevo (Sendinblue) — `brevo`

- **Alias:** brevo, sendinblue · **Vùng:** global · **Loại:** email
- **Mã hình dạng:** S2, S9 · **Độ tin cậy:** trung bình
- **Chữ ký:** location: header authorization (Bearer token cấu hình qua API) hoặc Basic auth trong URL hoặc header tuỳ chỉnh · algo: không ký
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `authorization` · body bắt buộc: event, email · body tuỳ chọn: message-id, ts, ts_event, date, subject, tag
- **Chống trùng:** message-id + event (chưa xác minh)
- **Ack / retry / tự tắt:** phản hồi: chưa xác minh
- **Tài liệu:** https://developers.brevo.com/docs/secured-webhooks
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** không
- **Ghi chú:** Dải IP nguồn 1.179.112.0/20, 172.246.240.0/20. Body fields theo kiến thức chung.
- **Nguồn:** <https://developers.brevo.com/docs/secured-webhooks> · <https://help.brevo.com/hc/en-us/articles/15127404548498>

### Auth0 (Log Streams - custom webhook) — `auth0`

- **Alias:** auth0, auth 0 · **Vùng:** global · **Loại:** auth
- **Mã hình dạng:** S2 · **Độ tin cậy:** thấp
- **Chữ ký:** location: header authorization · algo: giá trị Authorization Token cấu hình, gửi nguyên văn; không ký
- **Dấu vân tay:** method POST · content-type application/json (JSON lines / mảng / object tuỳ cấu hình) · header tuỳ chọn: `authorization` · body tuỳ chọn: log_id, data
- **Chống trùng:** log_id
- **Ack / retry / tự tắt:** phản hồi: 2xx · retry: (nguồn thứ ba) 3 lần/log; lỗi 7 ngày liên tiếp -> tạm dừng stream
- **Tài liệu:** https://auth0.com/docs/customize/log-streams/custom-log-streams
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** không
- **Ghi chú:** JSON lines -> body không phải 1 JSON hợp lệ. Auth0 Event Streams (CloudEvents) là sản phẩm khác.
- **Nguồn:** <https://auth0.com/docs/customize/log-streams/custom-log-streams.md> · <https://hookdeck.com/webhooks/platforms/guide-to-auth0-webhooks-features-and-best-practices.md>

### Adobe Commerce / Magento (Webhooks module) — `adobe-commerce`

- **Alias:** magento, adobe commerce · **Vùng:** global · **Loại:** ecommerce
- **Mã hình dạng:** S8, S10 · **Độ tin cậy:** thấp
- **Chữ ký:** location: header · header: x-adobe-commerce-webhook-signature · algo: RSA-SHA256 với cặp khoá sinh trong admin (tài liệu tự mâu thuẫn: ghi 'HMAC' nhưng code mẫu dùng createVerify + public key) · encoding: base64 · signedString: body (code mẫu re-serialize JSON — rủi ro)
- **Dấu vân tay:** method POST · content-type application/json · header tuỳ chọn: `x-adobe-commerce-webhook-signature`
- **Chống trùng:** chưa xác minh
- **Ack / retry / tự tắt:** phản hồi: Webhooks Commerce là ĐỒNG BỘ: phản hồi JSON có op (success/exception/add/replace…) điều khiển luồng Commerce — kiến thức chung, chưa xác minh trong phiên
- **Tài liệu:** https://developer.adobe.com/commerce/extensibility/webhooks/signature-verification
- **Payload mẫu chính thức:** ? · **mẫu kèm header:** ?
- **Ghi chú:** Magento Open Source không có webhook gốc. Adobe I/O Events (x-adobe-digital-signature-1/2) là cơ chế khác.
- **Nguồn:** <https://developer.adobe.com/commerce/extensibility/webhooks/signature-verification>

