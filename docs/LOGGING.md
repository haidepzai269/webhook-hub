# LOGGING — log phải tự nói "chậm / sai / tăng nhanh vì đâu"

> Trạng thái: **THIẾT KẾ (giai đoạn 1, ADR-250)** — chưa có dòng code nào theo tài liệu này. Giai đoạn 2 ở §10.
> Mục tiêu (Admin): nhìn một dòng log là biết **sơ bộ** do đâu (triage) để quyết định có đáng đào sâu bằng trace không.
> Log là tầng 1 (rẻ, luôn bật); metric là tầng 2 (đếm theo `cause`); trace (OpenTelemetry, sau) là tầng 3 (đào sâu một ca).
> Mâu thuẫn với `ARCHITECTURE.md` → ARCHITECTURE.md thắng.

---

## 1. Audit thực trạng

Logger: pino (`libs/common/src/logger.ts:4-21`) — JSON, có `redact` + `scrubSecrets`. Định danh hiện có: `x-request-id` chỉ cho `/v1/p/*` và `/api/v1/*`
(`apps/hub-api/src/modules/errors/request-id.ts:15-26`; **`/hooks/*` cố ý không có**); `correlationId` (UUID, `libs/common/src/correlation.ts:3`) sinh ở mỗi lần ingest
(`ingest.service.ts:263`), đi qua `outbox.payload` → header AMQP `x-correlation-id` (`outbox.relay.ts:139`) → `DeliveryMessage.correlationId`
(`libs/common/src/delivery-message.ts:4-12`) và được lưu ở cột `correlation_id` (`schema.prisma:551`). Tức **đã có sợi chỉ xuyên suốt**; chỉ chưa chuẩn W3C và chưa gắn vào mọi dòng log.

| Đường | Log hiện tại nói gì | Thiếu gì để biết nguyên nhân |
|---|---|---|
| **Ingest thành công** `ingest.service.ts:354-357` | `'Đã tiếp nhận và commit…'` + `rawEventId`, có `correlationId` (child logger `:309`) | Không có thời gian; không phân biệt chậm do verify / Redis / DB commit. `ms` chỉ có ở `trace.ingested` đẩy realtime (`:277`), không vào log. Histogram `ingestDuration` (`:449`) có tổng nhưng **không có chặng và không có nguyên nhân** |
| **Ingest lỗi DB** `:351` | `log.error({ err: error.message }, 'Lỗi transaction…')` | Chỉ `err.message`; không `code` (P1001/P2024/P2028…) dù `classifyInfraError` đã phân loại được (`infra-errors.ts:41-67`) — phân loại có nhưng **không được ghi ra log** |
| **Ingest bị từ chối** (chữ ký, nguồn lạ, 413/414, rate-limit, storage_full) `:468-640` | **Không có dòng log nào**: chỉ metric `ingestRequests{outcome}` + traffic recorder trong bộ nhớ | Không biết request nào, IP/nguồn nào, vì sao. Chữ ký sai (`:594-602`) chỉ đi vào hộp phạt. Muốn hỏi "sai do đâu" phải mở console |
| **Ingest bị hộp phạt chặn** `penalty-box.ts:567`, `blocked-ack.ts` | `'Hộp phạt: bắt đầu tạm chặn'` (có `reason, ip, banSeconds`) — lúc **bắt đầu** ban | Các request bị chặn **trong** ban không có dòng nào (cố ý, tránh bão log) → không thấy "đang chặn bao nhiêu/ai" ngoài metric |
| **Body parser** `body-parsers.ts` | Lỗi parser (400/413) đi lớp `hub-outcome` (`hub-outcome.ts:49-60`) — không log | Sai khuôn / quá lớn không để lại dấu vết ở log |
| **Outbox relay** `outbox.relay.ts:90-101` | Thành công `debug`; lỗi `logger.error({ err: err.message })` | Không phân biệt PG rớt / broker nack / confirm timeout / tx timeout 15s (`:11-14`). Lag chỉ là gauge `outboxLag` (`:121`) — **không ghi lại dòng nào đã chờ bao lâu**; không đóng dấu thời điểm publish lên message |
| **Normalize** `normalize.consumer.ts` | OK: `'Normalize & Route hoàn thành'` (không thời gian). Lỗi: `log.error` kèm `kind` transient/permanent; transient bị gộp 1 dòng/30s (`:191-194`) | Không có `queue_wait`, không thời gian adapter/DB. Sai khuôn catalog (`schema_mismatch`) và adapter ném lỗi **cùng một nhánh `permanent`** (`normalize-errors.ts`) → log không nói "dữ liệu provider đổi khuôn" hay "bug adapter" |
| **Delivery thành công** `delivery.consumer.ts:588` | `durationMs, destinationType` | Không `destinationId`, không `attempt`, không `queue_wait`. `durationMs` chỉ là chặng gọi đích; thời gian xử lý của hub (DB, giải mã, circuit) nằm trong `deliveryHandleDuration` mà **không thể nối với dòng log** |
| **Delivery thất bại, còn retry** `:609` | `{ nextQueue, nextAttempt }` — **không có `status`, `error`, `durationMs`** | Đây là lỗ lớn nhất: lần thử thất bại là sự kiện đáng ghi nhất mà dòng log không nói đích trả gì (chỉ ghi vào `delivery_attempts` + `lastError`) |
| **Delivery DEAD** `:641` | `{ status }` | Không nói DEAD vì 4xx cấu hình (lỗi của khách) hay hết 5 tầng (đích hỏng); phải suy từ `status` |
| **Hoãn: circuit / throttle / ramp / backpressure** `:248`, `:342`, `:451`, `gate.ts:50`, `normalize.consumer.ts:175` | Có `warn`/`debug` mô tả hoãn; throttle/ramp hạ xuống `debug` (`:342`,`:451`) | Hoãn là nguyên nhân số 1 của "giao chậm" nhưng **không có số "đã hoãn bao lâu so với dự kiến"** và không cùng một khuôn |
| **Circuit breaker** `circuit-breaker.service.ts:334,367` | `OPEN (hoãn gửi Ns)` có `failures, openSeconds, trips` | Thiếu `destinationId` ở dòng chuyển trạng thái chung (`:367`) tuỳ nhánh; không nói **lỗi nào** đã làm mở (5xx hay timeout) |
| **Alert evaluator** `alert.evaluator.ts:521` | `'Cảnh báo đổi trạng thái'` có `rule, subjectId, to` | Thiếu `cause` của rule để nối cảnh báo ↔ log/metric (rule có trong `ALERT_RULES` nhưng không ánh xạ sang cause) |
| **Storage job** `cleanup.job.ts:218`, `storage-alerts.ts:173`, `storage-clean.runner.ts:130` | Mốc/nấc dung lượng có `from,to`; dọn xong có số liệu | Không có **tốc độ tăng** (byte/giờ, bảng nào tăng) → báo "đầy" khi đã muộn, không báo "tăng nhanh vì đâu" |
| **Chung** | `logger.error({ err: e.message })` ở ~mọi nơi (vd `main.ts:97`, `outbox.relay.ts:100`, `delivery.consumer.ts:89`) | **Không có `err.code/err.class`**, không `svc`, không `trace_id`; `request_id` không bao giờ ở worker; `cause`/`blame` không tồn tại; tên trường lẫn lộn (`err` là string, đôi khi object: `redis.service.ts:59,76`; `correlationId` vs `rawEventId`…) |

