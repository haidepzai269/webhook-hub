# SPEC — Chiều ra lệnh (Actions): service nhờ hub gọi API provider bằng credentials hub đang giữ

> **Trạng thái:** sẵn sàng cho phiên DEV. Admin đã trả lời §12 ngày 12/10: Shop chuyển sang tạo link qua hub, được nâng trần dòng. **Chưa code.**
> **ADR:** ADR-164, ghi cùng lúc với spec này.
> **Tiền tố test:** `AC:`. Phiên dev thêm vào bảng §3.1 SPEC-verification và `verify/spec-sources.json`.
> **Tính chất:** **tuỳ chọn hoàn toàn.** Tắt nó đi thì hub vẫn là webhook hub như hiện nay, không có hành vi nào đổi.

---

## 0. Đọc trước khi làm

- `CLAUDE.md`: năm bất biến. Luật "thêm provider = class adapter + registry". Luật "khoá chống trùng không bao giờ ngẫu nhiên".
- `SPEC-ket-noi.md` §4 (khung connector KN2). Spec này **dựa** trên khung đó, không dựng lại.
- Code thật:
  - `libs/providers/src/provider.interface.ts`: `connector?` là mẫu cho năng lực tuỳ chọn; `actions?` làm y hệt.
  - `libs/providers/src/connectors/payos.connector.ts` (field `clientId`/`apiKey`/`checksumKey`) và `connectors/http.ts` (`connectorFetch`).
  - `apps/hub-api/src/modules/console/source-connection.service.ts`: thứ tự **COMMIT trước, gọi provider ngoài tx, TX ghi kết quả**, lease `PENDING_STALE_MS`. Spec này dùng lại nguyên khuôn đó.
  - `libs/database/prisma/schema.prisma` `SourceConnection` (credentials AES-GCM, RLS).
  - `apps/shop/src/payos.ts`: cách ký request và verify response đang chạy thật (ADR-141). Phần này sẽ chuyển vào adapter.

## 1. Vì sao

Ngày 12/10 Admin hỏi: *"Hub đã giữ đủ 3 key PayOS rồi, sao Shop vẫn phải điền lại?"*

Câu trả lời lúc đó là đúng thiết kế: hub chỉ lo **chiều nhận** (sự kiện từ provider đi vào), còn **chiều ra lệnh** (tạo link thanh toán) vẫn do service tự gọi. Admin chấp nhận ranh giới này, nhưng chốt thêm:

> Hỗ trợ chiều ra lệnh **như một tính năng không bắt buộc**, dành cho **backend ít kỹ thuật** muốn kết nối đơn giản, nhưng vẫn **đầy đủ idempotency và khoá concurrency**.

**Thước đo:**
- **Backend ít kỹ thuật:** chỉ có `HUB_URL`, không giữ key provider nào. Tạo được link thanh toán bằng **một** lệnh `curl`, hoặc 3 dòng SDK, không phải tự ký HMAC.
- **Không tạo trùng:** cùng một lệnh gửi lặp N lần (do retry, double-click, hai instance chạy song song) thì provider chỉ ghi nhận **một** link. Kiểm bằng test AC-C1..C4.
- **Không bắt buộc:** project không bật Actions thì mọi route `/actions` trả `403 actions_disabled`. Không có migration hay hành vi nào bắt service phải đổi.

**Ngoài phạm vi:**
- Hoàn tiền, chi hộ (payout), và mọi lệnh làm **tiền rời khỏi** tài khoản. Xem §11.
- Lệnh cho GitHub/Stripe (khung cho phép, nhưng chưa viết).
- Hub tự retry một lệnh thất bại ở chế độ nền. Lệnh là đồng bộ; service quyết định có retry hay không.
- Gắn sự kiện `payment.received` ngược về `actionId`. Việc này làm đổi catalog, để AC6 tuỳ chọn.

---

## 2. Bức tranh

