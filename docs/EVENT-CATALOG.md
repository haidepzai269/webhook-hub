# Catalog kiểu sự kiện chuẩn (v1)

> **Vào nhiều kiểu, ra một kiểu** (ADR-053, S3-2 đợt 10/10). Mỗi bên thứ ba gửi JSON riêng; service
> nhận từ hub chỉ cần hiểu **một** hình dạng cho mỗi miền.
> Nguồn sự thật trong code: `libs/common/src/canonical/` (`payment.ts`, `repo.ts`, `time.ts`, `index.ts`).
> Hợp đồng được khoá bằng test `libs/providers/test/canonical-contract.spec.ts` (U50).

## 1. Phong bì (không đổi)

Body hub gửi tới đích webhook (`apps/hub-worker/src/senders/webhook.sender.ts`):

```jsonc
{
  "id": "evt_01K…",            // id event của hub — dùng để chống trùng phía bạn
  "type": "payment.received",  // kiểu chuẩn, hoặc <provider>.<kiểu gốc>
  "source": "sepay",           // TÊN provider (payos | sepay | stripe | github | generic | api) — KHÔNG phải danh tính
  "sourceId": "9b5c…",         // id source CỤ THỂ trong project (R-1, ADR-094) — so với sourceIds đã ghim để tin nguồn
  "subject": "payment:92704",  // payment:<providerTxnId> | repo:<fullName>
  "normalized": true,          // true = data theo catalog dưới đây; false = data = { raw }
  "data": { … },
  "occurredAt": "2026-10-10T07:02:37.000Z",
  "receivedAt": "2026-10-10T07:02:38.120Z",
  "renderedContent": "…"       // chỉ có khi subscription có template
}
```

## 2. Luật

1. **`normalized: true`** ⇔ `type` thuộc catalog (§3, §4) và `data` đã qua validator.
2. **`normalized: false`**: kiểu chưa có ánh xạ → `type = <provider>.<kiểu gốc>` (vd `stripe.customer.created`,
   `github.release.published`, `github.ping`), `data = { raw: <body gốc> }`.
3. **Không gian dành riêng:** `payment.*` và `repo.*` chỉ dành cho kiểu chuẩn. Adapter phát kiểu thuộc hai
   không gian này mà `data` sai khuôn → **lỗi normalize vĩnh viễn** (ADR-044): không có event, không có
   delivery, metric `hub_normalize_schema_errors_total{source}` +1; raw_event còn nguyên để sửa adapter
   rồi "Chuẩn hoá lại" (`POST /api/v1/raw-events/renormalize`). Hub **không** âm thầm hạ xuống `normalized:false`.
4. **`data.raw`** = body gốc đã parse, có ở mọi kiểu. Lối thoát cho trường riêng của provider
   (vd `orderCode` của PayOS chỉ nằm ở `data.raw.data.orderCode` — BB-1).
5. **Hình dạng ổn định:** mọi khoá dưới đây **luôn có mặt** (thiếu dữ liệu → `null`). Validator từ chối cả
   khoá thiếu lẫn khoá lạ. Catalog chỉ được **thêm** trường tuỳ chọn; đổi hay bỏ trường = kiểu mới
   (`payment.received.v2`).
6. **Số tiền:** số nguyên > 0, đơn vị nhỏ nhất ISO 4217 (VND = đồng, USD = cent); riêng `payment.failed` cho phép `0` (giao dịch lỗi có thể không kèm số tiền). `currency` 3 chữ in hoa.
7. **Thời gian:** ISO 8601 có múi giờ. Chuỗi `YYYY-MM-DD HH:mm:ss` không múi giờ của PayOS/SePay được hiểu
   là giờ Việt Nam (+07:00) — `parseProviderTime`. Unix giây (Stripe) → ISO.
   Provider không gửi thời gian giao dịch → dùng thời điểm hub **nhận** raw event (`raw_events.received_at`), nên chuẩn hoá lại vẫn ra cùng giá trị.
