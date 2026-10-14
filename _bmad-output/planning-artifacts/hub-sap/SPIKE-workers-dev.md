# SPIKE LH-S — Worker nháp `hub-hooks-spike` trên `workers.dev`

> Story LH-S, SPEC-hub-sap §7b (cổng cho LH2/LH3). Mã: `spikes/catchnet-spike/` (ngoài npm workspaces, H10).
> **Cổng:** S1, S3, S5 (và S2 với Admin) đạt → được code LH2/LH3. S4/S6/S7 trượt → ghi §16, chưa chặn.
> File này **không chứa secret** (token, `whsec_`, `sk_test_` chỉ ở `.dev.vars` / `KEYS-CAN-LAY.md` mục J).

URL nháp: `https://hub-hooks-spike.<subdomain>.workers.dev/hooks/:provider/:key` _(điền sau deploy)_

## Kết quả

| # | Cách thử | Kết quả | Thời gian (bắt đầu → kết thúc) | Bằng chứng |
|---|---|---|---|---|
| S0 | Local `wrangler dev --local` (wrangler 4.145.0): POST body 51 byte có CRLF, tiếng Việt, emoji, byte `1f 8b 08 00 … ff fe 00 0d 0a 80 c3`; POST 1.1MB; `/hooks/momo/*`; dump token sai/thiếu; `__scheduled` | **Đạt (local).** sha256 lưu = sha256 file gốc (`6027c3b2…`), body base64 giải ra bằng từng byte; query `?x=1&y=%C3%A9` giữ nguyên; header `Stripe-Signature` giữ nguyên; 1.1MB → ghi `body_len=1100000`, `body_too_large=1`, body NULL, vẫn 200; momo → 204; token sai/thiếu → 401; cron → dòng `cron_tick` | 2026-10-14 ~11:01 | chạy tay, dump đối chiếu bằng node |
| S1 | Stripe test mode: tạo endpoint qua API → PaymentIntent test `pm_card_visa` confirm → dump → verify offline `whsec_` trên bytes đã lưu → xoá endpoint | _chưa_ | | |
| S2 | PayOS kênh thật (coordinator + Admin) | _chờ Admin_ | | |
| S3 | GitHub repo nháp: `gh api` tạo hook → `ping` + `push` → verify `X-Hub-Signature-256` offline → deliveries 200 → xoá hook | _chưa_ | | |
| S4 | SePay dashboard (coordinator + Admin) | _chờ Admin_ | | |
| S5 | So `sha256(body)` D1 với body provider (qua chữ ký S1/S3) | _chưa_ | | |
| S6 | Cron ≥ 10 tick liên tiếp + một lần fan-out 25 fetch (`SPIKE_FANOUT_URL`) | _chưa_ | | |
| S7 | `/_spike/latency` 20 request Worker → Render (thức / ngủ), p50/max | _chưa_ | | |

## Ghi chú / lệch so với spec (đưa vào §16 khi cần)

- Spike ghi body > 1MB **không body + cờ** rồi vẫn 200 (theo giao việc LH-S); LH2 thật thì trả 413 (H10).
- `compatibility_flags = ["global_fetch_strictly_public"]` để fan-out S6 gọi được chính `workers.dev` của Worker.

## Đã dọn

| Thứ | Lúc | Cách |
|---|---|---|
| wrangler dev local | 2026-10-14 ~11:03 | dừng task + kill workerd còn sót |
