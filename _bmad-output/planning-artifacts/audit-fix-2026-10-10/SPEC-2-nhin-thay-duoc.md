# SPEC-2 — Nhìn thấy được

> Đợt 2/3. Cần SPEC-1 đã xong, vì định dạng message gọn của S1-1 và outbox `delivery.requested` của S1-2.
> **Mục tiêu demo:**
> 1. Tắt đích Discord mock → dashboard chuyển đích sang **OPEN**, màu đỏ, theo thời gian thực.
> 2. Hết 60s → **HALF_OPEN** → một lần thử → **CLOSED**.
> 3. Mở một sự kiện thấy dòng thời gian ① nhận → ⑥ toả ra N đích, kèm từng lần thử.
> 4. Replay 20 delivery DEAD bằng một nút, có lý do, có audit.

---

## S2-1 · Circuit breaker thật: HALF_OPEN, ghi DB, phát sự kiện

**BB09:** câu 5. Hiện trạng ở `apps/hub-worker/src/circuit/circuit-breaker.service.ts`:
- **Không có HALF_OPEN.** Khi khoá `:state` hết hạn thì mọi message đều được gửi.
- **Bộ đếm lỗi không bao giờ reset** khi circuit hết OPEN.
- **Không ai ghi `destinations.circuit_state`**, nên dashboard luôn hiện CLOSED.
- Khi OPEN, message bị đẩy vào **hàng đợi 2h** dù circuit chỉ mở 60s (`delivery.consumer.ts:23,91`).
- `hub:alerts` không có ai nghe.

**Thiết kế (khoá Redis theo `circuit:{destId}`):**

| Khoá | Ý nghĩa |
|---|---|
| `:failures` | INCR, **EX 120** (lỗi cách nhau hơn 2 phút thì không tính là "liên tiếp") |
| `:open` | `SET … 'OPEN' EX 60`. Còn khoá = OPEN |
| `:probe` | `SET … NX EX 30`. Worker nào giành được thì là người gửi thử duy nhất |

- **`getState()` dùng một lệnh `MGET :open :failures`**:
  - có `:open` → `OPEN`;
  - không có `:open` và `failures ≥ 5` → `HALF_OPEN`;
  - còn lại → `CLOSED`.
- **Luồng trong `delivery.consumer.ts`:**
  - `OPEN` → `sendToQueue` vào **tầng retry ngắn nhất có TTL ≥ thời gian OPEN còn lại**. Viết hàm `retryQueueForDelay(ms)` trong `libs/messaging` và tính từ `RETRY_TIERS`; với 60s thì ra `q.delivery.retry.1m`. **Không tăng `attemptCount`**: đây là hoãn gửi, không phải một lần thử.
  - `HALF_OPEN`:
    - `SET :probe NX EX 30`. Giành được → gửi thử.
    - Không giành được → xử lý như OPEN (hàng đợi 1m).
  - Gửi thành công:
    - `failures > 0` hoặc đang HALF_OPEN → `DEL :failures :open :probe`, tức là **một lệnh DEL nhiều khoá**, rồi chuyển sang CLOSED.
    - `failures == 0` → **không gọi Redis gì cả**. Điểm này quan trọng cho ngân sách S3-5.
  - Gửi thất bại:
    - `INCR :failures` (+ `EXPIRE` lần đầu).
    - Đạt 5, hoặc đang ở HALF_OPEN → `SET :open OPEN EX 60` và `DEL :probe`, chuyển sang OPEN.
- **Chỉ khi trạng thái đổi** thì:
  - (a) ghi `destinations.circuit_state` qua `repo.updateDestinationCircuitState(destId, state)` (đã scope tenant; `CircuitState` enum đã có `HALF_OPEN`);
  - (b) `PUBLISH hub:realtime:circuit {tenantId, destinationId, from, to, failures, at}`.
