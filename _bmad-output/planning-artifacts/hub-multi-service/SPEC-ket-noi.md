# SPEC — Kết nối hai đầu: console tạo endpoint (hub sinh `whsec_`) + hub tự nối sang provider (biến thể A)

> **Trạng thái:** sẵn sàng cho phiên DEV. Làm **sau** khi S0–S14 xong (DX1/DX3b đã xong, ADR-134/136).
> **ADR:** ADR-138 (ghi cùng lúc với spec này).
> **Tiền tố test:** `KN:` (phiên dev thêm vào bảng §3.1 SPEC-verification + `verify/spec-sources.json`, xem §10).
> **Không thuộc spec này:** biến thể B (hub đọc `/.well-known/hub` của service). Xem `BACKLOG-bien-the-B-service-discovery.md`.

---

## 0. Đọc trước khi làm

- `CLAUDE.md` (bốn bất biến, luật "thêm provider = class adapter + registry, không `if (provider === 'x')` trong lõi").
- `docs/ARCHITECTURE.md`: mục endpoint, SSRF guard, source/secret.
- Code thật (đừng theo spec một cách mù quáng; chỗ nào lệch thì ghi vào §11):
  - `apps/hub-api/src/modules/api/api.controller.ts`: `POST sources` (:143), `POST destinations` (:206).
  - `apps/hub-api/src/modules/service-api/service-resources.controller.ts`: `POST endpoints` (:170). Đã sinh `whsec_`, đã challenge, đã adopt (ADR-098/101).
  - `apps/hub-api/src/modules/api/redact-secrets.interceptor.ts`.
  - `libs/providers/src/provider.interface.ts` (`diagnose?` là mẫu cho năng lực tuỳ chọn).
  - `libs/crypto` (`aesGcmEncrypt`, `MASTER_KEY`).
  - `apps/hub-api/src/modules/auth/google-oauth.service.ts:32`: mẫu `*_FAKE_BASE_URL` chỉ chạy ngoài production.

## 1. Vì sao (Admin chốt ngày 11/10)

Hiện tại dev phải **làm tay ở cả hai đầu**:

```
tay 1  Console hub: tạo source, dán checksumKey, copy URL ingest
tay 2  Dashboard PayOS: dán URL ingest  (cạm bẫy 4: adapter phải chạy trước)
tay 3  Service: tự đăng ký endpoint bằng code (ensure) + điền env
```

Admin: *"tối ưu cho user tiết kiệm công sức đến mức tối đa: chỉ cần nhập hoặc điền, verify ở hub chúng ta và nó sẽ kết nối tới bên thứ 3 luôn. Đó chính là mục đích cuối cùng cho tiện lợi."* AWS và Cloudflare đều làm theo kiểu này.

| # | Quyết định | Ghi chú |
|---|---|---|
| Q1 | Gộp "console endpoint" và "biến thể A" vào **một spec** | spec này |
| Q2 | Secret của endpoint: **hub sinh**. `ensure()` vẫn nhận secret do service đưa (tự động hoá) | API service đã làm vậy (:217); thiếu ở console |
| Q3 | **Giữ allowlist source ở service** (Murat) | Shop hiện kiểm ở **hai lớp**: ghim `sourceKeys` + `exclusive` khi `ensure`, và kiểm `trustedSourceIds` lúc nhận (`apps/shop/src/main.ts:128–134`). Giữ nguyên |
| Q4 | **Biến thể A**: hub tự đăng ký URL ingest tại provider | PayOS, Stripe làm ngay. GitHub viết spec nhưng **hoãn** |
| Q5 | **Credentials của provider được LƯU** trong DB, khoanh theo project, giống AWS/Jira | Admin bác đề xuất "dùng một lần rồi quên". Điều kiện lưu: xem §4.3 |
| Q6 | Biến thể B: **để sau** | backlog riêng |

**Thước đo:** từ lúc mở console tới lúc PayOS báo "✅ Đã kết nối" thì dev **không mở dashboard PayOS lần nào**, và chỉ điền đúng các ô có trên một màn hình của PayOS.

