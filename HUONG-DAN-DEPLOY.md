# Hướng dẫn deploy Webhook Hub — Render + Vercel + Neon (11/10)

> Làm theo đúng thứ tự. Mỗi bước có **✅ Kiểm** — chưa xanh thì đừng sang bước sau, báo coordinator.
> **Giá trị secret không nằm trong file này.** Coordinator sinh và gom vào `.env.deploy.local` (git bỏ qua); bạn copy từ đó dán vào Render/Vercel.
> Tên biến trong file này **lấy từ code thật** (`docker-compose.yml`). `docs/DEPLOYMENT.md` còn vài tên cũ (xem cuối file) — khi lệch, **file này đúng**.

---

## 0. Bức tranh — cái gì chạy ở đâu

| Thành phần                                        | Chạy ở                       | Loại                                                              | Vì sao                                                                                                                                 |
| ------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `hub-api` + `hub-worker` (`hub-all`)              | **Render**                   | **MỘT** Web Service (Docker), free — 2 tiến trình Node trong 1 container (ADR-129) | hub-api: webhook `/hooks/*`, API `/v1/p/*`, console, Socket.IO · hub-worker: normalize, giao webhook, outbox relay, cleanup. Free tier **không có** Background Worker → phương án (B), xem §0.1 |
| `shop` (backend)                                  | **Render**                   | Web Service (Docker), free                                        | Shop là **server Node chạy liên tục** (tự đăng ký endpoint với hub, nhận push đã ký) — **không** chạy được kiểu serverless trên Vercel |
| `web` = console **+ giao diện Shop** (storefront) | **Vercel**                   | Next.js                                                           | "Frontend gồm cả shop": trang cửa hàng nằm trong `apps/web`, gọi sang backend shop trên Render                                         |
| PostgreSQL                                        | **Neon**                     | ✅ **đã xong** (14 migration, RLS, role `hub_app` + `shop_user`)  |                                                                                                                                        |
| Redis                                             | **Upstash**                  | rediss://                                                         |                                                                                                                                        |
| RabbitMQ                                          | **CloudAMQP** (Little Lemur) | amqps:// — region **Tokyo** (AWS ap-northeast-1)                 | Little Lemur free không có Singapore → Admin chọn Tokyo (ADR-129)                                                                      |

**Region Singapore** cho Render, Neon, Upstash (ap-southeast-1). **Ngoại lệ: CloudAMQP ở Tokyo (AWS ap-northeast-1)** — gói free Little Lemur không có Singapore; mỗi lượt gọi broker thêm ~70 ms ở bản deployed. Chấp nhận được vì p95 chỉ đo ở LOCAL (ADR-019), deployed chỉ để chứng minh chạy thật (ADR-129).

### 0.1. ✅ Đã chốt: hub-worker chạy CHUNG container với hub-api — phương án (B), 0 đồng (ADR-129)

- **(B) đang dùng:** service `hub-api` trên Render chạy `docker-entrypoint.sh hub-all` → supervisor `docker/hub-all.js` sinh **hai tiến trình Node** (hub-api + hub-worker), mỗi tiến trình một kết nối RabbitMQ + một pool DB riêng. BB-4 (hai tiến trình) vẫn giữ; local vẫn chạy hai service tách rời. Một tiến trình chết → supervisor dừng nốt → Render khởi động lại cả container.
- (A) Background Worker Starter (~7 USD/tháng) — không dùng. Nếu sau này đổi sang (A): Docker Command của `hub-api` về `docker-entrypoint.sh hub-api`, thêm Background Worker `docker-entrypoint.sh hub-worker` (DEPLOYMENT §3.2).
- **Giờ instance free:** Render cho 750 giờ/tháng. `hub-api` (hub-all) luôn thức nhờ UptimeRobot ≈ 730 giờ; `shop` free **để ngủ** khi không dùng (đừng ping shop liên tục).

---

## 1. Chuẩn bị (≈ 15 phút)

### 1.1. Upstash Redis

