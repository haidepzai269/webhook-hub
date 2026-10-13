# RESUME P1/P2 (dev agent, 2026-10-11) — XONG

## P2 — commit 0233b43 (ADR-140)
- consoleDestination() (apps/hub-api/src/modules/api/destination-view.ts) cho list/create/patch `/api/v1/destinations`
- Trang Đích: cột "Xác minh" (describeVerification trong ui-logic.ts); types.ts thêm verification*
- TraceFeed: events/page.tsx (dải + toast), flow/page.tsx (toastsOnly)
- Test: apps/hub-api/test/destination-view.spec.ts, apps/web/src/lib/hub/ui-logic.spec.ts

## P1 — commit a9bea33 (ADR-141)
- apps/shop/src/payos.ts (link PayOS thật, ký + kiểm chữ ký phản hồi timingSafeEqual), payment.ts (TTL, mã DH+7 số, VietQR SePay)
- main.ts: /payment-options, POST /orders trả {paymentProvider, expiresAt, payment{qrImageUrl, qrCode?, checkoutUrl?}}, reconcile trả lateMoneyOrders
- Web CheckoutModal + lib/shop/api.ts: chọn PayOS/SePay, nút mở trang PayOS, poll tới expiresAt
- apps/shop/src = 443 dòng (trần 450)
- Docs: CLAUDE.md, .env.example, HUONG-DAN-DEPLOY §8/§9 (chỉ hunk của mình — hunk SHOP_PUBLIC_URL của agent khác KHÔNG commit), kịch bản 2.1
- Test: apps/shop/test/payos.spec.ts (SDK @payos/node làm oracle), shop-logic.spec.ts (TTL 30)

## Kiểm
- npx jest -w 2: 776 pass, 1 fail libs/hub-sdk/test/listen.spec.ts (file đang được agent khác sửa; chạy riêng thì xanh)
- web tsc + next build xanh; shop tsc xanh
- Chưa chạy thật với PayOS (cấm dùng khoá thật). docker-compose chưa thêm SHOP_* (agent khác đang dựng stack) — mặc định đủ cho local.

## Mở: xem CAN-ADMIN-QUYET-P1P2.md (Q1 hồi sinh đơn hết hạn, Q2 tài khoản liên kết payOS, Q3 qrserver)

## Sửa theo REVIEW-P1P2-2026-10-11 (GO-with-fixes) — ADR-144
- M-1 hạn theo paidAt + link PayOS sớm 5 phút; M-2 creditsOrder (OTHER_CHANNEL); M-3 mọi mã DH+7/+10, chọn mã có thật (ANY + FOR UPDATE)
- L-2 GET hết hạn lười; L-3 PayOS 231 -> đổi mã, thử lại 1 lần; L-4 orderTtlMs(env); L-5 payosLinkInput; L-6 xoá traces khi đổi project
- Gate shop-size = tổng apps/shop/src ≤ 450 (checkAll); doc comment createOrder về đúng chỗ; đính chính ADR-140 (L-7) + ADR-141 (M-1, L-1)
- **L-1 (ghi chú commit a9bea33):** message ghi "bỏ QR giả qrserver" — chỉ đúng cho nhánh SePay. Nhánh PayOS VẪN vẽ ảnh QR qua
  api.qrserver.com từ chuỗi VietQR thật của PayOS; coordinator chấp nhận tạm (Admin quyết Q3).
- apps/shop/src = 444 dòng
- Chưa kiểm được trên DB thật: `order_code = ANY(${orderCodes})` (Prisma truyền mảng JS thành text[]) — cần một lượt e2e shop (scripts/hub-all-e2e.sh) khi stack rảnh.

## Review vòng 2 (GO) — sửa nhỏ trước demo tiền thật
- R2-L1: web giữ EXPIRED là "chưa cuối" tới expiresAt + 6 phút, tiếp tục poll (order-status.ts + test); server không đổi
- R2-L4: ORDER BY order_code trong FOR UPDATE nhiều dòng (test regex nguồn)
- R2-L5: chú thích PAYMENT_SOURCES (source ngoài payos/sepay = OTHER_CHANNEL)
- R2-L2: CHƯA làm — đếm tiền OTHER_CHANNEL ở reconcile cần ghi lại khoản đó (cột/bảng mới) -> vượt trần 450 dòng. Hiện chỉ thấy ở log Shop
  (`[Shop] OTHER_CHANNEL …`) + console hub (sự kiện vẫn SUCCEEDED). Ghi ở ADR-144 (bổ sung).
- R2-L3 (PayOS giả gửi UTC không múi giờ): thuộc tools/verify-sink (agent KN) — KHÔNG đụng.
- apps/shop/src = 444 dòng