```
                 CHIỀU NHẬN (đã có)                               CHIỀU RA LỆNH (spec này, tuỳ chọn)
 PayOS ──webhook──▶ Hub ──whsec_──▶ Service           Service ──HUB_URL + Idempotency-Key──▶ Hub ──x-api-key + HMAC──▶ PayOS
                    │                                                                         │
                    └─ source_connections (credentials AES-GCM) ◀─── cùng một bản ghi ────────┘
```

Hai chiều dùng **chung** credentials đã lưu ở KN2. Đây là lý do tính năng này rẻ: không thêm nơi lưu bí mật nào.

**Các quyết định đã bàn (party mode 12/10):**

| # | Quyết định | Lý do / người đề xuất |
|---|---|---|
| D1 | **Tuỳ chọn ở 3 tầng:** adapter có `actions?` · kết nối bật `actions_enabled` (mặc định **tắt**) · API key có scope `act:payments` | Winston, Mary: apiKey PayOS có quyền tạo link → quyền tối thiểu |
| D2 | Lệnh chạy **đồng bộ** trong `hub-api`, timeout 10 giây | John: low-tech cần `checkoutUrl` ngay trong response. Không đi qua worker/queue |
| D3 | Từ vựng **trung lập với provider**: `payment.link.create/get/cancel`, field `reference` là chuỗi mờ | BB-1: hub không biết "đơn hàng". `orderCode` chỉ nằm trong adapter PayOS |
| D4 | **Hub cấp khoá phía provider** (`remote_key`, với PayOS là `orderCode` số) **trước khi** gọi | Amelia: biết trước id phía provider thì đối soát được khi mất response. Khoá đến từ sequence của DB, không ngẫu nhiên |
| D5 | **PostgreSQL là trọng tài** của idempotency lệnh: unique `(tenant_id, source_id, action_type, idempotency_key)` | Winston: tinh thần BB-2. **Không** dùng Redis lock cho lệnh |
| D6 | Khoá concurrency = **lease trên dòng + fencing token `attempt`**. Không giữ transaction trong lúc gọi mạng | Amelia: khuôn của `source-connection.service.ts`. Giữ tx qua HTTP 10 giây sẽ ăn hết pool Neon |
| D7 | Thiếu `Idempotency-Key` thì **mặc định `ref:<reference>`**. Thiếu cả hai → 400 | Sally: low-tech không biết Idempotency-Key là gì, nhưng có mã đơn |
| D8 | **0 lệnh Redis** trên đường lệnh. Rate limit dùng `WindowLimiter` trong bộ nhớ | Ngân sách R1/ADR-062 không đổi |

---

## 3. Mô hình dữ liệu

### 3.1 Bảng `hub.actions` (mới, có tenant, RLS + FORCE như các bảng tenant khác)

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid PK | Trả cho service là `actionId` (tiền tố `act_` + ULID ở API) |
| `tenant_id` | uuid | BB-5. FK ghép `(source_id, tenant_id)` → `sources(id, tenant_id)` như `source_connections` |
| `source_id` | uuid | Source có kết nối đang bật Actions |
| `action_type` | varchar(64) | `payment.link.create` · `payment.link.cancel` |
| `idempotency_key` | varchar(255) | Do service gửi, hoặc `ref:<reference>` (D7) |
| `request_hash` | char(64) | sha256 của input đã chuẩn hoá (khoá sắp a→z). Phát hiện cùng key nhưng khác nội dung |
| `reference` | varchar(64) null | Chuỗi mờ của service. Hub không hiểu, chỉ lưu và trả lại |
| `remote_key` | varchar(64) | Khoá phía provider do hub cấp (D4). PayOS: `orderCode` |
| `status` | enum | `PENDING` · `SUCCEEDED` · `FAILED` · `UNKNOWN` (xem §4) |
| `attempt` | int | **Fencing token.** Tăng mỗi lần một request nhận lease |
| `lease_until` | timestamptz | Hết hạn thì request khác được nhận lại (§5.2) |
| `result` | jsonb null | Output chuẩn khi `SUCCEEDED`. **Không** chứa bí mật |
| `error_code` / `error_fix` | varchar / text | Khuôn ADR-136 |
| `created_by_key_id` | uuid | API key đã gọi (audit) |
| `created_at` / `updated_at` / `expires_at` | timestamptz | `expires_at` = max(hạn link + 24h, created_at + 24h). Cleanup xoá sau mốc này |