**Ngoài phạm vi:**
- SePay tự động. API của họ đi qua OAuth2 app phải đăng ký, chưa chắc cá nhân được cấp; xem §6.
- GenericAdapter: theo định nghĩa không có API phía provider.
- Xoay `MASTER_KEY` / KMS.
- Biến thể B.

---

## 2. Bức tranh

```
                    ┌──────────────────── WEBHOOK HUB (Project) ────────────────────┐
 PayOS API  ◀══ KN3 ═╡ Connector  ──tạo trước──▶ Source ──▶ Nhật ký ──▶ Endpoint ══ KN1 ══▶ service
 Stripe API ◀══ KN4 ═╡ (KN2)                      (checksum)  sự kiện    (whsec_ do hub sinh,
 GitHub API ◀┄ KN5 ┄╡ credentials mã hoá                                   challenge, subscription)
                    └───────────────────────────────────────────────────────────────┘
          ▲                                                       ▲
     dev điền 1 màn hình                                  dev điền URL + tick event/source
```

---

## 3. KN1: Console tạo endpoint, hub sinh `whsec_`, chạy challenge

**Hiện trạng:** `POST /api/v1/destinations` nhận `signingSecret` tuỳ chọn, **không sinh**, **không challenge**, không tạo subscription. API service `POST /v1/p/:project/endpoints` thì đã làm đủ.

### 3.1 Backend

- **Tách logic dùng chung:** đưa phần lõi của `ServiceResourcesController.createEndpoint` (parse URL + SSRF, sinh `whsec_`, tạo PENDING trong tx có audit, challenge **ngoài** tx, ghi kết quả) ra `EndpointService`. Cả hai controller đều gọi service này. **Không** chép code.
  - Actor: console dùng `user:<id>`, service dùng `key:<id>`.
  - Adopt (ADR-098/101) **chỉ** áp dụng cho đường service API. Console không adopt.
- **Route console** (giữ prefix hiện có, scope `manage:endpoints`):
  - `POST /api/v1/endpoints`: body `{ name, url, eventTypes[], sourceIds[]?, signingSecret? }`. Tạo endpoint `type:'webhook'` + **một** subscription trong cùng tx với endpoint. Challenge xong mới trả response.
    - Response: `{ endpoint, subscription, verification, verificationFix?, signingSecret? }`.
    - `signingSecret` **chỉ có** khi hub sinh, và chỉ trả **một lần**.
  - `POST /api/v1/endpoints/:id/verify`: chạy lại challenge. Dùng chung `WindowLimiter(5/phút)`.
  - `POST /api/v1/endpoints/:id/rotate-secret`: sinh `whsec_` mới, trả một lần. **KN1b, tuỳ chọn:** giữ secret cũ 24 giờ, ký song song `v1,sigOld v1,sigNew`.
  - `POST /api/v1/destinations` **giữ nguyên** cho các loại đích khác (discord, …). Destination loại `webhook` tạo qua route cũ thì trả `422 use_endpoints_route` kèm `fix`.
- `eventTypes` kiểm theo catalog (`docs/EVENT-CATALOG.md`), sai thì 422. `sourceIds` phải thuộc project, không thì **404 giống hệt** id lạ (A2 cô lập).

### 3.2 UI (`apps/web`, trang `dashboard/destinations` hoặc trang mới `endpoints`)

Form gồm: URL, tick event type (lấy từ catalog), chọn source (multi-select lấy từ project).

Sau khi bấm:
- Hộp **"Secret chỉ hiện một lần"** có nút copy và dòng `.env: HUB_SIGNING_SECRET=whsec_…`.
- Trạng thái challenge ✅/❌. Nếu ❌ thì hiện `verificationFix` (khuôn lỗi ADR-136).

Trang chi tiết endpoint: delivery gần đây, nút Verify lại, nút Xoay secret.

### 3.3 Không đổi

- `ensure()` của SDK và Shop **giữ nguyên** (Q2).
- Shop **giữ** allowlist (Q3).

---

## 4. KN2: Khung connector (dùng chung cho mọi provider)

### 4.1 Interface: năng lực tuỳ chọn của adapter, KHÔNG phải nhánh trong lõi