1. https://console.upstash.com → **Create Database** → Name `webhook-hub` → Type **Regional** → Region **ap-southeast-1 (Singapore)** → **Create**.
2. Tab **Details** → mục **Connect** → chọn **ioredis / Node** → copy chuỗi `rediss://default:...@...upstash.io:6379`.
3. Dán vào `KEYS-CAN-LAY.md`, mục mới cuối file:
   ```env
   DEPLOY_REDIS_URL=
   ```

### 1.2. CloudAMQP RabbitMQ

1. https://customer.cloudamqp.com → **Create New Instance** → Name `webhook-hub` → Plan **Little Lemur (Free)** → Region **AWS ap-northeast-1 (Tokyo)** — gói free không có Singapore; Tokyo thêm ~70 ms/lượt broker ở deployed, chấp nhận vì p95 chỉ đo ở local (ADR-019, ADR-129) → **Create**.
2. Bấm vào instance → copy **AMQP URL** (dạng `amqps://user:pass@xxx.rmq.cloudamqp.com/user`).
   ```env
   DEPLOY_RABBITMQ_URL=
   ```
3. Đặt policy giới hạn DLQ (một lần). Coordinator chạy giúp được khi có URL (lệnh ở `docs/DEPLOYMENT.md` §6.1).

### 1.3. Báo coordinator sinh `.env.deploy.local`

Khi có 2 dòng trên, nhắn: **"sinh env deploy"**. Coordinator sẽ:

- sinh `MASTER_KEY`, `JWT_SECRET`, `CSRF_SECRET`, `SOCKET_TICKET_SECRET`, `OAUTH_COOKIE_SECRET`, `WEB_PROXY_SECRET`, `HUB_SIGNING_SECRET` (`whsec_…`), `METRICS_TOKEN`, `INTERNAL_TOKEN`, `SEED_SHOP_API_KEY` (`hk_live_…`);
- gom chuỗi Neon/Upstash/CloudAMQP, mã băm operator, key Gmail/Google/PayOS/SePay/GitHub vào `.env.deploy.local`, **chia sẵn 4 khối**: `[hub-api]`, `[hub-worker]`, `[shop]`, `[web]`.

> ⚠️ **`MASTER_KEY` không bao giờ được đổi sau khi seed** — nó mã hoá secret của source/đích trong DB. Đổi = hub không giải mã được nữa.

---

## 2. Render — tài khoản + nối GitHub (5 phút)

1. https://dashboard.render.com → đăng nhập bằng GitHub.
2. Lần đầu tạo service, Render hỏi quyền repo → chọn **Only select repositories** → `haidepzai269/webhook-hub`.
3. Nhánh deploy: **`master`**.

---

## 3. Render — `hub-api` (Web Service)

1. **New → Web Service** → chọn repo `webhook-hub`.
2. Điền:

| Ô                            | Giá trị                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| Name                         | `hub-api` (URL sẽ là `https://hub-api-xxxx.onrender.com` — ghi lại) |
| Region                       | **Singapore**                                                       |
| Branch                       | `master`                                                            |
| Runtime / Language           | **Docker**                                                          |
| Root Directory               | (để trống — gốc repo; Dockerfile ở gốc và build cần cả `libs/`)     |
| Docker Build Context Directory | `.` (mặc định)                                                    |
| Dockerfile Path              | `./Dockerfile`                                                      |
| Docker Command               | `docker-entrypoint.sh hub-all` (hub-api + hub-worker, ADR-129)      |
| Instance Type                | **Free**                                                            |
| Health Check Path (Advanced) | `/health`                                                           |
| Auto-Deploy                  | Yes                                                                 |

