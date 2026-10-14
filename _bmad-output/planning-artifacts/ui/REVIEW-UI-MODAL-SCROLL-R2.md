# REVIEW lượt 2 — UI-MS (khung modal/sheet chung + thanh cuộn chung)

- **Ngày:** 2026-10-14 · **Reviewer:** Sally (UX) + Murat (test), độc lập
- **Nhánh:** `feat/ui-modal-scroll` (worktree `C:\wt\ui`). Phần đã soát ở lượt này: 3 commit sửa `7f9bdb8` (N1), `e0676ee` (T1/T2/T3/T4/T8) và `f623368` (AUDIT), tính từ commit review lượt 1 `42d5fd0`.
- **Đối chiếu:** `REVIEW-UI-MODAL-SCROLL.md` (lượt 1: 1 Nặng, 0 TB, 8 Thấp)

## Kết luận: **ĐẠT** (0 Nặng · 0 Trung bình · 1 Thấp mới, không chặn)

### Đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx tsc --noEmit -p apps/web` | sạch |
| `npx jest sheet-width.spec ui-logic.spec scroll-lock.spec --maxWorkers=2` | 3 suite, 28/28 pass |
| `git diff --stat 9fe279c..HEAD` | vẫn chỉ có `apps/web/**` và `_bmad-output/**`; không có `apps/hub-*`, `libs/*` hay `apps/shop/src` ✅ |

## N1 — đã hết ✅

- **Nguyên nhân đã được gỡ:** `components/ui/sheet.tsx:77-80` bỏ hẳn `data-[side=left|right]:w-full`. Bề rộng mặc định giờ là class thường `w-full` cộng `SHEET_SIZE[size]`, và chỉ áp khi sheet mở từ bên trái hoặc phải. Class thường thì tailwind-merge (`cn`) gộp được, nên `w-(--sidebar-width)` của `sidebar.tsx:194` thay hẳn `w-full`. Sidebar mobile về lại 18rem, dải overlay bên phải hiện lại và chạm vào đó là đóng. Từ 640px trở lên, `sm:max-w-lg` vẫn còn nhưng không có tác dụng (18rem < 32rem).
- **5 sheet nội dung không đổi bề rộng:**
  - Áp dụng cho: cảnh báo (`md`); sự kiện, chặng, lắng nghe, lưu lượng (`lg`).
  - Không sheet nào truyền `className` có `w-*`, nên kết quả vẫn là `w-full` trên mobile và `sm:max-w-lg` / `sm:max-w-2xl` trên desktop, giống hệt lượt 1.
  - Độ ưu tiên giảm từ (0,2,0) xuống (0,1,0). Điều này không đổi kết quả vì không có class bề rộng nào khác cạnh tranh.
- **Spec chặn hồi quy có ý nghĩa** (`components/ui/sheet-width.spec.ts`):
  1. Regex cấm `w-*` đặt dưới variant `data-[side=left|right]`. Ca này **đỏ** trên `42d5fd0`, vì chuỗi cũ chứa `data-[side=left]:w-full`.
  2. Kiểm rằng sidebar mobile vẫn truyền `w-(--sidebar-width)`.
  3. Kiểm rằng `cn` thật sự gộp `w-full` đi. Ca này chứng minh giả định về tailwind-merge, không chỉ so chuỗi.
  - Hạn chế nhỏ (không chặn): regex chưa bắt dạng `data-[side=left]:data-open:w-*`, vì `[a-z]+` không khớp dấu `-`. Dạng này khó xuất hiện.

## Kiểm các sửa Thấp — không phát sinh lỗi mới