```ts
// libs/providers/src/provider.interface.ts (thêm, giống kiểu diagnose?)
export interface ConnectorSpec {
  fields: { name: string; label: string; secret: boolean; help: string }[];   // UI dựng form từ đây
}
export interface ConnectResult {
  remoteRef: string;                 // id phía provider: PayOS accountNumber che, Stripe we_…, GitHub hook id
  display: string;                   // "CAFE ABC · ****1234"
  sourceSecret?: string;             // provider SINH secret ký (Stripe) -> hub lưu làm SourceSecret v1
}
export interface ProviderConnector {
  spec: ConnectorSpec;
  /** secretForSource: secret ký mà adapter.verify sẽ dùng, nếu do dev nhập (PayOS checksumKey) hoặc hub sinh (GitHub). */
  connect(input: { ingestUrl: string; credentials: Record<string, string>; secretForSource?: string; baseUrl: string }): Promise<ConnectResult>;
  status?(input: { credentials: Record<string, string>; remoteRef: string; baseUrl: string }): Promise<'ok' | 'drifted' | 'gone'>;
  disconnect?(input: { credentials: Record<string, string>; remoteRef: string; baseUrl: string }): Promise<void>;
}
// ProviderAdapter thêm:  connector?: ProviderConnector;
```

Lõi chỉ được hỏi `adapter.connector ? … : 422 connector_unsupported`. **Cấm** `switch (provider)` ở controller hoặc service (probe P-KN1 ở §8).

### 4.2 Dữ liệu

Bảng mới `hub.source_connections`, khoanh theo project:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid | |
| `tenant_id` | uuid | RLS + `TenantScopedRepository` (BB-5). FK tổng hợp `(tenant_id, source_id)` như các bảng khác |
| `source_id` | uuid UNIQUE | một source có tối đa một kết nối |
| `provider` | text | |
| `credentials_encrypted` | text | AES-256-GCM bằng `MASTER_KEY`, mẫu `aesGcmEncrypt` |
| `status` | `PENDING` · `CONNECTED` · `FAILED` · `DRIFTED` · `DISCONNECTED` | |
| `remote_ref`, `display` | text | không nhạy cảm |
| `ingest_url` | text | URL đã đăng ký tại provider, để phát hiện `HUB_PUBLIC_URL` đổi |
| `last_error`, `last_fix` | text | khuôn ADR-136 |
| `connected_at`, `last_checked_at`, `created_at`, `updated_at` | timestamptz | |

### 4.3 Lưu credentials: điều kiện bắt buộc (Q5)

Admin chốt **lưu**, khoanh theo project, như AWS/Jira. Nhờ đó có thể: kết nối lại, đổi URL khi đổi domain, kiểm tình trạng, ngắt kết nối. Đổi lại phải giữ đủ 7 điều kiện:

1. **Mã hoá khi lưu** (`credentials_encrypted`, AES-GCM, `MASTER_KEY`). Không có cột plaintext.
2. **Chỉ ghi, không đọc qua API.** `RedactSecretsInterceptor` thêm `credentialsEncrypted: 'hasCredentials'`. UI chỉ hiện `display` và 4 ký tự cuối của từng trường bí mật. Không route nào trả credentials.
3. **Không vào log, không vào audit.** Audit `source.connect` / `source.reconnect` / `source.disconnect` / `source.credentials_delete` chỉ ghi **tên trường**. Pino redact thêm `apiKey`, `clientId`, `checksumKey`, `credentials`.
4. **RLS + scope:** mọi thao tác cần `manage:sources`. Project khác thì **404 giống hệt**.
5. **Nút "Xoá credentials":** xoá cột mã hoá, giữ source và kết nối (status giữ nguyên). Muốn kết nối lại thì phải nhập lại.
6. **Hướng dẫn key ít quyền nhất:** UI ghi rõ với Stripe là dùng *restricted key* chỉ có quyền `webhook_endpoints: write`. PayOS không có key hạn chế, nên ghi rõ "key này tạo được link thanh toán; hub mã hoá và không bao giờ hiện lại".
7. **Ghi trong báo cáo:** credentials có quyền ghi bên thứ ba chỉ an toàn ngang `MASTER_KEY`. Lộ DB thì chưa sao, nhưng lộ DB **và** env thì lộ hết. Ghi vào phần đánh đổi của ADR-138, không giấu.