3. **Environment** → **Add from .env** → dán **khối `[hub-api]` RỒI khối `[hub-worker]`** trong `.env.deploy.local` (hợp của hai khối — trùng tên thì giữ giá trị của `[hub-api]`; `DIRECT_URL` phải là **owner** vì container này chạy migrate, worker vẫn dùng `DATABASE_URL` = hub_app). Thêm `WORKER_METRICS_PORT=0`. Supervisor tự đặt `connection_limit` = 5 cho mỗi tiến trình (ghi đè `connection_limit=1` trong chuỗi; đổi bằng `HUB_ALL_API_DB_CONNECTIONS` / `HUB_ALL_WORKER_DB_CONNECTIONS`). Khối `[hub-api]` gồm:
   `NODE_ENV=production` · `TRUST_PROXY=1` · `DATABASE_URL` (`hub_app`, pooler, có `&pgbouncer=true&connection_limit=1`) · `DIRECT_URL` (owner) · `REDIS_URL` · `RABBITMQ_URL` · `MASTER_KEY` · `HUB_SIGNING_SECRET` · `JWT_SECRET` · `CSRF_SECRET` · `SOCKET_TICKET_SECRET` · `OAUTH_COOKIE_SECRET` · `WEB_PROXY_SECRET` · `WEB_PUBLIC_URL` · `CORS_ORIGINS` · `OPERATOR_EMAIL` · `OPERATOR_PASSWORD_HASH` · `MAIL_DRIVER=gmail` · `MAIL_FROM` · `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` · `GOOGLE_OAUTH_CLIENT_ID/SECRET` · `GITHUB_OAUTH_CLIENT_ID/SECRET` · `METRICS_TOKEN` · `INTERNAL_TOKEN` · `SHUTDOWN_TIMEOUT_MS=25000` · `INGEST_RATE_LIMIT_PER_MIN=100` · `PAYOS_CLIENT_ID` · `PAYOS_API_KEY` · `PAYOS_CHECKSUM_KEY` · `SEPAY_API_KEY` · `GITHUB_WEBHOOK_SECRET`.

   **KHÔNG đặt:** `PORT` (Render tự cấp) · `HUB_APP_DB_PASSWORD` · `RUN_SEED` · `GOOGLE_OAUTH_FAKE_BASE_URL` · `GITHUB_OAUTH_BASE_URL` · `MOCK_BASE_URL` · mọi biến `DEMO_…` · mọi biến `NEXT_PUBLIC_…`.

   `WEB_PUBLIC_URL` / `CORS_ORIGINS` chưa có URL Vercel thì tạm để `https://placeholder.vercel.app` — bước 6 sửa lại.

   **Khi deploy lại / Render dừng container (D-2, ADR-129):** chỉ **worker** drain (xử lý xong message đang chạy, tối đa 22 s); **hub-api thoát ngay** khi nhận SIGTERM (chưa có shutdown hook). Request webhook đang dở bị cắt TRƯỚC khi trả 2xx → provider tự gửi lại; chống trùng (BB-2) và "không ACK trước COMMIT" (BB-3) bảo đảm không mất, không đôi sự kiện.
4. **Create Web Service**. Build lần đầu **5–10 phút** (image build cả monorepo). Nếu build lỗi ở `next build` do tải Google Fonts → bấm **Manual Deploy → Clear build cache & deploy** lần nữa (lỗi mạng đã gặp ở local, không phải code).

**✅ Kiểm:**

- Log có `Applying database migrations` → `No pending migrations` (Neon đã migrate) → `[hub-all] Starting hub-api + hub-worker` → dòng JSON `"proc":"api"` có `Nest application successfully started` và `"proc":"worker"` kết nối RabbitMQ / outbox relay.
- Trên CloudAMQP → **RabbitMQ Manager → Queues** thấy 9 queue `q.*`; **Connections** có **2** kết nối (api + worker).
- Mở `https://hub-api-xxxx.onrender.com/health` → 200.
- Log **không** có `role đặc quyền` / `privileged` (nếu có = `DATABASE_URL` đang là owner → sửa sang `hub_app`).

---

## 4. ~~Render — `hub-worker`~~ — BỎ (worker chạy trong `hub-api`, ADR-129)

Không tạo Background Worker. Worker đã chạy trong container `hub-api` (bước 3, `docker-entrypoint.sh hub-all`).
Kiểm ở bước 3: log có cả `"proc":"api"` lẫn `"proc":"worker"`; CloudAMQP có 2 connection; không có `permission denied`.

---

## 5. Vercel — `web` (console + giao diện Shop)