- Bỏ kênh `hub:alerts`. Thay bằng kênh trên, có `tenantId` (ADR-035).
- Redis chết thì vẫn **fail-open** như cũ, đúng ARCHITECTURE §5.4.

**ADR:** "Circuit breaker 3 trạng thái với probe `SET NX`; DB `circuit_state` chỉ để hiển thị, Redis là nguồn chạy". Đánh đổi: HALF_OPEN là trạng thái suy ra, không lưu.

**Test** (`apps/hub-worker/test/circuit-breaker.spec.ts`, dùng `ioredis-mock` hoặc Redis giả trong bộ nhớ):
- 5 lần lỗi → OPEN, và có đúng **một** lần publish.
- Khi OPEN, consumer không gọi sender; message vào `q.delivery.retry.1m` và `attemptCount` giữ nguyên.
- Hết TTL `:open` → HALF_OPEN. Hai worker cùng lúc: chỉ một worker giành được probe.
- Probe thành công → CLOSED, các khoá bị xoá.
- Probe thất bại → OPEN lại.
- Gửi thành công khi `failures == 0` → 0 lệnh ghi Redis.

**Cách kiểm (docker):**
- Thêm `GET|POST /mock/fail?status=500` vào `apps/hub-api/src/modules/mock`. Endpoint này luôn trả mã HTTP được yêu cầu.
- Tạo đích webhook trỏ tới `http://hub-api:4000/mock/fail?status=500`, subscription `repo.push`, rồi bắn 7 webhook GitHub.

```bash
docker exec webhook-hub-postgres psql -U hub_user -d webhook_hub -c "select name, circuit_state from hub.destinations;"
# kỳ vọng: đích mock-fail = OPEN; message 6–7 có 0 attempt mới trong lúc OPEN
# đổi đích sang /mock/discord (PATCH destination), đợi ~70s: HALF_OPEN -> CLOSED
```

---

## S2-2 · Realtime đủ dữ liệu để vẽ đường đi của một webhook

**BB09:** câu 7 ("backend chỉ phát 2 loại tin"). JWT và room đã xong (ADR-035), **giữ nguyên**.

**Nguyên tắc (Winston):** chặng nào chạy **trong hub-api** thì emit **thẳng vào Socket.IO trong cùng tiến trình**, không qua Redis, nên tốn **0 lệnh Redis**. Chỉ chặng ở worker mới cần pub/sub.

**Đánh đổi (ghi ADR):** nếu chạy nhiều instance hub-api, client nối vào instance B sẽ không thấy `trace.ingested` của instance A. Chấp nhận được: dữ liệu chi tiết vẫn lấy từ `GET /events/:id`, socket chỉ để cập nhật trực tiếp.

| Sự kiện Socket.IO | Phát từ | Payload | Đường đi |
|---|---|---|---|
| `trace.ingested` | `ingest.service.ts`, sau khi trả kết quả. Gộp ①–④: nhận, verify, COMMIT, ACK | `{correlationId, provider, sourceKey, httpStatus, outcome: 'ACCEPTED'\|'REJECTED'\|'DUPLICATE'\|'RATE_LIMITED', rawEventId?, ms}` | In-process: inject `RealtimeGateway` (hoặc interface `RealtimeNotifier` theo ADR-021) vào `IngestService` |
| `event.received` (sửa) | normalize | Thêm `correlationId`, `deliveries: [{deliveryId, destinationId, destinationName, destinationType}]` | Redis `hub:realtime:events`. **Một** publish cho mỗi raw event (gộp mảng), không phải mỗi event |
| `delivery.attempt` (thay `delivery.updated`) | delivery consumer | `{correlationId, eventId, deliveryId, destinationId, attemptNo, generation, status: 'SUCCEEDED'\|'RETRYING'\|'DEAD'\|'DEFERRED', httpStatus, ms, nextQueue?, nextAttemptAt?}` | Redis `hub:realtime:deliveries`. `DEFERRED` = bị circuit hoãn, **không publish** để tiết kiệm Redis |
| `circuit.changed` | circuit breaker (S2-1) | `{destinationId, from, to, failures, at}` | Redis `hub:realtime:circuit` |

