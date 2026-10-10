# SPEC-B: Shop đặt đồ ăn theo Sarab

> Nhóm B. Đọc `README.md` cùng thư mục trước (D1–D5, Phase 0, quyền sở hữu file).
> Template: `C:\Users\admin\Downloads\sarab-v1.0.0.zip` (demo https://themewagon.github.io/sarab/), MIT, jQuery 3.7 + Bootstrap 5, `index.html` 1230 dòng, `style.css` 2437 dòng, `main.js` 448 dòng, ảnh 2,5 MB.
> Quyết định nền: ADR-024 (giỏ hàng), ADR-025 (root layout riêng), ADR-026 (port React, FA Free), ADR-027 (giá thật).

## Mục tiêu
`/shop` trông **y hệt Sarab** (đủ 14 section), Việt hoá nội dung, và thật sự **đặt món → giỏ → thanh toán QR → thấy đơn chuyển sang "Đã thanh toán"** thông qua Webhook Hub. Mọi thứ khác là tĩnh.

## Luật bất biến của nhóm
1. **BB-1:** chữ "món ăn" chỉ được xuất hiện trong `apps/shop` và `apps/web/src/app/(shop)`. **Không sửa `apps/hub-*`.**
2. `apps/shop` ≤ ~300 dòng (hiện 164).
3. **Không copy** `css/all.min.css` hay `webfonts/fa-*` của Sarab (Font Awesome **Pro**, giấy phép thương mại). Dùng `@fortawesome/fontawesome-free`. `icomoon.*` được copy nếu `style.css` có dùng.
4. Server tính tiền. Client **không bao giờ** gửi `amount`.
5. Shop **không** nghe Socket.IO của hub. Trạng thái đơn lấy bằng cách poll API của shop.

## Bản đồ 14 section (+ khung)

| # | Section Sarab (`id`) | Chế độ | Ghi chú |
|---|---|---|---|
| – | `#topbar` | Tĩnh | Hotline, giờ mở cửa, địa chỉ (VN) |
| – | `#nav` navbar | **Động (client)** | Anchor cuộn mượt; icon giỏ có số lượng (bật lại khối `cartfl` đang bị comment trong template) |
| – | `#searchOv` overlay tìm kiếm | **Động (client)** | Lọc trên danh sách menu đã tải; chọn kết quả → mở popup món |
| 1 | `#hero` | Tĩnh | CTA "Đặt món ngay" → `#menu` |
| 2 | `#category` | **Động (client)** | Click danh mục → cuộn tới `#menu` + lọc (như `filterMenu` trong `main.js`) |
| 3 | `#about` | Tĩnh | |
| 4 | `#menu` + `#menuPop` | **Động (API)** | Lấy từ `GET /products`. Nút lọc. Popup: ảnh, giá, giá gạch, sao, tag, chọn số lượng, **"Thêm vào giỏ"** |
| 5 | `#special` (đếm ngược −30%) | Tĩnh + đồng hồ client | **Không** áp dụng giảm giá thật (không có logic khuyến mãi). Nút → `#menu` |
| 6 | `#gallery` + `#galPop` | Tĩnh + lightbox client | Prev/Next bằng state |
| 7 | `#history` | Tĩnh | |
| 8 | `#chefs` | Tĩnh | |
| 9 | `#hours` | Tĩnh | |
| 10 | `#testimonials` | Tĩnh + `swiper/react` | |
| 11 | `#reservation` | **Tĩnh** | Submit → hiện `sucmsg` như template, **không có backend** |
| 12 | `#blog` | Tĩnh | |
| 13 | `#newsletter` | Tĩnh | Submit → thông báo thành công, không có backend |
| 14 | `#contact-section` | Tĩnh | Submit → `sucmsg`, không có backend |
| – | `footer`, `#btt` | Tĩnh | |
| **Mới** | Ngăn giỏ hàng (drawer) | **Động** | Không có trong template. Dựng bằng biến màu/class của `style.css` (`--primary`, `--secondary`, `.btn-red`) cho cùng ngôn ngữ thiết kế |
| **Mới** | Modal thanh toán | **Động** | Thông tin khách → QR → poll trạng thái |

## Menu (dữ liệu trong `apps/shop`, giá thật, VND)
Giữ 6 món ứng với 6 ảnh `img/menu/1..6.jpg` của template (Việt hoá tên/mô tả). Ví dụ:

| id | Tên | Danh mục | Giá | Giá gạch |
|---|---|---|---|---|
| m1 | Burger bò smash cổ điển | burgers | 69.000 | 89.000 |
| m2 | Pizza Margherita Hoàng gia | pizza | 129.000 | 159.000 |
| m3 | Gà rán cay Nashville | chicken | 79.000 | 99.000 |
| m4 | Wrap gà Fajita | wraps | 59.000 | 75.000 |
| m5 | Bánh Lava Nutella | desserts | 45.000 | 55.000 |
| m6 | Mì Ý nấm Truffle | pasta | 99.000 | 119.000 |

Mở rộng lên 12 món (dùng lại ảnh) **chỉ** khi vẫn giữ được ≤300 dòng. Ảnh trả về dạng `image: "/shop-assets/img/menu/1.jpg"`.

## Stories

**B-1: Backend `apps/shop`** (chạy song song với Phase 0).
- `GET /products` → 6 món ở bảng trên, schema `{ id, name, category, price, oldPrice, image, description, rating, tags[] }`.
- `POST /orders` nhận `{ items: [{ id, qty }], customer: { name, phone, address?, note? } }`. Validate: `items` không rỗng, `qty` là số nguyên 1–20, `id` có trong menu, `name`/`phone` bắt buộc. **Server tính `amount = Σ price × qty`.** Bỏ hẳn việc đọc `amount` từ body.
- Prisma `Order`: thêm `items Json` + `customer Json?` (1 migration, schema `shop`).
- `GET /orders/:code` trả thêm `items`, `customer`.
- **Giữ nguyên** `/hub-webhook` (HMAC, `timingSafeCompare`, chống replay 5 phút, khớp `DH\d+`).
*DoD:* `apps/shop/test/shop-logic.spec.ts` có thêm test cho: tổng tiền tính ở server; body có `amount: 1` thì bị bỏ qua; `id` lạ → 400; giỏ rỗng → 400. `wc -l apps/shop/src/main.ts` ≤ 300.

**B-2: Tài nguyên tĩnh + layout `(shop)`.**
- `apps/web/public/shop-assets/`: `css/{bootstrap.min,style,aos}.css`, `img/**`, `icomoon.*` nếu cần. **Không có** `all.min.css`, `fa-*` webfonts, jQuery, magnific-popup.
- `src/app/(shop)/layout.tsx` (root layout, `lang="vi"`): `<link>` tới Google Fonts (Playfair Display, Poppins, Dancing Script), Bootstrap, `style.css`, AOS. Import `@fortawesome/fontawesome-free/css/all.min.css`. **Không có Tailwind.**
*DoD:* mở `/shop` rồi kiểm tra trong DevTools: không có request nào tới `fa-light`/`fa-thin`/`fa-duotone`; `/dashboard` không bị CSS Bootstrap đè (kiểm tra bằng mắt sidebar + nút).

**B-3: Port 14 section sang React.** Mỗi section là một component trong `src/app/(shop)/shop/_components/`, **giữ nguyên `class`/`id`** của HTML gốc (đổi `class` → `className`). Nội dung Việt hoá. Tương tác của `main.js` viết lại bằng state/hook: sticky nav, cuộn mượt, overlay tìm kiếm, lọc menu, popup món, lightbox gallery, đồng hồ đếm ngược, nút back-to-top, AOS init (`useEffect`). Testimonials dùng `swiper/react`.
*DoD:* so sánh cạnh nhau với `sarab/index.html` gốc ở 1440px và 375px: bố cục, màu, font, khoảng cách khớp nhau; không còn jQuery trong bundle.

**B-4: Giỏ hàng (client).** `src/lib/shop/cart.ts`: store (Zustand hoặc Context) `{ items: {id, qty}[] }` lưu `localStorage` (bọc try/catch). Thêm từ popup (theo qty đã chọn) và từ nút `+` trên card. Drawer: danh sách món, +/−, xoá, tạm tính. **Tổng tiền chỉ để hiển thị**; số tiền chính thức lấy từ response của server. Badge số lượng trên nav và trên nút `cartfl`.
*DoD:* thêm 3 món, F5 → giỏ vẫn còn; giỏ rỗng thì nút "Thanh toán" bị disable.

**B-5: Thanh toán + theo dõi đơn.** Modal gồm 3 bước:
1. Form khách (tên, SĐT, địa chỉ, ghi chú), validate.
2. `POST /orders` → hiện QR (`qrCodeUrl`), **mã đơn `DH…` to rõ** kèm hướng dẫn "ghi đúng nội dung chuyển khoản", **số tiền lấy từ server**.
3. Poll `GET /orders/:code` mỗi 2s (như logic cũ), dừng khi `PAID`, hoặc khi đóng modal, hoặc sau 15 phút. Trạng thái: `PENDING` (đang chờ) · `PAID` (✓ đã thanh toán, xoá giỏ) · `UNDERPAID` (báo thiếu X đ) · `EXPIRED`.
- Nút **"Giả lập chuyển khoản"** chỉ render khi `NEXT_PUBLIC_DEMO_SIMULATE === 'true'` (port `simulatePaymentWebhook` cũ, bắn SePay vào `NEXT_PUBLIC_HUB_API_URL/hooks/sepay/src_sepay_main`, `transferAmount` = amount của server).
*DoD (demo chính):* local docker-compose: đặt 2 món → Giả lập → trong ≤5s modal chuyển sang "Đã thanh toán". Song song, dashboard `/dashboard/events` (Nhóm A) hiện sự kiện SePay tương ứng. Thêm một kịch bản UNDERPAID: sửa `transferAmount` nhỏ hơn → modal báo thiếu tiền.

**B-6: Dọn dẹp.** Xoá `shop/page.tsx` cũ. Cập nhật `docs/DEPLOYMENT.md` nếu có env mới. Chú thích `ThemeWagon/Bestwpware (MIT)` ở footer hoặc README.

**B-7: Kiểm tra cuối.** Lighthouse mobile cho `/shop` không có lỗi console. Ảnh dùng `next/image` hoặc `loading="lazy"` cho các section bên dưới màn hình đầu.

**B-8 (TUỲ CHỌN, chờ Admin bật):** vá 3 lỗ hổng trạng thái đơn đã tìm ra ngày 2026-09-22:
(a) `reconcile` thật sự `updateMany` các đơn PENDING quá 15 phút sang `EXPIRED`;
(b) bảng chuyển trạng thái tối thiểu, chặn mọi cạnh đi ra từ `PAID/EXPIRED/CANCELLED`;
(c) không cho `paidAmount` lùi về giá trị nhỏ hơn (webhook trễ mang dữ liệu cũ).
Amelia: *"Đổi luồng đơn mà không vá thì UNDERPAID→PAID→EXPIRED sẽ được demo ngay trên giao diện mới."* John: *"Ngoài phạm vi UI."*

## Ngoài phạm vi
Đăng nhập khách, lịch sử đơn, kho, mã giảm giá, phí ship, đặt bàn có backend, gửi email.