8. **`subject`** không chứa khái niệm của khách hàng: `payment:<providerTxnId>`, `repo:<fullName>`.
9. Event tạo trước S3-2 (kiểu `payment.succeeded`, `bank.transfer.*`, `repo.<event>`) **không** migrate;
   cột `events.normalized` của chúng mặc định `true`. Retention dọn dần.

## 3. Miền thanh toán

| Kiểu | Trường thời gian | PayOS | SePay | Stripe |
|---|---|---|---|---|
| `payment.received` | `paidAt` | `code==="00"` và `success!==false` | `transferType==="in"` hoặc thiếu | `payment_intent.succeeded` |
| `payment.sent` | `sentAt` | — | `transferType==="out"` | — |
| `payment.failed` | `failedAt`, `reason` | `code!=="00"` hoặc `success===false` | — | `payment_intent.payment_failed` |
| `payment.refunded` | `refundedAt` | — | — | `charge.refunded` |

Phần lõi chung (`PaymentCore`):

| Khoá | Kiểu | PayOS (`body.data.*`) | SePay (`body.*`) | Stripe (`body.data.object.*`) |
|---|---|---|---|---|
| `amount` | int > 0 (`payment.failed`: ≥ 0) | `amount` | `transferAmount` | `amount_received` / `amount` (failed) / `amount_refunded` |
| `currency` | `^[A-Z]{3}$` | `currency ?? "VND"` | `"VND"` | `currency.toUpperCase()` |
| `method` | enum | `"payment_link"` | `"bank_transfer"` | `payment_method_types[0]` (hoặc `payment_method_details.type` của charge) `=== "card"` ? `"card"` : `"other"` |
| `reference` | string \| null | `reference` | `referenceCode` | `id` |
| `memo` | string \| null | `description` | `content` | `description` |
| `counterparty` | `{name, accountNumber, bank}` \| null | `counterAccount*` (cả ba rỗng → `null`) | `null` | `null` |
| `account` | `{number, bank}` \| null | `{number: accountNumber, bank: null}` | `{number: accountNumber, bank: gateway}` | `null` |
| `providerTxnId` | string ≠ "" | `paymentLinkId ?? reference ?? "sha:"+hash(body)` | `String(id) ?? referenceCode ?? "sha:"+hash(body)` | `id ?? "sha:"+hash(body)` |
| `raw` | any | body | body | body (Stripe Event đầy đủ) |
| `reason` (failed) | string \| null | `body.desc ?? data.desc` | — | `last_payment_error.message` |

`method` hợp lệ: `bank_transfer | card | ewallet | payment_link | other`.

`hash(body)` = 32 hex đầu của sha256 trên **bytes gốc** — provider không gửi id nào thì vẫn có id ổn định (gửi lại y hệt → cùng giá trị, cùng khoá chống trùng).

Ví dụ — cùng một khoản 50.000đ qua PayOS và SePay ra **cùng tập khoá** (U37):

```json
{ "amount": 50000, "currency": "VND", "method": "bank_transfer", "reference": "MBVCB.3278907687",
  "memo": "DH123456 thanh toan", "counterparty": null, "account": { "number": "0123499999", "bank": "Vietcombank" },
  "providerTxnId": "92704", "raw": { "…": "body gốc" }, "paidAt": "2026-10-10T07:02:37.000Z" }
```

## 4. Miền repo (GitHub)

| GitHub (`X-GitHub-Event`) | Kiểu chuẩn |
|---|---|
| `push` | `repo.push` |
| `pull_request` | `repo.pull_request.<action>`; riêng `closed` + `merged:true` → `repo.pull_request.merged` |
| `issues` | `repo.issue.<action>` |
| mọi event khác (`ping`, `release`, `star`, `workflow_run`…) | `github.<event>[.<action>]`, `normalized:false` |

