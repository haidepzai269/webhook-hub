# SPIKE LH-S — Worker nháp `hub-hooks-spike` trên `workers.dev`

> Story LH-S, SPEC-hub-sap §7b (cổng cho LH2/LH3). Mã: `spikes/catchnet-spike/` (ngoài npm workspaces, H10).
> **Cổng:** S1, S3, S5 (và S2 với Admin) đạt → được code LH2/LH3. S4/S6/S7 trượt → ghi §16, chưa chặn.
> File này **không chứa secret** (token, `whsec_`, `sk_test_` chỉ ở `.dev.vars` / `KEYS-CAN-LAY.md` mục J).

URL nháp kỳ vọng: `https://hub-hooks-spike.webhook-hub.workers.dev`.
**URL thực tế sau deploy (2026-10-14): `https://hub-hooks-spike.haidepzai92006.workers.dev` → SAI subdomain, đã DỪNG.**

### Deploy 2026-10-14 (giai đoạn 2, bước 1–2)

- `wrangler whoami`: OAuth, Admin đã `wrangler login`.
- `npx wrangler d1 create hub-hooks-spike-db --location apac` → `✅ Successfully created DB 'hub-hooks-spike-db' in region APAC`, id ghi vào `wrangler.toml`.
- `npx wrangler d1 execute hub-hooks-spike-db --remote --file=schema.sql` → OK (`num_tables: 1`).
- `npx wrangler deploy` (stdin đóng, không có câu hỏi nào; wrangler **không** hỏi đăng ký subdomain) in nguyên văn:
  ```
  Uploaded hub-hooks-spike (4.12 sec)
  Deployed hub-hooks-spike triggers (3.63 sec)
    https://hub-hooks-spike.haidepzai92006.workers.dev
    schedule: * * * * *
  Current Version ID: b5f1f5f8-0531-45ae-91c2-ce526781316d
  ```
- Tức là tài khoản **đã có sẵn** subdomain `workers.dev` là `haidepzai92006` (bước J2 đặt `webhook-hub` chưa làm, hoặc làm ở tài khoản khác). Theo lệnh coordinator: **DỪNG, không chọn/đổi gì**. Chưa đặt `SPIKE_DUMP_TOKEN` (dump trả 401 với mọi token), chưa chạy S5/S6/S7.
- Worker `hub-hooks-spike` **vẫn đang chạy** trên URL trên (cron mỗi phút ghi `cron_tick` vào D1 nháp). Chờ Admin quyết: đổi subdomain tài khoản thành `webhook-hub` rồi deploy lại, hoặc `wrangler delete`.

## Kết quả

| # | Cách thử | Kết quả | Thời gian (bắt đầu → kết thúc) | Bằng chứng |
|---|---|---|---|---|
| S0 | Local `wrangler dev --local` (wrangler 4.145.0): POST body 51 byte có CRLF, tiếng Việt, emoji, byte `1f 8b 08 00 … ff fe 00 0d 0a 80 c3`; POST 1.1MB; `/hooks/momo/*`; dump token sai/thiếu; `__scheduled` | **Đạt (local).** sha256 lưu = sha256 file gốc (`6027c3b2…`), body base64 giải ra bằng từng byte; query `?x=1&y=%C3%A9` giữ nguyên; header `Stripe-Signature` giữ nguyên; 1.1MB → ghi `body_len=1100000`, `body_too_large=1`, body NULL, vẫn 200; momo → 204; token sai/thiếu → 401; cron → dòng `cron_tick` | 2026-10-14 ~11:01 | chạy tay, dump đối chiếu bằng node |
| S1 | Stripe test mode: tạo endpoint qua API → PaymentIntent test `pm_card_visa` confirm → dump → verify offline `whsec_` trên bytes đã lưu → xoá endpoint | _chờ Admin_ (`STRIPE_TEST_SECRET_KEY` trống) | | |
| S2 | PayOS kênh thật (coordinator + Admin) | _chờ Admin_ | | |
| S3 | GitHub repo nháp: `gh api` tạo hook → `ping` + `push` → verify `X-Hub-Signature-256` offline → deliveries 200 → xoá hook | _chờ Admin_ (`SPIKE_GITHUB_REPO` trống) | | |
| S4 | SePay dashboard (coordinator + Admin) | _chờ Admin_ | | |
| S5 | So `sha256(body)` D1 với body provider (qua chữ ký S1/S3) | _dừng: sai subdomain_ | | |
| S6 | Cron ≥ 10 tick liên tiếp + một lần fan-out 25 fetch (`SPIKE_FANOUT_URL`) | _dừng: sai subdomain_ | | |
| S7 | `/_spike/latency` 20 request Worker → Render (thức / ngủ), p50/max | _dừng: sai subdomain_ (`HUB_ORIGIN_URL` đã đặt trong `wrangler.toml`) | | |

## Ghi chú / lệch so với spec (đưa vào §16 khi cần)

- Spike ghi body > 1MB **không body + cờ** rồi vẫn 200 (theo giao việc LH-S); LH2 thật thì trả 413 (H10).
- `compatibility_flags = ["global_fetch_strictly_public"]` để fan-out S6 gọi được chính `workers.dev` của Worker.

## Đã dọn

| Thứ | Lúc | Cách |
|---|---|---|
| wrangler dev local | 2026-10-14 ~11:03 | dừng task + kill workerd còn sót |
