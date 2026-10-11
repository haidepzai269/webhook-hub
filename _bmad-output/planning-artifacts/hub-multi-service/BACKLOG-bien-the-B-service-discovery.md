# BACKLOG — Biến thể B: hub tự nối sang service (service discovery qua `/.well-known/hub`)

> Ghi ngày 2026-10-11, theo quyết định của Admin. Đây là tài liệu thiết kế để làm sau. Chưa có code, chưa có ADR.
> Nguồn đối chiếu: `docs/ARCHITECTURE.md` §7.3 (SSRF), `SPEC-hub-multi-service.md` §4.2/§4.3/§4.6/§4.7/§4.11/§4.12,
> `SPEC-dev-experience.md` (DX1/DX2/DX3), `verification/SPEC-verification.md` §3. Code đã đọc: `service-resources.controller.ts`,
> `endpoint-verifier.ts`, `api/api.controller.ts`, `libs/hub-sdk/src/{client,webhook,cli}.ts`, `apps/shop/src/main.ts`, `libs/crypto/src/ssrf.ts`.

## 0. Trạng thái

- **BACKLOG, chưa lên lịch.** Chỉ làm sau khi xong **biến thể A** (hub nối sang provider bên trái, nút "Kết nối PayOS")
  và sau toàn bộ S0–S14 cùng DX1–DX3.
- Khi lên lịch: viết ADR trước (giao thức `/.well-known/hub` + đổi mã), thêm tiền tố `SD:` vào bảng §3.1 của
  SPEC-verification và vào `verify/spec-sources.json`. Nếu không thêm, `verify:map` sẽ báo mọi `[SD:Tn]` là mã ma.
- Hai quyết định cùng ngày mà B dựa vào: (1) spec mới cho phép console tạo endpoint, và **hub sinh `whsec_`**; `ensure()` vẫn nhận
  secret do service đưa. (2) Allowlist "source nào là tiền thật" **ở lại phía service** (BB-1).

## 1. Vì sao hoãn

| Lý do | Chi tiết |
|---|---|
| Hub phải làm thêm nhiều việc | Thêm một giao thức mới (bản khai + đổi mã), thêm SDK phía service (`hub.middleware()`), thêm một lớp test bảo mật (SSRF, hứng secret, leo quyền source). |
| Kiểu A đã đủ | AWS (SNS HTTP subscription) và Cloudflare chỉ cho người dùng dán URL rồi xác nhận. Hub hiện đã có đúng mức đó: `POST /endpoints` + challenge + `ensure()`. |
| Không chặn luận điểm chính | Luận điểm của đồ án là "vào nhiều kiểu, ra một kiểu" và thêm provider bằng adapter. B chỉ làm DX phía bên phải tốt hơn. |
| Mở rộng lên sau vẫn kịp | B là lớp bọc trên các route sẵn có (`endpoints`, `subscriptions`, `verify`). Không đổi schema lõi, không đổi ingest hay worker. |

Hiện trạng để so sánh: Shop cần `HUB_URL`, `HUB_SIGNING_SECRET`, `SHOP_PUBLIC_URL`, `SHOP_PAYMENT_SOURCE_KEYS` (và `SHOP_PORT`),
rồi gọi `hub.endpoints.ensure({..., signingSecret, sourceKeys, exclusive: true})` ở `apps/shop/src/main.ts:213`. Với B-đầy đủ,
service chỉ còn cần `HUB_URL` cùng URL công khai của chính nó.

## 2. Luồng

