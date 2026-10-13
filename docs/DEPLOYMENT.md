# Triển khai — Webhook Hub

> Chốt 2026-09-17. Đi kèm [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`ROADMAP-14D.md`](ROADMAP-14D.md) · [`adr/README.md`](adr/README.md)
>
> ⚠️ Hạn mức free tier của mọi nhà cung cấp dưới đây **thay đổi liên tục**. Con số ghi ở đây là để *ước lượng ràng buộc*, **kiểm lại trang giá trước khi chốt tài khoản**.

---

> **Runbook từng bước cho operator:** [`HUONG-DAN-DEPLOY.md`](../HUONG-DAN-DEPLOY.md) (Render + Vercel + Neon, 11/10).
> File này là thiết kế + kiểm kê biến; hai file phải khớp nhau — lệch thì runbook theo code thật, sửa file này.

## 1. Hai môi trường, hai nhiệm vụ (ADR-019)

Đây là **quyết định kiến trúc**, không phải cách chữa cháy. Viết đúng như vậy vào báo cáo.

| | **LOCAL** — `docker-compose` | **DEPLOYED** — Render + Vercel + Neon + Upstash + CloudAMQP |
|---|---|---|
| **Nhiệm vụ** | **Đo đạc & chaos engineering** | **Chứng minh hệ thống online thật** |
| Demo được | k6 500 rps · `--scale hub-worker=5` · `docker kill` worker · tắt Redis/RabbitMQ · RabbitMQ Management UI · Grafana | PayOS / SePay / GitHub **thật** gọi vào URL **thật** · Shop · dashboard realtime · status page |
| Số liệu báo cáo | ✅ **Toàn bộ đo ở đây** | ❌ **Không đo ở đây** |
| Ai điều khiển | Bạn, hoàn toàn | Nhà cung cấp |

**Tại sao không đo trên môi trường deployed** — ba lý do độc lập, mỗi lý do đủ để làm số vô nghĩa:

1. **Neon free autosuspend** — compute ngủ sau ~5 phút, request đầu tiên phải đánh thức.
2. **Quota** — một lần chạy k6 500 rps trong 60 giây sinh ~30.000 sự kiện × ~2KB = **~60MB** vào `raw_events`, cộng hàng trăm nghìn message qua CloudAMQP và hàng trăm nghìn lệnh Upstash. Vài lần chạy là hết sạch cả ba hạn mức.
3. **Không có quyền kill container** trên Render → không chứng minh được at-least-once ở đó.

> **Câu cho báo cáo:** *"Môi trường đo đạc được tách khỏi môi trường triển khai, vì đo hiệu năng trên hạ tầng dùng chung có autosuspend và quota sẽ cho số liệu không tái lập được."*

---

## 2. Bản đồ nhà cung cấp

| Thành phần | Nhà cung cấp | Ghi chú |
|---|---|---|
| `hub-api` | **Render** (Docker) | Web Service · `/health` · Socket.IO server |
| `hub-worker` | **Render** (Docker) | Consumer + outbox relay + cleanup (ADR-020) |
| `web` (dashboard + storefront UI) | **Vercel** | Next.js |
| `shop` (backend) | **Render** Web Service (Docker, free) | Server Express chạy LIÊN TỤC (vòng tự đăng ký endpoint với hub, nhận push ký Standard Webhooks) — KHÔNG chạy kiểu serverless/route handler trên Vercel (thay ADR-022). Giao diện cửa hàng nằm trong `web` (Vercel) |
| PostgreSQL | **Neon** | schema `hub` + `shop` |
| Redis | **Upstash** | `rediss://`, giao thức Redis (không dùng REST) |
| RabbitMQ | **CloudAMQP** — Little Lemur (free) | ⚠️ món dễ bị quên nhất |
| Tunnel (local dev) | **cloudflared** named tunnel | Ngày 1–3, trước khi có URL Render |
| CI + cron 5' | **GitHub Actions** | |
| Uptime + keep-alive | **UptimeRobot** | ping 5 phút |
| Error tracking | **Sentry** (free) | tuỳ chọn |

### ⚠️ Region phải khớp — đây là thứ giết chỉ tiêu p95

**Tất cả đặt ở Singapore** (`ap-southeast-1` hoặc tương đương): Render · Neon · Upstash · CloudAMQP.

Lệch một cái — ví dụ Render Singapore mà Neon US-East — thì mỗi lượt gọi DB tốn ~200ms. Luồng ingest có 1 transaction + 3–4 lệnh Redis → **p95 thành nửa giây**, và **không có cách tối ưu code nào cứu được**. Đây là lỗi cấu hình, không phải lỗi kiến trúc, nhưng nó giết chỉ tiêu quan trọng nhất của đề tài.

---

## 3. Render

### 3.1. Ràng buộc free tier — đọc kỹ phần này trước khi tạo tài khoản

| Ràng buộc | Hệ quả |
|---|---|
| Web Service free **ngủ sau ~15 phút** không request, đánh thức ~1 phút | ☠️ Webhook đầu tiên sau khi ngủ **sẽ timeout**. GitHub chỉ cho ~10s. → **phải có UptimeRobot ping 5 phút** |
| **Background Worker là loại service TRẢ PHÍ** | `hub-worker` không có chỗ đứng trên free tier dưới dạng Background Worker |
| Free tier có **hạn mức tổng giờ instance/tháng** (thường nói ~750h) | ⚠️ **Một service always-on đã ăn ~730h/tháng.** Hai service always-on **vượt hạn mức.** Kiểm lại con số hiện hành |
| RAM/CPU free hạn chế | Không chạy tải nặng ở đây (đã có môi trường local) |

### 3.2. Ba phương án — chọn theo túi tiền

| | Cấu hình | Chi phí | Đánh đổi |
|---|---|---|---|
| **A** ⭐ khuyến nghị | `hub-api` free + UptimeRobot ping · `hub-worker` **Starter trả phí** | ~$7/tháng | Rẻ, đúng kiến trúc, worker luôn sống. **Giữ BB-4 trên cả hai môi trường** |
| **B** | Cả hai Starter trả phí | ~$14/tháng | An toàn nhất, không lo quota giờ |
| **C** | Cả hai là Web Service free, cùng bị UptimeRobot ping | $0 | ⚠️ **Vượt hạn mức giờ instance** → service bị dừng giữa tháng. Và `hub-worker` phải mọc thêm một HTTP `/health` giả chỉ để được ping. Mong manh |

| **D** ✅ **đang dùng** (ADR-129) | MỘT Web Service free chạy `docker-entrypoint.sh hub-all`: hub-api + hub-worker là **hai tiến trình Node** dưới supervisor `docker/hub-all.js` | $0 | Hai tiến trình chung một container 512 MB và chung số phận (một con chết → supervisor dừng hết → Render khởi động lại). Xem chi tiết dưới |

**Phương án D (ADR-129) — Admin chọn để không trả phí worker.** Lựa chọn TRIỂN KHAI do free tier, không phải kiến trúc: BB-4
vẫn giữ — vẫn hai process, mỗi process một AMQP connection + một pool Prisma riêng; local/hubv vẫn chạy hai service tách rời.
- `docker-entrypoint.sh hub-all`: chạy bước chuẩn bị của hub-api MỘT lần (`prisma migrate deploy` bằng `DIRECT_URL` = owner),
  rồi `exec node docker/hub-all.js` (PID 1) sinh hai con: `hub-api` (nghe `$PORT`) và `hub-worker` (`WORKER_METRICS_PORT=0`).
- SIGTERM/SIGINT → chuyển cho cả hai; supervisor chờ tối đa `SHUTDOWN_TIMEOUT_MS` (25 s; Render SIGKILL ~30 s) rồi SIGKILL, con nhận hạn 22 s (D-6). Chỉ **worker** drain; **hub-api thoát ngay** (chưa có shutdown hook) — request đang dở bị cắt trước khi trả 2xx, provider gửi lại, BB-2/BB-3 bảo đảm không mất/không đôi (D-2).
  Một con thoát ngoài ý muốn → SIGTERM con kia → container thoát ≠ 0 → Render khởi động lại (không có trạng thái nửa sống).
- Log: dòng JSON giữ nguyên + trường `"proc":"api"|"worker"|"supervisor"` (thêm `"edge"` khi `EDGE_NGINX=1`, §3.6).
- Pool: supervisor đặt `connection_limit` trong `DATABASE_URL` cho từng con — `HUB_ALL_API_DB_CONNECTIONS` (mặc định 5) +
  `HUB_ALL_WORKER_DB_CONNECTIONS` (mặc định 5) = 10 kết nối client tới pooler Neon (PgBouncer, giới hạn hàng nghìn — dư).
- RAM (đo hubv, `mem_limit: 512m`, sau smoke + một đơn Shop PAID): xem ADR-129. Heap mỗi con giới hạn bằng
  `--max-old-space-size` (`HUB_ALL_API_HEAP_MB` = 200, `HUB_ALL_WORKER_HEAP_MB` = 220).
- Giờ instance free: Render cho 750 giờ/tháng/tài khoản. `hub-all` luôn thức (UptimeRobot ping `/health` 5 phút) ≈ 730 giờ;
  `shop` free để NGỦ khi không dùng (đánh thức ~1 phút) — đừng ping shop liên tục, không thì vượt 750 giờ.
- Kiểm chứng: `bash scripts/hub-all-e2e.sh` (image thật trên hubv, `docker-compose.verify-allinone.yml`).
- **EG1 (ADR-175):** `EDGE_NGINX=1` thêm con thứ ba `edge` = nginx nghe `$PORT`, hub-api lùi vào `127.0.0.1:4000`. Mặc định
  **tắt** — không đặt biến thì container chạy y như trên. Chi tiết, biến và cách đo IP thật: §3.6.