**Năm lỗ hổng lớn nhất** (ưu tiên giai đoạn 2):
1. Từ chối ở ingest (chữ ký/nguồn lạ/413/429/507) **không có log** — `ingest.service.ts:468-640`.
2. Lần giao **thất bại có retry** không ghi `status/error/durationMs` — `delivery.consumer.ts:609`.
3. Không có bóc thời gian theo chặng ở bất cứ dòng nào; `queue_wait` không đo ở đâu — `outbox.relay.ts:139` không đóng dấu thời điểm publish.
4. `err.message` thay cho `err.code/class` — `ingest.service.ts:351`, `outbox.relay.ts:100`, `normalize.consumer.ts`.
5. `/hooks/*` không có request id; hub-worker không bao giờ có id nối ngược về request gốc ngoài `correlationId` (UUID dạng cũ, không W3C).

---

## 2. Taxonomy nguyên nhân (`cause`)

Quy tắc: **một enum đóng**, ghi ở `libs/common/src/causes.ts` (giai đoạn 2). `cause` = `<nhóm>.<tên>`, chỉ chữ thường + `_`. **Không bao giờ chứa id/giá trị tự do**
→ dùng được làm nhãn Prometheus (≈ 30 giá trị). `blame` ∈ `provider | khach | dich | hub | ha_tang`. Cột **Page?**: lỗi do hub/hạ tầng có hại → đáng đánh thức Admin; còn lại chỉ để triage.

### 2.1 CHẬM — `slow.*` (ghi khi vượt ngưỡng env, mức `warn`; nguyên nhân = chặng chiếm nhiều nhất trong `stage_ms`)

| cause | Nghĩa (1 dòng) | blame | Page? | Bước kế |
|---|---|---|---|---|
| `slow.destination` | `dest_http` > `SLOW_DELIVERY_MS` | dich | không | Xem `destination_id`; metric `hub_delivery_duration_seconds{destination_type}`; có thể sắp mở circuit |
| `slow.db` | `db_commit`/`db_*` chiếm phần lớn | ha_tang | có nếu kéo dài | Neon chậm/pool cạn; metric pool, `hub_backpressure_factor{dependency="db"}`; trace span DB |
| `slow.redis` | `redis` chiếm phần lớn | ha_tang | không (BB-2: chỉ chậm, không sai) | Upstash quota/latency; hub vẫn đúng |
| `slow.queue_wait` | `queue_wait` > `SLOW_QUEUE_WAIT_MS` (message nằm trong hàng đợi) | hub | có nếu lặp | Worker thiếu/đang bận: `hub_backpressure_held`, số consumer, depth hàng đợi |
| `slow.relay_lag` | `outbox_lag` (created→published) lớn | hub | có | Relay kẹt/PG chậm/broker nack: `hub_outbox_lag_seconds`, heartbeat (ADR-248) |
| `slow.deferred_circuit` | bị hoãn có chủ đích vì circuit OPEN/HALF_OPEN | dich | không | Đích đang hỏng — xem `fail.dest_*` cùng `destination_id` |
| `slow.deferred_throttle` | hoãn vì vượt RPS của đích / ramp | khach | không | Khách đặt `rateLimitRps` thấp; chủ ý |
| `slow.deferred_backpressure` | hoãn vì chính hub tự giảm tải (DB ốm) | hub | có | `hub_backpressure_factor`, `hub_backpressure_spilled_total` |
| `slow.cold_start` | instance vừa thức dậy (uptime < `COLD_START_WINDOW_S`, request đầu) | ha_tang | không | Render free ngủ (ADR-240); keep-alive; **không** tính vào p95 (xem §7) |
| `slow.hub_cpu` | event-loop lag cao (`monitorEventLoopDelay` p99 > ngưỡng) | hub | có nếu lặp | Hub bận CPU/GC; log đồng loạt `slow.*` khác nhau cùng lúc = dấu hiệu |

### 2.2 SAI — `wrong.*` (bên gửi sai/bị chặn theo chính sách: **không phải lỗi hub**) và `fail.*` (xử lý thất bại)

