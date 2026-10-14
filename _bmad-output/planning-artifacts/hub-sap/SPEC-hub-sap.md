# SPEC LH — Khi hub sập: lưới hứng (Cloudflare Worker + D1), sổ khoảng hở, lấy lại sự kiện

> Phòng party viết ngày 2026-10-13. Spec chỉ mô tả việc cần làm, **chưa có code**. Admin giao cho phiên dev.
> Tiền tố mã test là `LH:`. Phải thêm namespace `LH` vào `verify/spec-sources.json` **trước** khi viết test đầu tiên, theo dạng khai báo của `BP`.
> **Dải ADR của LH là 211–229** (Admin chốt 2026-10-14; PK dùng 230 trở đi). BP giữ 195–200, PK chặng 1–4 giữ 201–210. Grep lại trước khi ghi: `git grep -oh "ADR-2[0-9][0-9]" master -- docs _bmad-output | sort -u`.
> **Đọc mục "ĐÍNH CHÍNH H1–H13" ngay dưới đây trước.** Khi đính chính và phần thân khác nhau thì đính chính thắng.
> Thứ tự giao dev ở §11. **§9 (URL công khai) đã chốt 2026-10-14: `workers.dev` + chạy song song.**
> **Mỗi mục có khối "Vì sao sửa"**: chuyện gì hỏng, kịch bản cụ thể, vì sao chọn cách này mà không chọn cách khác. Agent dev phải dùng khối này làm dòng **Vấn đề / Đánh đổi** của ADR và làm thân commit. Không viết lại lý do theo trí nhớ. Nếu lúc code thấy lý do không còn đúng thì dừng lại và báo phòng.
> **Số liệu gói free và hành vi retry của provider** (§1) là kết quả tra web ngày 2026-10-13. Dev đối chiếu trang chính thức lúc làm và ghi ngày tra vào ADR. Lệch thì trang chính thức thắng, ghi vào §16.

## ĐÍNH CHÍNH H1–H13 (phòng soi spec với code master `305a402`, 2026-10-14; thắng phần thân)

Spec viết trên `57c81ad`. Từ đó PK0–PK5 đã lên master và sửa đúng những chỗ lưới hứng chạm vào. Lõi thiết kế vẫn giữ nguyên: ghi xuyên, Worker không giữ secret, một cửa `/hooks/*`. Các mối nối dưới đây phải sửa trước khi code.

**H1 (Nặng). Hub từ chối bằng 503 không được bị hiểu là "hub vắng".**
- **Vì sao:** PK4 cho source đặt `ack.rejectStatus: 503` khi chữ ký sai (`libs/providers/src/generic-config.ts:57`, ADR-205). §4.1 lại coi mọi 5xx là hub chết, nên Worker sẽ ghi D1 và trả 2xx cho một request chữ ký rác. Kẻ xấu vòng được qua hộp phạt EG2 và làm đầy D1 tới trần.
- **Sửa:**
  - Mọi phản hồi từ `/hooks/*` do hub **cố ý** trả đều mang header `x-hub-outcome: accepted | duplicate | rejected | handshake | refused`. Lỗi tạm thời thì không mang header này (vd DB down, đúng BB-3), hoặc mang `x-hub-outcome: unavailable`.
  - Worker coi là "hub vắng" **chỉ khi** gặp timeout, lỗi mạng, hoặc 5xx **mà không** có `x-hub-outcome`, hoặc có `x-hub-outcome: unavailable`. Có outcome khác thì trả nguyên phản hồi cho provider, **không** ghi D1.
  - Worker không chuyển header `x-hub-outcome` ra cho provider.
  - Test `[LH:T18]`: source `rejectStatus: 503` + chữ ký sai → provider nhận 503, D1 rỗng.
  - Test `[LH:T21]` (LH3, phía hub): mọi nhánh trả lời cố ý của `/hooks/*` mang `x-hub-outcome` đúng giá trị — accepted, duplicate, handshake (GET bắt tay, HEAD `head-ok`), rejected (401, 503 `rejectStatus`, 404, 400 parser, 413, 405, 422), refused (429 cổng phạt, 429 rate limit, 507, cờ unverified tắt); lỗi tạm thời (transaction lỗi, exception) mang `unavailable`. Ghi ở ADR-221.

**H2 (Nặng). Phát lại gặp 429 không được chuyển sang `inbox_dead`.**
- **Vì sao:** §4.4 viết "4xx → `inbox_dead`". Nhưng hub trả 429 khi vượt rate limit 100/phút/source, và cổng phạt cũng trả 429. Hub vừa thức, phát lại cộng lưu lượng mới vượt trần, thì sự kiện thật thành hàng chết.
- **Sửa:**
  - 408, 429, và mọi 5xx mà H1 coi là "hub vắng" → retry. Có `Retry-After` thì `next_at ≥` giá trị đó.
  - Chỉ chuyển sang `inbox_dead` khi hub trả 4xx khác **có** `x-hub-outcome: rejected | refused`, hoặc trả 404 (source không còn).
  - Test `[LH:T8]` thêm ca 429 → `next_at` lùi, dòng còn nguyên.

**H3 (Nặng). Chữ ký lưới phải kiểm được ở cổng phạt, mà cổng chạy trước khi đọc body.**
- **Vì sao:** `apps/hub-api/src/modules/ingest/penalty-gate.ts` chạy **trước body parser** (D3, ADR-177), có chủ ý không đọc body rác. Chữ ký §5 lại có `sha256(body)` nên không kiểm được ở cổng. Hệ quả là IP Cloudflare vẫn bị phạt chung, F7 không được giải.
- **Sửa:** tách thành hai chữ ký.
  - `x-catchnet-signature: v1=HMAC(secret, id.received_at.client_ip.mode.method.path_and_query)`. Không có body. Cổng phạt kiểm chữ ký này để lấy `client_ip`.
  - `x-catchnet-body-signature: v1=HMAC(secret, id.hex(sha256(body)))`. Hub kiểm sau khi parse body: tự tính `sha256(rawBody)`, dựng lại HMAC rồi so bằng `timingSafeEqual`. **Chỉ khi khớp** thì `receivedAt` của lưới mới được dùng làm `ctx.verifyAt`.
  - Chữ ký đầu đúng mà body lệch → bỏ `receivedAt` (verify theo `Date.now()`), vẫn dùng IP đã ký cho hộp phạt.
- **Code có sẵn:** `AdapterContext.verifyAt` đã có (`libs/providers/src/generic.adapter.ts:454`). LH3 chỉ đổ giá trị vào đó, rồi sửa `stripe.adapter.ts:33` truyền `receivedAt` vào `constructEvent` (ADR-174 vẫn đúng: cùng hàm của SDK, chỉ thêm tham số).

**H4 (Trung bình). URL công khai của request phụ thuộc đường nó đi vào.**
- **Vì sao:** F9 bỏ sót `publicHooksUrl()` (`apps/hub-api/src/modules/ingest/ingest.service.ts:768`) và `public-ingest-base.ts`. Hai chỗ này do PK5 thêm, dùng cho `unverified` + `forwardUrl`, và cho provider ký trên URL (Twilio trong danh mục). Theo U-C, source mới đi `workers.dev`, còn source cũ đi thẳng Render.
- **Sửa:**
  - Request có chữ ký lưới hợp lệ (H3) → URL = `HUB_INGEST_PUBLIC_URL` + path + query.
  - Không có → `HUB_PUBLIC_URL` như cũ.
  - Commit §9 (`[LH:T17]`) phải sửa cả hai chỗ trên. Phần chọn base theo header lưới thì làm ở LH3.
  - Test `[LH:T19]` (LH3, nợ REVIEW-LH-URL L1): có cả hai biến; request có chữ ký lưới hợp lệ → `publicUrl` của adapter (vd `forwardUrl` lưu `__hub_meta.url`) là URL `HUB_INGEST_PUBLIC_URL`; request gọi thẳng, hoặc header lưới sai chữ ký → URL `HUB_PUBLIC_URL`.

