# LOGGING — log phải tự nói "chậm / sai / tăng nhanh vì đâu"

> Trạng thái: **ĐÃ TRIỂN KHAI giai đoạn 2A (2026-10-18, ADR-254/255)** cho log + `cause` + trace_id + metric + `x-hub-cold` (§1–§10, bước 0–11 và 13). **Chưa làm (đợt 2B):** Sentry backend/frontend (§11, bước 12/14/15) và console (§8, bước 11). Chi tiết đã làm / còn lại / chỗ lệch thiết kế: **§12**. Các mục §1 (Audit) mô tả hiện trạng TRƯỚC giai đoạn 2A.
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
- **Đã triển khai (review 2A):** `formatters.log` của pino scrub đệ quy chuỗi trong object/mảng (sâu ≤ 8, ≤ 60 phần tử, ≤ 200 khoá); mọi lỗi đi qua `errInfo`; URL trong `err.msg` chỉ giữ host (bỏ userinfo/path/query). Giới hạn: bí mật không theo mẫu (`whsec_`, `hk_`, Bearer, số dài) nằm trong văn bản tự do thì không phát hiện được — nên không đưa dữ liệu vào log ngay từ đầu.
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
| 12 | **Sentry backend** (SAU khi chốt `trace_id` + canonical line, bước 1–3, 6): `reportUnexpected` + `beforeSend` dùng chung `redact`; `instrument.ts` hai tiến trình; tag §11.4; chống bão §11.3; test "không lọt" §11.2; đo RSS (11.5c) | `libs/common/src/sentry.ts` (mới), `apps/hub-api/src/main.ts`, `service-exception.filter.ts`, `apps/hub-worker/src/consumers/*.ts`, `docker/hub-all.js` (chỉ truyền env) | `hub-worker/src/main.ts`: **CHỜ** |
| 13 | hub-api: `exposedHeaders: ['x-request-id']` (+ header `x-hub-cold` nếu chọn, 11.9d) | `apps/hub-api/src/cors.ts`, middleware request-id | không |
| 14 | **Sentry frontend** (11.9): `instrumentation-client.ts`, `sentry.*.config.ts`, `global-error.tsx`, `error.tsx`, wrapper fetch gắn `request_id`/`frontend_cause`, `withSentryConfig` (token chỉ ở build Vercel); Replay TẮT; test §11.9e | `apps/web/**` (mới + `next.config.mjs`, `src/lib/**`) | đợt riêng sau bước 12; kiểm docs Next 16 trong `node_modules` |
| 15 | Env + docs Sentry: `SENTRY_DSN_*`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN/ORG/PROJECT_WEB`, `SENTRY_TRACES_SAMPLE_RATE_WEB` | `.env.example`, `docs/DEPLOYMENT.md`, `apps/web/vercel.json` | **CHỜ** |

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

**Ước lượng (chưa tính Sentry; Sentry backend ≈ 0.5–1 ngày, frontend ≈ 1–1.5 ngày kể cả test không-lọt):** 0–1 ≈ 0.5 ngày · 2–3 ≈ 0.5 ngày · 5–7 ≈ 1 ngày · 8–10 ≈ 0.5 ngày (phần CHỜ) · đo local (k6: p95 ingest trước/sau, §6 "đồng bộ") ≈ 0.25 ngày. Tổng ≈ 2.5–3 ngày dev + review.

**Câu hỏi cần Admin chốt:** (1) `trace_id` = `correlationId` bỏ `-` (đề xuất, không đổi schema) hay sinh riêng; (2) mặc định lấy mẫu thành công 10% ở deployed có đủ cho Admin; (3) ngưỡng mặc định ở §3.2; (4) replay = trace mới + link (đề xuất) hay cùng trace.


---

## 11. Sentry — bắt exception bất ngờ kèm stack trace (Admin chốt 2026-10-18; THIẾT KẾ, chưa code; ADR-251)

### 11.1 Phân vai (log ≠ Sentry)

| | Log + `cause` (§2) | Sentry |
|---|---|---|
| Bắt cái gì | Lỗi **ĐÃ BIẾT tên** (có trong enum) | Lỗi **CHƯA biết tên**: exception bất ngờ, kèm stack |
| Điều kiện đẩy | luôn (theo mức/lấy mẫu §6) | **Chỉ khi `blame = hub`** và là exception chưa phân loại: `fail.hub_unknown`, `fail.poison_message`, `wrong.schema_mismatch` khi nghi bug adapter, `catch` ngoài cùng, `unhandledRejection`/`uncaughtException`, lỗi render apps/web |
| **KHÔNG đẩy** | — | đích 5xx/timeout/4xx, chữ ký sai, nguồn lạ, trùng, hộp phạt, rate limit, DB/Redis/broker rớt tạm thời (`fail.hub_db`, `fail.hub_broker`, `fail.hub_redis` — đã có metric + cảnh báo; chỉ đẩy nếu `classifyInfraError` = `unknown`). Lý do: nhiễu và đốt hạn mức free |

Cơ chế: **một cửa duy nhất** `reportUnexpected(err, ctx)` trong `libs/common` (không gọi `Sentry.captureException` rải rác). Hàm nhận `cause`, tra `CAUSES[cause].blame`, chỉ gửi khi `blame === 'hub'` và `cause` thuộc nhóm "chưa biết". Test hợp đồng: mọi `cause` có `blame ≠ hub` → `captureException` không bao giờ được gọi (spy).
`SentryGlobalFilter` mặc định của `@sentry/nestjs` bắt **mọi** exception → **không dùng nguyên trạng**: hub-api đã có `service-exception.filter.ts` (4xx/503 có chủ đích). Gắn `reportUnexpected` vào nhánh `status >= 500 && !== 503` của filter đó (đúng chỗ đang `logger.error` "Lỗi máy chủ", `service-exception.filter.ts:28`), không thêm filter thứ hai (SDK có `@SentryExceptionCaptured()` cho trường hợp đã có catch-all).

### 11.2 An toàn dữ liệu (Sentry là dịch vụ ngoài: dữ liệu RỜI hệ thống)

- Mặc định **chỉ gửi stack + tag**: tắt request body, cookie, header, query; không user/IP (`sendDefaultPii:false`). Tài liệu NestJS ghi SDK mới **gửi HTTP body/query và IP/user id theo mặc định** (điều khiển bằng `dataCollection`) → phải tắt tường minh và **chứng minh bằng test**, không tin mặc định (xem 11.8).
- `beforeSend` + `beforeBreadcrumb` dùng **chung** `scrubSecrets`/`LOG_REDACT_OPTIONS` (`libs/common/src/auth/redact`) — một bộ luật, không bản thứ hai. Xoá: `body_raw`/body, `Authorization`, header chữ ký (`*signature*`, `webhook-signature`, `x-hub-signature*`, `stripe-signature`), API key (`hk_live_…`), `whsec_…`, token, cookie, chuỗi giống số tài khoản, URL đích có query. **Allowlist** (không phải denylist) cho `extra/contexts`: chỉ khoá nằm trong danh sách (`cause, blame, svc, stage, attempt, destination_type…`), khoá lạ bị bỏ.
- Lỗi Prisma có thể chứa tham số truy vấn → thay bằng `code` + model (như §5).
- Tắt breadcrumb `console`, body của `http`/`fetch`; không `includeLocalVariables` (biến cục bộ có thể chứa secret); `maxValueLength` 200; apps/web không session replay/profiling.
- **Test chứng minh không lọt (RED trước):** thay transport bằng giả; ném lỗi mang `whsec_…`, `Authorization: Bearer …`, header chữ ký, body có số tài khoản, `body_raw` base64 → toàn bộ envelope gửi đi **không chứa** các chuỗi đó (quét cả JSON). Test thứ hai: DSN trống → `Sentry.init` không được gọi, không gắn handler toàn cục nào.
- apps/web: `beforeSend` bỏ `request.headers/cookies/data`, cắt query; source map upload lúc build rồi **ẩn khỏi bundle công khai**.

### 11.3 Chống bão retry

- **Không capture trong vòng lặp retry từng delivery.** Lỗi đích vốn không đẩy. Lỗi lạ ở nhánh `unknown` (`delivery.consumer.ts:654-693`): chỉ capture khi `unknownErrors === 1` và khi vào DLQ, không capture mỗi lần hoãn 1 phút.
- Gom nhóm: `fingerprint = [svc, cause, err.class, err.code, chặng]` (không chứa message/id) → một vấn đề = một issue dù xảy ra 10 000 lần.
- Giới hạn phía hub trước khi tới SDK: `SENTRY_MAX_PER_MIN` (mặc định 10/tiến trình) + dedupe theo fingerprint trong `SENTRY_DEDUPE_WINDOW_MS` (mặc định 5 phút), đếm trong bộ nhớ; phần bị bỏ ghi `suppressed: n` vào log và metric `hub_sentry_events_total{svc,result=sent|dropped}`.
- Không đặt `tracesSampleRate` (không bật tracing Sentry — §11.5). `ignoreErrors`: `ECONNRESET`, `EPIPE`, abort của client.
- `flush` lúc shutdown ≤ 2 s, nằm **trong** `SHUTDOWN_TIMEOUT_MS=25000`.

### 11.4 Thẻ gắn kèm (nhảy Sentry → log)

`release` = git sha (build arg → `SENTRY_RELEASE`, cùng sha với image/Render/Vercel); `environment` = `local|deployed`; tag `svc` (`hub-api|hub-worker|web`), `cause`, `blame`, `request_id`, `trace_id` (W3C 32 hex — **cùng** `trace_id` của §3/§4; tra log bằng `trace_id`), `tenant_id` (qua allowlist). Đặt bằng `Sentry.withScope` quanh một lần `reportUnexpected`; **không** `setUser`. Chiều ngược lại: canonical line của lần lỗi có `sentry_event_id` (chỉ khi đã gửi).

### 11.5 Quan hệ với Traces — tra tài liệu chính thức (ngày tra 2026-10-18)

| Điều cần biết | Kết quả | Nguồn / mức chắc chắn |
|---|---|---|
| SDK Node có xây trên OpenTelemetry? | **Một phần.** Từ v8 Sentry "replaced parts of our Node SDK with OTel" (không phải toàn bộ). Docs hiện hành: "The Sentry JavaScript SDK creates and sends spans without an OpenTelemetry pipeline"; với app đã dùng OTel có hai chế độ: *capture span từ OTel API* hoặc *dùng pipeline OTel riêng* | blog.sentry.io/sentry-javascript-v8-sdk-otel-and-node-support (27/06/2024); docs.sentry.io/platforms/javascript/guides/node/opentelemetry/ — **đã xác minh** |
| Có tracing/propagation riêng? | **Có.** Propagate `sentry-trace` + `baggage`; Node ≥ 8.0.0 "distributed tracing will work out of the box"; `strictTraceContinuation` từ v10. Trang đó **không** nhắc `traceparent` | docs.sentry.io/…/node/tracing/distributed-tracing/ — **đã xác minh** |
| Hiểu W3C `traceparent`? | Có tuỳ chọn `propagateTraceparent` (browser SDK: PR #17509, 09/2025; chuyển vào base options + propagator OTel: PR #18476, 12/2025) — thêm `traceparent` **bên cạnh** `sentry-trace`/`baggage`. **Chưa xác minh:** bản phát hành đầu tiên; Node SDK có **nhận** `traceparent` đến không (PR còn nhận xét về `fields()` của propagator, chưa rõ đã sửa) | github.com/getsentry/sentry-javascript/pull/17509, /18476 — **một phần** |
| Chạy chỉ-lỗi? | Không đặt `tracesSampleRate` → tracing tắt. `openTelemetryIntegration` (docs ghi "since v11.0.0") dành cho khi **OTel sở hữu tracing**: gắn lỗi Sentry vào span OTel đang chạy, không gửi span | docs.sentry.io/…/configuration/integrations/opentelemetry/; PR docs #12006 — đã xác minh |
| Sentry có buộc ta đổi hướng Traces? | **Không.** Hướng của họ: OTel làm pipeline chính, Sentry gắn vào. Quyết định: **Sentry chỉ làm lỗi** (tracing Sentry tắt); `trace_id` W3C ở §4 là nguồn sự thật. Khi OTel vào đợt sau, bật `openTelemetryIntegration` (nếu bản SDK hỗ trợ) để lỗi gắn đúng `trace_id` → **không làm lại thiết kế trace_id**. Trước đó Sentry tự gán trace_id riêng cho mỗi sự kiện nên ta **ép tag `trace_id` của hub** (11.4); UI Sentry tạm có hai khái niệm trace_id | suy luận từ các dòng trên |

**Chưa xác minh (phải kiểm khi code, ghi vào ADR nếu khác):** (a) phiên bản `@sentry/node`/`@sentry/nestjs` sẽ cài và `openTelemetryIntegration` có trong bản đó không; (b) SDK Node có thể đặt trace_id của scope = trace_id của ta (`continueTrace` với `sentry-trace` dựng từ `traceparent`) — nếu được thì khỏi cần tag riêng; (c) khi `tracesSampleRate` không đặt, SDK có còn tự cài instrumentation OTel (tốn RAM trên Render free) — **đo RSS trước/sau** ở local.

### 11.6 Vị trí khởi tạo

| Tiến trình | Cách |
|---|---|
| hub-api | `instrument.ts` import **đầu tiên** của `main.ts`, trước `@nestjs/core` (đúng yêu cầu docs NestJS), gọi `initSentry('hub-api')`. **Không đụng** `NestFactory.create(AppModule, { rawBody: true })` (cạm bẫy #1) và không thêm middleware đọc body. Không dùng `SentryModule.forRoot()` nếu nó thêm interceptor/handler đọc request (kiểm trước); tối thiểu chỉ `reportUnexpected` ở filter hiện có |
| hub-worker | `instrument.ts` riêng, `initSentry('hub-worker')`; capture ở `catch` ngoài cùng của consumer + `unhandledRejection`; fire-and-forget, không chặn ack/nack |
| **hub-all** (`docker/hub-all.js` chạy **hai tiến trình** hub-api + hub-worker, ADR-129) | mỗi tiến trình init **riêng** với DSN riêng → BB-4 giữ (hai process, không chia sẻ trạng thái); supervisor và nginx không init Sentry |
| apps/web | `instrumentation.ts` + cấu hình client của `@sentry/nextjs`, chỉ lỗi; không tracing/replay; không `tunnelRoute` |

BB-3: `reportUnexpected` chạy **sau** quyết định ACK / ack-nack, `catch` bên trong, không `await` trên đường nóng. Sentry không dùng Redis/DB, không truy vấn thêm để làm giàu sự kiện; `redis-budget.spec.ts` giữ xanh. DSN trống → `initSentry` return ngay và **không import SDK** (`await import()` có điều kiện) → no-op hoàn toàn.

### 11.7 Biến môi trường và hạn mức

| Biến | Dùng cho | Ghi chú |
|---|---|---|
| `SENTRY_DSN_HUB_API`, `SENTRY_DSN_HUB_WORKER`, `SENTRY_DSN_WEB` | runtime từng tiến trình | **trống = no-op hoàn toàn** (mặc định local/test) |
| `SENTRY_RELEASE`, `DEPLOY_ENV` | tag release/environment | build arg git sha |
| `SENTRY_MAX_PER_MIN`, `SENTRY_DEDUPE_WINDOW_MS` | §11.3 | |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT_WEB` | **chỉ build apps/web** (upload source map) | secret CI/Vercel; không có ở runtime hub-api/worker |

