# RESUME — SPEC-shop-ket-noi-project (cách B), phiên DEV

> Log để tiếp tục nếu phiên đứt. Mới nhất ở dưới.

## Kế hoạch
SK1 (console Project + API key) → SK2 (shop.settings + /settings*) → SK3 (web /shop/settings) → SK4 (M-1/M-2/L-1/L-2 + docs + ADR).

## Nhật ký
- [x] Commit 0: tiền tố `SK:` (SPEC-verification §3.1, verify/spec-sources.json), checklist §9 trong spec.
- [x] SK1: `apps/web` trang `/dashboard/projects` (danh sách, tạo, chọn) + `/dashboard/api-keys` (tạo key, hộp "Chỉ hiện một lần" `HUB_URL=…`, thu hồi); sidebar nhóm "Project". Không thêm route hub. Test: `keys-logic.spec.ts` [SK:U6] (L0), `console-projects-db.spec.ts` [SK:U6] (L1 hubv: ApiKeyGuard nhận key mới, thu hồi -> 401).
  - Chạy L1 riêng file: scratchpad `l1.ts` (env như verify:db, không in secret).
- [x] SK1 bổ sung (Admin làm rõ): project tự tạo lúc đăng ký được chọn sẵn; "Tạo project" là nút phụ; demo không có bước tạo project. Test thêm trong keys-logic.spec.
- [x] SK2: `apps/shop/src/settings.ts` (resolveSettings/publicView/parseInput/ShopSettings/HubLink/testHub/adminGate/settingsRouter), `HubRegistration.reset()` + thế hệ, main đọc `settings.get()`, migration `20261012020000_shop_settings` (đã `migrate deploy` lên hubv — local), Prisma model `ShopSetting`, SDK `sources.list()`. ADR-155 (thiết kế), ADR-156 (trần 600). Gate shop-size 600. Test: settings.spec.ts [SK:U1..U5] (L0), settings-db.spec.ts [SK:U4] + GRANT shop_user (L1 hubv).
- [x] SK3: web `/shop/settings` (`SettingsForm.tsx`, `lib/shop/settings.ts`, `settings-logic.ts` + spec). Nguồn tin cậy chỉ gửi khi vừa Kiểm tra; ô bí mật xoá sau khi lưu. Build OK (`/shop/settings` tĩnh).
- [x] Sửa "stale project" (coordinator, production): lựa chọn project theo user `hub:projectId:<userId>`, xoá khi `logout()`, mặc định project là thành viên (`member` từ `GET /api/v1/projects`), badge "đang xem với quyền operator". Test `project-store.spec.ts` + L1 console-projects-db.
- [x] SK4: M-1 (`canTopUp`), M-2 (sessionStorage `shop:order`, `?order=`, hỏi trạng thái một lần), QR đơn cũ (khung Đơn + Tạo đơn mới, giỏ đổi -> đơn mới), L-1 (tên test m7), L-2 (log theo outcome); ADR-157 (khoá PayOS hai chỗ), ADR-158 (checkout) + đính chính ADR-154; HUONG-DAN-DEPLOY §8 env mới; HUONG-DAN-TEST-TINH-HUONG Kịch bản 10; `TAG_RE` của verify:map thêm `SK`; `SK:T1` vào acceptedOrphans. Các fix production khác của coordinator: commit riêng (stale project a81dc08, nút 🔗 af2a927, autofill ffda791).
- [x] REVIEW-SK fix (ADR-160): H-1 kiểm trước, lưu sau (`prepare` + `reconnect(env, commit)`, FAILED -> 422, không ghi DB, link cũ giữ nguyên) + L-6 `HubLink.lock`; M-1 `skip: 'UNTRUSTED'` + warn + runbook (HUONG-DAN-DEPLOY §8, Kịch bản 10); M-2 token ≥ 24, allowlist host (`SHOP_ALLOWED_HUB_HOSTS`), `HubLink` không ensure tới host lạ; M-3 một bản chụp, `degraded` + `reload()` 60s khi DB lỗi (L-1 test). Web: `saveHeadline`, 422 có `registration` hiện như kết quả. Trần 600/600 (gọn hub-registration, bỏ dòng trống trong thân hàm). L1 `settings-db.spec` 3/3 trên hubv.
