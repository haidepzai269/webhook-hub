# AUDIT — Popup / modal / sheet và thanh cuộn (`apps/web`)

- **Ngày:** 2026-10-14 · **Nhánh:** `feat/ui-modal-scroll` (từ master `9fe279c`) · **Người làm:** Amelia (dev) + Sally (UX)
- **Phạm vi:** chỉ `apps/web` (admin console Next.js + storefront `(shop)`). Không đụng `apps/hub-*`, `libs/*`, không đổi API / logic nghiệp vụ / i18n.
- **Nguyên tắc:** chỉ đổi khung và bố cục. Giữ nguyên hành vi, nội dung, khoá i18n.

## 1. Đã cài những gì dùng chung

| Thứ dùng chung | File | Tác dụng |
|---|---|---|
| Thanh cuộn chung | `apps/web/src/styles/scrollbar.css` | Chỗ **duy nhất** định nghĩa thanh cuộn. Admin import qua `app/(admin)/globals.css`, shop import ở `app/(shop)/layout.tsx`. Áp cho **mọi** vùng cuộn (trang, modal, sheet, bảng cuộn ngang, popover, select). |
| Lớp `.scroll-area` | cùng file | Vùng cuộn bên trong: `overflow:auto` + `overscroll-behavior:contain` (cuộn tới đáy không kéo trang nền theo). |
| Bộ cỡ overlay | `apps/web/src/components/ui/overlay-size.ts` | `sm` 24rem · `md` 32rem · `lg` 42rem; cao `min(32/42/48rem, 90dvh)`. Dialog, AlertDialog, Sheet cùng đọc ở đây. |
| Khung Dialog | `components/ui/dialog.tsx` | `DialogContent size=` · `DialogHeader` (đứng yên) · **`DialogBody`** (mới, phần duy nhất cuộn) · `DialogFooter` (đứng yên, bỏ `-mx/-mb`). Rộng mobile `calc(100% - 2rem)` (lề 1rem). |
| Khung AlertDialog | `components/ui/alert-dialog.tsx` | `size` `sm`/`default`(=sm 24rem)/`md` (mới) · **`AlertDialogBody`** (mới) cuộn, footer đứng yên. |
| Khung Sheet | `components/ui/sheet.tsx` | `SheetContent size=` (trái/phải: mobile full, ≥sm theo cỡ; trên/dưới tối đa 90dvh) · `SheetHeader` có viền dưới, đứng yên · **`SheetBody`** (mới) cuộn · `SheetFooter` đứng yên. |
| Popover | `components/ui/popover.tsx` | Không cao quá chỗ trống (`--radix-popover-content-available-height`), không rộng quá `100vw - 1rem`, tự cuộn. |
| FormDialog | `components/admin/form-dialog.tsx` | Dùng `DialogBody` + prop `size` (mặc định `md`). |
| Khoá cuộn nền cho overlay **tự viết** (shop) | `apps/web/src/lib/ui/scroll-lock.ts` (+ spec 6 ca) | Đếm tham chiếu (giỏ → thanh toán chồng nhau không mở khoá sớm), bù bề rộng thanh cuộn bằng `padding-right` (không giật layout), trả lại style cũ. |

**Khoá cuộn nền của Dialog/Sheet/AlertDialog admin:** Radix đã làm sẵn (`react-remove-scroll` + `react-remove-scroll-bar` — khoá `body` và bù bề rộng thanh cuộn). Không viết lại.

### Thanh cuộn — đặc tả đã cài

- Mảnh **6px**, track trong suốt, thumb bo tròn, màu = `--muted-foreground` pha 40% trong suốt → tự theo sáng/tối/preset (shop không có token này → xám dịu dự phòng; đổi được bằng `--scrollbar-base`).
- **Hover thumb: đậm (80%) và nở ra 10px.** WebKit/Blink không cho đổi bề rộng thanh cuộn theo hover, nên rãnh luôn 10px, thumb vẽ 6px nhờ viền trong suốt 2px + `background-clip: content-box`; hover bỏ viền → 10px. Có khai báo `transition`, nhưng Chromium hiện **không** nội suy pseudo-element thanh cuộn → đổi tức thì (vẫn mượt mắt vì chênh 4px). Đây là giới hạn trình duyệt, không phải thiếu sót.
- **Firefox:** `scrollbar-width: thin` + `scrollbar-color`, đặt trong `@supports not selector(::-webkit-scrollbar)` — vì Chrome ≥121 hễ thấy `scrollbar-color` là **bỏ qua toàn bộ** `::-webkit-scrollbar*`. Firefox không có hover theo thumb / nở ra (giới hạn của chuẩn).
- Bỏ CSS thanh cuộn riêng của template shop (`style.css`: 5px đỏ toàn trang; `.mpbox` 3px đỏ) → một kiểu duy nhất.
- Bảng cuộn ngang (`components/ui/table.tsx`, `components/admin/data-table.tsx`, bảng secret trong `endpoint-dialogs.tsx`/`api-keys`) tự nhận kiểu chung — không cần sửa từng nơi.