```
 Dev (console hub)          hub-api                                   Service (có @hub/sdk middleware)
 ─────────────────          ───────                                   ────────────────────────────────
 1. "Kết nối service" ──►  POST /api/v1/projects/:p/service-links
    dán https://svc.example     │
                                │ 2. SSRF guard (pin IP, không redirect, ≤5s, ≤16KB)
                                ├──── GET https://svc.example/.well-known/hub ───►  middleware trả bản khai JSON
                                │◄─── { version, webhookPath, eventTypes, sources? } ┘
                                │ 3. Kiểm bản khai: type hợp lệ theo catalog, sources ⊂ project
                                │    Hiện cho dev xác nhận (bảng: URL, types, sources) ◄── dev bấm "Đồng ý"
                                │ 4. Tạo Endpoint (hub sinh whsec_) + Subscription  (đúng đường POST /endpoints nội bộ)
                                │ 5. Challenge (endpoint-verifier hiện có), ký bằng whsec_ mới
                                │    ── POST webhookPath {type:"endpoint.verification",...} ──►
                                │      B-nhẹ:  middleware chưa có secret → xem §4.1
                                │      B-đầy đủ: body challenge kèm `linkCode` ─────────────►  middleware nhận mã
                                │                                                       │
                                │◄── POST /v1/p/:project/link-codes/redeem (Bearer hk_…) ┘ 6. đổi mã lấy whsec_
                                │ 7. Trả whsec_ (một lần), đánh dấu mã đã dùng
                                │    middleware lưu secret, trả challenge đã ký đúng → VERIFIED
 8. Console: VERIFIED ◄─────────┘
```

Các bước:
1. Dev có quyền `manage:endpoints` trên project dán base URL. Console gọi route console mới (người dùng JWT, không phải API key).
2. Hub gọi `GET <base>/.well-known/hub` qua `createSsrfSafeAxiosConfig` (cùng guard với `endpoint-verifier.ts`).
3. Hub kiểm bản khai (§3). Bước này **không ghi gì vào DB**. Console hiện bản xem trước, dev phải bấm xác nhận.
4. Hub tạo endpoint và subscription bằng chính logic của `POST /endpoints` và `POST /subscriptions`, không viết đường riêng.
5. Challenge chạy y hệt S6/§4.7 (`endpoint.verification`, `webhook-id = verify_<ulid>`).
6–7. Giao secret theo một trong hai nhánh (§4).
8. Endpoint chưa VERIFIED thì không có delivery. Đây là luật sẵn có của ARCHITECTURE §7 và vẫn giữ nguyên.

## 3. Định dạng `/.well-known/hub`

```json
{
  "hubDiscovery": "1",
  "service": { "name": "shop", "contact": "ops@shop.example" },
  "webhookPath": "/hub-webhook",
  "eventTypes": ["payment.received"],
  "sources": { "sourceKeys": ["src_payos_main", "src_sepay_main"], "required": false },
  "secretDelivery": ["link-code", "manual"]
}
```

| Trường | Luật |
|---|---|
| `hubDiscovery` | Bắt buộc. Chuỗi phiên bản chính. Hub chỉ hiểu `"1"`; giá trị khác trả 422 `unsupported_discovery_version`. Thêm trường không phá vỡ thì không tăng bản. Đổi nghĩa thì tăng `"2"`, và hub giữ song song bản cũ ít nhất một đợt. |
| `webhookPath` | Bắt buộc. Đường dẫn **tương đối**, bắt đầu bằng `/`. Không nhận URL tuyệt đối, vì nếu nhận thì bản khai có thể chỉ hub sang host khác. URL endpoint = origin dán vào + `webhookPath`. |
| `eventTypes` | Bắt buộc, từ 1 đến 50 phần tử. Mỗi phần tử là kiểu chuẩn hoặc wildcard đúng theo §4.6 (`payment.*`). Kiểu không có trong catalog trả 422. |
| `sources` | Tuỳ chọn. Chỉ là **gợi ý**. Xem §6, R3. Key không thuộc project trả 422 `unknown_source`, như `resolveSourceKeys` hiện có. |
| `secretDelivery` | Thứ tự service ưu tiên. Không có `link-code` thì hub dùng B-nhẹ. |
| Trường lạ | Bỏ qua, nhưng ghi vào audit để dễ gỡ lỗi. |

Ràng buộc khi tải bản khai: `Content-Type: application/json`, tối đa 16KB, timeout 5s, không theo redirect, chỉ GET.
Bản khai **không chứa bí mật** và ai cũng đọc được. Middleware chỉ phục vụ nó khi chưa liên kết, hoặc khi cấu hình cho phép.

## 4. B-nhẹ và B-đầy đủ