**Ràng buộc:**
- `UNIQUE (tenant_id, source_id, action_type, idempotency_key)`. Đây là trọng tài (D5).
- `UNIQUE (source_id, remote_key)`. Hai lệnh không bao giờ dùng chung một `orderCode`.
- `remote_key` lấy từ sequence `hub.action_remote_seq` (bigint). PayOS cần `orderCode` ≤ 9007199254740991, và sequence không bao giờ chạm tới giới hạn này.

### 3.2 `hub.source_connections`: thêm cột

- `actions_enabled boolean NOT NULL DEFAULT false`
- `actions_enabled_at timestamptz null`

Bật hoặc tắt đều ghi audit (`actor`, tên trường, **không** ghi giá trị).

### 3.3 Scope API key

Thêm `act:payments` vào `API_SCOPES` (`libs/common/src/api-key.ts`). Key cũ **không** tự có scope này.

---

## 4. Máy trạng thái của một lệnh

```
             nhận lease (TX1)            provider trả lời rõ ràng (TX2, khớp attempt)
  (mới) ───────────────────▶ PENDING ────────────────────────────────▶ SUCCEEDED
                               │  │
                               │  └─ provider từ chối rõ ràng (4xx, code≠00 và không phải "đã tồn tại") ──▶ FAILED
                               │
                               └─ timeout / lỗi mạng / 5xx sau khi ĐÃ gửi ──▶ UNKNOWN
                                                                              │
                         request lặp lại hoặc lease hết hạn → ĐỐI SOÁT (§5.3) ─┘──▶ SUCCEEDED | FAILED
```

- `FAILED` là **trạng thái cuối** cho key đó. Gửi lại cùng key thì nhận lại đúng lỗi cũ. Muốn thử lại phải dùng key mới.
- `UNKNOWN` **không bao giờ** là trạng thái cuối. Request kế tiếp với cùng key sẽ đối soát trước khi làm gì khác.
- Lỗi **trước khi** gửi (thiếu credentials, input sai, Actions đang tắt) thì không tạo dòng nào. Trả lỗi ngay.

---

## 5. Idempotency và khoá concurrency (lõi của spec)

### 5.1 Luồng `POST …/actions/payment.link.create`

```
TX1 (ngắn, < 50 ms):
  INSERT INTO hub.actions (…, status='PENDING', attempt=1, lease_until=now()+30s, remote_key=nextval(seq))
  ON CONFLICT (tenant_id, source_id, action_type, idempotency_key) DO NOTHING
  RETURNING *
  ├─ chèn được    → mình giữ lease (attempt=1). COMMIT.
  └─ đã có dòng   → SELECT … FOR UPDATE, rồi quyết định theo bảng 5.2. COMMIT.

NGOÀI TX:  gọi provider (timeout 10 s), dùng remote_key đã cấp.

TX2:
  UPDATE hub.actions SET status=…, result=…, lease_until=NULL
  WHERE id=:id AND attempt=:myAttempt          ← fencing
  ├─ 1 dòng → trả kết quả.
  └─ 0 dòng → đã có request khác nhận lease (mình chậm quá 30 s). KHÔNG ghi đè.
              Đọc lại dòng và trả trạng thái hiện tại của nó.
```

**Vì sao không giữ `FOR UPDATE` suốt lúc gọi PayOS:** giữ một kết nối DB 10 giây cho mỗi lệnh sẽ làm cạn pool của Neon free tier, và Render SIGKILL giữa chừng sẽ để lại khoá treo. Lease có hạn tự giải phóng. Fencing bảo đảm request "sống lại muộn" không ghi đè kết quả mới hơn.

### 5.2 Bảng quyết định khi đã có dòng (cùng idempotency key)

