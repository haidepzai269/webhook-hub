# SPIKE LH-S — Worker nháp `hub-hooks-spike` trên `workers.dev`

> Story LH-S, SPEC-hub-sap §7b (cổng cho LH2/LH3). Mã: `spikes/catchnet-spike/` (ngoài npm workspaces, H10).
> **Cổng:** S1, S3, S5 (và S2 với Admin) đạt → được code LH2/LH3. S4/S6/S7 trượt → ghi §16, chưa chặn.
> File này **không chứa secret** (token, `whsec_`, `sk_test_` chỉ ở `.dev.vars` / `KEYS-CAN-LAY.md` mục J).
> Giờ ghi theo UTC (`Z`); giờ Việt Nam = +7.

**URL nháp: `https://hub-hooks-spike.webhookhub.workers.dev`** (subdomain tài khoản `webhookhub`, D1 `hub-hooks-spike-db` vùng APAC).

## Tóm tắt cổng (phần dev làm được)

| | Kết quả |
|---|---|
| S1 Stripe | **ĐẠT** |
| S3 GitHub | **ĐẠT** |
| S5 Bytes | **ĐẠT** |
| S6 Gói free | **ĐẠT** |
| S7 Độ trễ | Có số khi hub **đang thức**; ca **đang ngủ** chưa đo |
| S2 PayOS, S4 SePay | Chờ coordinator + Admin |

## Kết quả

| # | Cách thử | Kết quả | Thời gian | Bằng chứng |
|---|---|---|---|---|
| S0 | Local `wrangler dev --local` (wrangler 4.145.0): body 51 byte có CRLF, tiếng Việt, emoji, byte `1f 8b 08 00 … ff fe 00 0d 0a 80 c3`; 1.1MB; `/hooks/momo/*`; dump token sai/thiếu; `__scheduled` | **Đạt (local).** sha256 lưu = sha256 file gốc, body lấy lại bằng từng byte; query giữ nguyên; >1MB → `body_too_large=1`, body NULL, vẫn 200; momo 204; token sai/thiếu 401; cron ghi `cron_tick` | 2026-10-14 ~04:01Z | dump đối chiếu bằng node |
| S1 | Stripe **test mode**, lib `stripe` 22.6.2 (của monorepo, không thêm dep): `webhookEndpoints.create` URL `/hooks/stripe/spike`, event `payment_intent.succeeded` → PaymentIntent `pm_card_visa` confirm=true → dump → `stripe.webhooks.constructEvent(bytes D1, Stripe-Signature D1, whsec_ endpoint)` → xoá endpoint | **ĐẠT.** Stripe chấp nhận URL `*.workers.dev` (endpoint `status: enabled`). Request tới D1 sau ~1,3s (UA `Stripe/1.0`, 2404 byte). `constructEvent` OK → `payment_intent.succeeded`. Phản chứng: đổi 1 byte → trượt | 04:50:13Z → 04:50:21Z | endpoint `we_1UQK8nDt500MnSAbIQoQ5S6d`, PI `pi_3UQK8nDt500MnSAb0YnqSpDj`, event `evt_3UQK8nDt500MnSAb0NWBtoQJ`, D1 row 17 |
| S2 | PayOS kênh thật (coordinator + Admin) | _chờ Admin_ | | |
| S3 | Repo nháp private `haidepzai269/catchnet-spike`: `gh api POST /hooks` (content_type json, secret 32 byte ngẫu nhiên) → `ping` tự gửi; `push` bằng contents API tạo `README.md` (repo rỗng nên không làm được commit trống qua git data API) → verify `X-Hub-Signature-256` offline (`timingSafeEqual`) → deliveries → xoá hook | **ĐẠT.** GitHub nhận URL. Deliveries: `ping 200 OK`, `push 200 OK`. Chữ ký sha256 khớp cả hai trên bytes D1; phản chứng đổi 1 byte → trượt | 04:50:39Z → 04:51:19Z | delivery `cddbd388-c78a-11f1-…` (ping, row 19, 7182 B), `d3b2873e-c78a-11f1-…` (push, row 20, 8040 B), UA `GitHub-Hookshot/54f8899` |
| S4 | SePay dashboard (coordinator + Admin) | _chờ Admin_ | | |
| S5 | (a) curl từ máy dev tới URL deploy: body lạ 51 B (CRLF/unicode/byte gzip) có query `?x=1&y=%C3%A9`; body **gzip thật** + `Content-Encoding: gzip`; JSON có khoảng trắng lạ + CRLF với `X-Hub-Signature-256` tự tính; `/hooks/momo/*`; 1.1MB. (b) Chữ ký thật ở S1/S3 | **ĐẠT.** Cả 5 body: `body_len` = độ dài gốc, sha256 lưu = sha256 gốc, bytes bằng từng byte. Cloudflare **không giải nén** body gzip (giữ nguyên bytes, header `content-encoding: gzip` còn). Header chữ ký còn nguyên giá trị. S1/S3 verify trên bytes D1 đều khớp | 04:36:34Z | D1 row 1–5; S1/S3 ở trên |
| S6 | Cron `* * * * *` trên gói free; deploy kèm `--var SPIKE_FANOUT_URL:<Worker>/_spike/noop` (không sửa toml) → mỗi tick 25 `fetch` về chính `workers.dev` của Worker (cờ `global_fetch_strictly_public`) → tắt fan-out bằng deploy lại | **ĐẠT.** 11 tick liên tiếp 04:39:34Z → 04:49:34Z, khoảng cách **đúng 60s** cả 10 khoảng, qua 2 lần redeploy. 3 tick fan-out (04:39, 04:40, 04:41): mỗi lần `{"fanout":25,"ok":25,"fail":0,"errors":[]}` — không lỗi subrequest/CPU, không lỗi 1042 | fan-out bật 04:37:17Z, tắt 04:42:21Z | dump `kind=cron_tick` |
| S7 | `GET /_spike/latency?target=https://hub-api-c9hg.onrender.com/health&n=20`, hai lượt liền; kiểm route từ chối target lạ | Hub **đang thức**: lượt 1 p50 **81ms**, max **953ms** (mẫu đầu, mở kết nối); lượt 2 p50 **82ms**, max **245ms**; tất cả 200. Target `https://example.com` → 400 `target phải là HUB_ORIGIN_URL`. **Ca hub đang ngủ chưa đo** (hub đang thức lúc thử; cần đo lại sau ≥ 15 phút không có request). Chỉ dùng để chọn `CATCHNET_FORWARD_TIMEOUT_MS`, không vào báo cáo hiệu năng (ADR-019) | 04:36:49Z → 04:36:54Z | JSON trả về của route |