### 4.4 Luồng `POST /api/v1/sources/connect`

```
body: { provider, name, sourceKey?, credentials: {...} }
1. adapter.connector chưa có              -> 422 connector_unsupported (fix: "dùng POST /sources + dán URL ở dashboard provider")
2. HUB_PUBLIC_URL là localhost/IP private -> 422 public_url_required (fix: "named tunnel hoặc bản deployed")
3. TX: tạo Source (+ SourceSecret nếu secretForSource có sẵn) + source_connections PENDING + audit   ← COMMIT TRƯỚC
4. NGOÀI TX: connector.connect({ ingestUrl: HUB_PUBLIC_URL + /hooks/<provider>/<sourceKey>, ... })
      ↳ provider có thể bắn request kiểm tra vào ingest NGAY LÚC NÀY → source phải tồn tại, adapter phải trả 200
5. TX: thành công -> CONNECTED + display (+ SourceSecret từ result.sourceSecret) + audit
       thất bại   -> FAILED + last_error/last_fix (source GIỮ LẠI, bấm "Thử lại" không phải nhập lại)
6. Response 201 { source, connection: { status, display, fix? } } — luôn 201 kể cả FAILED (giống endpoint, :175)
```

Thứ tự ở bước 3 → 4 chính là lời giải cho **cạm bẫy 4** của CLAUDE.md. Không đảo.

Các route khác (cùng scope):
- `POST /api/v1/sources/:id/connection/retry`
- `GET /api/v1/sources/:id/connection`: gọi `status?` nếu có, tối đa 1 lần/phút.
- `DELETE /api/v1/sources/:id/connection`: gọi `disconnect?` nếu có, rồi đặt `DISCONNECTED`.
- `DELETE /api/v1/sources/:id/connection/credentials`

### 4.5 Base URL của provider: không tin env mặc định của SDK

SDK PayOS **tự đọc `process.env.PAYOS_BASE_URL`** (`node_modules/@payos/node/lib/client.d.ts:27`). Production lỡ có biến này thì credentials thật bị gửi tới một host lạ. Quy định:
- Connector **luôn truyền `baseURL` tường minh**.
- Giá trị lấy từ `connectorBaseUrl(provider)`: production thì cứng (`https://api-merchant.payos.vn`, `https://api.stripe.com`, `https://api.github.com`). Ngoài production thì đọc `PAYOS_FAKE_BASE_URL` / `STRIPE_FAKE_BASE_URL` / `GITHUB_FAKE_BASE_URL`, theo mẫu `google-oauth.service.ts:32`.
- Production mà có biến `*_FAKE_BASE_URL` thì **app không khởi động** (giống luật của `GOOGLE_OAUTH_FAKE_BASE_URL`).

### 4.6 Fake provider cho test (`tools/verify-sink`)

CI không được gọi provider thật (repo public, luật VF, không secret).
- `POST /_fake/payos/confirm-webhook`: đọc `x-client-id` / `x-api-key`. Sai thì trả lỗi giống PayOS. Đúng thì **POST một request kiểm tra có chữ ký** (checksum lấy từ cấu hình fake) vào `webhookUrl`.
  - Ingest trả 200 thì fake trả `{code:"00", data:{webhookUrl, accountName:"CAFE TEST", accountNumber:"0001234", …}}`.
  - Ingest trả khác 200 thì fake trả lỗi.
- `POST /_fake/stripe/v1/webhook_endpoints`: trả `{id:"we_test…", secret:"whsec_test…"}`. `DELETE` thì trả `{deleted:true}`.
- `GET /_requests` (đã có) ghi lại cả các lời gọi này, để test kiểm header và body.

---

## 5. Connector từng provider

### 5.1 KN3: PayOS (làm ngay, phục vụ hồi 3 của demo)