| Trạng thái dòng | `request_hash` khác? | Phản hồi |
|---|---|---|
| bất kỳ | **khác** | `422 idempotency_key_reused`. fix: "Cùng Idempotency-Key nhưng nội dung khác — dùng key mới cho lệnh mới" |
| `SUCCEEDED` | giống | `200` + `result` đã lưu, header `Idempotent-Replayed: true`. **Không** gọi provider |
| `FAILED` | giống | Trả lại đúng lỗi đã lưu, header `Idempotent-Replayed: true` |
| `PENDING`, lease **còn hạn** | giống | `409 action_in_progress` + `Retry-After: 2` |
| `PENDING` lease **hết hạn**, hoặc `UNKNOWN` | giống | **Nhận lại lease**: `UPDATE … SET attempt=attempt+1, lease_until=now()+30s WHERE id=:id AND (lease_until < now() OR status='UNKNOWN')`. Chỉ một request thắng (CAS). Bên thắng chạy **đối soát §5.3**. Bên thua nhận `409 action_in_progress` |

### 5.3 Đối soát khi không biết lệnh trước đã tới provider hay chưa

Adapter khai báo `remoteIdempotency` cho từng lệnh. Lõi chỉ đọc giá trị này, **không** `if (provider === …)`:

| Giá trị | Ý nghĩa | Lõi làm gì khi đối soát |
|---|---|---|
| `'lookup'` (PayOS) | Provider tra được theo `remote_key` | Gọi `find(remote_key)`. Tìm thấy → `SUCCEEDED` với dữ liệu tìm được. Không thấy → gửi lại `create` **cùng** `remote_key`; provider tự chặn trùng (PayOS mã `231`), nếu gặp `231` thì gọi `find` lần nữa |
| `'native'` (Stripe, sau này) | Provider nhận Idempotency-Key của riêng nó | Gửi lại với cùng key phía provider (`hub-act-<id>`) |
| `'none'` | Không có cách nào biết chắc | **Không tự gửi lại.** Giữ `UNKNOWN`, trả `202 { status: 'unknown', fix }`. Service tự quyết |

**Điểm cần kiểm khi làm (PayOS):** `GET /v2/payment-requests/{orderCode}` có trả `checkoutUrl` và `qrCode` không? Nếu không:
- Dựng `checkoutUrl` từ `paymentLinkId` (theo khuôn PayOS đang dùng) **chỉ khi** đã kiểm bằng tài liệu hoặc gọi thật. Ghi kết quả vào §13.
- Nếu không dựng được: **huỷ link cũ** (`cancel`, chờ provider xác nhận) rồi tạo lại với `remote_key` **mới**, và ghi `superseded_remote_key` vào `result`. An toàn vì link cũ đã chắc chắn bị huỷ trước khi tạo link mới.

### 5.4 Hai idempotency key khác nhau cùng một `reference`

Ví dụ service sinh key ngẫu nhiên (sai luật), hoặc người dùng bấm hai lần ở hai tab. Hub **không** chặn ở mức DB, vì `reference` là chuỗi mờ và service có thể cố ý tạo lại link cho cùng một đơn sau khi link cũ hết hạn. Thay vào đó:
- Response có thêm `siblings: [{actionId, status, createdAt}]`: các lệnh **còn hiệu lực** có cùng `reference` trên cùng source (truy vấn có index `(source_id, reference)`).
- Tài liệu và SDK khuyên dùng **mặc định D7** (key = `ref:<reference>`), để low-tech đi đường an toàn mà không cần biết gì.

### 5.5 Tắt Actions hoặc ngắt kết nối khi đang có lệnh chạy

- TX1 đọc `actions_enabled` **trong cùng tx** và khoá dòng kết nối bằng `FOR SHARE`. Thao tác tắt lấy `FOR UPDATE` trên dòng đó, nên lệnh và thao tác tắt được xếp thứ tự.
- Lệnh đã qua TX1 thì vẫn được chạy xong. Hub không cắt ngang một lệnh đã gửi tới provider.
- Kết nối bị lưu trữ (ADR-161) thì xử lý như đang tắt: `403 actions_disabled`.