**Hạn mức free — chỉ số đã xác minh từ sentry.io/pricing (2026-10-18):** gói Developer có **5k errors**, **5M spans** (không dùng, tracing tắt), **1 user**, tra cứu **30 ngày**. Trang không nêu chu kỳ của 5k errors (chưa xác minh là mỗi tháng) → không ghi. Hệ quả: 5k là ít, nên cổng `blame = hub` + dedupe/fingerprint là bắt buộc, không phải tối ưu.

### 11.8 Nguồn và phần chưa xác minh

Đã đọc 2026-10-18: docs.sentry.io/platforms/javascript/guides/nestjs/ (gói `@sentry/nestjs`; `instrument.ts` import đầu; `SentryGlobalFilter`/`@SentryExceptionCaptured()`; body/query và user/IP gửi mặc định, tắt bằng `dataCollection`; trang **không** nói về `beforeSend` → phải kiểm bằng test 11.2, không tin tài liệu); …/node/opentelemetry/; …/node/tracing/distributed-tracing/; …/configuration/integrations/opentelemetry/; blog.sentry.io (27/06/2024); GitHub getsentry/sentry-javascript PR #17509, #18476; sentry.io/pricing. Chưa xác minh: 11.5 (a)(b)(c), tên chính xác tuỳ chọn tắt thu body ở bản sẽ cài, chu kỳ hạn mức 5k errors.

