# SPEC — Trải nghiệm dev: lỗi có hướng dẫn sửa, Quickstart 60 giây, `hub listen`

> **Đường dẫn file này:** `C:\webhook-hub\_bmad-output\planning-artifacts\hub-multi-service\SPEC-dev-experience.md`
> **Ngày:** 2026-10-10 · **Trạng thái:** sẵn sàng để dev, **làm SAU** `SPEC-hub-multi-service.md` (cùng thư mục) xong S0–S14
> **Nguồn quyết định:** ADR-055 (`docs/adr/README.md`) · bối cảnh: HANDOFF §4c
> **Ai đọc file này:**
> - **Phiên DEV:** đọc §0 → §5, làm story DX1 → DX3, đánh dấu ở §8.
> - **Phiên TEST:** đọc §0, §1, rồi chạy §6 và ghi kết quả vào §9.

---

## 0. Đọc trước khi làm

1. `CLAUDE.md` (BB-1..BB-5, quy tắc code). Luật cho phiên dev giống hệt §0 của `SPEC-hub-multi-service.md`:
   - mỗi story một commit;
   - chạy `npx jest -w 2`;
   - ADR lấy **số tiếp theo còn trống** (phiên khác cũng ghi ADR song song, nên kiểm ngay trước khi ghi);
   - mọi so sánh bí mật dùng `timingSafeCompare`.
2. `SPEC-hub-multi-service.md`, các mục: §4.3 (API service + bảng lỗi), §4.5 (polling), §4.7 (Standard Webhooks), §4.11 (SDK), §4.14 (kiểu chuẩn).
3. **Tiền đề phải có sẵn:** `libs/hub-sdk` (S11), `POST /events` (S4), polling + long-poll (S7), catalog kiểu chuẩn và fixture (S14). Thiếu cái nào thì dừng lại và báo, **không** tự làm tắt.

## 1. Vì sao (Admin chốt ngày 10/10)

> "Đặt mình vào vị trí dev, vị trí user… cho họ những gì họ cần, cảm thấy đáng: tiện lợi, setup dễ, quản lý dễ, uy tín, dễ scale, giống cách Cloudflare hay AWS làm."

Phòng đề xuất 4 thứ. Admin chốt như sau:

| # | Đề xuất | Chốt |
|---|---|---|
| 1 | Trang "Cam kết của hub" (công bố số đo) | **Không làm.** *"Chứng minh bằng hành động chứ không phải lời nói."* Số đo vẫn nằm ở chương đánh giá của báo cáo như kế hoạch cũ |
| 2 | Lỗi có hướng dẫn sửa | **Làm**, vì tạo uy tín. Story DX1 |
| 3 | Quickstart 60 giây | **Làm.** Story DX2 |
| 4 | `hub listen` (kiểu `stripe listen`) | **Làm.** Story DX3 |

**Thước đo chung của cả spec:** *thời gian từ 0 tới event đầu tiên* với một dev chưa từng thấy hub. Mục tiêu ≤ 60 giây tính từ lúc có connection string (Sally cược 60, Winston cược 90; cược một ly cà phê, đo ở TX2).

**Ngoài phạm vi:**
- UI đẹp: phiên `ui-revamp` chỉ làm 3 ô copy, xem §4.
- SDK cho ngôn ngữ khác Node.
- `hub listen` qua WebSocket hoặc tunnel.
- Trang status.
- Công bố SLA.

---

## 2. DX1 — Lỗi có hướng dẫn sửa

### 2.1 Định dạng lỗi (mọi response 4xx/5xx của **API service** `/v1/p/:project/*` và **console** `/api/v1/*`)

```jsonc
{
  "error": "missing_scope",                     // mã máy đọc, snake_case, ỔN ĐỊNH (đổi = breaking)
  "message": "This API key lacks the scope required for this action.",
  "fix": "Create a key with scope \"publish:events\" in the console (Project → Keys), or ask the hub admin.",
  "docsUrl": "docs/ERRORS.md#missing_scope",    // HUB_DOCS_URL + "#" + error; mặc định "docs/ERRORS.md"
  "requestId": "6f1c…",                         // correlation id của request (libs/common correlation)
  "required": "publish:events"                  // tham số riêng của từng mã (tuỳ mã, xem bảng)
}
```