### 5.6 Tắt máy (SIGTERM, `SHUTDOWN_TIMEOUT_MS=25000`)

Lệnh đang chạy có timeout 10 giây, nhỏ hơn 25 giây, nên thường kịp xong. Nếu bị SIGKILL giữa chừng, dòng còn `PENDING` với lease 30 giây. Request lặp lại sau 30 giây sẽ nhận lease và đối soát (§5.3). Không mất, không trùng.

---

## 6. Interface adapter (`libs/providers`)

```ts
// provider.interface.ts — thêm, cạnh `connector?`
export type RemoteIdempotency = 'lookup' | 'native' | 'none';

export interface ActionCallInput extends ConnectorCallInput {   // credentials + baseUrl đã có
  remoteKey: string;            // hub cấp (D4)
}

export interface PaymentLinkInput {
  amount: number;               // int > 0, VND
  currency: 'VND';
  reference: string | null;     // chuỗi mờ của service
  description: string;          // adapter kiểm giới hạn của provider (PayOS: 9 ký tự với tài khoản không liên kết)
  returnUrl: string; cancelUrl: string;   // chỉ http(s)
  expiresAt: string;            // ISO 8601
}
export interface PaymentLinkResult {
  checkoutUrl: string; qrCode: string | null;
  providerRef: string;          // PayOS paymentLinkId
  status: 'open' | 'paid' | 'cancelled' | 'expired';
  expiresAt: string;
}

export interface ProviderActions {
  'payment.link.create'?: {
    remoteIdempotency: RemoteIdempotency;
    run(input: ActionCallInput & { link: PaymentLinkInput }): Promise<PaymentLinkResult>;
    find?(input: ActionCallInput): Promise<PaymentLinkResult | null>;     // bắt buộc khi 'lookup'
  };
  'payment.link.cancel'?: { run(input: ActionCallInput & { reason?: string }): Promise<PaymentLinkResult> };
}

export interface ProviderAdapter {
  // …
  readonly actions?: ProviderActions;   // không có → 422 action_unsupported
}
```

**Lỗi adapter:** adapter ném `ActionError(code, fix, kind)` với `kind`:
- `'rejected'` → `FAILED` (cuối).
- `'unknown'` → `UNKNOWN`.
- `'duplicate'` → đối soát ngay bằng `find`.

Mọi so sánh chữ ký phản hồi dùng `timingSafeCompare` (ADR-058). Chữ ký request dùng `checksumKey` của **SourceSecret version hiện hành**, không dùng key cũ đang trong thời gian chồng.

**PayOS** (`libs/providers/src/actions/payos.actions.ts`): chuyển logic ký và verify từ `apps/shop/src/payos.ts` sang đây. Test đối chiếu chữ ký dùng SDK `@payos/node` làm oracle, như U-test của ADR-141.

---

## 7. API (`/v1/p/:project`, API key, scope `act:payments`)

| Route | Mô tả |
|---|---|
| `POST /sources/:sourceKey/actions/payment.link.create` | Header `Idempotency-Key` (tuỳ chọn, D7). Body = `PaymentLinkInput` (`currency` mặc định `VND`) |
| `POST /sources/:sourceKey/actions/payment.link.cancel` | Body `{ actionId, reason? }`. Tự idempotent: huỷ link đã huỷ vẫn trả 200 |
| `GET /actions/:actionId` | Đọc trạng thái. `UNKNOWN` thì đối soát luôn (có lease, như §5.2) |

**Response thành công:**

```json
{ "actionId": "act_01J…", "status": "succeeded", "reference": "DH1234567",
  "result": { "checkoutUrl": "https://pay.payos.vn/web/…", "qrCode": "000201…", "providerRef": "a1b2…",
              "status": "open", "expiresAt": "2026-10-12T10:25:00Z" },
  "siblings": [] }
```

**Lỗi** theo khuôn `{error, message, fix, docsUrl, requestId}` (ADR-136). Thêm vào `docs/ERRORS.md`:

| HTTP | `error` | Khi nào |
|---|---|---|
| 403 | `actions_disabled` | Kết nối chưa bật Actions, hoặc đã lưu trữ. fix: "Console › Nguồn › Kết nối PayOS › bật 'Cho service tạo link qua hub'" |
| 403 | `insufficient_scope` | Key thiếu `act:payments` |
| 404 | `not_found` | `sourceKey` hoặc `actionId` lạ, hay thuộc project khác: **cùng một body** (A2) |
| 409 | `action_in_progress` | §5.2, kèm `Retry-After` |
| 422 | `action_unsupported` | Adapter không có lệnh này |
| 422 | `idempotency_key_reused` | §5.2 |
| 422 | `invalid_action_input` | Kèm `field` (vd `description` quá 9 ký tự với PayOS) |
| 502 | `provider_rejected` | `FAILED`, kèm `providerCode` và `fix` |
| 202 | (không phải lỗi) `status: "unknown"` | Chỉ khi `remoteIdempotency: 'none'` |
| 429 | `rate_limited` | `WindowLimiter` 30 lệnh/phút/source (trong bộ nhớ, mỗi instance) |

---

## 8. Trải nghiệm "low-tech" (thước đo §1)

**curl, không cần thư viện:**

```bash
curl -X POST "$HUB/v1/p/cafe/sources/src_payos_main/actions/payment.link.create" \
  -H "Authorization: Bearer hk_live_…" -H "Content-Type: application/json" \
  -d '{"amount":50000,"reference":"DH1234567","description":"DH1234567",
       "returnUrl":"https://cafe.vn/ok","cancelUrl":"https://cafe.vn/huy","expiresAt":"2026-10-12T10:25:00Z"}'
```

Gọi lại y hệt bao nhiêu lần cũng ra **cùng** `checkoutUrl` (D7 + §5.2).

**SDK (`@hub/sdk`):**

```ts
const link = await hub.actions.payment.createLink('src_payos_main', { amount: 50000, reference: order.code, description: order.code, returnUrl, cancelUrl, expiresAt });
```

SDK tự retry `409 action_in_progress` và lỗi mạng theo `Retry-After` (trần 30 giây, như `listen` ở ADR-143). Retry luôn giữ **cùng** Idempotency-Key.

**Console:** trong màn "Kết nối PayOS" có công tắc *"Cho service trong project tạo link thanh toán qua hub"* (mặc định tắt) và đoạn curl mẫu ở trên, đã điền sẵn `sourceKey`.

---

## 9. Shop: chuyển sang tạo link PayOS qua hub (Admin chốt Q1, 12/10)

**Thứ tự chọn kênh tạo link** (`apps/shop/src/payos.ts`, hàm chọn chế độ):

| Shop có gì | Chế độ | Ghi chú |
|---|---|---|
| Đủ 3 key PayOS (DB hoặc env, như `payosConfig()` hiện nay) | **Gọi thẳng** (như ADR-141) | Giữ lại để tính năng hub vẫn là **tuỳ chọn** |
| Không có key PayOS, có `HUB_URL` và một source PayOS trong `paymentSourceKeys` | **Qua hub** (`hub.actions.payment.createLink`) | **Chế độ mặc định từ nay.** Deploy Shop xoá 3 key PayOS |
| Không cả hai | Ẩn PayOS, chỉ còn SePay/VietQR | Như hiện nay |