### 4.1 B-nhẹ (hiện secret một lần)
- Hub sinh `whsec_` (`generateWhsecSecret`, dùng chung với `POST /endpoints` khi thiếu `signingSecret`). Console hiện secret **một lần** để dev chép vào `.env`.
- Challenge lần đầu sẽ FAILED, vì service chưa có secret. Sau khi dev dán secret và khởi động lại service, dev bấm "Kiểm lại" (`POST …/endpoints/:id/verify`).
  Khác biệt lớn nhất so với hiện tại: dev không còn phải tự nghĩ ra secret và tự gọi `ensure()`.

### 4.2 B-đầy đủ (đổi mã, dev không mở `.env`)
Mẫu tham khảo: OAuth authorization code, luồng cài app của Slack và Shopify.

1. Sau bước 4, hub sinh `linkCode = "hlc_" + base64url(32 byte)`. DB chỉ lưu `sha256(linkCode)` cùng `endpointId`, `projectId`, `expiresAt = now + 5 phút`, `usedAt = NULL`.
2. Hub gửi challenge **không ký** (service chưa có secret), body `{"type":"endpoint.link","linkCode":"hlc_…","project":"cafe"}`.
   Service trả ngay 202. Việc tiếp theo là service tự gọi hub.
3. Middleware gọi `POST /v1/p/:project/link-codes/redeem` với `Authorization: Bearer <API key của chính service>` (lấy từ `HUB_URL`) và body `{"linkCode":"hlc_…"}`.
4. Hub kiểm, trong **một transaction** có `SELECT … FOR UPDATE`:
   - hash khớp (`timingSafeCompare`), `usedAt IS NULL`, `expiresAt > now`;
   - project của key bằng project của mã; key có `manage:endpoints`;
   - nếu đạt: `usedAt = now`, `endpoint.createdByKeyId = key.id`, audit `endpoint.linked`, trả `{endpointId, signingSecret: "whsec_…"}` **một lần**.
   - Mã đã dùng, hết hạn hoặc sai: trả 410 `link_code_invalid` (cùng một câu cho cả ba, để không làm oracle). Mã đã dùng mà bị dùng lại thì hub **thu hồi** secret vừa cấp, đưa endpoint về PENDING và ghi audit `endpoint.link_replay`.
5. Middleware lưu secret qua callback `onSecret(secret)` do dev cấp (file, secret manager, DB). Sau đó hub chạy challenge chuẩn (§4.7, có ký) → VERIFIED.
6. Hết 5 phút mà chưa đổi mã: endpoint ở trạng thái FAILED với `verificationError = link_not_redeemed`, và `verificationFix` (DX1) gợi ý service kiểm `HUB_URL`.

Lý do service phải tự gọi hub để đổi mã thay vì hub gửi secret thẳng: kẻ dán URL của mình vào sẽ nhận được `linkCode`, nhưng
không có API key của project nên không đổi được mã. Xem §6, R2.

### 4.3 So sánh

| | B-nhẹ | B-đầy đủ |
|---|---|---|
| Dev đụng `.env` | 1 lần (dán `whsec_`) | 0 lần, chỉ cần `HUB_URL` có sẵn |
| Secret đi qua | Màn hình console, clipboard | Kênh TLS service→hub, xác thực bằng API key |
| Giao thức mới | Chỉ `/.well-known/hub` | Thêm `endpoint.link`, `link-codes/redeem`, bảng `link_codes` |
| SDK | Middleware tuỳ chọn | Bắt buộc dùng middleware hoặc tự cài redeem |
| Bề mặt tấn công | Như hiện tại | Thêm đổi mã: replay, đua, đoán mã |
| Ước lượng | ~6h | ~14h (gồm cả B-nhẹ) |

## 5. Thay đổi dự kiến và ước lượng

