# MONITORING — theo dõi sức khỏe hệ thống (LOCAL)

> Quyết định: ADR-249. Phạm vi bộ này: **môi trường LOCAL** (docker-compose). Phần deployed (Render/Neon/Upstash/CloudAMQP) có chỗ chừa ở §7.

Hai loại câu hỏi mà bộ này phải trả lời:

| Loại | Ví dụ | Cách trả lời |
|---|---|---|
| **Thời điểm** | Giờ RAM Postgres bao nhiêu? Queue đang sâu bao nhiêu? | Dashboard "Hạ tầng", panel đo tức thời |
| **Giai đoạn** | Tuần này disk tăng thế nào? Bao giờ đầy? | TSDB lưu 15 ngày + `predict_linear` / `deriv` (luật `DiskWillFillIn7Days`, recording rule `hub:db_size_growth_bytes:perday6h`) |

## 1. Bản đồ 6 tầng sức khỏe

| # | Tầng | Câu hỏi | Đo ở đâu | Trạng thái |
|---|---|---|---|---|
| 1 | Ngoại vi / mạng | Provider/tunnel có vào được hub không? DNS, TLS, cloudflared | Chưa có probe ngoài. Gợi ý: blackbox-exporter hoặc cron-job.org gọi `/health` (đã dùng ở deployed) | **Thiếu** (local: không cần; deployed: cron-job.org) |
| 2 | Hạ tầng | CPU/RAM/disk host, từng container | `node-exporter` (host = VM WSL2), `cAdvisor` (container) → dashboard "Hạ tầng", luật `Host*`, `Disk*`, `Container*` | **Có** (local) |
| 3 | Middleware + DB | Postgres connection/kích thước, Redis bộ nhớ/lệnh, RabbitMQ queue/consumer/DLQ | `postgres-exporter`, `redis-exporter`, `rabbitmq_prometheus` (`:15692`) → luật `Postgres*`, `Redis*`, `Rabbit*` | **Có** (local) |
| 4 | Backend | RPS, p95 ingest/delivery, lỗi, circuit, outbox, worker còn sống | `hub-api:4000/metrics`, `hub-worker:9101/metrics` → dashboard "Webhook Hub"; `WorkerSilent` (heartbeat) | **Có** (heartbeat phụ thuộc agent khác, xem §5) |
| 5 | Frontend | Lỗi JS, Web Vitals của console | Sentry (`@sentry/nextjs`, ADR đợt Sentry) | **Ngoài bộ này** — làm ở tầng ứng dụng, không qua Prometheus |
| 6 | Nghiệp vụ | Sự kiện nhận/giao/chết, tỉ lệ thành công, lưu lượng theo nguồn | Metric `hub_*` của hub (hub_ingest_*, hub_deliveries_*, hub_alerts_open…), console | **Có** một phần; "SLO nghiệp vụ" (ví dụ % giao trong 1 phút) **thiếu** |

## 2. Chạy local

Sáu service theo dõi mới (`node-exporter`, `cadvisor`, `postgres-exporter`, `redis-exporter`, `alertmanager`, `alert-sink`) nằm trong **profile `monitoring`**: `docker compose up -d` thường **không** khởi động chúng (và `npm run verify:up` của stack `hubv` không đụng tên container / cổng với chúng). Prometheus và Grafana vẫn chạy mặc định như cũ, nhưng thiếu profile thì các target hạ tầng sẽ DOWN.

```bash
docker compose --profile monitoring up -d       # cả stack + bộ theo dõi, hoặc chỉ phần theo dõi:
docker compose --profile monitoring up -d prometheus grafana alertmanager alert-sink node-exporter cadvisor postgres-exporter redis-exporter rabbitmq
```

| Thành phần | Địa chỉ trên host | Ghi chú |
|---|---|---|
| Prometheus | http://localhost:9090 (Targets: `/targets`, Alerts: `/alerts`) | publish 0.0.0.0 từ trước, không xác thực |
| Grafana | http://localhost:3001 (`admin`/`admin`) | có từ trước, mật khẩu mặc định; thư mục **Webhook Hub** → dashboard **Hạ tầng** (uid `webhook-hub-infra`) và **Webhook Hub** |
| Alertmanager | http://127.0.0.1:9093 | chỉ loopback (không để LAN tạo silence) |
| Exporter, `alert-sink`, RabbitMQ `:15692` | **không publish ra host** | chỉ trong mạng compose |

