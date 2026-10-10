# SPEC-1 — Không mất, không lộ

> Đợt 1/3. Đọc [`README.md`](README.md) trước.
> Mục tiêu demo: tắt worker giữa chừng, bật lại → không delivery nào treo. Grep `outbox`, RabbitMQ, log → không thấy bot token hay signing secret.

---

## S1-1 · Message delivery chỉ mang tham chiếu, không mang secret

**BB09:** câu 3 ("Secret đã giải mã nằm nguyên văn trong message RabbitMQ") và câu 6 ("Payload outbox chứa cấu hình đích và signing secret đã giải mã").
**Hiện trạng:**
- `normalize.consumer.ts:124-153` giải mã `configEncrypted` và `signingSecretEncrypted`, rồi nhét vào `DeliveryMessage`.
- `api.controller.ts:203-257` (replay) ghi chúng vào `hub.outbox.payload`, tức là **nằm trong Postgres**.
- Cả hai còn nằm lại trong hàng đợi retry và DLQ.

**Làm:**
1. `libs/common/src/types.ts`: `DeliveryMessage` chỉ còn các trường `{ deliveryId, tenantId, attemptGeneration, attemptCount, correlationId }`.
   - Bỏ `config`, `signingSecret`, `event`, `destinationType`, `destinationId`, `subscriptionId`, `rateLimitRps`.
2. `delivery.consumer.ts`: đầu `handleMessage`, nạp qua `repo` (đã scope tenant) **một truy vấn** `findDeliveryForSend(deliveryId)`. Truy vấn này lấy delivery, event, subscription và destination.
   - Giải mã config và signing secret **ngay trong worker, lúc gửi**.
   - Không tìm thấy (đã bị xoá) thì `ack` và log warn.
3. Thêm `findDeliveryForSend` vào `TenantScopedRepository`, với `where: { id, tenantId }`.
4. `normalize.consumer.ts` và replay ở `api.controller.ts` chỉ còn dựng message gọn ở trên. Xoá mọi `aesGcmDecrypt` khỏi hai chỗ này.
5. **Tương thích ngược:** message cũ còn nằm trong hàng đợi retry vẫn có `deliveryId`, `tenantId`, `attemptCount`, `attemptGeneration`. Worker chỉ đọc 4 trường đó và **bỏ qua** phần còn lại. Không cần xoá hàng đợi.
6. **Dọn dữ liệu cũ:** viết SQL một lần (đặt trong migration ở S1-6, hoặc script `scripts/scrub-outbox-secrets.sql`):
   ```sql
   UPDATE hub.outbox SET payload = payload - 'config' - 'signingSecret' - 'event'
   WHERE topic = 'delivery.replayed';
   ```
7. `delivery_attempts.request_body` hiện lưu `{content, event}`, tức là không lưu secret. Giữ nguyên.

**Lợi ích phụ (ghi vào ADR):** sửa cấu hình đích (URL, token) thì có hiệu lực ngay cho cả message đang chờ retry.
**ADR:** "Message delivery chỉ mang tham chiếu; worker giải mã cấu hình đích lúc gửi". Đánh đổi: thêm 1 truy vấn DB mỗi lần gửi.

**Test:**
- Unit test: message dựng bởi normalize và replay **không** chứa các khoá `config`, `signingSecret`, `event`.
- Unit test: worker nhận message kiểu cũ (có `config` giả) thì vẫn gửi bằng config đọc từ DB.

**Cách kiểm (docker):**
```bash
# sau khi bắn 1 webhook SePay + replay 1 delivery DEAD
docker exec webhook-hub-postgres psql -U hub_user -d webhook_hub -c \
 "select count(*) from hub.outbox where payload::text ~* 'signingSecret|botToken|webhookUrl|\"config\"';"   # = 0
curl -s -u hub_admin:hub_secret -X POST localhost:15672/api/queues/%2F/q.delivery.retry.10s/get \
 -H 'content-type: application/json' -d '{"count":5,"ackmode":"ack_requeue_true","encoding":"auto"}' | grep -c signingSecret  # = 0
```

---

## S1-2 · Normalize → delivery đi qua outbox, có sweeper và lease

**BB09:** câu 4 ("Ghi đôi ở normalize → delivery… delivery nằm PENDING mãi").
**Hiện trạng:** `normalize.consumer.ts:166-177` gọi `channel.publish` sau COMMIT, trên kênh không confirm.