### 3.3. `render.yaml` (Blueprint — hạ tầng bằng code, đưa vào phụ lục báo cáo)

```yaml
services:
  - type: web
    name: hub-api
    runtime: docker
    region: singapore
    dockerfilePath: ./Dockerfile
    dockerCommand: docker-entrypoint.sh hub-api     # entrypoint nhận: hub-api | hub-worker | shop | web | seed
    healthCheckPath: /health
    plan: free
    envVars: [...]

  # Phương án D (ĐANG DÙNG, ADR-129): KHÔNG có service worker riêng — service hub-api chạy
  #   dockerCommand: docker-entrypoint.sh hub-all     (hub-api + hub-worker = 2 tiến trình trong 1 container)
  # và env = HỢP của khối [hub-api] + [hub-worker]. Khối dưới chỉ dùng cho phương án A (worker Starter trả phí):
  - type: worker            # Starter trả phí (phương án A)
    name: hub-worker
    runtime: docker
    region: singapore
    dockerfilePath: ./Dockerfile
    dockerCommand: docker-entrypoint.sh hub-worker
    plan: starter
    envVars: [...]

  - type: web
    name: shop
    runtime: docker
    region: singapore
    dockerfilePath: ./Dockerfile
    dockerCommand: docker-entrypoint.sh shop
    healthCheckPath: /products   # shop KHÔNG có route /health
    plan: free
    envVars: [...]               # SHOP_PORT = PORT (shop đọc SHOP_PORT, Render cấp PORT) — xem HUONG-DAN-DEPLOY §8
```

**Một Dockerfile multi-stage, một image, ba `dockerCommand` khác nhau** (`docker-entrypoint.sh hub-api|hub-worker|shop`). Không build nhiều image.

### 3.4. ⚠️ Graceful shutdown: **25 giây**, không phải 30

Render gửi `SIGTERM` rồi `SIGKILL` sau ~30s. Timeout drain trong `ARCHITECTURE.md` §5.6 đang để đúng 30s — **đúng mép vực**.

**Hạ xuống 25s.** Sai chỗ này lộ ra dưới dạng *"thỉnh thoảng mất message sau khi deploy"* — loại lỗi khó debug nhất.

### 3.5. Khác

- Phải nghe biến môi trường **`PORT`** của Render, không hardcode 4000.
- `RENDER_EXTERNAL_URL` dùng để tự cấu hình CORS/callback.
- Deploy từ GitHub, auto-deploy nhánh **`master`** (repo không có `main`).

### 3.6. Cửa vào nginx trong container `hub-all` (EG1, ADR-175/176)

`EDGE_NGINX=1` → supervisor `docker/hub-all.js` dựng `docker/nginx/nginx.conf.template` bằng `envsubst` (chỉ thay danh
sách biến cố định, `docker/nginx/edge.js`) rồi chạy thêm con `edge` = `nginx -g 'daemon off;'`:

```
proxy Render ──► nginx :$PORT ──► hub-api 127.0.0.1:$EDGE_API_PORT (HOST=127.0.0.1, TRUST_PROXY=1 tự đặt)
                                   hub-worker (không đổi)
```

- **Rollback = một biến:** xoá `EDGE_NGINX` (hoặc đặt `0`) → Render khởi động lại → hub-api nghe thẳng `$PORT` như cũ.
- **Health check** `/health` đi qua nginx, không bị cầu chì. Không cần đổi cấu hình health check của Render.
- **Tắt máy:** nginx nhận `SIGQUIT` (trả nốt request đang proxy, tối đa `EDGE_DRAIN_MS` − 1 s = 15 s — `worker_shutdown_timeout`, dẫn ra từ biến, luôn nhỏ hơn thời gian hub-api chờ), worker nhận
  `SIGTERM` ngay, hub-api nhận `SIGTERM` khi nginx đã thoát (chậm nhất `EDGE_DRAIN_MS`) — hub-api thoát ngay khi nhận
  SIGTERM (không drain HTTP), nên phải chờ nginx trả xong. Tổng vẫn trong 25 s.
- **Log:** access log JSON của nginx (`ts, ip, peer, xff, method, uri_path, status, limit_req_status, limit_conn_status,
  request_id, bytes, rt`) đi về supervisor qua syslog UDP 127.0.0.1 (stdout của tiến trình con là socket, nginx không mở
  được `/dev/stdout`), in ra với `"proc":"edge"`. Lỗi nginx (kể cả dòng `limiting requests` khi cầu chì chặn) đi stderr
  với tiền tố `[edge]`. stdout chậm (đệm > 1 MB) → supervisor **bỏ** dòng access log (không dồn RAM) và in số dòng đã bỏ.
- **hub-api chưa lên / timeout** → nginx trả `503 service_unavailable` JSON (khuôn ERRORS.md, `Retry-After: 5`) thay trang
  HTML 502/504. Provider gặp 5xx thì tự gửi lại.
- **RAM:** nginx 1 worker ≈ 7 MB (master) + 6 MB (worker) RSS, đo trong container `edge` của hubv.
- **Lỗi cấu hình** → supervisor in lỗi và thoát 1 ngay lúc khởi động: `EDGE_TRUSTED_PROXIES` sai khuôn; `EDGE_API_PORT` trùng
  `PORT`; dải tin cậy **quá rộng** (`/0`, IPv4 < /8, IPv6 < /16) mà `EDGE_REAL_IP_RECURSIVE=on` (nginx sẽ lấy phần tử
  **đầu** của XFF = IP client tự đặt); **`EDGE_NGINX=1` mà `EDGE_TRUSTED_PROXIES` trống** (spec EG D11 — mọi người mang IP
  proxy Render; chỉ chạy được khi cố ý đặt `EDGE_ALLOW_NO_REAL_IP=1`, kèm cảnh báo level 50); `TRUST_PROXY` của hub-api
  không phải `0`/`1`/IP/CIDR (vd `true`, `yes`) hoặc dải quá rộng → hub-api thoát; nginx không chạy được (thiếu binary…) → coi như con chết ngoài ý muốn, cả nhóm dừng, Render khởi động lại.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `EDGE_NGINX` | tắt | `1` = chạy nginx trước hub-api trong `hub-all`. Không ảnh hưởng `docker-entrypoint.sh hub-api` |
| `EDGE_IP_FUSE` | **tắt** | `1` = bật cầu chì IP (`limit_req`) cho `/hooks/*` và `/v1/p/*`. **Chỉ bật sau khi đã đo IP thật (bên dưới)** — ADR-176 |
| `EDGE_IP_RATE` | 50 | request/giây/IP của cầu chì (kẹp 1–100000). Phải đủ cho **TỔNG** lưu lượng một provider trên **mọi** tenant (GitHub, PayOS gửi từ chung dải IP) |
| `EDGE_IP_BURST` | 500 | burst `nodelay` (kẹp 0–1000000) |
| `EDGE_CONN_PER_IP` | 50 | kết nối đồng thời/IP cho `/hooks/*` (`limit_conn`, luôn bật khi có nginx) |
| `EDGE_TRUSTED_PROXIES` | trống | IP/CIDR tin cậy cho `set_real_ip_from`, cách nhau dấu phẩy/khoảng trắng. Trống = không tin `X-Forwarded-For` (IP = địa chỉ kết nối TCP — trên Render đó là IP proxy, CHUNG cho mọi người) |
| `EDGE_REAL_IP_RECURSIVE` | `on` | `real_ip_recursive`. `off` = lấy phần tử **cuối** của XFF. Dải quá rộng (`/0`…) BẮT BUỘC `off` |
| `EDGE_ALLOW_NO_REAL_IP` | tắt | `1` = cho `EDGE_NGINX=1` chạy khi `EDGE_TRUSTED_PROXIES` trống (cố ý, chỉ hợp lý khi KHÔNG có proxy phía trước; cảnh báo level 50). Không đặt thì từ chối khởi động |
| `EDGE_API_PORT` | 4000 | cổng nội bộ của hub-api khi có nginx (phải khác `PORT`) |
| `EDGE_DRAIN_MS` | 16000 | hub-api chờ nginx thoát tối đa chừng này khi tắt máy (kẹp để còn ≥ 6 s trước mốc SIGKILL); `worker_shutdown_timeout` của nginx = giá trị này − 1 s |
| `HOST` | trống | địa chỉ hub-api nghe. `hub-all` tự đặt `127.0.0.1` khi `EDGE_NGINX=1`; trống = mọi interface như cũ. Không đặt tay trên Render |

**Lần bật đầu tiên trên Render (Admin làm; phiên dev không có quyền Render):**

1. Thêm env cho service `hub-all`: `EDGE_NGINX=1`, `EDGE_TRUSTED_PROXIES=0.0.0.0/0,::/0`, `EDGE_REAL_IP_RECURSIVE=off`.
   Không đặt `EDGE_IP_FUSE`. Cấu hình này = **đúng hành vi `TRUST_PROXY=1` hôm nay**: tin chặng ngay trước (proxy Render —
   chỉ nó gọi được vào container) và lấy phần tử **cuối** của `X-Forwarded-For`. Nếu đã đặt tay `PORT=4000` thì thêm
   `EDGE_API_PORT=4001`. **Bắt buộc `EDGE_REAL_IP_RECURSIVE=off`** với `0.0.0.0/0` (để `on` thì app từ chối khởi động).
   Lưu ý: `0.0.0.0/0` cũng tin mọi máy trong **private network của Render** (service khác cùng tài khoản gọi thẳng
   `$PORT` được, tự đặt XFF) — giống hệt `TRUST_PROXY=1` hôm nay; thu hẹp ở bước 5 nếu đo được dải proxy.
