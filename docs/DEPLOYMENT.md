# Triển khai — Webhook Hub

> Chốt 2026-09-17. Đi kèm [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`ROADMAP-14D.md`](ROADMAP-14D.md) · [`adr/README.md`](adr/README.md)
>
> ⚠️ Hạn mức free tier của mọi nhà cung cấp dưới đây **thay đổi liên tục**. Con số ghi ở đây là để *ước lượng ràng buộc*, **kiểm lại trang giá trước khi chốt tài khoản**.

---

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
| `shop` (3 endpoint + reconcile) | **Vercel** route handlers | ADR-022 |
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

> **Nếu buộc phải $0:** phương án D — chạy cả hai app trong **một container** (cùng image, hai tiến trình con). Code không đổi, chỉ đổi lệnh khởi động. Local vẫn chạy 2 service tách rời nên **BB-4 vẫn được chứng minh** — chỉ là chứng minh ở môi trường local. Ghi rõ vào báo cáo là lựa chọn vận hành do hạn mức, không phải do thiết kế.

### 3.3. `render.yaml` (Blueprint — hạ tầng bằng code, đưa vào phụ lục báo cáo)

```yaml
services:
  - type: web
    name: hub-api
    runtime: docker
    region: singapore
    dockerfilePath: ./Dockerfile
    dockerCommand: node dist/apps/hub-api/main.js
    healthCheckPath: /health
    plan: free
    envVars: [...]

  - type: worker            # Starter trả phí (phương án A)
    name: hub-worker
    runtime: docker
    region: singapore
    dockerfilePath: ./Dockerfile
    dockerCommand: node dist/apps/hub-worker/main.js
    plan: starter
    envVars: [...]
```

**Một Dockerfile multi-stage, một image, hai `dockerCommand` khác nhau.** Không build hai image.

### 3.4. ⚠️ Graceful shutdown: **25 giây**, không phải 30

Render gửi `SIGTERM` rồi `SIGKILL` sau ~30s. Timeout drain trong `ARCHITECTURE.md` §5.6 đang để đúng 30s — **đúng mép vực**.

**Hạ xuống 25s.** Sai chỗ này lộ ra dưới dạng *"thỉnh thoảng mất message sau khi deploy"* — loại lỗi khó debug nhất.

### 3.5. Khác

- Phải nghe biến môi trường **`PORT`** của Render, không hardcode 4000.
- `RENDER_EXTERNAL_URL` dùng để tự cấu hình CORS/callback.
- Deploy từ GitHub, auto-deploy nhánh `main`.

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

**User DB riêng cho Shop (ADR-046).** Local: role `shop_user` tạo bởi `docker/postgres/init/02-shop-user.sh`, chỉ thấy schema `shop`. Neon: tạo role tương tự bằng SQL trong script đó (chạy bằng role sở hữu schema, thay `:"migrator"` bằng role chạy migration), rồi đặt connection string của `shop` theo role này.

`SELECT ... FOR UPDATE SKIP LOCKED` **vẫn chạy đúng** qua pooled vì nó nằm trong transaction tường minh. (`LISTEN/NOTIFY` thì **không** chạy qua transaction pooling — ta không dùng, đừng thêm vào.)

### 4.2. Autosuspend & dung lượng

- Free tier **ngủ sau ~5 phút** không hoạt động; request đầu phải đánh thức. → lý do #1 không đo p95 trên deployed.
- Dung lượng free hạn chế (~0.5GB). `raw_events` nặng vì lưu `headers` + `body` + `body_raw`, **~2KB/sự kiện**.
  - → **Không load test vào Neon.**
  - → Job `cleanup` phải chạy thật: xoá `raw_events` + `delivery_attempts` + `processed_messages` cũ hơn N ngày.
- **Neon branching**: nhánh `dev` riêng cho phát triển, `main` cho production. Rẻ, và là một đoạn hay trong báo cáo.

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

