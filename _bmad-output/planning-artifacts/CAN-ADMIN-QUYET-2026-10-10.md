# Việc cần Admin quyết (ghi bởi các agent, 10–11/10)

## Từ agent auth (AU1–AU6, 11/10) — mặc định an toàn đã chọn, chuỗi KHÔNG dừng

| # | Việc | Mặc định agent đã chọn | Admin cần làm |
|---|---|---|---|
| A1 | **Deploy lên Render/Neon sau AU6**: hub-api/hub-worker THOÁT nếu `DATABASE_URL` là role superuser/BYPASSRLS (vd `neondb_owner`) | Đúng spec §5.12.2 — không nới | TRƯỚC lần deploy kế: tạo role `hub_app` trên Neon (DEPLOYMENT.md §9), đổi `DATABASE_URL` của Render sang `hub_app`, giữ `DIRECT_URL` = owner, chạy `prisma migrate deploy` |
| A2 | Mail thật (Resend) | Local `MAIL_DRIVER=log`, hubv `capture` | Cấp `RESEND_API_KEY` (+ xác minh domain nếu muốn gửi tới email khác email chủ Resend) |
| A3 | GitHub OAuth App | Chưa cấu hình → `/auth/github` trả 503 | Tạo OAuth App, callback `<WEB_PUBLIC_URL>/auth/github/callback`, đặt `GITHUB_OAUTH_CLIENT_ID/SECRET`; chạy TA11 tay |
| A4 | Đăng nhập console local sau khi stack dev build lại | `.env` local đã thêm `OPERATOR_EMAIL=admin@hub.local`, hash chép từ `ADMIN_PASSWORD_HASH` (mật khẩu cũ), 3 secret mới, `WEB_PUBLIC_URL`, `MAIL_DRIVER=log` | Đăng nhập bằng **admin@hub.local** + mật khẩu admin cũ |
| A5 | TA14 trình duyệt thật (Chrome + Firefox, F5 giữ đăng nhập, `document.cookie` không thấy `__Host-hub_*`) | Mồ côi có lý do trong verify:map | Phiên TEST làm tay |
| A6 | Web chưa có `/onboarding`, `/forgot-password`, `/reset-password`, `/invite`, trang Thành viên/Thiết bị | API đã đủ; DINH-CHINH-AUTH §3 giao phiên UI | Giao phiên UI |

## Từ agent sửa review AU (R-1..R-14, 11/10) — xem `auth/RESUME-auth-fixes.md`

| # | Việc | Mặc định an toàn đã chọn | Admin cần làm / quyết |
|---|---|---|---|
| A7 | **R-9 `api_keys` chưa bật RLS** (có `tenant_id`; `hub_app` không đặt biến vẫn đọc được). HOÃN: tra key theo hash là bước xác định tenant trên đường NÓNG `/v1/p/*` (mỗi publish) — bật RLS phải chuyển `findApiKeyByHash` sang batch `systemTx` + migration policy + đo lại p95 ingest (trần 15 %, hiện đã +7,6 %) | Liệt kê/thu hồi key vẫn lọc `tenant_id` ở `TenantScopedRepository` (BB-5 lớp 2); ngoại lệ đã ghi ở ADR-108 | Chọn: (a) bật RLS + batch + đo k6 ingest (≈ 2 giờ dev), hoặc (b) giữ ngoại lệ, ghi vào DINH-CHINH-2026-10-10 §2 |
| A8 | **Deploy: biến mới** `WEB_PROXY_SECRET` (≥ 32 ký tự, GIỐNG nhau ở Render hub-api và Vercel web, R-2/ADR-110); `WEB_PUBLIC_URL` giờ BẮT BUỘC ở production (thiếu → hub-api thoát, R-13/ADR-117) | Trống `WEB_PROXY_SECRET` = hành vi cũ (rate limit IP chung) | Đặt hai biến trước lần deploy kế (DEPLOYMENT §9) |
| A9 | **Migration dữ liệu trên Neon** (R-7/ADR-111) | Gate `data-migration-rls` đỏ nếu migration DML sau RLS thiếu `SET LOCAL app.rls_system = 'on'` | Không cần làm gì — chỉ biết luật |
| A10 | **R-6 đổi DX đăng ký** (ADR-120): đăng ký không còn đăng nhập ngay; phải bấm link trong mail (link đăng nhập luôn). Tài khoản mật khẩu chưa xác minh không đăng nhập được | Đúng §5.2 "không lộ email đã có" | Deployed cần mail thật (A2) — không có Resend thì người dùng mới KHÔNG vào được (trừ GitHub). Nếu muốn giữ "đăng ký là vào luôn" thì quay lại phương án 2 của review (chấp nhận dò qua register, 5 lần/giờ/IP) — báo để revert ADR-120 |
| A11 | **R-4 còn +16,8 %** thời gian xử lý của worker so với trước AU6 (đầu-cuối chỉ +1,4 %) sau khi batch 3 truy vấn nóng (ADR-119) | Batch mặc định; `RLS_HOT_BATCH=0` để đo lại | Chấp nhận, hoặc giao gộp thêm `tenantTx` ghi kết quả (đổi luồng lease) |

## Từ coordinator (review cuối + bước 6, 11/10 sáng)
- **A12 — DX đăng ký (gắn A10):** sau N-1 người dùng nhập mật khẩu 2 lần (lúc đăng ký và lúc bấm link). Reviewer đề xuất phương án nhẹ hơn, an toàn ngang: form đăng ký chỉ hỏi email + tên, link mail mở form đặt mật khẩu (dùng `claimAccount` sẵn có). Admin chọn thì giao dev (~1 story nhỏ).
- **A13 — stack dev còn subscription cũ "Demo Shop Outbound Webhook" (không ghim nguồn, đang bật):** mỗi khoản tiền gửi tới Shop 2 lần (Shop vẫn đúng nhờ kiểm `sourceId` + chống trùng). Nên tắt trong console. Tôi không tắt vì là cấu hình của Admin.
- **A14 — stack dev còn subscription "Báo Git commits lên Discord" ĐANG BẬT** (có từ trước, không phải agent bật). Vì vậy tôi KHÔNG chạy `e2e-smoke.sh` trên stack dev (script bắn GitHub push → sẽ gửi Discord thật); chỉ kiểm bằng SePay. Smoke đầy đủ đã chạy xanh trên hubv.
- **A15 — Thấp:** lúc `up -d`, hub-worker khởi động trước khi hub-api tạo xong quyền cho `hub_app` → ~3 giây log lỗi `permission denied for schema hub` rồi tự lành. Có thể thêm `depends_on: hub-api: condition: service_healthy` cho worker.
- **Sao lưu DB dev trước khi áp migration đa service + auth + RLS:** `pg_dumpall` ở scratchpad phiên (`dev-db-before-au-20261011-0706.sql`, 137KB). Cần giữ lâu thì chép ra chỗ khác.
- **`.env` local:** coordinator thêm `WEB_PROXY_SECRET` (ngẫu nhiên, chỉ local) để R-2 có hiệu lực trên stack dev. Không commit.
- **File tạm của reviewer:** `node_modules/.cache/review-sock.cjs` — xoá tay được.