- Header `x-request-id` = `requestId` trên **mọi** response, kể cả 2xx. Nhờ đó dev báo lỗi chỉ cần gửi một chuỗi, admin tra log ra ngay.
- `message` và `fix` viết **tiếng Anh**, theo thông lệ API (Stripe, Cloudflare). `docs/ERRORS.md` giải thích bằng **tiếng Việt**. Quyết định này ghi trong ADR-055.
- **Không áp dụng** cho `/hooks/:provider/:sourceKey`. Bên gọi ở đó là provider, nên ack phải theo định dạng của provider (`buildAck`). **Ngoại lệ:** `GenericAdapter.buildAck` thêm `fix` vào body lỗi, vì người đọc là dev đang cấu hình nguồn tuỳ chỉnh.

### 2.2 Danh mục lỗi (`libs/common/src/errors/catalog.ts`)

Một object hằng: `code → { status, message, fix(params) }`. `fix` là hàm **thuần**, chỉ nhận tham số đã liệt kê dưới đây.

| `error` | Status | Tham số | `fix` (ý chính) |
|---|---|---|---|
| `invalid_api_key` | 401 | — | Kiểm `HUB_URL`/key; key có thể đã bị revoke; tạo key mới trong console |
| `not_found` | 404 | — | Kiểm slug project trong connection string và id tài nguyên. **Cùng một câu** cho cả "không tồn tại" lẫn "của project khác" |
| `missing_scope` | 403 | `required` | Tạo key có scope `<required>` |
| `validation_failed` | 422 | `field`, `reason` | Trường `<field>`: `<reason>`, ví dụ "must match ^[a-z0-9_]+(\.[a-z0-9_]+)+$" |
| `schema_mismatch` | 422 | `type`, `field` | Kiểu `<type>` là kiểu chuẩn; trường `<field>` sai khuôn, xem `docs/EVENT-CATALOG.md#<type>` |
| `reserved_type` | 422 | `type` | (dự phòng nếu phiên dev chọn cấm hẳn publish kiểu dành riêng) |
| `missing_idempotency_key` | 422 | `source?` | Gửi `idempotencyKey` (API) hoặc kiểm cấu hình `idempotency` của nguồn |
| `payload_too_large` | 413 | `limit` | Body tối đa `<limit>` |
| `invalid_cursor` | 400 | — | Dùng `nextCursor` của lần gọi trước, hoặc `latest` |
| `endpoint_unreachable` | 422 | `verificationError` | Xem bảng 2.3 |
| `conflict` | 409 | `field` | `<field>` đã tồn tại (vd slug project) |
| `rate_limited` | 429 | `retryAfter` | Chờ `<retryAfter>` giây (chỉ dùng nếu đã có giới hạn tốc độ; không thì bỏ) |
| `internal_error` | 500 | — | Gửi `requestId` cho admin. **Không** lộ stack hay message gốc |

### 2.3 Lỗi challenge của endpoint

Response tạo endpoint và gọi `/verify` thêm trường `verificationFix` cạnh `verificationError`:

| `verificationError` | `verificationFix` (ý chính) |
|---|---|
| `timeout` | Endpoint phải trả lời trong 10s; kiểm app đang chạy và URL truy cập được từ hub |
| `http_<status>` | Endpoint trả `<status>`; phải trả 200 với body `{"challenge": "<giá trị nhận được>"}` |
| `challenge_mismatch` | Body trả về phải đúng `{"challenge": ...}`. Dùng `hub.challengeResponse(body)` của SDK |
| `ssrf_blocked` | URL trỏ vào địa chỉ nội bộ, bị chặn. Ở máy local, dùng `hub listen` (DX3) thay vì đăng ký `localhost` |
| `dns_error` / `connection_refused` | Kiểm tên miền / cổng |

`ssrf_blocked` trỏ sang `hub listen` là cố ý. Đây là chỗ dev local hay vấp nhất, và DX3 sinh ra để gỡ đúng chỗ đó.