1. https://vercel.com → đăng nhập GitHub → **Add New → Project** → Import `webhook-hub`.
2. Điền:

| Ô                                    | Giá trị                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| Project Name                         | vd `webhook-hub` → URL `https://webhook-hub.vercel.app` (ghi lại) |
| Framework Preset                     | **Next.js**                                                       |
| Root Directory                       | `apps/web` (bấm Edit) — **BẮT BUỘC** (ngược với Render, nơi để trống) |
| Build / Output                       | để mặc định                                                       |
| Node.js Version (Settings → General) | **22.x**                                                          |

> ⚠️ **Root Directory khác Render:** Vercel PHẢI là `apps/web` (Next.js nằm ở đó); Render (§3, §8) để TRỐNG vì Dockerfile ở gốc repo và build cần cả `libs/`.

3. **Environment Variables** — dán **khối `[web]`**, làm HAI đợt:

   **Đợt 1 — lần deploy đầu** (chưa có URL Render): chỉ biến đã biết.

| Biến               | Giá trị           | Ghi chú                                         |
| ------------------ | ----------------- | ----------------------------------------------- |
| `WEB_PROXY_SECRET` | giống hệt hub-api | runtime (đọc lúc chạy), không phải `NEXT_PUBLIC_` |

   **Đợt 2 — sau khi `hub-api` (§3) và `shop` (§8) đã có URL:** thêm ba biến URL rồi **Deployments → Redeploy**. Ba biến này được
   **nhúng lúc BUILD** (`NEXT_PUBLIC_*` vào bundle trình duyệt; `HUB_API_INTERNAL_URL` vào `rewrites`) — đổi giá trị mà không Redeploy thì không có tác dụng.

| Biến                       | Giá trị                             | Ghi chú                                       |
| -------------------------- | ----------------------------------- | --------------------------------------------- |
| `HUB_API_INTERNAL_URL`     | `https://hub-api-xxxx.onrender.com` | Đích proxy `/api/*`, `/auth/*` — **đọc lúc BUILD** |
| `NEXT_PUBLIC_HUB_API_URL`  | `https://hub-api-xxxx.onrender.com` | Socket.IO + URL `/hooks` hiển thị — BUILD      |
| `NEXT_PUBLIC_SHOP_API_URL` | `https://shop-xxxx.onrender.com`    | Storefront gọi backend shop — BUILD           |

**KHÔNG đặt** `NEXT_PUBLIC_DEMO_SIMULATE`, `NEXT_PUBLIC_DEMO_SEPAY_APIKEY` (chỉ local, ADR-027).

4. **Deploy**.
   Nếu build báo `Cannot find module` / không thấy `@hub/flow` → Settings → **Build & Development** → Install Command: `cd ../.. && npm ci` → Redeploy. (Web import `libs/common` ở ngoài `apps/web`; mục _Include files outside the Root Directory_ phải đang **bật** — mặc định bật.)

**✅ Kiểm:** mở `https://webhook-hub.vercel.app/login` thấy trang đăng nhập có nút GitHub + Google.

---

## 6. Nối URL hai chiều

1. Render → `hub-api` → Environment: đặt `WEB_PUBLIC_URL` = `https://webhook-hub.vercel.app` (không `/` cuối), `CORS_ORIGINS` = cùng giá trị → **Save, rebuild & deploy**.
2. **GitHub OAuth App bản deploy** (KEYS mục A3): Homepage `https://webhook-hub.vercel.app`, callback `https://webhook-hub.vercel.app/auth/github/callback` → điền `DEPLOY_GITHUB_OAUTH_CLIENT_ID/SECRET` → coordinator cập nhật khối `[hub-api]` → dán lại 2 biến `GITHUB_OAUTH_*` trên Render (khác giá trị local!).
3. **Google client đăng nhập** (`webhook-hub-login`) → **Authorized redirect URIs** thêm `https://webhook-hub.vercel.app/auth/google/callback` → Save. (Client gửi mail **không** đổi gì.)

---

## 7. Seed dữ liệu lên Neon (coordinator giao agent làm)

