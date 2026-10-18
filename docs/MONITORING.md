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

```bash
docker compose up -d              # cả stack, hoặc chỉ phần theo dõi:
docker compose up -d prometheus grafana alertmanager alert-sink node-exporter cadvisor postgres-exporter redis-exporter rabbitmq
```

| Thành phần | Địa chỉ trên host | Ghi chú |
|---|---|---|
| Prometheus | http://localhost:9090 (Targets: `/targets`, Alerts: `/alerts`) | |
| Grafana | http://localhost:3001 (`admin`/`admin`) | thư mục **Webhook Hub** → dashboard **Hạ tầng** (uid `webhook-hub-infra`) và **Webhook Hub** |
| Alertmanager | http://localhost:9093 | |
| Exporter, `alert-sink`, RabbitMQ `:15692` | **không publish ra host** | chỉ trong mạng compose |

Xem cảnh báo đã bắn tới receiver tạm: `docker logs webhook-hub-alert-sink`.

Kiểm tra cấu hình (không cần cài gì ngoài Docker):

```bash
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint promtool -v "$PWD/infra/prometheus/rules:/rules:ro" prom/prometheus:v3.14.0 check rules /rules/infra.yml
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint amtool  -v "$PWD/infra/alertmanager:/c:ro" prom/alertmanager:v0.27.0 check-config /c/alertmanager.yml
```

(`MSYS_NO_PATHCONV=1` chỉ cần trong Git Bash trên Windows.)

### Lưu trữ & retention

Prometheus lưu ở volume `promdata`, **retention 15 ngày** và trần **2 GB** (`--storage.tsdb.retention.size`, cái nào chạm trước thì cắt). Đánh đổi: dài hơn thì `predict_linear`/so sánh tuần tin cậy hơn nhưng tốn đĩa gần tuyến tính. Đo thực tế sau vài phút chạy 10 target: ~3 MB; ước tính 15 ngày ở nhịp 15s (exporter) + 5s (hai job app) cỡ vài chục đến vài trăm MB, cAdvisor là nguồn series nhiều nhất. Muốn đổi: sửa `command` của service `prometheus`. Xoá sạch số đo: `docker compose down` rồi `docker volume rm webhook-hub_promdata`.

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
| prometheus (đã có từ trước, nay có TSDB bền) | ~60 MiB lúc mới, tăng theo số series |

Máy dev: VM Docker có ~5.8 GiB, toàn stack (kể cả stack `hubv` nếu đang chạy) còn dư.

## 3. Cái gì được đo, bằng gì

| Job Prometheus | Target | Nhịp | Cho tầng |
|---|---|---|---|
| `hub-api` | `hub-api:4000` | 5s | 4 |
| `hub-worker` | `hub-worker:9101` | 5s | 4 |
| `node` | `node-exporter:9100` | 15s | 2 |
| `cadvisor` | `cadvisor:8080` | 15s | 2 |
| `postgres` | `postgres-exporter:9187` | 15s | 3 |
| `redis` | `redis-exporter:9121` | 15s | 3 |
| `rabbitmq` | `rabbitmq:15692/metrics` | 15s | 3 (node, memory, disk free) |
| `rabbitmq-queues` | `rabbitmq:15692/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count` | 15s | 3 (tin + consumer theo queue) |
| `alertmanager`, `prometheus` | chính chúng | 15s | tự giám sát |

Luật ở `infra/prometheus/rules/infra.yml` (đã qua `promtool check rules`): target down; RAM/CPU host; disk `predict_linear` 7 ngày (warning) và 24 giờ (critical) + dưới 10%; RAM container gần trần / > 1.5 GiB, CPU container, restart liên tục; Postgres connection > 80% `max_connections`, `pg_up`, `hub_db_size_bytes` tăng > 200 MiB/giờ, `hub_storage_near_full`; Redis down / > 85% maxmemory; RabbitMQ backlog tăng liên tục ở `q.normalize` và `q.delivery.main`, consumer = 0, DLQ > 0; `WorkerSilent`. Mỗi alert có `for:`, `severity` (`warning`|`critical`) và mô tả tiếng Việt "bộ phận nào bị bệnh gì".

## 4. Alertmanager — receiver CHƯA chốt

Admin đang chọn giữa email / Telegram bot / SMS. Hiện `infra/alertmanager/alertmanager.yml` có receiver `default` gửi webhook về service `alert-sink` (echo ghi log) để luồng Prometheus → Alertmanager → receiver chạy thật. Khối Telegram và email đã chừa sẵn ở dạng bình luận. **Không đưa token/mật khẩu vào file này** — dùng `bot_token_file` / `auth_password_file` trỏ tới file mount từ ngoài repo. SMS: Alertmanager không có receiver SMS gốc, đi qua `webhook_configs` tới cổng SMS.