### 2.4 Cài đặt

- `ServiceExceptionFilter` (NestJS) đăng ký cho cả hai nhóm route. Mọi `HttpException` có `error` thuộc catalog được bổ sung `message/fix/docsUrl/requestId`. Lỗi lạ trả `internal_error` và log đầy đủ ở server.
- Thay mọi chỗ ném lỗi tự do ở API service bằng `throw hubError('missing_scope', { required })`.
- **Luật an toàn** (có test):
  - `fix` và tham số **không bao giờ** chứa key, secret, giá trị header chữ ký, hay body của request;
  - `not_found` trả body **giống hệt** nhau, chỉ khác `requestId`.
- `docs/ERRORS.md`: mỗi mã một mục `## <code>` (tiếng Việt): khi nào xảy ra, cách sửa, ví dụ `curl`.
- **Sửa SPEC-hub-multi-service U22:** "body giống hệt" đổi thành "body giống hệt **trừ `requestId`**".

---

## 3. DX2 — Quickstart 60 giây

### 3.1 Con đường mà dev đi (đây là hợp đồng, test TX2 đo đúng con đường này)

```
1. Console → Project → Keys → Tạo key (scope read:events + manage:endpoints)  → nhận 3 ô copy
2. Ô 1:  HUB_URL=hub://hk_test_…@localhost:4000/cafe      (dán vào .env)
3. Ô 2:  npm i <SDK>                                       (xem 3.3)
4. Ô 3:  npx hub listen --forward http://localhost:3000/webhooks
5. Chạy app mẫu (examples/quickstart-node) → bắn thử → thấy event in ra
```

### 3.2 Backend

- Response `POST /api/v1/projects/:projectId/keys` thêm trường:
  ```jsonc
  "quickstart": {
    "env": "HUB_URL=hub://hk_test_…@localhost:4000/cafe",
    "install": "npm i @hub/sdk",
    "snippets": [ { "title": "Receive events locally", "code": "npx hub listen --forward http://localhost:3000/webhooks" },
                  { "title": "Verify in your app", "code": "<≤ 12 dòng>" } ]
  }
  ```
- Chọn snippet theo scope của key:
  - `read:events` → `hub listen` + `poll`;
  - `manage:endpoints` → `endpoints.ensure` + `verifyWebhook` + `challengeResponse`;
  - `publish:events` → `publish`;
  - nhiều scope → nối các snippet theo thứ tự đó.
- `GET /api/v1/projects/:projectId/keys/:keyId/quickstart` trả cùng cấu trúc, nhưng key thay bằng `<YOUR_KEY>`, vì key thô chỉ hiện một lần (§2 SPEC đa service).
- Template snippet nằm ở `libs/hub-sdk/src/quickstart.ts` (hàm thuần `buildQuickstart({connectionString, scopes, installCmd})`). Như vậy SDK và console dùng chung một nguồn, không bị lệch.
- Env `HUB_SDK_INSTALL`, mặc định `npm i @hub/sdk`. SDK **chưa** publish lên npm, nên ở local đặt `npm i ../../libs/hub-sdk` (ghi trong `.env.example`).

### 3.3 App mẫu và tài liệu

- `examples/quickstart-node/index.js` **≤ 40 dòng**, chỉ dùng `node:http` và SDK:
  - nghe ở `:3000/webhooks`;
  - `challengeResponse` → trả về;
  - `verifyWebhook` sai → 401;
  - đúng → in `type`, `data.amount ?? ''`, `id` và trả 200.
  - Đọc secret từ `HUB_LISTEN_SECRET`, hoặc `HUB_SIGNING_SECRET` khi chạy thật.
- `docs/QUICKSTART.md`: đúng 5 bước §3.1, mỗi bước một khối lệnh, **không** giải thích kiến trúc. Cuối file có link sang `ARCHITECTURE.md` cho ai tò mò.

### 3.4 UI (phiên `ui-revamp`)

- Màn tạo key hiện **3 ô copy** lấy từ `quickstart` (env, install, listen), cộng một cảnh báo "key chỉ hiện một lần".
- Không cần đẹp. Spec này chỉ cung cấp API. Đã ghi một dòng sang `ui-revamp/README.md`.