### 11.9 Frontend / RUM cho apps/web (console Next.js) — ADR-252

Admin nhấn mạnh: tầng frontend quan trọng ngang backend, vì RUM là nơi **duy nhất** thấy dev bị treo màn hình (cold start Render, CORS, chunk lỗi).
Hiện trạng đã đọc: `apps/web` dùng Next `16.3.8` + React 19 (`apps/web/package.json`); **chưa có** `global-error.tsx`, **chưa có** CSP/`connect-src` (grep không thấy); URL backend lấy từ `NEXT_PUBLIC_HUB_API_URL` (`src/lib/env.ts:6`); `apps/web/AGENTS.md` cảnh báo Next này khác bản quen — **đọc `node_modules/next/dist/docs/` trước khi code**.

#### a) Chỉ số cần thu và công cụ

| Nhu cầu | Cách thu |
|---|---|
| Core Web Vitals: LCP, INP, CLS, TTFB | Sentry browser tracing (web vitals gắn vào span `pageload`/`navigation`) **hoặc** Vercel Speed Insights |
| Exception JS runtime | Sentry (`@sentry/nextjs`): `window.onerror`/`unhandledrejection` + `global-error.tsx` + error boundary từng route |
| Lỗi tải chunk/CDN (`ChunkLoadError`, import động lỗi) | Sentry: bắt riêng, tag `frontend_cause=chunk_load`; gợi ý UI "tải lại trang" (thường do deploy mới xoá chunk cũ) |
| Lỗi CORS/mạng khi gọi hub-api | Wrapper `fetch` của console (một chỗ) bắt `TypeError: Failed to fetch`/timeout → tag `frontend_cause=network\|cors\|timeout\|cold_start`, kèm host (không path/query) — vì trình duyệt **không** cho phân biệt CORS với mạng đứt trong message lỗi, ghi nhãn là `network_or_cors` và đối chiếu bằng log hub-api (có request tới hay không) |