- **Form** (một màn hình "Kênh thanh toán" của PayOS): `clientId`, `apiKey` (bí mật), `checksumKey` (bí mật).
- `secretForSource = checksumKey`. Hub tạo `SourceSecret` v1 **trước** khi gọi PayOS, nên adapter verify được request kiểm tra.
- `connect`: `new PayOS({ clientId, apiKey, checksumKey, baseURL }).webhooks.confirm(ingestUrl)`, rồi `display = "${accountName} · ****${last4(accountNumber)}"`.
- **Cảnh báo ghi đè** (bắt buộc ở UI, và bắt buộc trong body là `acknowledgeOverwrite: true`, thiếu thì 422): *"Mỗi kênh PayOS chỉ có một webhook URL. Kết nối sẽ THAY URL hiện tại. Nếu backend của bạn đang nhận PayOS trực tiếp, nó sẽ ngừng nhận."*
- `status?`: **không làm** (PayOS chưa có API đọc URL hiện tại mà phòng xác minh được). `disconnect?`: **không có** (PayOS không xoá được URL), nên UI ghi "đổi URL ở dashboard PayOS nếu muốn ngắt".
- **⚠ Câu mở KQ1 (phải xử lý TRƯỚC khi code phần normalize): request kiểm tra của PayOS có thành `payment.received` không?**
  - Nếu chữ ký hợp lệ và có `data` giống giao dịch, nó sẽ được normalize rồi push sang mọi service subscribe `payment.received`. Shop có allowlist và tra theo đơn nên an toàn. Một service khác có thể cộng tiền ma.
  - **Chưa ai thấy bản thật.** Phiên dev phải lấy bằng chứng: tìm trong `raw_events` của bản deployed (lần Admin đăng ký URL PayOS trước đây) hoặc trong fixture `real` (SPEC-verification §5.3), rồi ghi body đã che vào §11.
  - **Yêu cầu** (bất kể bằng chứng ra sao): request kiểm tra **phải được lưu raw** (BB-3, nó là bằng chứng), **phải trả 200**, và **không được** ra `payment.received` tới subscriber. Cách nhận diện quyết định sau khi có bằng chứng, nằm **trong `PayOSAdapter`** (BB-1: từ vựng PayOS chỉ ở adapter). Ghi ADR khi chọn.

### 5.2 KN4: Stripe (làm ngay sau KN3)

- **Form:** `secretKey` (restricted, `webhook_endpoints: write`).
- `connect`: `POST {baseUrl}/v1/webhook_endpoints` với form-encoded `url=<ingestUrl>` và `enabled_events[]` theo các event mà `StripeAdapter.normalize` hiểu. Dùng `fetch`, **không thêm SDK Stripe**.
  - Response `secret` → `result.sourceSecret` → hub lưu làm `SourceSecret` v1.
  - **Dev không phải nhập secret ký.**
- `status?`: `GET /v1/webhook_endpoints/{we_id}`. Nếu `url` khác `ingest_url` → `drifted`; 404 → `gone`.
- `disconnect?`: `DELETE /v1/webhook_endpoints/{we_id}`.
- Chú ý: secret chỉ trả lúc tạo. Kết nối lại nghĩa là **tạo endpoint mới** ở Stripe, xoá cái cũ, rồi thêm `SourceSecret` version mới (dùng lại cơ chế `secretVersions` đã có, cả hai cùng verify trong lúc chuyển).

### 5.3 KN5: GitHub (**viết vào spec, CHƯA làm**; làm sau KN1–KN4, còn giờ thì làm)

- **Quyền:** cần token có `admin:repo_hook`, hoặc fine-grained PAT có quyền *Webhooks: write* trên repo.
  - **Không** nới scope của luồng đăng nhập GitHub (AU5 chỉ xin `read:user user:email` và không lưu token, `github-oauth.service.ts:16`).
  - Hai lựa chọn, chọn khi làm:
    - (a) dán fine-grained PAT vào form. Đơn giản, đi đúng khung §4.
    - (b) màn đồng ý OAuth **riêng** "Cho hub quản lý webhook repo", token lưu theo §4.3.
  - Phòng nghiêng (a) trước, (b) sau.