**Làm:**
1. Trong **cùng transaction** ở `normalize.consumer.ts`, mỗi delivery tạo ra phải có thêm một dòng outbox:
   - `tx.outbox.create({ data: { topic: 'delivery.requested', payload: <DeliveryMessage gọn của S1-1> } })`.
   - Xoá vòng `channel.publish` (dòng 166-177).
2. `outbox.relay.ts:94-96`: định tuyến theo topic.
   - `delivery.requested` và `delivery.replayed` → `EXCHANGES.DELIVERY` / `ROUTING_KEYS.DELIVER`.
   - Các topic còn lại → `EVENTS`.
   - Viết dạng map `TOPIC_ROUTES`, không thêm `if` thứ ba.
3. **Lease khi bắt đầu gửi** (chống gửi trùng khi sweeper và message gốc cùng tới). Trong `delivery.consumer.ts`, trước `sender.send`, thay `updateDeliveryStatus(DELIVERING)` bằng **cập nhật có điều kiện**:
   ```
   UPDATE deliveries SET status='DELIVERING', updated_at=now()
   WHERE id=$1 AND tenant_id=$2 AND attempt_generation=$gen AND attempt_count=$msg.attemptCount
     AND (status IN ('PENDING','RETRYING') OR (status='DELIVERING' AND updated_at < now() - interval '60 seconds'))
   ```
   - Thực hiện qua phương thức repo `claimForSend`, có trả về `count`.
   - `count = 0` thì `ack` và log `debug` "đã có worker khác nhận".
   - Lease 60s phải lớn hơn timeout gửi (5s) cộng thời gian ghi DB.
4. **Sweeper** chạy cùng `OutboxRelay`, mỗi 60s, có jitter:
   - Tìm delivery `PENDING` có `created_at < now() - DELIVERY_SWEEP_AFTER_MS` (mặc định 10 phút), **không có attempt nào**, và **không có dòng outbox chưa publish** nào trỏ tới nó.
   - Dùng `FOR UPDATE SKIP LOCKED`, `LIMIT 100`.
   - Với mỗi dòng tìm được, ghi lại một outbox `delivery.requested`.
   - Mỗi lần chạy có dòng nào thì log warn kèm số lượng.
   - Sweeper chạy xuyên tenant, vì là hạ tầng giống relay. Truy vấn raw là được, nhưng **chỉ ghi outbox, không đọc dữ liệu nghiệp vụ ra ngoài**. Ghi chú lý do ngay trong code.
5. **ADR:** "Mọi chặng đều qua outbox; sweeper và lease thay cho phép màu". Đánh đổi: thêm độ trễ relay khoảng 500ms ở chặng thứ hai.

**Test:**
- Unit test normalize: sau transaction thì có N dòng outbox `delivery.requested` và **không có lời gọi `channel.publish`**.
- Unit/DB test lease: hai lần `claimForSend` liên tiếp cùng tham số thì lần 2 trả `count=0`.
- DB test sweeper (`RUN_DB_TESTS=1`): delivery PENDING 11 phút không có attempt thì được ghi outbox. Delivery đã có outbox chưa publish thì không.

**Cách kiểm (docker):**
```bash
docker compose stop hub-worker
# bắn 1 webhook SePay (lệnh ở S1-8), đợi 2s
docker compose start hub-worker
# kỳ vọng: delivery SUCCEEDED, không dòng nào PENDING quá 1 phút
docker exec webhook-hub-postgres psql -U hub_user -d webhook_hub -c \
 "select status,count(*) from hub.deliveries group by 1; select topic,count(*) filter (where published_at is null) pending from hub.outbox group by 1;"
```

---

## S1-3 · Lỗi normalize: lỗi tạm thì thử lại, lỗi dữ liệu mới vào DLQ; phát lại được

**BB09:** câu 4 ("Postgres chập chờn 1 giây là sự kiện vào `q.normalize.dlq`, và không có công cụ phát lại").

**Làm:**
1. Trong `libs/messaging/topology.ts` (**chỉ được khai báo ở đây**), thêm queue `q.normalize.retry.30s`:
   - `x-message-ttl: 30000`;
   - dead-letter về exchange và routing key mà `q.normalize` đang nghe.
   - **Không đổi tham số của queue đang có** (cạm bẫy số 3 trong CLAUDE.md).