**Một công cụ hay tách đôi — đánh đổi (số đã xác minh 2026-10-18):**

| | Chỉ Sentry (lỗi + vitals) | Sentry (lỗi) + Vercel Speed Insights (vitals) |
|---|---|---|
| Hạn mức | Sentry Developer: **5k errors**, **5M spans**, 1 user, 30 ngày (sentry.io/pricing). Vitals tiêu span (cần `tracesSampleRate`) | Speed Insights free: **10.000 event / 30 ngày cuốn chiếu**, chia sẻ cả team; chạm hạn mức thì Vercel **tạm dừng thu ≥ 14 ngày** (docs Vercel, cập nhật 2026-09-23) |
| Chỉ số free | Đủ LCP/INP/CLS/TTFB trong span | **Gói free chỉ có Real Experience Score (RES)**, không có từng Core Web Vital và không xem 30 ngày — từng CWV (FCP, LCP, INP, CLS, TTFB) cần Speed Insights **Plus** (chỉ Pro/Enterprise, $10/project/tháng) |
| Rủi ro điều khoản | Không | **Vercel Hobby giới hạn "non-commercial personal use only"** (Fair Use Guidelines). Nếu hub được coi là sản phẩm có tiền/doanh nghiệp thì phải lên Pro — rủi ro chung của việc deploy console trên Hobby, không riêng Speed Insights |
| Nối lỗi ↔ vitals ↔ backend | Cùng một `trace_id`/release/tag, một chỗ xem | Hai công cụ, không nối được trace_id |
| Dữ liệu rời hệ thống | Một bên thứ ba | Hai bên thứ ba |

