# RESUME — Event Flow UI

- Worktree: `C:\webhook-hub\.claude\worktrees\agent-a2f27e5a7dec66849` · nhánh `feat/event-flow-ui` (chưa push/merge)
- Commit: F1 `58bb232` · F2 `80a8bba` · F4/F5 API `22f8d25` · F3 V1 `383df2e` · F4/F5 UI `beaef11` · style `e1d8694` (vòng chỉnh hình thức theo ảnh mẫu, 8 ảnh chụp lại). Worktree sạch.
- XONG F1–F5. Ảnh: `screens/` (8 ảnh). ADR nháp: `ADR-DRAFT.md`. §10 spec đã điền.
- CHƯA: F6 (kéo cạnh mở form), F7 (rebase sau đa service). Tiến trình 3100/4100 đã tắt; subscription demo đã TẮT.

## Lệnh khi cần chạy lại
```bash
bash C:/Users/admin/AppData/Local/Temp/claude/C--webhook-hub/147523fc-aa93-45df-ab48-e857f1846f73/scratchpad/api4100.sh   # hub-api :4100
cd apps/web && NEXT_PUBLIC_HUB_API_URL=http://localhost:4100 npx next dev -p 3100
node apps/web/scripts/flow-screens.mjs <outDir> <okEventId> <failEventId>   # Chrome hệ thống
RUN_DB_TESTS=1 DATABASE_URL=postgresql://hub_user:hub_password@localhost:5433/webhook_hub?schema=hub npx jest -w 2 apps/hub-api/test/flow-db
```
- Dữ liệu demo DB dev: destination `Discord (mock lỗi 500)` 1761d340-… + subscription 90318c7d-… (đang tắt).

- **F7 xong** (2026-10-10 tối): nhánh rebase lên master b5d0f91, commit `1a43972`. L0 550 · L1 91 (hubv) · map 0 ma/0 trùng · next build sạch. Ảnh chụp lại trên hubv + `*-cafe-*` (project cafe, event origin=api). Chạy lại: `scratchpad/api4100-hubv.sh` (CORS_ORIGINS=http://localhost:3100), `ADMIN_PASSWORD=VERIFY_ONLY_admin_password node apps/web/scripts/flow-screens.mjs …`. Trên hubv còn: đích `Discord (mock lỗi 500)` + subscription demo (đã tắt), key `flow-ui-demo` (project cafe).
