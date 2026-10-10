# Demo đa project: hai service dùng chung một hub

> Kịch bản cho hội đồng (SPEC đa service §7.3). Script chạy được: `scripts/demo-multi-project.sh`.
> Mọi số liệu đo nằm ở `hubv` hoặc stack local, **không** ở deployed (ADR-019).

## 1. Thế giới seed (S12, ADR-082)

Seed tự chạy khi hub-api khởi động (`RUN_SEED=true`), idempotent theo slug. Tắt bằng `SEED_DEMO_PROJECTS=false`.

| Project | Môi trường | Source (mock) | Key | Endpoint | Subscription |
|---|---|---|---|---|---|
| `cafe` | test | SePay `src_sepay_cafe`, Apikey `demo_sepay_cafe_key_local_only` | `cafe-be`, đủ 4 scope, tiền tố `hk_test_` | `cafe-endpoint` | `payment.*` |
| `bookstore` | live | PayOS `src_payos_bookstore`, checksum `demo_payos_bookstore_checksum_local_only` | `bookstore-be`, đủ 4 scope, tiền tố `hk_live_` | `bookstore-endpoint` | `payment.*` |

- Seed **không bao giờ in key ra log** (MS-R6, ADR-087) — chỉ prefix. Muốn key cố định thì đặt trước `SEED_CAFE_API_KEY` / `SEED_BOOKSTORE_API_KEY`; không thì tạo key mới qua console `POST /api/v1/projects/:projectId/keys` (script demo tự làm việc này).
- Endpoint trỏ vào mock của chính stack: `${MOCK_BASE_URL}/mock/echo/<slug>` (local) hoặc `http://sink:4100/<slug>` (hubv, `DEMO_ENDPOINT_BASE_URL`, đọc lại payload ở `http://localhost:14100/_requests`).
- Mỗi key có `publish:events` đi kèm một source `api` (`api_<keyId>`, ADR-074).
- Secret mock là giá trị cố định **chỉ cho local**. Seed không chạy ở production.

## 2. Chạy

```bash
# hubv (mặc định) — script tự tạo key cho cafe/bookstore qua console admin
bash scripts/demo-multi-project.sh
# stack local
API=http://localhost:4000 SINK= OPERATOR_EMAIL=admin@hub.local OPERATOR_PASSWORD=<mật khẩu> PG_CONTAINER=webhook-hub-postgres \
  bash scripts/demo-multi-project.sh
```

Script không bắn gì vào Telegram hay Discord: chỉ dùng source của `cafe`/`bookstore`, và subscription của hai project này chỉ trỏ endpoint mock.

## 3. Sáu hồi và điều hội đồng nhìn thấy

| # | Làm | Thấy | Chứng minh |
|---|---|---|---|
| 1 | SePay mock bắn vào source của `cafe` | event `payment.received` thuộc `cafe`; endpoint `cafe` nhận 1 request, `bookstore` nhận **0** | Cô lập dữ liệu theo project (BB-5) |
| 2 | Key `bookstore` gọi `GET /v1/p/cafe/events` và `/v1/p/khongtontai/events` | cả hai **404** `{"error":"not_found"}`, body giống hệt | Không lộ project nào tồn tại (ADR-073) |
| 3 | Key demo tự tạo endpoint + subscription của nó (poll `endpointId` chỉ nhận endpoint của chính key, ADR-094), tắt endpoint, bắn 3 giao dịch, rồi `GET /v1/p/cafe/events?status=failed&endpointId=…` | đúng 3 sự kiện bị lỡ | Polling (A) là lưới an toàn khi push hỏng (ADR-077) |
| 4 | Tạo key tạm cho `cafe` rồi revoke | key tạm 401; `cafe-be` và `bookstore-be` vẫn 200 | Revoke chỉ ngắt đúng một service |
| 5 | Thêm "AB Bank" bằng GenericAdapter; gửi sai tên header rồi sửa | lắng nghe: `missing_header`, chờ `x-signature`, thấy `x-sig` → sau khi sửa: `ok` | Thêm nguồn không cần code; chẩn đoán không lộ chữ ký (ADR-079/080) |
| 6 | PayOS (bookstore), SePay (cafe), AB Bank có mapping (cafe), cùng 50.000đ | 3 dòng `payment.received`, cột khoá `data` **giống hệt nhau**, `normalized = t` | Vào nhiều kiểu, ra một kiểu (ADR-053) |

Kết quả một lần chạy trên hubv (2026-10-11):

```
1. cafe | payment.received | 50000 · sink /cafe: 1 request · sink /bookstore: 0 request
2. {"error":"not_found"} → HTTP 404 (hai lần, body giống hệt)
3. bị lỡ: 3 sự kiện [10003, 10002, 10001]
4. revoke → 204 · key vừa revoke → 401 · cafe-be → 200 · bookstore-be → 200
5. lắng nghe: {"ok":false,"reason":"missing_header","expectedHeader":"x-signature","candidateHeaders":["x-sig"]} → sửa → {"ok":true,"reason":"ok"}
6. cafe | generic | … | account,amount,counterparty,currency,memo,method,paidAt,providerTxnId,reference
   bookstore | payos | … | account,amount,counterparty,currency,memo,method,paidAt,providerTxnId,reference
   cafe | sepay | … | account,amount,counterparty,currency,memo,method,paidAt,providerTxnId,reference
```

## 4. Shop: một service thật dùng hub (S11)

Shop (`apps/shop`) không được seed tạo endpoint. Lúc khởi động nó dùng `@hub/sdk`:

```ts
const hub = createHubClient(process.env.HUB_URL);           // hub://hk_test_…@hub-api:4000/default
await hub.endpoints.ensure({ name: 'shop', url: `${SHOP_PUBLIC_URL}/hub-webhook`,
                             eventTypes: ['payment.received'], signingSecret: HUB_SIGNING_SECRET });
```

`/hub-webhook` chỉ có **một** nhánh xử lý thanh toán (`readPayment`), không có `if` theo provider: PayOS, SePay hay AB Bank đều đến với cùng hình dạng `payment.received`.

## 5. Hướng phát triển: semaphore theo endpoint (noisy neighbor)

Hiện tại cô lập giữa các project là "mềm": một đích chậm chỉ bị chặn bởi `DELIVERY_TIMEOUT_MS` và circuit breaker (ADR-078). Số đo T10 trên hubv (40 event vào đích ngủ 30s, rồi 20 event của project khác, 1 worker, prefetch 20):

| `DELIVERY_TIMEOUT_MS` | Trễ project bên cạnh p50 | p95 | Đích chậm |
|---|---|---|---|
| 5000 | 1712 ms | 2463 ms | 20/20 attempt "timeout", circuit OPEN |
| 10000 | 6424 ms | 7005 ms | 20/20 attempt "timeout", circuit OPEN |

Bước tiếp theo nếu cần cô lập cứng: semaphore số request đồng thời theo endpoint (Redis, ≤ 2 lệnh/delivery), hoặc tách queue theo project.