---

## 4. DX3 — `hub listen` (và `hub trigger`)

### 4.1 Ý tưởng

Dev viết handler webhook trên laptop. Hub không gọi được `localhost` của họ: bị SSRF guard chặn, và laptop nằm sau NAT. Thông thường dev sẽ phải dựng ngrok hay cloudflared.

`hub listen` **kéo** sự kiện bằng long-poll (polling A, §4.5 SPEC đa service), rồi **đẩy** vào `localhost`, ký Standard Webhooks y như hub push thật.

**Không thêm hạ tầng server nào.** Đây là ứng dụng thực tế của quyết định polling (A). Nên nêu rõ điểm này khi bảo vệ (Winston).

### 4.2 Lệnh

```
npx hub listen --forward <url> [--types payment.*,repo.push] [--from latest|<seq>]
               [--secret whsec_…] [--allow-remote] [--url <connection string>]
npx hub trigger <type> [--data '{"amount":50000}']        # tuỳ chọn, DX3b
```

- `libs/hub-sdk/bin/hub.js`, khai báo `"bin": {"hub": "bin/hub.js"}`. Parse tham số bằng `node:util parseArgs`. **Không** thêm phụ thuộc ngoài.
- Connection string lấy từ `--url`, nếu không có thì từ env `HUB_URL`. Thiếu cả hai → thoát mã 2, in câu hướng dẫn kiểu DX1.

### 4.3 Hành vi `listen`

1. `hub.me()`.
   - In: `Connected to project "cafe" as service "<serviceName>" (key hk_test_••••abcd)`.
   - Thiếu scope `read:events` → in `fix` của DX1 rồi thoát.
2. **Secret phiên:**
   - `--secret` hoặc env `HUB_LISTEN_SECRET`; nếu không có thì sinh `whsec_` + base64(24 byte).
   - In ra **một lần**: `Your local signing secret: whsec_… (set HUB_LISTEN_SECRET to keep it stable)`.
3. **Cursor đầu:**
   - `--from latest` (mặc định) gọi `GET /events?after=latest`. Backend **mới** trả `{events:[], nextCursor:"<seq lớn nhất đã qua cửa sổ lắng>"}`.
   - `--from <seq>` thì dùng luôn giá trị đó.
4. **Vòng lặp:** `poll({after, types, wait: 20})`. Với **từng** event, theo **thứ tự seq**:
   - `POST <forward>` với body = `toWebhookBody(event)`;
   - header `webhook-id` = `event.id`, `webhook-timestamp`, `webhook-signature` ký bằng secret phiên;
   - timeout 10s;
   - in một dòng: `14:02:37  payment.received  evt_01J…  → 200 (34 ms)`. Non-2xx thì in kèm 200 ký tự đầu của body trả về.
5. **Không retry**, vì đây là công cụ dev.
   - Cursor vẫn tiến kể cả khi local trả lỗi.
   - `ECONNREFUSED` → in `Cannot reach http://localhost:3000/webhooks — is your app running?` rồi tiếp tục.
6. **Ctrl+C** → in `Forwarded N events (M failed). Last cursor: <seq>. Resume with --from <seq>`, thoát mã 0.
7. **Mất mạng hoặc hub 5xx:** backoff 1s → 2s → 5s (trần), in một dòng cảnh báo, không thoát.

**Luật:**
- **Parity:** body mà `listen` gửi phải **byte-identical** với body `WebhookSender` gửi cho cùng event.
  - Tách hàm `toWebhookBody(event)` sang `libs/common` để cả hai cùng dùng. **Cấm** viết serializer thứ hai.
  - Nếu không như vậy, code dev test ở local sẽ chạy khác production.
- **Chỉ đọc:**
  - `listen` **không** tạo delivery;
  - không ảnh hưởng endpoint thật hay circuit breaker;
  - không đổi trạng thái gì trong hub.
