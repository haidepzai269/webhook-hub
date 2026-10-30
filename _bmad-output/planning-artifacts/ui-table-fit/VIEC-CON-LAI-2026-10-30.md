# Việc còn lại — sơ đồ Hành trình bấm được + bảng/popup không cuộn ngang (ADR-271)

Ngày 2026-10-30. Admin yêu cầu gác đo để đẩy code gấp. Nhánh: `fix/web-journey-click-table-fit`.
Dừng lúc agent dev đang làm giàu dữ liệu giả cho `apps/web/scripts/overflow-audit.mjs` (connection, inspect, traffic). Phần đó không có trên cây, không commit.

## Trạng thái kiểm chứng

| Việc | Trạng thái |
|---|---|
| Review độc lập lần 1 (đến `9a95999`) | ĐẠT CÓ ĐIỀU KIỆN, 7 mục phải sửa |
| Commit sau review (`4244272`..`06a6ec9`) | **CHƯA có review lại** |
| Lượt đo tổng kết sau bản sửa cuối | **CHƯA xong** |
| `tsc` web | Chỉ còn 2 lỗi trong `.next/types/validator.ts` (`.next` cũ, thiếu `/privacy`) |
| `responsive-table-logic.spec.ts` | Đạt, 9/9 |
| `mobile-card-specs.spec.ts` | Đỏ 5 ca trên Windows do CRLF. Review xác định không do nhánh này; chưa sửa |
| Chạy thật trên hub deployed, dữ liệu thật | **CHƯA** — mọi số đo đều dùng API giả |

## A. Phải làm tiếp

1. Review độc lập lại các commit `4244272`..`06a6ec9`, nhất là `.scroll-area` có giấu nội dung không, và dạng danh sách `journey-list.tsx` + `journey-view.tsx`.
2. Chạy hết `node apps/web/scripts/overflow-audit.mjs` (có `RESUME`) ở 360/768/1024/1280/1440/1920. Mọi phần tử chứa nút, link, input bị cắt là LỖI. Một dev server, một trình duyệt, đo tuần tự: máy đã sập hai lần khi chạy agent.
3. Chạy `node apps/web/scripts/journey-click-test.mjs`, gồm ca bấm đôi "Phát lại" chỉ tạo 1 POST.
4. Kiểm backend có chống phát lại trùng không; hiện mới chặn ở giao diện.
5. Xác nhận thủ công trên production sau khi deploy:
   - Sự kiện DEAD: bấm "Phát lại", "Mở hàng đợi lỗi", chip lần thử.
   - Trang Nguồn ở 1280 và 1920: không cuộn ngang, cột hành động hiện đủ.
   - Nút "Cột" bật lại được cột tự ẩn.
6. Đo việc đổi trang, sắp xếp, lọc có đặt lại cột tự ẩn đúng không. Code đã truyền các tín hiệu này (`data-table.tsx:114`), chưa đo trên trình duyệt.
7. Mở bằng tay các popup audit chưa chắc đã đo: các bước sau của "Kết nối nhà cung cấp", sửa endpoint, Dọn dung lượng.

## B. Nợ riêng, không chặn PR

- Sửa regex `mobile-card-specs.spec.ts` chịu được CRLF.
- Lỗi hydration ở mọi trang khi chạy audit bằng dữ liệu giả: nghi do mốc thời gian tương đối, chưa chứng minh.
- Admin xác nhận thứ tự ưu tiên ẩn cột; hiện ẩn từ phải sang trái, giữ cột đầu và cột thao tác.
- Bảng chưa có chế độ thẻ dưới `md`: Khoá API, Cảnh báo, Sự kiện (có thể xuống dòng nhiều ở 360).

## C. Việc còn lại sau khi chuyển tài khoản Render (Admin làm trên dịch vụ ngoài)

Phòng không xem được các dịch vụ này, nên mục nào đã làm thì Admin gạch.

- [ ] cron-job.org ping `https://hub-api-x22a.onrender.com/health`, lịch `*/5 7-22 * * *`, múi giờ `Asia/Ho_Chi_Minh`.
- [ ] Đối soát khoản PayOS chuyển lúc hub tắt hoặc URL sai; xem log shop `payment.received từ source KHÔNG tin cậy`.
- [ ] Lưu trữ đích shop cũ trong project thật; tắt đăng ký của shop ở Default.
- [ ] `SHOP_WEB_URL` trên shop mới là `https://webhook-hub-rouge.vercel.app/shop`.
- [ ] `HUB_URL` env của shop khớp project `hai-nguyen-hoang`.
- [ ] Health Check Path của hub là `/health/live`.
- [ ] Đối chiếu env có thể thiếu: `SENTRY_DSN`, `HEARTBEAT_URL`, `TELEGRAM_*`, `DISCORD_WEBHOOK_URL`, `HUB_DOCS_URL`.
- [ ] GitHub "Github test 1": đổi URL ở repo, Redeliver lượt lỗi. SePay: đổi URL nếu có dùng.
- [ ] OAuth GitHub/Google và `WEB_PUBLIC_URL`, `CORS_ORIGINS` đúng domain `webhook-hub-rouge`.
- [ ] Tài khoản Render cũ: gỡ GitHub App nếu không còn dùng, API key, deploy hook, thẻ thanh toán.
- [ ] Worker `hub-hooks-spike` trên Cloudflare: xoá nếu còn deploy.
- [ ] Ảnh chụp trong phiên chat đã lộ `SHOP_SETTINGS_KEY` và `HUB_SIGNING_SECRET`: xoay nếu ảnh đã rời máy hoặc tài khoản cũ từng bị người khác truy cập.
- [ ] Repo chưa có workflow reconcile: đơn quá hạn trên deployed không tự chuyển hết hạn (lỗ hổng có từ trước).
- [ ] Sửa tài liệu còn URL cũ: `docs/DEPLOYMENT.md:542`, `spikes/catchnet-spike/wrangler.toml:20`, domain Vercel trong `HUONG-DAN-DEPLOY.md`.
