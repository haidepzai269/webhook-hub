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
- Q1 = (a) (Admin 11/10): `rejectAck` trong ingest.service — 401/422 ở /hooks qua `adapter.buildAck`, status lõi giữ. ADR-139
  (137/138 là phiên khác). RED trước (`ingest-reject-ack.spec.ts` 5 fail), xanh sau; L0 đầy đủ 101 suite / 750 test pass;
  redis-budget xanh; `verify/test/hub-sim-adapters.spec.ts` xanh (fixture hub-sim chỉ kỳ vọng status — không vỡ, không cần VF sửa).
- Live (Admin 11/10): df 16 GB trống ≥ 8 → `docker compose -p webhook-hub build hub-api hub-worker shop web` + `up -d` (KHÔNG đụng hubv,
  không down -v, không xoá image/volume). Compose chạy hub-api bằng `hub_app` → không gặp lỗi AU6 (lỗi đó chỉ khi chạy từ source
  với `.env` dev, vốn dùng `hub_user` superuser). TX1/TX3 (`--from latest`)/TX4 PASS — ghi ở SPEC §9.
- hub-sim trên stack dev sau Q1: `payos/bad-sig` → 401 `{"code":"01",…}` ✓, `sepay/auth-no-prefix` → 401 `{"success":false,…}` ✓;
  `github/ping` → 401 (mong 200) vì secret GitHub của stack dev ≠ secret giả `.env.verify` — KHÔNG phải hồi quy, status/body GitHub
  giữ `{error}`. Stripe/Generic không có source ở stack dev → chỉ kiểm bằng unit (`ingest-reject-ack.spec.ts`). Fixture hub-sim chỉ
  kỳ vọng status nên không cần VF sửa.
- Review DX-A: M-1 + L-5 (ADR-143), M-2 (QUICKSTART + ARCHITECTURE §18), L-3 (`HUB_DOCS_URL` gợi ý ở .env.example + HUONG-DAN-DEPLOY).
  SỰ CỐ index dùng chung: mình đã stage (update-index) file của M-1 vào `.git/index` thì agent KN1 commit `c888ef6` → commit đó
  chứa luôn thay đổi M-1/L-5 + ADR-143 của mình, và các file controller/catalog/ADR trong `c888ef6` là bản HEAD+mình (THIẾU hunk
  KN1: mã `use_endpoints_route`/`endpoint_owned_by_service`… trong catalog, refactor controller, ADR-142 — vẫn nằm ở working tree
  của họ). Commit `80a98bd` của mình vì thế RỖNG (cùng tree). Từ đây mình chỉ commit qua GIT_INDEX_FILE riêng + commit-tree.
- Review vòng 2 (GO-with-fixes): R2-M1 (lô poll_seq commit riêng — `ORCHESTRATED_METHODS`, test DB hub_app RED [5,5,5] → xanh [5,3,1]),
  R2-L1 (parseRetryAfter: số giây / HTTP-date / body; kẹp 1–30 s), R2-L2 (`--from latest` bỏ cuộc sau 10 lần + fix). ADR-145.
  R2-L3 KHÔNG làm: 413 xảy ra trước khi nạp adapter (`ingest.service.ts` ~dòng 244), đưa qua `rejectAck` = đổi thứ tự đường
  nóng; nhánh 413/404/429 của `genericAckFix` để dành nếu sau này làm. R2-L4: không viết lại lịch sử.
  Commit theo luật mới: `git commit -m … -- <paths>`. File lẫn hunk của agent khác (tenant-scoped.repository.ts, ARCHITECTURE.md):
  tạm ghi bản HEAD+mình vào working tree, commit theo path, rồi trả lại bản đầy đủ (kiểm mtime trước khi trả).