- **Mặc định chỉ forward tới** `localhost`, `127.0.0.1`, `::1`, `host.docker.internal`. URL khác → thoát kèm hướng dẫn, trừ khi có `--allow-remote`. Mục đích: tránh dev lỡ tay đẩy dữ liệu project sang chỗ lạ.
- Key luôn được che trong mọi dòng in ra (dùng lại `util.inspect` của client, §4.11 SPEC đa service).
- **Độ trễ dự kiến:** cửa sổ lắng 2s + vòng DB tối đa 1s + thời gian normalize. Ghi con số đo thật vào §9.

### 4.4 `hub trigger` (DX3b, tuỳ chọn, làm nếu còn giờ)

- `trigger <type>` lấy payload mẫu từ fixture của S14 (`payment.received`, `repo.push`…), ghép `--data` vào, rồi `hub.publish(type, data, {idempotencyKey: 'trigger-' + ulid})`.
- Cần scope `publish:events`. Payload mẫu **phải** qua `validateCanonical`, đi đúng đường ingest như mọi event khác.
- Kết hợp với `listen`, dev thử được handler mà không cần provider thật hay tài khoản ngân hàng.

### 4.5 Backend mới (nhỏ)

- `GET /v1/p/:project/events?after=latest` theo mô tả ở 4.3 bước 3. Giá trị `after` khác số và khác `latest` → 400 `invalid_cursor` (DX1).
- Không thêm route nào khác.

---

## 5. Story (làm đúng thứ tự)

| ID | Story | Phụ thuộc | Ước lượng |
|---|---|---|---|
| **DX1** | Catalog lỗi + `ServiceExceptionFilter` + `x-request-id` + `verificationFix` + `fix` trong `GenericAdapter.buildAck` + `docs/ERRORS.md` + sửa U22 | SPEC đa service S0–S14 | 3h |
| **DX2** | `buildQuickstart` trong SDK + trường `quickstart` + route GET quickstart + `examples/quickstart-node` + `docs/QUICKSTART.md` + `.env.example` | DX1 | 2.5h |
| **DX3** | `toWebhookBody` dùng chung + `after=latest` + CLI `hub listen` | DX2 | 4h |
| DX3b | (tuỳ chọn) `hub trigger` | DX3 | 1.5h |

**Cập nhật tài liệu khi xong:**
- `docs/ARCHITECTURE.md`: thêm mục "Trải nghiệm dev". Nêu rõ `listen` = polling (A) + ký phía client, không có hạ tầng mới.
- `CLAUDE.md` mục Trạng thái: thêm một dòng.

## 6. Kịch bản test (cho phiên TEST)

### 6.1 Unit / integration (`npx jest -w 2`)