2. `normalize.consumer.ts`, nhánh `catch`, phân loại lỗi:
   - **Lỗi tạm:** `Prisma.PrismaClientKnownRequestError` có mã `P1001`, `P1002`, `P1008`, `P1017`, `P2024`, `P2034`; `PrismaClientInitializationError`; lỗi mạng (`ECONNRESET`, `ETIMEDOUT`). Đọc header `x-normalize-retry`, mặc định 0.
     - Nếu < 5 thì `sendToQueue('q.normalize.retry.30s', content, { headers: {..., 'x-normalize-retry': n+1}, persistent:true })` rồi `ack`.
     - Nếu ≥ 5 thì `nack(false,false)` để vào DLQ.
   - **Lỗi dữ liệu** (adapter `normalize` ném lỗi, JSON hỏng, provider không có trong registry) → DLQ ngay như cũ.
   - Gom logic phân loại vào hàm thuần `classifyNormalizeError(err): 'transient' | 'permanent'` để test.
3. **Phát lại dựa trên Postgres, không đọc RabbitMQ.** Postgres là trọng tài; DLQ trong broker chỉ là bản sao.
   - `GET /api/v1/raw-events/orphans`: trả các `raw_events` có `status='ACCEPTED'`, **không có `events` nào** trỏ tới, và `received_at < now() - 2 phút`. Có scope tenant qua `source.tenantId`. Giới hạn 100 dòng, kèm tổng số.
   - `POST /api/v1/raw-events/renormalize { ids?: string[], reason: string }`: với mỗi raw event mồ côi (lọc lại ở server, scope tenant), ghi một outbox `event.received` có payload giống chặng ingest. Ghi `audit_logs` theo S2-3; nếu S2-3 chưa có thì để `TODO(S2-3)`.
     - Giới hạn 500 dòng mỗi lần.
     - `processed_messages(normalize, rawEventId)` không chặn, vì lần lỗi trước đã rollback.
   - Thêm 2 phương thức repo tương ứng (BB-5).
4. **UI** (`apps/web`, trang `dashboard/events`): một dải cảnh báo nhỏ "N sự kiện thô chưa được chuẩn hoá", có nút **"Chuẩn hoá lại"** và ô lý do. Ẩn khi N = 0. Dùng component shadcn sẵn có.
5. **ADR:** "Lỗi normalize phân loại tạm/vĩnh viễn; phát lại từ `raw_events`, không từ DLQ broker".

**Test:**
- Unit test `classifyNormalizeError` với từng mã lỗi.
- Unit test consumer: lỗi tạm thì đi vào `q.normalize.retry.30s` với header tăng dần; tới lần thứ 6 thì `nack` vào DLQ.

**Cách kiểm (docker):**
```bash
# Pause postgres không dùng được: relay cũng cần PG nên message không tới normalize.
# Dùng cờ tiêm lỗi CHỈ chạy khi NODE_ENV !== 'production':
#   NORMALIZE_FAULT_FIRST_N=2 -> 2 lần xử lý đầu ném PrismaClientKnownRequestError P1001 giả
# compose: hub-worker.environment có NORMALIZE_FAULT_FIRST_N=${NORMALIZE_FAULT_FIRST_N:-0}
NORMALIZE_FAULT_FIRST_N=2 docker compose up -d hub-worker
# bắn 1 webhook → kỳ vọng: log 2 lần 'x-normalize-retry', q.normalize.dlq không tăng, event được tạo sau ~60s
curl -s -u hub_admin:hub_secret localhost:15672/api/queues | jq -r '.[] | "\(.name) \(.messages)"' | grep normalize
```

---

## S1-4 · Worker sống sót khi mất RabbitMQ; có job dọn dẹp

**BB09:** câu 4 ("Worker không tự kết nối lại… Không có job dọn dẹp").

**Làm:**
1. `apps/hub-worker/src/main.ts`:
   - Lúc khởi động, kết nối AMQP **có thử lại**: 10 lần, backoff 1s→2s→4s… tối đa 30s. Hết số lần mới `process.exit(1)`.
   - Đăng ký `connection.on('error', log)`. Thêm `connection.on('close', …)`: log error, dừng relay, rồi `process.exit(1)` để orchestrator khởi động lại (compose dùng `restart: unless-stopped`, Render tự restart).
   - **Chọn cách boring:** không tự dựng lại channel trong cùng tiến trình. Ghi lý do vào ADR: dựng lại consumer, confirm channel và relay giữa chừng dễ sinh bug hơn là để tiến trình chết sạch rồi lên lại.
   - Các client Redis trong worker phải có `.on('error', …)` để không văng `Unhandled error event`.