| cause | Nghĩa | blame | Page? | `error`/`reason` khách thấy (nguồn thật: `docs/ERRORS.md` / `REASON_CODES`) | Bước kế |
|---|---|---|---|---|---|
| `wrong.signature` | chữ ký/khoá không khớp | provider (hoặc khách sai secret) | không | `signature_invalid` | Xem `source_id`; secret đã rotate? Lặp nhiều → hộp phạt |
| `wrong.unknown_source` | `/hooks/:p/:key` không tồn tại/tắt | provider/khách | không | 404 / `unknown_source` | URL cấu hình sai; đếm theo IP (hộp phạt) |
| `wrong.payload_shape` | body rỗng/không parse/sai content-type/413/414 | provider/khách | không | `empty_body`, `payload_too_large`, `unsupported_media_type`, `uri_too_long` | Xem `bytes`, `content_type` |
| `wrong.schema_mismatch` | adapter ra sai khuôn catalog (lỗi normalize vĩnh viễn) | provider (đổi khuôn) hoặc hub (bug adapter) | **có** (nghi bug hub) | `schema_mismatch` | Raw trong DLQ; so `EVENT-CATALOG.md`; renormalize sau khi sửa |
| `wrong.config_dest_4xx` | đích trả 4xx (trừ 408/429) → DEAD ngay | khach | không | `http_4xx` | Khách sửa URL/auth đích; replay sau khi sửa |
| `wrong.policy_blocked` | bị chính sách chặn: hộp phạt, rate limit, `project_storage_full`, nguồn/đích/subscription tắt, endpoint chưa xác minh | khach/provider | không (trừ storage_full → xem `growth.storage`) | `ip_temporarily_blocked`, `rate_limited`, `project_storage_full`, `*_inactive` | Dùng `detail.policy` ở dòng log |
| `wrong.duplicate` | bản trùng (Redis hoặc UNIQUE PG) | provider | không | ACK `duplicate` | Bình thường; tăng vọt → `growth.dup_flood` |
| `fail.dest_5xx` | đích trả 5xx | dich | không | `http_5xx` | Xem `fail.dest_*` cùng đích; circuit sắp mở |
| `fail.dest_timeout` | đích không trả lời trong 5s (hoặc 408) | dich | không | `timeout`, `http_408` | Đích chậm/ngủ; so `slow.destination` |
| `fail.dest_network` | DNS/refused/TLS/reset khi gọi đích | dich | không | `network_error` | Đích sập hoặc URL sai |
| `fail.dest_overload` | đích trả 429 | dich | không | `http_429` | Giảm `rateLimitRps` |
| `fail.exhausted` | hết 5 tầng retry → DEAD (kèm `last_cause`) | dich | không | `max_attempts` | DLQ; replay khi đích khoẻ |
| `fail.hub_db` | PG lỗi hạ tầng (transient, `classifyInfraError`) | ha_tang | **có** | 503 `unavailable` | `err.code`; Neon status; backpressure sẽ tự giảm tải |
| `fail.hub_broker` | RabbitMQ: confirm nack/channel đóng/mất kết nối | ha_tang | **có** | (nội bộ) | CloudAMQP; relay rollback an toàn (at-least-once) |
| `fail.hub_redis` | Redis lỗi (fail-open, chỉ chậm — BB-2) | ha_tang | không | (không lộ) | Upstash; kiểm quota |
| `fail.hub_unknown` | lỗi lạ chưa phân loại (bug) | hub | **có** | `internal_error` | Stack ở log; vào DLQ sau N lần |
| `fail.poison_message` | message hỏng (parse lỗi) → bản sao DLQ | hub | **có** | (nội bộ) | `x-dead-reason=parse_error`; ai publish? |

### 2.3 TĂNG NHANH — `growth.*` (log **tổng hợp theo cửa sổ**, không phải mỗi sự kiện; mức `warn`; kèm tốc độ + so với đường nền)

| cause | Nghĩa | blame | Page? | Bước kế |
|---|---|---|---|---|
| `growth.burst_source` | một source/project nhận tốc độ > `GROWTH_BURST_FACTOR` × nền (hoặc > ngưỡng tuyệt đối) | provider/khach | không (trừ khi kéo theo `slow.*`) | Xem `source_id`, tỉ lệ `wrong.duplicate` (provider bắn lặp?) |
| `growth.dup_flood` | tỉ lệ `duplicate` của một source vượt ngưỡng | provider | không | Provider retry bão vì ACK chậm/không tới? Kiểm ACK latency |
| `growth.retry_storm` | số lần thử/sự kiện tăng (attempt:event vượt ngưỡng) | dich | không | Một đích hỏng làm cả hàng đợi retry; circuit |
| `growth.dlq_swell` | DEAD/phút tăng hoặc DLQ vượt mốc | dich/hub (xem `last_cause`) | có nếu `wrong.schema_mismatch`/`fail.hub_*` | Nhóm theo `last_cause` |
| `growth.backlog` | độ sâu hàng đợi/`outbox_lag` tăng liên tục | hub | có | Thêm worker; `slow.queue_wait` đi kèm |
| `growth.storage` | dung lượng project/DB tăng nhanh (byte/giờ), kèm bảng nào | khach/provider | có khi gần đầy | `storage-alerts`; ai ghi nhiều (`source_id`); chính sách giữ |

**Phân xử khi một dòng có nhiều dấu hiệu:** `cause` = nguyên nhân **gần với kết quả nhất** theo thứ tự: lỗi (`wrong.*`/`fail.*`) > hoãn có chủ đích (`slow.deferred_*`) > chặng chậm nhất (`slow.*`). Các chặng còn lại vẫn nằm trong `stage_ms`; chặng chiếm ≥ 50% tổng và vượt ngưỡng của nó mới đủ điều kiện làm `cause` `slow.*`.

---

## 3. Hợp đồng "canonical log line"

Mỗi **sự kiện then chốt** đúng **một dòng** giàu thông tin (không rải 6 dòng nhỏ). Bốn loại, phân biệt bằng `msg` ổn định (chuỗi cố định, không nhúng giá trị):

