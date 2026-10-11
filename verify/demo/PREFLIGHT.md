# PREFLIGHT — trước giờ bảo vệ

> Nguồn: SPEC-verification §9.3 (VF8). Kịch bản: `verify/demo/steps.yaml` · lệnh: `docs/RUNBOOK.md`.
> Đánh dấu từng ô vào bản in. Bước deployed do **Admin** chạy (phiên dev không gọi hạ tầng thật).

## T-1 ngày

- [ ] `npm run verify:all` xanh trên ĐÚNG commit sẽ demo (ghi hash: ________)
- [ ] `npm run verify:bb` → bảng 5 bất biến xanh/đỏ đúng — dán vào chương Kiểm thử
- [ ] `npm run demo:rehearse` ≤ 11 phút, không bước ❌ (`verify/results/rehearsal-<ngày>.md`)
- [ ] Quay **video dự phòng** đủ 14 bước
- [ ] Số dư PayOS đủ cho vài lần 2.000đ · domain gửi mail (Resend) · OAuth callback (Google) đúng URL deployed
- [ ] Source PayOS của project `demo` đã tạo TRÊN WEB như user thường, URL hub đã dán vào trang PayOS và PayOS đã xác nhận (cạm bẫy 4)
- [ ] Tài khoản viewer chỉ đọc của project `demo` đăng nhập được (cho giáo khảo, `docs/FOR-EXAMINERS.md`)

## T-60'

- [ ] `npm run demo:reset -- --env local` (hubv sạch + dữ liệu nền; in tài khoản console)
- [ ] Dữ liệu deployed của project `demo`: `demo:reset --env deployed` **chưa có** (CAN-ADMIN-QUYET-VF Q4) — dọn tay trên console nếu cần
- [ ] Docker Desktop ≥ 6 GB RAM · `VERIFY_WITH_METRICS=1` nếu chiếu Grafana (bước 5)
- [ ] Tắt thông báo hệ điều hành, chế độ không làm phiền

## T-10'

- [ ] `DEMO_WARM_URLS="https://<hub-api>/health,https://<shop>/health,https://<web>/" npm run demo:warm` (Render free ngủ sau 15 phút, lần gọi đầu ~1 phút)
- [ ] Mở sẵn tab: dashboard deployed · RabbitMQ UI hubv (`localhost:25672`) · Grafana · psql · hai cửa sổ ẩn danh (cafe/bookstore)
- [ ] Cỡ chữ terminal ≥ 18

## Sự cố

| Sự cố | Làm gì |
|---|---|
| Deployed chết | Chuyển hồi 1 và 3 sang `hubv` local, **nói rõ** là local |
| PayOS chậm | `npm run hub-sim -- send payos/paid-69000 --to <url> --secret <checksum PayOS THẬT của source demo>` — **bắt buộc `--secret`** khi gửi vào deployed (mặc định hub-sim ký bằng secret GIẢ của `.env.verify` → hub deployed trả 401); lấy secret từ trình quản lý mật khẩu, KHÔNG gõ trên màn hình đang chiếu. Không có secret thì phát vào hubv local. **Nói rõ** là phát lại (fixture `real` nếu có: "bytes này PayOS đã gửi hôm trước") |
| Mọi thứ chết | Chiếu video |
