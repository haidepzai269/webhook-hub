# RESUME — DX phương án A (dev agent)

> Spec: `SPEC-dev-experience.md` (bản cắt gọn phương án A). Thứ tự: DX3 → DX3b → DX1-lite (sau commit C-1) → DX2 rút gọn → docs.
> Agent khác song song sửa `service-resources.controller.ts` + `tenant-scoped.repository.ts` (C-1) — KHÔNG sửa 2 file đó trước khi C-1 commit.

## Nhật ký
- 2026-10-11 bắt đầu. Đọc spec, CLAUDE.md, polling (ADR-095/099: cursor = poll_seq, không còn cửa sổ lắng).
- DX3 xong: `toWebhookBody` (libs/common/src/webhook-body.ts) dùng bởi WebhookSender + CLI; `libs/hub-sdk/src/cli.ts` + `bin/hub.js`; `after=latest` (repo.latestPollCursor) + 400 invalid_cursor. Test UX9–UX15 xanh (UX11 cả DB thật hubv). ADR-133 (ADR-132 là VF3 của agent kia).
  - Chạy test DB một file: `node <scratchpad>/dbjest.js <file>` (env giống verify:db).
  - Sửa kèm: polling-params.spec có regex `/\bseq\b/` bị lưu thành ký tự backspace (test luôn xanh) -> sửa lại.
- DX3b xong: `hub trigger` + `libs/common/src/canonical/samples.ts`; UX16 xanh. ADR-134.
- Đo `hub listen` LOCAL (stack dev localhost:4000, image API cũ — dùng `--from <cursor>`), SePay mock cafe → app local, N=10:
  p50 619 ms · p95 1699 ms · max 1699 ms · 10/10 nhận, 0 chữ ký sai; khởi động CLI 0,9 s (ts-node). Key tạm `dx-latency-measure` đã revoke.
  Script: scratchpad `measure-listen.js` (không in key).
- DX1-lite xong (sau commit C-1 72ee8a7): catalog `libs/common/src/errors/catalog.ts` (mọi mã đang ném + mã suy từ status),
  `apps/hub-api/src/modules/errors/*` (filter + x-request-id + hubError + install), `verificationFix`, Generic buildAck `fix`,
  web `errorMessageOf` (detail → câu Việt theo mã → message), SDK HubError kèm fix/requestId, `docs/ERRORS.md`, U22 sửa chữ.
  Test UX1–UX6 xanh. ADR-136 (ADR-135 là VF4). Câu hỏi Admin: CAN-ADMIN-QUYET-DX.md Q1 (fix Generic 401/422 qua lõi ingest).
- DX2 rút gọn xong: `examples/quickstart-node/index.js` (34 dòng, node:http + SDK) + `package.json` (`@hub/sdk: file:../../libs/hub-sdk`
  → `npx hub` có bin link trong thư mục app mẫu) + `docs/QUICKSTART.md` (5 bước, hub:// local, ghi chú hubs:// deployed).
  Kiểm thật LOCAL (stack dev, image API cũ, `--from <cursor>`): app mẫu in `payment.received 50000 evt_…` sau ~1,05 s;
  đổi secret app → listen in `→ 401 … invalid signature`; không lộ key. KHÔNG build lại image (ổ C còn 16 GB/97%) —
  `after=latest` chỉ kiểm bằng unit + DB thật (UX11). Chạy hub-api từ source không được: `.env` dev dùng role superuser (AU6 chặn).
- Docs xong: ARCHITECTURE §18 "Trải nghiệm dev", CLAUDE.md Trạng thái, SPEC-dev-experience §8 (checklist + 10 lệch) + §9 TX3 (một phần).
  Toàn bộ L0 `npx jest -w 2`: 98 suite pass, 736 test pass, 0 fail (DB suite skip ở L0; UX11 DB chạy riêng: xanh).
