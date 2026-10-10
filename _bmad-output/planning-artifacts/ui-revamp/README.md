# UI Revamp: Dashboard (Studio Admin) + Shop đặt đồ ăn (Sarab)

> Viết ngày 2026-10-09 trong phiên party mode. **Spec này dùng để giao cho phiên khác thực hiện.**
> Đọc theo thứ tự: file này → `SPEC-A-admin.md` (Nhóm A) → `SPEC-B-shop.md` (Nhóm B).
> Quyết định nền: ADR-024..027 trong `docs/adr/README.md`.

> **⚠️ 2026-10-10, từ phiên hub-multi-service (ADR-053, story S14):** Từ S14, tên kiểu event đầu ra đổi như sau:
> - `payment.succeeded` và `bank.transfer.received` → **`payment.received`**; `data` chung một khuôn: `amount, currency, method, reference, memo, counterparty, account, providerTxnId, paidAt, raw`.
> - GitHub ngoài push/PR/issue: `repo.<event>` → `github.<event>`.
>
> Phiên UI cần sửa:
> - placeholder `payment.succeeded` ở `apps/web/src/app/(admin)/dashboard/subscriptions/page.tsx`;
> - payload mẫu trong `dashboard/playground/_components/build-request.ts`, nếu nó hiển thị event đầu ra.
>
> Payload **đầu vào** giả lập SePay (`transferAmount`) ở SPEC-B **giữ nguyên**, vì đó là định dạng của SePay. Chi tiết: `../hub-multi-service/SPEC-hub-multi-service.md` §4.14.5.
>
> **⚠️ 2026-10-10 (ADR-055):** Màn **tạo key** của console cần hiện **3 ô copy** lấy từ trường `quickstart` của response (`env`, `install`, lệnh `hub listen`), kèm cảnh báo "key chỉ hiện một lần". Không cần đẹp. Lỗi API giờ có thêm `fix` và `requestId`: nếu UI hiện lỗi thì hiện cả `fix`. Chi tiết: `../hub-multi-service/SPEC-dev-experience.md` §2, §3.4.

## 1. Quyết định đã chốt (Admin, 2026-10-09)

| # | Câu hỏi | Chốt |
|---|---|---|
| D1 | Giỏ hàng? | **Có**, nhiều món. Giỏ ở client, server tự tính tổng (ADR-024) |
| D2 | Sarab "y hệt" đến mức nào? | **Đủ 14 section.** Section không liên quan tới đặt hàng thì để tĩnh, không có backend |
| D3 | Giá menu | **Giá thật** (ADR-027). Giả lập thanh toán chỉ có ở local |
| D4 | Cách port Sarab | **Port sang React + giữ `style.css` gốc** (ADR-026) |
| D5 | Studio Admin dùng nhánh nào | **Theo template** (nhánh `main`, Next.js 16). `apps/web` nâng từ Next 15 lên 16 |

Quyết định phát sinh trong phòng (đã ghi ADR):
- Hai root layout tách bằng route group `(admin)` / `(shop)` (ADR-025)
- **Thay Font Awesome Pro bằng Free.** Template kèm `Font Awesome Pro 6.0.0 — Commercial License`, cấm commit (ADR-026)
- Shop **không** nghe Socket.IO của hub, mà poll API của chính shop (BB-1, Winston)

## 2. Phân tích: được / không được / xung đột

### Được (không phá bất biến)
- **BB-1:** toàn bộ chuyện "đồ ăn" nằm ở `apps/shop` + `apps/web/(shop)`. **Hub không đổi một dòng nào** vì nó vẫn chỉ thấy giao dịch có nội dung `DH…`.
- **BB-2..BB-5:** UI không chạm vào ingest, idempotency hay worker. Endpoint mới duy nhất ở hub (`stats/timeseries`, Nhóm A) đọc Postgres qua `TenantScopedRepository` và không đụng Redis.
- Cả hai template đều **MIT**.

### Không được / cấm
- ❌ Commit webfonts/CSS **Font Awesome Pro** của Sarab.
- ❌ Gộp Bootstrap và Tailwind vào chung một root layout.
- ❌ Shop subscribe Socket.IO của hub (vì cần JWT admin, và sẽ ghép shop vào hub).
- ❌ Client gửi `amount` lên `POST /orders` (lỗ hổng sửa giá, có sẵn ở `apps/shop/src/main.ts:42`).
- ❌ Bật `NEXT_PUBLIC_DEMO_SIMULATE` ở deployed (seed key SePay sẽ nằm trong bundle).
- ❌ Bê nguyên 9 dashboard, Kanban, Chat, Email… của Studio Admin. Chỉ lấy **khung**.
- ❌ `apps/shop` vượt ~300 dòng (hiện 164).