*Chưa tự xác minh:* con số "Vercel Analytics 50.000 event/tháng" do coordinator nêu — không có trong trang tôi đọc (chỉ đọc trang Speed Insights và Fair Use), nên **không** dùng làm cơ sở; kiểm `vercel.com/docs/analytics/limits-and-pricing` trước khi cân nhắc Web Analytics.

**Khuyến nghị: MỘT công cụ — Sentry — cho cả lỗi và vitals; không thêm Speed Insights ở đợt đầu.** Lý do: (1) gói free của Speed Insights **không cho từng Core Web Vital**, nên không thay được vitals của Sentry; (2) một công cụ giữ được `trace_id` nối frontend → hub-api → worker; (3) ít bên nhận dữ liệu hơn; (4) tránh phụ thuộc Hobby/Pro. Giữ ngưỡng hạn mức: vitals tiêu span → `tracesSampleRate` thấp (11.9c).

#### b) DỮ LIỆU — vùng nguy hiểm nhất

Console hiện secret **một lần** (`SecretOnce`: `whsec_`, API key, connection string chứa key — `src/components/admin/secret-once.tsx`, dùng ở `api-keys/page.tsx`, `endpoint-dialogs.tsx`), payload webhook (`json-viewer.tsx`, `detail-cards.tsx`, `stage-sheet.tsx`), email người dùng. Session Replay ghi DOM → nếu lọt, secret rời hệ thống **vĩnh viễn** (secret chỉ hiện một lần nên mất bảo vệ này là không cứu được ngoài việc rotate).

**Cấu hình bị cấm:** `replayIntegration({ maskAllText: false, blockAllMedia: false })` (mẫu Admin chép từ bài học). Tài liệu Sentry: mặc định `maskAllText=true`, `blockAllMedia=true`, `maskAllInputs=true`; đặt `false` là **tắt bảo vệ có sẵn** "chỉ dùng cho site không có dữ liệu nhạy cảm"; và "trước khi bật Replay ở production, xác minh cấu hình mask" (docs.sentry.io/…/nextjs/session-replay/privacy/, đã đọc 2026-10-18). Hub **không** thuộc loại site không nhạy cảm. Một test (11.9e) cấm chuỗi `maskAllText: false`/`blockAllMedia: false` xuất hiện trong mã.

**Khuyến nghị: TẮT Session Replay hoàn toàn ở đợt đầu** (không đăng ký `replayIntegration`). Lập luận: (1) giá trị chẩn đoán thấp so với rủi ro — lỗi frontend của console đa số tái hiện được từ stack + breadcrumb có kiểm soát; (2) màn hình console là nơi hiện secret một lần, payload thật của khách (dữ liệu bên thứ ba mà dev khách tin hub giữ), email; mask theo selector là danh sách chặn (quên một vùng = lọt), còn tắt là an toàn mặc định; (3) 5k errors/hạn mức nhỏ, replay thêm quota riêng chưa xác minh; (4) có thể bật lại sau khi có kiểm thử mask và nhu cầu thật. **Nếu Admin vẫn muốn bật sau:** `maskAllText:true`, `blockAllMedia:true`, `maskAllInputs:true`, `replaysSessionSampleRate:0`, chỉ `replaysOnErrorSampleRate` thấp (ví dụ 0.1–0.2, đo theo hạn mức), `block: ['[data-sentry-block]', '.sentry-block']`, và **bắt buộc** gắn `data-sentry-block` cho: `SecretOnce` (bao cả nút copy), mọi `JsonViewer`/vùng payload/`detail-cards`, mọi `<input>`/`<textarea>` nhập secret (kèm `data-sentry-mask`), bảng email thành viên, khung connection string; **không** `unmask`/`unblock`; không bật capture body của network.

Cho phần **không phải Replay** (vẫn bật ở đợt đầu):
- `sendDefaultPii:false`; `beforeSend` xoá `request.headers/cookies/data`, `user`, và **cắt URL**: bỏ query và hash (`?token=`, `#…`) cả ở `request.url`, `transaction`, `breadcrumb.data.url`; thay segment giống id/secret bằng `:id`.
- `beforeBreadcrumb`: bỏ breadcrumb `ui.input`/giá trị ô nhập, `console`, và `fetch`/`xhr` chỉ giữ `method`, `status`, host+path đã chuẩn hoá (không body, không query, không header).
- Allowlist cho `extra/contexts/tags` như 11.2; tag của console chỉ: `svc=web`, `release`, `environment`, `route` (pattern, ví dụ `/dashboard/api-keys`), `frontend_cause`, `request_id`, `trace_id`.
- `tracesSampleRate` **thấp** — mẫu bài học 0.2 là điểm xuất phát cao; với 5M spans free và console ít người dùng thì 0.2 chưa vượt, nhưng mỗi pageload/navigation + fetch sinh nhiều span → đặt mặc định **0.1** deployed (`SENTRY_TRACES_SAMPLE_RATE_WEB`, 0 ở local), xem lại sau 1 tuần theo dashboard usage. Dùng `tracesSampler` bỏ qua route tĩnh/`/_next/*`.
- `tracePropagationTargets` = **chỉ** origin của hub-api (`NEXT_PUBLIC_HUB_API_URL`): không gửi header theo dõi cho domain thứ ba.