| Kiểu | Khoá |
|---|---|
| `repo.push` | `repo {fullName, url}`, `branch` (`refs/heads/x`), `tag` (`refs/tags/x`), `commits[≤20] {id, message, author, url, timestamp}`, `commitCount` (tổng thật), `actor {login}`, `compareUrl`, `raw` |
| `repo.pull_request.*` | `repo`, `number`, `title`, `state` (`open`/`closed`), `merged`, `url`, `author {login}`, `actor {login}`, `baseBranch`, `headBranch`, `raw` |
| `repo.issue.*` | `repo`, `number`, `title`, `state`, `url`, `author`, `actor`, `labels: string[]`, `raw` |

Không chép email của author vào phần chung (dữ liệu cá nhân); email vẫn trong `raw`.

## 5. Dùng trong subscription và template

- `eventTypes` khớp chính xác hoặc theo mẫu (`payment.*` = mọi sự kiện thanh toán, `*` = mọi sự kiện — S3-3).
- Template: `{{data.amount}} {{data.currency}}`, `{{data.memo}}`, `{{data.reference}}` đúng cho **mọi** nguồn
  thanh toán; `{{data.repo.fullName}}`, `{{data.actor.login}}` cho `repo.*`.

## 5b. Service tự phát và nguồn tuỳ chỉnh (đa service)

- **`POST /v1/p/:project/events`** (ADR-074): `type` thuộc không gian dành riêng (`payment.*`, `repo.*`) phải đúng khuôn catalog — sai → **422** `{"error":"schema_mismatch","field":"<tên trường>"}` NGAY lúc gọi, trước khi ghi. Kiểu riêng của service (vd `order.created`) là hợp đồng của chính service: `normalized: true`, `data` giữ nguyên.
- **GenericAdapter có `mapping`** (ADR-079): nguồn bên thứ ba chưa có adapter vẫn ra kiểu chuẩn thanh toán. Giá trị chỉ là tên trường **cấp một** của body hoặc `{"const": …}`:
  ```jsonc
  "eventType": "payment.received",
  "mapping": { "amount": "soTien", "currency": {"const":"VND"}, "method": {"const":"bank_transfer"},
               "reference": "maGD", "memo": "noiDung", "providerTxnId": "maGD", "paidAt": "thoiGian" },
  "timezone": "+07:00"
  ```
  Bắt buộc `amount`, `currency`, `method`, `providerTxnId` và trường thời gian của kiểu; `counterparty`/`account` = `null`; `raw` = body. Số tiền chỉ nhận số nguyên hoặc chuỗi toàn chữ số (`"50.000"` là sai). Body thiếu trường → lỗi normalize vĩnh viễn; chế độ lắng nghe báo `mapping_field_missing` + tên trường. Không có `mapping` thì `data = { raw }`, `normalized: false`.
- **SDK**: `import type { PaymentReceived, RepoPush } from '@hub/sdk'` — chỉ type, không kéo validator.
- **Bên nhận xử lý TIỀN phải kiểm `source`** (MS-R2, ADR-084): `payment.received` từ `api` (service tự phát) hay `generic` (nguồn tuỳ chỉnh) đúng khuôn nhưng không phải bằng chứng thanh toán của cổng. Tên provider KHÔNG phải danh tính (key `manage:sources` tạo được source `sepay` của riêng nó): ghim **source cụ thể** bằng `sourceKeys`/`sourceIds` trong subscription (MS-P2-1, ADR-089) — Shop ghim `src_payos_main,src_sepay_main`.

## 6. Ánh xạ sang CloudEvents 1.0 (chỉ tài liệu — hub KHÔNG đổi body)

Admin chốt (DINH-CHINH 10/10 §1 A1): body giữ phong bì của hub; ai cần CloudEvents thì ánh xạ như sau.

| CloudEvents | Hub |
|---|---|
| `specversion` | luôn `"1.0"` (không gửi) |
| `id` | `id` |
| `source` | URI tự dựng, vd `/sources/<sourceId>` (hub gửi `source` = tên provider) |
| `type` | `type` |
| `subject` | `subject` |
| `time` | `occurredAt` |
| `datacontenttype` | `"application/json"` |
| `data` | `data` |
| extension | `normalized`, `receivedAt` |
