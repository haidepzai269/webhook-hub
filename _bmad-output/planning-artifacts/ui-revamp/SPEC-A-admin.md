# SPEC-A: Dashboard Webhook Hub theo Studio Admin

> Nhóm A. Đọc `README.md` cùng thư mục trước (quyết định D1–D5, Phase 0, quyền sở hữu file).
> Template: https://studio-admin.arhamkhnz.com/ · repo `arhamkhnz/next-shadcn-admin-dashboard` (MIT, nhánh `main`: Next 16, Tailwind v4, shadcn/ui, Zustand, TanStack Table, RHF + Zod).

## Mục tiêu
Thay `apps/web/app/page.tsx` (924 dòng, một component, style inline, 4 tab) bằng một dashboard có **khung của Studio Admin**: sidebar thu gọn được, header, theme preset, light/dark, data-table, chart. Lấy **khung**, không lấy **nội dung mẫu**.

Tiêu chí: người xem demo đọc được trạng thái hệ thống trong 5 giây (Sally). Giao diện không được chấm điểm, nhưng được *xem*.

## Lấy gì / bỏ gì từ template
| Lấy | Bỏ |
|---|---|
| Layout sidebar + header, nút thu gọn, chỉnh độ rộng nội dung | 9 dashboard mẫu (CRM, Finance, Academy…) và 4 dashboard legacy |
| `components/ui/*` (shadcn), theme presets, light/dark | Kanban, Chat, Email, Calendar, File Manager, Invoice, Patient… |
| Data-table (TanStack) có phân trang/lọc/ẩn cột | Users/Roles management (RBAC đang "planned" ở template) |
| Một màn auth (login v1) | 3 màn auth còn lại, register, forgot password |
| Chart (shadcn chart / recharts), KPI card của dashboard Default | Dữ liệu giả (`data.json`, faker) |
| Biome config **chỉ trong `apps/web`** (không áp lên cả monorepo) | Husky hooks |

Thương hiệu: tên "Webhook Hub", ngôn ngữ giao diện **tiếng Việt**.

## Bản đồ màn hình ↔ API (API có sẵn, base `NEXT_PUBLIC_HUB_API_URL`)

| Route | Nội dung | API |
|---|---|---|
| `/auth/login` | Form login (RHF + Zod). JWT lưu `localStorage` key `hub_jwt_token` (giữ như cũ) | `POST /auth/login` |
| `/dashboard` | 6 KPI card (sources, destinations, events, deliveries, dead, success rate) · chart sự kiện/delivery theo thời gian · sparkline realtime · 10 sự kiện gần nhất · badge Health + Socket | `GET /api/v1/overview` · **`GET /api/v1/stats/timeseries` (mới)** · socket `metrics.tick` · `GET /health` |
| `/dashboard/events` | Data-table phân trang bằng cursor (`after`, `limit≤100`). Click dòng mở **Sheet** chi tiết: header, payload JSON, danh sách delivery | `GET /api/v1/events` · `GET /api/v1/events/:id` |
| `/dashboard/deliveries` | Data-table, lọc theo status `PENDING/DELIVERING/RETRYING/SUCCEEDED/DEAD` | `GET /api/v1/deliveries?status=` |
| `/dashboard/dlq` | Bảng delivery DEAD + nút **Replay** (AlertDialog xác nhận + toast, **không dùng `window.alert`**). Ghi rõ "attempt_generation + 1" | `GET /api/v1/dlq` · `POST /api/v1/deliveries/:id/replay` |
| `/dashboard/sources` | Bảng + Dialog tạo (provider, name, secret). Hiện `webhookUrl` có nút copy | `GET/POST /api/v1/sources` |
| `/dashboard/destinations` | Bảng + Dialog tạo (name, type, config JSON, signingSecret, rateLimitRps) | `GET/POST /api/v1/destinations` |
| `/dashboard/subscriptions` | Bảng + Dialog tạo (destination, eventTypes, template) | `GET/POST /api/v1/subscriptions` |
| `/dashboard/playground` | Bắn webhook thử (port logic `sendTestWebhook` cũ: github/sepay/…) + hiện response | `POST /hooks/:provider/:sourceKey` |