| `msg` | Khi nào | svc | Mức |
|---|---|---|---|
| `ingest.done` | mỗi request `/hooks`, `/events` kết thúc (mọi outcome) | hub-api | thành công=`info` (lấy mẫu, §6); lỗi/chậm=`warn`/`error` |
| `normalize.done` | mỗi lần xử lý message normalize (ok/skip/lỗi/hoãn) | hub-worker | như trên |
| `delivery.attempt` | mỗi lần thử giao (kể cả thất bại), mỗi lần hoãn/bỏ (`outcome=deferred\|skipped`) | hub-worker | như trên |
| `growth.window` | tổng hợp theo cửa sổ 60s khi vượt ngưỡng | hub-worker (+hub-api cho burst) | `warn` |

### 3.1 Trường

| Trường | Bắt buộc | Ghi chú |
|---|---|---|
| `ts` (ISO), `level` | luôn | đã có (pino) |
| `svc` | luôn | `hub-api` \| `hub-worker` (base của logger, đặt một lần) |
| `msg` | luôn | một trong bốn chuỗi cố định trên (thêm khi có loại mới + sửa tài liệu này) |
| `request_id` | khi có | chỉ `/v1/p/*`, `/api/v1/*` (id dev thấy ở `x-request-id`); `/hooks` không có |
| `trace_id` (32 hex), `span_id` (16 hex) | luôn | `trace_id` = `correlationId` bỏ dấu `-` (UUID v4 là 128 bit = hợp lệ W3C, **không đổi schema**). `span_id` mới mỗi chặng |
| `event_name` | khi biết | kiểu chuẩn (`payment.paid`…) — **sau normalize**; trước đó để trống. Hub không biết "đơn hàng" (BB-1) |
| `tenant_id` | khi biết | nhãn log, **không** là nhãn metric |
| `source_id` / `destination_id` / `delivery_id` / `raw_event_id` | khi có | |
| `outcome` | luôn | enum đóng, dùng lại từ `hub-outcome.ts`: `accepted\|duplicate\|rejected\|refused\|unavailable\|handshake` ở ingest; `ok\|failed\|retry\|dead\|deferred\|skipped` ở worker |
| `cause`, `blame` | khi `outcome` ≠ ok **hoặc** chậm | từ `causes.ts` (§2). Dòng thành công bình thường không có |
| `attempt` | delivery | số lần thử (1..6) |
| `total_ms` | luôn | |
| `stage_ms` | luôn | object số nguyên, xem §3.2 |
| `http_status` | khi có | phản hồi của hub (ingest) hoặc của đích (delivery) |
| `err` | khi có lỗi | `{ class, code, msg }` — `class`=tên lớp lỗi, `code`=mã máy đọc (Prisma `P2024`, errno `ECONNRESET`, AMQP `406`, hoặc `HTTP_5xx`); `msg` đã qua `scrubSecrets`, cắt 200 ký tự. **Cấm** chỉ có `err.message` |
| `bytes`, `provider` | ingest | `provider` qua `providerMetricLabel` (không lấy thẳng từ path — chống nổ cardinality) |
| `sampled` | khi lấy mẫu | `{ rate: 0.1 }` hoặc `{ suppressed: n }` — để người đọc biết có dòng bị bỏ |

### 3.2 Bóc thời gian theo chặng (`stage_ms`) — đo ở đâu, chi phí bao nhiêu

Tất cả dùng `performance.now()`/`Date.now()` **trong bộ nhớ**; **không thêm lệnh Redis, không thêm truy vấn DB** (ngân sách R1 ở `apps/hub-api/test/redis-budget.spec.ts` giữ nguyên — bọc đồng hồ quanh lời gọi **đã có**).

| Chặng | Thuộc | Cách đo (quanh lời gọi sẵn có) | Ghi chú |
|---|---|---|---|
| `verify` | ingest | quanh bước verify chữ ký (`ingest.service.ts:~594-640`) | CPU (HMAC), thường < 1ms |
| `redis` | ingest | quanh `getIdempotencyKey` (`:307`) + `setIdempotencyKey` (`:355`) — cộng dồn | đúng 2 lệnh đã có, không thêm |
| `db_commit` | ingest | quanh `tenantTx` (`:315-348`) | chặng chậm điển hình |
| `ack_build` | ingest | dựng phản hồi ACK | thường ~0 |
| `total_ms` | ingest | từ `startedAt` (`:262`) | `parse` (body parser) nằm **trước** `traced`: đo bằng `req` start-time ở middleware; nếu không có thì chấp nhận phần thiếu = `total_ms - Σstage` ghi là `other` |
| `outbox_lag` | relay → dòng worker | `age_s` đã SELECT sẵn trong relay (`outbox.relay.ts:~122`, `now() - created_at` tính bằng **đồng hồ PG**, miễn nhiễm lệch giờ) → đóng vào header AMQP `x-outbox-age-ms` | 0 truy vấn thêm |
| `queue_wait` | worker | `now` lúc consumer nhận − `max(published_ts, due_ts)`. `published_ts` = thuộc tính AMQP `timestamp` do relay đóng lúc publish; `due_ts` = header `x-due-at` (ms) do consumer đặt khi đẩy vào tầng retry (= `nextAttemptAt`). **Trừ phần chờ cố ý của tầng retry/hoãn**, chỉ phần *quá hạn* mới là `queue_wait` | clamp ≥ 0; âm > 1s ghi cờ `clock_skew:true` (relay và consumer có thể ở instance khác nhau) |
| `deliver_prep` | delivery | nạp delivery/destination, giải mã, render, circuit | gồm DB — đã có truy vấn, chỉ bọc đồng hồ |
| `dest_http` | delivery | `result.durationMs` (`webhook.sender.ts:49,56`) | chỉ thời gian gọi đích |
| `db_persist` | delivery | quanh `persistAttempt` (`:~550`) | |
| `defer_ms` | delivery | khi `outcome=deferred`: thời gian hoãn **dự kiến** (TTL tầng) | không phải chặng chậm, là lý do chậm |
| `adapter`, `db_read`, `db_write` | normalize | quanh `ProviderAdapter.normalize`, đọc raw_event, transaction normalize+route+outbox | |