Prometheus/Grafana mở 0.0.0.0 với quyền mặc định là hiện trạng của stack local từ trước, không đổi ở ADR-249 (ghi lại để biết: đừng chạy trên mạng không tin cậy).

Xem cảnh báo đã bắn tới receiver tạm: `docker logs webhook-hub-alert-sink`.

Kiểm tra cấu hình (không cần cài gì ngoài Docker):

```bash
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint promtool -v "$PWD/infra/prometheus/rules:/rules:ro" prom/prometheus:v3.14.0 check rules /rules/infra.yml
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint amtool  -v "$PWD/infra/alertmanager:/c:ro" prom/alertmanager:v0.27.0 check-config /c/alertmanager.yml
```

(`MSYS_NO_PATHCONV=1` chỉ cần trong Git Bash trên Windows.)

### Lưu trữ & retention

Prometheus lưu ở volume `promdata`, **retention 15 ngày** và trần **2 GB** (`--storage.tsdb.retention.size`, cái nào chạm trước thì cắt). Dài hơn thì `predict_linear`/so sánh tuần tin cậy hơn nhưng tốn đĩa gần tuyến tính. Xoá sạch số đo: `docker compose down` rồi `docker volume rm webhook-hub_promdata`. Prometheus **không bật `--web.enable-lifecycle`**: sửa `prometheus.yml`/luật thì phải restart container `webhook-hub-prometheus` (hoặc gửi SIGHUP).

**Số đo thật (trước khi giảm series, 2026-10-18):** ~590 sample/s, ~11.9 nghìn head series, RSS Prometheus ~148 MiB. Với ~1,5 byte/sample sau nén thì 15 ngày vào khoảng 1,1 GB, dễ chạm trần 2 GB khi thêm series; con số "vài chục MB" ghi lúc đầu là sai (đó chỉ là TSDB sau vài phút).

**Giảm series đã làm** (`metric_relabel_configs` drop + cAdvisor 30s): bỏ `container_{tasks_state,memory_failures_total,fs_*,blkio_*,network_*,...}`, `node_{nfs,softnet,interrupts,...}_*`, `erlang_vm_*`; **không** drop thứ luật/dashboard dùng (`container_memory_working_set_bytes`, `container_cpu_usage_seconds_total`, `container_start_time_seconds`, `container_spec_memory_limit_bytes`, `node_cpu/memory/filesystem_*`, `rabbitmq_detailed_*`). Đếm trên số đo trước đó: bỏ được khoảng 4,4 nghìn trên ~9,4 nghìn series đang sống (cAdvisor ~2.1k, erlang ~1.9k, node ~0.4k), cAdvisor còn lại đo 30s. **Ước tính** sau đó: ~270 sample/s, 15 ngày ~0,5 GB. **Đo lại sau khi nạp cấu hình mới (2026-10-18):** ~255–270 sample/s, ~4.870 series sống. Lưu ý `prometheus_tsdb_head_series` vẫn báo ~12.106 vì còn series cũ chưa bị loại khỏi head (sẽ rơi dần khi head compaction/ cắt block): đọc con số ~4.870 là số series đang được scrape thật, đừng nhầm với 12.106. Muốn tự đo:

```bash
# sample/s và số series đầu (PromQL)
rate(prometheus_tsdb_head_samples_appended_total[5m])     prometheus_tsdb_head_series
# dung lượng TSDB hiện tại (sau vài ngày nhân ra 15d)
MSYS_NO_PATHCONV=1 docker exec webhook-hub-prometheus du -sk /prometheus
```

### RAM các container mới (đo `docker stats`, rảnh tải)

| Container | RAM |
|---|---|
| cadvisor | ~25 MiB |
| alertmanager | ~21 MiB |
| alert-sink | ~16 MiB |
| postgres-exporter | ~12 MiB |
| redis-exporter | ~10 MiB |
| node-exporter | ~10 MiB |
| **Cộng 6 container mới** | **~95 MiB** |
| prometheus (có từ trước) | **~150 MiB RSS** ở ~12k series (đo lại lúc 11,9k series); lúc mới chạy chỉ ~60 MiB, tăng theo số series |

Cả bộ ~250 MiB. VM Docker có ~5,8 GiB, còn dư (kể cả stack `hubv` nếu đang chạy).

## 3. Cái gì được đo, bằng gì