| # | File gợi ý | Kịch bản | Mong đợi |
|---|---|---|---|
| UX1 | `apps/hub-api/test/error-filter.spec.ts` | ném từng mã trong catalog | body có đủ `error, message, fix, docsUrl, requestId`; status khớp bảng 2.2; header `x-request-id` = `requestId` |
| UX2 | 〃 | key project A gọi project B có tồn tại / project không tồn tại | hai body **giống hệt trừ `requestId`** |
| UX3 | 〃 | gây lỗi 401/403/422 khi header chứa key thật, body chứa `"secret":"s3cr3t"` | `JSON.stringify(body)` không chứa key, không chứa `s3cr3t` |
| UX4 | `libs/common/test/error-catalog.spec.ts` | duyệt mọi mã trong catalog | `docs/ERRORS.md` có heading `## <code>` cho từng mã; `fix()` trả chuỗi không rỗng |
| UX5 | 〃 | lỗi lạ (`throw new Error('db down at 10.0.0.5')`) | 500 `internal_error`, body **không** chứa `10.0.0.5` |
| UX6 | `apps/hub-api/test/endpoint-verify.spec.ts` | mỗi `verificationError` ở bảng 2.3 | có `verificationFix` tương ứng; `ssrf_blocked` có nhắc `hub listen` |
| UX7 | `libs/hub-sdk/test/quickstart.spec.ts` | `buildQuickstart` với scope `[read:events]` / `[manage:endpoints]` / `[publish:events]` / cả ba | đúng bộ snippet, đúng thứ tự §3.2 |
| UX8 | `apps/hub-api/test/quickstart.spec.ts` | `GET …/keys/:id/quickstart` | chứa `<YOUR_KEY>`, **không** chứa tiền tố hay hash của key thật |
| UX9 | `libs/common/test/webhook-body.spec.ts` | cùng một event qua `WebhookSender` (mock axios bắt body) và qua `listen` (mock fetch bắt body) | hai body **bằng nhau từng byte** |
| UX10 | `libs/hub-sdk/test/listen.spec.ts` | server giả trả 1 event; forward tới server local trong test | server local nhận đúng header Standard Webhooks; `verifyWebhook(body, headers, secret)` → true |
| UX11 | `apps/hub-api/test/polling.spec.ts` (bổ sung) | `after=latest` khi có seq 1..5 (seq 5 chưa qua cửa sổ lắng) | `events:[]`, `nextCursor:"4"`; `after=abc` → 400 `invalid_cursor` |
| UX12 | `libs/hub-sdk/test/listen.spec.ts` | local trả 500 cho event 1 | in dòng lỗi, event 2 vẫn được forward, cursor tiến qua cả hai |
| UX13 | 〃 | local không chạy (ECONNREFUSED) | in đúng câu "is your app running?", tiến trình không thoát |
| UX14 | 〃 | `--forward https://evil.example.com/x` không có `--allow-remote` | thoát mã ≠ 0, có hướng dẫn; có cờ thì chạy |
| UX15 | 〃 | gom toàn bộ stdout/stderr của một phiên listen | không chứa key thô |
| UX16 | `libs/hub-sdk/test/trigger.spec.ts` (nếu làm DX3b) | `trigger payment.received` | body gửi `POST /events` qua `validateCanonical` → ok |

### 6.2 E2E (docker compose sạch, sau khi chạy xong §7.0 của SPEC đa service)

**TX1 — Lỗi có hướng dẫn sửa**
```bash
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer $KR" -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{},"idempotencyKey":"x1"}'
# 403; header x-request-id; body có error=missing_scope, required=publish:events, fix nhắc "publish:events", docsUrl
curl -si $API/v1/p/cafe/events -H "Authorization: Bearer hk_test_sai" ; # 401 invalid_api_key + fix
curl -si "$API/v1/p/cafe/events?after=abc" -H "Authorization: Bearer $KA" ; # 400 invalid_cursor
```
✅ Tra `requestId` trong log hub-api (`docker compose logs hub-api | grep <requestId>`) → thấy đúng request đó.

**TX2 — Quickstart 60 giây (đo bằng đồng hồ)**
1. Người test **chưa đọc** code hub. Chỉ mở `docs/QUICKSTART.md` và console (hoặc `curl` tạo key nếu UI chưa có).
2. Bấm giờ từ lúc **có connection string** cho tới khi app mẫu in event đầu tiên. Event được bắn bằng `hub trigger payment.received`, hoặc bằng SePay mock nếu chưa làm DX3b.
3. ✅ Ghi số giây vào §9. **Đạt nếu ≤ 90s**, đẹp nếu ≤ 60s (ai thắng cược thì được ly cà phê). Ghi lại mọi chỗ người test bị khựng: mỗi chỗ khựng là một lỗi tài liệu cần sửa.

**TX3 — `hub listen` đầu-cuối**
```bash
cd examples/quickstart-node && HUB_LISTEN_SECRET=whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0 node index.js &
HUB_URL=$HUB_URL_KA HUB_LISTEN_SECRET=whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0 npx hub listen --forward http://localhost:3000/webhooks --types 'payment.*'
# terminal khác: bắn SePay mock 50000 vào source của cafe
```
✅ Mong đợi:
- Trong vòng ≤ 5s, listen in `payment.received … → 200`; app mẫu in `payment.received 50000 evt_…`.
- Đổi secret của app mẫu thành sai → listen in `→ 401`.
- Ctrl+C → in dòng tổng kết có cursor. Chạy lại với `--from <cursor-1>` → event cuối được forward lại (cùng `webhook-id`).