- **Không bao giờ thử chế độ này rồi rơi sang chế độ kia trong cùng một lần tạo link.** Lý do: lệnh qua hub có thể đang `UNKNOWN` (PayOS đã tạo link với `orderCode` do hub cấp), nếu Shop lại gọi thẳng với `orderCode` của mình thì một đơn có **hai** link trả được tiền. Chế độ được quyết **một lần** theo cấu hình, lỗi thì trả lỗi.
- **`reference` = mã đơn** (`DH` + 7 số), **`description` = mã đơn.** Webhook về vẫn có `memo` chứa `DH\d+`, nên luồng khớp đơn của Shop không đổi (BB-1).
- **`orderCode` của PayOS do hub cấp** (D4), không còn là phần số của mã đơn. Cột `payos_payment_link_id` lưu `result.providerRef`. Giới hạn "9×10⁶ mã đơn" của ADR-141 chỉ còn áp cho chế độ gọi thẳng.
- **Idempotency-Key:** để trống, hub mặc định `ref:<mã đơn>` (D7). Khách bấm "Thanh toán" hai lần hoặc Shop retry thì ra **cùng** `checkoutUrl`.
- **Lỗi:**
  - `409 action_in_progress`: SDK tự retry.
  - `403 actions_disabled`: Shop trả 503 cho web, kèm `fix` "Chủ project bật 'Cho service tạo link qua hub' ở console".
  - `502 provider_rejected`: như lỗi PayOS hiện nay.
- **Key của Shop** (`HUB_URL`) phải có thêm scope `act:payments`.
  - `POST /settings/test-hub` báo thiếu scope này bằng **cảnh báo**, không chặn lưu, vì Shop vẫn có thể gọi thẳng nếu có key.
  - Trang Cài đặt hiện **chế độ PayOS đang dùng**: "qua hub" / "gọi thẳng" / "tắt". Ô 3 key PayOS chuyển thành phần "Nâng cao (không bắt buộc)", có ghi chú: *"Bỏ trống để tạo link qua hub."*
- **Trần dòng:** Admin chấp nhận nâng trần `apps/shop/src`. Phiên DEV ghi **ADR mới** (nâng ~600 → ~650) cùng lúc với commit. Không được vượt mức đã ghi.

**Test Shop (`AC:` nhóm S):**
- **AC-SH1:** không có key PayOS, hub bật Actions → `POST /orders` (PayOS) trả `checkoutUrl` từ hub. Fake hub ghi nhận `Idempotency-Key` trống / `reference` = mã đơn.
- **AC-SH2:** đủ 3 key → gọi thẳng, **không** gọi hub (fetch giả của hub không bị chạm).
- **AC-SH3:** hub trả lỗi (5xx/timeout) ở chế độ qua hub → Shop **không** gọi thẳng PayOS, kể cả khi env có `SHOP_PAYOS_API_BASE`.
- **AC-SH4:** tạo link hai lần cho cùng đơn → cùng `reference` → cùng `checkoutUrl`.
- **AC-SH5 (L2, LOCAL):** đi hết một vòng web → Shop → hub → fake PayOS → webhook về hub → Shop, đơn chuyển `PAID`.

## 10. Quan sát

- **Metrics** (Prometheus, đếm trong bộ nhớ):
  - `hub_actions_total{action_type, provider, status}`
  - `hub_action_duration_seconds` (histogram)
  - `hub_action_reconcile_total{outcome}`
- **Log** có `actionId`, `attempt`, `remoteKey`. **Không** log credentials, chữ ký hay `checkoutUrl` đầy đủ.
- **Console:** tab "Lệnh" trong trang Nguồn, liệt kê 50 lệnh gần nhất (trạng thái, reference, thời gian). Không có nút gửi lại: gửi lại là việc của service.
- **Cleanup** dòng hết `expires_at` nằm trong job cleanup hiện có của `hub-worker` (Redis lock, ADR-020).

---

## 11. Bảo mật

- **Quyền tối thiểu (D1):** cần **cả** `actions_enabled` lẫn scope `act:payments`. Lộ một key `read:events` không tạo được link.
- **Chỉ lệnh làm tiền đi VÀO** (tạo/huỷ link nhận tiền). Lệnh làm tiền đi **ra** (hoàn tiền, chi hộ) **cấm** trong khung này. Nếu muốn có thì cần spec riêng, xác nhận hai bước và ADR riêng.
- `returnUrl`/`cancelUrl`: chỉ `http(s)`. Hub **không** gọi các URL này nên không có rủi ro SSRF; chúng chỉ được chuyển cho provider.
- Base URL provider đi qua `connectorBaseUrl(spec)`: production luôn là URL cứng. Fake PayOS trong `tools/verify-sink/fake-providers.js` chỉ dùng ngoài production.
- `result` và response **không bao giờ** chứa credentials. `RedactSecretsInterceptor` áp cho các route mới.

