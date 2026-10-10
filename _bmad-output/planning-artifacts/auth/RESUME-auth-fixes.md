# RESUME — sửa theo REVIEW-AUTH-2026-10-11

Luật: RED→GREEN→GATED→PROBED, mỗi mục một commit có `Verify:`, `npm run verify` exit 0 trước commit. KHÔNG stage SPEC-event-flow-ui.md, DINH-CHINH-2026-10-10.md.

| Mục | Trạng thái | Commit | Ghi chú |
|---|---|---|---|
| R-1 | xong | 275abbd | ADR-109; RED: 18 song song → 18×401 (unit), review: 17×401 |
| R-2 | xong | d237654 | |
| R-7 | xong | c05299f | gate data-migration-rls, ADR-111 | |
| R-3 | xong | e43a60d | ADR-112 | |
| R-4 | xong | 4609265 | ADR-119: A +33% -> B +16,8% handle; e2e +1,4% | |
| R-5 | xong | 81f6e2f | ADR-115 | |
| R-6 | xong | 3714d44 | ADR-120 + DINH-CHINH-AUTH §9 | |
| R-8 | xong | 3dbb7cd | ADR-113 | |
| R-10 | xong | 1eb26a2 | ADR-114 |
| R-12 | xong | 8c61554 | ADR-116 |
| R-13 | xong | e8a6594 | ADR-117 |
| R-14 | xong | 4244c64 | ADR-118 |
| R-11 | xong | baadc21 | script demo |
| R-9 | hoãn | — | CAN-ADMIN-QUYET A7 (đường nóng /v1/p + migration + đo lại p95) | |

## Bước kế

XONG (11/10). Kiểm cuối trên hubv: verify L0 611/0/0 · L1 136/0/0 · map 227 mã 0 ma 0 trùng · gates 14 luật 0 vi phạm · e2e auth 16/16 · e2e-smoke OK · demo-multi-project exit 0. Việc của Admin: CAN-ADMIN-QUYET A7–A11.
- R-1 PROBED live (hubv, image mới): 18 login sai song song → 5×401 + 13×429.
- R-2: web hubv chạy bằng `--profile web` (cổng 13000). e2e `[AR:R-2] (phần c)` RED trên api cũ (Y bị 429), GREEN sau rebuild.
- Mã test cho review: namespace `AR` (verify/spec-sources.json + TAG_RE trong verify/lib/map.ts), test unit ở apps/hub-api/test/auth-review.spec.ts.
- Smoke hubv: `HUB_URL=http://localhost:14000 PG_CONTAINER=hubv-postgres-1 bash scripts/e2e-smoke.sh` sau khi `set -a; . ./.env.verify` (PG_CONTAINER mặc định là stack DEV).
- R-4 đo: harness tạm ở scratchpad (measure.sh); cách đo chính thức trong k6/README.md "Đường giao". Số: ADR-119.
- R-6 (đã xong): chọn phương án 1 + chặn login khi chưa xác minh (không thì register+login vẫn dò được) + link xác minh
  đăng nhập luôn + đăng ký lại email chưa xác minh = gửi lại link. Sửa: auth.service register/login/verifyEmail,
  controller, web register-form + verify-email, e2e registered() (đi qua mail), TA1/TA2/TA3, L1 auth-session/auth-mail.
- R-9: hoãn → CAN-ADMIN-QUYET (đường nóng /v1/p + migration; ghi lý do).

## Vòng 2 (REVIEW-AUTH "Vòng 2": N-1..N-4)

| Mục | Trạng thái | Commit | Ghi chú |
|---|---|---|---|
| N-1 | xong | 752d4bd | ADR-121: verify-email buộc đặt mật khẩu cho tài khoản mật khẩu chưa xác minh + claimAccount |
| N-2 | xong | 25d3505 | ADR-122 | |
| N-3 | xong | (commit N-3+N-4) | ADR-123 | |
| N-4 | xong | (commit N-3+N-4) | ADR-123; local vẫn tự chọn IP được (ghi rõ), kiểm Vercel thật theo DEPLOYMENT | |
