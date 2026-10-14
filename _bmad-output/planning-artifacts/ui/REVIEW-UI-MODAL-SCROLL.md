# REVIEW — UI-MS: khung modal/sheet chung + thanh cuộn chung

- **Ngày:** 2026-10-14 · **Reviewer:** Sally (UX) + Murat (test), độc lập
- **Nhánh:** `feat/ui-modal-scroll` (worktree `C:\wt\ui`), 7 commit `f3f9a67..92fd001` trên master `9fe279c`
- **Đối chiếu:** yêu cầu gốc của Admin (1) khung overlay + (2) thanh cuộn chung; báo cáo dev `AUDIT-MODAL-SCROLL.md`

## Kết luận: **CHƯA ĐẠT** (1 Nặng · 0 Trung bình · 8 Thấp)

Khung chung (`overlay-size.ts` + `DialogBody`/`AlertDialogBody`/`SheetBody`), thanh cuộn một chỗ và `scroll-lock` cho shop đều làm đúng hướng và gọn. Vướng **một hồi quy trên mobile**: sidebar admin chiếm hết màn và không còn đường đóng (N1). Sửa N1 (1–2 dòng) cộng thêm test chặn hồi quy thì ĐẠT. Các mục Thấp không chặn merge.

### Đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit -p apps/web` | sạch (0 lỗi) |
| `npx jest scroll-lock.spec ui-logic.spec unverified.spec --maxWorkers=2` | 3 suite, 32/32 pass |
| `git diff --stat 9fe279c..HEAD` | chỉ có `apps/web/**` và `_bmad-output/**`. **Không đụng** `apps/hub-*`, `libs/*`, `apps/shop/src` ✅ |

Không chạy `next build`/docker (theo giao việc), nên phần CSS sau build cần kiểm trên Vercel preview, xem Checklist.

---

## Nặng

### N1 — Sidebar admin trên mobile phủ 100% màn, không còn cách đóng

- **Vị trí:** `apps/web/src/components/ui/sheet.tsx:77` (đổi `data-[side=left]:w-3/4` → `data-[side=left]:w-full`, phía right cũng vậy) và `apps/web/src/components/ui/sidebar.tsx:194` (sidebar mobile truyền `className="w-(--sidebar-width) … [&>button]:hidden"`).
- **Cơ chế:** với Tailwind v4, `data-[side=left]:w-full` sinh ra selector `.cls[data-side="left"]`, độ ưu tiên (0,2,0). Nó thắng `w-(--sidebar-width)` (0,1,0) bất kể thứ tự. tailwind-merge không gộp hai class này vì chúng khác variant. Trước đây `w-3/4` cũng thắng theo cách này, nhưng 75% của 375px ≈ 281px, xấp xỉ 18rem nên không ai thấy. Giờ thành 100%. Từ `sm` trở lên lại bị `SHEET_SIZE.md` (`sm:max-w-lg`) chặn ở 32rem.
- **Kịch bản:** điện thoại 375px, mở admin rồi bấm ☰. Sidebar phủ kín màn. Nút ✕ đã bị `[&>button]:hidden` ẩn, và không còn dải overlay nào để chạm ra ngoài. Bấm một mục menu thì trang phía sau đổi, nhưng sheet vẫn mở vì không có `setOpenMobile(false)` khi điều hướng. Người dùng **bị kẹt**: điện thoại không có phím Esc. Bảng lục soát ghi #22 là "nhận khung mới không đổi hình", điều này **sai**.
- **Sửa gợi ý:**
  - Ở `sidebar.tsx:194`, thêm `data-[side=left]:w-(--sidebar-width) data-[side=right]:w-(--sidebar-width) sm:max-w-none`. Hoặc cho `SheetContent` một cờ để bỏ cỡ, rồi để sidebar tự đặt bề rộng.
  - Thêm một ca vào `ui-logic.spec.ts` (kiểu test đọc chuỗi class đang có) để khẳng định sidebar mobile ghi đè bề rộng theo cả variant `data-[side=*]`.
  - Sửa dòng #22 trong AUDIT.

## Trung bình

Không có.

## Thấp