---

## 12. Quyết định của Admin (12/10)

| # | Câu hỏi | Admin chốt |
|---|---|---|
| Q1 | Shop có dùng chế độ "qua hub" không? | **Có.** Shop chuyển sang tạo link qua hub làm mặc định. Gọi thẳng chỉ còn khi Shop có đủ 3 key (§9) |
| Q1b | Trần 600 dòng của `apps/shop/src` | **Được nâng.** ADR riêng ghi cùng commit |
| Q2 | AC6 (`actionId` trong `payment.received`) | Để sau. Không làm trong spec này |
| Q3 | Lease 30 giây | Giữ 30 giây |

## 13. Kế hoạch và test

| Bước | Nội dung | Test (`AC:`) |
|---|---|---|
| AC1 | Migration: `hub.actions` + sequence + RLS/FORCE + GRANT; cột `actions_enabled`; scope `act:payments` | AC-D1: RLS chặn đọc chéo tenant. AC-D2: FK ghép từ chối source của project khác |
| AC2 | `ProviderActions` + PayOS actions (create/find/cancel) + fake PayOS trong sink | AC-P1: chữ ký khớp oracle `@payos/node`. AC-P2: phản hồi chữ ký sai → `FAILED provider_bad_signature`. AC-P3: mã `231` → `kind:'duplicate'` |
| AC3 | `ActionService` (TX1 / gọi / TX2, lease, fencing, đối soát) + routes + lỗi | Xem nhóm C dưới đây |
| AC4 | Console: công tắc + tab "Lệnh" + curl mẫu | AC-U1: mặc định tắt. AC-U2: bật/tắt có audit |
| AC5 | SDK `hub.actions.payment.createLink` + `docs/QUICKSTART.md` phần "Tạo link qua hub" | AC-S1: SDK retry 409 với **cùng** key |
| AC7 | Shop chuyển sang qua hub (§9) + ADR nâng trần | AC-SH1..SH5 |
| AC6 | (tuỳ Q2) `actionId` trong `payment.received` | — |

**Nhóm C (concurrency / idempotency), bắt buộc ở L1 với PostgreSQL thật:**
- **AC-C1:** 20 request song song cùng key → fake PayOS nhận đúng **1** lần `create`; cả 20 đều nhận cùng `actionId`, hoặc `409` rồi retry ra cùng kết quả.
- **AC-C2:** cùng key nhưng khác `amount` → `422 idempotency_key_reused`, provider **không** bị gọi.
- **AC-C3 (fencing):** request A nhận lease, fake PayOS treo 35 giây. B nhận lại lease (attempt=2), đối soát và `SUCCEEDED`. Khi A trả về muộn, TX2 của A cập nhật 0 dòng, kết quả của B còn nguyên.
- **AC-C4 (mất response):** fake PayOS tạo link xong nhưng đóng kết nối trước khi trả lời → `UNKNOWN`. Request lặp lại đối soát bằng `find` → `SUCCEEDED`, provider chỉ có **1** link.
- **AC-C5:** tắt Actions song song với 10 lệnh. Mỗi lệnh hoặc chạy xong, hoặc `403`; không có dòng `PENDING` nào bị treo quá lease.
- **AC-C6:** kill `hub-api` giữa lúc gọi (L2 chaos, LOCAL) → sau 30 giây lặp lại cùng key → `SUCCEEDED`, 1 link.
- **AC-G1 (gate):** lõi `ActionService` không chứa chuỗi tên provider nào (`payos|stripe|github|sepay`). Cùng kiểu với gate P-KN1.
- **AC-G2:** `redis-budget.spec.ts` không đổi: đường lệnh 0 lệnh Redis.

**Ghi lệch giữa spec và code thật tại đây khi làm:**
- (trống)