Nhóm sidebar: **Tổng quan** (Dashboard) · **Luồng dữ liệu** (Events, Deliveries, DLQ) · **Cấu hình** (Sources, Destinations, Subscriptions) · **Công cụ** (Playground). Nút "Mở Shop" mở `/shop` ở tab mới.

## Stories

**A-0: Phase 0** (xem README §3). Làm xong và merge trước khi Nhóm B làm UI.

**A-1: Khung admin.** Copy shell + `components/ui` + theme từ template vào `src/app/(admin)`. Sidebar theo bản đồ ở trên. Auth guard phía client (không có JWT → `/auth/login`; API trả 401 → xoá token, quay về login). `/` redirect sang `/dashboard`.
*DoD:* build xanh; chuyển light/dark và theme preset được; sidebar thu gọn được; mobile 375px không bị cuộn ngang.

**A-2: Lớp dữ liệu.** `src/lib/hub/client.ts`: `hubFetch` gắn Bearer token và xử lý 401. Dùng TanStack Query (thêm dependency) để cache. `src/lib/hub/socket.ts`: một kết nối Socket.IO dùng chung. Khi nhận `event.received` hoặc `delivery.updated` thì **invalidate query** tương ứng, không tự vá state bằng tay. `metrics.tick` (mỗi 5s) đổ vào sparkline.
*DoD:* bắn webhook ở Playground thì `/dashboard` và `/dashboard/events` tự cập nhật, không phải F5.

**A-3: Endpoint `GET /api/v1/stats/timeseries?range=24h|7d`** (backend, `apps/hub-api`).
- Trả `[{ bucket: ISO, events, succeeded, retrying, dead }]`, bucket theo giờ (24h) hoặc ngày (7d).
- Thêm method vào **`TenantScopedRepository`** (`date_trunc` + `GROUP BY`, `tenant_id` lấy từ repo). **Không query thẳng, không đụng Redis** (BB-5, ngân sách Upstash).
- Có `JwtAuthGuard` như các route `api/v1` khác.
*DoD:* có unit test cho repo method (scope tenant: tenant B không thấy dữ liệu của tenant A); response < 200ms với 10k event ở local.

**A-4: Dashboard `/dashboard`.** KPI card, area chart lấy từ A-3 (chuyển 24h/7d), sparkline realtime, bảng sự kiện gần nhất, card Health (`/health`: trạng thái db/redis/rabbit nếu có), badge Socket.
*DoD:* tắt Redis ở local thì card Health báo lỗi, các phần còn lại vẫn hiển thị (BB-2: chậm đi, không sai).

**A-5: Events + Sheet chi tiết.** Data-table với cursor pagination (Trước/Sau). Sheet hiển thị payload bằng `<pre>` có nút copy và danh sách delivery kèm status badge.

**A-6: Deliveries + DLQ + Replay.** Badge màu theo status. Replay: AlertDialog → POST → toast → invalidate `dlq` + `overview`.
*DoD:* replay một delivery DEAD thì nó biến khỏi DLQ và xuất hiện ở Deliveries với generation mới.

**A-7: Sources / Destinations / Subscriptions.** Bảng + Dialog tạo (RHF + Zod). **Không hiển thị secret** sau khi tạo (API trả về `secretEncrypted` thì cũng không render ra).

**A-8: Playground + dọn dẹp.** Port logic test sender. Xoá `page.tsx` cũ khi các màn mới đã thay thế đủ. **Dọn mùi BB-1:** `apps/hub-api/src/modules/realtime/realtime.gateway.ts:50-52` đang subscribe kênh `hub:realtime:orders` và emit `order.updated`. Không ai publish vào kênh này, và hub **không được biết "order"**. Xoá nó và ghi ADR 3 dòng.

## Ràng buộc
- Mọi URL lấy từ env, không hardcode `localhost`.
- Không thêm endpoint nào gọi Redis mỗi request. `metrics.tick` đã đếm trong bộ nhớ, giữ nguyên.
- Không thêm Next `proxy.ts`/middleware cho auth vì JWT nằm ở `localStorage`, server không đọc được.
- Không sửa ingest, worker hay topology.