## 5. Giới hạn thật (đã gặp khi dựng)

**Windows 11 + Docker Desktop (WSL2):**

1. **`node-exporter` đo VM WSL2 của Docker Desktop, không phải Windows host.** CPU/RAM/disk trên dashboard là của VM đó (giới hạn bởi `.wslconfig`), không phải của máy Windows. Disk Windows (ổ C:) không có trong số đo; các mountpoint hiện ra là ổ ảo của VM (`/var`, `/tmp`, `/usr/lib/wsl`…). Muốn đo máy Windows thật: dùng `windows_exporter` chạy trên host (ngoài phạm vi).
2. Mount `/` của node-exporter dùng `ro` thường, **không** `rslave` (Docker Desktop từ chối "path / is mounted on / but it is not a shared or slave mount"). Hệ quả: mountpoint trong các mount con có thể không đầy đủ.
3. **cAdvisor không gắn được tên container.** Docker Desktop dùng containerd image store nên cAdvisor (kể cả v0.49 và v0.52) báo `failed to identify the read-write layer ID` và bỏ container. Cách chạy được: `--docker=unix:///nonexistent.sock --docker_only=false` để đọc cgroup thô `/docker/<id>`. Đổi lại metric chỉ có `id`; `prometheus.yml` sinh nhãn `container` = 12 ký tự đầu, khớp cột `ID` của `docker ps` (`docker ps --format '{{.ID}} {{.Names}}'` để tra tên). Nhãn `name`, metric đĩa/mạng theo container, `container_spec_memory_limit_bytes` có thể thiếu → luật `ContainerMemoryNearLimit` thường im (cũng vì local không đặt `mem_limit`). cAdvisor chạy `privileged`.
4. Mọi container của Docker Desktop (cả stack `hubv`) đều hiện trong số đo container, không chỉ stack `webhook-hub-*`.
5. Số đo ở đây là để quan sát và để báo "hệ thống sống ra sao"; **số liệu báo cáo hiệu năng (p95) vẫn lấy từ k6 ở LOCAL** (ADR-019), không lấy từ bộ này.

**Redis và quota (R1):** `redis-exporter` chỉ chạy `INFO`/đọc nên không đổi ngân sách Redis đường nóng của app (không đụng mã ứng dụng). Nhưng **không được chạy nó ở deployed với nhịp 5s**: mỗi lần scrape là lệnh Upstash tính vào quota. Đó là lý do bộ này chỉ dành cho local.

**Metric phụ thuộc agent khác:**
- `hub_worker_heartbeat_timestamp_seconds` (luật `WorkerSilent`, panel "Heartbeat worker"): do hub-worker phát ở đợt sửa `/health`. Chưa có thì vector rỗng, luật im lặng (không báo giả). Worker chết hẳn đã có `TargetDown{job="hub-worker"}`.
- `hub_db_size_bytes` (luật `HubDbGrowingFast`, recording `hub:db_size_growth_bytes:perday6h`): hub-worker chỉ đọc `pg_database_size` tối đa 10 phút/lần và chỉ phát khi worker chạy bản mới; `pg_database_size_bytes` của exporter vẫn có sẵn làm đối chiếu.

## 6. Kết quả kiểm chứng lúc dựng (2026-10-18, Docker Desktop 27.5.1)

- `docker compose config`: hợp lệ.
- `promtool check rules`: 26 rule (5 recording + 21 alert), SUCCESS. `amtool check-config`: SUCCESS.
- `/api/v1/targets`: **10/10 UP** (`hub-api`, `hub-worker`, `node`, `cadvisor`, `postgres`, `redis`, `rabbitmq`, `rabbitmq-queues`, `alertmanager`, `prometheus`).
- Chuỗi cảnh báo đã chạy thật: tắt `redis-exporter` → `TargetDown{job="redis"}` → Alertmanager → `alert-sink` nhận POST (có trong log).
- Grafana nạp được dashboard "Hạ tầng"; mọi biểu thức panel trả `success` (panel heartbeat worker và `hub_db_size_bytes` trống vì metric chưa có, xem §5).

## 7. Chỗ chừa cho DEPLOYED (agent khác nối sau)

Ràng buộc đã biết: không chạy exporter đo kiểu local ở Render/free tier (autosuspend + quota; Upstash tính theo lệnh; CloudAMQP giới hạn connection). Nên dùng: `/health` + cron-job.org cho tầng 1 và "còn sống", số đo của chính nền tảng (Render/Neon/Upstash/CloudAMQP dashboard) cho tầng 2–3, `/metrics` của app (đã có `METRICS_TOKEN`) cho tầng 4, Sentry cho tầng 5.

> TODO (nối sau): bảng "tầng → công cụ ở deployed", cách báo động deployed (cùng receiver Alertmanager đã chốt hay kênh khác).