| Job Prometheus | Target | Nhịp | Cho tầng |
|---|---|---|---|
| `hub-api` | `hub-api:4000` | 5s | 4 |
| `hub-worker` | `hub-worker:9101` | 5s | 4 |
| `node` | `node-exporter:9100` | 15s | 2 |
| `cadvisor` | `cadvisor:8080` | 30s | 2 |
| `postgres` | `postgres-exporter:9187` | 15s | 3 |
| `redis` | `redis-exporter:9121` | 15s | 3 |
| `rabbitmq` | `rabbitmq:15692/metrics` | 15s | 3 (node, memory, disk free) |
| `rabbitmq-queues` | `rabbitmq:15692/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count` | 15s | 3 (tin + consumer theo queue) |
| `alertmanager`, `prometheus` | chính chúng | 15s | tự giám sát |

Luật ở `infra/prometheus/rules/infra.yml` (đã qua `promtool check rules`: 32 rule = 5 recording + 27 alert): `Watchdog` (luôn bắn); target down; RAM/CPU host; disk `predict_linear` 7 ngày (warning) và 24 giờ (critical) + dưới 10%; **ổ C: Windows** theo ngưỡng tuyệt đối GB (§5); RAM container gần trần / > 1,5 GiB, CPU container, restart liên tục; Postgres connection > 80% `max_connections`, `pg_up`, `hub_db_size_bytes` tăng > 200 MiB/giờ, `hub_storage_near_full`; Redis down / > 85% maxmemory; RabbitMQ backlog tăng liên tục ở `q.normalize` và `q.delivery.main`, consumer = 0, queue chính biến mất, DLQ > 0; `WorkerSilent` + `WorkerHeartbeatMissing`. Mỗi alert có `for:`, `severity` (`warning`|`critical`) và mô tả tiếng Việt "bộ phận nào bị bệnh gì".

## 4. Alertmanager — Telegram local (ADR-257)

`infra/alertmanager/alertmanager.yml` là **template**; `entrypoint.sh` (mount vào container) render nó lúc khởi động. Receiver `default` luôn gửi webhook về `alert-sink` (echo ghi log). Telegram chỉ bật khi Admin tự đặt hai file vào `infra/alertmanager/secrets/` (thư mục gitignored, chỉ `*.example` nằm trong git):

```
cd infra/alertmanager/secrets
printf '%s\n' 'DÁN_TOKEN_Ở_ĐÂY'   > telegram_bot_token   # dạng 123456789:AA...; KHÔNG qua git/chat. File .example chỉ là mẫu định dạng
printf '%s\n' 'DÁN_CHAT_ID_Ở_ĐÂY' > telegram_chat_id     # số (chat riêng: dương; nhóm: âm)
sudo chown 65534 telegram_bot_token telegram_chat_id      # container chạy user nobody (65534)
chmod 600 telegram_bot_token telegram_chat_id             # KHÔNG dùng 644: mọi user trên máy host đọc được token
docker compose --profile monitoring up -d --force-recreate alertmanager
docker logs webhook-hub-alertmanager 2>&1 | grep entrypoint   # "Telegram BẬT" hoặc "Telegram TẮT"
```

- Entrypoint bỏ dòng `#` và dòng trống, cần đúng 1 dòng giá trị; token phải khớp `^[0-9]+:[A-Za-z0-9_-]+$`, chat_id là số. Sai/thiếu/không đọc được (vd. chmod 600 mà chưa chown 65534) -> log nêu rõ lý do và `Telegram TẮT`, Alertmanager vẫn lên và chỉ gửi `alert-sink`. Config render còn được `amtool check-config` kiểm; lỗi/marker lệch thì tự rơi về bản TẮT. Đổi file secret thì phải recreate container.
- Route: chỉ `severity` warning/critical vào Telegram (rồi `continue` sang `default`); **Watchdog và severity=none không bao giờ tới Telegram**. Gom `alertname,severity`, `group_wait 30s`, `group_interval 5m`, lặp 4h (critical 1h). Tin nhắn tiếng Việt: tên luật, mức, tóm tắt, mô tả, ĐANG BÁO/ĐÃ HẾT, giờ UTC, link Grafana/Alertmanager local.
- **Cách nhanh:** `./infra/alertmanager/test-telegram.sh [warning|critical|that|doi-token]` — hỏi chat_id + token (gõ không hiện) nếu chưa có file, ghi secret đúng quyền ở trên, recreate Alertmanager, kiểm `Telegram BẬT`, rồi bắn cảnh báo giả qua `amtool` (`that` = tắt `redis-exporter` để có `TargetDown` thật). Không in secret.
- Kiểm tra không cần token thật: `amtool check-config` template; hoặc chạy container thử với `api_url:` trỏ vào server HTTP giả (chỉ bản sao tạm, không commit) rồi `POST /api/v2/alerts`; xác nhận nhận `/bot<token>/sendMessage` với đúng `chat_id` + `text`.
- Email / SMS vẫn là chỗ chừa (comment) trong `alertmanager.yml`. `HEARTBEAT_URL` (Healthchecks.io) là kênh khác, không liên quan Telegram.