Ngoài đường nóng: delivery lỗi thêm `EVAL` INCR circuit; circuit HALF_OPEN thêm `EVAL` giành probe; gửi trùng (GET idem trúng) chỉ 2 lệnh. Đích có throttle **không** tốn thêm lệnh nào (đo `redis-cli MONITOR` 10/10 sau review #2: 1 SePay → 2 đích có `rate_limit_rps` = **8 lệnh client**, trước đó 10). Cố ý **giữ** `GET` idem trước transaction (không làm R2): request trùng trả lời từ Redis, khỏi mở transaction và chịu P2002 + rollback.

**Quota Upstash free (kiểm 10/10/2026 trên [upstash.com/pricing/redis](https://upstash.com/pricing/redis)): 500.000 lệnh/tháng** (≈ 16.600/ngày) → ≈ **2.700 sự kiện/ngày** với 1 đích (÷6), ≈ 2.000 với 2 đích (÷8) — chưa trừ lệnh nền (pub/sub adapter, health).

> ⚠️ **Chưa xác nhận** Upstash tính một `EVAL` là 1 lệnh: [tài liệu billing](https://upstash.com/docs/redis/overall/billing) chỉ nói "tính theo số lệnh", không nói riêng về script (tìm 10/10 không thấy). Mọi con số trên giả định 1 `EVAL` = 1 lệnh. Nếu Upstash tính cả lệnh bên trong script thì đường nóng tối đa: ingest 3 → 4 (INCR+EXPIRE ở lần đầu cửa sổ), delivery có throttle 2 → 4–5 (GET, GET, INCR, EXPIRE + PUBLISH). Cần hỏi support Upstash trước khi ghi số quota vào báo cáo.

*Lịch sử (trước S3-5):* thiết kế cũ tiêu 5–8 lệnh/sự kiện, **cộng thêm phần tệ nhất**:

> `metrics.tick` mỗi **2 giây** = **~43.000 lệnh/ngày chỉ để hệ thống đứng yên không làm gì.**

**Bắt buộc sửa:**

| Sửa | Cách |
|---|---|
| `metrics.tick` → **5 giây**, đếm **trong bộ nhớ** `hub-api` | Không chạm Redis mỗi tick. Chỉ đọc Redis khi cần số liệu tổng hợp liên-instance |
| Gộp lệnh | `enableAutoPipelining: true` |
| Cache cấu hình source/destination | TTL 60s trong bộ nhớ tiến trình **trước** khi hỏi Redis |
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

### 7.1. Hai thứ trên Vercel

| Project | Nội dung |
|---|---|
| `web` | Next.js — dashboard (client của `hub-api`) + storefront UI (client của `shop`) |
| `shop` | Route handlers: `GET /api/products` · `POST /api/orders` · `POST /api/hub-webhook` · `POST /api/internal/reconcile` |

`shop` kết nối Neon bằng **pooled connection string** (serverless → nhiều kết nối ngắn).

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
      - run: curl -fsS -X POST "$SHOP_URL/api/internal/reconcile" -H "X-Internal-Token: $TOKEN"
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
| `https://<shop>.vercel.app/api/products` | 5 phút | Giám sát |

Bật **public status page** → chụp vào báo cáo. Mười phút cấu hình, và nó trả lời câu *"làm sao biết hệ thống đang sống?"*.

---

## 9. Kiểm kê biến môi trường

```bash
# --- Hạ tầng ---
DATABASE_URL=            # Neon pooled (-pooler, ?pgbouncer=true&connection_limit=1) — ĐĂNG NHẬP BẰNG ROLE hub_app (AU6)
DIRECT_URL=              # Neon direct, role OWNER — chỉ cho prisma migrate + seed
                         # AU6 (RLS, ADR-108) — tạo role hub_app MỘT lần trên Neon (Console → Roles → New role
                         # "hub_app", hoặc SQL Editor bằng owner):
                         #   CREATE ROLE hub_app LOGIN PASSWORD '<mật khẩu mạnh>' NOSUPERUSER NOBYPASSRLS;
                         #   GRANT CONNECT ON DATABASE neondb TO hub_app;
                         # rồi chạy `prisma migrate deploy` (DIRECT_URL): migration cấp quyền schema hub + bật RLS.
                         # hub-api/hub-worker THOÁT nếu DATABASE_URL là role superuser/BYPASSRLS (vd neondb_owner).
                         # Seed trên deployed: `docker-entrypoint.sh seed` với DIRECT_URL (seed tự mở phiên hệ thống).
                         # MIGRATION DỮ LIỆU (R-7, ADR-111): trên Neon owner KHÔNG phải superuser nên FORCE RLS chặn cả
                         # owner — UPDATE/INSERT/DELETE trên bảng có RLS ảnh hưởng 0 DÒNG mà KHÔNG báo lỗi (local thì
                         # chạy đúng vì hub_user là superuser → lệch môi trường im lặng). Mọi migration dữ liệu tạo sau
                         # 20261011110000_rls_hub_app phải mở đầu bằng:
                         #   SET LOCAL app.rls_system = 'on';   -- Prisma gửi cả file một lần = một transaction ngầm
                         # Gate `data-migration-rls` (npm run verify:gates) đỏ nếu thiếu. Đã thử bằng `prisma migrate
                         # deploy` với owner không superuser: thiếu dòng này → 0 dòng; có → đủ dòng.
REDIS_URL=               # Upstash rediss://
AMQP_URL=                # CloudAMQP amqps://

# --- Bảo mật ---
ENCRYPTION_MASTER_KEY=   # AES-256-GCM, 32 byte base64 — KHÔNG commit
# Đăng nhập console (SPEC-auth §7, ADR-103) — bốn secret, mỗi cái ≥ 32 ký tự và KHÁC nhau; hub-api thoát nếu sai
JWT_SECRET=              # access token 15 phút (cookie __Host-hub_at)
CSRF_SECRET=             # ký token CSRF gắn với session
SOCKET_TICKET_SECRET=    # vé Socket.IO 60 giây
OAUTH_COOKIE_SECRET=     # cookie state/PKCE của GitHub OAuth (AU5)
OPERATOR_EMAIL=          # operator = root của hub (seed). Deployed không tự seed: chạy `docker-entrypoint.sh seed` một lần
OPERATOR_PASSWORD_HASH=  # bcrypt cost 12. Render: dán hash nguyên `$` (không phải `$$` — chỉ compose nội suy)
WEB_PUBLIC_URL=          # https://<web>.vercel.app — CORS có credentials, link trong mail, OAuth callback
MAIL_DRIVER=resend       # AU2. KHÔNG dùng `log` trên deployed (link xác minh/đặt lại mật khẩu sẽ nằm trong log Render)
RESEND_API_KEY=          # Admin cung cấp. Bẫy: chưa xác minh domain (DNS) thì Resend CHỈ gửi tới email chủ tài khoản
MAIL_FROM=               # vd "Webhook Hub <onboarding@resend.dev>" (chưa có domain) hoặc no-reply@<domain đã xác minh>
GITHUB_OAUTH_CLIENT_ID=  # AU5: GitHub → Settings → Developer settings → OAuth Apps. KHÁC GITHUB_WEBHOOK_SECRET
GITHUB_OAUTH_CLIENT_SECRET=
                         # Authorization callback URL = https://<web>.vercel.app/auth/github/callback (qua proxy web)
                         # KHÔNG đặt GITHUB_OAUTH_BASE_URL trên deployed (chỉ cho fake-github; khác github.com -> app thoát)
TRUST_PROXY=1            # sau proxy của Render: rate limit theo IP đọc X-Forwarded-For (request gọi THẲNG API)
WEB_PROXY_SECRET=        # R-2/ADR-110: ≥ 32 ký tự, GIỐNG HỆT biến cùng tên ở Vercel. Request console đi qua proxy của
                         # Vercel (rewrites) nên `req.ip` là IP egress của Vercel (chung cho mọi người). Web gửi IP thật
                         # trong `x-hub-client-ip` kèm secret này; API chỉ tin khi khớp (timingSafeEqual). Để trống =
                         # rate limit theo IP của console thành giới hạn CHUNG toàn hệ thống (khoá theo email vẫn đúng)
INTERNAL_TOKEN=          # cho /api/internal/reconcile

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
METRICS_TICK_MS=5000
NODE_ENV=production      # bật SSRF guard (§7.3 ARCHITECTURE); hub-api KHÔNG đăng ký /mock/* (ADR-054)
CIRCUIT_MAX_DEFERRALS=30 # hub-worker: trần số lần hoãn liên tiếp vì circuit (≈30 phút) rồi tính là một lần thử thất bại (ADR-054)
METRICS_TOKEN=           # BẮT BUỘC trên deployed: hub-api /metrics VÀ hub-worker :WORKER_METRICS_PORT/metrics đòi
                         # "Authorization: Bearer <token>" (review #6). Prometheus/scraper phải gửi token: trong
                         # prometheus.yml bỏ comment khối `authorization: {type: Bearer, credentials: ...}` ở cả 2 job
                         # (Prometheus không tự đọc env trong file cấu hình). Local: để trống.
WORKER_METRICS_PORT=9101 # hub-worker trên Render là background worker không nhận traffic ngoài -> đặt 0 nếu không scrape
INGEST_RATE_LIMIT_PER_MIN=100 # trần request/phút/source (S3-4)
RUN_SEED=                # deployed: ĐỂ TRỐNG (không tự seed). docker-compose local mặc định true (ADR-066)
SEED_TELEGRAM_ACTIVE=    # seed tạo subscription Telegram `payment.*` BẬT hay TẮT. Không đặt: bật khi có đủ
                         # TELEGRAM_BOT_TOKEN thật + TELEGRAM_CHAT_ID (hành vi cũ). Compose local mặc định false.

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