**H5 (Trung bình). `raw_events.via` phải phân biệt chuyển tiếp với phát lại.**
- **Vì sao:** ghi xuyên thì lúc hub sống, mọi request vẫn đi qua Worker. Một giá trị `'catchnet'` làm báo cáo "lưới đã cứu" đếm gấp hàng trăm lần.
- **Sửa:**
  - Worker gửi `x-catchnet-mode: forward | replay`. Header này nằm trong chuỗi ký H3.
  - `via` nhận giá trị `'catchnet-forward' | 'catchnet-replay' | NULL`.
  - Nhãn "đã được lưới bảo vệ" (§9) tắt khi gặp một trong hai giá trị. Số "lưới đã cứu" chỉ đếm `catchnet-replay`.
  - Test `[LH:T20]` (LH3): chữ ký lưới hợp lệ mode `forward` → `raw_events.via='catchnet-forward'`, mode `replay` → `'catchnet-replay'`; chữ ký sai / không có → `via` NULL. `raw_events.received_at` = `x-catchnet-received-at` CHỈ khi chữ ký body khớp; lệch → mặc định DB (giờ hub). Migration chỉ thêm cột `via` + CHECK.

**H6 (Trung bình). Không hứng request bắt tay.**
- **Vì sao:** khi hub vắng, Worker trả `{"ok":true}` cho GET `hub.challenge` (Meta) hay `url_verification` (Slack). Provider sẽ báo "xác minh URL thất bại", và hub phát lại một handshake thì cũng vô nghĩa.
- **Sửa:**
  - `sources_sync` thêm cột `catch_methods TEXT NOT NULL DEFAULT 'POST'`. GET/HEAD **không bao giờ** được hứng, trừ khi source khai báo GET là sự kiện (VNPay IPN, sau PK6). Request không được hứng mà hub vắng → 503.
  - Bắt tay nằm trong body (Slack) thì Worker không nhận ra được. Chấp nhận: provider báo lỗi xác minh, dev bấm lại. Khi phát lại, hub ghi một dòng `handshake` vô hại. Ghi vào ADR-215.

**H7 (Thấp). Tham chiếu cũ trong spec.**
- "PK2 (danh mục)" là **PK9** (`libs/providers/src/catalog`, ADR-208).
- `buildAck(result, ctx)` **đã có** (`provider.interface.ts:252`), cùng `ack.successStatus` 200/202/204 của PK4. Dùng luôn, không chờ PK6.
- Hiện chưa có adapter VNPay hay MoMo. GET sự kiện cần PK6 bên hub. `[LH:T9]` chỉ kiểm phía Worker (lưu và phát lại giữ nguyên query); nửa phía hub làm sau PK6.
- Code ở F8 đã dời sang `source-connection.service.ts:253-256`.

**H8 (Trung bình). LH5 PayOS và trần Shop.**
- `apps/shop/src` đang ở **đúng 600/600 dòng**. Commit thay cron bằng `reconcile` phải giảm dòng, báo số dòng trước/sau trong thân commit.
- Khoá chống trùng PayOS là `payos:${orderCode}:${reference}` (`payos.adapter.ts:78`). `lookupByRef` phải sinh **một item cho mỗi giao dịch** trong `transactions[]`, dùng đúng `reference` của giao dịch đó, không dùng `paymentLinkId`. Nếu không thì `[LH:T15]` ra 2 event.

**H9 (Trung bình). LH0: hub ngủ không phải gián đoạn (Admin chốt 2026-10-14).**
- **Vì sao:** Render free ngủ cho tới khi có request chạm vào. Heartbeat thuần thì sáng nào cũng có "khoảng hở 7 tiếng", banner thành tiếng ồn, và dev sẽ bỏ qua đúng hôm mất thật. Bản bán thật thì chạy VPS, không ngủ.
- **Sửa:**
  - Tắt máy sạch (SIGTERM → graceful shutdown, gồm Render cho ngủ và deploy) ghi `process_heartbeats.stopped_at = now()`.
  - Lúc khởi động:
    - `stopped_at` đã đặt → **không** ghi khoảng hở (ngủ hoặc deploy).
    - Không có `stopped_at` và `last_beat_at` cũ quá 2 × 60s → crash → ghi `outage_gaps (source='heartbeat')`.
  - Lưới hứng báo phải giữ request → ghi `outage_gaps (source='catchnet')`, kể cả khi hub đang ngủ. Đây là bằng chứng có request bị lỡ.
  - Banner chỉ hiện với hai loại trên.
  - **Không** dùng cron Worker ping giữ Render thức (đốt quota Neon và giờ Render).
  - `[LH:T2]` thêm ca: tắt sạch rồi nằm 3 phút → không ghi gì.

**H10 (Trung bình). Chỗ đặt Worker và cách test.**
- `apps/catchnet/` nằm **ngoài** npm workspaces gốc: `package.json` và lock riêng, job CI riêng. `wrangler`/`workerd` nặng, không được làm chậm `npm ci` của hub.
- Test Miniflare chạy trong CI, không chạy trên máy dev yếu.
- Spike vẫn ở `spikes/catchnet-spike/`.
- So token và chữ ký ở Worker bằng `crypto.subtle.timingSafeEqual` (API của runtime Workers), kiểm độ dài trước.
- Body > 1MB (trần ingest của hub) → không hứng, trả 413. D1 có trần kích thước dòng; dev tra và ghi §16.

**H11. Dải ADR.**
- LH dùng 211–229. Các số ở §12 giữ nguyên; ADR phát sinh thêm dùng từ 221.
- PK dùng 230+ (PK10 đã dùng ADR-230).

**H12. Thứ tự (thay §11, Admin chốt 2026-10-14: lưới hứng làm TRƯỚC PK6–PK8).**

| # | Story | Phụ thuộc |
|---|---|---|
| 1 | §7c mục J trong `KEYS-CAN-LAY.md` + §9 tách `HUB_INGEST_PUBLIC_URL` (gồm H4 phần env) | — |
| 2 | LH-S spike (cổng) | Admin có tài khoản Cloudflare; Admin có mặt lúc S2 PayOS |
| 3 | LH3 (H1 header outcome, H3, H4, H5) | LH-S đạt |
| 4 | LH2 Worker + D1 + phát lại (H2, H6, H10) | LH3 |
| 5 | LH0 sổ khoảng hở (H9) | — (có migration) |
| 6 | LH6 chaos LOCAL | LH2, LH3 |
| 7 | LH5 reconcile PayOS + Shop bỏ cron (H8) | — |
| 8 | LH1 `recovery` + nhãn 🛡️ | PK10 đã gộp (cùng sửa `catalog.data.ts`) |
| 9 | LH4 backfill Stripe | LH0 |
| 10 | LH7 giấy | tất cả |

- Story có migration (LH0, LH3 thêm `raw_events.via`) đặt timestamp **sau** `20261014090000_unverified_sources`.
- Bật Worker thật `hub-hooks` (`wrangler deploy` tên thật, đặt secret, đổi `HUB_INGEST_PUBLIC_URL` trên Render) là thao tác hạ tầng: **hỏi Admin từng lần**.

**H13. Còn đúng, đã kiểm.**
- Route `/hooks/:provider/:sourceKey` (GET + POST) khớp §4.1.
- `swVerify` nhận `nowSec` (F5).
- `buildAck` dùng được cho ack ở §4.3.
- `EventOrigin.reconciliation` có sẵn (F2).

## 0. Bối cảnh và mong muốn của Admin

Admin hỏi: *"Hub sập thì webhook provider bắn tới trong lúc đó đi đâu? Không lẽ service của dev không nhận được tín hiệu? Có cơ chế backup không?"* Sau đó hỏi rộng hơn: *"Nếu service của dev dùng VNPay, MoMo, hay một provider khác thì sao?"*

**Mong muốn đã chốt (Admin, 2026-10-13):**

1. Chọn hướng **A và rộng hơn A**: sổ khoảng hở + lấy lại theo từng loại provider, phủ cả VNPay, MoMo và provider lạ.
2. **Làm lưới hứng.** Đặt ở **Cloudflare Worker + D1** (gói free, không cần thẻ).
3. **URL công khai: chưa chốt.** Admin thấy đổi URL thì được nhưng bất tiện, cần bàn kỹ hơn (§9).

**Nguyên tắc của cả spec:** hub không hứa "không bao giờ mất". Hub hứa ba điều, đúng với từng provider:

| Hứa | Nghĩa |
|---|---|
| **Biết** | Hub biết chính nó đã gián đoạn từ lúc nào tới lúc nào (LH0) |
| **Nói thật** | Mỗi source cho dev biết khi hub gián đoạn thì sự kiện có lấy lại được không, bằng cách nào (LH1) |
| **Lấy lại được khi có thể** | Lưới hứng (LH2–LH3) cho mọi provider. Backfill (LH4) và tra theo mã (LH5) cho provider có API |