### Xung đột đã giải quyết
| Xung đột | Giải |
|---|---|
| CLAUDE.md cấm giỏ hàng ↔ shop đặt đồ ăn | ADR-024 sửa luật: giỏ chỉ ở client, CLAUDE.md đã cập nhật |
| Tailwind preflight ↔ Bootstrap reboot | ADR-025: hai root layout |
| "Y hệt" (jQuery) ↔ monorepo TypeScript | ADR-026: port React, giữ class + `style.css` |
| Giá thật ↔ demo tốn tiền thật | ADR-027: giá hiển thị = giá thu; giả lập chỉ ở local |
| Biểu đồ Studio cần chuỗi thời gian ↔ API chỉ trả số đếm | Nhóm A thêm `GET /api/v1/stats/timeseries` (Postgres, không Redis) |
| Hai nhóm cùng sửa `apps/web` (package.json, layout) | **Phase 0** do Nhóm A làm trước, xem §3 |

### Rủi ro còn mở
- 3 lỗ hổng trạng thái đơn (memory 2026-09-22: reconcile chết, không có timestamp guard, không có state machine). **Ngoài phạm vi UI**, ghi thành story tuỳ chọn B-8. Amelia khuyến nghị làm, John muốn để sau. **Admin quyết.**
- Next 16 có breaking change (ví dụ `middleware` → `proxy`). Dashboard hiện tại dùng JWT trong `localStorage` nên auth guard vẫn ở client, không cần proxy.

## 3. Thứ tự thực hiện và quyền sở hữu file

```
Phase 0 (Nhóm A, ~nửa ngày) ──┬──> Nhóm A: A-1..A-8
                              └──> Nhóm B: B-2..B-7 (phần UI)
Nhóm B: B-1 (backend apps/shop) chạy SONG SONG với Phase 0, vì không đụng apps/web
```

**Phase 0, nền chung (Nhóm A làm, merge xong Nhóm B mới bắt đầu phần UI):**
1. Nâng `apps/web` lên Next 16 + React 19.2 theo `package.json` của Studio Admin. Chuyển `app/` → `src/app/`.
2. Xoá `app/layout.tsx` chung. Tạo `src/app/(admin)/layout.tsx` (Tailwind v4 + shadcn + theme) và `src/app/(shop)/layout.tsx` (**khung rỗng**: `<html lang="vi">`, chưa có CSS).
3. Tạm chuyển `page.tsx` cũ vào `(admin)` và `shop/page.tsx` cũ vào `(shop)/shop/` để không gãy gì.
4. Env: thay hardcode `http://localhost:4000/4001` bằng `NEXT_PUBLIC_HUB_API_URL`, `NEXT_PUBLIC_SHOP_API_URL`, `NEXT_PUBLIC_DEMO_SIMULATE`. Cập nhật `docs/DEPLOYMENT.md` (biến env của Vercel).
5. DoD: `npm run build --workspace=apps/web` xanh; `/` (dashboard cũ) và `/shop` (shop cũ) vẫn chạy.

**Quyền sở hữu sau Phase 0:**
| Đường dẫn | Chủ |
|---|---|
| `apps/web/src/app/(admin)/**`, `apps/web/src/components/ui/**`, `src/components/admin/**`, `src/lib/hub/**` | A |
| `apps/hub-api/**`, `libs/database/src/tenant-scoped.repository.ts` (chỉ thêm method stats) | A |
| `apps/web/src/app/(shop)/**`, `apps/web/public/shop-assets/**`, `src/lib/shop/**` | B |
| `apps/shop/**`, `libs/database/prisma/schema.prisma` (chỉ model `Order`) | B |
| `apps/web/package.json` | A ở Phase 0. B thêm `swiper`, `aos`, `@fortawesome/fontawesome-free`, **báo A** trước khi merge |

## 4. Prompt bàn giao cho phiên mới

> Đọc `CLAUDE.md`, rồi `_bmad-output/planning-artifacts/ui-revamp/README.md` và spec của nhóm mình. Template Sarab nằm ở `C:\Users\admin\Downloads\sarab-v1.0.0.zip`: **giải nén vào thư mục scratch riêng, không giải nén vào repo**, và chỉ copy những gì spec cho phép (KHÔNG copy `css/all.min.css` hay `webfonts/` vì đó là FA Pro). Studio Admin: https://github.com/arhamkhnz/next-shadcn-admin-dashboard (MIT, nhánh `main`). Làm theo từng story, mỗi story đạt DoD rồi mới sang story kế. Quyết định mới → ghi ADR 3 dòng.