- Chỉ phát `trace.ingested` khi **biết tenant**, tức là source tồn tại. Source key không tồn tại (404) thì không phát gì.
- Gateway subscribe thêm `hub:realtime:circuit`. Mọi emit vẫn qua `server.to('tenant:'+id)`.
- Ghi `nextAttemptAt` vào `deliveries.next_attempt_at` khi RETRYING (cột đã có, hiện không ai ghi). Tính bằng `now + TTL tầng kế`.
- `metrics.tick`: khi `done == 0` thì `successRate = null`; UI hiện "—", không hiện 100%.
- Đổi tên `delivery.updated` thành `delivery.attempt` ở cả `apps/web/src/lib/hub/socket.ts` và mọi chỗ nghe.

**ADR:** "Trace in-process ở hub-api, chỉ pub/sub ở worker; gộp chặng để giữ ngân sách Redis".

**Test:**
- Mở rộng `realtime-auth.spec.ts`: tin trên `hub:realtime:circuit` có tenantId thì chỉ tới room của tenant đó; thiếu tenantId thì bị bỏ.
- Unit test ingest: mỗi request gọi notifier đúng một lần với `outcome` đúng (ACCEPTED, REJECTED, DUPLICATE).
- Unit test gateway: `successRate` là `null` khi `done = 0`.

---

## S2-3 · Audit log + replay hàng loạt

**BB09:** câu 6 ("Replay hàng loạt: không có… Audit log: 0 chỗ trong code ghi vào").
Replay đơn đã đúng transaction (ADR-031). **Giữ nguyên**, chỉ thêm audit.

**Làm:**
1. `TenantScopedRepository`:
   - `createAuditLog({action, entityType, entityId, actor, reason, metadata})`;
   - `findAuditLogs({limit, before?})`.
2. Lấy `actor` từ JWT `sub`: thêm decorator `@CurrentUser()` cạnh `@CurrentTenant()`.
3. `POST /api/v1/deliveries/:id/replay`:
   - Body có thêm `{ reason?: string }`.
   - Ghi `audit_logs` (`action='delivery.replay'`) **trong cùng transaction** với delivery mới và outbox.
4. `POST /api/v1/deliveries/replay-bulk`:
   - Body: `{ destinationId?, from?, to?, errorContains?, reason (bắt buộc, ≥ 5 ký tự), dryRun?: boolean }`.
   - Chọn các delivery **DEAD, generation mới nhất, chưa bị replay**. Dùng lại đúng điều kiện của ADR-031 / `findDeadDeliveries`, không viết lại điều kiện.
   - Giới hạn 500 dòng.
   - `dryRun=true` → trả `{ count, sample: 10 dòng đầu }` và **không ghi gì**.
   - Chạy thật → **một transaction** gồm N delivery mới + N outbox `delivery.replayed` (message gọn của S1-1) + **một** audit log `action='delivery.replay_bulk'`, `metadata={filter, count, deliveryIds}`.
   - Trả `{ count, generation… }`.
5. Các hành động khác cũng ghi audit:
   - tạo, sửa, xoá source, destination, subscription;
   - `renormalize` (S1-3).
6. `GET /api/v1/audit-logs?limit=50&before=<id>`.
7. **ADR:** "Audit log ghi cùng transaction với hành động; bulk replay ≤ 500 dòng, bắt buộc lý do, có dryRun".

**Test:**
- Bulk replay `dryRun` không ghi gì.
- Chạy thật tạo đủ N delivery, N outbox và 1 audit trong cùng một transaction: mock lỗi giữa chừng thì không còn dòng nào.
- Replay một delivery đã được replay → bị loại khỏi tập chọn.

---