## 1. Những gì đã biết (tra web + đọc code, 2026-10-13, master `57c81ad`)

### 1.1. Hành vi retry của provider

| Provider | ① Provider tự gửi lại | API lấy lại | Loại phục hồi |
|---|---|---|---|
| Stripe | Có, kéo dài tới ~3 ngày (phòng nhớ, **chưa tra lại**) | `GET /v1/events` theo thời gian | ① + ② |
| SePay | 7 lần theo Fibonacci, ~33 phút, **chỉ khi bật "Auto retry"** ([nguồn](https://developer.sepay.vn/en/sepay-webhooks/xu-ly-loi)) | Chỉ replay tay trên dashboard SePay, ≤ 20 log/lượt | ① (có hạn) |
| GitHub | **Không** tự gửi lại, timeout 10s ([nguồn](https://docs.github.com/webhooks/using-webhooks/handling-failed-webhook-deliveries)) | REST: liệt kê deliveries + redeliver | ② |
| PayOS | Chỉ trang marketing hứa "có retry", **không có số lần, lịch, timeout** ([nguồn](https://payos.vn/solutions/giai-phap-thanh-toan-danh-cho-developer/)). Không có log hay nút gửi lại | `GET /v2/payment-requests/{orderCode\|linkId}`. **Không** có API liệt kê theo thời gian trong tài liệu ([nguồn](https://payos.vn/docs/api/)) | ③ |
| VNPay | Không có tài liệu chính thức về số lần retry IPN | QueryDR theo mã giao dịch | ③ |
| MoMo | Không có tài liệu chính thức. IPN đòi **204 trong 15s** ([nguồn](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/)) | Query theo `orderId` | ③ |
| Generic (provider thứ 100) | Không biết | Không có | ④ |

Loại: ① provider tự gửi lại · ② liệt kê từ mốc thời gian · ③ tra theo mã giao dịch (mã chỉ dev biết) · ④ không lấy lại được.

### 1.2. Gói free cho lưới hứng

| Dịch vụ | Giới hạn gói free | Kết luận |
|---|---|---|
| CF Workers | 100.000 request/ngày, CPU 10ms/request (chờ `fetch`/D1 không tính CPU), body tối đa 100MB ([nguồn](https://developers.cloudflare.com/workers/platform/limits/)) | ✅ Dùng |
| CF D1 | 100.000 dòng ghi/ngày, 5 triệu dòng đọc/ngày, 5GB ([nguồn](https://developers.cloudflare.com/d1/platform/pricing/)) | ✅ Dùng. **Dev tra lại kích thước dòng/BLOB tối đa** |
| CF Queues | 10.000 thao tác/ngày, giữ 24h, free từ 2026-02-04 ([nguồn](https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/)) | ❌ Giữ 24h quá ngắn cho sự cố qua đêm |
| CF KV | 1.000 lần ghi/ngày | ❌ Quá ít |
| Upstash QStash | Luôn trả 200, token nằm trong URL | ❌ Không trả được 204 cho MoMo |
| Upstash Redis | — | ❌ BB-2: Redis được phép sai, lưới hứng thì không |
| Vercel → Neon | Không thêm nhà cung cấp | ❌ (Admin chọn CF): Neon chết là lưới chết theo; cold start Vercel cộng Neon autosuspend |

### 1.3. Code

| # | Ở đâu | Thực tế | Hệ quả |
|---|---|---|---|
| F1 | ADR-129, `docker-entrypoint.sh hub-all` | hub-api, hub-worker, nginx chạy **chung một container** Render. Render free ngủ khi rảnh | "Hub sập" trên deployed thường là **hub đang ngủ**. Cold start vài chục giây > timeout GitHub 10s, MoMo 15s |
| F2 | `libs/database/prisma/schema.prisma` | `EventOrigin` đã có `webhook, reconciliation, replay, derived` | LH5 dùng `reconciliation` sẵn có, không thêm enum |
| F3 | `apps/shop` (ADR-009) | Shop tự đối soát PayOS bằng cron gọi `GET /v2/payment-requests` | LH5 nâng đúng việc này thành năng lực chung của hub |
| F4 | `libs/providers/src/stripe.adapter.ts:33` | `constructEvent(rawBody, sig, secret)` dùng `Date.now()`, tolerance mặc định 5 phút | Phát lại sau 20 phút sẽ **401**. Stripe SDK 22.6.2 có tham số `receivedAt` (`node_modules/stripe/cjs/Webhooks.js:17`) → sửa được (LH3) |
| F5 | `libs/crypto/src/standard-webhooks.ts:42-50` | `swVerify` nhận `opts.nowSec` | Sửa được theo cùng cách (LH3) |
| F6 | `libs/providers/src/generic.adapter.ts:144` | Đã dùng `raw.receivedAt` khi verify lại | Hướng đúng, LH3 làm cho mọi adapter |
| F7 | `apps/hub-api/src/modules/ingest/penalty-box.ts`, `trust-proxy.ts` | Hộp phạt EG2 và cầu chì EG1 khoá theo **IP** | Request đi qua Worker đến từ IP của Cloudflare → một kẻ xấu làm IP Cloudflare bị phạt là **chặn mọi ingest** (LH3) |
| F8 | `source-connection.service.ts:262-278` | URL đã đăng ký khác URL mong đợi → `DRIFTED` + `public_url_changed` | Cơ chế chuyển URL cho PayOS/Stripe **đã có**. §9 dựa vào nó |
| F9 | `projects.controller.ts:55`, `source-connection.service.ts:49`, `stripe.connector.ts` | Một biến `HUB_PUBLIC_URL` dùng cho cả API lẫn URL ingest | Phải tách URL ingest ra (§9) |

## 2. LH0 — Sổ khoảng hở

> **Vì sao sửa**
> - **Chuyện gì hỏng:** hub không biết chính nó đã chết. Sống lại thì dashboard xanh, không ai biết trong 20 phút vừa rồi webhook GitHub nào đã rơi.
> - **Kịch bản:** Render ngủ 14:02–14:19. GitHub gửi 3 push, cả 3 failed vì timeout 10s. GitHub không gửi lại. Dev không bao giờ biết.
> - **Vì sao là viên gạch đầu tiên:** backfill (LH4) cần mốc `since`. Nhãn 🛡️ (LH1) cần biết có khoảng hở hay không. Báo cáo cho dev cần khung giờ. Thiếu sổ thì mọi lớp sau phải đoán.
> - **Vì sao ghi vào Postgres, không ghi Redis:** sổ là bằng chứng, phải sống qua restart. BB-2: Redis được phép mất.
> - **Vì sao không dùng metric Prometheus:** metric trên deployed không lưu lâu và hub-api không đọc lại được nó.

**Phạm vi:**
1. Bảng hạ tầng `hub.process_heartbeats(process text PK, instance text, last_beat_at timestamptz)`. Mỗi tiến trình ghi một lần / 60s (`UPDATE … SET last_beat_at = now()`). Không có `tenant_id` vì là bảng hạ tầng (cùng loại ngoại lệ với outbox/relay, ghi vào ADR).
2. Lúc khởi động, nếu `now - last_beat_at > 2 × 60s` → ghi `hub.outage_gaps(id, process, started_at = last_beat_at, ended_at = now(), source)`. `source` = `'heartbeat'`, hoặc `'catchnet'` khi biết từ lưới hứng (LH2 báo request đầu tiên nó phải giữ).
3. Ngân sách: 1 UPDATE / phút / tiến trình. **0 lệnh Redis.** Không nằm trên đường ingest.
4. Console: banner *"Hub gián đoạn 14:02–14:19 (17 phút)"* trên trang project, kèm bảng theo từng source (LH1).
5. `[LH:T1]` dừng tiến trình 3 phút (giả đồng hồ) → khởi động ghi đúng một khoảng hở. `[LH:T2]` restart nhanh (< 2 phút) → không ghi.

## 3. LH1 — Trường `recovery` trong danh mục + nhãn 🛡️

> **Vì sao sửa**
> - **Chuyện gì hỏng:** dev chọn PayOS hay VNPay mà không biết nếu hub chết thì mình mất gì. Thứ dev sợ nhất không phải hub sập, mà là hub sập rồi giả vờ như chưa từng sập (Sally).
> - **Vì sao là dữ liệu trong danh mục PK2:** mỗi provider một kiểu (§1.1). Viết `if (provider === …)` trong console là phá luận điểm adapter.
> - **Vì sao ghi "không rõ" thay vì đoán:** PayOS, VNPay, MoMo không có tài liệu retry. Ghi "có retry" là hứa thay provider.

**Phạm vi:**
1. Mỗi mục danh mục (PK2) và mỗi adapter có sẵn khai báo:
   ```ts
   recovery: {
     pushRetry: { window: '3d' | '33m' | null, condition?: string }, // null = không rõ
     pull: 'list-since' | 'lookup-by-ref' | 'none',
   }
   ```
   Giá trị khởi đầu lấy từ bảng §1.1. `condition` cho SePay = "chỉ khi bật Auto retry".
2. Trang source hiện một dòng 🛡️, sinh từ `recovery` + trạng thái lưới (LH2) + khoảng hở gần nhất (LH0). Ví dụ:
   - *"PayOS: không rõ PayOS có gửi lại không. ✅ Lưới hứng đang bảo vệ. Hub có thể tra lại theo mã giao dịch (LH5)."*
   - *"Generic: hub không lấy lại được sự kiện của provider này nếu lưới hứng không giữ được."*
3. `[LH:T3]` mọi adapter đã đăng ký đều có `recovery` (test đỏ khi thiếu).

## 4. LH2 — Lưới hứng: Cloudflare Worker + D1, ghi xuyên

> **Vì sao sửa**
> - **Chuyện gì hỏng:** chỉ provider loại ① tự cứu được, và chỉ trong cửa sổ của họ. GitHub không gửi lại. PayOS không công bố. Provider thứ 100 không ai biết.
> - **Kịch bản:** khách trả tiền PayOS lúc Render đang ngủ. PayOS gọi, timeout. Nếu PayOS không gửi lại thì chỉ còn cron đối soát của Shop cứu, mà cron đó chạy 5 phút một lần trên GitHub Actions và chỉ phủ PayOS.
> - **Vì sao ghi xuyên mà không luôn hứng:** luôn hứng thì mọi sự kiện chờ thêm một nhịp kéo, p95 xấu đi và mọi số đo k6 trong báo cáo phải làm lại. Ghi xuyên: hub sống thì lưới hứng chỉ là một chặng chuyển tiếp.
> - **Vì sao Cloudflare + D1 (Admin chốt):** Worker không ngủ, D1 là **vùng lỗi độc lập** với Neon/Render, gói free đủ dùng. Vercel → Neon chết theo Neon và có cold start chồng cold start.
> - **Vì sao Worker không verify chữ ký:** Worker không giữ secret. Giữ secret ở hai nơi là gấp đôi bề mặt lộ. Verify chỉ có một chỗ là hub.
> - **Vì sao vẫn giữ BB-3 (Amelia):** "COMMIT" trong BB-3 nghĩa là **lần ghi bền đầu tiên**. Worker chỉ trả 2xx sau khi D1 ghi xong. Request chưa ghi bền thì Worker trả 503 để provider tự gửi lại.

### 4.1. Luồng

```
provider ──► Worker /hooks/:provider/:sourceKey (GET hoặc POST)
              │
              ├─ sourceKey không có trong bảng sources_sync ─► chuyển tiếp hub; hub lỗi ─► 503 (KHÔNG ghi, KHÔNG 2xx)
              │
              ├─ mạch "hub chết" đang mở (isolate nhớ ≤ 30s) ─► bỏ qua chuyển tiếp, ghi D1 luôn
              │
              ├─ chuyển tiếp hub, timeout 4s (dưới 10s của GitHub, 15s của MoMo)
              │     hub trả bất kỳ mã nào < 500 ─► trả NGUYÊN phản hồi của hub (status, header an toàn, body)
              │     hub 5xx / timeout / lỗi mạng ─► ghi D1 ─► trả ack của source (§4.3)
              │
              └─ ghi D1 lỗi ─► 503 (KHÔNG 2xx)
```

- **Giữ nguyên bytes:** body đọc bằng `arrayBuffer()`, lưu BLOB, chuyển tiếp bằng đúng bytes đó. Không bao giờ `JSON.parse` rồi stringify lại (HMAC tính trên bytes).
- **Giữ nguyên URL đầy đủ** cả query string (VNPay IPN là GET, chữ ký nằm trên query, PK6).
- **Giữ header gốc** trong D1 (cần để verify khi phát lại). Header bị loại khi chuyển tiếp: `host`, `cf-*`, `x-forwarded-*` (Worker đặt lại theo §5).
- Hub trả 401/404/422 thì Worker trả nguyên mã đó, **không** ghi D1. Lỗi đó là lỗi của request, không phải lỗi của hub.

### 4.2. Schema D1

```sql
CREATE TABLE inbox (
  id            TEXT PRIMARY KEY,          -- ulid, sinh ở Worker
  source_key    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  method        TEXT NOT NULL,
  url           TEXT NOT NULL,             -- đường dẫn + query gốc
  headers_json  TEXT NOT NULL,
  body          BLOB NOT NULL,
  received_at   INTEGER NOT NULL,          -- ms epoch, giờ Worker nhận
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_at       INTEGER NOT NULL,
  last_status   INTEGER
);
CREATE INDEX inbox_next ON inbox(next_at);

CREATE TABLE inbox_dead (... cùng cột ..., reason TEXT, dead_at INTEGER);

CREATE TABLE sources_sync (
  source_key  TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  ack_status  INTEGER NOT NULL,            -- vd 200, 204
  ack_type    TEXT,                        -- content-type
  ack_body    TEXT,                        -- vd {"RspCode":"00","Message":"Confirm Success"}
  updated_at  INTEGER NOT NULL
);
```

**Không** lưu secret, credentials hay `tenant_id` trong D1. `sources_sync` chỉ chứa thứ đã công khai trong URL, cộng với ack.

**Trần chống xả rác:** mỗi `source_key` tối đa `CATCHNET_MAX_PER_KEY` dòng đang chờ (mặc định 2.000), toàn bảng tối đa `CATCHNET_MAX_ROWS` (mặc định 50.000, tức một nửa quota ghi/ngày). Vượt trần thì trả 503 (provider tự gửi lại nếu có), metric `catchnet_overflow`.

### 4.3. Ack khi hub vắng mặt

- Hub đẩy `ack_*` cho từng source vào `sources_sync`. Giá trị lấy từ `buildAck` nhánh "đã nhận" của adapter (PK6: `buildAck(result, ctx)`). MoMo = 204, VNPay = 200 + body `RspCode 00`, còn lại 200 `{"ok":true}`.
- **Đánh đổi phải ghi ADR:** khi hub vắng, Worker trả ack "đã nhận" **trước khi verify**. Với VNPay thì request chữ ký sai cũng nhận `00` thay vì `97`. Chấp nhận được vì request đó vẫn bị hub từ chối khi phát lại và không bao giờ vào luồng. Chỉ khác ở mã trả về cho provider.

### 4.4. Phát lại (Worker tự làm, hub không có code kéo)

- **Cron Trigger mỗi phút:** lấy ≤ `CATCHNET_REPLAY_BATCH` dòng (mặc định 25, dưới trần 50 subrequest/lần chạy của gói free, **dev tra lại**) có `next_at <= now`, sắp theo `received_at`, rồi gửi lại vào hub đúng method/URL/header/body cộng header lưới hứng (§5).
- Hub 2xx (kể cả `duplicate`) → xoá dòng. Hub 4xx (401, 404, 422) → chuyển sang `inbox_dead` kèm lý do. Hub 5xx/timeout → `attempts++`, `next_at` lùi dần (1m, 2m, 5m, 10m, rồi 30m), không giới hạn số lần trong `CATCHNET_RETENTION_DAYS` (mặc định 7). Quá hạn → `inbox_dead`.
- **Vì sao Worker phát lại mà hub không kéo về (Winston):** hub giữ nguyên **một** cửa vào duy nhất là `/hooks/*`. Không có module kéo, không có đường ingest thứ hai, không sửa lõi. Lưới hứng chỉ là "provider retry mà mình kiểm soát được".
- **Nhịp phát lại chính là áp lực ngược:** 25 request/phút thì một hàng 5.000 request mất ~3,3 giờ. Đây là chủ ý, cùng tinh thần slow-start BP4: hub vừa thức dậy không bị dội. `CATCHNET_REPLAY_BATCH` chỉnh được.
- **Thứ tự không được đảm bảo:** request mới đi thẳng trong khi hàng cũ đang phát lại. Hub chưa bao giờ hứa thứ tự (Shop cộng dồn có tính giao hoán, ADR-034). Ghi vào EVENT-CATALOG.

### 4.5. Đồng bộ `sources_sync`

- Hub-api gọi `PUT {CATCHNET_URL}/_admin/sources/:key` khi tạo, sửa, lưu trữ source. Lúc khởi động gọi thêm `POST /_admin/sources/resync` (toàn bộ, theo trang). Xác thực bằng `CATCHNET_ADMIN_TOKEN`, so bằng `timingSafeEqual` ở phía Worker.
- Đồng bộ lỗi không chặn việc tạo source: log + metric, có vòng resync mỗi 10 phút. Source chưa sync thì rơi vào nhánh "không có trong bảng" (503 khi hub chết), tức là **an toàn**: không 2xx nếu chưa ghi bền.
- Đường này không chạm Redis.

### 4.6. Test

- `[LH:T4]` (Miniflare/`wrangler dev`, D1 cục bộ) hub sống → phản hồi của hub đi qua nguyên vẹn, D1 rỗng.
- `[LH:T5]` hub chết → D1 có đúng 1 dòng, body **bằng từng byte** với request gốc, provider nhận ack của source (MoMo 204).
- `[LH:T6]` ghi D1 lỗi → 503, không 2xx.
- `[LH:T7]` source không có trong `sources_sync` + hub chết → 503, D1 rỗng.
- `[LH:T8]` phát lại: hub trả 200 duplicate → dòng bị xoá. 401 → `inbox_dead`. 503 → `next_at` lùi.
- `[LH:T9]` VNPay GET kèm query → URL lưu và phát lại giữ nguyên query string.
- `[LH:T10]` trần `CATCHNET_MAX_PER_KEY` → 503 + metric.

## 5. LH3 — Hub nhận request từ lưới hứng

> **Vì sao sửa**
> - **Chuyện gì hỏng (1), cửa sổ thời gian:** Stripe, Standard Webhooks, Slack/Paddle (PK3a) chỉ chấp nhận chữ ký trong ±5 phút. Phát lại sau 20 phút → **401** → sự kiện thật vào `inbox_dead`. Lưới hứng cứu được request, rồi hub tự vứt nó.
> - **Chuyện gì hỏng (2), IP:** mọi request qua Worker mang IP của Cloudflare. Hộp phạt EG2 khoá theo IP. Một kẻ xấu bắn 404 vào Worker là IP Cloudflare bị phạt và **mọi ingest bị chặn**.
> - **Vì sao không tin `CF-Connecting-IP` / `X-Forwarded-For` trực tiếp:** ai gọi thẳng URL Render cũng đặt được hai header đó. Dải IP Cloudflare rất rộng, không ép được vào `TRUST_PROXY` (luật ≥ /8, ADR-176).
> - **Vì sao không cho Worker tự đặt `received_at` mà không ký:** giả được `received_at` là phát lại được một sự kiện Stripe cũ, vượt cửa sổ chống replay.

**Phạm vi:**
1. Worker gửi kèm (cả khi chuyển tiếp lẫn khi phát lại):
   ```
   x-catchnet-id:          <ulid>
   x-catchnet-received-at: <ms epoch>
   x-catchnet-client-ip:   <CF-Connecting-IP>
   x-catchnet-signature:   v1=<HMAC-SHA256(CATCHNET_FORWARD_SECRET, id.received_at.client_ip.method.path_and_query.sha256(body))>
   ```
2. Hub-api kiểm chữ ký bằng `timingSafeEqual`, và `|now - received_at| ≤ CATCHNET_RETENTION_DAYS`. Kiểm xong thì:
   - IP cho hộp phạt / cầu chì = `x-catchnet-client-ip`.
   - `ProviderRequest.receivedAt = x-catchnet-received-at`. Mọi adapter kiểm cửa sổ thời gian phải dùng giá trị này thay `Date.now()`: Stripe truyền `receivedAt` vào `constructEvent` (F4), `swVerify` truyền `nowSec` (F5), PK3a `signed-template` cũng vậy.
   - `raw_events.received_at` = giờ Worker nhận (để mốc khoảng hở và độ trễ đúng). Thêm cột `raw_events.via text NULL` (`'catchnet'`) để console và báo cáo phân biệt được.
   - Chữ ký sai hoặc thiếu → bỏ qua cả 4 header (coi như request thường gọi thẳng), **không** 401. Request gọi thẳng URL Render vẫn chạy như cũ.
3. Idempotency **không đổi**: request phát lại có cùng bytes và cùng id của provider, nên `UNIQUE(source_id, idempotency_key)` của Postgres nuốt bản trùng (hub đã COMMIT nhưng trả lời quá 4s → Worker vẫn ghi D1 → phát lại → `duplicate` 200 → xoá). BB-2 giữ nguyên, D1 không phải trọng tài.
4. Ngân sách Redis: request qua lưới đi đúng đường ingest hiện tại, **không thêm lệnh**. `redis-budget.spec` thêm một ca có header lưới hứng (`[LH:T11]`).
5. `[LH:T12]` Stripe ký lúc T, phát lại lúc T+20 phút kèm `received_at = T` có chữ ký lưới → 202. Cùng request với `received_at` giả (chữ ký lưới sai) → 401.
6. `[LH:T13]` `x-catchnet-client-ip` mà thiếu chữ ký lưới → hộp phạt dùng IP thật của kết nối.

## 6. LH4 — Backfill loại ② (Stripe trước, GitHub sau)

> **Vì sao sửa**
> - **Chuyện gì hỏng:** lưới hứng chỉ cứu được request **đã tới** Worker. Nếu chính Worker hoặc D1 lỗi, hoặc provider gửi trước khi source được sync, thì chỉ còn hỏi lại provider.
> - **Vì sao năng lực tuỳ chọn của adapter:** thêm provider = thêm class (CLAUDE.md). Lõi chỉ gọi `adapter.backfill?.()` nếu adapter có.
> - **Vì sao GitHub để sau:** cần token có quyền đọc hook, mà SPEC-ket-noi để GitHub ở trạng thái hoãn.

**Phạm vi:**
1. `ProviderAdapter.backfill?(ctx: { since: Date; until: Date; credentials }): AsyncIterable<{ rawBody: Buffer; headers: Record<string,string> }>`
2. Kích hoạt khi LH0 ghi một khoảng hở: hub-worker gọi backfill cho mọi source có `recovery.pull = 'list-since'` và có credentials trong `source_connections`. `since = started_at − 5 phút` (biên an toàn).
3. Mỗi item đi qua ingest với `origin = 'reconciliation'`. **Khoá chống trùng phải trùng với webhook gốc** (Stripe: `evt_…`). Nếu không thì cùng một sự kiện được tính hai lần. `[LH:T14]` webhook gốc + backfill cùng sự kiện → 1 event.
4. Stripe: `GET /v1/events?created[gte]=…`. Dữ liệu từ API không có chữ ký webhook, nên adapter đánh dấu `verifiedBy: 'api-credentials'`. Đây là lý do khoá chống trùng phải lấy từ `id`, không lấy từ body hash.

## 7. LH5 — Tra theo mã, loại ③ (PayOS trước, VNPay/MoMo sau PK5)

> **Vì sao sửa**
> - **Chuyện gì hỏng:** VNPay, MoMo, PayOS không có API "đưa tôi mọi giao dịch từ 14:02". Phải có mã giao dịch, mà mã đó **chỉ service của dev biết** (BB-1: hub không biết đơn hàng).
> - **Vì sao dev đưa mã cho hub mà không tự gọi provider:** dev vẫn tự làm được (Shop đang làm, ADR-009). Nhưng ký request QueryDR của VNPay là việc ai cũng ghét và viết sai mỗi người một kiểu. Hub đã giữ credentials mã hoá (`source_connections`), nên hub tra hộ là đúng giá trị dev trả tiền để có.
> - **Vì sao không phá BB-1:** hub nhận `refs` là **chuỗi mờ**, không hiểu nghĩa, không lưu thành bảng đơn hàng.

**Phạm vi:**
1. `POST /v1/p/:project/sources/:id/reconcile` `{ refs: string[] (≤ 50) }`, scope `sources:write`. Trả về từng ref: `found_paid | found_unpaid | not_found | error`.
2. `ProviderAdapter.lookupByRef?(ref, credentials): Promise<{ rawBody; headers } | null>`. PayOS: `GET /v2/payment-requests/{ref}`.
3. Kết quả "đã trả" đi qua ingest với `origin = 'reconciliation'`. Khoá chống trùng phải trùng webhook gốc: PayOS = khoá adapter hiện đang sinh từ webhook (`orderCode` + `reference` của giao dịch, dev kiểm lại `payos.adapter.ts`). Ra `payment.received` đúng khuôn EVENT-CATALOG.
4. Ngân sách: endpoint này **không** nằm trên đường nóng. Rate limit theo project (≤ 1 lần gọi / 10s).
5. `@hub/sdk` thêm `hub.sources.reconcile(sourceId, refs)`. **Đã chốt (Admin, 2026-10-14, phương án a): Shop THAY cron ADR-009.** Cron chỉ gom mã đơn `PENDING` rồi gọi hàm này, bỏ code tự gọi PayOS trong `apps/shop`. Phải giảm dòng, không tăng (trần 600). Ghi ADR sửa ADR-009 (append, không sửa ADR cũ). Shop là ví dụ sống của năng lực này trên demo.
6. `[LH:T15]` webhook PayOS gốc + reconcile cùng mã → 1 event. `[LH:T16]` `refs` > 50 → 422.

## 7b. LH-S — Thử trước bằng Worker nháp (CỔNG: không đạt thì KHÔNG code LH2/LH3)

> **Vì sao có bước này (Admin, 2026-10-14)**
> - **Chuyện chưa biết:** phòng chưa thấy provider nào cấm URL `*.workers.dev`, nhưng **chưa ai thử**. Một số dịch vụ chặn domain dùng chung vì domain đó hay bị lạm dụng. Nếu PayOS từ chối thì cả §9 sai, và mọi code LH2/LH3 viết trước đó thành vô ích.
> - **Vì sao thử bằng Worker nháp mà không bằng code thật:** Worker nháp chỉ ~50 dòng, vứt đi được. Nó không chạm hub, không chạm Shop, không chạm source thật. Thử sai thì không có gì phải hoàn tác trong repo.
> - **Vì sao chuyển bytes nguyên vẹn cũng phải thử ngay ở đây:** nếu Cloudflare chuẩn hoá header hay body (gzip, xuống dòng, thứ tự header) thì HMAC sai 100%. Chuyện này phải biết trước khi thiết kế phát lại, không phải sau.

**Phạm vi:**

0. Làm §7c trước (hướng dẫn tài khoản Cloudflare). Chưa có tài khoản thì không deploy được gì.
1. Thư mục `spikes/catchnet-spike/` (KHÔNG nằm trong `apps/`, không vào build). Worker tên **`hub-hooks-spike`**. Không dùng tên thật `hub-hooks`, vì tên thật là bất biến (§9).
   - Mọi request vào `/hooks/*` → ghi D1 nháp: method, URL đầy đủ, toàn bộ header, độ dài body, `sha256(body)`, body (≤ 1MB) → trả 200 `{"ok":true}`. Riêng path `/hooks/momo/*` trả 204.
   - `GET /_spike/dump?token=…` → xem các dòng đã ghi (token ngẫu nhiên, so bằng `timingSafeEqual`).
   - Có Cron Trigger mỗi phút, ghi một dòng `cron_tick` để chứng minh cron chạy trên gói free.
2. **Duyệt một lần cho cả đợt thử (Admin, 2026-10-14):** dev được `wrangler deploy`/`delete` Worker **`hub-hooks-spike`** và D1 nháp, tạo/xoá webhook nháp ở Stripe (test mode), GitHub (repo nháp), SePay, và chạy S2 trên kênh PayOS thật theo cách dưới, **không hỏi lại từng bước**. Mọi thứ ngoài danh sách này (Worker tên thật `hub-hooks`, Render, Neon, biến môi trường prod) vẫn phải hỏi.
3. Kiểm từng provider, ghi kết quả vào `_bmad-output/planning-artifacts/hub-sap/SPIKE-workers-dev.md`:

| # | Provider | Cách thử | Đạt khi |
|---|---|---|---|
| S1 | **Stripe** | Chế độ **test mode**: tạo webhook endpoint trỏ URL nháp bằng API (`sk_test_…`), `stripe trigger payment_intent.succeeded`, rồi **xoá endpoint** | Stripe chấp nhận URL; request tới; verify chữ ký **offline** bằng `whsec_` của endpoint nháp trên đúng body đã lưu → khớp |
| S2 | **PayOS** | **Admin chọn (ii), 2026-10-14: dùng kênh thật.** ⚠️ `confirm-webhook` ghi đè URL webhook của kênh (ADR-149). Làm lúc ít đơn, giữ ≤ 10 phút. Trước khi thử: ghi lại URL hiện tại của kênh. Thử xong: bấm "Kết nối lại" ở console → kiểm `status()` = `CONNECTED` → gọi reconcile của Shop một lần cho các đơn tạo trong khung giờ thử. Ghi giờ bắt đầu/kết thúc vào file SPIKE | `confirm-webhook` trả thành công; request kiểm tra của PayOS có trong D1; HMAC theo `checksumKey` trên `data` đã lưu → khớp |
| S3 | **GitHub** | Repo **nháp** của Admin, thêm webhook trỏ URL nháp, secret thử; sự kiện `ping` + một `push` | GitHub nhận URL; deliveries báo 200; `X-Hub-Signature-256` verify offline → khớp |
| S4 | **SePay** | Dashboard SePay, thêm webhook trỏ URL nháp, nút gửi thử (nếu có) | SePay lưu được URL; request tới D1 |
| S5 | Bytes | So `sha256(body)` trong D1 với body provider gửi (S1/S3 đối chiếu được qua chữ ký) | Không lệch byte nào; header chữ ký còn nguyên |
| S6 | Gói free | Cron chạy ≥ 10 lần liên tiếp; một lần chạy làm ≥ 25 `fetch` ra ngoài | Không lỗi giới hạn subrequest/CPU |
| S7 | Độ trễ | 20 request Worker → Render (đang thức và đang ngủ), ghi p50/max | Chỉ ghi số để chọn `CATCHNET_FORWARD_TIMEOUT_MS`. **Không** đưa vào báo cáo hiệu năng (ADR-019) |

4. **Cổng:**
   - S1–S3 + S5 đạt → được code LH2/LH3.
   - S2 (PayOS) trượt → **dừng**, báo phòng kèm thông báo lỗi nguyên văn của PayOS. Không tự đổi phương án URL (phải quay lại §9 với Admin).
   - S4/S6/S7 trượt → ghi §16, báo phòng, chưa chặn.
5. **Dọn sau khi thử:** xoá webhook nháp ở Stripe/GitHub/SePay; PayOS trả URL kênh về như cũ (nếu dùng kênh thật); `wrangler delete hub-hooks-spike` + xoá D1 nháp (hỏi Admin). Ghi đã dọn gì vào file SPIKE.
6. Không commit secret nào. Token, `whsec_`, `sk_test_` chỉ để trong `.dev.vars` (đã `.gitignore`, dev kiểm) và chạy gitleaks trước push.

## 7c. Hướng dẫn lấy tài khoản Cloudflare → `KEYS-CAN-LAY.md` (việc ĐẦU TIÊN của LH-S)

> **Vì sao:** `workers.dev` là domain của Cloudflare, nên bắt buộc có một tài khoản Cloudflare gói free (không thẻ, không domain, không DNS). Admin tự tạo bằng email của Admin. Dev không tạo hộ, vì tài khoản và subdomain là vĩnh viễn (§9).

**Dev làm, trước mọi bước khác của LH-S:**

1. **Thêm** (append, KHÔNG ghi đè) mục mới vào `C:\webhook-hub\KEYS-CAN-LAY.md`, tiêu đề `## J. Cloudflare — lưới hứng (workers.dev + D1)`, đúng giọng và khuôn của các mục A–I sẵn có: các bước đánh số, khối ` ```env ` để Admin điền sau dấu `=`, ô tự sinh ghi _"để trống = coordinator tự sinh"_.
   - File này **không vào git** (`.git/info/exclude`) và đang chứa secret thật. Dev **không đọc to, không chép, không trích** giá trị nào của các mục khác vào commit, log, spec hay tin nhắn. Kiểm lại `git check-ignore -v KEYS-CAN-LAY.md` trước khi sửa.
2. Nội dung mục J phải có (dev tra lại giao diện Cloudflare hiện tại; tên nút lệch thì giao diện thật thắng):
   - **J1. Đăng ký:** `https://dash.cloudflare.com/sign-up`, email của Admin, xác minh mail. Không cần thêm website/domain; gặp màn "Add a site" thì bỏ qua. **Không nhập thẻ.**
   - **J2. Đặt subdomain `workers.dev`:** Workers & Pages → mục subdomain → nhập **`webhook-hub`**. Ghi rõ: **tên này vĩnh viễn**, đổi là mọi provider phải đăng ký lại URL. Nếu `webhook-hub` đã có người dùng thì **dừng, báo coordinator**, không tự chọn tên khác.
   - **J3. Account ID:** lấy ở trang Workers & Pages (cột phải) hoặc trang Overview → điền `CLOUDFLARE_ACCOUNT_ID`.
   - **J4. API token cho `wrangler`:** My Profile → API Tokens → Create Token → mẫu **"Edit Cloudflare Workers"**, thêm quyền **Account › D1 › Edit**, giới hạn đúng tài khoản này, đặt hạn dùng (vd 90 ngày) → điền `CLOUDFLARE_API_TOKEN`. Nói rõ token chỉ hiện một lần. Ghi cách thay thế: Admin tự gõ `! npx wrangler login` trong phiên Claude Code (đăng nhập bằng trình duyệt, khỏi tạo token).
   - **J5. Secret tự sinh (để trống):** `CATCHNET_ADMIN_TOKEN`, `CATCHNET_FORWARD_SECRET`, token `/_spike/dump`.
   - **J6. Kiểm:** `npx wrangler whoami` in đúng email và account → báo coordinator.
   - Khối env mẫu:
     ```env
     # Cloudflare (J)
     CLOUDFLARE_ACCOUNT_ID=
     CLOUDFLARE_API_TOKEN=
     CATCHNET_WORKERS_SUBDOMAIN=webhook-hub
     CATCHNET_ADMIN_TOKEN=          # để trống = coordinator tự sinh
     CATCHNET_FORWARD_SECRET=       # để trống = coordinator tự sinh
     CATCHNET_SPIKE_DUMP_TOKEN=     # để trống = coordinator tự sinh
     ```
3. Báo coordinator "đã thêm mục J". **Chờ Admin điền xong và `wrangler whoami` chạy được** mới deploy Worker nháp.
4. Các key provider dùng cho S1–S4 mà file chưa có (`sk_test_` Stripe test mode, secret webhook nháp GitHub) → thêm luôn vào mục J (J7) theo cùng khuôn, kèm cách lấy.

## 8. LH6 — Chaos LOCAL (số liệu báo cáo lấy ở đây)

- Compose `hubv` thêm service `catchnet` (`wrangler dev --local`, D1 SQLite cục bộ).
- `verify:chaos` thêm kịch bản `catchnet-outage`: bắn 500 webhook (PayOS + Stripe + GitHub + generic) qua Worker, `docker stop hub-api` ở request thứ 100, `start` lại ở request 400. Kỳ vọng: **500 event, không trùng, không thiếu**, `inbox` rỗng sau ≤ 20 phút, `outage_gaps` có đúng một dòng.
- k6 vẫn bắn **thẳng localhost hub-api** (cạm bẫy 5). Thêm một kịch bản k6 riêng đo chặng Worker → hub để báo cáo chi phí độ trễ của lưới hứng. Không trộn với số p95 hiện có.

## 9. URL công khai

**Sự thật không né được:** URL hiện tại thuộc domain của Render (`*.onrender.com`). Cloudflare không đứng trước được domain mình không sở hữu. Nên **mọi phương án đều phải đổi URL ít nhất một lần** cho source đã có. Câu hỏi thật là: **đổi một lần cho mãi mãi**, tức là URL ingest nằm trên domain mình kiểm soát. Sau lần đó, chuyển backend (Render → bất cứ đâu) không còn bắt dev đăng ký lại webhook.

| Phương án | Chi phí | Đổi URL | Ghi chú |
|---|---|---|---|
| **U-A** `https://<tên>.<account>.workers.dev/hooks/…` | $0 | 1 lần | Domain thuộc Cloudflare. Rời Cloudflare là đổi lần nữa |
| **U-B** domain riêng (vd `hooks.<tên>.id.vn`) trỏ DNS về Cloudflare, Worker gắn route | Tiền domain/năm (dev tra giá) | 1 lần, rồi **không bao giờ** | Đúng cách Stripe/GitHub giữ URL không đổi. Vượt "$0" |
| **U-C** chạy song song (đi kèm A hoặc B) | — | Từ từ | Source **mới** nhận URL lưới ngay. Source **cũ** giữ URL Render (vẫn chạy, **không** được bảo vệ), console gắn nhãn *"Chưa được lưới hứng bảo vệ"* + nút **"Chuyển URL"** |

**Chuyển URL đỡ bất tiện tới đâu (theo F8):**
- PayOS, Stripe: tự động. Đổi `HUB_INGEST_PUBLIC_URL` → `status()` báo `DRIFTED public_url_changed` → nút "Kết nối lại" gọi `confirm-webhook` / cập nhật endpoint Stripe. Cơ chế đã có.
- GitHub, SePay, generic: tay. Console hiện URL mới + nút sao chép + checklist từng bước. Nút "Đã đổi" chỉ tắt nhãn khi **request đầu tiên qua lưới hứng** của source đó tới (có `via = 'catchnet'`), không tin lời bấm.

**ĐÃ CHỐT (Admin, 2026-10-14): U-C + U-A.** Không mua domain lúc này. U-B ghi vào "hướng phát triển".

**Luật cho U-A (vì URL `workers.dev` ghép từ tên Worker và subdomain tài khoản):**
- URL có dạng `https://<tên-worker>.<subdomain-tài-khoản>.workers.dev/hooks/:provider/:sourceKey`. **Đổi tên Worker hoặc đổi subdomain tài khoản = đổi URL của MỌI source.** Chọn một lần, ghi vào ADR-220, coi như bất biến.
- Tên Worker cố định trong `wrangler.toml` (`name = "hub-hooks"` hoặc tên Admin chọn). Không deploy thêm Worker khác cùng tên cho môi trường khác. Môi trường thử dùng tên riêng (`hub-hooks-staging`).
- Đã chốt: subdomain tài khoản **`webhookhub`** (`webhook-hub` đã có người dùng, Admin đổi 2026-10-14), tên Worker **`hub-hooks`** → `https://hub-hooks.webhookhub.workers.dev`.
- `HUB_INGEST_PUBLIC_URL` = URL `workers.dev` đó. `HUB_ORIGIN_URL` của Worker = URL Render thật.
- Dev kiểm trước khi bật: PayOS `confirm-webhook` và Stripe tạo endpoint **chấp nhận** URL `*.workers.dev`. Bị từ chối thì ghi §16 và báo phòng, **không** tự đổi phương án.

**Việc làm được ngay, không phụ thuộc lựa chọn:** tách `HUB_INGEST_PUBLIC_URL` (URL provider gọi vào) khỏi `HUB_PUBLIC_URL` (API, console). Mọi chỗ ở F9 và connector dùng biến mới. Thiếu biến mới thì rơi về `HUB_PUBLIC_URL` như cũ. Đây là một commit riêng (`[LH:T17]`).

## 10. LH7 — Giấy phải khớp code

- `docs/ARCHITECTURE.md`:
  - BB-3 thêm một câu: *"COMMIT = lần ghi bền đầu tiên; có thể là D1 của lưới hứng (ADR-21x)"*.
  - Thêm mục "Khi hub gián đoạn": bảng §1.1 và sơ đồ §4.1.
  - Q&A thêm *"Nếu hub sập?"*.
- `docs/DEPLOYMENT.md`: thêm Cloudflare (Worker + D1) vào bảng nhà cung cấp, kèm ràng buộc gói free (§1.2), biến môi trường (§13), `wrangler` deploy. D1 location hint `apac` (dev tra lại).
- `docs/EVENT-CATALOG.md`: thứ tự sự kiện **không** được đảm bảo (đúng từ trước, giờ ghi rõ).
- `docs/FOR-EXAMINERS.md`: câu trả lời mẫu cho câu hỏi hội đồng "hub sập thì sao".
- Sơ đồ `docs/diagrams/webhook-hub-luong-chi-tiet.drawio`: thêm trang lưới hứng.

## 11. Story và thứ tự

| # | Story | Phụ thuộc | Ghi chú |
|---|---|---|---|
| 0 | **LH-S thử bằng Worker nháp** | Admin duyệt deploy + tài khoản provider | **Cổng.** Không đạt S1–S3+S5 thì dừng |
| 1 | §9 commit tách `HUB_INGEST_PUBLIC_URL` | — | Nhỏ, làm được song song với LH-S |
| 2 | LH0 sổ khoảng hở | — | |
| 3 | LH3 hub nhận request từ lưới (chữ ký lưới, IP, `receivedAt`) | LH-S đạt | Phải xong **trước** khi bật Worker |
| 4 | LH2 Worker + D1 + phát lại | LH3 | |
| 5 | LH6 chaos LOCAL | LH2, LH3 | Bằng chứng cho báo cáo |
| 6 | LH1 `recovery` + nhãn 🛡️ | PK2 (danh mục) | Nếu PK2 chưa có thì khai `recovery` trên adapter trước |
| 7 | LH5 reconcile PayOS | — | VNPay/MoMo sau PK5 |
| 8 | LH4 backfill Stripe | LH0 | GitHub khi SPEC-ket-noi mở lại GitHub |
| 9 | LH7 giấy | tất cả | |

## 12. ADR (ghi khi làm, mỗi ADR 3 dòng)

| ADR | Story | Tiêu đề |
|---|---|---|
| 211 | §9 | Tách `HUB_INGEST_PUBLIC_URL` khỏi `HUB_PUBLIC_URL` |
| 212 | LH0 | Sổ khoảng hở trong Postgres (bảng hạ tầng, không `tenant_id`), heartbeat 60s, 0 Redis |
| 213 | LH1 | `recovery` là dữ liệu của adapter/danh mục; "không rõ" thay vì đoán |
| 214 | LH2 | Lưới hứng Cloudflare Worker + D1, ghi xuyên timeout 4s; **BB-3: COMMIT = lần ghi bền đầu tiên**; Worker không giữ secret, không verify |
| 215 | LH2 | Ack "đã nhận" khi hub vắng (VNPay `00` cả khi chữ ký sai, request vẫn bị từ chối khi phát lại) |
| 216 | LH2 | Worker tự phát lại vào `/hooks/*`, hub không có đường ingest thứ hai; nhịp 25/phút là áp lực ngược có chủ ý |
| 217 | LH3 | Header lưới hứng có chữ ký HMAC; `receivedAt` của Worker dùng cho cửa sổ thời gian khi verify; IP cho hộp phạt lấy từ header đã ký |
| 218 | LH4 | `backfill(since)` tuỳ chọn trên adapter, khoá chống trùng phải trùng webhook gốc |
| 219 | LH5 | `reconcile(refs)`: refs là chuỗi mờ (BB-1); hub tra hộ bằng credentials đã lưu |
| 220 | §9 | URL ingest = `workers.dev` (U-A) chạy song song URL Render cho source cũ (U-C); tên Worker + subdomain tài khoản là bất biến |

## 13. Biến môi trường mới

| Biến | Ở đâu | Mặc định | Ghi chú |
|---|---|---|---|
| `HUB_INGEST_PUBLIC_URL` | hub-api | = `HUB_PUBLIC_URL` | URL provider gọi vào |
| `CATCHNET_URL` | hub-api | trống = tắt đồng bộ | URL Worker (cho `/_admin/*`) |
| `CATCHNET_ADMIN_TOKEN` | hub-api + Worker secret | — | ≥ 32 byte ngẫu nhiên |
| `CATCHNET_FORWARD_SECRET` | hub-api + Worker secret | — | HMAC header lưới hứng. Hỗ trợ hai giá trị khi xoay khoá (`,`) |
| `HUB_ORIGIN_URL` | Worker | — | URL Render thật để chuyển tiếp |
| `CATCHNET_FORWARD_TIMEOUT_MS` | Worker | 4000 | Kẹp 1000..8000 |
| `CATCHNET_REPLAY_BATCH` | Worker | 25 | Kẹp 1..40 |
| `CATCHNET_RETENTION_DAYS` | Worker + hub-api | 7 | |
| `CATCHNET_MAX_PER_KEY` / `CATCHNET_MAX_ROWS` | Worker | 2000 / 50000 | |

## 14. Cố tình không làm

- **Worker verify chữ ký.** Secret chỉ ở một nơi.
- **Luôn hứng** (mọi request vào D1 trước). Phá p95 và số đo hiện có.
- **Hub kéo từ D1** (đường ingest thứ hai). Worker phát lại vào `/hooks/*`.
- **Lưu inbox vào Upstash Redis / QStash.** BB-2, và QStash không trả được 204.
- **Giữ thứ tự sự kiện** qua lưới hứng.
- **Tự động phát lại `inbox_dead`.** Dev bấm trên console (sau, không trong đợt này).
- **Đo p95 lưới hứng trên deployed** (ADR-019). Chỉ chứng minh online thật.
- **Hứa "không bao giờ mất".** Worker + D1 cùng chết, cộng provider không retry, thì vẫn mất. Nhãn 🛡️ nói đúng điều đó.

## 15. Câu hỏi mở cho Admin

- ~~Q1 (§9)~~ **Đã chốt 2026-10-14:** U-C + U-A (`workers.dev`, không mua domain).
- ~~Q2~~ **Đã chốt 2026-10-14:** giữ 7 ngày.
- ~~Q3~~ **Đã chốt 2026-10-14:** (a) Shop thay cron ADR-009 bằng `reconcile(refs)`.
- ~~Q4~~ **Đã chốt 2026-10-14:** Admin tự tạo tài khoản Cloudflare free theo hướng dẫn dev viết vào `KEYS-CAN-LAY.md` (§7c). Subdomain tài khoản = **`webhookhub`** (`webhook-hub` bị chiếm) → URL thật `https://hub-hooks.webhookhub.workers.dev`, URL nháp `https://hub-hooks-spike.webhookhub.workers.dev`.

## 15b. Checklist story (tick khi review ĐẠT; regex `\[x\] \*\*(LH[\w-]*)\*\*` của `verify:map`)

- ✅ LH-S (spike, không có mã test nên không dùng dạng tick của `verify:map`) — spike Worker nháp: cổng ĐẠT (S1 Stripe, S2 PayOS kênh thật, S3 GitHub, S5 bytes), S6 đạt, S7 mới đo lúc hub thức, S4 SePay hoãn. Kết quả ở `SPIKE-workers-dev.md`
- [x] **LH-URL** — §9 tách `HUB_INGEST_PUBLIC_URL` (`[LH:T17]`, ADR-211). REVIEW-LH-URL ĐẠT (0 Nặng / 0 TB). Nợ Thấp L1–L6 ghi ở §16
- [ ] **LH3** — hub nhận request từ lưới (H1, H3, H4, H5): `[LH:T11]`–`[LH:T13]`, `[LH:T18]` (phía hub), `[LH:T19]` (H4, sửa REVIEW-LH-URL L1), `[LH:T20]` (H5), `[LH:T21]` (H1); ADR-217, ADR-221
- [ ] **LH2** · [ ] **LH0** · [ ] **LH6** · [ ] **LH5** · [ ] **LH1** · [ ] **LH4** · [ ] **LH7**

## 16. Ghi chú / nợ phát hiện khi code

- **LH-URL (REVIEW-LH-URL, Thấp):**
  - **L1:** trước LH3, `publicHooksUrl()` dùng base ingest cho mọi request. **Không đặt `HUB_INGEST_PUBLIC_URL` trên Render trước khi LH3 lên.**
  - **L2:** biến đặt sai thì chỉ nút Kết nối báo 422. Nên kiểm biến lúc khởi động ở production.
  - **L3:** `connect()`, `connectExisting()` và trường `ingestUrl` của controller chưa có test.
  - **L4:** `ingestUrl` chưa có trong response PATCH và connect.
  - **L5:** chữ cũ còn trong `docsVersion` Twilio, `DEPLOYMENT.md:657`, `HUONG-DAN-DEPLOY.md:145`.
  - **L6:** ADR-220 được nhắc tới nhưng chưa ghi (sẽ ghi ở LH2/§9 khi bật Worker thật).
  - Message của commit `013caf3` ghi "DỞ DANG", nhưng nội dung đã hoàn tất ở `4430304`.
- **LH-S:**
  - Header tới Worker bị viết thường và đổi thứ tự.
  - Cloudflare tự thêm `cf-*`, `x-real-ip`, `x-forwarded-proto`; LH2 phải bỏ khi chuyển tiếp.
  - Lần deploy đầu, cron chạy chậm vài phút.

_(dev ghi vào đây; lệch với tài liệu provider hoặc trang giá Cloudflare thì trang chính thức thắng)_