**Watchdog (dead-man's switch):** luật `Watchdog` luôn bắn, route riêng sang receiver `watchdog` (nhắc lại mỗi 5 phút). Local nó chỉ trỏ `alert-sink` (chứng minh đường ống Prometheus → Alertmanager → receiver thông). Giới hạn: **Prometheus hoặc Alertmanager chết thì chỉ kênh NGOÀI báo được**. Khi chốt kênh: trỏ receiver `watchdog` tới Healthchecks.io (ping mỗi 5 phút, thiếu ping họ gửi cảnh báo) bằng `url_file` (URL chứa token, không đưa vào repo; chỗ chừa đã có trong `alertmanager.yml`).

**Inhibit:** `TargetDown` che `WorkerSilent`/`RabbitNoConsumers` cùng `job` (`WorkerHeartbeatMissing`/`RabbitQueueMissing` dùng `absent()` nên không có nhãn `job`, inhibit không khớp chúng; không hại vì điều kiện `up == 1` của chúng đã loại trừ ca target chết); dự báo đầy 24 giờ che dự báo 7 ngày cùng `mountpoint`; `HostMemoryCritical` che `HostMemoryHigh`.

## 5. Giới hạn thật (đã gặp khi dựng)

**Windows 11 + Docker Desktop (WSL2):**

1. **`node-exporter` đo VM WSL2 của Docker Desktop, không phải toàn bộ Windows host.** CPU/RAM là của VM (giới hạn bởi `.wslconfig`). Disk: các mountpoint của VM (`/var`, `/tmp`, `/var/lib` ext4 ảo ~1 TB…) **và mountpoint `/usr/lib/wsl/drivers` (9p) chính là ổ C: Windows** (~510 GB tổng; đo 2026-10-18 lúc dựng chỉ còn ~13 GB, ~2,6% trống; sau khi nén VHDX bằng diskpart cùng ngày còn ~39,6 GB trống). Ổ C: là nơi chứa VHDX của Docker; **VHDX chỉ phình, không tự co, tới khi C: đầy thì Docker/WSL2 treo — rủi ro mà `predict_linear` trên `/var/lib` (ext4 ảo 1 TB) không thấy.** Vì vậy có nhóm luật riêng `DiskWindowsCLow` (<20 GB, warning), `DiskWindowsCCritical` (<8 GB, critical), `DiskWindowsCWillFillIn7Days` theo ngưỡng tuyệt đối GB, và `DiskAlmostFull` (%), `DiskWillFillIn7Days`/`DiskWillFillIn24Hours` loại mountpoint này ra (tránh báo trùng). Không có số đo CPU/RAM thật của Windows: muốn thì dùng `windows_exporter` trên host (ngoài phạm vi).
2. Mount `/` của node-exporter dùng `ro` thường, **không** `rslave` (Docker Desktop từ chối "path / is mounted on / but it is not a shared or slave mount"). Hệ quả: mountpoint trong các mount con có thể không đầy đủ.
3. **cAdvisor không gắn được tên container.** Docker Desktop dùng containerd image store nên cAdvisor (kể cả v0.49 và v0.52) báo `failed to identify the read-write layer ID` và bỏ container. Cách chạy được: `--docker=unix:///nonexistent.sock --docker_only=false` để đọc cgroup thô `/docker/<id>`. Đổi lại metric chỉ có `id`; `prometheus.yml` sinh nhãn `container` = 12 ký tự đầu, khớp cột `ID` của `docker ps` (`docker ps --format '{{.ID}} {{.Names}}'` để tra tên). Nhãn `name`, metric đĩa/mạng theo container, `container_spec_memory_limit_bytes` có thể thiếu → luật `ContainerMemoryNearLimit` thường im (cũng vì local không đặt `mem_limit`). cAdvisor KHÔNG cần `privileged` và không cần mount `/var/run` (đã thử trên container tạm: vẫn đọc đủ 23 cgroup `/docker/<id>`, không lỗi permission); chỉ cần mount `/`, `/sys`, `/var/lib/docker`, `/dev/disk` ở dạng `ro` và `/dev/kmsg`.
4. Mọi container của Docker Desktop (cả stack `hubv`) đều hiện trong số đo container, không chỉ stack `webhook-hub-*`.
5. Số đo ở đây là để quan sát và để báo "hệ thống sống ra sao"; **số liệu báo cáo hiệu năng (p95) vẫn lấy từ k6 ở LOCAL** (ADR-019), không lấy từ bộ này.

**Redis và quota (R1):** `redis-exporter` chỉ chạy `INFO`/đọc nên không đổi ngân sách Redis đường nóng của app (không đụng mã ứng dụng). Nhưng **không được chạy nó ở deployed với nhịp 5s**: mỗi lần scrape là lệnh Upstash tính vào quota. Đó là lý do bộ này chỉ dành cho local.

**Cách nén VHDX Docker (khi ổ C: sắp đầy):** thoát Docker Desktop; `wsl --shutdown`; mở PowerShell quyền admin chạy `diskpart`, rồi `select vdisk file=<đường dẫn tới docker_data.vhdx>`, `attach vdisk readonly`, `compact vdisk`, `detach vdisk`, `exit`. Việc này **tắt mọi container** (cả stack đang chạy) và VHDX **sẽ phình lại** khi dùng tiếp, nên chỉ là biện pháp tạm.

**`postgres-exporter` dùng `hub_user` — SUPERUSER của DB local** (mật khẩu lấy `${POSTGRES_PASSWORD:-hub_password}`; service `postgres` hiện hardcode `hub_password`, ADR-249 không sửa DB). Giới hạn đã biết: môi trường thật phải dùng role `pg_monitor` riêng, không dùng superuser cho exporter.

**Metric phụ thuộc agent khác (điểm yếu, không phải ưu điểm):**
- `hub_worker_heartbeat_timestamp_seconds` (`WorkerSilent`, panel heartbeat): gauge không nhãn **xuất 0 trước nhịp đầu**, nên luật lọc `> 0` (không thì báo critical oan lúc worker khởi động). Điểm yếu: nếu metric **không tồn tại** (image worker cũ) mà target vẫn UP thì `WorkerSilent` im vĩnh viễn, nên có luật `WorkerHeartbeatMissing` (`absent(...)` và `up{job="hub-worker"}==1`, 5 phút, warning). Worker chết hẳn đã có `TargetDown{job="hub-worker"}`.
- `hub_db_size_bytes` (`HubDbGrowingFast`, recording `hub:db_size_growth_bytes:perday6h`, panel "Kích thước database"): cũng **xuất 0 trước lần set đầu sau mỗi lần worker restart**, nên mọi chỗ dùng đều lọc `> 0` (subquery `[1h:1m]`/`[6h:1m]` cho `delta`/`deriv`). `pg_database_size_bytes` của exporter vẫn có để đối chiếu.

## 6. Kết quả kiểm chứng (2026-10-18, Docker Desktop 27.5.1)

- `docker compose config -q`: hợp lệ cho cả `docker-compose.yml` và tổ hợp `-f docker-compose.yml -f docker-compose.verify.yml -p hubv`. Ở tổ hợp `hubv` mặc định (không bật profile) sáu service theo dõi không được chọn; nếu cố bật `--profile monitoring` ở `hubv` thì chúng mang `container_name: webhook-hub-*` cố định và `alertmanager` publish `127.0.0.1:9093`, **sẽ đụng stack chính** — đừng bật profile này ở `hubv`.
- `promtool check rules`: 32 rule SUCCESS; `promtool check config`: SUCCESS; `amtool check-config`: SUCCESS (2 receiver, 3 inhibit rule).
- Lần dựng đầu: `/api/v1/targets` **10/10 UP**; chuỗi `redis-exporter` tắt → `TargetDown` → Alertmanager → `alert-sink` nhận POST (log).
- Sau lần sửa review: Prometheus đã nạp **32 rule** (có `Watchdog`) và cấu hình giảm series (đo lại ở §2). Biểu thức mới đã chạy thử qua API đọc.
- **Để cAdvisor (đã bỏ `privileged` và `/var/run`) và Alertmanager (bind `127.0.0.1`) có hiệu lực trên stack đang chạy cần recreate container:** `docker compose --profile monitoring up -d` (do Admin chạy; không tự động). Thiếu bước này, các service đang chạy vẫn giữ cấu hình cũ (cAdvisor privileged, Alertmanager 0.0.0.0).
- Grafana nạp được dashboard "Hạ tầng"; panel heartbeat trống tới khi worker mới (có metric) chạy.

## 7. Chỗ chừa cho DEPLOYED (agent khác nối sau)

Ràng buộc đã biết: không chạy exporter đo kiểu local ở Render/free tier (autosuspend + quota; Upstash tính theo lệnh; CloudAMQP giới hạn connection). Nên dùng: `/health` + cron-job.org cho tầng 1 và "còn sống", số đo của chính nền tảng (Render/Neon/Upstash/CloudAMQP dashboard) cho tầng 2–3, `/metrics` của app (đã có `METRICS_TOKEN`) cho tầng 4, Sentry cho tầng 5.

### 7.1. Cảnh báo hạn mức gói free qua Telegram (LOG-CAUSE 7, ADR-263)

Gói free Neon/Upstash không tự cảnh báo, nên `hub-worker` (job `QuotaAlertJob`, KHÔNG phải hub-api) tự đo thưa và nhắn Telegram cho Admin.

| Tài nguyên | Đo bằng | Trần | Chi phí |
|---|---|---|---|
| Neon - dung lượng | `pg_database_size` | `QUOTA_NEON_STORAGE_BYTES` (mặc định `DB_DISK_BUDGET_MB` = 512MB) | 1 truy vấn nhẹ / 15 phút |
| Upstash - lệnh/tháng | `INFO` -> `total_commands_processed` cộng dồn theo tháng UTC (**ước lượng**) | `QUOTA_UPSTASH_COMMANDS_PER_MONTH` (500.000, DEPLOYMENT §5.2) | 1 lệnh Redis / 15 phút |
| Upstash - dung lượng | `INFO` -> `used_memory` | `QUOTA_UPSTASH_MEMORY_BYTES` (**chưa có mặc định, cần Admin xác nhận số của gói**; không đặt = không đo) | cùng lệnh `INFO` |
| Neon - compute-hours | không đo | - | không có cách rẻ trong DB; xem dashboard Neon |

- Mức: warning ≥ 80% (`QUOTA_WARN_PCT`), critical ≥ 95% (`QUOTA_CRIT_PCT`); chỉ nhắn khi ĐỔI mức, nhắc lại sau 24h (`QUOTA_REPEAT_MS`); hạ mức có đệm 2 điểm %.
- Trạng thái "đã báo mức nào" nằm ở key Redis `quota:alert:state` (TTL 40 ngày) nên sống qua lần khởi động lại hằng ngày. Redis mất key = báo lại đúng một lần.
- Cần cả `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` (cùng biến với đích Telegram); thiếu một = tắt hẳn, log 1 dòng lúc khởi động.
- Kiểm tay trước khi tin số lệnh: `redis-cli -u $REDIS_URL INFO | grep total_commands_processed`. Không có trường này thì job chỉ log cảnh báo và bỏ qua Upstash.
- Giả định (chưa kiểm chứng): `total_commands_processed` đơn điệu, riêng cho database, nhất quán giữa các lần gọi. Delta được kẹp theo `giây × QUOTA_UPSTASH_MAX_CMD_PER_SEC` (mặc định 200); mẫu bất thường (giảm quá mức kẹp / tăng quá mức kẹp) bị BỎ, đếm vào `anomalies` và log "INFO total_commands_processed bất thường" (tối đa 1 lần/giờ). Nhiều mẫu bất thường = INFO không ổn định, hãy tin dashboard Upstash. Kiểm chứng: chạy `INFO` vài lần cách nhau vài phút và so.
- Redis lỗi (vd hết hạn mức Upstash): job vẫn đo Neon, dùng trạng thái tạm trong bộ nhớ và ghi rõ trong tin nhắn.
- Giới hạn: số lệnh trước lần đo đầu của tháng không biết; Upstash chưa xác nhận cách tính EVAL.

> TODO (nối sau): bảng "tầng → công cụ ở deployed", cách báo động deployed (cùng receiver Alertmanager đã chốt hay kênh khác).