2. **Job dọn dẹp** `apps/hub-worker/src/scheduler/cleanup.job.ts`:
   - Chạy mỗi giờ, có jitter.
   - Giành khoá `SET cleanup:lock <instanceId> NX EX 300` (đúng ARCHITECTURE: "Redis lock chỉ dùng cho job cleanup"). Không giành được thì bỏ qua lượt.
   - Xoá theo lô 5000 dòng tới khi hết:
     - `DELETE FROM hub.outbox WHERE published_at < now() - interval '7 days'`;
     - `DELETE FROM hub.processed_messages WHERE created_at < now() - interval '7 days'`.
   - **Ràng buộc an toàn:** 7 ngày > tổng thời gian retry (10s+1m+5m+30m+2h). Thêm hằng số kèm assert lúc load.
   - Ngưỡng đặt bằng env `CLEANUP_RETENTION_DAYS`, mặc định 7.
3. **Chặn phình dữ liệu từ request ký sai** (phát hiện 10/10 khi Admin hỏi về R2):
   - **Hiện trạng:** `ingest.service.ts:81-97` lưu **toàn bộ body** của mọi request ký sai vào `raw_events` với khoá `rejected_<correlationId>`, tức là không bao giờ trùng.
   - **Kịch bản tệ nhất:** kẻ tấn công biết một source key thì chỉ bị rate limit 100 req/phút chặn. Như vậy là 144k dòng/ngày; với body ~100KB là **~14GB/ngày**, trong khi Neon free chỉ có 0,5GB.
   - **Sửa:**
     - (a) Request REJECTED chỉ lưu `bodyRaw` và `body` **cắt còn 4KB đầu**, kèm `body_truncated` trong `headers` meta, hoặc một cột mới tạo qua migration.
     - (b) Cleanup xoá `raw_events` có `status='REJECTED'` và `received_at < now() - 7 ngày`.
     - (c) Rate limit riêng cho REJECTED: tối đa **20 bản ghi/phút/source**, đếm trong bộ nhớ tiến trình, không tốn Redis. Vượt thì vẫn trả 401 nhưng không ghi DB, chỉ log.
   - **Không đụng tới raw_events ACCEPTED.** Đó là bằng chứng gốc để verify và replay lại (BB09: "body jsonb vứt raw bytes").
4. **ADR:** "AMQP rớt thì chết sạch để orchestrator dựng lại; cleanup giữ 7 ngày; request ký sai chỉ lưu mẫu có giới hạn".

**Test:**
- Unit test cleanup: không giành được khoá thì không chạy câu DELETE nào.
- Unit test assert retention > tổng TTL retry.

**Cách kiểm (docker):**
```bash
docker compose restart rabbitmq
docker compose ps hub-worker      # đã tự lên lại (Restarting -> Up), log có dòng 'AMQP close'
docker compose logs hub-worker --tail 30 | grep -i "amqp\|kết nối"
```

---

## S1-5 · Bịt các lỗ BB-5 hiện có (không phụ thuộc mô hình Project)

**BB09:** câu 9 ("Subscription chéo tenant… Hub và Shop dùng chung user DB"). Thêm lỗ mới phát hiện hôm 10/10: normalize đọc `raw_events` không qua repo.

**Làm:**
1. `createSubscription` ở `api.controller.ts:121-129`, và cả update nếu có:
   - Gọi `repo.findDestinationById(body.destinationId)` trước khi tạo.
   - Không thấy thì `404 'Destination không tồn tại'`, không phải 403, để không lộ việc đích đó có tồn tại ở tenant khác.
2. `findActiveSubscriptionsForEventType` (`tenant-scoped.repository.ts:103`): đổi `include: { destination: true }` thành **lọc** `destination: { tenantId: this.tenantId }` trong `where`. Đây là phòng thủ chiều sâu, vì dữ liệu cũ có thể đã lẫn.
3. `normalize.consumer.ts:53`: thay `this.prisma.rawEvent.findUnique` bằng `repo.findRawEventById(id)`.
   - Phương thức mới lọc `where: { id, source: { tenantId } }`.
   - Dựng repo **trước** đoạn đọc, bằng `this.prisma.forTenant(tenantId)`.
