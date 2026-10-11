# Dành cho hội đồng — xem gì, ở đâu

> Không cần cài gì để xem. Ô `‹…›` do Admin điền trước buổi bảo vệ (phiên dev không biết/không đăng URL thật).

| | |
|---|---|
| Web (bản deployed) | ‹URL web Vercel› |
| Tài khoản chỉ đọc (viewer, project `demo`) | ‹email viewer› / ‹mật khẩu› — xem được dashboard, sự kiện, delivery; không sửa/xoá được (thử xoá endpoint → 403) |
| Thanh toán thử 2.000đ | Admin tự chuyển khoản trong buổi bảo vệ (Q-V1) — ‹ảnh QR nếu muốn tự thử› |
| Video dự phòng (14 bước) | ‹link video› |

## Bằng chứng tự động

- **Bản đồ test**: [`docs/TEST-MAP.md`](TEST-MAP.md) — mỗi mã yêu cầu của spec → file:dòng của test chứng minh nó, trạng thái lần chạy cuối.
- **Năm bất biến** (`npm run verify:bb`): mỗi bất biến có test xanh trên code thật VÀ một "probe" (đột biến có chủ đích trong git worktree tạm) làm test đó đỏ. Một probe chỉ được tính ✅ khi: (1) lượt **đối chứng** trên worktree CHƯA phá chạy cùng test đó và test XANH (kèm kiểm mọi `@hub/*` phân giải vào chính worktree), (2) sau khi phá, test ĐỎ **đúng lý do** — thông điệp lỗi khớp mẫu `expectFailure` khai trong probe (vd assert tiền đề RLS, `toBeGreaterThanOrEqual(500)`), lỗi môi trường (mất kết nối DB, không tìm thấy module, timeout) không bao giờ được tính. Đối chứng không xanh thì probe là **INVALID**, không phải ✅.

| Bất biến | Nói gì | Test | Probe làm đỏ |
|---|---|---|---|
| BB-1 | Hub không biết "đơn hàng" | `[BB:1]` grep gác cổng | P-BB1-01 thêm `orderCode` vào worker |
| BB-2 | Postgres là trọng tài chống trùng; Redis được phép sai | `[BB:2]` L0 + chaos (Redis tắt / FLUSHALL → vẫn 1 sự kiện) | P-BB2-01 nuốt lỗi trùng rồi ghi bản thứ hai |
| BB-3 | Không trả 2xx trước COMMIT | `[BB:3]` L0 + chaos (kill -9 api/worker, pause Postgres → 0 mất, 0 trùng) | P-BB3-01 COMMIT lỗi vẫn ACK · P-BB3-02 ack trước khi ghi |
| BB-4 | api và worker là hai tiến trình | `[BB:4]` compose + không import chéo; chaos kill riêng từng bên | — (hình dạng hệ thống) |
| BB-5 | Mọi truy vấn theo project | `[BB:5]` RLS bằng role `hub_app` | P-BB5-02 bỏ `set_config` → 0 dòng · P-BB5-01 repo quên lọc → RLS vẫn chặn |

## Ai có Docker

```bash
npm ci && npm run verify:up && npm run verify
```

Chi tiết: [`docs/RUNBOOK.md`](RUNBOOK.md).