## Ghi chú / lệch so với spec (đưa vào §16 khi cần)

- **Cron lan ra chậm:** tick đầu tiên tới lúc 04:39:34Z, vài phút sau deploy đầu; trước đó không có tick nào (Cloudflare ghi là thay đổi cron có thể mất tới 15 phút). Sau đó đều 60s, redeploy không làm lỡ nhịp.
- **Header:** Worker thấy tên header **viết thường** và `Object.fromEntries(req.headers)` trả theo **thứ tự chữ cái**, không giữ thứ tự gốc. Không ảnh hưởng HMAC (Stripe/GitHub ký body, không ký thứ tự header). Ngoài ra Cloudflare thêm `cf-connecting-ip`, `cf-ipcountry`, `cf-ray`, `cf-visitor`, `x-forwarded-proto`, `x-real-ip` → LH2 phải bỏ khi chuyển tiếp (§4.1).
- **DNS:** sau khi đổi subdomain sang `webhookhub` và deploy lại, URL trả 200 sau ~75s.
- **Lần deploy đầu (2026-10-14 sáng)** ra `https://hub-hooks-spike.haidepzai92006.workers.dev` vì tài khoản đã có sẵn subdomain đó (`webhook-hub` đã có người dùng). Admin đổi subdomain sang `webhookhub`; spec sửa ở `d6a4f47`.
- Spike ghi body > 1MB **không body + cờ** rồi vẫn 200 (theo giao việc LH-S); LH2 thật trả 413 (H10).
- D1 (`--location apac`) nhận BLOB 51 B–8 KB không vấn đề. Trần kích thước dòng D1 chưa thử với 1MB thật (spike không lưu body > 1MB) → LH2 tra và ghi §16.

## Đã dọn

| Thứ | Lúc | Cách |
|---|---|---|
| wrangler dev local | 2026-10-14 ~04:03Z | dừng task + kill workerd còn sót |
| Fan-out S6 | 04:42:21Z | deploy lại không có `SPIKE_FANOUT_URL` |
| Webhook endpoint Stripe test `we_1UQK8nDt500MnSAbIQoQ5S6d` | 04:50:21Z | `webhookEndpoints.del` → `deleted: true` |
| Hook GitHub `697436053` trên `haidepzai269/catchnet-spike` | 04:51:19Z | `gh api -X DELETE`; danh sách hook còn 0 |
| **Còn giữ** | | Worker `hub-hooks-spike` + D1 `hub-hooks-spike-db` (cần cho S2/S4). Repo nháp còn file `README.md` do push S3 tạo. PaymentIntent test để nguyên (test mode) |