**Quy tắc "chậm"**: ngưỡng ở env (một nơi — `libs/common/src/slow-thresholds.ts`, không số cứng rải rác):
`SLOW_INGEST_MS` (mặc định 500), `SLOW_DELIVERY_MS` (3000), `SLOW_NORMALIZE_MS` (1000), `SLOW_QUEUE_WAIT_MS` (5000), `SLOW_RELAY_LAG_MS` (3000), `COLD_START_WINDOW_S` (60),
`EVENT_LOOP_LAG_P99_MS` (200). `total_ms` > ngưỡng → thêm `cause=slow.*` theo chặng lớn nhất; dòng đó luôn được ghi đủ (không lấy mẫu).

**`slow.cold_start`**: `process.uptime() < COLD_START_WINDOW_S` và request là request thứ nhất của tiến trình (cờ bộ nhớ). `process.uptime()` miễn phí. Edge nginx đã log `rt` (`docs/DEPLOYMENT.md:164`): `rt − total_ms` lớn = thời gian ở proxy/khởi động, ghi chú trong hướng dẫn đọc log.
**`slow.hub_cpu`**: `perf_hooks.monitorEventLoopDelay()` lấy mẫu liên tục trong bộ nhớ, đọc p99 mỗi `metrics.tick` (5s) → cờ bộ nhớ; không tốn truy vấn.

---

## 4. Truyền ngữ cảnh để làm Traces sau (không triển khai OTel đợt này)

**Nguyên tắc: không đổi schema DB.** `correlation_id` UUID đã lưu (`events.correlation_id`, `schema.prisma:551`), payload outbox là JSON, AMQP có header.

| Chặng | Hiện nay | Thiết kế | Đổi schema? |
|---|---|---|---|
| Request vào `/hooks` | `correlationId` UUID (`ingest.service.ts:263`); không `x-request-id` | `trace_id` = `correlationId` bỏ `-`; nếu request có header `traceparent` hợp lệ thì **dùng trace_id của nó** (và lưu `correlationId` = UUID dựng từ 32 hex đó). `/hooks`: sinh mới, không tin `x-request-id` | không |
| `raw_events` + `outbox` | `outbox.payload.correlationId` | thêm vào payload JSON: `traceparent` (`00-<trace>-<span_ingest>-01`) và `ingestMs`/`ingestedAt` | **không** (JSON) |
| Relay → AMQP | header `x-correlation-id` (`:139`) | thêm header `traceparent`, thuộc tính `timestamp` (ms), header `x-outbox-age-ms`; giữ `x-correlation-id` (tương thích ngược) | không |
| Normalize | `correlationId` trong payload; ghi `events.correlation_id` | đọc `traceparent` từ header; span con `normalize`; ghi lại `traceparent` mới (span normalize) vào payload outbox `delivery.requested` | không |
| Delivery message | `DeliveryMessage` **chỉ cho phép 7 khoá** (`DELIVERY_MESSAGE_KEYS`, S1-1/ADR-042: gọn, không bí mật) | **không** thêm vào body message; `traceparent` đi bằng **header AMQP** (như `x-circuit-deferred-since`). `freshAttemptHeaders` (`delivery.consumer.ts:148`) phải **giữ** `traceparent` qua các tầng retry | không |
| Gọi đích (Standard Webhooks push) | ký `webhook-id/timestamp/signature` | thêm header `traceparent` ra đích (W3C chuẩn, vô hại; **không** nằm trong chuỗi ký). Đích có OTel sẽ nối được trace; đích không hiểu thì bỏ qua | không |
| `x-request-id` của dev | chỉ `/v1/p/*`, `/api/v1/*` | giữ nguyên là id *dev thấy*; `request_id` được log cùng `trace_id` ở mọi dòng của request đó → dev báo `requestId`, Admin tra ra `trace_id`, rồi theo `trace_id` qua worker | không |

**Ranh giới bất biến**
- BB-1: log/trace có `event_name` (kiểu chuẩn) nhưng **không** `orderCode` hay trường nghiệp vụ nào. Không log `data` của event.
- BB-3: `trace_id` được sinh **trước** COMMIT, ACK sau COMMIT như cũ; ghi log `ingest.done` **sau** quyết định ACK, không làm chậm/đổi thứ tự.
- BB-5: `tenant_id` là thuộc tính; hạ tầng log **không** là đường đọc dữ liệu mới (không query DB để làm giàu log).
- BB-4: ngữ cảnh đi qua broker (header), không qua bộ nhớ chung hay Redis.
- Mất ngữ cảnh (message cũ, replay thủ công) → worker sinh `trace_id` mới và log `trace_origin:"orphan"`, không bao giờ lỗi vì thiếu header.

**Retry vs. replay.** Cùng một delivery qua các tầng retry (10s…2h) = **cùng trace** (một chuỗi nhân quả). **Replay** (`delivery.replayed`, `api.controller.ts:718,836`) do con người kích hoạt, có thể sau nhiều ngày = **trace MỚI** có *link* về trace gốc: header `x-replay-of: <trace_id gốc>` (span link theo OTel; trace dài nhiều ngày vô dụng khi đọc) và `replay_of` trong canonical line. Điều kiện: kiểm ở giai đoạn 2 xem `api.controller` đã sinh `correlationId` mới cho replay chưa — nếu dùng lại thì đổi sang sinh mới + giữ gốc ở `replay_of`.

