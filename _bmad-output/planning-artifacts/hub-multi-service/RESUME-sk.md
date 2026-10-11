# RESUME — SPEC-shop-ket-noi-project (cách B), phiên DEV

> Log để tiếp tục nếu phiên đứt. Mới nhất ở dưới.

## Kế hoạch
SK1 (console Project + API key) → SK2 (shop.settings + /settings*) → SK3 (web /shop/settings) → SK4 (M-1/M-2/L-1/L-2 + docs + ADR).

## Nhật ký
- [x] Commit 0: tiền tố `SK:` (SPEC-verification §3.1, verify/spec-sources.json), checklist §9 trong spec.
- [x] SK1: `apps/web` trang `/dashboard/projects` (danh sách, tạo, chọn) + `/dashboard/api-keys` (tạo key, hộp "Chỉ hiện một lần" `HUB_URL=…`, thu hồi); sidebar nhóm "Project". Không thêm route hub. Test: `keys-logic.spec.ts` [SK:U6] (L0), `console-projects-db.spec.ts` [SK:U6] (L1 hubv: ApiKeyGuard nhận key mới, thu hồi -> 401).
  - Chạy L1 riêng file: scratchpad `l1.ts` (env như verify:db, không in secret).