#### c) Nối với backend (trace_id/request_id)

- **Đi xuống:** `tracePropagationTargets` chỉ hub-api → SDK thêm `sentry-trace` + `baggage` (đã xác minh, 11.5) vào fetch tới hub-api; `traceparent` chỉ khi bật `propagateTraceparent` (một phần xác minh; **chưa biết bản phát hành** — kiểm khi cài). hub-api đã có thể đọc `traceparent` theo §4; nếu Sentry web chỉ gửi `sentry-trace`, hub-api **dịch** `sentry-trace` (`<trace_id 32 hex>-<span_id>-<sampled>`) sang `trace_id` — cùng định dạng 32 hex, nên `trace_id` của frontend = `trace_id` của log hub (giai đoạn 2 cần test).
- **Đi lên:** hub-api trả `x-request-id` cho `/v1/p/*` và `/api/v1/*` (`request-id.ts`) → wrapper `fetch` của console đọc nó, gắn vào scope của sự kiện lỗi (tag `request_id`) → từ Sentry sang log: `grep <request_id>`. **Điều kiện cần đổi ở hub-api:** `corsOptions` (`apps/hub-api/src/cors.ts:11`) **chưa khai `exposedHeaders`**, nên trình duyệt (cross-origin) **không đọc được** `x-request-id`. Thêm **chỉ** `exposedHeaders: ['x-request-id']`. `allowedHeaders` không khai → thư viện cors phản chiếu `Access-Control-Request-Headers` nên `sentry-trace`/`baggage`/`traceparent` đi qua cho **origin đã allowlist**; **không** mở `origin:'*'`, không thêm `credentials` mới, không mở rộng danh sách origin (chỉ `WEB_PUBLIC_URL` + `CORS_ORIGINS`). Preflight thêm header tuỳ chỉnh = mỗi request cross-origin có thể thêm một OPTIONS (chấp nhận; có thể `Access-Control-Max-Age`).
- Tag `trace_id` được SDK web tự có (id của pageload/navigation); khi hub-api trả `x-request-id`, console tag cả hai trên lỗi.

#### d) Cold start Render nhìn từ frontend

hub-api free ngủ sau ~15 phút không có request, thức mất ~1 phút (ADR-240; console có badge realtime `connecting`, ngưỡng 90s ở ADR-243). Ở frontend thấy: request đầu tiên rất chậm (hoặc timeout), TTFB của **fetch tới hub-api** cao, còn TTFB của chính trang Next (Vercel) bình thường.
Phân biệt "cold start" với "chậm vì code" — **chỉ bằng dữ liệu đo được ở trình duyệt, không đoán**:
1. Wrapper `fetch` đo `duration` từng cuộc gọi tới hub-api (span `http.client` đã có) và tag **`hub_phase`**: `first_call_of_session` (cuộc gọi hub-api đầu tiên của tab) hoặc `after_idle` (cách cuộc gọi trước > 10 phút — `performance.now()` trong bộ nhớ).
2. Nếu đáp ứng có header `x-hub-uptime` / `x-hub-cold` (hub-api đặt khi `process.uptime() < COLD_START_WINDOW_S` — dùng cùng cờ `slow.cold_start` của §3.2, **0 lệnh Redis/DB**, thêm vào `exposedHeaders`) → tag `frontend_cause=cold_start` một cách **xác định**. Đây là cách duy nhất chắc chắn; nếu chưa làm header này thì chỉ tag suy đoán `suspected_cold_start` (khi `hub_phase≠warm` và `duration>8s`) và ghi rõ là suy đoán.
3. Chậm mà `hub_phase=warm` và không có `x-hub-cold` → `frontend_cause=slow_api` → chuyển sang log hub-api theo `request_id` (có `cause` §2). TTFB trang Next chậm mà fetch hub-api nhanh → `slow_frontend` (code/bundle/Vercel).
4. Lỗi treo/timeout phía UI (không có response): `frontend_cause=network_or_cors`, kèm `online: navigator.onLine`.
Kết quả: bảng Sentry lọc theo tag `frontend_cause` ∈ {`cold_start`, `suspected_cold_start`, `slow_api`, `slow_frontend`, `network_or_cors`, `chunk_load`, `js_exception`} — enum đóng, đặt ở cùng chỗ với `causes.ts` (nhóm riêng `fe.*` trong log nếu sau này console gửi log).

#### e) Next.js: nơi khởi tạo, boundary, source map, CSP

