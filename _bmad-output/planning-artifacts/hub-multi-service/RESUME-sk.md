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