## 2. Bảng lục soát

Dòng = số dòng ở master `9fe279c`. Lỗi: **CQ** cao quá/không cap · **RQ** rộng quá · **CT** cuộn cả khung (tiêu đề/nút trôi mất) · **KN** không khoá nền / khoá gây giật · **TC** thanh cuộn mặc định/riêng lẻ · **DÀI** nội dung thường gặp phải cuộn.

### 2.1 Dialog (Radix) — admin

| # | File:dòng | Modal | Lỗi trước | Cách sửa | Trạng thái |
|---|---|---|---|---|---|
| 1 | `components/admin/form-dialog.tsx:33` | Khung form "Tạo mới" (dùng ở #2–#4) | CT (`max-h-[90dvh] overflow-y-auto` trên cả hộp → tiêu đề + nút Huỷ/Tạo cuộn mất), TC | `DialogBody` + `size` | ✅ |
| 2 | `dashboard/destinations/page.tsx:308` | Tạo đích | CT, DÀI (5 ô xếp dọc) | `md`; **khoá ký + giới hạn tốc độ gộp 1 hàng** | ✅ |
| 3 | `dashboard/sources/page.tsx:487` | Tạo nguồn (provider có sẵn / generic) | CT, DÀI rất nặng với generic (tới ~15 ô ký) | **một cỡ `lg` cố định** (đổi provider không nhảy cỡ — review T2); generic lưới 2 cột, ghi chú `role=note` + nút điền nhanh + ô chuỗi ký trải hết hàng | ✅ |
| 4 | `dashboard/subscriptions/page.tsx:276` | Tạo subscription | CT, DÀI | `md`; **tên + đích gộp 1 hàng** | ✅ |
| 5 | `dashboard/api-keys/page.tsx:167` | Tạo API key / hiện connection string 1 lần | CT | `md` + `DialogBody` | ✅ |
| 6 | `dashboard/destinations/endpoint-dialogs.tsx:148` | Tạo endpoint (+ secret 1 lần) | CT, DÀI (tên, URL, kiểu, nguồn, cờ chưa xác thực) | **`lg`**; **tên + URL 1 hàng; nguồn + cờ chưa xác thực 1 hàng**; `DialogBody` | ✅ |
| 7 | `dashboard/destinations/endpoint-dialogs.tsx:267` | Chi tiết endpoint (delivery gần đây) | CT, danh sách dài cuộn cả hộp | `lg` + `DialogBody` | ✅ |
| 8 | `dashboard/dlq/page.tsx:151` | Replay hàng loạt (xem trước) | CT — nút Chạy trôi khỏi màn khi bản xem trước dài | `md` + `DialogBody`, 3 nút đứng yên | ✅ |
| 9 | `dashboard/projects/page.tsx:252` | Tạo project | **CQ** (không cap chiều cao) | `md` + `DialogBody` | ✅ |
| 10 | `dashboard/sources/connect-dialogs.tsx:169` | Kết nối provider (PayOS/Stripe) | CT, DÀI | `md` + `DialogBody`; **tên + khoá nguồn mới 1 hàng** | ✅ |
| 11 | `dashboard/sources/connect-dialogs.tsx:378` | Tình trạng kết nối | **CQ** (không cap) | `md` + `DialogBody` | ✅ |

### 2.2 AlertDialog (xác nhận) — admin

| # | File:dòng | Hộp | Lỗi trước | Cách sửa | Trạng thái |
|---|---|---|---|---|---|
| 12 | `dashboard/api-keys/page.tsx:220` | Thu hồi key | **CQ** (không cap) | `AlertDialogBody`, cỡ `default`=sm | ✅ |
| 13 | `dashboard/dlq/page.tsx:380` | Replay một delivery (+ lý do) | **CQ** | `AlertDialogBody` gồm cả ô lý do | ✅ |
| 14 | `dashboard/events/_components/orphan-banner.tsx:69` | Chuẩn hoá lại event mồ côi (+ textarea) | **CQ** | `AlertDialogBody` gồm textarea | ✅ |
| 15 | `dashboard/storage/page.tsx:310` | Dọn dung lượng | **CQ** | `AlertDialogBody` | ✅ |
| 16 | `components/flow/topology-canvas.tsx:851` | Ngắt / Xoá node (3 ghi chú + **3 nút**) | **CQ**, **RQ** (3 nút trong 24rem tràn) | **`size="md"`** + `AlertDialogBody` | ✅ |

### 2.3 Sheet — admin

| # | File:dòng | Sheet | Lỗi trước | Cách sửa | Trạng thái |
|---|---|---|---|---|---|
| 17 | `dashboard/alerts/_components/alert-sheet.tsx:26` | Chi tiết cảnh báo | CT (`overflow-y-auto` cả sheet → tiêu đề + nút đóng trôi) | `size="md"`, `SheetBody` | ✅ |
| 18 | `dashboard/events/_components/event-sheet.tsx:42` | Chi tiết sự kiện (JSON) | CT | `size="lg"` (36→42rem cho JSON), `SheetBody` | ✅ |
| 19 | `components/flow/stage-sheet.tsx:32` | Chi tiết chặng (tab vào/ra/chi tiết) | CT | `lg`, `SheetBody` | ✅ |
| 20 | `dashboard/sources/listen-sheet.tsx:40` | Lắng nghe nguồn generic | CT | `lg`, `SheetBody` | ✅ |
| 21 | `dashboard/sources/traffic-sheet.tsx:56` | Lưu lượng nguồn (biểu đồ + bảng IP) | CT | `lg`, `SheetBody` | ✅ |
| 22 | `components/ui/sidebar.tsx:189` | Sidebar mobile (Sheet trái) | **Hồi quy do UI-MS (review N1):** `data-[side=left]:w-full` (0,2,0) đè `w-(--sidebar-width)` → phủ kín 375px, ✕ bị ẩn, không có dải overlay để chạm đóng | `sheet.tsx`: bề rộng mặc định thành class trơn `w-full` (gộp được qua cn) → `w-(--sidebar-width)` thắng; 5 sheet nội dung không đổi (không truyền `w-*`). Chặn hồi quy: `components/ui/sheet-width.spec.ts` | ✅ |

### 2.4 Popover — admin

| # | File:dòng | Popover | Lỗi trước | Cách sửa | Trạng thái |
|---|---|---|---|---|---|
| 23 | `components/admin/layout-controls.tsx:47` | Tuỳ chỉnh giao diện (nhiều nhóm) | **CQ** trên màn thấp — không cap | Cap ở primitive (chỗ trống thật) + tự cuộn | ✅ |
| 24 | `components/alerts/alert-bell.tsx:78` | Chuông cảnh báo | `100vh` (sai trên mobile có thanh địa chỉ) | `100dvh`; danh sách `.scroll-area` là vùng cuộn **duy nhất** (popover `overflow-hidden`, panel cap theo `--radix-popover-content-available-height` — review T1) | ✅ |
| 25 | `components/storage/storage-banner.tsx:95` | Gợi ý liên hệ (1 câu) | — | Nhận cap của primitive; không đổi | ⏸ không cần |

### 2.5 Overlay tự viết — storefront `(shop)` (CSS thuần, ADR-025 không Tailwind)

| # | File:dòng | Overlay | Lỗi trước | Cách sửa | Trạng thái |
|---|---|---|---|---|---|
| 26 | `(shop)/shop/_components/CheckoutModal.tsx:263` + `shop-cart.css:274` | Thanh toán (form → QR → xong) | CT (`.ckbox` `92vh` cuộn cả hộp, bước + nút đóng trôi), `vh` sai mobile, KN giật | `.ckbox` `min(760px, 90dvh)` flex-col; **bước + hàng nút (`.ckfoot`, nút submit dùng `form="ckForm"`) đứng yên, chỉ `.ckbody` cuộn** (review T3); lề safe-area; khoá nền qua `scroll-lock` | ✅ |
| 27 | `(shop)/shop/_components/MenuPopup.tsx:44` + `style.css:2048` | Popup món | CT (nút đóng trôi khi cuộn), thanh cuộn 3px đỏ riêng | `min(640px, 88dvh)`; **màn rộng: ảnh đứng yên, cột chữ cuộn**; màn hẹp: ảnh thấp `min(240px,30dvh)` (dự phòng `30vh` — T8), **nút đóng `sticky`** (T4); bỏ thanh cuộn riêng | ✅ |
| 28 | `(shop)/shop/_components/CartDrawer.tsx:34` + `shop-cart.css:117` | Ngăn giỏ hàng | KN giật (body `overflow:hidden` không bù thanh cuộn), danh sách kéo cuộn trang | `.cartlist` `min-height:0` + `overscroll contain`; khoá nền qua `scroll-lock` (ShopEffects) | ✅ |
| 29 | `(shop)/shop/_components/Gallery.tsx:56` | Lightbox ảnh | KN giật; xung đột với khoá của ShopEffects (cái nào đóng trước xoá khoá của cái kia) | `bodyScrollLock` đếm tham chiếu | ✅ (khung ảnh `64vh` giữ nguyên) |
| 30 | `(shop)/shop/_components/SearchOverlay.tsx:50` | Tìm kiếm toàn màn | KN giật | Khoá nền qua ShopEffects → `scroll-lock`; kết quả đã cuộn riêng (`40vh`) — giữ nguyên | ✅ |

### 2.6 Không phải modal nhưng đã soát

- `window.confirm` (xoay secret endpoint, ngắt kết nối) — hộp native của trình duyệt, ngoài phạm vi.
- `Select` / `DropdownMenu` — đã cap bằng `--radix-*-available-height` từ trước; nhận thanh cuộn chung.
- `app/(admin)/layout.tsx:52` `h-screen` — khung app, không phải overlay; giữ.
- `JsonViewer` / `detail-cards` / `event-log` (`overflow-auto`, `max-h-[26rem]`) — vùng cuộn nội tuyến, nhận thanh cuộn chung; giữ.

## 3. Tổng kết

- **Tìm thấy:** 30 overlay (11 Dialog · 5 AlertDialog · 6 Sheet · 3 Popover · 5 overlay tự viết của shop).
- **Đã sửa:** 28. **Để lại:** 2 (sidebar mobile #22, popover 1 câu #25) — không có lỗi, tự nhận khung mới.
- **Gọn bố cục (nội dung thường gặp không phải cuộn):** form đích, subscription, endpoint, kết nối provider, nguồn generic (gộp cột, lên cỡ `lg` khi nhiều ô); hộp quản lý node lên `md`.

## 4. Cách QA xem trên Vercel preview

1. Thanh cuộn: trang Sự kiện (danh sách dài), bảng rộng trên màn hẹp — thumb mảnh xám, hover thì đậm + to. Đổi theme tối → thumb sáng theo token. Firefox: mảnh, màu dịu.
2. Thu nhỏ cửa sổ còn ~600px cao → mở **Nguồn → Tạo → Nhà cung cấp khác → Chuỗi ký**: tiêu đề + nút Huỷ/Tạo đứng yên, chỉ form cuộn; không có thanh cuộn ở trang nền; trang không giật ngang khi mở/đóng.
3. **Đích → Tạo endpoint**: ≥640px rộng thấy tên/URL một hàng; footer luôn thấy.
4. Sheet sự kiện / chặng: cuộn JSON dài — tiêu đề và nút ✕ không trôi.
5. Topology → quản lý node: 3 nút nằm gọn một hàng.
6. Shop (mobile 375×667): mở popup món, giỏ, thanh toán — không vượt màn, nút đóng luôn thấy, trang nền không cuộn theo, không giật khi mở.

## 5. Giới hạn đã biết

- Chromium không chạy `transition` trên `::-webkit-scrollbar-thumb` → nở/đậm tức thì. Firefox không có hover-nở.
- Shop khi khoá nền: phần tử `position: fixed` bám mép phải (nút giỏ nổi) có thể dịch ~thanh cuộn (15px) — body được bù padding, phần tử fixed thì không. Nhỏ, không sửa để tránh đụng template.

## 6. Sau review `REVIEW-UI-MODAL-SCROLL.md` (42d5fd0)

- **N1 (Nặng) đã sửa:** sidebar mobile, xem dòng #22. Spec `sheet-width.spec.ts` có 3 ca: không có `w-*` dưới variant `data-[side]`, sidebar vẫn truyền `w-(--sidebar-width)`, `cn` gộp đè `w-full`. Ca đầu ĐỎ trên bản trước khi sửa.
- **Thấp đã sửa:** T1 (chuông: một vùng cuộn), T2 (Tạo nguồn một cỡ `lg`; preset + chuỗi ký trải 2 cột), T3 (footer thanh toán đứng yên), T4 (nút đóng popup món dính trên màn hẹp), T8 (dự phòng `vh`).
- **Nợ ghi nhận, không làm:**
  - **T5:** `body{overflow:hidden}` không chặn cuộn chạm trên iOS Safari < 16; phần tử `fixed` bám mép phải dịch theo bề rộng thanh cuộn khi khoá; thiếu ca test cho adapter DOM thật `bodyScrollLock`.
  - **T6:** rãnh WebKit luôn 10px (thumb 6px) → vùng cuộn mất 10px ngang; `transition` trên thumb không có tác dụng ở Chromium.
  - **T7:** nhãn/gợi ý tiếng Anh ở nửa cột xuống dòng nhiều hơn, hai ô cạnh nhau có thể lệch hàng — QA ở locale EN.
  - **T2b:** ô của generic hiện/ẩn theo `scheme`/`sigMode` nên có thể đổi cột khi đổi lựa chọn (thứ tự DOM/tab vẫn đúng).