- **Form:** `token`, `owner`, `repo`, `events` (mặc định `push`, `pull_request`).
- `secretForSource`: **hub sinh** (32 byte ngẫu nhiên), lưu `SourceSecret` v1, gửi kèm trong `config.secret`. Dev không nhập secret.
- `connect`: `POST /repos/{owner}/{repo}/hooks` với `{config:{url, content_type:'json', secret}, events, active:true}`. GitHub bắn `ping` ngay, nên adapter GitHub phải trả 200 cho `ping` và **không** normalize nó ra `repo.*` (kiểm adapter hiện tại).
- `status?`: `GET /repos/{o}/{r}/hooks/{id}`. `disconnect?`: `DELETE …/hooks/{id}`.

---

## 6. SePay: giữ dán tay, Admin kiểm một việc

SePay **có** API `POST /api/v1/webhooks` (scope `webhook:write`, kèm `bank_account_id`, `authen_type` = `Api_Key` | `OAuth2.0` | `No_Authen`). Nhưng API này đi qua **OAuth2 app phải đăng ký**, tài liệu không nói cá nhân có được cấp không.

- **Admin:** thử đăng ký app ở SePay. Được thì thêm story KN6 theo đúng khung §4: hub sinh `api_key`, gửi `authen_type: Api_Key`, adapter SePay verify header `Apikey`.
- **Cho tới lúc đó:** SePay dùng luồng cũ (tạo source + copy URL), cộng thêm hướng dẫn từng bước trong UI.

Nguồn: https://docs.sepay.vn/oauth2/api-webhooks.html · https://developer.sepay.vn/en/sepay-webhooks/tao-webhook

---

## 7. Story (làm đúng thứ tự)

| ID | Story | Phụ thuộc | Ước lượng |
|---|---|---|---|
| **KN1** | `EndpointService` dùng chung + route console endpoints (sinh `whsec_`, challenge, subscription) + UI form/secret một lần/verify lại | S0–S14 | 3–4h |
| KN1b | (tuỳ chọn) xoay secret có thời gian chồng 24 giờ, ký hai chữ ký | KN1 | 2h |
| **KN2** | Interface `connector?` + bảng `source_connections` + route connect/retry/status/disconnect/credentials + redact + `connectorBaseUrl` + fake provider trong sink + UI form dựng từ `spec.fields` | KN1 | 4h |
| **KN3** | Connector PayOS + cảnh báo ghi đè + **KQ1 có bằng chứng** | KN2 | 2h (+ KQ1) |
| **KN4** | Connector Stripe (status, disconnect, secret do Stripe sinh) | KN2 | 1.5h |
| KN5 | Connector GitHub. **HOÃN**, chỉ làm khi KN1–KN4 đã REVIEWED và còn giờ | KN2 | 3h |
| KN6 | SePay. **Chỉ khi** Admin xác nhận đăng ký được OAuth app | KN2 | 2h |

Mỗi story theo vòng đời RED → GREEN → GATED → PROBED → REVIEWED (SPEC-verification §6), với khối `Verify:` trong commit.

**Cập nhật tài liệu khi xong KN3:**
- `docs/ARCHITECTURE.md`: thêm mục "Kết nối provider". Nêu rõ thứ tự source → commit → gọi provider.
- `CLAUDE.md`: sửa cạm bẫy 4 thành "nút Kết nối đã lo thứ tự; dán tay thì vẫn phải đúng thứ tự".
- `CLAUDE.md` mục Trạng thái: thêm một dòng.
- SPEC-verification §9.1 (hồi 3 demo): đổi bước Admin tạo source PayOS thành **"Kết nối PayOS"**.

---

## 8. Kịch bản test

### 8.1 Unit / L1 (`npx jest -w 2`, L1 dùng role `hub_app`, skip > 0 = đỏ)