| Phần | Việc | Giờ |
|---|---|---|
| Backend console | `POST /api/v1/…/service-links/preview` (tải và kiểm bản khai, không ghi DB) và `POST …/service-links` (tạo endpoint + sub, gọi lại logic `service-resources`). Hiện console `POST /api/v1/destinations` **không** sinh `whsec_` và **không** chạy challenge. Phải làm theo quyết định (1) trước. | 3 |
| Backend | `DiscoveryFetcher` (SSRF guard, 16KB, 5s, không redirect) + validator bản khai theo catalog | 2 |
| Backend (B-đầy đủ) | Migration `link_codes` (có `tenant_id`, đi qua `TenantScopedRepository`, BB-5), route `link-codes/redeem` `@RequireScope('manage:endpoints')`, thu hồi khi replay, audit | 4 |
| SDK | `hub.middleware({ webhookPath, eventTypes, sources?, onEvent, onSecret?, getSecret })`: phục vụ `/.well-known/hub`, trả challenge (đã có `challengeResponse`), verify chữ ký (đã có `verifyWebhook`), xử lý `endpoint.link` | 3 |
| UI | Nút "Kết nối service", màn xem trước bản khai, hiện secret một lần (B-nhẹ), trạng thái chờ đổi mã (B-đầy đủ) | 2 |
| Shop | Bỏ `ensure()` và `HUB_SIGNING_SECRET` nếu chuyển hẳn sang B-đầy đủ; **giữ** `SHOP_PAYMENT_SOURCE_KEYS` và kiểm `trustedSourceIds` ở `readPayment` | 1 |
| Tài liệu, test, probe | §7, `docs/ERRORS.md` (mã mới), Quickstart thêm nhánh B | 3 |
| **Tổng** | B-nhẹ khoảng 6h · B-đầy đủ khoảng 18h | |

`ensure()` **không bỏ**, vẫn dùng cho tự động hoá và CI. B chỉ là thêm một lối vào.

## 6. Rủi ro bảo mật và cách chặn

| # | Rủi ro | Cách chặn |
|---|---|---|
| R1 | **SSRF:** hub gọi ra URL do người dán vào (`/.well-known/hub` và `webhookPath`) | Bắt buộc dùng `createSsrfSafeAxiosConfig`: pin IP chống DNS rebinding, không redirect. Chặn dải private khi không ở `NODE_ENV=development`; link-local `169.254/16` và `fe80::/10` bị chặn ở mọi môi trường (ARCH §7.3, ADR-076). `webhookPath` chỉ nhận đường dẫn tương đối nên không đổi được host. Lỗi trả `ssrf_blocked` và `fix` trỏ sang `hub listen` (DX1 §2.3). Giới hạn tốc độ preview theo người dùng. |
| R2 | **Hứng secret:** kẻ khác dán URL của mình để nhận secret | B-đầy đủ: secret chỉ trả cho key đúng project, có `manage:endpoints`, và mã chỉ dùng một lần. B-nhẹ: secret chỉ hiện cho người đã đăng nhập console và có quyền; không bao giờ gửi secret đến URL. |
| R3 | **Bản khai xin quá quyền:** sources không thuộc project, hoặc vượt allowlist nghiệp vụ | Sources bị giới hạn trong project của người dán, key lạ trả 422 `unknown_source`. Người dán phải có `manage:endpoints`. Bản khai chỉ là **gợi ý**: hub không coi việc ghim source theo bản khai là "tin tiền thật". Service vẫn kiểm `trustedSourceIds` bằng allowlist của chính nó (BB-1, quyết định 2). Lệch giữa hai bên thì service trả 503 hoặc bỏ qua, không ghi nhận tiền. |
| R4 | Replay hoặc đua khi đổi mã | `FOR UPDATE` + `usedAt`, TTL 5 phút, chỉ lưu hash. Mã bị dùng lại thì thu hồi secret (§4.2, bước 4). |
| R5 | Đoán mã hoặc làm oracle | Mã 256 bit; mọi lỗi trả cùng một mã 410; so sánh bằng `timingSafeCompare`; giới hạn tốc độ theo key. |
| R6 | Lộ bí mật trong log hoặc audit | Audit chỉ ghi `endpointId`, `keyId`, không ghi mã hay secret. Luật catalog lỗi DX1 vẫn áp dụng. |
| R7 | Bản khai bị đổi sau khi liên kết | Hub chỉ đọc bản khai lúc liên kết. Muốn đổi thì liên kết lại hoặc sửa sub ở console. Không tự đồng bộ ngầm. |

## 7. Test dự kiến (theo luật SPEC-verification §3)