| Việc | Cách (theo docs Sentry NextJS đã đọc; Next ở repo là 16.x — đối chiếu docs trong `node_modules/next/dist/docs/` khi code) |
|---|---|
| Init client | `instrumentation-client.ts` (client), `sentry.server.config.ts` + `sentry.edge.config.ts` (server/edge, nạp qua `instrumentation.ts` theo `NEXT_RUNTIME`). DSN trống → không init (no-op) |
| Lỗi server component | `instrumentation.ts` xuất `onRequestError = Sentry.captureRequestError` (cần `@sentry/nextjs` ≥ 8.28.0 + Next 15 theo docs) — **qua `reportUnexpected`/lọc** như 11.1 (đừng bắt cả 404/401 có chủ đích) |
| Error boundary | **Thêm** `app/global-error.tsx` (hiện chưa có): `captureException(error)` rồi UI báo lỗi + nút tải lại, **không** hiện `error.message` thô; thêm `error.tsx` cho `(admin)` để lỗi một trang không sập cả console |
| Source map | `withSentryConfig` với `authToken` (= `SENTRY_AUTH_TOKEN`), `org`, `project` (= `SENTRY_PROJECT_WEB`) **chỉ có ở môi trường build Vercel**, không phải runtime, không commit; source map ẩn khỏi bundle công khai (tên tuỳ chọn ở bản cài — docs trang manual-setup **không** nêu `hideSourceMaps`, chưa xác minh). `widenClientFileUpload` tuỳ chọn (tăng thời gian build) |
| `tunnelRoute` | **Không dùng** ở đợt đầu: docs cảnh báo tăng tải server; đổi lại ad-blocker có thể chặn Sentry (chấp nhận — console là công cụ của dev; ghi vào đánh đổi) |
| CSP | Hiện **chưa có CSP** → không chặn Sentry. Khi thêm CSP: `connect-src` thêm domain ingest của Sentry (dạng `https://<id>.ingest.<region>.sentry.io` — **host chính xác lấy từ DSN, chưa xác minh định dạng theo vùng**), không dùng `*`; `worker-src blob:` chỉ cần nếu bật Replay (đợt đầu tắt) |
| Env web | `NEXT_PUBLIC_SENTRY_DSN` (= giá trị `SENTRY_DSN_WEB`, Next chỉ inline biến `NEXT_PUBLIC_*` vào bundle — như `NEXT_PUBLIC_HUB_API_URL`); DSN không bí mật nhưng để trống là no-op |

**Test/kiểm thủ công chứng minh secret không lọt (RED trước, giai đoạn 2):**
1. *Unit:* thay transport Sentry bằng giả; gọi `beforeSend`/`beforeBreadcrumb` với sự kiện chứa `whsec_abc…`, `hk_live_…`, `Authorization`, connection string `…://hk_live_…@…`, email, URL `?token=…#secret` → output không chứa chuỗi nào, URL đã bỏ query/hash.
2. *Quét mã:* test grep cấm `maskAllText: false`, `blockAllMedia: false`, `unmask`, `replaysSessionSampleRate` > 0, `sendDefaultPii: true`, `includeLocalVariables`, trong `apps/web/**` (và cấm `replayIntegration` khi cờ Replay tắt).
3. *E2E (Playwright, nếu repo có) hoặc thủ công:* mở console → tạo endpoint để hiện `SecretOnce` và mở chi tiết sự kiện có payload → gây một lỗi JS có chủ đích (nút ẩn `?__throw=1` chỉ ở local) → **chặn request tới `*.ingest.*sentry.io`**, lưu envelope → `grep` toàn envelope tìm secret vừa hiện, giá trị payload, email: **không thấy**. Lặp lại với Replay bật + `replaysOnErrorSampleRate:1` (cấu hình thử) và xác nhận vùng `data-sentry-block` là placeholder rỗng trong replay payload — **chỉ chạy ở local, không bật ở deployed**.
4. *Thủ công trên Sentry UI (sau deploy thử):* mở một issue frontend, xem Breadcrumbs / Request / URL / Tags: không có secret, không query/hash.
5. *CORS:* trên deployed, một fetch từ console tới hub-api đọc được `x-request-id`; origin lạ **không** (không mở rộng CORS).

---

## 12. Trạng thái triển khai giai đoạn 2A (2026-10-18)

Admin chốt cả 8 đề xuất: `trace_id` = `correlationId` bỏ `-`; lấy mẫu dòng thành công 10% deployed / 100% local; ngưỡng chậm ingest 500 ms, delivery 3 s, queue_wait 5 s (env, một file); replay = trace mới + `replay_of`; header `x-hub-cold` (backend làm đợt này, frontend đọc ở 2B); `exposedHeaders`.