Nhắn: **"seed neon"**. Agent chạy seed từ máy local với khối `[hub-api]` (+ `SEED_SHOP_API_KEY`, `HUB_PUBLIC_URL=https://hub-api-xxxx.onrender.com`, `SHOP_WEBHOOK_URL=https://shop-xxxx.onrender.com/hub-webhook`, `SEED_DEMO_PROJECTS=false`, `SEED_TELEGRAM_ACTIVE=false`). Seed tạo:

- tài khoản **operator** (email Gmail của bạn + mã băm đã có);
- project `default` với source `src_payos_main`, `src_sepay_main`, `src_github_main` (secret mã hoá bằng `MASTER_KEY` deploy);
- API key `shop` (đúng giá trị `SEED_SHOP_API_KEY`).

> Seed chạy **sau** khi `MASTER_KEY` đã đặt trên Render và **cùng giá trị** — sai là source không giải mã được.

**✅ Kiểm:** đăng nhập `https://webhook-hub.vercel.app/login` bằng **email + mật khẩu operator** (không dùng nút Google/GitHub — operator bị chặn đăng nhập OAuth, đúng thiết kế) → thấy project `default` với 3 source.

---

## 8. Render — `shop` (Web Service)

1. **New → Web Service** → repo `webhook-hub` → Name `shop` · Region **Singapore** · Branch `master` · Runtime **Docker** · Docker Command `docker-entrypoint.sh shop` · Instance **Free** · Health Check Path `/products` (Shop không có route `/health`).

| Ô                              | Giá trị                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| Root Directory                 | (để trống — gốc repo; Dockerfile ở gốc và build cần cả `libs/`) |
| Docker Build Context Directory | `.` (mặc định)                                                  |
| Dockerfile Path                | `./Dockerfile`                                                  |

2. Environment — khối `[shop]`:

| Biến                                   | Giá trị                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `NODE_ENV`                             | `production`                                                              |
| `SHOP_PORT`                            | `10000` (Shop đọc `SHOP_PORT`, không đọc `PORT`)                          |
| `PORT`                                 | `10000` (để Render biết cổng)                                             |
| `DATABASE_URL`, `DIRECT_URL`           | cùng chuỗi `shop_user` (`DEPLOY_SHOP_DATABASE_URL`, đã có `&schema=shop`) |
| `HUB_URL`                              | `hubs://<SEED_SHOP_API_KEY>@hub-api-xxxx.onrender.com/default`            |
| `HUB_SIGNING_SECRET`                   | giống hub-api                                                             |
| `SHOP_PUBLIC_URL`                      | `https://shop-xxxx.onrender.com`                                          |
| `INTERNAL_TOKEN`                       | giống hub-api                                                             |
| `PAYOS_CLIENT_ID/API_KEY/CHECKSUM_KEY` | key PayOS (tạo link thanh toán)                                           |

3. Create → sau khi lên, quay lại **Vercel** điền `NEXT_PUBLIC_SHOP_API_URL=https://shop-xxxx.onrender.com` → **Redeploy** (biến `NEXT_PUBLIC_` nhúng lúc build).

**✅ Kiểm:** log shop có `[Shop] endpoint VERIFIED (https://shop-xxxx.onrender.com/hub-webhook)`. Nếu log báo đang thử lại đăng ký → hub-api đang ngủ/khởi động, chờ 1–2 phút (Shop tự thử lại mãi, R2-1).

---

## 9. Provider gọi vào hub

URL webhook: `https://hub-api-xxxx.onrender.com/hooks/<provider>/<sourceKey>`

| Provider | Đặt ở                                                                                                                            | URL                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| SePay    | my.sepay.vn → WebHooks → thêm, kiểu xác thực **API Key** = `SEPAY_API_KEY`                                                       | `.../hooks/sepay/src_sepay_main`   |
| PayOS    | my.payos.vn → Kênh thanh toán → Webhook URL. **Đặt SAU khi hub-api đã chạy** — PayOS bắn request kiểm tra đòi 200 (cạm bẫy 4)    | `.../hooks/payos/src_payos_main`   |
| GitHub   | repo → Settings → Webhooks → Add: Content type `application/json`, Secret = `GITHUB_WEBHOOK_SECRET`, events Push + Pull requests | `.../hooks/github/src_github_main` |