## S2-4 · Playground gửi được PayOS ký đúng

**BB09:** công cụ test ("Không có nút cho PayOS"). Hiện tại `playground/_components/build-request.ts:62` gửi chữ ký giả, và `page.tsx:142` ẩn ô nhập secret cho PayOS.

**Làm:**
1. `build-request.ts`, case `payos`: nếu có secret (checksum key) thì ký theo đúng thuật toán PayOS:
   - sắp khoá của `data` theo alphabet;
   - nối `key=value` bằng `&`, với `null`/`undefined` thành chuỗi rỗng;
   - lấy HMAC-SHA256 hex.
   Đặt chữ ký vào `body.signature`, dựng lại body sau khi ký.
2. `page.tsx`: hiện ô secret cho PayOS, nhãn "Checksum key".
3. **Test chéo với SDK** (`apps/hub-api/test` hoặc `libs/providers/test`):
   - Chữ ký do hàm của Playground tạo ra phải bằng `payos.crypto.createSignatureFromObj(data, key)` của `@payos/node`.
   - Muốn test được thì tách hàm ký sang `apps/web/src/lib/hub/payos-sign.ts`: thuần, không phụ thuộc DOM, dùng WebCrypto.

**Cách kiểm:** Playground → PayOS → nhập checksum key trong `.env` → Gửi → nhận **200**. Gửi lại đúng body đó → **200 duplicate**.

---

## S2-5 · Dashboard vẽ dữ liệu thật

**Sally:** "Dashboard đẹp mà cột Circuit luôn xanh là bằng chứng chống lại mình."
Dùng component shadcn đã có, giữ phong cách Studio Admin. **Không** thêm thư viện mới.

| Màn | File | Sửa |
|---|---|---|
| Destinations | `dashboard/destinations/page.tsx` | Badge `CLOSED`/`HALF_OPEN`/`OPEN` (xanh/vàng/đỏ) đọc từ API, **cập nhật live** khi nghe `circuit.changed` (invalidate query hoặc set cache) |
| Deliveries | `dashboard/deliveries/_components/*` | Cột "Lần thử", "HTTP", "ms", "Thử lại lúc" (đếm ngược từ `nextAttemptAt`). Live theo `delivery.attempt` |
| Event detail | `dashboard/events/_components/event-sheet.tsx` | Thêm tab/khối **"Dấu vết"**: dòng thời gian dọc ① nhận (raw_event.receivedAt, signature_valid) → ② commit → ③ normalize (event.receivedAt) → toả N nhánh, mỗi nhánh một đích với danh sách attempts (attemptNo, HTTP, ms, error). Dữ liệu từ `GET /api/v1/events/:id` (đã có rawEvent, deliveries, attempts). Live: nghe `delivery.attempt` có cùng `eventId` thì refetch |
| Events list | `dashboard/events/page.tsx` | Toast nhỏ hoặc dòng "mới" khi nghe `trace.ingested` có outcome REJECTED/DUPLICATE, để demo được "chữ ký sai bị chặn" |
| DLQ | `dashboard/dlq/page.tsx` | Nút **"Replay hàng loạt"**: dialog lọc (đích, khoảng thời gian, chứa lỗi), ô lý do bắt buộc, nút "Xem trước" gọi `dryRun` hiện số lượng, rồi nút "Replay N delivery". Replay đơn cũng hỏi lý do (không bắt buộc) |
| Audit | `dashboard/audit/page.tsx` (**mới**) + mục sidebar | Bảng thời gian, actor, action, entity, lý do. Phân trang `before` |
| Overview | `_components/realtime-card.tsx` | `successRate == null` hiện "—" |

Thêm query và type tương ứng trong `apps/web/src/lib/hub/{queries,types,socket}.ts`.

**Cách kiểm:** chạy kịch bản demo ở đầu file, **quay GIF** (`demo-circuit.gif`), đặt trong `_bmad-output/planning-artifacts/audit-fix-2026-10-10/`.

