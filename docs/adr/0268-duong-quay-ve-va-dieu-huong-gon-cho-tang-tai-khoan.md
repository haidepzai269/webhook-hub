# ADR-268 — Đường quay về và điều hướng gọn cho tầng tài khoản (2026-10-19)

**Vấn đề:** ADR-237 bỏ sidebar dự án khỏi `/alerts`, `/settings` (đúng phân cấp Hub ⊃ Tài khoản ⊃ Dự án) nhưng hệ quả là vào đó rồi không còn đường nào quay về dashboard dự án — trang "cô lập"; logo chỉ dẫn về `/projects`.

**Chọn:** Bổ sung ADR-237, KHÔNG đảo nó: vẫn không sidebar dự án. `AccountTopBar` (dùng chung `/projects`, `/alerts`, `/settings`) thêm hàng điều hướng gọn: "← Về dự án <tên>" (→ `/dashboard`, dự án lấy từ `project-store`; chưa chọn thì → `/projects`; ẩn ở chính `/projects`), rồi các tab Tất cả dự án / Cảnh báo / Cài đặt (lọc theo vai trò bằng `accountMenuItems`, đánh dấu `aria-current`). Logo → `/dashboard` khi đã chọn dự án, không thì `/projects`. Logic thuần ở `lib/hub/account-routes.ts` (có jest); hàng cuộn ngang trên mobile.

**Đánh đổi:** Thanh trên cao thêm 44px ở tầng tài khoản và thêm 4 khoá i18n (`nav.account.*`); đổi lại không phải dựng sidebar thứ hai. Operator đang chọn dự án mình không là thành viên sẽ thấy nhãn chung "Về dự án đang chọn" vì không có tên trong memberships.