**TX4 — `listen` chỉ đọc**
- Đếm `SELECT count(*) FROM hub.deliveries` trước và sau khi chạy TX3 (chỉ tính delivery của subscription thật).
- ✅ Không có delivery nào sinh ra do `listen`. Endpoint thật của cafe vẫn nhận đúng như không có `listen`.

**TX5 — `hub trigger` (nếu làm DX3b)**
- `npx hub trigger payment.received --data '{"amount":12345}'` → listen forward event có `data.amount=12345`, `normalized:true`.
- `npx hub trigger payment.received --data '{"amount":1.5}'` → in lỗi `schema_mismatch` kèm `fix`.

### 6.3 Bước demo (chèn vào **đầu** §7.3 của SPEC đa service)

0. **"Một service mới kết nối vào hub trong 60 giây."** Tạo key → dán `HUB_URL` → `npx hub listen` → `hub trigger payment.received` → app mẫu in event. Bấm giờ ngay trên màn hình. Sau đó cố tình dùng key thiếu scope để hội đồng thấy lỗi kèm `fix`.

## 7. Rủi ro

1. **SDK chưa publish npm:** `npx hub` chỉ chạy được trong monorepo hoặc sau `npm i <đường dẫn>`. Quickstart ghi rõ điều này; `HUB_SDK_INSTALL` đổi được.
2. **Độ trễ `listen`** khoảng 2–4s do cửa sổ lắng. Chấp nhận vì là công cụ dev; ghi số thật.
3. **Thông báo lỗi tiếng Anh:** hội đồng có thể hỏi. Lý do: thông lệ API và đối tượng là dev. Giải thích tiếng Việt có ở `docs/ERRORS.md` (ADR-055).
4. **`fix` lộ thông tin:** đã chặn bằng luật 2.4 cùng UX2, UX3, UX5. Ai thêm mã lỗi mới thì phải thêm test.

## 8. Checklist (phiên DEV đánh dấu)

> **Phương án A (Admin duyệt 11/10) — bản cắt gọn.** Thứ tự làm: DX3 → DX3b → DX1-lite → DX2 rút gọn → docs. Nhật ký: `RESUME-dx.md`.