---

## Lệch khi làm

*(phiên dev ghi vào đây)*

### Phiên dev 10/10 (Amelia)

1. **ADR:** dùng **ADR-048** (S2-1 + sweeper RETRYING + lease/shutdown theo review SPEC-1), **ADR-049** (S2-2), **ADR-050** (S2-3). S2-4 không cần ADR.
2. **S2-1, phát hiện trạng thái "tự đổi":** `:open` hết hạn không sinh sự kiện nào. Vì vậy consumer so trạng thái Redis suy ra với cột `circuit_state` đọc kèm delivery (`syncObserved`) rồi ghi DB + publish khi khác. Hệ quả: nếu không có message nào tới thì dashboard vẫn hiện OPEN dù Redis đã HALF_OPEN.
3. **S2-1, TTL `:failures`:** spec ghi "EX 120 lần đầu". Nếu chỉ vậy thì bộ đếm có thể hết hạn trước `:open`, và circuit nhảy thẳng về CLOSED mà không probe. Lúc OPEN, tôi gia hạn `:failures` thêm 180s (cùng MULTI với `SET :open`).
4. **S2-1, 4xx:** lỗi non-retryable (404…) cũng được tính vào circuit. Khi kiểm, 5 lần 404 làm circuit OPEN, nên replay sau đó phải đợi một chu kỳ probe.
5. **S2-1, probe và lease:** giành được probe mà claim thua hoặc gặp processed hit thì `DEL :probe` ngay, không đợi 30s.
6. **Phần mở rộng theo điều phối (review SPEC-1):**
   - (a) sweeper quét RETRYING có `next_attempt_at < now − 5 phút` (`DELIVERY_RETRY_SWEEP_GRACE_MS`), `attemptCount` lấy từ DB;
   - (b) hoãn vì circuit ghi `next_attempt_at`, và PENDING có `next_attempt_at` mới thì không bị quét;
   - (c) claim thua mà lease DELIVERING còn hạn cho đúng lần gửi thì hoãn vào 1m thay vì ack bỏ;
   - (d) graceful shutdown huỷ consume, chờ handler (`InFlightTracker`) rồi mới đóng channel.

   Mục (d) làm lộ một lỗi có từ trước: entrypoint chạy `exec npm run start`, nên SIGTERM giết sh/node trước khi handler kịp chạy. Graceful shutdown chưa từng chạy trong container. Tôi sửa **riêng worker** thành `exec node dist/...`; trên docker đã thấy log `idle:true … Graceful shutdown hoàn tất`. hub-api, shop và web vẫn chạy qua `npm run`.
7. **Hoãn vì throttle** không ghi `next_attempt_at`, để không ghi DB cho mỗi message. Throttle kéo dài quá 5 phút thì sweeper có thể sinh bản sao; lease chặn được việc gửi trùng.
8. **Khoá Redis kiểu cũ:** code cũ để lại `circuit:*:state` và `circuit:*:failures` **không TTL**. Một khoá `failures=5` không TTL sẽ làm đích đó bị suy ra HALF_OPEN mãi. Tôi đã xoá các khoá này trên Redis local (Redis được phép mất, BB-2). **Khi deploy lên Upstash cần xoá tương tự** (`circuit:*:state`, và `circuit:*:failures` có TTL = −1).
9. **S2-2:** `trace.ingested` có thêm outcome `ERROR` (500 lúc COMMIT), vì spec không liệt kê trường hợp này. `event.received` đổi hình dạng thành `{tenantId, correlationId, rawEventId, events[], deliveries[]}`. Web chỉ dùng tin này để invalidate, nên không vỡ gì. `/overview.successRate` cũng thành `null` khi 0 delivery.
10. **S2-3:**
    - API trước đây chỉ có POST tạo, nên tôi thêm `PATCH/DELETE /destinations/:id`, `PATCH/DELETE /subscriptions/:id` và `PATCH /sources/:id`. **Không xoá source**, vì xoá sẽ cascade mất `raw_events`.
    - Xoá đích sẽ cascade mất subscription và delivery của đích đó; audit giữ tên.
    - `POST /sources` không còn trả mảng `secrets` (ciphertext), chỉ trả `secretVersions`.
    - Bulk dùng `createMany` cho delivery và outbox, transaction timeout 30s.