| # | File:dòng | Phát hiện / kịch bản | Gợi ý |
|---|---|---|---|
| T1 | `components/ui/popover.tsx:32` + `components/alerts/alert-bell.tsx:113` | `PopoverContent` giờ có `.scroll-area` và `max-h` bằng chỗ trống. Chuông cảnh báo lại có panel flex riêng (`max-h min(560px,100dvh-6rem)`) với danh sách `.scroll-area`. Trên màn thấp (chỗ trống < panel), **hai vùng cuộn lồng nhau**: thanh tiêu đề chuông bị cuộn đi theo hộp ngoài. | Thêm `overflow-hidden` vào `className` của PopoverContent ở alert-bell, hoặc đổi panel thành `max-h-full`. |
| T2 | `dashboard/sources/page.tsx:495, 556` | (a) Đổi provider trong lúc dialog đang mở làm hộp **nhảy cỡ** md↔lg. (b) Lưới 2 cột của `GenericFields` gồm các ô xuất hiện/ẩn theo điều kiện, nên đổi `scheme`/`sigMode` làm các ô **đổi cột**, mắt phải dò lại. Ô `template` dài và hàng nút "điền nhanh" bị ép còn nửa cột. Thứ tự tab vẫn khớp DOM theo hàng (không sai a11y). | Để ô preset + template trải 2 cột (`sm:col-span-2`); cân nhắc mở `lg` ngay khi provider là generic, trước lần render đầu. |
| T3 | `(shop)/_components/CheckoutModal.tsx:281` | Nút "Đặt món"/hành động nằm trong `.ckbody` nên vẫn cuộn theo nội dung. Chỉ phần bước ở trên đứng yên, chưa có "footer đứng yên" đúng nghĩa. So với trước đã tốt hơn (trước đây cả hộp cuộn). | Chấp nhận được với template shop. Muốn trọn yêu cầu thì tách hàng nút ra ngoài `.ckbody`. |
| T4 | `shop-assets/css/shop-cart.css` (khối `.mpbox`, < 992px) | Popup món trên màn hẹp: `.mpbox` vẫn tự cuộn và `.mpclose` (absolute trong hộp) **trôi mất** khi mô tả dài. Ảnh đã thu còn `min(240px,30dvh)` nên với món bình thường ở 375×667 hiếm khi gặp. | `position: sticky` cho `.mpclose`, hoặc giữ cột chữ cuộn riêng như màn rộng. |
| T5 | `lib/ui/scroll-lock.ts:36-48` | `body{overflow:hidden}` không chặn cuộn chạm trên iOS Safari < 16. Phần tử `position:fixed` bám mép phải (`#btt`) dịch đúng bằng bề rộng thanh cuộn khi khoá (AUDIT §5 đã nêu). Spec 6 ca có ý nghĩa: đếm lồng nhau, bù padding, trả style cũ, unlock thừa, SSR. Logic đúng cho unmount khi đang mở (cleanup của effect gọi unlock) và cho Strict Mode (lock→unlock→lock). Chỉ thiếu một ca cho adapter DOM thật `bodyScrollLock`. | Ghi nhận. Không bắt buộc. |
| T6 | `styles/scrollbar.css:30-50` | Trên WebKit/Blink, rãnh luôn chiếm 10px (thumb vẽ 6px) nên mọi vùng cuộn mất 10px bề ngang. macOS/Safari hết thanh cuộn overlay, hiện thanh cổ điển. `transition` trên thumb không có tác dụng (AUDIT đã nêu). Đây là đánh đổi để có hiệu ứng nở khi hover, chấp nhận được. | Ghi nhận. |
| T7 | `destinations/page.tsx:383`, `subscriptions/page.tsx:285`, `endpoint-dialogs.tsx:172, 213` | Nhãn/gợi ý tiếng Anh ở nửa cột xuống dòng nhiều hơn. Khi hai ô cạnh nhau có nhãn cao khác nhau, ô nhập lệch hàng. Lỗi validation hiện trong `Field` của từng cột, không chồng nhau. Không đổi khoá i18n, API hay hành vi submit (`form={formId}` vẫn còn). | QA ở locale EN (Checklist mục 5). |
| T8 | `shop-cart.css` (`.mpimg height:min(240px,30dvh)`) | Không có dự phòng `vh` (khác `.ckbox`/`.mpbox` là có). Admin không cần dự phòng: Tailwind v4 yêu cầu Safari 16.4 / Chrome 111 / Firefox 128, đều đã hỗ trợ `dvh`. | Thêm dòng `height: 30vh` đứng trước. |

## Kết quả soi theo 6 câu hỏi