---

## 10. Giữ hub-api không ngủ — UptimeRobot

Render free ngủ sau ~15 phút → webhook đầu tiên timeout (GitHub chỉ chờ ~10 s).

1. https://uptimerobot.com → **Add New Monitor** → HTTP(s) → URL `https://hub-api-xxxx.onrender.com/health` → Interval **5 minutes** → Create.
2. **Không** ping `shop` (để shop được ngủ, tiết kiệm giờ free; hub tự giao lại khi shop thức).

---

## 11. Kiểm thu cuối (cùng coordinator)

- [ ] Đăng nhập operator (email + mật khẩu) → thấy `default`.
- [ ] Đăng xuất → **Đăng nhập bằng Google** bằng tài khoản Google khác → vào được, có project riêng (TA11-Google).
- [ ] **Đăng nhập GitHub** (TA11).
- [ ] `/register` bằng email của bạn → nhận mail xác minh từ Gmail → bấm link đặt mật khẩu → vào được.
- [ ] Storefront trên Vercel → tạo đơn → thanh toán SePay/PayOS thật số tiền nhỏ → đơn **PAID**, console thấy event `payment.received` và delivery tới `shop` SUCCEEDED.
- [ ] GitHub push vào repo → event `repo.push` hiện trên console.
- [ ] Header IP giả trên Vercel (DEPLOYMENT §9, mục `WEB_PROXY_SECRET`) — coordinator làm cùng.
- [ ] TA14: Chrome + Firefox, F5 giữ đăng nhập, `document.cookie` không thấy cookie `__Host-hub_*`.
- [ ] Sau khi xong: **đổi mật khẩu operator** sang mật khẩu có cả chữ (đang toàn số).

---

## 12. Lỗi hay gặp

| Triệu chứng                                            | Nguyên nhân                                                                              | Sửa                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| hub-api thoát ngay, log nhắc role đặc quyền            | `DATABASE_URL` là `neondb_owner`                                                         | Dùng chuỗi `hub_app`                                               |
| hub-api thoát, log `WEB_PUBLIC_URL`                    | Production bắt buộc biến này                                                             | Đặt URL Vercel                                                     |
| hub-api thoát, log nêu tên biến `GOOGLE_*`/`MAIL_FROM` | `MAIL_DRIVER=gmail` thiếu biến                                                           | Dán đủ 4 biến                                                      |
| Đăng nhập trên Vercel báo lỗi CSRF/401 liên tục        | `WEB_PROXY_SECRET` lệch giữa Render và Vercel, hoặc `HUB_API_INTERNAL_URL` sai lúc build | Sửa → Redeploy Vercel                                              |
| Console không realtime                                 | `NEXT_PUBLIC_HUB_API_URL` sai                                                            | Sửa → Redeploy                                                     |
| Delivery tới shop RETRYING 503                         | Shop chưa đăng ký xong / đang ngủ                                                        | Chờ — tự lành                                                      |
| `PRECONDITION_FAILED` RabbitMQ                         | Queue cũ khác arguments                                                                  | Xoá queue trên CloudAMQP rồi restart worker (cạm bẫy 3)            |
| Mail không tới                                         | Refresh token Gmail chết (app còn Testing)                                               | Google Auth Platform → Audience → **In production**, lấy token mới |

---

## Phụ lục — chỗ `docs/DEPLOYMENT.md` đang ghi cũ (sẽ giao agent sửa)

| DEPLOYMENT.md ghi                 | Code thật dùng                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY`           | **`MASTER_KEY`**                                                                      |
| `AMQP_URL`                        | **`RABBITMQ_URL`**                                                                    |
| Shop = route handlers trên Vercel | Shop = **server Node trên Render** (đăng ký endpoint, nhận push ký Standard Webhooks) |
| Auto-deploy nhánh `main`          | Repo dùng **`master`**                                                                |
