# Bàn giao 2026-10-15 (tối, máy nhà) → máy công ty

> **Admin chốt 2026-10-16:** tới **thứ Hai (2026-10-19)** mới dùng máy công ty. Mọi việc trong các file `*-VIEC-MAY-CONG-TY.md` (chaos T16, workerd LH2) **tạm gác** tới lúc đó. Máy nhà vẫn làm các việc nhẹ, ví dụ LH2b.
>
> Bản trước: `BAN-GIAO-2026-10-15.md` (chiều, máy công ty). Luật mới của Admin: việc máy nhà không chạy nổi thì dừng lại, commit, ghi vào file `*-VIEC-MAY-CONG-TY.md` để máy công ty chạy tiếp.

## 1. Hai nhánh đã push, CHƯA gộp master

| Nhánh | HEAD | Review | CI | Còn lại ở máy công ty |
|---|---|---|---|---|
| `feat/bp-f3` | `4f8f388` | REVIEW-F3 lượt 2 **ĐẠT**, đủ điều kiện | run `38753284031` xanh 4/4; db L1 275/275, 0 skip; Lua thật đã chạy | Chaos `npm run verify:chaos -- --tag bp-t16`. Xem `_bmad-output/planning-artifacts/backpressure/F3-VIEC-MAY-CONG-TY.md` |
| `feat/lh` | `d49e25b` | REVIEW-LH2 lượt 3 **ĐẠT** (0 Nặng / 0 TB) | run `38750252313` xanh 5/5, có job mới `catchnet` | Chạy workerd thật: CPU/bộ nhớ một lượt cron, `meta.changes`, `%2e%2e`, thử `RETURNING`, byte UTF-8. Xem `_bmad-output/planning-artifacts/hub-sap/LH2-VIEC-MAY-CONG-TY.md` |

- **F3** (ADR-234, đính chính ADR-232):
  - Trong cùng EVAL `LUA_GATE`: ở bậc cuối mà bị chặn thì gia hạn `:ramp` thành max(2×step, 10s+step), không bao giờ rút ngắn.
  - Trần `RAMP_MAX` mặc định = min(180, 3×(ramp+step)), env chỉ kẹp xuống.
  - Kẹp số lần nhân đôi ≤ 5. `START_RPS` chỉ kẹp xuống, mức 2, nên trần cuối ≤ 64.
  - `TOTAL_RETRY_WINDOW_MS` = 27.250.000 ms (≈ 7h34m10s). Lệnh dọn với `olderThan` < khoảng 7h35m sẽ trả 400.
  - Chaos T16 ĐẠT thì gộp master (cần Admin nói "gộp").
- **LH2** (ADR-214–216, 222–224): Worker `apps/catchnet` (ngoài workspaces) + D1.
  - Ghi xuyên timeout 4s. Hứng chỉ khi key đã sync. Có trần byte (body + header + target), trần dòng và trần ngày.
  - Cron giữ chỗ cả lô, mỗi lượt 10 dòng / 44 truy vấn.
  - Phát lại: 408/429/507 thì retry.
  - `safeHookTarget` chặn path traversal. nginx dùng `geo` cho dải IP Cloudflare (R2-L1).
  - **Chưa tick LH2** ở §15b: chờ số đo workerd từ máy công ty.

## 2. CỔNG: không deploy Worker trước LH2b

- Không `wrangler deploy hub-hooks`, không trỏ source nào sang `workers.dev`, không đặt `HUB_INGEST_PUBLIC_URL` cho tới khi **LH2b** ĐẠT.
- **LH2b** (Admin chốt: làm ngày mai): hub đẩy `sources_sync` sang Worker. Cụ thể là `PUT /_admin/sources/:key` khi source được tạo/sửa/lưu trữ, resync lúc khởi động và mỗi 10 phút, ack lấy từ `buildAck`.
- Gộp cùng LH2b:
  - **R2:** số liệu theo từng key trong `/_admin/stats`, lệnh admin xoá hàng chết của một key (gỡ khoá).
  - **R1:** `moveDead` trong `runReplay` bọc try/catch từng dòng.
  - **R3:** ghi vào file việc máy công ty.
- Sau LH2b mới tới LH0 → LH6 → LH5 → LH1 → LH4 → LH7.

## 3. Gitleaks: job `secrets` quét MỌI nhánh

- Secret giả trong vitest catchnet (`lh2-test-*-0123456789abcdef`) đã được allowlist trên `feat/lh` (`d49e25b`) và `feat/bp-f3` (`4aa3710`).
- **Master chưa có allowlist này.** Từ giờ tới lúc gộp `feat/lh`, CI `secrets` của master sẽ đỏ, trừ khi push riêng commit allowlist lên master (đã hỏi Admin).
- Kiểm toàn lịch sử bằng đúng image mà CI ghim: `zricethezav/gitleaks:v8.18.4 detect --source /repo --log-opts="--remotes=origin"`. Image `latest` có luật mới, báo 10 mục giả trong tài liệu cũ (ví dụ `curl -u`).

## 4. Nợ mới

- Test chập chờn `auth-mail-db.spec`: lần này đỏ ở **dòng 203** ("gửi lại xác minh… 429"), chạy lại thì xanh. Cần sửa cách chờ mail hoặc token.
- **F3, mức Thấp:**
  - `.env.example:170-174` chưa có `DELIVERY_RAMP_MAX_SECONDS`, vẫn ghi "cửa sổ retry tính theo 60".
  - L2-1: ca L1 phần d chỉ chịu được khoảng 200ms thời gian thật trôi; CI chậm có thể đỏ giả.
  - L2-4: lệch đồng hồ giữa các worker chưa tính vào cửa sổ retry.
- **LH2:**
  - N2: chọn và lease vẫn là 2 câu SQL.
  - `catchnet_overflow` mới chỉ là log, chưa thành metric.
  - ADR-220 ghi khi bật Worker.
  - Migration `0001` sửa tại chỗ được, nhưng sau lần `--remote` đầu tiên thì không được sửa nữa.
- Nợ cũ giữ nguyên, xem `BAN-GIAO-2026-10-15.md` §4–§6.

## 5. Worktree ở máy nhà

| Worktree | Nhánh |
|---|---|
| `C:\wt\lh` | `feat/lh` (làm tiếp LH2b) |
| `C:\wt\ui` | `feat/bp-f3`, worktree UI cũ dùng lại |
| `C:\wt\pk` | `feat/pk` (chờ PK6–PK8) |