11. **S2-4:** ngoài ô nhập, Playground còn **ghi body đã ký trở lại ô nhập**, để "Gửi lại" gửi đúng byte cũ và ra 200 duplicate.
12. **S2-5 (fork UI):**
    - Badge 3 màu đã có sẵn từ trước; tôi thêm phần cập nhật live, chấm màu và tooltip.
    - "Dấu vết" thay danh sách deliveries cũ trong sheet, không làm tab riêng. Bước ② không có mốc giờ riêng vì API không trả thời điểm COMMIT.
    - Toast REJECTED/DUPLICATE chỉ hiện khi đang mở trang Sự kiện.
13. **Chưa kiểm bằng mắt / chưa quay GIF:** Chrome extension đang nối với hai máy Linux/macOS, không truy cập được `localhost:3000` của máy Windows này. Mọi trang trả HTTP 200 và bundle có code mới, nhưng chưa ai nhìn UI. `demo-circuit.gif` **chưa có**.
14. **Telegram thật:** đích seed "Telegram Ops Group" gửi Telegram **thật**. Smoke (2 lần) và một lần gửi PayOS thử đã gửi tin thật. Tôi không bấm Gửi PayOS trong trình duyệt nữa.
15. **Dữ liệu kiểm:** đích `S2 mock-fail` và subscription `S2 circuit` đã xoá qua API (có audit; delivery của chúng cascade theo). Còn lại các event `repo.s2circuit`/`repo.push`/`payment.succeeded` của phiên kiểm, các dòng `audit_logs` id 3–11 (actor `dev-amelia`), và một PayOS raw/event thử (orderCode theo timestamp).
16. **Kết thúc dòng:** script Python ghi file bằng text mode trên Windows đã đổi một số file sang CRLF. Tôi đã chuyển mọi file TS đang thay đổi về LF, gồm cả các file vốn là CRLF do `core.autocrlf=true`. Nội dung không đổi khi commit.

### Sửa sau review

Review đối kháng SPEC-2 để lại 10 điểm. Ghi chung ở **ADR-054** (ADR-053 đã được phiên SPEC-3 dùng cho catalog kiểu chuẩn).