2. Chờ deploy xanh, mở `https://<hub>/health` → 200. Log Render có dòng `{"proc":"edge",…,"uri_path":"/health"}`.
3. **Đo IP thật** (§3.2 của SPEC-chong-qua-tai). Từ máy của bạn:
   ```bash
   curl -s https://api.ipify.org; echo                                  # IP thật của bạn, gọi là MY_IP
   curl -s -o /dev/null https://<hub>/health                            # lượt A: không header
   curl -s -o /dev/null https://<hub>/health -H 'x-forwarded-for: 6.6.6.6' -H 'x-real-ip: 6.6.6.6'   # lượt B: IP giả
   ```
   Trong log Render tìm hai dòng `"proc":"edge"` của `/health` vừa rồi, đọc `ip`, `peer`, `xff`:
   - **Đạt:** cả hai lượt có `ip` = `MY_IP`. `peer` là IP proxy Render (vd `10.x.x.x`), `xff` lượt B dạng `6.6.6.6, MY_IP`.
   - `ip` = `6.6.6.6` ở lượt B → Render không ghi/không nối XFF như giả định. **Dừng:** đặt `EDGE_TRUSTED_PROXIES=` (trống),
     **không** bật cầu chì, ghi lại vào bảng dưới + ADR-176.
   - `ip` = `peer` hoặc một IP không phải của bạn (vd IP CDN) → mọi người sẽ trông như cùng IP. **Không** bật cầu chì; ghi lại.
4. Lặp bước 3 từ một mạng khác (4G điện thoại) → `ip` phải đổi theo mạng.
5. (Tuỳ chọn, chặt hơn) Nếu `peer` luôn nằm trong một dải cố định, thử `EDGE_TRUSTED_PROXIES=<dải đó>` +
   `EDGE_REAL_IP_RECURSIVE=on`, đo lại bước 3–4. Chỉ giữ nếu vẫn đạt; `xff` có chặng lạ sau `MY_IP` thì quay lại bước 1.
6. Đạt → đặt `EDGE_IP_FUSE=1`, deploy lại, ghi kết quả vào bảng dưới. Vài ngày đầu xem log `limit_req_status":"REJECTED"`
   và trang "Recent Deliveries" của GitHub webhook: có 429 thật từ provider → tăng `EDGE_IP_RATE`/`EDGE_IP_BURST` (chỉ env).

| Ngày | Cấu hình real IP | Lượt A `ip` | Lượt B `ip` | `peer` | Kết luận / `EDGE_IP_FUSE` |
|---|---|---|---|---|---|
| _chưa đo_ | | | | | cầu chì **tắt** |

**Kiểm ở local (không cần Render):**
- L0: `npx jest apps/hub-api/test/edge-nginx.spec.ts` (template, envsubst, regex sourceKey [EG:T3], supervisor [EG:T9] với
  nginx giả). Có `EDGE_NGINX_BIN` thì [EG:T9] và [EG:T11] (phần d) — chuỗi nginx thật → express `trust proxy 1` — chạy với
  nginx THẬT; job `unit` của CI cài nginx và đặt biến này.
- nginx THẬT trong image: `docker build -t hub-edge . && docker run --rm --entrypoint node -e EDGE_NGINX_BIN=nginx hub-edge
  node_modules/jest/bin/jest.js -w 1 --runTestsByPath apps/hub-api/test/edge-nginx.spec.ts` — test in `T9 nginx THẬT: 200 sau … ms, exit 0`.
- L2 trên hubv: service `edge` (:18080 → hub-api, trần thấp 5 r/s burst 10) + `edge-sink` (:18090 → sink, chỉ hubv) —
  `npm run verify:e2e -- --tag EG1` ([EG:T2], [EG:T10], [EG:T11]).
- Compose dev: `edge` nghe :8080 (cầu chì bật, không có proxy phía trước nên IP kết nối là IP thật). k6 vẫn bắn thẳng
  `hub-api:4000`; số đo bắn qua `edge` phải ghi rõ trong báo cáo.
- Compose: `edge` nằm RIÊNG trên mạng `edge_net` với IP cố định; hub-api có `TRUST_PROXY` = đúng IP đó (`main.ts` nhận danh
  sách IP/CIDR, `apps/hub-api/src/trust-proxy.ts`) → qua edge, `req.ip` của hub-api = IP client mà nginx thấy (từ máy host là
  gateway `.1` của edge_net); gọi thẳng :4000/:14000 với XFF giả thì **không** được tin.
  - dev: `EDGE_NET_SUBNET=10.250.250.0/29`, `EDGE_NET_RANGE=10.250.250.0/30`, `EDGE_IP=10.250.250.6` (mặc định, đổi được qua env;
    `TRUST_PROXY` mặc định theo `EDGE_IP`). **Đừng đặt `TRUST_PROXY=0` trong `.env` local** — đè mặc định, qua edge thì
    `req.ip` thành IP container.
  - hubv: `docker-compose.verify.yml` đè sang `10.250.251.0/29`, edge `10.250.251.6`, hub-api `TRUST_PROXY=10.250.251.6` →
    stack dev và hubv chạy cùng lúc không bị `Pool overlaps` (đã thử: tạo mạng 10.250.250.0/29 trong lúc hubv chạy).
- Bằng chứng regex `sourceKey` (2026-10-12, DB hubv, chỉ đọc): `SELECT count(*), count(*) FILTER (WHERE ('/hooks/'||provider||'/'||source_key)
  !~ '^/hooks/[a-z0-9-]+/[A-Za-z0-9_-]{1,64}$') FROM hub.sources` → **29 source, 0 không khớp**, key dài nhất 40 ký tự
  (payos 6, sepay 4, github 3, stripe 2, generic 2, api 12). Từ EG1 (spec D13), mọi đường tạo source (`POST /api/v1/sources`,
  "Kết nối provider") kiểm `sourceKey` tự đặt bằng `SOURCE_KEY_RE` = `^[A-Za-z0-9_-]{1,64}$` — TRÙNG phần sourceKey của regex
  nginx ([EG:T3] so hai regex) — sai thì 422 `validation_failed` (field `sourceKey`): key nào tạo được cũng qua được nginx. Chạy lại query này
  trên Neon trước khi bật `EDGE_NGINX` (key tạo trước EG1 qua API có thể lệch).

---

## 4. Neon (PostgreSQL)

### 4.1. Prisma cần HAI connection string

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // pooled (-pooler) — cho runtime
  directUrl = env("DIRECT_URL")     // direct          — cho prisma migrate
}
```

```
DATABASE_URL = postgresql://...@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/db?sslmode=require&pgbouncer=true&connection_limit=1
DIRECT_URL   = postgresql://...@ep-xxx.ap-southeast-1.aws.neon.tech/db?sslmode=require
```

**Thiếu `directUrl` → `prisma migrate` hỏng** trên PgBouncer transaction mode (nó cần prepared statements và advisory lock).

**Migrations, không `db push` (ADR-047, 2026-10-10).** `docker-entrypoint.sh hub-api` chạy `npx prisma migrate deploy --schema=libs/database/prisma/schema.prisma`. Lệnh này tự dùng `DIRECT_URL` (khai báo `directUrl` ở trên), nên trên Neon **bắt buộc** có `DIRECT_URL` trỏ endpoint direct, không phải `-pooler`. Neon đang có dữ liệu từ thời `db push` thì đánh dấu baseline một lần, **không reset**:

```bash
DATABASE_URL=<direct> DIRECT_URL=<direct> npx prisma migrate resolve --applied 0_init --schema=libs/database/prisma/schema.prisma
```

Trước đó kiểm `npx prisma migrate diff --from-schema-datasource libs/database/prisma/schema.prisma --to-schema-datamodel libs/database/prisma/schema.prisma` ra rỗng.

**User DB riêng cho Shop (ADR-046, ADR-125).** Local: role `shop_user` tạo bởi `docker/postgres/init/02-shop-user.sh`, chỉ thấy schema `shop`. Deployed **bắt buộc** có role riêng trên Neon — chạy MỘT lần trong SQL Editor của Neon bằng `neondb_owner` (role chạy migration), SAU `prisma migrate deploy`:

```sql
CREATE ROLE shop_user LOGIN PASSWORD '<mật khẩu mạnh, chỉ chữ/số>';   -- đã có thì: ALTER ROLE shop_user WITH LOGIN PASSWORD '…';
CREATE SCHEMA IF NOT EXISTS shop;
GRANT CONNECT ON DATABASE neondb TO shop_user;
GRANT USAGE ON SCHEMA shop TO shop_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shop TO shop_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA shop TO shop_user;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA shop GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shop_user;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA shop GRANT USAGE, SELECT ON SEQUENCES TO shop_user;
-- Cố ý KHÔNG GRANT gì trên schema hub.
```

Connection string của Shop: `postgresql://shop_user:<pw>@<ep>-pooler.<region>.aws.neon.tech/neondb?sslmode=require&schema=shop`.

`SELECT ... FOR UPDATE SKIP LOCKED` **vẫn chạy đúng** qua pooled vì nó nằm trong transaction tường minh. (`LISTEN/NOTIFY` thì **không** chạy qua transaction pooling — ta không dùng, đừng thêm vào.)

### 4.2. Autosuspend & dung lượng

- Free tier **ngủ sau ~5 phút** không hoạt động; request đầu phải đánh thức. → lý do #1 không đo p95 trên deployed.
- Dung lượng free hạn chế (~0.5GB). `raw_events` nặng vì lưu `headers` + `body` + `body_raw`, **~2KB/sự kiện**.
  - → **Không load test vào Neon.**
  - → Job `cleanup` phải chạy thật: xoá `raw_events` + `delivery_attempts` + `processed_messages` cũ hơn N ngày.
