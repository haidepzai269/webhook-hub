# SPEC — Hub đa service: Project, API key, kết nối, GenericAdapter

> **Đường dẫn file này:** `C:\webhook-hub\_bmad-output\planning-artifacts\hub-multi-service\SPEC-hub-multi-service.md`
> ⚠️ **ĐỌC TRƯỚC: `DINH-CHINH-2026-10-10.md` (cùng thư mục) THẮNG file này** ở mọi chỗ mâu thuẫn — hiện trạng sau commit `0b2cef4`, quyết định Admin (gộp SPEC-3, retention, commit), thứ tự chặng A/B.
> **Ngày:** 2026-10-10 · **Trạng thái:** sẵn sàng để dev · **Bổ sung 10/10 chiều:** S14 (§4.14), test U34–U50, T15, bước 6 demo
> **Nguồn quyết định:** ADR-038, 039, 040, 041, **053** (S14, chuẩn hoá đầu ra) trong `docs/adr/README.md` · bối cảnh ở `HANDOFF-2026-10-09.md` (cùng thư mục)
> **Spec nối tiếp:** `SPEC-dev-experience.md` (cùng thư mục, ADR-055): lỗi có `fix`, Quickstart 60 giây, `hub listen`. Làm **sau** khi xong S0–S14 của file này. Lưu ý: U22 bị DX1 sửa thành "body giống hệt trừ `requestId`".
> **Ai đọc file này:**
> - **Phiên DEV:** đọc §0 → §6, làm các story theo thứ tự ở §5, đánh dấu `[x]` vào checklist ở §9.
> - **Phiên TEST:** đọc §0, §2, §3, rồi chạy toàn bộ §7 (kịch bản test) và ghi kết quả vào §10.

---

## 0. Đọc trước khi làm (bắt buộc)

1. `CLAUDE.md`: bốn bất biến BB-1 đến BB-5 và các quy tắc code. Phá một bất biến là **bug kiến trúc**.
2. `docs/ARCHITECTURE.md` §3.1: thứ tự ingest cố định. Redis `SET NX` phải nằm **sau** `COMMIT`.
3. `docs/adr/README.md` ADR-038 đến 041.
4. File này.

**Luật cho phiên dev:**
- **Mỗi story một commit.** Commit message có mã story, ví dụ `feat(S3): api key guard + scopes`. Chạy `npx jest -w 2` trước khi commit. **Không** chạy jest không giới hạn worker: đã từng làm Docker Desktop crash vì hết RAM.
- **Mọi truy vấn bảng có `tenant_id`** đi qua `TenantScopedRepository`. Bảng mới (`projects`, `api_keys`) không thuộc nghiệp vụ tenant; đọc qua escape hatch có tên rõ ràng trên `PrismaService`, giống `findSourceBySourceKeyForIngest`.
- **Mọi so sánh bí mật** (chữ ký, token, challenge) dùng `crypto.timingSafeEqual`, qua `timingSafeCompare` của `@hub/crypto`.
- **Không** thêm `if (provider === 'x')` vào lõi ingest hoặc worker.
- Mọi quyết định nhỏ phát sinh khi code: **ghi ADR 3 dòng**, dùng **số tiếp theo còn trống** ở cuối `docs/adr/README.md`. Phiên dev biên bản 9/10 đang thêm ADR song song (tới ADR-052 lúc viết); ADR-053 là quyết định S14. **Luôn kiểm số cuối ngay trước khi ghi.**
- `docker-entrypoint.sh` đang chạy `prisma db push --accept-data-loss`. **Mọi cột mới phải có default hoặc nullable**, để dữ liệu cũ không bị xoá khi push.

---

## 1. Mục tiêu

Biến hub từ "một hệ thống phục vụ một BE" thành **hạ tầng dùng chung** (giống CloudAMQP, Upstash):

- Nhiều service kết nối vào bằng **connection string** chứa API key.
- Dữ liệu tách theo **Project**: không project nào đọc hay ghi được dữ liệu của project khác, kể cả khi biết UUID.
- Service **nhận sự kiện bằng push** (ký theo Standard Webhooks, endpoint qua challenge), dùng **polling/long-poll** làm dự phòng.
- Service **tự đẩy sự kiện** vào hub (`POST /events`), đi đúng đường ingest (raw_events + outbox trong cùng transaction).
- Service **tự cấu hình nguồn bên thứ ba** mà hub chưa có adapter, qua `GenericAdapter` với 3 mẫu xác thực.
- **Shop thành một service thật**: tự kết nối bằng `HUB_URL` + SDK, không còn do seed tạo sẵn endpoint.
- **Vào nhiều kiểu, ra một kiểu** (S14, §4.14): mọi nguồn thanh toán ra cùng `payment.*`, GitHub ra `repo.*`, có validator. Service chỉ viết **một** hàm xử lý cho mỗi kiểu chuẩn, không cần `if (source === ...)`.

**Ngoài phạm vi đợt này:** Organization, billing, tự đăng ký tài khoản, semaphore theo endpoint, tách queue theo project, SSE, CloudEvents body, JSONPath hay biến đổi dữ liệu tuỳ ý trong GenericAdapter (chỉ cho phép ánh xạ khai báo cấp một ở §4.14.4), catalog cho miền ngoài thanh toán và repo, giao diện (thuộc phiên `planning-artifacts/ui-revamp`; spec này chỉ cung cấp API cho UI).

---

## 2. Từ vựng và quy ước

| Từ | Nghĩa | Trong code / DB |
|---|---|---|
| **Project** | Biên cô lập dữ liệu. Tương đương Jira site, RabbitMQ vhost | bảng `hub.projects`. Cột `tenant_id` ở mọi bảng **giữ tên**, nghĩa là `project_id` (ADR-041) |
| **Service** | Một BE bên ngoài dùng hub, được nhận diện bằng **API key** | bảng `hub.api_keys`, cột `service_name` |
| **Endpoint** | Tên ở bề mặt REST của `destinations` có `type=webhook` | DB giữ tên `destinations` |
| **Connection string** | `hubs://<apiKey>@<host>/<projectSlug>` (dùng `hub://` cho http ở local) | do SDK parse |
| **Admin** | Người vận hành toàn hub (console), đăng nhập bằng JWT như hiện nay | `/api/v1/*` |

**Định dạng API key:** `hk_<env>_<43 ký tự base64url>` (32 byte ngẫu nhiên), trong đó `env ∈ {test, live}` lấy theo `projects.environment`.
- DB chỉ lưu `key_hash = sha256(full key)` (hex, unique) và `key_prefix` = 12 ký tự đầu, để hiển thị.
- Dùng SHA-256 là đủ, không cần bcrypt, vì key có 256 bit entropy (ghi ADR khi làm).
- Key thô chỉ trả về **đúng một lần**, lúc tạo.

**Comment bắt buộc** trên mọi model Prisma có `tenantId`:
`// tenant_id = project_id (ADR-038/041). Giữ tên cột để không đổi 40 file.`

---

## 3. Hiện trạng code (đã đọc ngày 10/10, dev kiểm lại trước khi sửa)

| Chỗ | Hiện trạng | Liên quan story |
|---|---|---|
| `libs/database/prisma/schema.prisma` | Chưa có `projects`, `api_keys`. `ProviderEnum` = payos, sepay, github, stripe. `Subscription` lọc theo `eventTypes` (dùng `has`), không có lọc source. `Event` không có `source_id` | S1, S5, S8 |
| `apps/hub-api/src/modules/auth/*` | Một admin, JWT gắn cứng `DEFAULT_TENANT_ID` (`libs/database/src/constants.ts`) | S2, S3 |
| `apps/hub-api/src/modules/api/api.controller.ts` | `/api/v1/*` dùng JWT. `createSubscription` **không kiểm** destination cùng tenant. `GET events?after=` đi **lùi** (`orderBy receivedAt desc`) và bỏ qua `types` | S2, S5, S7 |
| `apps/hub-worker/src/consumers/normalize.consumer.ts:167` | Publish delivery **trực tiếp** sau `COMMIT`. Đây là dual-write: crash giữa commit và publish thì delivery PENDING mãi mãi | S0 |
| `apps/hub-worker/src/senders/*.sender.ts` | `timeout: 5000` **gắn cứng** ở cả 3 sender | S10 |
| `apps/hub-worker/src/senders/webhook.sender.ts` | Header tự đặt `X-Hub-Event-Id`, `X-Hub-Timestamp`, `X-Hub-Signature: v1=<hex>` | S6 |
| `apps/shop/src/main.ts:105-175` | Verify header `X-Hub-*` cũ. `SIGNING_SECRET` có fallback gắn cứng | S6, S11 |
| `libs/crypto/src/ssrf.ts:118` | Đã sửa `{all:true}` cho Node 22, **chưa chạy lại để kiểm** | S0 |
| `libs/providers/src/provider.interface.ts` | `verify(req, secrets)` không nhận cấu hình của source | S8 |
| Cleanup / retention | **Không tồn tại** job cleanup trong `hub-worker` | S7 |
| `audit_logs` | Bảng có, **không chỗ nào ghi** | S2, S3, S6 |
| `libs/providers/src/*.adapter.ts` | Phong bì đã thống nhất, **`data` thì chưa**: PayOS `amount` + `orderCode` (phạm BB-1); SePay `transferAmount`; GitHub và Stripe dùng body gốc. PayOS luôn ra `payment.succeeded`, kể cả giao dịch lỗi | S14 |
| `apps/shop/src/main.ts:129-136` | `eventData.amount \|\| eventData.transferAmount`, tìm mã đơn trong `orderCode`/`content`: phân nhánh theo provider ở phía khách hàng | S14 |

---

## 4. Thiết kế

### 4.1 Thay đổi schema (Prisma)

```prisma
enum ProviderEnum { payos sepay github stripe generic api  @@schema("hub") }
enum ProjectEnv   { test live                               @@schema("hub") }
enum EndpointVerification { PENDING VERIFIED FAILED         @@schema("hub") }

model Project {
  id          String     @id @db.Uuid              // = tenant_id ở các bảng khác
  slug        String     @unique @db.VarChar(64)   // ^[a-z0-9][a-z0-9-]{2,62}$, vd "cafe", "default"
  name        String     @db.VarChar(255)
  environment ProjectEnv @default(test)
  createdAt   DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  apiKeys     ApiKey[]
  @@map("projects") @@schema("hub")
}

model ApiKey {
  id          String    @id @default(uuid()) @db.Uuid
  tenantId    String    @map("tenant_id") @db.Uuid   // project
  serviceName String    @map("service_name") @db.VarChar(128)
  keyPrefix   String    @map("key_prefix") @db.VarChar(16)
  keyHash     String    @unique @map("key_hash") @db.Char(64)
  scopes      String[]                              // xem 4.2
  readTypes   String[]  @default([]) @map("read_types")  // lọc thêm cho read:events; rỗng = tất cả
  sourceId    String?   @unique @map("source_id") @db.Uuid  // source provider=api, tạo kèm nếu có publish:events
  lastUsedAt  DateTime? @map("last_used_at") @db.Timestamptz(6)
  revokedAt   DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  project     Project   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
  @@map("api_keys") @@schema("hub")
}
```

