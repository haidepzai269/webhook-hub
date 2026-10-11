# RESUME — DX phương án A (dev agent)

> Spec: `SPEC-dev-experience.md` (bản cắt gọn phương án A). Thứ tự: DX3 → DX3b → DX1-lite (sau commit C-1) → DX2 rút gọn → docs.
> Agent khác song song sửa `service-resources.controller.ts` + `tenant-scoped.repository.ts` (C-1) — KHÔNG sửa 2 file đó trước khi C-1 commit.

## Nhật ký
- 2026-10-11 bắt đầu. Đọc spec, CLAUDE.md, polling (ADR-095/099: cursor = poll_seq, không còn cửa sổ lắng).
- DX3 xong: `toWebhookBody` (libs/common/src/webhook-body.ts) dùng bởi WebhookSender + CLI; `libs/hub-sdk/src/cli.ts` + `bin/hub.js`; `after=latest` (repo.latestPollCursor) + 400 invalid_cursor. Test UX9–UX15 xanh (UX11 cả DB thật hubv). ADR-133 (ADR-132 là VF3 của agent kia).
  - Chạy test DB một file: `node <scratchpad>/dbjest.js <file>` (env giống verify:db).
  - Sửa kèm: polling-params.spec có regex `/\bseq\b/` bị lưu thành ký tự backspace (test luôn xanh) -> sửa lại.