Chuẩn bị OTel (đợt sau): `trace_id/span_id` định dạng W3C ⇒ OTel SDK (NestJS auto-instrument HTTP, `amqplib`, `pg`/Prisma) cắm vào mà **không đổi khuôn log**: chỉ lấy `trace_id/span_id` từ context OTel thay vì tự sinh. Exporter tắt mặc định (`OTEL_ENABLED=0`) để không tốn quota Render free.

---

## 5. An toàn dữ liệu

- **Cấm tuyệt đối trong log:** `body_raw`/body event, `data` của event, secret (`whsec_`, `hk_live_…`, signing secret, token), **giá trị** header chữ ký, số tài khoản, URL đích có query/token. Cho phép: tên header, độ dài, `sha256` cắt 8 hex để đối chiếu (như DLQ `delivery.consumer.ts:76`), `bytes`, host của đích (không path/query).
- `err.msg` luôn qua `scrubSecrets`; `redact` của pino (`logger.ts:13`) là lưới an toàn thứ hai — **không** thay cho việc không đưa dữ liệu vào. Lỗi Prisma chứa tham số truy vấn: chỉ lấy `code` + tên model, không lấy `message` nguyên văn của `PrismaClientKnownRequestError` cho `err.msg`.
- Test hợp đồng (§9) có một "bãi mìn": request chứa `whsec_…`, chuỗi giống số tài khoản, header chữ ký → quét toàn bộ output log, không được xuất hiện.
- Mặc định `LOG_LEVEL`: local=`debug`, deployed=`info`. `debug` không bao giờ có trong đường nóng production.

---

## 6. Chi phí & hạn mức

| Rủi ro | Cách |
|---|---|
| Thành công lưu lượng cao | `ingest.done`/`delivery.attempt` thành công: **lấy mẫu** `LOG_SUCCESS_SAMPLE` (mặc định 0.1 deployed, 1 local) + **đếm** thay vì ghi (metric đã có). **Lỗi, chậm, hoãn, DEAD: luôn ghi** |
| Bão log lặp | Gộp theo `(cause, source_id\|destination_id)` ≤ 1 dòng / `LOG_DEDUPE_WINDOW_MS` (mặc định 30s), kèm `suppressed: n` — đúng cách normalize đã làm (`normalize.consumer.ts:191-194`). Bộ nhớ trần (LRU ≤ 1000 khoá) |
| Request bị chặn trong ban | **không** ghi từng request; `growth.window` + `suppressed` đủ (đã có metric `hub_ingest_penalty_blocked_total`) |
| Dung lượng log Render free | Dòng thành công ~300–400 byte; ước 10 req/s × 10% ≈ 3.5 MB/giờ. Edge access log đã có (`DEPLOYMENT.md:164`) — **không** nhân đôi thông tin đó trong app log |
| Upstash/Redis quota | Log **không** chạm Redis. Lấy mẫu/dedupe/cờ cold-start/event-loop đều trong bộ nhớ |
| DB | Log **không** truy vấn DB để làm giàu |
| Đồng bộ | pino ghi đồng bộ stdout; nếu đo thấy ảnh hưởng p95 thì `pino.destination({ sync:false })` — quyết bằng số liệu local (k6), không đoán |

---

## 7. Nối với metrics

Cardinality: `cause` ≈ 30 giá trị, **không** thêm `tenant_id`, `source_id`, `destination_id` làm nhãn.

| Metric hiện có (file) | Đề xuất |
|---|---|
| `hub_ingest_requests_total{provider,outcome}` (hub-api `metrics.ts`) | thêm nhãn `cause` (chỉ khi ≠ ok; dòng ok để `cause=""`) |
| `hub_deliveries_total{destination_type,status}` (`hub-worker/src/metrics.ts`) | thêm nhãn `cause` |
| `hub_deliveries_deferred_total{reason}` | giữ `reason`; đồng nhất giá trị với `slow.deferred_*` (`circuit\|throttle\|ramp\|infra\|backpressure`) |
| `hub_normalize_schema_errors_total{source}` | đổi/thêm: đếm theo `cause=wrong.schema_mismatch` (nhãn `source` là provider đã đăng ký, không phải source_id) |
| `hub_delivery_infra_errors_total{kind}`, `hub_normalize_retries_total` | giữ; thêm `err_code` cho `kind=transient`? **Không** — để `err.code` ở log |
| `hub_ingest_duration_seconds{provider}`, `hub_delivery_duration_seconds`, `hub_delivery_handle_seconds` | giữ; **thêm** `hub_stage_duration_seconds{svc,stage}` (histogram, `stage` ∈ enum §3.2 — cố định, ≈ 12 giá trị) |

**Metric mới (chỉ tên + nhãn):**
- `hub_log_events_total{svc,msg,cause}` — mỗi canonical line đã **ghi hoặc bị lấy mẫu bỏ** đều đếm (để số trên Grafana không phụ thuộc mẫu).
- `hub_slow_total{svc,cause}` — số lần vượt ngưỡng chậm theo nguyên nhân.
- `hub_queue_wait_seconds{queue}` (histogram) — `queue` là tên hàng đợi cố định.
- `hub_event_loop_lag_seconds` (gauge, p99) — phục vụ `slow.hub_cpu`.
- `hub_growth_total{cause}` — mỗi cửa sổ `growth.window` kích hoạt.

Cảnh báo (Prometheus/Alertmanager, do agent monitoring sở hữu `infra/**`): quy tắc nên nhóm theo `cause` có **Page?=có** (§2). Mapping alert cũ (`ALERT_RULES`, `alert.evaluator.ts`) → cause đặt cạnh `causes.ts`, không bảng riêng.

> Lưu ý: `hub-worker/src/metrics.ts` đang bị agent khác sửa — **chờ** (§10).

---

## 8. Hai đối tượng đọc: Admin (log) và dev khách (khuôn lỗi)