| Bước §10 | Trạng thái | Ở đâu |
|---|---|---|
| 0 Test hợp đồng | **Xong** | `apps/hub-api/test/log-contract.spec.ts`, `log-landmine.spec.ts`, `cold-start.spec.ts`; `apps/hub-worker/test/log-contract.spec.ts`; `libs/common/test/{causes,log-line,trace-context,growth-window}.spec.ts` |
| 1 `causes.ts`, `slow-thresholds.ts`, `log-line.ts`, `trace-context.ts` | **Xong** | `libs/common/src/` (+ `growth-window.ts`, `event-loop.ts`); `svc` bằng `mixin` + `setServiceName()` (lệch: không phải `base` — ADR-254) |
| 2 Ingest — `ingest.done` mọi outcome | **Xong**, kể cả từ chối (chữ ký, nguồn lạ/tắt/lệch provider, 413/414/405, hộp phạt IP+cặp+gate, 429, 507, unverified, thiếu khoá chống trùng), body-parser 4xx, trùng, lỗi DB | `ingest.service.ts`, `body-parsers.ts`, `penalty-gate.ts` |
| 3 `traceparent`/`ingestedAt` vào payload outbox | **Xong** | `OutboxPayload` (`types.ts`) |
| 4 Relay đóng dấu | **Xong** — `properties.timestamp` (ms), `x-outbox-age-ms`, `traceparent`, `x-replay-of`; body delivery giữ 7 khoá (ADR-255) | `outbox.relay.ts` |
| 5 Normalize | **Xong** — `normalize.done`, `queue_wait`, tách `wrong.schema_mismatch` / `fail.hub_unknown` / `fail.poison_message` | `normalize.consumer.ts`, `route-event.ts` |
| 6 Delivery + circuit | **Xong** — `delivery.attempt` mọi nhánh (thất bại còn retry có `http_status`, `err`, `stage_ms.dest_http`, `attempt`, `destination_id`), `x-due-at`, `traceparent` giữ qua retry và gửi ra đích, `fail.exhausted` kèm `last_cause`; circuit OPEN ghi `trigger_cause` | `delivery.consumer.ts`, `webhook.sender.ts`, `circuit-breaker.service.ts` |
| 7 `growth.window` + cause cho alert/storage | **Xong** (burst_source, dup_flood, retry_storm, dlq_swell, backlog); `alertRuleCause()` + `cause` ở log đổi trạng thái cảnh báo và nấc dung lượng. **Chưa:** `growth.storage` theo byte/giờ (cần số đo mới); `queue depth` thật của broker (backlog suy từ `queue_wait`/`outbox_lag` ở các dòng log) | `growth-window.ts`, `alert.evaluator.ts`, `storage-alerts.ts` |
| 8 Metric | **Xong** — nhãn `cause` ở `hub_ingest_requests_total`, `hub_deliveries_total`; mới: `hub_log_events_total`, `hub_slow_total`, `hub_stage_duration_seconds`, `hub_queue_wait_seconds`, `hub_event_loop_lag_seconds`, `hub_growth_total` | `metrics.ts` hai app |
| 9 Event-loop monitor | **Xong** — đọc mỗi 5 s (timer `unref`, trong bộ nhớ) | `event-loop.ts`, `main.ts` hai app |
| 10 Env + docs | **Xong** | `.env.example`, `docs/DEPLOYMENT.md` (§ env), `docs/ERRORS.md`, tài liệu này |
| 11 Console | **Chưa — 2B** (`StageReason` thêm `cause`/`blame`, waterfall từ `stage_ms`) | `apps/web/**` |
| 12 Sentry backend / 14 frontend / 15 env | **Chưa — 2B** | — |
| 13 `exposedHeaders` + `x-hub-cold` | **Xong** — `['x-request-id','x-hub-cold']`, không mở rộng origin/credentials; header chỉ ở phản hồi đầu của tiến trình, bỏ qua health/metrics/OPTIONS | `cors.ts`, `cold-start.ts` |

**Chỗ lệch thiết kế (ghi ADR-254/255):**
1. `svc` qua `mixin`, không phải `base`.
2. `traceparent` đến từ client chỉ nhận ở `/v1/p/:project/events` (đã xác thực); `/hooks` luôn sinh trace mới.
3. Lỗi DB tạm thời trong tx ingest → **503** `service_unavailable` + `fail.hub_db`; lỗi lạ giữ **500** + `fail.hub_unknown`.
4. Gộp dòng lặp áp thêm cho `fail.hub_db|hub_broker|hub_redis` (bão lỗi hạ tầng — ADR-231); các `fail.*` còn lại luôn ghi.
5. `growth.window` đọc từ chính canonical line (observer, kể cả dòng bị mẫu bỏ) — không thêm điểm đo.
6. Delivery outbox row có 8 khoá (`traceparent`); message trên dây vẫn 7 khoá. Ba test khoá-khoá-outbox (`normalize-consumer`, `replay-message`, `replay-bulk`) được cập nhật; regex nhãn metric ở `penalty-box`/`penalty-gate` cho phép nhãn `cause`.
7. `delivery.attempt` ghi `err.code` dạng `HTTP_5xx|HTTP_4xx|HTTP_429|HTTP_408|TIMEOUT|ECONNREFUSED…`; sender chưa trả `errorKind` nên timeout/mạng nhận ra bằng chuỗi lỗi (`causeOfSendFailure`).
8. `http_status`/`outcome` của `ingest.done` suy từ chính phản hồi; nhánh lỡ quên `cause` rơi về lưới đỡ theo status (`causeOfStatus`).

**Hướng dẫn đọc log:** `jq 'select(.msg=="ingest.done" and .cause)'` lọc dòng có nguyên nhân; `jq 'select(.trace_id=="…")'` theo một trace qua cả hai tiến trình; `stage_ms` cho biết chặng nào chiếm thời gian (`rt` của nginx − `total_ms` lớn = thời gian ở proxy/khởi động); `sampled.suppressed` cho biết có dòng bị gộp; `trace_origin: orphan|correlation` = message mất ngữ cảnh (cũ/replay thủ công).