4. **Tách user DB cho Shop:**
   - Thêm `docker/postgres/init/02-shop-user.sql`. Mount vào `/docker-entrypoint-initdb.d` nếu chưa có thư mục này; nếu đã có thư mục init thì thêm file vào đó.
   - SQL tạo role `shop_user` (mật khẩu lấy từ env), `GRANT USAGE ON SCHEMA shop`, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shop`, `ALTER DEFAULT PRIVILEGES IN SCHEMA shop GRANT …`. **Không cấp gì trên schema `hub`.**
   - Script init chỉ chạy khi volume rỗng. Bảng `shop.*` do migration của hub-api tạo **sau** đó, nên `ALTER DEFAULT PRIVILEGES` phải được khai báo **cho role chạy migration** (`FOR ROLE hub_user`).
   - `docker-compose.yml` → service `shop` đổi `DATABASE_URL` sang `shop_user`.
5. **ADR:** "Kiểm đích cùng tenant ở API và lọc lại ở repo; Shop có user DB riêng chỉ thấy schema `shop`".

**Test:**
- `apps/hub-api/test/subscription-tenant.spec.ts`: tenant A tạo subscription với `destinationId` của tenant B thì nhận 404, và không có dòng nào được tạo.
- Unit test repo: `findActiveSubscriptionsForEventType` không trả subscription có destination khác tenant (dùng mock Prisma, kiểm `where`).

**Cách kiểm (docker):**
```bash
docker exec webhook-hub-postgres psql -U shop_user -d webhook_hub -c "select count(*) from hub.events;"
# kỳ vọng: ERROR: permission denied for schema hub
grep -rn "prisma\.rawEvent\." apps/hub-worker/src   # kỳ vọng: 0 dòng
```

---

## S1-6 · Không bao giờ build ra bản cũ; migrations thay `db push`

**BB09:** lỗi chặn P0-1.

**Làm:**
1. Xoá mọi `libs/*/dist` và `apps/*/dist` trên máy.
   - Đảm bảo `.gitignore` có `dist/`, `libs/*/src/**/*.js`, `libs/*/src/**/*.d.ts`, `*.js.map`.
   - Các file `.js`/`.d.ts` đã xoá trong `libs/*/src` đang ở trạng thái `D` trong git: commit việc xoá này.
2. `Dockerfile`: thêm `RUN rm -rf libs/*/dist apps/*/dist` ngay trước bước `npm run build`. `.dockerignore` đã chặn rồi, đây là lớp thứ hai.
3. **Kiểm export lúc khởi động** (worker và api):
   - Viết hàm `assertDatabaseLib()` đặt trong `libs/database/src/index.ts`. Hàm này ném lỗi nếu `typeof getMasterKey !== 'function' || typeof TenantScopedRepository !== 'function'`.
   - Gọi ở đầu `bootstrap()` của cả hai app. Lỗi phải lộ ngay lúc khởi động, không được để message trôi vào DLQ.
4. **Migrations:**
   - Tạo baseline `libs/database/prisma/migrations/0_init/migration.sql` bằng `npx prisma migrate diff --from-empty --to-schema-datamodel libs/database/prisma/schema.prisma --script`, cộng `migration_lock.toml`.
   - `docker-entrypoint.sh`: thay `prisma db push --accept-data-loss` bằng `npx prisma migrate deploy --schema=libs/database/prisma/schema.prisma`.
   - Mọi thay đổi schema của SPEC-1..3 đều là migration mới, tạo bằng `prisma migrate dev --name …`.
   - DB local đang có dữ liệu sinh từ `db push`: **hỏi Admin** để `docker compose down -v`, hoặc chạy `prisma migrate resolve --applied 0_init`.
   - Cập nhật `docs/DEPLOYMENT.md`: Neon dùng `DIRECT_URL` cho `migrate deploy`.
5. **ADR:** "`migrate deploy` thay `db push --accept-data-loss`; kiểm export lúc khởi động".

**Cách kiểm:**
```bash
ls libs/*/dist apps/*/dist 2>&1 | grep -c "No such"   # = số thư mục, tức là không còn dist
grep -c "accept-data-loss" docker-entrypoint.sh       # = 0
docker compose build --no-cache hub-worker hub-api && docker compose up -d && docker compose logs hub-api | grep -i migrate
```

---

## S1-7 · Đích chạy được thật: đồng bộ đích, Telegram không chết vì dấu `_`

**BB09:** lỗi chặn P0-3 (phần đồng bộ) và câu 3 (Telegram Markdown).

**Làm:**
1. Thêm `docker-entrypoint.sh seed --sync-destinations`, tức là `npm run prisma:seed -- --sync-destinations`.
   - Với các đích seed đã biết tên (Discord, Telegram, Shop): mã hoá lại `config` từ env hiện tại (`MOCK_BASE_URL`, `SHOP_WEBHOOK_URL`, `TELEGRAM_*`, `DISCORD_WEBHOOK_URL`, `HUB_SIGNING_SECRET`) và **update** đích.
   - Không đụng các bảng khác. In ra đích nào đã đổi.
2. `telegram.sender.ts:32`: **bỏ `parse_mode`**, gửi văn bản thuần. Văn bản thuần không bao giờ bị 400 vì ký tự lạ.
   - Seed template Telegram bỏ `**…**`. Nội dung template được viết lại ở S3-3.
3. Thêm test SSRF đi **qua axios** với `createSsrfSafeAxiosConfig(url, true)` tới `http.createServer` cục bộ, kỳ vọng 200. Test hiện có chỉ đi qua `http.get`.
4. **ADR:** gộp với S1-1 nếu cùng ngày: "Telegram gửi văn bản thuần".

**Test:** unit test sender, kiểm payload gửi đi không có khoá `parse_mode`.

**Cách kiểm:** gửi template có `_a_b*c` tới Telegram mock (`/mock/telegram`) và tới Telegram thật. Delivery phải `SUCCEEDED`.

---

## S1-8 · Script smoke e2e (dùng lại cho phiên review)

**Làm:** viết `scripts/e2e-smoke.sh` (bash, chạy được trên Git Bash Windows).
- Bắn 1 webhook GitHub ký đúng, 1 webhook ký sai, 1 webhook SePay `Apikey` đúng (key lấy từ env `DEMO_SEPAY_APIKEY`), và gửi lại SePay lần nữa.
- Đợi tối đa 20s, rồi in bảng `events × deliveries` (type, status, attempt_count, last_error).
- **Exit ≠ 0** nếu:
  - có delivery không `SUCCEEDED`;
  - ký sai mà không nhận 401;
  - gửi lại mà sinh event thứ hai;
  - `hub.outbox` có chuỗi giống secret.

**Cách kiểm:** `bash scripts/e2e-smoke.sh` → `OK` và exit 0.

---

## Lệch khi làm

*(phiên dev ghi vào đây)*

### Phiên dev 10/10 (Amelia)

1. **Số ADR:** ADR-041 đã bị phiên khác chiếm (bàn giao đa service). SPEC-1 dùng **ADR-042..047**: 042 (S1-1 + Telegram văn bản thuần của S1-7), 043 (S1-2), 044 (S1-3), 045 (S1-4), 046 (S1-5), 047 (S1-6).
2. **S1-1 bước 6 (dọn outbox cũ):** đặt thành migration dữ liệu `20261010000000_scrub_outbox_secrets`, không phải script rời, để Neon cũng được dọn khi `migrate deploy`. Xoá thêm các khoá thừa khác (`destinationType`, `destinationId`, `subscriptionId`, `rateLimitRps`, `eventId`), áp cho cả `delivery.requested`.
3. **S1-1, tương thích ngược:** worker đọc 4 trường tham chiếu cộng `correlationId`. Mọi lần đẩy tiếp (hoãn vì circuit/throttle, retry, DLQ) đều **dựng lại message gọn**, kể cả khi message vào là kiểu cũ. Trước đây nhánh circuit/throttle đẩy lại `msg.content` nguyên văn, nên secret cũ sẽ nằm lại trong hàng đợi mãi.
4. **S1-2 sweeper mở rộng:** ngoài PENDING không attempt, sweeper quét thêm **DELIVERING treo quá ngưỡng**. Lý do: worker chết giữa lúc gửi thì message bị redeliver ngay. Lúc đó lease còn hiệu lực nên message bị ack bỏ, và nếu không quét DELIVERING thì delivery treo mãi. Sweeper cũng bỏ qua delivery vừa có outbox trong cửa sổ 10 phút (kể cả đã publish), để không nhân bản message mỗi phút khi hàng đợi chỉ đang chậm.
5. **S1-2 rủi ro còn lại (chưa vá):** delivery consumer ghi RETRYING rồi mới `sendToQueue` tầng retry, trên kênh không confirm. Worker chết giữa hai bước đó thì message gốc được redeliver, gặp `processed_messages` hit và bị ack, nên delivery nằm RETRYING mãi. Sweeper chưa quét RETRYING, vì circuit OPEN đẩy message vào tầng 2h mà không cập nhật `updated_at`, nên không phân biệt được với "đang chờ hợp lệ". Đề xuất cho SPEC-2 (S2-1 sửa circuit): chuyển retry sang outbox, hoặc ghi `next_attempt_at` rồi cho sweeper quét theo cột đó.
6. **S1-3, định nghĩa raw mồ côi:** ngoài "không có event", thêm điều kiện "không có `processed_messages(normalize, id)`" để loại raw event mà adapter cố ý chuẩn hoá ra 0 event. Hệ quả: sau 7 ngày cleanup xoá `processed_messages`, raw event loại đó (hiện không adapter nào sinh ra) sẽ hiện thành mồ côi.
7. **S1-3 audit:** bảng `audit_logs` đã có trong schema nên ghi thật qua `repo.createAuditLog` (action `raw_event.renormalize`), kèm `TODO(S2-3)` để chuẩn hoá chung với replay hàng loạt.
8. **S1-4 cleanup, "chỉnh retention = 0 để kiểm" (checklist #21):** assert lúc load từ chối mọi retention ≤ tổng TTL retry (~2h39m), đúng tinh thần spec ("assert lúc load"). Vì vậy kiểm trên docker bằng cách chèn dòng lùi ngày 8 ngày. Lượt cleanup đầu chạy sau 30–90s kể từ khi khởi động (không đợi 1 giờ) để một lần restart là đủ kiểm. Có thêm env `CLEANUP_INTERVAL_MS`.
9. **S1-4 bug cũ lộ ra khi kiểm:** `OutboxRelay.pollAndPublish` khi chưa có channel gọi `scheduleNext()` và `finally` gọi thêm lần nữa, nên số timer nhân đôi mỗi 500ms. Trước đây channel có ngay nên không ai thấy. Có retry kết nối AMQP thì cửa sổ chờ dài ra, và worker **OOM 2GB** sau ~45s. Đã sửa (chỉ `finally` lên lịch, `scheduleNext` huỷ timer cũ) và thêm `outbox-relay.spec.ts`.
10. **S1-4 REJECTED meta:** `bodyTruncated`/`originalBytes` nằm trong `headers.__hub_meta`, không thêm cột, để tránh migration. Trần 20/phút đếm trong bộ nhớ nên nhân theo số instance hub-api.
11. **S1-5 shop user:** file là `docker/postgres/init/02-shop-user.sh` chứ không phải `.sql`, vì mật khẩu lấy từ env `SHOP_DB_PASSWORD`. Volume local đã có dữ liệu nên đã chạy tay một lần (`docker compose exec -T postgres sh /docker-entrypoint-initdb.d/02-shop-user.sh`). Thêm `.gitattributes` (`*.sh eol=lf`) vì máy dev đặt `core.autocrlf=true`, script CRLF sẽ hỏng trong container.
12. **S1-6:** không `docker compose down -v`. Đã `migrate resolve --applied 0_init` trên DB local sau khi `migrate diff` DB↔schema ra rỗng. Phần "commit việc xoá `.js/.d.ts` trong `libs/*/src`" **chưa làm** vì phiên này được dặn không commit; các file đó vẫn ở trạng thái `D` chờ commit. `npx tsc --noEmit` (incremental) sinh lại `apps/*/dist/tsconfig.tsbuildinfo`. File này vô hại, đã bị gitignore/dockerignore, và đã xoá cuối phiên.
13. **S1-7:** chỉ bỏ `**` ở template Telegram. Template Discord giữ Markdown vì Discord không trả 400. Entrypoint `seed` giờ chuyển tham số thẳng tới workspace `libs/database`, vì `npm run prisma:seed -- --flag` ở root bị npm lồng nuốt mất cờ.
14. **Dữ liệu kiểm còn lại trong DB local:** destination `S1 check 404`, `S1 check down`, `S1-7 Telegram mock` và các subscription `repo.s1_*`. Chúng chỉ nhận event type `repo.s1_*` (không ảnh hưởng smoke). Delivery `S1 check down` sẽ đi hết các tầng retry rồi thành DEAD. Không xoá bằng SQL trần.

### Sửa sau review (10/10, Amelia)

Sáu lỗi review đối kháng SPEC-1 (và một từ SPEC-2) để lại. ADR-051 (che header + các mục nhỏ), ADR-052 (DLQ bằng policy).

1. **(Trung) API key SePay lộ trong `raw_events`.** `redactHeaders()` mới (`apps/hub-api/src/modules/ingest/redact-headers.ts`) che `authorization`, `cookie`, `x-api-key`, `proxy-authorization` → `<scheme> ***`. Gọi ngay sau `adapter.verify`, áp cho cả ACCEPTED lẫn REJECTED; `signature_header` tính từ bản đã che (chữ ký `sha256=` của GitHub giữ nguyên). `body_raw` không đụng. Dữ liệu cũ: migration `20261010010000_redact_raw_event_headers` (idempotent; đã áp qua `migrate deploy` khi hub-api khởi động, local còn 0/84 dòng lộ). Log ingest không in header; thêm `redact` pino trong `libs/common/src/logger.ts` làm lưới an toàn. Test: `redact-headers.spec.ts`, `ingest-redact.spec.ts`, `redact-migration-db.spec.ts` (DB). Kiểm thật: `GET /api/v1/events/:id` của event SePay smoke trả `"authorization":"Apikey ***"`, `signatureHeader` `"Apikey ***"`, không chứa `DEMO_SEPAY_APIKEY`.
2. **(Thấp) P2028** vào nhóm lỗi tạm của normalize. Test trong `normalize-consumer.spec.ts`.
3. **(Thấp) Senders.** `apps/hub-worker/src/senders/http-limits.ts`: `outboundLimits()` = `timeout` + `signal: AbortSignal.timeout(5000)` (tạo mới mỗi lần gửi) + `maxContentLength`/`maxBodyLength` 64KB, dùng ở cả ba sender. Abort (`ERR_CANCELED`) vẫn thành `SendResult` 500 (retryable, như timeout cũ) với thông điệp "timeout tổng". Test `sender-limits.spec.ts`. Lưu ý: đích trả body > 64KB giờ thành 500 → retry (dù đích có thể đã nhận).
4. **(Thấp) `seed --sync-destinations`** gọi `checkSyncDestinationsEnv()` (`libs/database/src/seed-env.ts`): thiếu `HUB_SIGNING_SECRET`, `SHOP_WEBHOOK_URL`, `MOCK_BASE_URL` (khi còn đích dùng mock) hoặc `TELEGRAM_CHAT_ID` (khi token Telegram thật) → in tên biến thiếu, exit 2; `--allow-defaults` để bỏ qua. Test `libs/database/test/seed-env.spec.ts`. Kiểm trong docker: thiếu `SHOP_WEBHOOK_URL`/`MOCK_BASE_URL` → exit 2 kèm thông báo.
5. **(Thấp) DLQ không giới hạn.** Không đổi arguments queue. Hằng `DLQ_POLICY` trong `libs/messaging/src/topology.ts` (`^q\.(delivery|normalize)\.dlq$`, max-length 5000, drop-head, priority 10). Local: service one-shot `rabbitmq-init` (rabbitmqadmin, PUT idempotent) trong `docker-compose.yml`; `rabbitmqctl list_queues name policy` cho thấy chỉ hai DLQ mang `hub-dlq-bounded`. CloudAMQP: lệnh curl management API ở `docs/DEPLOYMENT.md` §6.1. Test `libs/messaging/test/dlq-policy.spec.ts` (pattern chỉ khớp hai DLQ; compose khớp hằng số).
6. **(Thấp, SPEC-2) RETRYING `next_attempt_at IS NULL`.** Sweeper quét thêm khi `updated_at` cũ hơn `LEGACY_RETRY_SWEEP_AFTER_MS` = 3h (> tầng 2h). Mọi chỗ ghi RETRYING hiện nay đều ghi `next_attempt_at`, nên điều kiện chỉ chạm dữ liệu cũ. Test DB trong `delivery-lease-sweeper.spec.ts` (3h05 → quét, 2h59 → không, chạy lại không nhân bản).
7. **Smoke:** để tránh gửi Telegram thật, trước smoke đã `seed --sync-destinations` với `TELEGRAM_BOT_TOKEN=123456:mock-token` (đích Telegram → mock), smoke OK, rồi chạy lại `--sync-destinations` với env chuẩn để trả đích Telegram về token thật.