| | Admin vận hành hub | Dev khách |
|---|---|---|
| Kênh | log JSON / metric / (sau này) trace | JSON lỗi `{error,message,fix,docsUrl,requestId}` (`docs/ERRORS.md`), console |
| Chi tiết | có `cause`, `blame`, `stage_ms`, `err.class/code` | `error` ổn định + `fix` tiếng Anh; **không** lộ stack, `blame` nội bộ, `err.msg` |
| Nối nhau | `request_id` ↔ `trace_id` trong cùng dòng | `requestId` trong body/header |

**Một nguồn sự thật, không hai bảng.** `libs/common/src/causes.ts` là bảng duy nhất:
```
CAUSES[cause] = { group, blame, hubFault, page, next, error?: <mã ở ERRORS.md>, reason?: <khoá trong REASON_CODES (stages.ts)> }
```
- Chiều log → khách: dòng log mang `cause`; `ERRORS.md` vẫn là nguồn của `message/fix`. `causes.ts` chỉ **tham chiếu** `error`/`reason` (không chép chữ). Console đã có `REASON_CODES` (`libs/common/src/flow/stages.ts:50-70`, cột "Hỏng ở") → giai đoạn 2 thêm `cause` + nhãn `blame` vào `StageReason`, **không** tạo catalog thứ ba.
- Test đồng bộ (RED→xanh): (a) mọi `REASON_CODES` key được một `cause` tham chiếu hoặc ghi rõ `exempt`; (b) mọi `error` tham chiếu có mục trong `ERRORS.md`; (c) mọi `cause` đều có `blame` và `next` không rỗng.
- Đề xuất cho console (chỉ đề xuất, không làm ở đợt này): trang chi tiết sự kiện/delivery hiện `cause` + `blame` + `stage_ms` thành thanh waterfall (đã có `durationMs/offsetMs` trong `StageView`); dev thấy "Đích của bạn trả 5xx — xem `fix`", Admin thấy thêm `blame`. Chỉ hiển thị cho dev các cause có `blame ≠ hub/ha_tang`; với lỗi hub chỉ hiện `requestId` (đúng nguyên tắc `internal_error` ở ERRORS.md).

---

## 9. Ví dụ dòng log (đã rút gọn trường nền; không có dữ liệu thật)

**(a) Ingest chậm do DB** — `db_commit` chiếm 1.9 s / 2.04 s:
```json
{"ts":"2026-10-18T03:14:07.512Z","level":"warn","svc":"hub-api","msg":"ingest.done","trace_id":"3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7","span_id":"a1b2c3d4e5f60718","tenant_id":"prj_8c2f","source_id":"src_41ad","provider":"payos","outcome":"accepted","http_status":202,"cause":"slow.db","blame":"ha_tang","total_ms":2043,"stage_ms":{"verify":1,"redis":4,"db_commit":1931,"ack_build":0,"other":107},"bytes":912,"raw_event_id":"b8d1…"}
```
**(b) Delivery lỗi do đích 5xx** (lần 2/6, còn retry):
```json
{"ts":"2026-10-18T03:20:44.090Z","level":"warn","svc":"hub-worker","msg":"delivery.attempt","trace_id":"3f2a9c1e5b7d4a08b6c1d2e3f4a5b6c7","span_id":"0f1e2d3c4b5a6978","tenant_id":"prj_8c2f","delivery_id":"d_77e0","destination_id":"dst_93bc","event_name":"payment.paid","attempt":2,"outcome":"retry","cause":"fail.dest_5xx","blame":"dich","http_status":503,"total_ms":412,"stage_ms":{"queue_wait":3,"deliver_prep":18,"dest_http":371,"db_persist":20},"err":{"class":"HttpError","code":"HTTP_5xx","msg":"503 Service Unavailable"},"next_queue":"q.delivery.retry.1m"}
```
**(c) Delivery chậm do queue_wait** (đích nhanh, hub tắc ở hàng đợi):
```json
{"ts":"2026-10-18T03:31:02.775Z","level":"warn","svc":"hub-worker","msg":"delivery.attempt","trace_id":"9d0e8f7a6b5c4d3e2f1a0b9c8d7e6f50","span_id":"7c6b5a4938271605","tenant_id":"prj_8c2f","delivery_id":"d_a1c4","destination_id":"dst_93bc","event_name":"repo.push","attempt":1,"outcome":"ok","cause":"slow.queue_wait","blame":"hub","http_status":200,"total_ms":14920,"stage_ms":{"outbox_lag":310,"queue_wait":14380,"deliver_prep":22,"dest_http":181,"db_persist":27}}
```
**(d) Tăng nhanh do một source** (cửa sổ 60 s):
```json
{"ts":"2026-10-18T03:40:00.003Z","level":"warn","svc":"hub-api","msg":"growth.window","tenant_id":"prj_8c2f","source_id":"src_41ad","provider":"payos","cause":"growth.burst_source","blame":"provider","window_s":60,"count":5120,"baseline_per_min":180,"factor":28.4,"duplicate_ratio":0.91,"hint":"wrong.duplicate chiếm 91%: provider đang bắn lặp"}
```

---

## 10. Kế hoạch giai đoạn 2

**Trạng thái xung đột (nhánh `fix/health-live-ready`, 2026-10-18):** agent health sửa `apps/hub-api/src/modules/health/**`, `apps/hub-worker/src/{main.ts,metrics.ts,scheduler/outbox.relay.ts}`, `docs/DEPLOYMENT.md`, `.env.example`; agent monitoring sửa `docker-compose.yml`, `prometheus.yml`, `infra/**`, `docs/MONITORING.md`.