- [x] DX1 (lite, `74bf617`) · [x] DX2 (rút gọn, `6c5b78a`) · [x] DX3 (`fc40e29`) · [x] DX3b (`d6b1a00`)
- ADR mới: ADR-133 (`hub listen`, `toWebhookBody`, `after=latest`), ADR-134 (`hub trigger`, mẫu cạnh catalog), ADR-136 (khuôn lỗi + `detail` cho console). (ADR-132/135 là VF3/VF4 của phiên khác.)
- Test: UX1–UX6, UX9–UX16 có tag `[DX:UXn]`; UX7/UX8 KHÔNG làm (thuộc phần DX2 bị cắt).
- Lệch so với spec (kèm lý do):
  1. **DX2 cắt theo phương án A:** không `buildQuickstart`, không trường `quickstart` khi tạo key, không route GET quickstart, không 3 ô copy, không `HUB_SDK_INSTALL`/`.env.example` (để phương án B). Chỉ `examples/quickstart-node` (34 dòng) + `docs/QUICKSTART.md`. Thêm `examples/quickstart-node/package.json` (`@hub/sdk: file:../../libs/hub-sdk`) để `npx hub` có bin link — gọi `npx hub` ở thư mục không có bin link sẽ tải gói tên `hub` của npm (không phải của mình).
  2. **`after=latest`:** spec viết "seq lớn nhất đã qua cửa sổ lắng" — cửa sổ lắng đã bỏ ở ADR-095; `latest` = max `poll_seq` SAU `assignPollSeq` (event commit sau đó luôn có cursor lớn hơn). UX11 kiểm theo nghĩa mới (unit + Postgres thật). Cursor rác: 422 `validation_failed` cũ → **400 `invalid_cursor`**.
  3. **Đóng gói CLI:** CLI nạp `toWebhookBody` + mẫu từ `@hub/common` lúc chạy → chạy trong monorepo / cài bằng đường dẫn; thư viện chính SDK vẫn 0 phụ thuộc runtime. Bin dùng `dist/cli.js` nếu đã build, không thì ts-node.
  4. **Catalog lỗi = mọi mã đang ném** (giữ `slug_taken`, `outside_read_types`, `unknown_source`, `project_required`… — đổi mã là breaking) + mã suy từ status (`bad_request`, `forbidden`, `conflict`, `unauthenticated`, `service_unavailable`). Bỏ `reserved_type` và `endpoint_unreachable` (không đường nào ném; tạo endpoint FAILED vẫn 201 kèm `verificationError` + `verificationFix`). `verificationError` thật là `unreachable` (không tách `dns_error`/`connection_refused`), thêm `invalid_json`, `invalid_url`, `no_signing_secret`.
  5. **Không viết lại mọi chỗ ném lỗi bằng `hubError`:** filter chuẩn hoá body cũ (mã có sẵn hoặc suy từ status, tham số lọc theo catalog). Có `hubError()` cho code mới; test quét `apps/hub-api/src` đỏ nếu ném mã chưa có trong catalog.
  6. **`detail`:** câu gốc tiếng Việt của hub ra `detail` (không có ở `not_found`/5xx) để console giữ tiếng Việt (web `errorMessageOf` ưu tiên `detail` → câu Việt theo mã). Spec không có trường này (ADR-136).
  7. **`ssrf_blocked` fix** nêu cả hai đường: deployed → đăng ký URL công khai (vd `SHOP_PUBLIC_URL`); local → `hub listen` (yêu cầu của Admin, rộng hơn §2.3).
  8. **GenericAdapter.buildAck `fix`** đã có, nhưng 401/422 của `/hooks` do lõi ingest trả thẳng (không qua `buildAck`) → chưa tới tay dev. Chờ Admin: `CAN-ADMIN-QUYET-DX.md` Q1.
  9. `hub trigger`: idempotencyKey `trigger-<base36 thời gian + 10 hex>` thay vì ulid (SDK không thêm phụ thuộc).
  10. Không build lại image Docker (ổ C còn ~16 GB, 97%) → TX1/TX3 với `after=latest` chưa chạy trên stack; độ trễ đo trên stack dev với `--from <cursor>` (xem §9 / RESUME-dx).

## 9. Kết quả test (phiên TEST điền)

| Kịch bản | PASS/FAIL | Ghi chú / output | Ngày |
|---|---|---|---|
| UX1–UX16 | | | |
| TX1 | PASS (phiên DEV, stack dev `webhook-hub` build lại từ `9243043`) | key chỉ `read:events` POST /events → 403 `missing_scope`, `required=publish:events`, `fix` nhắc `publish:events`, `docsUrl=docs/ERRORS.md#missing_scope`, header `x-request-id` = body `requestId`; key sai → 401 `invalid_api_key` + fix; `after=abc` → 400 `invalid_cursor`; `after=latest` → 200 `{events:[],nextCursor:"68"}`; requestId tìm thấy trong `docker logs webhook-hub-api`; không response nào chứa key | 2026-10-11 |
| TX2 | | **số giây:** … · chỗ bị khựng: … · ai thắng cược ☕: … | |
| TX3 | PASS (phiên DEV) | `--from latest` → "from cursor 68"; SePay mock → app mẫu (examples/quickstart-node) in `payment.received 50000 evt_…`: 5 lần 1087/403/495/894/519 ms (max 1,09 s ≤ 5 s); đổi secret app → listen in `→ 401`; dừng (abort = Ctrl+C) → mã 0, `Forwarded 6 events (1 failed). Last cursor: 92. Resume with --from 92`; chạy lại `--from 91` → event cuối forward lại, cùng `evt_…` (webhook-id), `→ 200`; không lộ key. Lượt đo trước (image cũ, `--from <cursor>`, N=10): p50 0,62 s · p95 1,70 s | 2026-10-11 |
| TX4 | PASS (phiên DEV) | 6 event của TX3 → đúng 6 delivery (1/event), tất cả tới subscription thật đang bật (`payment.*` của cafe); tổng delivery của project tăng đúng 6 trong phiên → `listen` không sinh delivery | 2026-10-11 |
| TX5 | | | |
| Demo bước 0 | | | |