Sửa các model có sẵn:

| Model | Thêm / sửa |
|---|---|
| `Source` | `verificationConfig Json? @map("verification_config")`. Chỉ dùng khi `provider=generic` |
| `Event` | `seq BigInt @default(autoincrement()) @unique` (cursor polling, §4.5) · `sourceId String? @map("source_id") @db.Uuid` · `normalized Boolean @default(true)` · index `@@index([tenantId, seq])` |
| `Destination` | `verification EndpointVerification @default(VERIFIED)` (default VERIFIED để dữ liệu cũ, telegram và discord không bị chặn; endpoint webhook **mới** tạo qua API service thì set `PENDING`) · `verifiedAt DateTime?` · `verificationError String?` · `@@unique([id, tenantId])` |
| `Subscription` | `sourceIds String[] @default([]) @map("source_ids") @db.Uuid` (rỗng = mọi source trong project) · **khoá ngoại ghép** `destination Destination @relation(fields: [destinationId, tenantId], references: [id, tenantId])`. Khoá này làm DB từ chối subscription trỏ sang destination của project khác |

`NormalizedEvent` (`libs/common/src/types.ts`) thêm `normalized?: boolean` (mặc định true). `ProviderType` thêm `'generic' | 'api'`.

**Seed / migration dữ liệu:** tạo `Project{id: DEFAULT_TENANT_ID, slug:'default', name:'Default', environment:'test'}` bằng upsert, **trước** mọi bảng khác. Seed không tạo destination và subscription cho Shop nữa (S11): Shop tự đăng ký.

### 4.2 Scope

| Scope | Cho phép |
|---|---|
| `publish:events` | `POST /events` |
| `read:events` | `GET /events` (polling). Nếu `readTypes` không rỗng thì chỉ thấy các type khớp (hỗ trợ wildcard như subscription) |
| `manage:endpoints` | CRUD endpoint, subscription, gọi lại challenge |
| `manage:sources` | CRUD source, nộp secret, `inspect` (chế độ lắng nghe) |

Key không có scope nào thì bị từ chối lúc tạo (422).

### 4.3 API