Tiền tố `SD:`. Mỗi test mang đúng một mã. Dòng nào chạm bảo mật phải có probe (§6.3) chứng minh test biết đỏ.

| Mã | Tầng | Tình huống | Mong đợi |
|---|---|---|---|
| [SD:T1] | unit | Validator: bản khai hợp lệ (mẫu §3) | ok, URL = origin + `webhookPath` |
| [SD:T2] | unit | `webhookPath` là URL tuyệt đối, hoặc có `//`, `..` | 422 `invalid_discovery` |
| [SD:T3] | unit | `hubDiscovery: "2"` | 422 `unsupported_discovery_version` |
| [SD:T4] | unit | `eventTypes` có kiểu ngoài catalog | 422, nêu tên kiểu |
| [SD:T5] | L1 | Fetcher tới `127.0.0.1` / `169.254.169.254`, `NODE_ENV=production` | `ssrf_blocked`, không có request đi ra (probe: bỏ guard thì test đỏ) |
| [SD:T6] | L1 | Bản khai trả 302 hoặc lớn hơn 16KB | bị từ chối, không theo redirect |
| [SD:T7] | L1 | Preview không ghi DB | đếm số dòng endpoint và sub không đổi |
| [SD:T8] | L1 | Bản khai xin sourceKey của project khác | 422 `unknown_source`, không tạo gì |
| [SD:T9] | L1 | Redeem đúng key, đúng project, trong 5 phút | 200 có `whsec_`, `usedAt` được set, audit `endpoint.linked` |
| [SD:T10] | L1 | Redeem bằng key của project khác | 410 (giống hệt khi mã sai), secret không lộ |
| [SD:T11] | L1 | Redeem bằng key thiếu `manage:endpoints` | 403 `missing_scope` |
| [SD:T12] | L1 | Redeem sau 5 phút | 410, endpoint FAILED `link_not_redeemed` |
| [SD:T13] | L1 | Hai redeem song song cùng mã | đúng một lần 200; lần kia 410 và secret bị thu hồi (probe: bỏ `FOR UPDATE` thì test đỏ) |
| [SD:T14] | L1 | Bảng `link_codes` chỉ chứa hash | không có chuỗi `hlc_` nào trong DB |
| [SD:T15] | unit | `hub.middleware()` phục vụ `/.well-known/hub`, trả challenge đã verify, từ chối body không ký | 200 / 200 / 401 |
| [SD:T16] | L2 | E2E B-đầy đủ: service mẫu chỉ có `HUB_URL` → bấm "Kết nối" → `hub trigger payment.received` → service nhận | VERIFIED, nhận đúng 1 sự kiện |
| [SD:T17] | L2 | Bản khai xin source "tiền thật" mà allowlist của service không có | service không ghi nhận tiền (BB-1) |
| [SD:T18] | L2 | Kẻ hứng: URL lạ nhận `linkCode`, thử redeem bằng key của project mình | 410, endpoint của nạn nhân không có secret nào lộ |

## 8. Câu hỏi mở

1. Thực thể "service link" có cần bảng riêng không, hay chỉ cần thêm cột `linkedVia` trên destination?
2. B-đầy đủ có bắt buộc service đã có API key từ trước không? Nếu bắt buộc, dev vẫn phải dán `HUB_URL` một lần. Câu hỏi là có nên để hub cấp luôn key trong lúc đổi mã, tức thành "cài app" thật như Slack, hay không.
3. Challenge `endpoint.link` gửi đi không ký. Có nên ký bằng một khoá công khai của hub (Ed25519, kiểu `v1a,` của Standard Webhooks) để service biết request thật sự đến từ hub không?
4. Khi `sources` của bản khai lệch với allowlist của service: hub chỉ cảnh báo trên console, hay chặn bước tạo?
5. Có cho đồng bộ lại bản khai (thêm `eventTypes`) mà không cần liên kết lại không? Nếu cho thì cần quy trình xác nhận thứ hai.
6. Ở môi trường deployed (Render), service đang ngủ có thể không trả `/.well-known/hub` trong 5s. Có cần retry hoặc thông báo "đang đánh thức service" không?
