# Cần Admin quyết — P1/P2 (2026-10-11)

## Q1 — Đơn đã hết hạn mà tiền ĐỦ vẫn về: hồi sinh thành PAID?
- Hiện tại (giữ ADR-034, Admin đã chốt "không hồi sinh"): đơn ở EXPIRED, `paidAmount` được cộng (không mất), log cảnh báo,
  khách thấy "đã hết hạn nhưng Shop đã nhận X — gọi hotline", reconcile trả `lateMoneyOrders`.
- Link PayOS hết hạn cùng lúc với đơn (`expiredAt`), nên trả muộn chỉ còn xảy ra với chuyển khoản thẳng (SePay).
- Phương án khác: EXPIRED + đủ tiền → PAID (outcome `LATE_PAID`). Đổi ~3 dòng ở `applyPayment` + test. Chọn?

## Q2 — Tài khoản ngân hàng của kênh PayOS có "liên kết qua payOS" không?
- PayOS giới hạn `description` 9 ký tự với tài khoản KHÔNG liên kết → mã đơn đã rút còn `DH` + 7 số (9 ký tự) để chắc chắn chạy.
- Nếu lúc trả tiền thật thấy memo của webhook (console → sự kiện → `data.memo`) có tiền tố lạ, gửi lại để kiểm regex `DH\d+`.

## Q3 — Ảnh QR PayOS vẽ qua api.qrserver.com
- Chuỗi VietQR (số tài khoản, số tiền, nội dung) đi qua bên thứ ba để vẽ ảnh. Muốn vẽ tại trình duyệt thì thêm thư viện QR
  vào `apps/web` (đụng package-lock — chưa làm vì agent khác đang chạy song song).

## Việc Admin làm trên hạ tầng (agent KHÔNG làm)
- Render → service `shop` → Environment: `SHOP_WEB_URL`, `SHOP_BANK_CODE`, `SHOP_BANK_ACCOUNT`, `SHOP_BANK_ACCOUNT_NAME`
  (tuỳ chọn `SHOP_ORDER_TTL_MIN`); kiểm `PAYOS_CLIENT_ID/API_KEY/CHECKSUM_KEY` là CÙNG kênh với source `src_payos_main`.
- Vercel: không cần biến mới.