1. **(Cao) Xoá làm mất lịch sử gửi.** `DELETE /subscriptions/:id` trả 409 kèm `deliveryCount` nếu còn delivery nào; thông báo hướng dẫn tắt (`isActive=false`). `DELETE /destinations/:id` chỉ xoá được khi không còn subscription (409 kèm `subscriptionCount` + `deliveryCount`). Migration `20261010020000_restrict_delivery_history_fk` đổi hai FK sang `ON DELETE RESTRICT` (`prisma migrate deploy`, không reset; `migrate diff` sau đó rỗng). Race giữa bước đếm và DELETE → P2003 → 409. `deliveries.event_id` vẫn CASCADE (retention). UI: cột thao tác Tắt/Bật + Xoá ở Subscriptions, Xoá ở Đích; 409 hiện toast dễ hiểu, toast subscription có nút "Tắt". **Hệ quả:** đích đã từng được dùng gần như không xoá được nữa — chủ ý. Điều này thay mục 10 phần "xoá đích cascade" ở trên.
2. **`dryRun` phải là boolean.** Chọn: thiếu → 400 (không đoán mặc định), sai kiểu → 400. Validate cùng chỗ `from`/`to` (chuỗi ISO 8601, `from ≤ to`), `destinationId` (UUID), `errorContains` (chuỗi).
3. **Circuit chỉ tính lỗi phía đích:** 5xx, 408, 429, không có phản hồi (sender trả 500 khi lỗi mạng/timeout). 4xx khác vẫn DEAD nhưng không chạm circuit — thay mục 4 ở trên. **Probe HALF_OPEN nhận 4xx:** nhả probe, giữ HALF_OPEN (4xx không chứng minh đích sống hay chết; lần gửi kế tiếp được thử ngay thay vì đợi TTL probe 30s).
4. **Trần hoãn vì circuit:** header `x-circuit-deferrals` +1 mỗi lần hoãn; quá `CIRCUIT_MAX_DEFERRALS` (mặc định 30) → ghi một attempt thất bại (`response_status` NULL, error "circuit … quá lâu"), qua `processed_messages` + lease như lần gửi thường, đi tầng retry kế theo `attemptCount`, `next_attempt_at` = TTL tầng đó; header về 0 ở lần thử mới. Không gọi `recordFailure` (không có bằng chứng mới về đích).
5. **Hồi quy 64KB:** bỏ `maxContentLength`. Sender đọc phản hồi `responseType: 'stream'`, `validateStatus: () => true`, giữ ≤ 64KB rồi huỷ stream; status từ dòng trạng thái. Giữ `maxBodyLength` 64KB cho body gửi. Test server cục bộ thật trả 200 + 200KB → status 200, đúng 1 request (`sender-large-response.spec.ts`).
6. **Circuit Lua:** `LUA_ACQUIRE_PROBE` (SET NX chỉ khi `:open` vắng và failures ≥ 5, token ngẫu nhiên), `LUA_RELEASE_PROBE` (DEL chỉ khi đúng token), `LUA_INCR_EXPIRE` (dùng cả cho throttle → bớt 1 lệnh Redis/lần lỗi). Thành công sau lỗi luôn chạy UPDATE có điều kiện `circuit_state <> 'CLOSED'`. `ioredis-mock` không có trong repo → Redis giả trong test mô phỏng ngữ nghĩa, còn script THẬT chạy trên Redis docker khi `RUN_DB_TESTS=1`.
7. **`/mock/*`** chỉ đăng ký khi `NODE_ENV !== 'production'` (`hubApiControllers()`); mock Telegram log token dạng `123456:***`.
8. **UI:** mốc toast của TraceFeed nằm trong store realtime (mount lại không toast lại); bị dội → tối đa 1 toast/2s kèm "+N". Mọi mutation có audit đi qua `invalidateAudited()` (luôn thêm `["audit"]`), có test quét `queries.ts`. `RetryCountdown` tự `clearInterval` khi về 0. Logic thuần nằm ở `apps/web/src/lib/hub/ui-logic.ts`; test chạy bằng jest gốc của repo (web không có runner riêng; `*.spec.ts` bị loại khỏi tsconfig của web).
9. **Audit gom nhóm:** `delivery.replay_bulk` → `entityType=delivery_batch`, `entityId` = UUID lô (`batchId` trong response), danh sách id ở metadata. `raw_event.renormalize` nhiều dòng → `raw_event_batch` + UUID. Comment `/mock/fail` sửa thành 200–599 cho khớp code.
10. **Delivery `1d9f344c…`:** xem kết quả kiểm ở báo cáo phiên (RETRYING, attempt 5 lúc 02:59:57 UTC, message nằm trong `q.delivery.retry.2h`).

**Dữ liệu kiểm thêm:** đích `circuit-check-<ts>` (đã trỏ về `/mock/discord`) và subscription cùng tên (đã **tắt** — không xoá được vì có 12 delivery, đúng thiết kế mới), 6 delivery DEAD 400 + 6 delivery 500 của kịch bản circuit. Đích Telegram được tạm chuyển sang mock trong lúc smoke/kiểm rồi trả về env chuẩn.