- **Neon branching**: nhánh `dev` riêng cho phát triển, `main` cho production. Rẻ, và là một đoạn hay trong báo cáo.

### 4.3. Hạn mức dung lượng theo project (QT, SPEC-han-muc-dung-luong, ADR-182..187, 189, 190)

Ổ Neon free (~0,5GB) dùng chung cho mọi project. Mỗi project có hạn mức `PROJECT_STORAGE_QUOTA_MB` (mặc định 50, operator
ghi đè ở trang Dự án); tổng hạn mức được **cấp vượt** (10 × 50MB ≈ cả ổ) nên có thêm chốt toàn cục `DB_DISK_BUDGET_MB × 80%`.
Nấc: 70 / 85 / 95 cảnh báo (email owner + operator, banner, webhook `hub.project.storage`), 100% `LOCKED` (507 cho source
thường), 110% `HARD_LOCKED` (507 cả source "Giữ lâu"). Số liệu là **ước tính** (cộng dồn byte qua bộ gộp EG4, hiệu chỉnh
bằng quét thật mỗi 24h).

**Hai cờ an toàn — mặc định 0 ở production (E5).** Deploy tự động có thể chạy ban đêm; không được để nó tự khoá project thật
hay tự xoá dữ liệu thật trước khi Admin kiểm số đo trên dữ liệu thật. Cờ đọc MỘT lần lúc khởi động (đổi = đổi env + restart,
tắt lại là rollback tức thì). Đặt `STORAGE_LOCK_ENABLED` giống nhau ở hub-api VÀ hub-worker (worker dùng nó để câu email /
webhook `lockEnabled` nói thật).

| Cờ = 0 | Hệ thống vẫn làm | Không làm |
|---|---|---|
| `STORAGE_LOCK_ENABLED` | đo, đổi nấc, alert, email, webhook, banner ("Khoá chưa bật…, sự kiện vẫn được nhận"); đếm `hub_ingest_storage_would_reject_total` | trả 507 |
| `STORAGE_AUTO_CLEAN_ENABLED` | seed policy mặc định (Rác xoá 1 ngày, Thấp dọn 3 ngày), hiện trên console "Đã cài, chưa chạy"; dọn tay vẫn chạy | dọn tự động |

**Checklist bật** (ghi ngày bật từng cờ vào bảng dưới):
1. Deploy với cả hai cờ = 0. **Người vận hành đã lưu Cài đặt cảnh báo TRƯỚC QT6** (review QT-S3 L7): `email_rules` cũ không có
   `hub.storage_near_full` / `project.storage_*` (`DEFAULT_EMAIL_RULES` chỉ áp cho người CHƯA có tuỳ chọn) -> vào Cài đặt cảnh
   báo tick các luật mới, không thì không nhận email dung lượng.
2. Chờ ≥ 24h để có ít nhất một lượt hiệu chỉnh. Log `Storage: hiệu chỉnh (quét thật)` có `driftPct` = (cộng dồn − quét thật) / quét
   thật. |driftPct| > 20% thì CHƯA bật — xem lại `bloat_factor`.
3. Xem danh sách project ≥ 95% (cột "Mức sử dụng" ở trang Dự án của operator). Owner đã nhận email chưa (`hub.alert_emails`)?
4. Bật `STORAGE_LOCK_ENABLED=1` (hub-api + hub-worker). Theo dõi `hub_ingest_storage_rejected_total`.
5. Xem policy dọn tự động của từng project thật (trang Dung lượng), rồi bật `STORAGE_AUTO_CLEAN_ENABLED=1`.
6. Ghi ngày bật:

| Cờ | Ngày bật | Người bật |
|---|---|---|
| `STORAGE_LOCK_ENABLED` | — | — |
| `STORAGE_AUTO_CLEAN_ENABLED` | — | — |

**Chi phí Redis của StorageJob** (không nằm trên đường nóng — `redis-budget.spec.ts` không đổi): 1 `SET NX EX` mỗi nhịp nấc
(60s) + 1 `SET NX EX` mỗi nhịp kiểm hiệu chỉnh (≤ 1h) **mỗi instance worker** ≈ 1.440 + 24 lệnh/ngày/instance. **Đổi nấc
không phải 0 lệnh Redis:** StorageAlerts gọi `evaluator.announce` -> 1 `PUBLISH hub:realtime:alerts` cho MỖI alert đổi trạng
thái, tức tối đa **2 PUBLISH / lần đổi nấc** (đóng alert nấc cũ + mở alert nấc mới; về OK chỉ đóng = 1; lượt nhắc email
24h không đổi alert = 0). Hiếm, sau COMMIT, dùng chung kết nối của AlertEvaluator. Chốt ổ `hub.storage_near_full` cũng
1 PUBLISH khi mở/đóng. Email/webhook đi Postgres (outbox), 0 lệnh Redis. Đường ingest: +0 lệnh Redis, +0 lượt DB (khoá đọc `level` trong chính câu nạp source).

---

## 5. Upstash (Redis)

### 5.1. Kết nối

Dùng endpoint **`rediss://`** (giao thức Redis over TLS), **không dùng REST API** — `ioredis` và Socket.IO adapter cần giao thức thật.

```ts
new Redis(process.env.REDIS_URL, { enableAutoPipelining: true, maxRetriesPerRequest: 3 })
```

### 5.2. ⚠️ Ngân sách lệnh: **≤ 4 lệnh cố định / sự kiện + ≤ 2 lệnh / delivery** (R1, ADR-062)

**Số thật (đếm bằng test `apps/hub-api/test/redis-budget.spec.ts`, S3-5, 10/10):**

