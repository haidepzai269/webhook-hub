# Webhook Hub — đọc file này trước khi làm bất cứ việc gì

Đồ án tốt nghiệp. **Ứng dụng Webhook kết nối dữ liệu giữa các nền tảng.**
Chấm nặng: **logic core · kiến trúc · hiểu bản chất webhook · backend**. Không chấm giao diện đẹp.

## Tài liệu (thứ tự đọc)

| File | Nội dung |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **Nguồn sự thật về kiến trúc.** Mọi thứ khác phải khớp với file này. |
| [`docs/ROADMAP-14D.md`](docs/ROADMAP-14D.md) | Lộ trình 14 ngày + Definition of Done từng ngày |
| [`docs/EVENT-CATALOG.md`](docs/EVENT-CATALOG.md) | **Catalog kiểu chuẩn** (`payment.*`, `repo.*`) — hợp đồng đầu ra của hub. Thêm/đổi trường = sửa catalog + test U50 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Hai môi trường · Render/Vercel/Neon/Upstash/CloudAMQP · ràng buộc free tier · env vars |
| [`docs/MONITORING.md`](docs/MONITORING.md) | Theo dõi sức khỏe 6 tầng (LOCAL: Prometheus + exporter + Alertmanager + dashboard "Hạ tầng") · giới hạn Windows/WSL2 · ADR-249 |
| [`docs/LOGGING.md`](docs/LOGGING.md) | Log tự nói nguyên nhân sơ bộ: taxonomy `cause` (chậm/sai/tăng nhanh), canonical log line, `stage_ms`, `traceparent` W3C + Sentry/RUM — THIẾT KẾ (ADR-250..252), chưa code |
| [`docs/adr/README.md`](docs/adr/README.md) | Nhật ký quyết định — **append-only, ghi ngay khi quyết định**. README đóng băng ở ADR-266; từ ADR-267 **mỗi ADR một file** `docs/adr/NNNN-<slug>.md` (`npm run adr:new -- "<tiêu đề>"`), bổ sung ADR cũ ở `docs/adr/bo-sung/NNNN-YYYY-MM-DD-<slug>.md` (ADR-267) |
| `webhook-hub-y-tuong.md` | Ý tưởng gốc. **Chỉ tham khảo.** Mâu thuẫn với ARCHITECTURE.md → ARCHITECTURE.md thắng. |

## Năm bất biến — phá một cái là bug kiến trúc, không phải đánh đổi

1. **BB-1 — Hub không biết "đơn hàng" là gì.** Không có `orderCode`, regex `DH\d+`, hay bảng `orders` trong `apps/hub-*`. Nghiệp vụ thuộc `apps/shop`.
2. **BB-2 — PostgreSQL là trọng tài duy nhất của idempotency.** Redis chỉ là đường tắt và *được phép sai*. Redis mất dữ liệu → hệ thống chậm đi, **không sai**.
3. **BB-3 — Không bao giờ trả 2xx cho provider trước khi `COMMIT` thành công.** ACK sớm = mất sự kiện vĩnh viễn.
4. **BB-4 — `hub-api` và `hub-worker` là hai tiến trình tách rời từ Ngày 1.** Khả năng mở rộng là *hình dạng* hệ thống, không phải tính năng cắm thêm sau.
5. **BB-5 — Mọi bảng nghiệp vụ mang `tenant_id`; mọi truy vấn đi qua `TenantScopedRepository`.** Không query trực tiếp không scope, kể cả khi hiện chỉ có 1 tenant.

## Quy tắc khi code

- **Thứ tự ingest là cố định** — xem `docs/ARCHITECTURE.md` §3.1. Redis `SET NX` phải nằm **SAU `COMMIT`**. Đừng "tối ưu" lại.
- **Topology RabbitMQ khai báo ở MỘT chỗ duy nhất:** `libs/messaging/topology.ts`. Rải rác → `PRECONDITION_FAILED`, app không lên.
- **`apps/shop/src` trần cứng ~600 dòng** (ADR-141 link PayOS thật; ADR-156 trang Cài đặt kết nối — cách B). Vượt = đang lạc đề, dừng lại. Giỏ hàng chỉ ở client, server tự tính tổng (ADR-024). Không đăng nhập, không kho.
- **Thêm provider = viết một class `ProviderAdapter` + đăng ký registry.** Không sửa ingest/worker/DB. Đây là luận điểm chính của đề tài — đừng phá nó bằng một cái `if (provider === 'x')` trong lõi.
- **So chữ ký/khoá chỉ bằng `crypto.timingSafeEqual`** — không bao giờ `!==`/`===`/`Buffer.equals`. SDK provider có hàm verify riêng mà so không constant-time thì tự so (PayOS so bằng `!==`, ADR-058). Chỉ được giao cho SDK **đã đọc mã nguồn, xác nhận gọi `timingSafeEqual`, và ghi ADR kèm version**: hiện chỉ có GitHub (`@octokit/webhooks-methods` `verifyWithFallback`) và Stripe (`constructEvent`), ADR-174.
- **Khoá chống trùng không bao giờ ngẫu nhiên** — thiếu id của provider thì `bodyHashKey(rawBody)`.
- **Adapter ra kiểu chuẩn** theo `docs/EVENT-CATALOG.md`; `payment.*`/`repo.*` sai khuôn là lỗi normalize vĩnh viễn, không hạ cấp âm thầm.
- **HMAC tính trên `body_raw` (bytes), không phải trên JSON đã parse.**
- **Không query DB trực tiếp.** Đi qua `TenantScopedRepository` — kể cả query "chỉ để debug". Một chỗ lọt là BB-5 chết.
- **Ghi ADR 3 dòng mỗi khi quyết định gì đó** (vấn đề / chọn / đánh đổi) — vào FILE RIÊNG `docs/adr/NNNN-<slug>.md`, KHÔNG thêm vào `docs/adr/README.md` (đã đóng băng, ADR-267; `npm run adr:new`). Lúc làm tốn 2 phút; ghi lại sau thì mất hai ngày và sẽ bịa sai.