| Mục | Kiểm | Kết quả |
|---|---|---|
| **T3** Checkout `form="ckForm"` (`CheckoutModal.tsx:284, 511-540`) | Nút submit nằm trong `.ckfoot`, ngoài `<form>`, nối bằng `form="ckForm"`, nên form vẫn là chủ của nút. Bấm nút thì sự kiện `submit` bắn trên form, `submit()` (`:207`) vẫn `preventDefault` và validate như cũ; `noValidate` giữ nguyên. Nhấn **Enter** trong ô nhập vẫn submit được, vì theo HTML nút submit mặc định là nút đầu tiên có chủ là form đó, kể cả khi nằm ngoài DOM của form. Khi giỏ trống, nút bị `disabled` nên Enter cũng không submit, giống trước. Điều kiện hiện nút khớp đúng các khối cũ: `!order` / `order && status !== "PAID"` (Tạo đơn mới hoặc Đổi món) / `order && status === "PAID"`. `id="ckForm"` là duy nhất. `.ckfoot:empty` không xảy ra vì luôn có đúng một nhánh. | ✅ |
| **T4** sticky nút đóng popup món (`shop-cart.css` khối `@media (max-width:991px)`) | `.mpbox > .mpclose` có độ ưu tiên (0,2,0), thắng `position:absolute` của `.mpclose` (0,1,0). Nút là flex item: `margin-left:auto` đẩy nó sang phải, `.mpimg` rộng 100% nên rơi xuống dòng sau. Dòng flex của nút cao 14 + 34 − 48 = 0, nên ảnh vẫn sát mép trên. Vì `.mpbox` là vùng cuộn, `top:14px` giữ nút dính khi cuộn. `z-index:2` cùng việc đã được định vị giúp nút vẽ đè lên ảnh. Màn ≥992px không bị ảnh hưởng. | ✅ (cần xem mắt, Checklist 4) |
| **T1** chuông (`alert-bell.tsx:78, 115`) | `PopoverContent` có `overflow-hidden`; utility này thắng `.scroll-area` vốn ở `@layer components`. Panel bị chặn bởi `min(560px, 100dvh−6rem, var(--radix-popover-content-available-height,560px))`. Radix đặt biến này trên phần tử Content, panel là con nên thừa hưởng; giá trị dự phòng 560px dùng khi panel không nằm trong popover. Chỉ còn danh sách `min-h-0 flex-1 .scroll-area` là cuộn. | ✅ |
| **T2** Tạo nguồn (`sources/page.tsx:495`, `generic-fields.tsx:225, 313, 330`) | Hộp cố định cỡ `lg` nên không nhảy cỡ. Nút điền nhanh và ô `template` trải 2 cột. Prop `wide` mặc định `false`, không đổi các ô khác. Không đổi khoá i18n hay logic form. | ✅ |
| **T8** dự phòng `vh` | `height: 30vh` đứng trước `min(240px,30dvh)` | ✅ |
| AUDIT (`f623368`) | Dòng #22 đã ghi đúng là hồi quy và đã sửa. §6 liệt kê nợ T5/T6/T7/T2b, khớp với review. | ✅ |

## Thấp (mới)

| # | File:dòng | Phát hiện | Gợi ý |
|---|---|---|---|
| T9 | `CheckoutModal.tsx` (`submitError` trong `<form>`, nút ở `.ckfoot`) | Nút submit giờ luôn thấy, nhưng `submitError` và lỗi từng ô vẫn nằm trong `.ckbody`. Nếu người dùng cuộn lên đầu form rồi bấm "Tạo đơn" ở footer, lỗi có thể hiện ngoài vùng nhìn trên màn thấp, và người dùng thấy như bấm không có phản hồi. | Khi submit lỗi, `scrollIntoView({block:"nearest"})` tới ô lỗi đầu tiên hoặc tới `.ckerr`; hoặc đưa `submitError` vào `.ckfoot`. Không chặn merge. |

Các mục nợ T5/T6/T7/T2b giữ nguyên như AUDIT §6, chấp nhận.

## Checklist QA trực quan (Vercel preview) — bổ sung cho lượt 1

1. **375px, admin → ☰:** sidebar rộng khoảng 18rem, dải mờ bên phải hiện, chạm vào dải đó thì đóng. Mở 5 sheet (cảnh báo, sự kiện, chặng, lắng nghe, lưu lượng): trên mobile phủ hết bề ngang; trên desktop rộng 32rem (cảnh báo) hoặc 42rem (4 sheet còn lại).
2. **Chuông cảnh báo** ở cửa sổ cao ~500px: thanh tiêu đề chuông đứng yên, chỉ danh sách cuộn, chỉ có một thanh cuộn.
3. **Shop → Thanh toán:**
   - Nút "Tạo đơn & lấy mã QR" luôn thấy ở đáy hộp.
   - Để trống rồi bấm: lỗi hiện ra. Cuộn lên đầu form rồi bấm lại để xem có thấy lỗi không (T9).
   - Nhấn Enter trong ô SĐT phải submit.
   - Tạo đơn: thấy nút "Đổi món / tạo đơn mới"; khi đã thanh toán thì đổi thành "Tiếp tục xem thực đơn".
4. **Shop 375×667 → popup món có mô tả dài:** cuộn hộp, nút ✕ dính góc trên phải và không đẩy ảnh xuống. Màn ≥992px: ảnh đứng yên, cột chữ cuộn.
5. **Admin → Nguồn → Tạo:** đổi qua lại provider có sẵn và "Nhà cung cấp khác" mà hộp không nhảy cỡ. Ở chế độ chuỗi ký, nút điền nhanh và ô chuỗi ký trải hết hàng.