| Mã | Kiểm |
|---|---|
| `[KN:U1]` | Console `POST /endpoints` không có `signingSecret` thì response có `whsec_…` đúng một lần. `GET` sau đó không có secret |
| `[KN:U2]` | Endpoint + subscription tạo **cùng tx**: subscription lỗi (sourceId lạ) thì không còn endpoint mồ côi |
| `[KN:U3]` | `sourceIds` của project khác → 404 **giống hệt byte** với id không tồn tại |
| `[KN:U4]` | Challenge chạy **ngoài** tx: mock challenge treo 3 giây thì không giữ connection PG (đếm pool) |
| `[KN:U5]` | `POST /destinations` với `type:'webhook'` → 422 `use_endpoints_route` có `fix` |
| `[KN:U6]` | Provider không có `connector` → 422 `connector_unsupported` |
| `[KN:U7]` | `HUB_PUBLIC_URL=http://localhost:4000` → 422 `public_url_required`, **không** gọi provider (sink `/_requests` rỗng) |
| `[KN:U8]` | Source + SourceSecret được COMMIT **trước** lời gọi provider: fake PayOS bắn request kiểm tra **trong lúc** `confirm` đang chờ, ingest vẫn trả 200 |
| `[KN:U9]` | Provider lỗi → kết nối `FAILED` + `last_fix`, source vẫn còn. `retry` thành công mà không phải nhập lại |
| `[KN:U10]` | `credentials_encrypted` không chứa plaintext (grep giá trị trong `SELECT *`). Không route nào trả credentials (quét mọi response GET của source) |
| `[KN:U11]` | Log (pino capture) và `audit_logs.metadata` không chứa giá trị `apiKey`/`checksumKey`/`secretKey` |
| `[KN:U12]` | `NODE_ENV=production` + `PAYOS_FAKE_BASE_URL` → app không khởi động. `PAYOS_BASE_URL` trong env **không** đổi được host connector gọi |
| `[KN:U13]` | PayOS thiếu `acknowledgeOverwrite` → 422 |
| `[KN:U14]` | Stripe: `secret` trong response thành `SourceSecret`. Event ký bằng secret đó thì verify qua |
| `[KN:U15]` | Stripe kết nối lại thì có SourceSecret version mới; event ký bằng secret cũ vẫn qua trong lúc chuyển; `DELETE` gọi đúng `we_id` cũ |
| `[KN:U16]` | Request kiểm tra của PayOS (theo bằng chứng KQ1) được lưu `raw_events`, trả 200, **không** sinh delivery `payment.received` |
| `[KN:U17]` | `xoá credentials` → cột null, `retry` trả 422 `credentials_required` |
| `[KN:U18]` | Thành viên không có `manage:sources` → 403 `missing_scope` ở mọi route §4.4 |

### 8.2 E2E trên hubv (`npm run verify`, L2)

| Mã | Kịch bản |
|---|---|
| `[KN:T1]` | Console tạo endpoint trỏ `http://sink:4100` → ✅ challenge. Publish `payment.received` thì sink nhận đúng chữ ký `whsec_` vừa hiện (`verify_sig`) |
| `[KN:T2]` | "Kết nối PayOS" với fake: thấy `CAFE TEST · ****1234`. Fake ký và bắn giao dịch thì event tới endpoint của T1 |
| `[KN:T3]` | "Kết nối Stripe" với fake → ✅. Ngắt thì fake nhận `DELETE` |
| `[KN:T4]` | Hai project A, B: project B không thấy và không thao tác được kết nối của A (404 giống hệt) |

### 8.3 Probe (SPEC-verification §6)

- **P-KN1:** chèn `if (provider === 'payos')` vào `sources.connect` của service. Grep gate phải đỏ.
- **P-KN2:** đảo bước 3 và 4 (gọi provider trước rồi mới commit). `[KN:U8]` phải đỏ.
- **P-KN3:** bỏ redact `credentialsEncrypted`. `[KN:U10]` phải đỏ.
- **P-KN4:** ghi `credentials` thẳng vào `audit.metadata`. `[KN:U11]` phải đỏ.

### 8.4 Người thật (Admin, trên bản deployed)

1. "Kết nối PayOS" bằng kênh thật → thấy tên tài khoản thật.
2. Thanh toán 2.000đ → event tới Shop.
3. Vào dashboard PayOS **chỉ để xem**: URL webhook đúng là URL của hub.

Ghi kết quả vào §12.

---

## 9. Demo