1. **Overlay bỏ sót:** grep `DialogContent|SheetContent|AlertDialogContent|PopoverContent|DropdownMenuContent|SelectContent|fixed inset-0|position: fixed` trong `apps/web/src` và CSS shop. Mọi `AdminDialogContent` (11) đều có `DialogBody`, mọi `AlertDialogContent` (5) đều có `AlertDialogBody`, các sheet nội dung (5) đều có `SheetBody`. Không chỗ nào cài thiếu thân, nên không còn trường hợp header mất padding vì `p-4` đã bị bỏ khỏi Content. Riêng **sidebar mobile (Sheet)** bị đổi hình (N1). Select/DropdownMenu đã được Radix giới hạn chiều cao. `#searchOv` (shop) cho kết quả cuộn riêng.
2. **CSS:** `min(…, 90dvh)` đủ cho baseline của Tailwind v4. Shop có dự phòng `vh` (trừ T8). Content dùng `flex flex-col overflow-hidden`, Header/Footer có `shrink-0`, Body có `min-h-0 flex-1` + `.scroll-area`, nên thân cuộn thật. Form nằm **trong** Body, nút submit ở Footer dùng thuộc tính `form=`, nên không có `<form>` nào bọc Body+Footer làm hỏng flex. Mobile: `w-[calc(100%-2rem)]` cho lề 1rem; `lg` (`sm:max-w-2xl`, 42rem) co theo màn trong khoảng 640–704px.
3. **Thanh cuộn:** lập luận đúng. Từ Chrome 121, hễ phần tử có `scrollbar-color`/`scrollbar-width` khác `auto` thì Chrome bỏ `::-webkit-scrollbar*`. Chromium và Safari trả `true` cho `selector(::-webkit-scrollbar)`, Firefox trả `false`. Vì vậy `@supports not selector(::-webkit-scrollbar)` chỉ áp các thuộc tính chuẩn cho Firefox: `thin` (~8px) + màu, không có hover. Nếu sau này Chromium bỏ `::-webkit-scrollbar` thì tự rơi về nhánh chuẩn, không vỡ. Theme: màu đọc `--muted-foreground` ngay tại phần tử, nên `.dark` trên `<html>` đổi được cả thanh cuộn của viewport. Không còn CSS thanh cuộn rải rác (đã bỏ 2 khối trong `style.css`; grep `scrollbar` trong `src` chỉ còn `scrollbar.css`). Selector viewport của Radix Select tự ẩn thanh cuộn bằng style không có layer, nên thắng `@layer base`. Chấp nhận được.
4. **Bố cục 2 cột:** thứ tự DOM giữ nguyên, nên tab/focus đi theo hàng và khớp với thị giác. Nhãn `htmlFor`/`aria-label` giữ nguyên, lỗi validation ở trong `Field`. Không đổi khoá i18n, API hay nghiệp vụ. Ghi chú UX ở T2 và T7.
5. **scroll-lock:** đúng (xem T5). Gallery và ShopEffects dùng chung một bộ đếm, nên vá được lỗi cũ "đóng cái này xoá khoá của cái kia".
6. **Phạm vi:** đạt (chỉ `apps/web` + tài liệu).

## Checklist QA trực quan (Vercel preview)

1. **Điện thoại 375px, admin → ☰:** sidebar rộng khoảng 18rem, vẫn thấy dải mờ bên phải, chạm vào dải đó thì đóng. *(Mục kiểm N1, hiện đang hỏng.)*
2. **Thanh cuộn:** trang Sự kiện, bảng rộng trên màn hẹp. Thumb mảnh, xám dịu; hover thì đậm và to ra. Đổi theme tối, thumb đổi theo. Firefox: mảnh, đúng màu.
3. **Cửa sổ cao ~600px → Nguồn → Tạo → Nhà cung cấp khác → Chuỗi ký:** tiêu đề và nút Huỷ/Tạo đứng yên, chỉ form cuộn. Trang nền không hiện thanh cuộn và không giật ngang khi mở/đóng.
4. **Đích → Tạo endpoint** (≥640px): tên + URL nằm một hàng; footer luôn thấy. Thu xuống 360px thì về 1 cột, còn lề 1rem.
5. **Đổi ngôn ngữ sang EN** rồi mở lại form Đích / Subscription / Endpoint: nhãn nửa cột không tràn; bấm Tạo khi để trống thì lỗi hiện đúng dưới từng ô.
6. **Sheet sự kiện / chặng:** cuộn JSON dài, tiêu đề và nút ✕ không trôi. **Topology → quản lý node:** 3 nút nằm gọn một hàng.
7. **Chuông cảnh báo** trên cửa sổ thấp (~500px): chỉ có một thanh cuộn (T1).
8. **Shop 375×667:** mở popup món, giỏ, thanh toán. Hộp không vượt màn, nút đóng luôn thấy, nền không cuộn theo. Mở giỏ → thanh toán → đóng thanh toán thì nền vẫn khoá; đóng giỏ thì nền cuộn lại được. Mở gallery rồi đóng: trang không giật.