| Chặng | Lệnh | Số |
|---|---|---|
| ingest | `EVAL` rate limit (INCR+EXPIRE trong Lua) · `GET` idem · `SET NX` idem (sau COMMIT) | 3 |
| normalize | `PUBLISH hub:realtime:events` (một lần cho mỗi raw event) | 1 |
| mỗi delivery | `MGET` circuit (đích không throttle) **hoặc** một `EVAL` gộp circuit + throttle (đích có `rate_limit_rps`, review #2) · `PUBLISH hub:realtime:deliveries` (thành công khi `failures=0`: 0 lệnh circuit) | 2 |
| **Tổng** | 1 đích = **6**, 2 đích = **8** | |

Ngoài đường nóng: request sai chữ ký **0 lệnh** (EG3, ADR-178: rate limit chạy sau verify; trước đó 1 `EVAL`); request bị hộp phạt chặn 0 lệnh (ADR-177); delivery lỗi thêm `EVAL` INCR circuit; circuit HALF_OPEN thêm `EVAL` giành probe; gửi trùng (GET idem trúng) chỉ 2 lệnh. Đích có throttle **không** tốn thêm lệnh nào (đo `redis-cli MONITOR` 10/10 sau review #2: 1 SePay → 2 đích có `rate_limit_rps` = **8 lệnh client**, trước đó 10). Cố ý **giữ** `GET` idem trước transaction (không làm R2): request trùng trả lời từ Redis, khỏi mở transaction và chịu P2002 + rollback.

**Quota Upstash free (kiểm 10/10/2026 trên [upstash.com/pricing/redis](https://upstash.com/pricing/redis)): 500.000 lệnh/tháng** (≈ 16.600/ngày) → ≈ **2.700 sự kiện/ngày** với 1 đích (÷6), ≈ 2.000 với 2 đích (÷8) — chưa trừ lệnh nền (pub/sub adapter, health).

**Đích chết — chi phí Redis sau BP2–BP4** (ADR-196..198): mỗi lần hoãn vì circuit = **1 lệnh** (gate `LUA_GATE`, trước khi nạp DB) và **0 truy vấn đọc**; `next_attempt_at` ghi thưa ≤ 1 lần / 2 phút. OPEN lần đầu 60s rồi **300s** sau probe thất bại → hoãn vào `retry.5m`. Một delivery tới đích chết suốt cửa sổ, **mỗi lần thử**: ~7 vòng 5m trong trần 30 phút (7 EVAL) + 1–2 vòng 1m rơi vào các khoảng HALF_OPEN (mỗi vòng 1 EVAL, thêm 1 EVAL giành probe nếu thắng) + lần quá trần (1 EVAL gate + 1 PUBLISH realtime) ≈ **9–11 lệnh**; × 6 lần thử ≈ **55–65 lệnh / delivery** (trước BP: 30 lần hoãn × 6 = 180, chưa kể PUBLISH). 1.000 delivery của MỘT đích chết ≈ 55.000–65.000 lệnh ≈ **11–13% quota tháng** (trước: ~180.000, hơn một phần ba) — giảm khoảng 3 lần. Probe: ≤ 1 / đích / 5 phút. Sau hồi phục, slow-start (60s) thêm ≤ 1 lệnh mỗi vòng `retry.10s` cho message vượt trần ramp.

> ⚠️ **Chưa xác nhận** Upstash tính một `EVAL` là 1 lệnh: [tài liệu billing](https://upstash.com/docs/redis/overall/billing) chỉ nói "tính theo số lệnh", không nói riêng về script (tìm 10/10 không thấy). Mọi con số trên giả định 1 `EVAL` = 1 lệnh. Nếu Upstash tính cả lệnh bên trong script thì đường nóng tối đa: ingest 3 → 4 (INCR+EXPIRE ở lần đầu cửa sổ), delivery có throttle 2 → 4–5 (GET, GET, INCR, EXPIRE + PUBLISH). Cần hỏi support Upstash trước khi ghi số quota vào báo cáo.

*Lịch sử (trước S3-5):* thiết kế cũ tiêu 5–8 lệnh/sự kiện, **cộng thêm phần tệ nhất**:

> `metrics.tick` mỗi **2 giây** = **~43.000 lệnh/ngày chỉ để hệ thống đứng yên không làm gì.**

**Bắt buộc sửa:**

| Sửa | Cách |
|---|---|
| `metrics.tick` → **5 giây**, đếm **trong bộ nhớ** `hub-api` | Không chạm Redis mỗi tick. Chỉ đọc Redis khi cần số liệu tổng hợp liên-instance |
| Gộp lệnh | `enableAutoPipelining: true` |
| Cache cấu hình source/destination | **Không làm** — cấu hình đọc từ Postgres, không qua Redis (0 lệnh Redis), nên không cần cache |
| Đếm và ghi lại | ✅ `redis-budget.spec.ts` (Proxy đếm lệnh trên mọi client ioredis của api + worker) |

### 5.3. Pub/Sub — thiết kế phòng hờ (ADR-021)

Socket.IO adapter và kênh thông báo worker → api dùng Redis pub/sub. Trên Upstash việc này **chạy được**, nhưng mỗi message đều tính vào quota và hành vi có thể khác Redis tự host.

**Giải pháp:** tách sau một interface, **viết Ngày 7**, ~30 dòng:

```ts
interface RealtimeNotifier {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: (p: unknown) => void): Promise<void>;
}
// RedisNotifier      — mặc định (local + deployed)
// RabbitFanoutNotifier — dự phòng: fanout exchange, mỗi hub-api một queue tạm
```

Nếu Upstash giở chứng, đổi một dòng trong DI container. **Không sửa gì khác.** Đây là phòng hờ rẻ, không phải over-engineering — nó là đúng một interface và một class thứ hai chỉ viết khi cần.

> Ghi chú: Socket.IO Redis adapter **chỉ thực sự cần khi có nhiều instance `hub-api`**. Trên Render ta chạy **1 instance** → có thể tắt adapter ở deployed, bật ở local khi demo scale.

---

## 6. CloudAMQP (RabbitMQ) — món dễ bị quên nhất

Gói **Little Lemur** (free) giới hạn **số message/tháng** và **số connection đồng thời**. Kiểm lại con số hiện hành trước khi chốt.

| Ràng buộc | Ta ứng phó |
|---|---|
| Số queue | Topology cần **9 queue**: `q.normalize` · `q.normalize.dlq` · `q.delivery.main` · 5 tầng retry · `q.delivery.dlq`. Thoải mái |
| **Số connection** | ⚠️ **Một AMQP connection cho mỗi tiến trình, nhiều channel trên đó.** Đây là best practice chuẩn và là **câu trả lời khi hội đồng hỏi về quản lý kết nối**. Đừng mở connection cho mỗi consumer |
| **Số message/tháng** | ☠️ **Không load test vào CloudAMQP.** Một lần k6 500 rps là đủ đốt sạch |
| Không có Management UI theo ý muốn | → demo queue phình/xẹp ở **local** |
| **DLQ không có consumer** | `q.delivery.dlq`, `q.normalize.dlq` chỉ tăng → đặt **policy** `hub-dlq-bounded` (max-length 5000, drop-head) — xem §6.1 (ADR-052) |

### 6.1. Policy giới hạn DLQ (ADR-052) — đặt **một lần** sau khi tạo instance

**Không** thêm `x-max-length` vào arguments của queue (queue đã tồn tại khác arguments → `PRECONDITION_FAILED`, cạm bẫy 3). Dùng policy — đổi nóng được, không cần xoá queue. Giá trị nguồn: `DLQ_POLICY` trong `libs/messaging/src/topology.ts`. Local: service one-shot `rabbitmq-init` trong `docker-compose.yml` tự đặt mỗi lần `up`.

CloudAMQP: lấy host/user/pass/vhost từ trang instance (vhost thường **trùng user**). Management API là HTTPS cùng host:

```bash
# PUT idempotent — chạy lại vô hại. VHOST phải URL-encode ("/" -> %2F).
curl -u "$USER:$PASS" -X PUT -H 'content-type: application/json' \
  "https://$HOST/api/policies/$VHOST/hub-dlq-bounded" \
  -d '{"pattern":"^q\\.(delivery|normalize)\\.dlq$","definition":{"max-length":5000,"overflow":"drop-head"},"priority":10,"apply-to":"queues"}'

# Kiểm: hai DLQ phải hiện policy = hub-dlq-bounded
curl -s -u "$USER:$PASS" "https://$HOST/api/queues/$VHOST" | grep -o '"name":"q\.[a-z.]*dlq"[^}]*"policy":"[^"]*"'
```

Hoặc dùng UI CloudAMQP → *RabbitMQ Manager* → Admin → Policies với cùng giá trị. Lưu ý: mỗi queue chỉ chịu **một** policy (priority cao nhất) — nếu instance có policy mặc định khớp `.*`, priority 10 của ta phải cao hơn nó. Bị cắt đầu DLQ **không mất dữ liệu**: nguồn sự thật là Postgres (`deliveries` DEAD, `raw_events`), DLQ trong broker chỉ là bản sao để soi.

---

## 7. Vercel

### 7.1. Một thứ trên Vercel: `web` — Shop backend ở Render

| Ở đâu | Nội dung |
|---|---|
| Vercel `web` | Next.js — dashboard (client của `hub-api`) + giao diện cửa hàng (client của `shop`, `NEXT_PUBLIC_SHOP_API_URL`) |
| Render `shop` | Server Express (`apps/shop`): `GET /products` · `POST /orders` · `GET /orders/:code` · `POST /hub-webhook` · `POST /api/internal/reconcile`. Chạy liên tục: vòng tự đăng ký endpoint với hub + nhận push đã ký. `docker-entrypoint.sh shop`, cổng `SHOP_PORT` (= `PORT` Render cấp), health check `/products` |

`shop` kết nối Neon bằng role `shop_user` (pooled, `?sslmode=require&schema=shop`, §4). Chi tiết biến: HUONG-DAN-DEPLOY §8.

### 7.2. Cron đối soát — GitHub Actions, không phải Vercel Cron

Vercel Hobby giới hạn cron rất ngặt (không đủ cho chu kỳ 5 phút). Dùng scheduled workflow:

```yaml
# .github/workflows/reconcile.yml
on:
  schedule:
    - cron: '*/5 * * * *'     # 5 phút là chu kỳ nhỏ nhất GitHub Actions cho phép
jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -X POST "$SHOP_URL/api/internal/reconcile" -H "X-Internal-Token: $TOKEN"   # SHOP_URL = https://shop-xxxx.onrender.com
```

Endpoint đó **phải có token nội bộ** — nếu không thì ai cũng gọi được.

> Đây là pattern hợp lệ, không phải mẹo vặt. Ghi vào báo cáo: *"tác vụ định kỳ tách khỏi tiến trình ứng dụng, kích hoạt từ bên ngoài."*

### 7.3. Socket.IO qua Vercel → Render

Vercel **không chạy được WebSocket server** — nhưng không cần: server nằm ở `hub-api` trên Render, Vercel chỉ host **client**.

- Client ép `transports: ['websocket']` — tránh rắc rối handshake polling khi không có sticky session.
- Socket.IO KHÔNG đi qua rewrites của Vercel (khác site) → không dùng cookie: client xin **vé** 60 giây qua
  `/auth/socket-ticket?projectId=` (qua proxy, có cookie), đặt vào `auth: {ticket}` của handshake; hub-api kiểm vé +
  session còn sống trước khi chấp nhận kết nối (SPEC-auth §5.7).
- **CORS trên `hub-api`**: allowlist **đúng** domain production + regex cho preview URL của riêng bạn. **Đừng để `*.vercel.app` trống** — đó là cho phép mọi project Vercel của mọi người.

---

## 8. UptimeRobot

| Ping | Mỗi | Mục đích |
|---|---|---|
| `https://hub-api.onrender.com/health` | 5 phút | ☠️ **Chống Render ngủ** + giám sát |
| `https://shop-xxxx.onrender.com/products` | 5 phút | Giám sát + giữ shop (Render free) không ngủ |

Bật **public status page** → chụp vào báo cáo. Mười phút cấu hình, và nó trả lời câu *"làm sao biết hệ thống đang sống?"*.

---

## 9. Kiểm kê biến môi trường

```bash
# --- Hạ tầng ---
DATABASE_URL=            # Neon pooled (-pooler) — ĐĂNG NHẬP BẰNG ROLE hub_app (AU6). hub-api VÀ hub-worker: thêm đuôi
                         # `&pgbouncer=true&connection_limit=1`, vd
                         # postgresql://hub_app:<pw>@<ep>-pooler.<region>.aws.neon.tech/neondb?sslmode=require&schema=hub&pgbouncer=true&connection_limit=1
DIRECT_URL=              # Neon direct, role OWNER — chỉ cho prisma migrate + seed
                         # AU6 (RLS, ADR-108) — tạo role hub_app MỘT lần trên Neon (Console → Roles → New role
                         # "hub_app", hoặc SQL Editor bằng owner):
                         #   CREATE ROLE hub_app LOGIN PASSWORD '<mật khẩu mạnh>' NOSUPERUSER NOBYPASSRLS;
                         #   GRANT CONNECT ON DATABASE neondb TO hub_app;
                         # rồi chạy `prisma migrate deploy` (DIRECT_URL): migration cấp quyền schema hub + bật RLS.
                         # hub-api/hub-worker THOÁT nếu DATABASE_URL là role superuser/BYPASSRLS (vd neondb_owner).
                         # Seed trên deployed: `docker-entrypoint.sh seed` với DIRECT_URL (seed tự mở phiên hệ thống).
                         # MIGRATION DỮ LIỆU (R-7, ADR-111, sửa ở ADR-125): trên project Neon của đồ án `neondb_owner` là
                         # NOSUPERUSER nhưng **BYPASSRLS = true** (đã kiểm 11/10: `SELECT rolsuper, rolbypassrls FROM pg_roles
                         # WHERE rolname = current_user`) → owner BỎ QUA RLS, migration dữ liệu chạy đủ dòng. Vẫn GIỮ quy ước
                         # (phòng thủ nhiều lớp, mang sang được nhà cung cấp mà owner không có BYPASSRLS — khi đó FORCE RLS
                         # làm UPDATE/INSERT/DELETE ảnh hưởng 0 dòng không báo lỗi; đã tái hiện bằng `prisma migrate deploy`):
                         # mọi migration dữ liệu tạo sau 20261011110000_rls_hub_app mở đầu bằng
                         #   SET LOCAL app.rls_system = 'on';   -- Prisma gửi cả file một lần = một transaction ngầm
                         # Gate `data-migration-rls` (npm run verify:gates) đỏ nếu thiếu.
                         # `_prisma_migrations`: DIRECT_URL trên Neon không có ?schema= nên bảng này nằm ở schema `public`
                         # (local: `hub`). REVOKE trong migration RLS chỉ nhắm `hub._prisma_migrations` → trên Neon không
                         # trúng gì; hub_app vẫn bị permission denied ở `public._prisma_migrations` (không được cấp quyền).
REDIS_URL=               # Upstash rediss://
RABBITMQ_URL=            # CloudAMQP amqps:// (tên biến code đọc; trước đây file này ghi nhầm AMQP_URL)

# --- Bảo mật ---
MASTER_KEY=              # AES-256-GCM, ≥ 32 ký tự — KHÔNG commit (tên code đọc; trước đây ghi nhầm ENCRYPTION_MASTER_KEY)
# Đăng nhập console (SPEC-auth §7, ADR-103) — bốn secret, mỗi cái ≥ 32 ký tự và KHÁC nhau; hub-api thoát nếu sai
JWT_SECRET=              # access token 15 phút (cookie __Host-hub_at)
CSRF_SECRET=             # ký token CSRF gắn với session
SOCKET_TICKET_SECRET=    # vé Socket.IO 60 giây
OAUTH_COOKIE_SECRET=     # cookie state/PKCE của GitHub OAuth (AU5)
OPERATOR_EMAIL=          # operator = root của hub (seed). Deployed không tự seed: chạy `docker-entrypoint.sh seed` một lần
OPERATOR_PASSWORD_HASH=  # bcrypt cost 12. Render: dán hash nguyên `$` (không phải `$$` — chỉ compose nội suy)
WEB_PUBLIC_URL=          # https://<web>.vercel.app — CORS có credentials, link trong mail, OAuth callback
MAIL_DRIVER=gmail        # ADR-124: gmail (Gmail API qua HTTPS + OAuth2 — Render free CHẶN cổng SMTP) | resend. AU2. KHÔNG dùng `log` trên deployed (link xác minh/đặt lại mật khẩu sẽ nằm trong log Render)
RESEND_API_KEY=          # Admin cung cấp. Bẫy: chưa xác minh domain (DNS) thì Resend CHỈ gửi tới email chủ tài khoản
MAIL_FROM=               # resend: "Webhook Hub <onboarding@resend.dev>" hoặc no-reply@<domain đã xác minh>
                         # gmail: ĐÚNG địa chỉ Gmail đã cấp refresh token, vd "Webhook Hub <ban@gmail.com>"
GOOGLE_CLIENT_ID=        # gmail: OAuth client (Web application) — xem "Lấy GOOGLE_REFRESH_TOKEN" dưới khối này
GOOGLE_CLIENT_SECRET=    # gmail: KHÔNG commit, không log
GOOGLE_REFRESH_TOKEN=    # gmail: scope https://www.googleapis.com/auth/gmail.send. Thiếu biến nào -> hub-api thoát lúc khởi động
                         # Token bị thu hồi/hết hạn -> log "invalid_grant" chỉ cách lấy lại; đăng ký/quên mật khẩu vẫn trả ngay (gửi chạy nền)
GITHUB_OAUTH_CLIENT_ID=  # AU5: GitHub → Settings → Developer settings → OAuth Apps. KHÁC GITHUB_WEBHOOK_SECRET
GITHUB_OAUTH_CLIENT_SECRET=
                         # Authorization callback URL = https://<web>.vercel.app/auth/github/callback (qua proxy web)
                         # KHÔNG đặt GITHUB_OAUTH_BASE_URL trên deployed (chỉ cho fake-github; khác github.com -> app thoát)
GOOGLE_OAUTH_CLIENT_ID=  # AU5b (ADR-127): đăng nhập Google — client RIÊNG, KHÁC GOOGLE_CLIENT_ID/SECRET của driver mail gmail
GOOGLE_OAUTH_CLIENT_SECRET=
                         # Authorized redirect URI = https://<web>.vercel.app/auth/google/callback (qua proxy web). Cách tạo:
                         # mục "Tạo client đăng nhập Google" dưới khối này. KHÔNG đặt GOOGLE_OAUTH_FAKE_BASE_URL trên deployed
TRUST_PROXY=1            # sau proxy của Render: rate limit theo IP đọc X-Forwarded-For (request gọi THẲNG API). Nhận
                         # thêm danh sách IP/CIDR = chỉ tin đúng các proxy đó (compose local: IP của service edge)
WEB_PROXY_SECRET=        # R-2/ADR-110: ≥ 32 ký tự, GIỐNG HỆT biến cùng tên ở Vercel. Request console đi qua proxy của
                         # Vercel (rewrites) nên `req.ip` là IP egress của Vercel (chung cho mọi người). Web gửi IP thật
                         # trong `x-hub-client-ip` kèm secret này; API chỉ tin khi khớp (timingSafeEqual). Để trống =
                         # rate limit theo IP của console thành giới hạn CHUNG toàn hệ thống (khoá theo email vẫn đúng)
INTERNAL_TOKEN=          # cho /api/internal/reconcile
EMAIL_FILTER_CAPACITY=100000   # ADR-180: dung lượng Bloom filter gợi ý email đã có (/auth/email-check), FPR 0,1%.
                         # ≈ 435 KB/instance ở 100k (đỉnh ≈ 0,9 MB lúc dựng lại). Số user vượt -> degraded, mọi kiểm tra
                         # đi DB (vẫn đúng, chậm hơn) + log cảnh báo -> tăng biến này
EMAIL_FILTER_REBUILD_MS=600000 # ADR-180: chu kỳ dựng lại filter từ hub.users (bù tin pub/sub bị mất). 0 = chỉ dựng lúc boot

# --- Provider (nạp vào source_secrets, không đọc trực tiếp trong adapter) ---
PAYOS_CLIENT_ID= PAYOS_API_KEY= PAYOS_CHECKSUM_KEY=
SEPAY_API_KEY=           # lấy sau — không chặn Ngày 5
GITHUB_WEBHOOK_SECRET=

# --- Đích ---
TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=

# --- Vận hành ---
PORT=                    # Render cấp — không hardcode
CORS_ORIGINS=            # domain Vercel production
SHUTDOWN_TIMEOUT_MS=25000
EDGE_NGINX=              # EG1 (ADR-175): 1 = nginx trước hub-api trong hub-all. Trống = như cũ. Bảng đủ biến EDGE_* + HOST: §3.6
EDGE_IP_FUSE=            # ADR-176: cầu chì IP /hooks/* + /v1/p/*. CHỈ đặt 1 sau khi đo IP thật (§3.6 bước 3–6)
EDGE_IP_RATE=50 EDGE_IP_BURST=500 EDGE_CONN_PER_IP=50   # trần cầu chì (r/s, burst) và kết nối đồng thời/IP — đổi không cần build
EDGE_TRUSTED_PROXIES=    # set_real_ip_from (CIDR). Lần bật đầu: 0.0.0.0/0,::/0 + EDGE_REAL_IP_RECURSIVE=off (= TRUST_PROXY=1 hôm nay)
HOST=                    # không đặt tay: hub-all tự đặt 127.0.0.1 cho hub-api khi EDGE_NGINX=1
METRICS_TICK_MS=5000
NODE_ENV=production      # bật SSRF guard (§7.3 ARCHITECTURE); hub-api KHÔNG đăng ký /mock/* (ADR-054)
CIRCUIT_MAX_DEFER_MS=1800000 # hub-worker: trần THỜI GIAN hoãn vì circuit cho một lần thử rồi tính là một lần thử thất bại (BP2, ADR-196; thay CIRCUIT_MAX_DEFERRALS). Chỉ đặt THẤP hơn mặc định
CIRCUIT_OPEN_MAX_SECONDS=300 # hub-worker: OPEN sau probe thất bại (60..300s; BP3, ADR-197). Chỉ đặt THẤP hơn 300
DELIVERY_RAMP_START_RPS=2    # hub-worker: slow-start sau hồi phục (BP4, ADR-198) — trần đầu (rps)
DELIVERY_RAMP_STEP_SECONDS=10 # mỗi bước nhân đôi trần
DELIVERY_RAMP_SECONDS=60     # thời lượng ramp; 0 = tắt; chỉ đặt THẤP hơn 60
BACKPRESSURE_SET_POINT=0.05  # hub-worker: áp lực ngược cho DB (BP5, ADR-200) — tỷ lệ lỗi hạ tầng để bắt đầu lùi
BACKPRESSURE_PROBE_INTERVAL_MS=5000 # chế độ dò: 1 message / khoảng này khi lùi hẳn
BACKPRESSURE_HOLD_MAX_MS=60000 # giữ message chờ permit tối đa (phải < consumer_timeout của RabbitMQ), quá thì hoãn không đốt lượt; chỉ đặt THẤP hơn 60000
NORMALIZE_MAX_DEFER_MS=3600000 # normalize hoãn không đốt lượt khi DB ốm; chỉ đặt THẤP hơn mặc định
# BP5 (ADR-200): channel consumer RabbitMQ đóng bất thường -> hub-worker THOÁT (log kèm mã/lý do lỗi channel). Ở chế độ hub-all
# supervisor dừng cả hub-api, Render dựng lại container: ingest gián đoạn tới khi lên lại; provider tự retry (BB-3) nên không
# mất sự kiện; message chưa ack được RabbitMQ giao lại. Crash loop -> xem dòng log "AMQP channel consumer đóng bất thường" (code).
METRICS_TOKEN=           # BẮT BUỘC trên deployed: hub-api /metrics VÀ hub-worker :WORKER_METRICS_PORT/metrics đòi
                         # "Authorization: Bearer <token>" (review #6). Prometheus/scraper phải gửi token: trong
                         # prometheus.yml bỏ comment khối `authorization: {type: Bearer, credentials: ...}` ở cả 2 job
                         # (Prometheus không tự đọc env trong file cấu hình). Local: để trống.
WORKER_METRICS_PORT=9101 # hub-worker trên Render là background worker không nhận traffic ngoài -> đặt 0 nếu không scrape
INGEST_RATE_LIMIT_PER_MIN=100 # trần request/phút/source (S3-4)
EDGE_PENALTY_404_THRESHOLD=20  # hub-api, hộp phạt (EG2, ADR-177): số 404 do sourceKey KHÔNG tồn tại / 60s / IP thì chặn
                         # mọi /hooks/* của IP đó. Kẹp 5–1000. Mỗi instance đếm riêng (ngưỡng thực tế × số instance)
EDGE_PENALTY_401_THRESHOLD=30  # số 401 sai chữ ký / 60s / cặp (IP, sourceKey) thì chặn CHỈ cặp đó. Kẹp 5–1000
EDGE_PENALTY_BAN_SECONDS=600   # thời gian phạt, kẹp 30–86400
EDGE_PENALTY_ENABLED=1         # 0 = tắt hẳn hộp phạt (rollback). IP loopback/private không bao giờ bị chấm điểm
EDGE_PENALTY_GOOD_TTL=86400    # giây nhớ một cặp (IP, sourceKey) đã verify đúng: IP đang bị phạt vẫn thông cặp này. Kẹp 300–604800
EDGE_PENALTY_GOOD_IPS_PER_KEY=16     # số IP "tốt" nhớ cho MỖI sourceKey (LRU riêng — key này không đẩy được key khác). Kẹp 4–1024
EDGE_PENALTY_GOOD_KEYS_PER_TENANT=64 # số sourceKey tốt tối đa của MỘT project (LRU riêng — project này không đẩy được project khác). Kẹp 1–10000
EDGE_PENALTY_GOOD_MAX_KEYS=10000     # trần số sourceKey trong cache tốt. Kẹp 100–50000 (quyết định RAM khi mỗi key 1 IP)
EDGE_PENALTY_GOOD_MAX_ENTRIES=100000 # trần TỔNG số cặp tốt — RAM Render free 512MB cho cả hub-all. Kẹp 2000–500000
                                     # Đo heapUsed (review lượt 5, xấu nhất: mỗi project 1 key): ~850 byte/key kèm IP đầu
                                     # + ~120 byte mỗi IP thêm -> RAM ≈ KEYS × 850 + (ENTRIES − KEYS) × 120.
                                     # Mặc định (10k, 100k) ≈ 17MB; hai trần (50k, 500k) đo ≈ 79MB
                                     # Theo dõi gauge hub_ingest_penalty_good_entries
EDGE_PENALTY_401_GOOD_MULTIPLIER=10  # cặp tốt bị ban ở ngưỡng 401 × hệ số này (không miễn vô hạn). Kẹp 2–100
                         # SAU DEPLOY: kiểm hub_ingest_penalty_skipped_private_total ≈ 0 (panel Grafana 10). Chiếm
                         # > 50% /hooks = hub-api đang thấy IP của proxy/NAT, không phải IP thật -> hộp phạt không có tác dụng
EDGE_PENALTY_MAX_ENTRIES=50000 # trần số khoá trong bộ nhớ (LRU, khoá đang phạt giữ lâu hơn). Kẹp 1000–1000000
TRAFFIC_FLUSH_MS=60000   # hub-api (EG4, ADR-179): nhịp đẩy lưu lượng theo source từ bộ nhớ xuống Postgres, kẹp 5000–600000.
                         # Ghi lỗi -> giữ tối đa 10 phút dữ liệu rồi bỏ phần cũ (metric hub_traffic_flush_dropped_total)
TRAFFIC_RETENTION_DAYS=7 # hub-worker: cleanup xoá hub.source_traffic_minutely cũ hơn N ngày, kẹp 1–90
# --- Hạn mức dung lượng theo project (QT, ADR-182..187, 189, 190) — xem §4.3 ---
PROJECT_STORAGE_QUOTA_MB=50       # hub-api + hub-worker: hạn mức mặc định mỗi project (operator ghi đè từng project ở console)
DB_DISK_BUDGET_MB=512             # hub-worker: ngân sách ổ Postgres chung; > 80% -> cảnh báo operator hub.storage_near_full
STORAGE_LEVEL_INTERVAL_MS=60000   # hub-worker: nhịp cập nhật nấc (một truy vấn gộp xuyên project)
STORAGE_RECALIBRATE_INTERVAL_MS=86400000 # hub-worker: nhịp hiệu chỉnh (quét thật từng project)
STORAGE_LOCK_ENABLED=0            # hub-api + hub-worker: 1 = trả 507 khi LOCKED/HARD_LOCKED. MẶC ĐỊNH 0 ở production (E5)
STORAGE_AUTO_CLEAN_ENABLED=0      # hub-worker (+ hub-api cho câu console): 1 = chạy dọn tự động theo policy. MẶC ĐỊNH 0 (E5)
SOURCE_LIMIT_PER_PROJECT=20       # hub-api: trần source chưa lưu trữ mỗi project (operator miễn), 409 source_limit
DELIVERY_TIMEOUT_MS=5000 # hub-worker: trần tổng một lần gửi, kẹp 1000–10000 (ADR-078); đổi phải restart worker
ALERT_EMAIL_INTERVAL_MS=15000 # hub-worker (CB5, ADR-173): nhịp vòng gửi email cảnh báo; 0 = tắt. Worker CŨNG cần
                         # WEB_PUBLIC_URL (gốc deep link trong thư) + MAIL_DRIVER/MAIL_FROM/GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
                         # giống hub-api. Cấu hình mail sai không làm worker chết: email thử 3 lần rồi FAILED (log + metric)
                         # Hiện worker dùng CHUNG bộ GOOGLE_* với mail xác thực (một quota Gmail). Về sau nên tách bộ GMAIL_*
                         # riêng cho email cảnh báo (ADR-173 bổ sung, T-5). Stack hubv đặt ALERT_EMAIL_INTERVAL_MS=0.
RUN_SEED=                # deployed: ĐỂ TRỐNG (không tự seed). docker-compose local mặc định true (ADR-066)
SEED_TELEGRAM_ACTIVE=    # seed tạo subscription Telegram `payment.*` BẬT hay TẮT. Không đặt: bật khi có đủ
                         # TELEGRAM_BOT_TOKEN thật + TELEGRAM_CHAT_ID (hành vi cũ). Compose local mặc định false.
HUB_PUBLIC_URL=          # hub-api: URL https CÔNG KHAI của CHÍNH hub-api, vd https://hub-api-xxxx.onrender.com (không phải
                         # URL Vercel, không đuôi /). "Kết nối provider" (SPEC-ket-noi, ADR-138/151) đăng ký
                         # <HUB_PUBLIC_URL>/hooks/<provider>/<sourceKey> tại PayOS/Stripe. Thiếu / localhost / IP nội bộ ->
                         # 422 public_url_required (app vẫn chạy). Đổi domain -> kết nối báo DRIFTED, bấm "Kết nối lại".

# --- KHÔNG BAO GIỜ đặt trên production (hub-api VÀ hub-worker) — chỉ cho stack kiểm chứng / test ---
# *_FAKE_BASE_URL (PAYOS_/STRIPE_/GITHUB_/GOOGLE_OAUTH_…)  -> NODE_ENV=production + có giá trị: app THOÁT lúc khởi động
# CONNECTOR_INGEST_BASE_URL                                -> như trên (URL ingest của stack hubv)
# PAYOS_BASE_URL            -> connector bỏ qua (URL PayOS cứng), nhưng SDK @payos/node tự đọc biến này: đừng đặt
# VERIFY_ONLY_* / VERIFY_DB_OWNER_URL                       -> biến của phiên kiểm chứng, không thuộc deploy
# MAIL_DRIVER=capture       -> production + capture: app THOÁT (mail kiểm chứng)
# GITHUB_OAUTH_BASE_URL, MOCK_BASE_URL, NEXT_PUBLIC_DEMO_*  -> chỉ local

# --- web (Vercel) — build-time, Next inline vào bundle → KHÔNG đặt secret ở đây ---
NEXT_PUBLIC_HUB_API_URL=   # https://hub-api.onrender.com — Socket.IO (vé) + URL /hooks hiển thị cho người dùng
HUB_API_INTERNAL_URL=      # https://hub-api.onrender.com — đích proxy /api/* và /auth/* (Next tính lúc BUILD). REST của
                           # dashboard đi QUA proxy này để cookie phiên là cookie first-party của domain web
NEXT_PUBLIC_SHOP_API_URL=  # URL shop — storefront gọi
WEB_PROXY_SECRET=          # RUNTIME (không phải NEXT_PUBLIC_, không vào bundle) — giống hệt bên hub-api (R-2/ADR-110).
                           # `src/proxy.ts` gắn IP client (x-real-ip/x-forwarded-for do Vercel ghi đè) + secret
                           # N-4/ADR-123 — KIỂM MỘT LẦN trên Vercel thật (local thì client tự đặt XFF được, đã biết):
                           #   1. redis-cli (Upstash) --scan --pattern 'rl:reg:ip:*' -> ghi lại khoá hiện có
                           #   2. curl -X POST https://<web>/auth/register -H 'content-type: application/json'
                           #        -H 'x-forwarded-for: 6.6.6.6' -H 'x-real-ip: 6.6.6.6' -d '{"email":"x@y.vn","name":"x","password":"..."}'
                           #   3. khoá mới phải là rl:reg:ip:<IP THẬT của máy bạn>, KHÔNG phải rl:reg:ip:6.6.6.6.
                           #   Thấy 6.6.6.6 = Vercel không ghi đè header -> báo lại, đừng dựa vào giới hạn theo IP.
NEXT_PUBLIC_DEMO_SIMULATE= # chỉ 'true' ở LOCAL (ADR-027). Deployed: để trống
NEXT_PUBLIC_DEMO_SEPAY_APIKEY= # CHỈ LOCAL (apps/web/.env.local), cần khi DEMO_SIMULATE=true: seed key SePay cho nút giả lập. KHÔNG BAO GIỜ đặt trên Vercel
```

### Tạo client đăng nhập Google (AU5b, ADR-127)

1. Google Cloud project **`webhook-hub`** — dùng chung project với client gửi mail được (Admin đang làm vậy), nhưng là **client khác**.
   GO-5: chung project = chung **một consent screen và một trạng thái publish** (Branding/Audience): tên app/logo trên màn
   hình đăng nhập là của project đó, và scope nhạy cảm `gmail.send` chưa thẩm định nằm cùng app. Tách **hai project**
   (login / mail) là gia cố tuỳ chọn cho sạch, không bắt buộc.
2. **Google Auth Platform → Branding / Audience**: User type **External**; **Publish app → In production**. Scope chỉ
   `openid email profile` (không nhạy cảm) → **không cần Google thẩm định**, mọi tài khoản Google đăng nhập được.
3. **Google Auth Platform → Clients → Create client** → loại **Web application**:
   - *Authorized JavaScript origins*: **không cần** (luồng chạy ở server).
   - *Authorized redirect URIs*: `http://localhost:3000/auth/google/callback` (stack dev, đi qua web :3000) và
     `https://<web>.vercel.app/auth/google/callback`.
4. Chép Client ID / Client secret → `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (Render; local: `.env`).
   `WEB_PUBLIC_URL` phải khớp origin của redirect URI (local `http://localhost:3000`).
5. GO-2 (ADR-128): email Google trùng tài khoản ĐÃ xác minh chỉ tự liên kết khi Google là nơi cấp email (`@gmail.com`,
   `@googlemail.com`, hoặc Workspace có claim `hd` = domain email). Domain riêng khác → `/login?error=google_link_requires_password`:
   đăng nhập bằng mật khẩu. Hiện CHƯA có trang/endpoint "liên kết Google khi đang đăng nhập" — thêm khi có trang tài khoản.
6. Thử: `/login` → "Đăng nhập bằng Google". Lỗi `redirect_uri_mismatch` = URI ở bước 3 không khớp `<WEB_PUBLIC_URL>/auth/google/callback`.

### Lấy GOOGLE_REFRESH_TOKEN (MAIL_DRIVER=gmail, ADR-124)

1. **Google Cloud Console** → tạo/chọn project → *APIs & Services → Library* → bật **Gmail API**.
2. **Google Auth Platform** (menu trái; trước đây gọi là "OAuth consent screen / Credentials"), gồm ba mục *Branding / Audience / Clients*:
   - 2a. *Get started* / **Branding**: điền tên app + email hỗ trợ → tạo consent screen. Mục *Audience* và *Test users* chỉ hiện SAU bước này.
   - 2b. **Audience**: User type **External** — tài khoản @gmail cá nhân KHÔNG chọn được *Internal* (chỉ Google Workspace mới có).
     Rồi **Publish app → In production**: refresh token cho scope Gmail không còn hết hạn sau 7 ngày, và danh sách *Test users*
     không còn tác dụng (bỏ qua bước thêm test user nếu publish ngay). Nếu ở lại *Testing* thì PHẢI thêm đúng Gmail sẽ gửi thư
     vào *Test users*, và token chết sau 7 ngày (log báo `invalid_grant`).
   - App chưa qua xác minh của Google vẫn dùng được cho chính tài khoản của bạn (màn hình "unverified" → *Advanced → Go to …*).
3. **Clients → Create client** → loại **Web application**; *Authorized redirect URIs* thêm
   `https://developers.google.com/oauthplayground`. Ghi lại Client ID / Client secret → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Mở **https://developers.google.com/oauthplayground** → bánh răng ⚙ → tick **Use your own OAuth credentials** → dán Client ID/secret.
5. Ô *Input your own scopes*: `https://www.googleapis.com/auth/gmail.send` → **Authorize APIs** → đăng nhập ĐÚNG Gmail ở bước 2 → cho phép.
6. **Exchange authorization code for tokens** → chép **Refresh token** → `GOOGLE_REFRESH_TOKEN`. `MAIL_FROM` = chính Gmail đó.
7. Đặt 4 biến + `MAIL_DRIVER=gmail` trên Render (KHÔNG đặt ở Vercel, không commit), deploy, thử "Quên mật khẩu" với email của bạn.
   Thu hồi: https://myaccount.google.com/permissions → gỡ app (token chết ngay, log báo `invalid_grant`).


> **Nguyên tắc:** adapter **không đọc env**. Secret vào DB qua `source_secrets` (đã mã hoá). Env chỉ để seed lần đầu. Đây là lý do `verify()` nhận `secrets: string[]` làm tham số.

---

## 10. Deploy lần đầu — **cuối Ngày 3, không phải Ngày 13** (ADR-023)

Deploy lần đầu **luôn** mất một ngày. Mất nó ở Ngày 3 khi còn 11 ngày để xoay, tốt hơn nhiều so với Ngày 13.

### Checklist "deploy rỗng" (làm ngay khi xương sống chạy local)

- [ ] Tạo 5 tài khoản, **tất cả region Singapore**: Render · Neon · Upstash · CloudAMQP · Vercel
- [ ] `render.yaml` Blueprint, một Dockerfile multi-stage
- [ ] `prisma migrate deploy` chạy được lên Neon bằng `DIRECT_URL`
- [ ] `hub-api` lên, `/health` trả 200 với **cả ba** phụ thuộc xanh
- [ ] `hub-worker` lên, consume được `q.normalize` từ CloudAMQP
- [ ] Đổi URL webhook GitHub từ tunnel → URL Render
- [ ] **`git push` → tin nhắn Discord, đi qua hạ tầng thật**
- [ ] UptimeRobot ping 5 phút cả hai
- [ ] `web` lên Vercel, gọi được `hub-api`, Socket.IO kết nối được qua CORS

**DoD:** xương sống chạy **online**, không phải chỉ trên máy bạn.

### Sáu cái bẫy sẽ lộ ra đúng hôm đó

1. Region lệch → p95 thành nửa giây
2. Thiếu `DIRECT_URL` → `prisma migrate` hỏng
3. Không nghe `PORT` → Render báo service không lên
4. CORS chặn Socket.IO handshake từ Vercel
5. CloudAMQP từ chối connection thứ N
6. `SIGTERM` 30s = mép vực → mất message sau mỗi lần deploy

> Mỗi cái mất nửa ngày nếu gặp ở Ngày 13. Gặp ở Ngày 3 thì mất nửa giờ vì chưa có gì phức tạp chồng lên.

---

## 11. Chi phí

| Món | Chi phí |
|---|---|
| Render `hub-worker` Starter (phương án A) | ~$7/tháng |
| Render `hub-api` free + UptimeRobot ping | $0 |
| Neon · Upstash · CloudAMQP · Vercel · GitHub Actions · UptimeRobot · Sentry | $0 (free tier) |
| **Tổng** | **~$7/tháng** trong 1–2 tháng cần online |

> **Đã cân nhắc và loại:** một VPS ~$5/tháng chạy nguyên `docker-compose` sẽ cho RabbitMQ không quota, quyền kill container, và load test thoải mái — tức là gộp được hai môi trường làm một. Đổi lại mất trải nghiệm PaaS/serverless và phần "triển khai trên nền tảng hiện đại" trong báo cáo. **Đã chốt đi theo Render + Vercel + Neon + Upstash.**

## Xoay API key của một service (R2-2, ADR-098)

1. Console tạo key mới với **cùng `serviceName`** (ví dụ `shop`) và cùng scope. `serviceName` là danh tính của service: không đặt trùng cho hai service khác nhau.
2. Cập nhật `HUB_URL` của service sang key mới, khởi động lại service.
3. Revoke key cũ (`DELETE /api/v1/projects/:projectId/keys/:keyId`).
4. Lần `ensure` sau, endpoint cùng url của key cũ (đã revoke, cùng `serviceName`) được **nhận lại** (audit `endpoint.adopted`), không tạo endpoint thứ hai. Endpoint khác url của key cũ: operator tắt subscription ở console.