**Hồi 3** (thật và cô lập), thay bước "tạo source PayOS rồi sang PayOS dán URL":

> Admin mở hub → Sources → **Kết nối PayOS** → dán 3 ô của kênh → tick "Tôi hiểu URL cũ sẽ bị thay" → bấm.
> Màn hình hiện **"✅ CAFE … · ****…"**. Admin thanh toán 2.000đ thật → event chạy tới Shop.
> Admin không mở dashboard PayOS trước mặt hội đồng.

Câu nói khi bảo vệ: *"Hub tạo source và commit trước, rồi mới gọi PayOS. Vì PayOS bắn request kiểm tra ngay trong lúc đăng ký, nếu đảo thứ tự thì PayOS gọi vào một source chưa tồn tại."* (probe P-KN2 chứng minh).

---

## 10. Phối hợp

- **Tiền tố `KN:`:** thêm vào bảng §3.1 SPEC-verification và `verify/spec-sources.json`. Việc này do **phiên dev** làm cùng commit đầu tiên của KN1 (spec verification do phiên đó giữ).
- Spec này **không** sửa SPEC-hub-multi-service, SPEC-auth, DINH-CHINH.
- `KICH-BAN-TEST-DA-SERVICE.md` thêm chặng C (kết nối) **sau khi** KN3 xong, theo route thật.

## 11. Lệch so với spec (phiên DEV ghi)

- KQ1, bằng chứng request kiểm tra PayOS: …
- **KN1 (ADR-142):**
  - Route console nằm ở controller riêng `apps/hub-api/src/modules/console/endpoints.controller.ts` (không sửa `ApiController` ngoài 1 dòng 422 `use_endpoints_route`). Thêm `GET /api/v1/endpoints/:id` (trang chi tiết) và `GET /api/v1/catalog/event-types` (UI tick theo catalog — một nguồn ở `libs/common/src/canonical`).
  - "eventTypes kiểm theo catalog": chỉ siết trong không gian dành riêng `payment.*`/`repo.*` (`payment.recieved` → 422 `validation_failed`); kiểu riêng của service (`order.*`) vẫn hợp lệ — service publish kiểu riêng qua `/v1/p/:project/events`.
  - `sourceIds` sai khuôn / không tồn tại / khác project → cùng **404 `not_found`** (spec cũ của `/subscriptions` là 422 `unknown_source`; console endpoints theo §3.1 là 404). Kiểm nằm TRONG tx tạo endpoint nên lỗi rollback cả endpoint (U2).
  - `rotate-secret` chỉ cho endpoint do console tạo (`createdByKeyId` NULL). Endpoint của service → 409 `endpoint_owned_by_service` (service xoay qua `/v1/p/.../verify` + `signingSecret`, SDK `ensure()`). Xoay KHÔNG challenge lại (service chưa có secret mới — challenge sẽ FAILED và normalize bỏ qua endpoint); trạng thái verification giữ nguyên.
  - U4 "đếm pool": kiểm bằng **tính thấy được** — trong lúc challenge treo 3 s, một kết nối khác đã thấy endpoint + subscription + audit (tx đã COMMIT ⇒ kết nối đã trả về pool). Ổn định hơn đếm `pg_stat_activity` khi nhiều test chạy song song.
  - `WindowLimiter(5/phút)` của console là instance riêng (không chung bộ đếm với `/v1/p`).
  - UI: nút "Tạo endpoint webhook" + hộp chi tiết (delivery gần đây, Verify lại, Xoay secret) ở trang Đích; form cũ chỉ còn telegram/discord. Chưa có trang route riêng `endpoints`.

## 12. Checklist và kết quả

- [x] KN1 · [ ] KN1b (tuỳ chọn) · [ ] KN2 · [ ] KN3 · [ ] KN4 · [ ] KN5 (hoãn) · [ ] KN6 (chờ SePay)
- ADR mới: …

| Kịch bản | PASS/FAIL | Ghi chú | Ngày |
|---|---|---|---|
| KN:U1–U18 | | | |
| KN:T1–T4 | | | |
| P-KN1..4 | | | |
| §8.4 người thật | | tên tài khoản hiện ra: … | |