## Cạm bẫy đã biết (đừng mắc lại)

1. `NestFactory.create(AppModule, { rawBody: true })` — thiếu là chữ ký sai 100% mà log không nói gì.
2. cloudflared phải là **named tunnel** — URL đổi mỗi lần restart thì provider trỏ vào hư không.
3. Đổi `x-message-ttl` của queue đã tồn tại → `PRECONDITION_FAILED`. Xoá queue trước.
4. Đăng ký webhook PayOS **sau** khi adapter chạy — PayOS bắn request kiểm tra đòi 200. Nút **"Kết nối PayOS"** ở console đã lo thứ tự (source + secret COMMIT rồi mới gọi PayOS, ADR-146); dán URL tay thì vẫn phải đúng thứ tự.
5. k6 bắn vào **localhost**, không qua tunnel — không thì đo ra độ trễ của Cloudflare.

## Ngăn xếp

NestJS monorepo (`apps/hub-api` · `apps/hub-worker` · `apps/shop` · `apps/web`) · PostgreSQL 16 (schema `hub` + `shop`) · Redis 7 · RabbitMQ 3 · Socket.IO · Next.js · Prisma · Docker Compose · Prometheus + Grafana · k6.

> **Không có `apps/hub-scheduler`** — outbox relay (`SKIP LOCKED`, an toàn nhiều instance) và cleanup (Redis lock) nằm trong `hub-worker`. ADR-020.

## Hai môi trường — đừng lẫn (ADR-019)

| | Dùng để | |
|---|---|---|
| **LOCAL** `docker-compose` | **Đo đạc & chaos** — k6, scale worker, kill container, tắt Redis | **Mọi số liệu báo cáo lấy ở đây** |
| **DEPLOYED** Render + Vercel + Neon + Upstash + CloudAMQP | Chứng minh online thật, provider thật gọi vào | **Không đo p95 ở đây** (autosuspend + quota) |

Ràng buộc deployed phải nhớ khi code:
- `SHUTDOWN_TIMEOUT_MS=25000` — **25s, không phải 30s** (Render SIGKILL sau ~30s)
- `metrics.tick` **5s**, đếm trong bộ nhớ, **không** chạm Redis mỗi tick (quota Upstash)
- Ngân sách Redis **≤ 4 lệnh cố định / sự kiện (ingest + normalize) + ≤ 2 lệnh / delivery** (R1, ADR-062); đường hoãn/throttle/ramp **≤ 1 lệnh, 0 truy vấn đọc** (gate trước khi nạp; hoãn vẫn ghi `next_attempt_at` thưa ≤ 1 lần/2 phút — ADR-196/198) — đếm bằng `apps/hub-api/test/redis-budget.spec.ts`; thêm lệnh vào đường nóng là test đỏ
- Prisma cần **hai** connection string: `DATABASE_URL` (pooled) + `DIRECT_URL` (migrate)
- Nghe biến `PORT` của Render, không hardcode
- **Một AMQP connection / tiến trình, nhiều channel** (giới hạn connection CloudAMQP)
- Tất cả region **Singapore** — lệch region là p95 chết

## Trạng thái

- **2026-09-17** — chốt kiến trúc + triển khai, viết `docs/`. Chưa có code.
- **2026-09-18** — Ngày 1.
- **2026-10-11** — Đa service (S1–S12, ADR-071..082): Project + API key + connection string, `/v1/p/:project/*` (publish, polling A theo `events.poll_seq` (thứ tự COMMIT, trả `cursor` dạng chuỗi — không phải `events.seq`, ADR-095/099), endpoint có challenge, subscription `sourceIds`, source GenericAdapter + chế độ lắng nghe), push ký Standard Webhooks (bỏ `X-Hub-*`), `@hub/sdk`, Shop tự đăng ký endpoint, demo `cafe`/`bookstore` (`docs/DEMO-MULTI-PROJECT.md`).
- **2026-10-11** — Kết nối hai đầu (SPEC-ket-noi KN1–KN3, ADR-138/142/146): console tạo endpoint (hub sinh `whsec_` + challenge + subscription cùng tx); "Kết nối PayOS" — hub tự `confirm-webhook` sau khi source COMMIT; credentials provider lưu mã hoá theo project (`source_connections`, RLS).
- **2026-10-11** — Trải nghiệm dev phương án A (ADR-133/134/136): `hub listen`/`hub trigger` (polling A + ký phía client, `toWebhookBody` dùng chung với WebhookSender, `after=latest`), khuôn lỗi `{error, message, fix, docsUrl, requestId}` + `x-request-id` (`docs/ERRORS.md`), `docs/QUICKSTART.md` + `examples/quickstart-node`.