**A. Console admin (JWT, giữ `/api/v1`).** Admin là người vận hành toàn hub.

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/v1/projects` | danh sách project |
| POST | `/api/v1/projects` | `{slug, name, environment}` → 201. Trùng slug → 409 |
| GET | `/api/v1/projects/:projectId/keys` | danh sách key, **không** trả hash |
| POST | `/api/v1/projects/:projectId/keys` | `{serviceName, scopes[], readTypes?[]}` → 201 `{id, key, keyPrefix, connectionString, scopes}`. **`key` chỉ xuất hiện ở response này.** Ghi `audit_logs` action `api_key.created` |
| DELETE | `/api/v1/projects/:projectId/keys/:keyId` | set `revokedAt`, ghi audit `api_key.revoked` → 204. Lần gọi thứ hai vẫn 204 |
| `*` | các route `/api/v1/*` hiện có | thêm query tuỳ chọn `?projectId=`. Không truyền thì dùng `DEFAULT_TENANT_ID`. projectId không tồn tại → 404. Giữ tương thích cho dashboard hiện tại |

`connectionString` = `${HUB_PUBLIC_URL scheme → hubs|hub}://${key}@${host}/${slug}`. Biến env mới: `HUB_PUBLIC_URL` (vd `http://localhost:4000`).

**B. API cho service (API key, `/v1/p/:project/...`).** Header là `Authorization: Bearer hk_...`.

| Method | Path | Scope | Body / Query → Response |
|---|---|---|---|
| GET | `/v1/p/:project/me` | (bất kỳ) | → `{project:{slug,name,environment}, serviceName, scopes}`. SDK dùng để kiểm kết nối |
| POST | `/v1/p/:project/events` | publish:events | `{type, data, subject?, idempotencyKey}` → **202** `{eventId?:null, rawEventId, duplicate:false}`; trùng → **200** `{duplicate:true}` |
| GET | `/v1/p/:project/events` | read:events | `?after=<seq>&limit=50&types=a.b,c.*&status=failed&endpointId=&wait=0..20` → `{events:[...], nextCursor:"<seq>"}` |
| POST | `/v1/p/:project/endpoints` | manage:endpoints | `{name, url, signingSecret?}` → 201 `{id, url, verification, verificationError?, signingSecret?}` (`signingSecret` chỉ trả khi hub tự sinh) |
| GET | `/v1/p/:project/endpoints` | manage:endpoints | danh sách endpoint của project, không lộ secret |
| POST | `/v1/p/:project/endpoints/:id/verify` | manage:endpoints | chạy lại challenge → 200 `{verification, verificationError?}` |
| POST | `/v1/p/:project/subscriptions` | manage:endpoints | `{endpointId, name, eventTypes[], sourceIds?[]}` → 201 |
| GET | `/v1/p/:project/subscriptions` | manage:endpoints | |
| POST | `/v1/p/:project/sources` | manage:sources | `{provider, name, secret, verificationConfig?}` → 201 `{id, webhookUrl}`. `provider=api` → 422 |
| GET | `/v1/p/:project/sources` | manage:sources | |
| GET | `/v1/p/:project/sources/:id/inspect` | manage:sources | `?since=<ISO>` → 10 raw_events mới nhất kèm chẩn đoán (§4.8) |

**Bảng lỗi xác thực (`ApiKeyGuard`), theo đúng thứ tự kiểm:**

1. Thiếu header, sai định dạng, hash không tồn tại, hoặc key đã revoke → **401** `{error:"invalid_api_key"}`.
2. `:project` không tồn tại, **hoặc** `key.tenantId ≠ project.id` → **404** `{error:"not_found"}`. Hai trường hợp phải **trả cùng body**, để không lộ project nào đang tồn tại.
3. Thiếu scope → **403** `{error:"missing_scope", required:"<scope>"}`.
4. Tài nguyên `:id` không thuộc project → **404**.

Guard gắn `request.tenantId = key.tenantId` và `request.apiKey`, để `@CurrentTenant()` dùng lại được. Cập nhật `lastUsedAt` tối đa 1 lần mỗi phút (so sánh trong bộ nhớ), để không ghi DB mỗi request.

### 4.4 Publish (`POST /events`) đi đúng đường ingest

- Khi tạo key có scope `publish:events`, tạo kèm một `Source{provider:'api', sourceKey:'api_'+keyId, name:serviceName}` không có secret, rồi gắn vào `api_keys.source_id`.
- Tách lõi transaction của `IngestService.ingestWebhook` (bước 6–7: tạo raw_event, outbox, rồi Redis SET **sau** COMMIT) thành hàm `persistAccepted(source, rawReq, idempotencyKey, correlationId)`. Cả `/hooks` lẫn `/events` cùng gọi hàm này. **Không** nhân bản code transaction.
- `ApiAdapter` (`libs/providers/src/api.adapter.ts`):
  - `verify()` **luôn trả false**: không ai đẩy được vào `/hooks/api/...` từ ngoài. Xác thực của đường `/events` do `ApiKeyGuard` lo.
  - `extractIdempotencyKey()` = `api:${body.idempotencyKey}`.
  - `normalize()`: `type` = `body.type`, `data` = `body.data`, `source` = `'api'`, `subject` = `body.subject`.
- **Kiểm đầu vào:**
  - `type` khớp `^[a-z0-9_]+(\.[a-z0-9_]+)+$`;
  - `idempotencyKey` là chuỗi 1–255 ký tự;
  - `data` là object;
  - body tối đa 1MB.
  Sai → 422.
- Trả **202** chứ không phải 201, vì sự kiện được *nhận* (đã COMMIT) nhưng chưa normalize. Vẫn đúng BB-3: chỉ trả 2xx sau COMMIT.

### 4.5 Polling (A) và long-poll

- Cursor là `events.seq` (BigInt tăng dần), **không** dùng ULID. Lý do: ULID sinh ở nhiều worker trong cùng một mili giây không đảm bảo thứ tự.
- **Cửa sổ lắng (settle window):** chỉ trả event có `received_at <= now() - interval '2 seconds'`. Lý do: seq được cấp lúc INSERT, còn transaction có seq nhỏ hơn có thể COMMIT *sau* transaction có seq lớn hơn; nếu đọc ngay thì cursor đã vượt qua và mất vĩnh viễn sự kiện đó. Đánh đổi: polling trễ khoảng 2s. Ghi ADR.
- Truy vấn: `tenant_id = $project AND seq > $after AND received_at <= now()-2s [AND type khớp types/readTypes] [AND status=failed] ORDER BY seq ASC LIMIT $limit`. `nextCursor` = seq của phần tử cuối; nếu rỗng thì giữ nguyên `after`. `seq` serialize thành **chuỗi** (BigInt không vào JSON được).
- `status=failed`: event có ít nhất một delivery với `status IN ('DEAD','RETRYING')` thuộc **generation mới nhất**. Nếu có `endpointId` thì chỉ xét delivery tới endpoint đó; endpointId không thuộc project → 404.
- `types`: danh sách cách nhau bằng dấu phẩy, chấp nhận wildcard `x.*` như subscription. Tham số này được giao với `readTypes` của key.
- `wait` (0–20, mặc định 0). Nếu kết quả rỗng và `wait>0`, lặp lại truy vấn mỗi 1000ms cho đến khi có kết quả hoặc hết `wait` giây. Client ngắt kết nối (`req.on('close')`) thì dừng vòng lặp. Trần 20s, vì Render cắt request lúc khoảng 30s. **Không** dùng Redis. Code vòng lặp ≤ 50 dòng (điều kiện của John).
- Cũng sửa `GET /api/v1/events` của dashboard: đổi tham số `after` cho đúng nghĩa (tăng dần), hoặc đổi tên thành `before` cho dashboard. Ghi ADR khi chọn.

### 4.6 Subscription: wildcard và lọc source

- Hợp lệ: `^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$`. `payment.*` khớp **mọi** type bắt đầu bằng `payment.` (nhiều cấp). Không chấp nhận `*` đứng một mình, `*.paid`, hay regex → 422.
- Matching trong `TenantScopedRepository.findActiveSubscriptionsForEvent(type, sourceId)`. Với type `a.b.c`, sinh danh sách ứng viên `['a.b.c', 'a.*', 'a.b.*']` rồi lọc: `eventTypes hasSome ứng viên` **AND** (`sourceIds` rỗng **OR** `sourceIds has sourceId`) **AND** `isActive`. Đổi tên hàm cũ và cập nhật mọi chỗ gọi.
- Khi tạo subscription:
  - `endpointId` phải thuộc project (kiểm ở app, trả 404; khoá ngoại ghép là lưới cuối);
  - mọi `sourceIds` phải thuộc project (→ 422 `{error:"unknown_source", ids:[...]}`).
- Normalize consumer lưu `event.sourceId` và **không tạo delivery** cho destination `type=webhook` có `verification ≠ VERIFIED`. Bỏ qua theo cách này thì không ghi delivery nào, và ghi log ở mức `info`.

### 4.7 Push ký theo Standard Webhooks + challenge

**Ký (`libs/crypto/src/standard-webhooks.ts`, dùng chung cho hub, GenericAdapter và SDK):**

```
sign(secret, msgId, ts, body) = "v1," + base64( HMAC_SHA256(secretBytes, `${msgId}.${ts}.${body}`) )
secretBytes = secret bắt đầu "whsec_" ? base64decode(phần sau) : utf8(secret)   // tương thích secret cũ
verify(secret, headers, rawBody, toleranceSec=300):
  - thiếu header nào trong 3 header → false
  - |now - ts| > tolerance → false
  - header signature có thể chứa nhiều chữ ký cách nhau bằng dấu cách ("v1,a v1,b"); khớp một cái là đủ; so sánh bằng timingSafeEqual
```

**`WebhookSender`:**
- Header: `webhook-id: <event.id>` (giữ nguyên qua mọi lần retry và replay), `webhook-timestamp: <unix giây>`, `webhook-signature: v1,<base64>`, `content-type: application/json`.
- **Xoá hẳn** `X-Hub-*` (ADR-040: không gửi song song).
- Body thêm `normalized`.
- Endpoint mới tạo mà không có `signingSecret` thì hub sinh `whsec_` + base64(24 byte ngẫu nhiên).

**Challenge** (chạy đồng bộ trong hub-api, lúc tạo endpoint hoặc gọi `/verify`):

1. `challenge` = 32 byte ngẫu nhiên, encode base64url.
2. `POST url` với body `{"type":"endpoint.verification","challenge":"..."}`, ký bằng header Standard Webhooks (`webhook-id` = `verify_<ulid>`).
   - Qua `createSsrfSafeAxiosConfig`, timeout 10s, `maxRedirects: 0`.
3. Kết quả:
   - Response 2xx, JSON có `challenge` khớp (timingSafeEqual) → `VERIFIED`, `verifiedAt = now`.
   - Ngược lại → `FAILED`, `verificationError` ghi lý do ngắn:
     - `timeout`
     - `http_<status>`
     - `challenge_mismatch`
     - `ssrf_blocked`
     - `invalid_json`
4. Ghi `audit_logs` (`endpoint.verified` / `endpoint.verification_failed`).

Response của `POST /endpoints` vẫn là **201**, kể cả khi challenge FAILED. Endpoint vẫn được tạo, chỉ chưa nhận sự kiện.

### 4.8 GenericAdapter (bậc 2, ADR-041)

**Cấu hình** `sources.verification_config` (kiểm lúc tạo source; sai → 422 với tên trường lỗi):

```jsonc
{
  "scheme": "hmac-sha256" | "static-token" | "standard-webhooks",
  "header": "x-signature",            // bắt buộc với hmac-sha256 và static-token; viết thường
  "encoding": "hex" | "base64",       // chỉ hmac-sha256, mặc định hex
  "prefix": "sha256=",                // tuỳ chọn: hmac thì bỏ tiền tố trước khi so; static-token vd "Bearer "
  "idempotency": { "header": "x-request-id" } | { "field": "transactionId" },  // ĐÚNG MỘT trong hai
  "eventType": "bank.transaction.received"   // ^[a-z0-9_]+(\.[a-z0-9_]+)+$
}
```

- Với `standard-webhooks`: không có `header` hay `encoding`. `idempotency` mặc định là `{header:"webhook-id"}`.
- `field` chỉ là trường **cấp một** của body: `^[A-Za-z0-9_]{1,64}$`. **Cấm** JSONPath và dấu chấm (John).
- `provider=generic` mà thiếu `verificationConfig` → 422. `provider ≠ generic` mà có `verificationConfig` → 422.

**Thay đổi interface (tương thích ngược):**

```ts
interface AdapterContext { verificationConfig?: unknown }
verify(req, secrets, ctx?: AdapterContext): Promise<boolean>;
extractIdempotencyKey(req, ctx?: AdapterContext): string;          // ném IdempotencyKeyMissingError nếu thiếu
normalize(req, context & { verificationConfig?: unknown }): NormalizedEvent[];
```

- 4 adapter cũ bỏ qua `ctx`.
- `IngestService` truyền `source.verificationConfig`.
- Nếu bắt được `IdempotencyKeyMissingError` (lỗi chung, không riêng provider nào): lưu raw_event `REJECTED`, trả **422** `{error:"missing_idempotency_key"}`. Không fallback ulid.
- `NormalizeConsumer` nạp source qua repo theo `sourceId` để lấy config.

**Hành vi của GenericAdapter:**

| scheme | verify |
|---|---|
| hmac-sha256 | đọc `headers[header]` → bỏ `prefix` → so với `HMAC_SHA256(secret, rawBody)` encode theo `encoding`, bằng timingSafeEqual. Thử lần lượt mọi secret (hỗ trợ xoay secret) |
| static-token | đọc `headers[header]` → bỏ `prefix` → timingSafeEqual với từng secret |
| standard-webhooks | `standardWebhooks.verify(secret, headers, rawBody)` |

- `extractIdempotencyKey` = `generic:${giá trị}`. Giá trị lấy từ header, hoặc từ `body[field]` (chỉ nhận string hoặc number). Thiếu hoặc rỗng → ném lỗi.
- `normalize` = một event:
  - `type` = `eventType`;
  - **(sửa bởi S14)** không có `mapping`: `data = { raw: body đã parse }`; nếu body không phải JSON object thì `{ raw: rawBody.toString('utf8') }`. Có `mapping`: xem §4.14.4;
  - `source` = `'generic'`;
  - `normalized: false` (hoặc `true` nếu có `mapping`, §4.14.4).
- `buildAck`: thành công → 200 `{ok:true}`, trùng → 200 `{ok:true,duplicate:true}`, lỗi → status kèm `{ok:false,error}`.

**Chẩn đoán (chế độ lắng nghe)** — hàm thuần `diagnose(rawEvent, secrets, config)` trong GenericAdapter (adapter khác trả `{ok: signatureValid}`):

```
{ ok: boolean,
  reason?: "missing_header" | "signature_mismatch" | "token_mismatch" | "timestamp_out_of_range"
         | "missing_idempotency_key" | "ok",
  expectedHeader?: "x-signature",
  candidateHeaders?: ["x-sig", "x-hmac"]   // header có chứa sig|token|auth|hmac|key, KHÔNG kèm giá trị
}
```

- `GET /sources/:id/inspect?since=` lấy tối đa 10 raw_events của source đó, có `received_at >= since`, mới nhất trước. Trả `{id, receivedAt, status, diagnosis}`.
- **Tuyệt đối không** trả giá trị header chữ ký, token hay secret.
- UI "chế độ lắng nghe" (phiên UI làm) chỉ là gọi lại endpoint này mỗi 2s.

### 4.9 Noisy neighbor — hướng A (ADR-041)

- `DELIVERY_TIMEOUT_MS` (env, mặc định 5000, chặn trong khoảng 1000–10000), đọc **một lần** lúc khởi động worker. Thay số gắn cứng `5000` ở 3 sender.
- Timeout phải được tính là lỗi retryable và cộng vào circuit breaker. Hiện axios timeout trả `status 500` nên đã đúng; viết test để khoá hành vi này.
- **Không** làm semaphore và **không** tách queue. Ghi vào `docs/` mục "Hướng phát triển: semaphore theo endpoint", kèm số đo của kịch bản T10.

### 4.10 Retention

- `EVENT_RETENTION_DAYS` (env, mặc định 7).
- Job cleanup trong `hub-worker`, chạy mỗi giờ, giữ khoá Redis `lock:cleanup` bằng `SET NX PX 300000` để chỉ một instance chạy. Mỗi lô xoá 1000 dòng: `events` có `received_at < now() - N days` (cascade sang deliveries và attempts), rồi `raw_events` cũ hơn N ngày, rồi `processed_messages` cũ hơn N ngày, rồi `outbox` đã publish cũ hơn 1 ngày.
- Xoá theo lô, dùng truy vấn có scope theo **từng project** qua repo (BB-5), hoặc một escape hatch hạ tầng có tên rõ ràng và ghi ADR. Phiên dev chọn và ghi ADR.

### 4.11 SDK Node (`libs/hub-sdk`, package `@hub/sdk`)

```ts
const hub = createHubClient(process.env.HUB_URL!);   // parse hubs:// | hub://
await hub.me();                                      // kiểm kết nối
await hub.publish('order.created', data, { idempotencyKey });
const { events, nextCursor } = await hub.poll({ after, types, status, endpointId, wait });
await hub.endpoints.ensure({ name, url, eventTypes, sourceIds, signingSecret });
   // idempotent: tìm theo url; chưa có thì tạo; chưa VERIFIED thì gọi /verify; đảm bảo có subscription
hub.verifyWebhook(rawBody: Buffer, headers, signingSecret): boolean
hub.challengeResponse(parsedBody): { challenge } | null   // trả object nếu body là endpoint.verification
```

- Dùng `fetch` của Node 22, không phụ thuộc thư viện ngoài.
- **Che key:** `util.inspect` và `toJSON` của client in `hk_live_••••` cộng 4 ký tự cuối. Message của lỗi ném ra không chứa key (điều kiện của Amelia).
- Lỗi HTTP ném `HubError{status, code}`.

### 4.12 Shop thành service thật

- Env mới: `HUB_URL` (connection string của key `manage:endpoints` thuộc project default), `SHOP_PUBLIC_URL` (vd `http://shop:4001` trong docker). **Bỏ** fallback gắn cứng của `HUB_SIGNING_SECRET`: thiếu thì không khởi động.
- Lúc khởi động (sau khi `listen`): gọi `hub.endpoints.ensure({url: SHOP_PUBLIC_URL+'/hub-webhook', eventTypes:['payment.received'], signingSecret: HUB_SIGNING_SECRET})`. Lỗi thì log và thử lại sau 10s, tối đa 6 lần. Shop **vẫn phục vụ** trong lúc chờ.
- `/hub-webhook`:
  - `hub.challengeResponse(body)` khác null → trả 200 JSON đó. Request challenge **cũng phải qua verify chữ ký**.
  - Ngược lại `hub.verifyWebhook(...)`, sai → 401.
  - Chống trùng theo `webhook-id` (giữ `ProcessedHubEvent`).
- `docker-compose.yml`: tạo key bằng seed (S2) rồi ghi `HUB_URL` vào `.env` / compose. Seed in connection string ra log **một lần** lúc chạy. `SSRF` ở local: `NODE_ENV=development` đã cho phép IP private (`ssrf.ts:67`); kiểm lại.
- **Giữ trần 300 dòng** của `apps/shop/src/main.ts`.

### 4.13 RLS — tuỳ chọn, chỉ làm nếu S0–S12 xong

Bật RLS trên các bảng có `tenant_id`, với policy `tenant_id = current_setting('app.project_id')::uuid`. Repo phải `SET LOCAL` trong mỗi transaction. Nếu không làm, ghi "hướng phát triển" trong ADR.

### 4.14 Chuẩn hoá dữ liệu đầu ra: "vào nhiều kiểu, ra một kiểu" (S14, ADR-053)

**Vì sao làm.** Đây là giá trị cốt lõi của hub đối với một dev production (Admin chốt ngày 10/10). Service dùng hub chỉ cần nói **một ngôn ngữ** ở ba lớp:

| Lớp | Đầu vào (mỗi bên thứ ba một kiểu) | Đầu ra (một kiểu) | Ở đâu trong spec |
|---|---|---|---|
| Định dạng | JSON riêng của PayOS, SePay, GitHub, Stripe, nguồn tuỳ chỉnh | phong bì chung + `data` theo **catalog kiểu chuẩn** | §4.14 (mục này) |
| Xác thực | 4 kiểu chữ ký + 3 mẫu của GenericAdapter | Standard Webhooks | §4.7 |
| Nhịp nhận | bên thứ ba gọi lúc nào, retry ra sao là tuỳ họ | push có retry theo luật hub, hoặc polling cursor | §4.5, §4.7 |

**Hiện trạng (đọc code ngày 10/10).** Hiện mới thống nhất được **phong bì**, còn `data` thì chưa:
- PayOS → `payment.succeeded`, `data.amount`, có cả `data.orderCode`. Trường này phạm DoD BB-1 ở §6 (`grep orderCode libs` phải bằng 0).
- SePay → `bank.transfer.received`, `data.transferAmount`.
- GitHub và Stripe → `data` là body gốc.
- Hệ quả: `apps/shop/src/main.ts:136` phải viết `Number(eventData.amount || eventData.transferAmount)`. Cái `if` theo provider bị cấm trong lõi đã bị đẩy sang phía khách hàng.
- Adapter PayOS luôn trả `payment.succeeded`, kể cả khi webhook báo giao dịch lỗi (`code ≠ "00"`).

#### 4.14.1 Luật chung (áp dụng cho mọi adapter, kể cả GenericAdapter và `POST /events`)

1. **Không thay đổi phong bì:** `id, type, source, sourceId, subject, occurredAt, receivedAt, correlationId, origin, normalized`.
2. **`normalized: true`** nghĩa là `data` có hình dạng ổn định mà hub cam kết. Có đúng hai trường hợp:
   - (a) `type` thuộc **catalog kiểu chuẩn** (§4.14.2) và `data` đã qua validator;
   - (b) sự kiện do service tự publish qua `POST /events`, tức hợp đồng của chính service đó.
3. **`normalized: false`** nghĩa là bên thứ ba gửi một kiểu chưa có ánh xạ. Khi đó:
   - `data = { raw: <body gốc đã parse> }`, hoặc `{ raw: "<chuỗi utf8>" }` nếu body không phải JSON;
   - `type = <provider>.<kiểu gốc>`, ví dụ `stripe.customer.created`, `github.release.published`.
4. **Không gian tên dành riêng:** `payment.*` và `repo.*` chỉ dành cho kiểu chuẩn.
   - Adapter phát kiểu thuộc hai không gian này mà `data` không qua validator → **lỗi normalize vĩnh viễn** (phân loại theo ADR-044). Raw_event vẫn còn để phát lại sau khi sửa adapter. **Không** đẩy dữ liệu sai hình dạng ra ngoài, và **không** âm thầm hạ xuống `normalized:false`, vì service đã đăng ký `payment.received` sẽ mất sự kiện mà không biết.
   - `POST /events` với `type` thuộc không gian dành riêng → phải qua validator, sai thì **422** `{error:"schema_mismatch", field}`.
5. **Có `raw` ở mọi kiểu chuẩn:** `data.raw` = body gốc đã parse, là lối thoát cho ai cần trường riêng của provider (Winston). Phần chung **mỏng**, `raw` **đầy đủ**.
   - Đánh đổi: dung lượng `events.data` tăng gần gấp đôi. Chấp nhận được vì retention chỉ 7 ngày (§4.10).
6. **BB-1:** phần chung chỉ chứa khái niệm của **miền** (tiền, giao dịch, repo), **không** chứa khái niệm của service khách hàng.
   - Không có `orderCode`: mã đơn của Shop nằm trong `memo` hoặc `reference`, Shop tự tìm.
   - `orderCode` của PayOS chỉ còn trong `data.raw`.
7. **Hình dạng ổn định:**
   - Mọi khoá của phần chung **luôn có mặt**. Thiếu dữ liệu thì `null`, không bỏ khoá.
   - Chỉ được **thêm** trường tuỳ chọn. Đổi hoặc bỏ trường thì phải làm kiểu mới (`payment.received.v2`). Ghi luật này vào `docs/`.
8. **Số tiền:** số nguyên, tính theo **đơn vị nhỏ nhất** của ISO 4217 (VND tính bằng đồng, USD tính bằng cent; Stripe vốn đã đúng). `currency` viết hoa 3 ký tự. Số tiền không nguyên hoặc ≤ 0 → lỗi validator.
9. **Thời gian:** ISO 8601 có múi giờ.
   - Chuỗi dạng `YYYY-MM-DD HH:mm:ss` không có múi giờ (PayOS `transactionDateTime`, SePay `transactionDate`) được hiểu là **giờ Việt Nam (+07:00)**.
   - Chuyển bằng một hàm dùng chung `parseProviderTime(s, defaultOffset='+07:00')`. Unix giây (Stripe `created`) → ISO.
10. **`subject`** không chứa khái niệm của khách hàng:
    - kiểu `payment.*` → `payment:<providerTxnId>`;
    - kiểu `repo.*` → `repo:<fullName>`;
    - khi `normalized:false` → giữ như hiện nay, hoặc `null`.

#### 4.14.2 Catalog kiểu chuẩn v1

**Miền thanh toán.** Mọi kiểu `payment.*` có chung phần lõi `PaymentCore`:

```ts
// libs/common/src/canonical/payment.ts — thuần TS, không phụ thuộc thư viện ngoài
type Counterparty = { name: string | null; accountNumber: string | null; bank: string | null };
interface PaymentCore {
  amount: number;              // số nguyên > 0, đơn vị nhỏ nhất
  currency: string;            // ^[A-Z]{3}$
  method: 'bank_transfer' | 'card' | 'ewallet' | 'payment_link' | 'other';
  reference: string | null;    // mã tham chiếu giao dịch phía ngân hàng/cổng
  memo: string | null;         // nội dung chuyển khoản / description — nơi service tìm mã của mình
  counterparty: Counterparty | null;   // người trả (received) / người nhận (sent)
  account: { number: string | null; bank: string | null } | null;  // tài khoản của mình
  providerTxnId: string;       // id giao dịch duy nhất phía provider
  raw: unknown;
}
interface PaymentReceived extends PaymentCore { paidAt: string }
interface PaymentSent     extends PaymentCore { sentAt: string }
interface PaymentFailed   extends PaymentCore { failedAt: string; reason: string | null }
interface PaymentRefunded extends PaymentCore { refundedAt: string }   // amount = số tiền hoàn
```

| Kiểu chuẩn | PayOS | SePay | Stripe |
|---|---|---|---|
| `payment.received` | `body.code==="00"` và `body.success!==false` | `transferType==="in"` (hoặc không có trường này) | `payment_intent.succeeded` |
| `payment.sent` | — | `transferType==="out"` | — |
| `payment.failed` | `body.code!=="00"` hoặc `body.success===false` | — | `payment_intent.payment_failed` |
| `payment.refunded` | — | — | `charge.refunded` |

**Bảng ánh xạ trường** (dev kiểm lại tên trường bằng payload mẫu trong `libs/providers/test/fixtures`, hoặc tài liệu chính thức của provider; lệch thì ghi ADR):

| Trường chuẩn | PayOS (`body.data.*`) | SePay (`body.*`) | Stripe (`body.data.object.*`) |
|---|---|---|---|
| `amount` | `amount` | `transferAmount` | `amount_received` (succeeded) · `amount` (failed) · `amount_refunded` (refunded) |
| `currency` | `currency ?? "VND"` | `"VND"` | `currency.toUpperCase()` |
| `method` | `"payment_link"` | `"bank_transfer"` | `payment_method_types[0]==="card" ? "card" : "other"` |
| `reference` | `reference` | `referenceCode` | `id` (pi_… / ch_…) |
| `memo` | `description` | `content` | `description` |
| `counterparty` | `{name: counterAccountName, accountNumber: counterAccountNumber, bank: counterAccountBankName}`; mọi trường null thì `null` | `null` (SePay không gửi) | `null` |
| `account` | `{number: accountNumber, bank: null}` | `{number: accountNumber, bank: gateway}` | `null` |
| `providerTxnId` | `paymentLinkId ?? reference` | `String(id)` | `id` |
| `paidAt` / `sentAt` / … | `parseProviderTime(transactionDateTime)` | `parseProviderTime(transactionDate)` | `created` (unix) → ISO |
| `reason` (failed) | `body.desc ?? data.desc` | — | `last_payment_error?.message ?? null` |

**Miền repo (GitHub).**

```ts
// libs/common/src/canonical/repo.ts
type Repo = { fullName: string; url: string };
type Actor = { login: string };
interface RepoPush {
  repo: Repo; branch: string | null; tag: string | null;   // ref "refs/heads/x" → branch, "refs/tags/x" → tag
  commits: { id: string; message: string; author: string | null; url: string; timestamp: string }[]; // tối đa 20
  commitCount: number; actor: Actor; compareUrl: string | null; raw: unknown;
}
interface RepoPullRequest {   // repo.pull_request.<action>
  repo: Repo; number: number; title: string; state: 'open' | 'closed'; merged: boolean;
  url: string; author: Actor; actor: Actor; baseBranch: string; headBranch: string; raw: unknown;
}
interface RepoIssue {         // repo.issue.<action>
  repo: Repo; number: number; title: string; state: 'open' | 'closed';
  url: string; author: Actor; actor: Actor; labels: string[]; raw: unknown;
}
```

- Ánh xạ: `push` → `repo.push`; `pull_request` → `repo.pull_request.<action>`, **riêng** `action=closed` kèm `pull_request.merged=true` → `repo.pull_request.merged`; `issues` → `repo.issue.<action>`.
- Không chép email của author vào phần chung, vì là dữ liệu cá nhân. Email vẫn có trong `raw`.
- Mọi event GitHub khác (`ping`, `release`, `star`, `workflow_run`…) → `github.<event>[.<action>]`, `normalized:false`.
- **Thay đổi so với hiện nay:** trước đây các event này ra `repo.<event>`. Ghi lại thay đổi này vào ADR-053.

**Miền khác:** chưa có catalog. Mọi kiểu Stripe ngoài bảng trên → `stripe.<type gốc>`, `normalized:false`.

#### 4.14.3 Validator và nơi đặt code

- `libs/common/src/canonical/`: `payment.ts`, `repo.ts`, `index.ts`. Viết type guard tay `validateCanonical(type, data): {ok:true} | {ok:false, field:string}` và `isReservedType(type)`. **Không** thêm zod hay ajv. Catalog có 7 dạng, viết tay đọc được và bảo vệ được trước hội đồng.
- `parseProviderTime` đặt trong `libs/common/src/canonical/time.ts`.
- `NormalizeConsumer` gọi `validateCanonical` sau `adapter.normalize()` với mọi event có `isReservedType`. Sai → lỗi vĩnh viễn kèm `field`, có log và metric `hub_normalize_schema_errors_total{source}`. Đây là **chỗ duy nhất** lõi biết về catalog: lõi chỉ biết "kiểu dành riêng thì phải đúng khuôn", **không** biết provider nào (không `if (provider === 'x')`).
- `ApiAdapter` / `POST /events`: kiểm `isReservedType` → `validateCanonical` ở tầng controller để trả 422 **đồng bộ**, trước khi `persistAccepted`.
- `libs/hub-sdk` re-export các type: `import type { PaymentReceived, RepoPush } from '@hub/sdk'`. Không re-export validator; SDK vẫn không phụ thuộc gì.

#### 4.14.4 GenericAdapter: ánh xạ khai báo để ra kiểu chuẩn

Thêm khối **tuỳ chọn** `mapping` vào `verificationConfig` (§4.8). Ví dụ cho "AB Bank":

```jsonc
{
  "scheme": "hmac-sha256", "header": "x-signature", "idempotency": { "field": "maGD" },
  "eventType": "payment.received",
  "mapping": {
    "amount": "soTien",
    "currency": { "const": "VND" },
    "method": { "const": "bank_transfer" },
    "reference": "maGD",
    "memo": "noiDung",
    "providerTxnId": "maGD",
    "paidAt": "thoiGian"
  },
  "timezone": "+07:00"     // tuỳ chọn, mặc định +07:00, dùng cho chuỗi thời gian không múi giờ
}
```

- Giá trị trong `mapping` chỉ có hai dạng:
  - tên trường **cấp một** của body (`^[A-Za-z0-9_]{1,64}$`, cùng luật với `idempotency.field`, **cấm** JSONPath và dấu chấm);
  - hoặc `{"const": string | number}`.
- Chỉ cho `mapping` khi `eventType` thuộc **miền thanh toán** (`payment.received | payment.sent | payment.failed | payment.refunded`). Kiểu `repo.*` có cấu trúc lồng nhau, nên **không** hỗ trợ qua GenericAdapter.
- **Kiểm lúc tạo source** (422 kèm tên trường):
  - `eventType` thuộc không gian dành riêng mà thiếu `mapping` → 422;
  - `mapping` thiếu trường bắt buộc (`amount`, `currency`, `method`, `providerTxnId`, và trường thời gian của kiểu đó) → 422;
  - có `mapping` mà `eventType` không thuộc miền thanh toán → 422.
- **Lúc normalize:**
  - Trường tuỳ chọn không được ánh xạ → `null`. `counterparty` và `account` = `null`.
  - `amount`: nhận number nguyên, hoặc chuỗi chỉ gồm chữ số (`"50000"`). Chuỗi có dấu phân cách như `"50.000"` hay `"50,000"` **coi là sai**: hub không đoán định dạng số.
  - `raw` = body.
  - `normalized: true`.
  - Body thiếu trường đã ánh xạ hoặc sai kiểu → lỗi vĩnh viễn theo luật 4.
- Không có `mapping` và `eventType` không thuộc không gian dành riêng → giữ như §4.8, nhưng theo luật 3: `data = { raw: body }`, `normalized:false`.
- `diagnose()` (§4.8) thêm `reason: "mapping_field_missing"` kèm `field`, chỉ tên trường, không có giá trị. Nhờ vậy chế độ lắng nghe báo được "thiếu trường `soTien`".

#### 4.14.5 Thay đổi phía người dùng hub

- **Shop** (§4.12):
  - `eventTypes` đổi thành `['payment.received']`.
  - Đọc `data.amount` và `data.currency`. Tìm mã đơn trong `data.memo`, rồi tới `data.reference`.
  - **Xoá** nhánh `eventData.transferAmount`, `eventData.orderCode` và `eventData.content` ở `apps/shop/src/main.ts:129-136`.
  - Shop tạo link/QR thì đặt mã đơn vào nội dung chuyển khoản hoặc description. Hiện đã làm như vậy với SePay.
- **Seed và dữ liệu cũ:**
  - Subscription seed đang dùng `payment.succeeded` hoặc `bank.transfer.*` → đổi sang `payment.received`.
  - Event cũ trong DB **không** migrate. Retention 7 ngày sẽ tự dọn. Ghi điều này vào ADR-053.
- **Template Telegram/Discord:** placeholder `{{data.amount}}` giờ đúng cho **mọi** nguồn thanh toán. Đổi ví dụ ở seed.
- **UI** (phiên `ui-revamp`): placeholder `payment.succeeded` ở trang subscriptions và payload mẫu ở playground cần đổi. Spec này chỉ ghi lại, không làm UI.

---

## 5. Story (làm đúng thứ tự)

| ID | Story | Phụ thuộc | Ước lượng |
|---|---|---|---|
| **S0** | Kiểm lại P0: chạy luồng GitHub → shop thành công thật (SSRF đã sửa). **Sửa dual-write ở normalize**: ghi delivery message vào `outbox` (topic `delivery.created`) **trong** transaction; relay route `delivery.*` sang `x.hub.delivery`. Xoá `channel.publish` trực tiếp | — | 2h |
| **S1** | Schema §4.1 + seed project default + comment `tenant_id` + escape hatch `findProjectBySlug`, `findApiKeyByHash` trên `PrismaService` | S0 | 2h |
| **S2** | Console admin §4.3A: project và key (tạo, liệt kê, revoke), connection string, audit, `?projectId=` cho route cũ. Seed tạo sẵn key `shop` (scope `manage:endpoints`, `read:events`) và in `HUB_URL` | S1 | 3h |
| **S3** | `ApiKeyGuard`, decorator `@RequireScope()`, `/v1/p/:project/me`, bảng lỗi §4.3, `lastUsedAt` có giới hạn | S2 | 2h |
| **S4** | `POST /events` §4.4: tách `persistAccepted`, `ApiAdapter`, source `api` tạo kèm key | S3 | 3h |
| **S5** | Endpoint, subscription cho service §4.3B + wildcard + `sourceIds` + kiểm cùng project + khoá ngoại ghép §4.6 | S3 | 3h |
| **S6** | Standard Webhooks §4.7: lib dùng chung, sender, challenge, chặn delivery khi chưa VERIFIED, audit | S5 | 3h |
| **S7** | Polling (A) + long-poll §4.5 (`seq`, cửa sổ lắng, `status=failed`, `types`) + retention §4.10 + sửa `after` của dashboard | S5 | 4h |
| **S8** | GenericAdapter §4.8 + đổi interface + `IdempotencyKeyMissingError` + `normalized` | S4 | 3h |
| **S9** | `GET /sources/:id/inspect` + `diagnose()` | S8 | 1.5h |
| **S10** | `DELIVERY_TIMEOUT_MS` §4.9 + test khoá hành vi timeout | S0 | 1h |
| **S14** | Chuẩn hoá đầu ra §4.14: `libs/common/src/canonical` (catalog + validator + `parseProviderTime`), sửa 4 adapter theo bảng ánh xạ, kiểm ở NormalizeConsumer và `POST /events`, `mapping` cho GenericAdapter, `docs/EVENT-CATALOG.md`. **Làm sau S10, trước S11** | S8, S9 | 4h |
| **S11** | SDK §4.11 (re-export type của catalog) + Shop thành service thật §4.12, đọc `payment.received` §4.14.5 + gỡ phần seed tạo destination của Shop | S6, S7, S14 | 4h |
| **S12** | Seed màn demo: project `cafe` và `bookstore`, mỗi project một source PayOS hoặc SePay mock, một key, một endpoint mock. Viết `docs/DEMO-MULTI-PROJECT.md` | S11 | 1.5h |
| S13 | (tuỳ chọn) RLS §4.13 | S12 | 3h |

**Cập nhật tài liệu khi xong:**
- `docs/ARCHITECTURE.md`: thêm mục Project / API key / kết nối.
- `.env.example`: thêm `HUB_PUBLIC_URL`, `HUB_URL`, `SHOP_PUBLIC_URL`, `DELIVERY_TIMEOUT_MS`, `EVENT_RETENTION_DAYS`.
- `CLAUDE.md` mục Trạng thái: thêm một dòng.
- `docs/EVENT-CATALOG.md` (S14): catalog v1, bảng ánh xạ, luật ổn định hình dạng (luật 7 §4.14.1). Đây là tài liệu "hợp đồng" đưa cho service dùng hub.

---

## 6. Definition of Done (toàn đợt)

- [ ] `npx jest -w 2` xanh. Có test mới cho mọi mục ở §7.1.
- [ ] Mọi kịch bản E2E ở §7.2 chạy bằng `curl` cho đúng kết quả mong đợi, trên `docker compose up` sạch (volume mới).
- [ ] `grep -rn "X-Hub-Signature\|x-hub-signature\|X-Hub-Event-Id" apps libs` chỉ còn ở test hoặc comment lịch sử.
- [ ] `grep -rn "channel.publish" apps/hub-worker/src/consumers` = 0 (S0).
- [ ] `grep -rn "orderCode\|DH\\\\d" apps/hub-api apps/hub-worker libs` = 0 (BB-1).
- [ ] Không có truy vấn `tenant_id` nào ngoài `TenantScopedRepository` hoặc escape hatch có tên trên `PrismaService`.
- [ ] Đã ghi ADR cho mọi quyết định phát sinh (số tiếp theo còn trống).
- [ ] `apps/shop/src/main.ts` ≤ 300 dòng.
- [ ] (S14) `grep -n "transferAmount\|eventData.content" apps/shop/src` = 0: Shop chỉ đọc kiểu chuẩn.
- [ ] (S14) Mỗi adapter có test fixture cho **mọi** dòng của bảng ánh xạ §4.14.2. U50 (khoá hình dạng) xanh.

---

## 7. Kịch bản test (cho phiên TEST)

### 7.0 Chuẩn bị

```bash
# Ở C:\webhook-hub. Làm sạch volume để kiểm cả đường seed:
docker compose down -v && docker compose up -d --build
docker compose logs hub-api | grep -i "HUB_URL\|listening"       # lấy connection string seed in ra
# Đăng nhập admin lấy JWT
JWT=$(curl -s localhost:4000/auth/login -H 'content-type: application/json' \
  -d '{"username":"<ADMIN_USERNAME trong .env>","password":"<mật khẩu>"}' | jq -r .accessToken)
H="Authorization: Bearer $JWT"
```

Biến dùng xuyên suốt: `API=http://localhost:4000`. Endpoint mock để nhận push: tự dựng một server nhỏ, hoặc dùng `apps/shop` (cổng 4001).

**Server nhận thử** (lưu tại `scratch/echo.js`, chạy `node scratch/echo.js 4100`):
- trả về challenge nếu body là `endpoint.verification`;
- ghi mọi request ra stdout;
- `?mode=fail` thì trả 500, `?mode=slow` thì ngủ 30s.

Phiên test tự viết server này, khoảng 20 dòng.

> **Lưu ý docker:** endpoint mà hub-worker gọi phải là địa chỉ worker thấy được. Dùng `http://host.docker.internal:4100/...`, hoặc chạy echo trong compose.

### 7.1 Unit / integration (jest), mỗi dòng là một test

| # | File test gợi ý | Kịch bản | Mong đợi |
|---|---|---|---|
| U1 | `libs/crypto/test/standard-webhooks.spec.ts` | Ký rồi verify cùng secret `whsec_...` | true |
| U2 | 〃 | Sửa 1 byte body | false |
| U3 | 〃 | timestamp lệch 301s / 299s | false / true |
| U4 | 〃 | header có 2 chữ ký `"v1,sai v1,đúng"` | true |
| U5 | 〃 | secret không có `whsec_` (secret cũ) | ký và verify bằng utf8, true |
| U6 | 〃 | Vector chuẩn trong README của repo standard-webhooks (msg_p5jXN8AQM9LWM0D4loKWxJek, ts 1614265330, secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, body `{"test": 2432232314}`) | chữ ký = `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=` |
| U7 | `libs/providers/test/generic.adapter.spec.ts` | hmac-sha256 hex, header đúng | verify true |
| U8 | 〃 | hmac-sha256 base64 + prefix `sha256=` | true; bỏ prefix → false |
| U9 | 〃 | hmac tính trên JSON đã parse rồi stringify lại (khoảng trắng khác) | **false** (phải tính trên rawBody) |
| U10 | 〃 | static-token đúng / sai 1 ký tự / thiếu header | true / false / false |
| U11 | 〃 | 2 secret (xoay secret), request ký bằng secret cũ | true |
| U12 | 〃 | idempotency `{field:"transactionId"}`, body thiếu trường | ném `IdempotencyKeyMissingError` |
| U13 | 〃 | idempotency `{field:"a.b"}` lúc validate config | lỗi validate |
| U14 | 〃 | normalize body không phải JSON | `data={raw:"..."}`, `normalized:false`, `type=eventType` |
| U15 | 〃 | `diagnose`: header gửi là `x-sig`, config chờ `x-signature` | `reason:missing_header`, `candidateHeaders` chứa `x-sig`, **không** có giá trị |
| U16 | `libs/providers/test/api.adapter.spec.ts` | `verify()` với bất kỳ input nào | false |
| U17 | `libs/database/test/subscription-match.spec.ts` | type `payment.link.succeeded`; subs `payment.*`, `payment.link.*`, `payment.link.succeeded`, `pay.*`, `payment` | khớp 3 sub đầu, không khớp 2 sub cuối |
| U18 | 〃 | sub có `sourceIds=[S1]`, event từ S2 | không khớp; `sourceIds=[]` → khớp |
| U19 | 〃 | validate type `*`, `*.paid`, `payment.*.x`, `Payment.*` | 422 cả 4 |
| U20 | `apps/hub-api/test/api-key.guard.spec.ts` | key hợp lệ, project đúng | qua, `request.tenantId` = project |
| U21 | 〃 | key revoke | 401 |
| U22 | 〃 | key project A gọi path project B **có tồn tại** vs path project **không tồn tại** | cả hai 404, **body giống hệt** |
| U23 | 〃 | thiếu scope | 403 `missing_scope` |
| U24 | `apps/hub-api/test/polling.spec.ts` | event `received_at = now()-1s` | **không** trả (cửa sổ lắng) |
| U25 | 〃 | 3 event seq 1, 2, 3; `after=1` | trả 2, 3 **theo thứ tự tăng dần**; `nextCursor="3"` |
| U26 | 〃 | `wait=3`, không có event, sau 1.5s chèn event (`received_at` lùi 5s) | trả về trong khoảng 1.5–3s, có event đó |
| U27 | 〃 | `wait=2`, không có gì | trả `{events:[], nextCursor:after}` sau khoảng 2s |
| U28 | `apps/hub-worker/test/delivery-consumer.spec.ts` (bổ sung) | sender trả timeout (status 500, error chứa `timeout`) | retryable, `recordFailure` được gọi, không DEAD |
| U29 | `apps/hub-worker/test/normalize-outbox.spec.ts` | normalize tạo N delivery | N dòng outbox `delivery.created` trong **cùng** tx; không gọi `channel.publish` |
| U30 | 〃 | destination webhook `verification=PENDING` | không tạo delivery |
| U31 | `libs/hub-sdk/test/sdk.spec.ts` | parse `hubs://hk_live_abc@h.example.com/cafe` | baseUrl `https://h.example.com`, project `cafe` |
| U32 | 〃 | `console.log(client)`, `JSON.stringify(client)`, message của lỗi | không chứa key thô |
| U33 | 〃 | `challengeResponse({type:'endpoint.verification',challenge:'x'})` / body khác | `{challenge:'x'}` / null |
| U34 | `libs/providers/test/canonical-payos.spec.ts` | fixture PayOS `code:"00"`, amount 50000, description `"DH123456 thanh toan"` | `type=payment.received`, `normalized:true`, `amount=50000`, `currency="VND"`, `method="payment_link"`, `memo` = description, `subject` bắt đầu `payment:`, **không** có khoá `orderCode` ngoài `data.raw` |
| U35 | 〃 | fixture PayOS `code:"01"` hoặc `success:false` | `type=payment.failed`, `reason` = desc |
| U36 | `libs/providers/test/canonical-sepay.spec.ts` | `transferType:"in"` / `"out"` / không có trường | `payment.received` / `payment.sent` / `payment.received`; `account.bank` = `gateway`; `counterparty=null` |
| U37 | `libs/providers/test/canonical-same-shape.spec.ts` | **cùng một khoản 50000đ** đi qua PayOS và SePay | `Object.keys(data)` của hai event **giống hệt nhau**; `amount`, `currency` bằng nhau. Đây là test chứng minh luận điểm "ra một kiểu" |
| U38 | `libs/providers/test/canonical-stripe.spec.ts` | `payment_intent.succeeded`, `amount_received:1999`, `currency:"usd"` | `payment.received`, `amount=1999`, `currency="USD"`, `method="card"`, `paidAt` = ISO của `created` |
| U39 | 〃 | `customer.created` | `type=stripe.customer.created`, `normalized:false`, `data` chỉ có khoá `raw` |
| U40 | `libs/providers/test/canonical-github.spec.ts` | push `ref:"refs/heads/main"`, 25 commit | `branch="main"`, `tag=null`, `commits.length=20`, `commitCount=25`, không có email trong phần chung; `ref:"refs/tags/v1"` → `branch=null`, `tag="v1"` |
| U41 | 〃 | `pull_request` `action:closed` + `merged:true` / `merged:false` | `repo.pull_request.merged` / `repo.pull_request.closed` |
| U42 | 〃 | event `ping`, `release` | `github.ping`, `github.release.published`, `normalized:false` |
| U43 | `libs/common/test/canonical-time.spec.ts` | `parseProviderTime("2026-10-10 14:02:37")`; chuỗi ISO có `Z`; `"abc"` | `"2026-10-10T07:02:37.000Z"`; giữ nguyên thời điểm; ném lỗi |
| U44 | `libs/common/test/canonical-validate.spec.ts` | `payment.received` với amount `1.5` / `0` / `"100"` / thiếu khoá `memo` / `currency:"vnd"` / dữ liệu đúng | 5 trường hợp đầu `{ok:false, field}` đúng tên trường; trường hợp cuối `{ok:true}` |
| U45 | `apps/hub-worker/test/normalize-canonical.spec.ts` | adapter giả phát `payment.received` sai khuôn | lỗi vĩnh viễn (ADR-044), **không** có dòng `events` hay `deliveries`, metric `hub_normalize_schema_errors_total` +1; raw_event vẫn còn |
| U46 | `libs/providers/test/generic.adapter.spec.ts` | `mapping` như §4.14.4, body `{soTien:50000,maGD:"GD1",noiDung:"DH123 tt",thoiGian:"2026-10-10 09:00:00"}` | `payment.received`, `normalized:true`, `amount=50000`, `paidAt="2026-10-10T02:00:00.000Z"`, `counterparty=null`, `raw` = body |
| U47 | 〃 (validate config) | `eventType:"payment.received"` không có `mapping` / `mapping` thiếu `amount` / có `mapping` mà `eventType:"bank.x"` / giá trị `"a.b"` | 422 cả 4, kèm tên trường |
| U48 | 〃 | `soTien:"50.000"`; body thiếu `soTien` | lỗi vĩnh viễn; `diagnose` trả `reason:"mapping_field_missing"`, `field:"soTien"`, không có giá trị |
| U49 | `apps/hub-api/test/publish-canonical.spec.ts` | `POST /events` `type:"payment.received"` thiếu `providerTxnId` / `type:"order.created"` data bất kỳ | 422 `{error:"schema_mismatch",field:"providerTxnId"}` / 202 |
| U50 | `libs/providers/test/canonical-contract.spec.ts` | chạy mọi fixture của 4 adapter, so tập khoá của `data` với danh sách khoá khai báo của từng kiểu chuẩn | khớp tuyệt đối. Khoá luật 7: thêm hoặc bớt khoá mà không đổi catalog thì test đỏ |

### 7.2 E2E bằng curl (chạy trên docker compose)

Mỗi kịch bản ghi **PASS/FAIL + output thực** vào §10.

**T1 — Tạo project và key, connection string**
```bash
curl -s -X POST $API/api/v1/projects -H "$H" -H 'content-type: application/json' \
  -d '{"slug":"cafe","name":"Cafe","environment":"test"}'                 # 201, lấy id → PA
curl -s -X POST $API/api/v1/projects -H "$H" -H 'content-type: application/json' \
  -d '{"slug":"bookstore","name":"Bookstore","environment":"live"}'       # 201 → PB
curl -s -X POST $API/api/v1/projects -H "$H" -H 'content-type: application/json' \
  -d '{"slug":"cafe","name":"x"}'                                         # 409
curl -s -X POST $API/api/v1/projects/$PA/keys -H "$H" -H 'content-type: application/json' \
  -d '{"serviceName":"cafe-be","scopes":["publish:events","read:events","manage:endpoints","manage:sources"]}'
# 201: key bắt đầu hk_test_ ; connectionString = hub://hk_test_...@localhost:4000/cafe → KA
# Tương tự cho PB → KB (bắt đầu hk_live_)
curl -s $API/api/v1/projects/$PA/keys -H "$H"     # KHÔNG có trường key / keyHash
```
✅ Mong đợi:
- như comment ở từng lệnh;
- `docker compose exec postgres psql -U <user> -d <db> -c "select key_hash, key_prefix from hub.api_keys"` cho thấy hash 64 ký tự hex, **không** có key thô;
- `select action from hub.audit_logs` có `api_key.created`.

**T2 — Cô lập giữa các project (cốt lõi của demo)**
```bash
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/p/cafe/me -H "Authorization: Bearer $KA"            # 200
curl -s -w '\n%{http_code}\n' $API/v1/p/bookstore/me -H "Authorization: Bearer $KA"                  # 404 {"error":"not_found"}
curl -s -w '\n%{http_code}\n' $API/v1/p/khongtontai/me -H "Authorization: Bearer $KA"               # 404, body Y HỆT dòng trên
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/p/cafe/me -H "Authorization: Bearer hk_test_sai"   # 401
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/p/cafe/me                                          # 401
# Lấy id một endpoint của bookstore (EB, tạo ở T4) rồi dùng KA gọi:
curl -s -w '\n%{http_code}\n' -X POST $API/v1/p/cafe/endpoints/$EB/verify -H "Authorization: Bearer $KA"   # 404
```

**T3 — Scope**
```bash
# Tạo key chỉ có read:events cho PA → KR
curl -s -w '\n%{http_code}\n' -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KR" \
  -H 'content-type: application/json' -d '{"type":"order.created","data":{},"idempotencyKey":"x1"}'
# 403 {"error":"missing_scope","required":"publish:events"}
curl -s -X POST $API/api/v1/projects/$PA/keys -H "$H" -H 'content-type: application/json' \
  -d '{"serviceName":"rong","scopes":[]}'                                    # 422
```

**T4 — Endpoint + challenge**
```bash
node scratch/echo.js 4100 &
curl -s -X POST $API/v1/p/cafe/endpoints -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d '{"name":"echo","url":"http://host.docker.internal:4100/ok"}'
# 201, verification=VERIFIED, có signingSecret bắt đầu whsec_ (vì không truyền) → EA, SECA
# echo in ra request có header webhook-id bắt đầu verify_, webhook-signature bắt đầu v1,
curl -s -X POST $API/v1/p/cafe/endpoints -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d '{"name":"hong","url":"http://host.docker.internal:4100/?mode=fail"}'
# 201, verification=FAILED, verificationError=http_500
curl -s -X POST $API/v1/p/cafe/endpoints -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d '{"name":"ssrf","url":"http://169.254.169.254/latest/meta-data"}'
# 201 FAILED ssrf_blocked (hoặc 422; ghi lại hub làm gì, kèm cách xử lý). KHÔNG được có request nào đi ra IP đó
```
Tạo endpoint cho bookstore bằng KB → EB.

**T5 — Subscription: wildcard, sourceIds, chặn vượt project**
```bash
curl -s -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" -H 'content-type: application/json' \
  -d "{\"endpointId\":\"$EA\",\"name\":\"all-orders\",\"eventTypes\":[\"order.*\"]}"         # 201
curl -s -w '\n%{http_code}\n' -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" \
  -H 'content-type: application/json' -d "{\"endpointId\":\"$EB\",\"name\":\"x\",\"eventTypes\":[\"order.*\"]}"  # 404
curl -s -w '\n%{http_code}\n' -X POST $API/v1/p/cafe/subscriptions -H "Authorization: Bearer $KA" \
  -H 'content-type: application/json' -d "{\"endpointId\":\"$EA\",\"name\":\"x\",\"eventTypes\":[\"*\"]}"        # 422
```
Kiểm thêm ở tầng DB: chạy thẳng một `INSERT` vào `hub.subscriptions` với `tenant_id=PA`, `destination_id=EB`. Mong đợi DB **từ chối** (khoá ngoại ghép).

**T6 — Publish + push có chữ ký + chống trùng**
```bash
curl -s -w '\n%{http_code}\n' -X POST $API/v1/p/cafe/events -H "Authorization: Bearer $KA" \
  -H 'content-type: application/json' -d '{"type":"order.created","data":{"total":45000},"idempotencyKey":"ord-1"}'   # 202
# Gửi lại y hệt → 200 {"duplicate":true}
```
✅ Mong đợi:
- echo nhận **đúng 1** request, có `webhook-id` = event id (`evt_...`), body có `"normalized":true`;
- verify chữ ký bằng `SECA` qua SDK (`node -e` gọi `verifyWebhook`) → true;
- **không** có header `x-hub-*`;
- endpoint của bookstore **không** nhận gì.

Thêm các ca:
- `type:"Order"` → 422; thiếu `idempotencyKey` → 422.
- Gọi thẳng `POST /hooks/api/api_<keyId>` → **401** (ApiAdapter.verify luôn false).

**T7 — Endpoint chưa VERIFIED không nhận sự kiện**
- Tạo subscription `order.*` cho endpoint `hong` (FAILED).
- Publish `ord-2`.
- Mong đợi: `select count(*) from hub.deliveries where subscription_id=<sub của hong>` = 0.
- Echo đổi sang chế độ ok, gọi `/endpoints/<hong>/verify` → VERIFIED. Publish `ord-3` → có delivery.

**T8 — Polling (A), long-poll, status=failed**
```bash
curl -s "$API/v1/p/cafe/events?after=0&limit=2" -H "Authorization: Bearer $KA"
#   seq tăng dần, nextCursor là chuỗi; gọi tiếp after=nextCursor cho đến khi rỗng; không lặp, không sót
curl -s "$API/v1/p/cafe/events?after=0&types=order.*" -H "Authorization: Bearer $KA"      # chỉ order.*
curl -s "$API/v1/p/cafe/events?after=0" -H "Authorization: Bearer $KB"
#   KB gọi path cafe → 404; gọi path bookstore → không thấy event nào của cafe
time curl -s "$API/v1/p/cafe/events?after=<cursor cuối>&wait=10" -H "Authorization: Bearer $KA"
#   trong lúc chờ, publish ord-9 từ terminal khác → trả về trong khoảng ≤ 2+1+độ trễ normalize giây, có ord-9
time curl -s "$API/v1/p/cafe/events?after=<cursor cuối>&wait=3" -H "Authorization: Bearer $KA"
#   không ai publish → rỗng sau khoảng 3s
```
**Khôi phục sau khi endpoint chết** (điều kiện của Sally):
1. Dừng echo.
2. Publish `ord-20` … `ord-24`.
3. Chờ các delivery chuyển RETRYING. Muốn có DEAD ngay thì cho echo trả 400.
4. `GET events?after=0&status=failed&endpointId=$EA` phải trả đủ 5 event, không thừa event đã SUCCEEDED.

**T9 — GenericAdapter (ngân hàng giả) + chế độ lắng nghe**
```bash
curl -s -X POST $API/v1/p/cafe/sources -H "Authorization: Bearer $KA" -H 'content-type: application/json' -d '{
  "provider":"generic","name":"AB Bank (giả)","secret":"bank_secret_123",
  "verificationConfig":{"scheme":"hmac-sha256","header":"x-signature","encoding":"hex",
    "idempotency":{"field":"transactionId"},"eventType":"bank.transaction.received"}}'
# 201, webhookUrl=/hooks/generic/<sourceKey> → URL_G, SRC_G
BODY='{"transactionId":"TX1","soTien":50000}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $2}')
curl -s -w '\n%{http_code}\n' $API$URL_G -H 'content-type: application/json' -H "x-signature: $SIG" --data-raw "$BODY"   # 200
# Gửi lại y hệt → 200 duplicate
curl -s -w '\n%{http_code}\n' $API$URL_G -H 'content-type: application/json' -H "x-sig: $SIG" --data-raw "$BODY"         # 401
curl -s -w '\n%{http_code}\n' $API$URL_G -H 'content-type: application/json' -H "x-signature: $SIG" --data-raw '{"soTien":1}'  # 401 (chữ ký không khớp body)
B2='{"soTien":1}'; S2=$(printf '%s' "$B2" | openssl dgst -sha256 -hmac bank_secret_123 | awk '{print $2}')
curl -s -w '\n%{http_code}\n' $API$URL_G -H 'content-type: application/json' -H "x-signature: $S2" --data-raw "$B2"      # 422 missing_idempotency_key
curl -s "$API/v1/p/cafe/sources/$SRC_G/inspect?since=2000-01-01T00:00:00Z" -H "Authorization: Bearer $KA"
```
✅ Mong đợi khi gọi `inspect`:
- có dòng ACCEPTED (`reason:"ok"`);
- có dòng REJECTED với `reason:"missing_header"` và `candidateHeaders:["x-sig"]`;
- có dòng `signature_mismatch`;
- có dòng `missing_idempotency_key`;
- **không** có chuỗi `$SIG` hay `bank_secret_123` ở bất kỳ đâu trong response.

Thêm:
- Event sinh ra có `type=bank.transaction.received`, `normalized=false`, `data.raw.soTien=50000` (S14: payload thô nằm dưới `raw`).
- Subscription `bank.*` với `sourceIds:[SRC_G]` nhận được event này.
- Tạo source `generic` thiếu `verificationConfig` → 422; `idempotency:{"field":"a.b"}` → 422.
- Lặp lại T9 với `static-token` (header `authorization`, prefix `Bearer `) và `standard-webhooks` (ký bằng SDK).

**T10 — Noisy neighbor (hướng A), có số đo**
1. Endpoint của bookstore trỏ `?mode=slow` (ngủ 30s), subscription `order.*`.
2. Endpoint của cafe trỏ echo bình thường.
3. Publish **40** event vào bookstore, ngay sau đó publish 20 event vào cafe.
4. Đo độ trễ của cafe (`delivery_attempts.created_at` − `events.received_at`) qua SQL. Lấy p50 và p95.
5. Chạy lại với `DELIVERY_TIMEOUT_MS=10000` để so sánh.

✅ Mong đợi:
- attempt của bookstore có `duration_ms` khoảng 5000 và error chứa `timeout`, rồi chuyển RETRYING;
- sau 5 lỗi, circuit của bookstore OPEN;
- p95 của cafe bị chặn trên khoảng `timeout × ⌈40/20⌉` trong đợt đầu, rồi giảm khi circuit mở.
- Ghi **bảng số** vào §10. Đây là số liệu cho mục "hướng phát triển: semaphore".

**T11 — Shop là service thật**
1. `docker compose down -v && up`.
2. Log của shop có dòng "endpoint VERIFIED". Bảng `hub.destinations` có endpoint của shop với `verification=VERIFIED`, do **API** tạo (seed không tạo).
3. Chạy luồng mua hàng PayOS hoặc SePay mock như cũ: đơn chuyển PAID, cộng tiền đúng một lần, kể cả khi bắn lại cùng webhook 3 lần.
4. Shop nhận request **không** chữ ký → 401. Request challenge giả không có chữ ký → 401.
5. Bỏ `HUB_SIGNING_SECRET` → shop không khởi động, lỗi rõ ràng.
6. `wc -l apps/shop/src/main.ts` ≤ 300.

**T12 — Revoke key chỉ ngắt đúng một service**
1. Tạo thêm key `KA2` cho cafe.
2. `DELETE /api/v1/projects/$PA/keys/<id KA>` → 204, gọi lại → 204.
3. KA gọi `/me` → 401. KA2 gọi `/me` → 200. KB → 200.
4. Endpoint đã đăng ký bằng KA **vẫn nhận** push: endpoint thuộc project, không thuộc key. Ghi nhận hành vi này vào §10.
5. Audit có `api_key.revoked`.

**T13 — Retention**
1. Đặt `EVENT_RETENTION_DAYS=1`.
2. Chạy `UPDATE hub.events SET received_at = now() - interval '2 days' WHERE ...` cho 3 event.
3. Kích job bằng tay (dev cung cấp lệnh hoặc env `CLEANUP_INTERVAL_MS` ngắn).
4. Mong đợi: 3 event, delivery và attempt của chúng biến mất; event khác còn nguyên.
5. Chạy 2 worker (`docker compose up --scale hub-worker=2`): log cho thấy **chỉ một** instance chạy cleanup mỗi lượt.

**T14 — Hồi quy (không được hỏng)**
1. GitHub webhook ký đúng → 200; trùng → 200 duplicate; sai chữ ký → 401 + raw_event REJECTED. Theo `CLAUDE.md`, HMAC tính trên rawBody.
2. Replay một delivery DEAD qua `/api/v1/deliveries/:id/replay` → generation +1, endpoint nhận lại với **cùng** `webhook-id`.
3. Dashboard cũ gọi `/api/v1/overview`, không có `projectId` → vẫn chạy (project default).
4. Socket.IO: client JWT chỉ nhận sự kiện của project mình (ADR-035).
5. Tắt Redis (`docker compose stop redis`) rồi publish → vẫn 202, không tạo trùng (BB-2). Bật lại Redis.
6. `npx jest -w 2` xanh toàn bộ.

**T15 — Vào nhiều kiểu, ra một kiểu (S14)**
1. Tạo subscription `payment.received` (không lọc source) trên endpoint echo `EA` của cafe.
2. Bắn vào source của cafe: một webhook **PayOS** mock (`code:"00"`, 50000) và một webhook **SePay** mock (`transferType:"in"`, 50000). Cách bắn giống seed S12 / `docs/DEMO-MULTI-PROJECT.md`.
   ✅ echo nhận **2** request. Với mỗi body, chạy `jq '.data | del(.raw) | keys'` → **hai kết quả giống hệt nhau**. `jq '.data.amount'` = 50000 cả hai. Chuỗi `orderCode` chỉ xuất hiện dưới `.data.raw`.
3. Tạo source GenericAdapter "AB Bank" có `mapping` như §4.14.4, rồi bắn body `{soTien:50000,...}` có ký đúng.
   ✅ echo nhận request thứ 3: cùng `type`, cùng tập khoá ở bước 2, `normalized:true`.
4. Bắn lại AB Bank nhưng bỏ `soTien` → gọi `inspect`.
   ✅ có dòng `reason:"mapping_field_missing"`, `field:"soTien"`; echo **không** nhận thêm gì.
5. `POST /v1/p/cafe/events` với `type:"payment.received"`, `data:{amount:1}` → **422** `schema_mismatch`.
6. Shop: tạo đơn, trả bằng SePay mock rồi tạo đơn khác trả bằng PayOS mock. ✅ cả hai đơn `PAID` đúng số tiền.
   `grep -n "transferAmount" apps/shop/src/main.ts` → không có kết quả.
7. Bắn Stripe `customer.created` (mock, ký đúng) → event `stripe.customer.created`, `normalized:false`, subscription `payment.received` **không** nhận.

### 7.3 Kịch bản demo cho hội đồng (chạy cuối, quay màn hình)

Màn hình chia đôi: dashboard project **cafe** bên trái, **bookstore** bên phải.

1. Bắn PayOS hoặc SePay vào source của cafe: bên trái sáng lên, bên phải im lặng hoàn toàn.
2. Service bookstore dùng key của mình đòi sự kiện của cafe: nhận **404**.
3. Tắt endpoint cafe 2 phút rồi bật lại. Service cafe chạy `hub.poll({status:'failed'})` và lấy lại đủ sự kiện bị lỡ.
4. Revoke một key: chỉ đúng service đó bị ngắt.
5. Thêm "AB Bank" bằng GenericAdapter trong 2 phút. Chế độ lắng nghe báo ❌ "chờ `x-signature`, thấy `x-sig`". Sửa cấu hình xong thì ✅.
6. **Vào nhiều kiểu, ra một kiểu.** Chiếu song song ba payload gốc (PayOS, SePay, AB Bank), mỗi cái một kiểu, rồi chiếu ba body Shop nhận được: **cùng một hình dạng** `payment.received`. Mở `apps/shop/src/main.ts` cho hội đồng thấy chỉ có **một** hàm xử lý thanh toán, không có `if` theo provider. Đây là câu trả lời cho câu hỏi "sao không tự viết module nhận webhook trong service".

---

## 8. Rủi ro đã biết, phiên dev phải xử lý hoặc ghi ADR

1. `DeliveryMessage` mang `signingSecret` dạng **rõ** đi qua RabbitMQ (có từ trước). Không sửa trong đợt này, nhưng ghi ADR "hướng phát triển: worker tự nạp secret theo destinationId".
2. Challenge chạy đồng bộ trong hub-api, nên hub-api phải gọi HTTP ra ngoài. Bắt buộc dùng SSRF guard và timeout 10s. Không vi phạm BB-4: worker vẫn là nơi gửi sự kiện.
3. `db push --accept-data-loss`: thêm `@@unique` hoặc khoá ngoại ghép trên dữ liệu bẩn có thể làm push xoá dữ liệu. Chạy thử trên bản sao trước. Nên tính chuyển sang `prisma migrate deploy` (ghi ADR nếu làm).
4. Cửa sổ lắng 2s chưa an toàn tuyệt đối nếu transaction normalize kéo dài hơn 2s. Ghi nhận trong ADR.
5. Long-poll giữ kết nối HTTP. Trên Render free có giới hạn kết nối, nên trần `wait=20`.

---

## 9. Checklist tiến độ (phiên DEV đánh dấu)

- [ ] S0 · [ ] S1 · [ ] S2 · [ ] S3 · [ ] S4 · [ ] S5 · [ ] S6 · [ ] S7 · [ ] S8 · [ ] S9 · [ ] S10 · [ ] S11 · [ ] S12 · [ ] S14 (làm trước S11) · [ ] S13 (tuỳ chọn)
- ADR mới đã ghi: …
- Lệch so với spec (nếu có, kèm lý do): …

## 10. Kết quả test (phiên TEST điền)

| Kịch bản | PASS/FAIL | Ghi chú / output | Ngày |
|---|---|---|---|
| U1–U33 | | | |
| U34–U50 (S14) | | | |
| T1 | | | |
| T2 | | | |
| T3 | | | |
| T4 | | | |
| T5 | | | |
| T6 | | | |
| T7 | | | |
| T8 | | | |
| T9 | | | |
| T10 | | bảng số p50/p95 | |
| T11 | | | |
| T12 | | | |
| T13 | | | |
| T14 | | | |
| T15 (S14) | | | |
| Demo 7.3 | | | |