| # | Bước | File | Xung đột? |
|---|---|---|---|
| 0 | **RED trước:** test hợp đồng (bảng dưới) — viết fail | `apps/hub-api/test/log-contract.spec.ts`, `apps/hub-worker/test/log-contract.spec.ts`, `libs/common/test/causes.spec.ts` | không |
| 1 | `causes.ts` (enum + bảng), `slow-thresholds.ts`, `log-line.ts` (builder `canonicalLine()`, redaction, dedupe, mẫu), `trace-context.ts` (parse/format `traceparent`, `trace_id` từ `correlationId`); `logger.ts` thêm `base: {svc}` | `libs/common/src/**` | không |
| 2 | Ingest: bọc đồng hồ + một dòng `ingest.done` cho mọi outcome (gồm từ chối) | `apps/hub-api/src/modules/ingest/ingest.service.ts`, `body-parsers.ts` (hook lỗi parser), `penalty-gate.ts` | không |
| 3 | Đóng `traceparent`/`ingestedAt` vào payload outbox | `ingest.service.ts` (`OutboxPayload` ở `libs/common/src/types.ts`) | không |
| 4 | Relay đóng `timestamp`, `x-outbox-age-ms`, `traceparent` | `apps/hub-worker/src/scheduler/outbox.relay.ts` | **CHỜ** (agent health) |
| 5 | Normalize: `normalize.done`, `queue_wait`, tách `wrong.schema_mismatch` khỏi `fail.hub_unknown` | `normalize.consumer.ts`, `normalize-errors.ts` | không |
| 6 | Delivery: `delivery.attempt` cho mọi nhánh (thất bại có `status/err`), `x-due-at`, giữ `traceparent` ở `freshAttemptHeaders`, gửi `traceparent` ra đích | `delivery.consumer.ts`, `senders/webhook.sender.ts`, `circuit-breaker.service.ts` (thêm `destination_id`/lỗi gây mở) | không |
| 7 | `growth.window` (bộ đếm trong bộ nhớ trên `traffic-recorder`/consumer; không Redis) + gắn `cause` vào alert evaluator | `traffic-recorder.ts`, `alert.evaluator.ts`, `storage-alerts.ts` | không |
| 8 | Metric: nhãn `cause` + metric mới ở §7 | `apps/hub-api/src/modules/metrics/metrics.ts`; `apps/hub-worker/src/metrics.ts` | hub-api: không; **worker metrics.ts: CHỜ** (agent health) |
| 9 | Khởi động: event-loop monitor, tick `metrics.tick` đọc | `apps/hub-worker/src/main.ts`, `apps/hub-api/src/main.ts` | **worker main.ts: CHỜ** |
| 10 | Env + tài liệu: thêm biến §3.2/§6 vào `.env.example`; mục "log" ở `DEPLOYMENT.md`; `docs/ERRORS.md` thêm tham chiếu `cause` | `.env.example`, `docs/DEPLOYMENT.md` | **CHỜ** |
| 11 | Console (đề xuất §8) | `apps/web/**` | tách đợt riêng |

**Test hợp đồng log (RED → xanh), mỗi đường lỗi phải phát đúng `cause`:**
| Test | Kỳ vọng |
|---|---|
| chữ ký sai | `ingest.done` `outcome=rejected`, `cause=wrong.signature`, không có chữ ký trong output |
| source lạ | `wrong.unknown_source` |
| body 413 / rỗng | `wrong.payload_shape` |
| bị hộp phạt chặn | `wrong.policy_blocked` + `suppressed` (không 1 dòng/request) |
| trùng (Redis hit / P2002) | `wrong.duplicate`, **0 lệnh Redis thêm** |
| PG ném `P2024` giữa tx | `fail.hub_db` + `err.code=P2024`, HTTP 503 `unavailable` |
| mock đồng hồ DB chậm | `slow.db` (ngưỡng `SLOW_INGEST_MS` từ env) |
| delivery: đích 500 / timeout / ECONNREFUSED / 429 / 400 | `fail.dest_5xx` / `fail.dest_timeout` / `fail.dest_network` / `fail.dest_overload` / `wrong.config_dest_4xx` |
| lần thứ 6 thất bại | `fail.exhausted`, `last_cause` đúng |
| message `delivery.attempt` có `queue_wait` lớn (mock `timestamp` AMQP) | `slow.queue_wait`; retry tầng 1m **không** bị tính là `queue_wait` |
| circuit OPEN / throttle / backpressure spill | `slow.deferred_circuit` / `_throttle` / `_backpressure`, `defer_ms` có giá trị |
| normalize adapter ra sai khuôn | `wrong.schema_mismatch` ≠ `fail.hub_unknown` |
| message hỏng | `fail.poison_message` |
| `traceparent` | ingest→outbox→AMQP header→normalize→delivery→header gửi đích: **cùng `trace_id`**, `span_id` khác nhau; retry tầng 2 giữ `trace_id`; replay có `trace_id` mới + `replay_of` |
| **ngân sách** | `redis-budget.spec.ts` vẫn xanh (không lệnh mới); không truy vấn DB mới (đếm qua spy Prisma) |
| **an toàn** | bãi mìn §5: không `whsec_`, số tài khoản, chữ ký, body trong output |
| đồng bộ bảng | `causes.spec.ts` (a)(b)(c) ở §8 |
| lấy mẫu | thành công 1000 lần → ≈ `LOG_SUCCESS_SAMPLE`, `hub_log_events_total` vẫn đếm đủ 1000; lỗi 100% được ghi |

**Ước lượng:** 0–1 ≈ 0.5 ngày · 2–3 ≈ 0.5 ngày · 5–7 ≈ 1 ngày · 8–10 ≈ 0.5 ngày (phần CHỜ) · đo local (k6: p95 ingest trước/sau, §6 "đồng bộ") ≈ 0.25 ngày. Tổng ≈ 2.5–3 ngày dev + review.

**Câu hỏi cần Admin chốt:** (1) `trace_id` = `correlationId` bỏ `-` (đề xuất, không đổi schema) hay sinh riêng; (2) mặc định lấy mẫu thành công 10% ở deployed có đủ cho Admin; (3) ngưỡng mặc định ở §3.2; (4) replay = trace mới + link (đề xuất) hay cùng trace.
