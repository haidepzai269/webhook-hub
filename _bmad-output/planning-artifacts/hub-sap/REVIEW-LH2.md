# REVIEW-LH2 — lưới hứng Cloudflare Worker `hub-hooks` + D1

**Reviewer:** Winston (kiến trúc) · **Ngày:** 2026-10-15 · **Nhánh:** `feat/lh` (worktree `C:\wt\lh`)
**Phạm vi:** `cbe263e`, `64d8a67`, `3163882`, `15d11a3` (diff `eb7eebc..15d11a3`; `eb7eebc` là merge master, không soi)

**Đối chiếu với:** `CLAUDE.md` (BB-1..5), SPEC-hub-sap (ĐÍNH CHÍNH H1–H13, §4, §16 T-5/T-7, mục "LH2 đã làm / nợ"), ADR-211/214–217/221–223, code LH3 phía hub (`apps/hub-api/src/modules/ingest/catchnet.ts`, `hub-outcome.ts`, `ingest.service.ts` `outcomeOf`, `penalty-gate.ts`, `main.ts`), vector `libs/crypto/test/fixtures/catchnet-vectors.json`, `LH2-VIEC-MAY-CONG-TY.md`.

**Đã chạy (máy nhà, không docker, không wrangler):**
- `apps/catchnet`: `npx vitest run` → 3 file, **24/24 pass**. `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npx jest --maxWorkers=1 apps/hub-api/test/edge-nginx.spec.ts` → **15 pass, 3 skip** (cần nginx thật), 0 fail.
- `npm query .workspace` ở gốc → `catchnet` **không** nằm trong workspaces (map-workspaces của npm 10.9.2 hỗ trợ mẫu `!`). Lock gốc không có mục `apps/catchnet`.
- Thử nhanh WHATWG URL trên Node: `new URL(origin + "/hooks/%2e%2e/api/v1/x").href` → `…/api/v1/x` (dùng cho L2).

## Kết luận: **CHƯA ĐẠT** — 0 Nặng · 4 TB · 11 Thấp

Lõi đúng hướng:
- BB-3 được giữ ở mọi nhánh trả lời: 2xx chỉ có hai nguồn, là phản hồi của hub (hub đã COMMIT) hoặc `ackResponse` sau khi `insertCaught` trả `changes === 1`.
- Ký khớp từng byte với LH3: dùng chung vector, ký đúng `href` đưa vào `fetch`, header đặt bằng `set`, METHOD viết hoa.
- Body giữ nguyên bytes.
- Bảng phân loại phản hồi đúng thứ tự H1/H2/T-5.

Bốn mục TB đều nằm ở đường *sẵn sàng* chứ không ở đường *đúng*:
- mạch 30s chặn cả request không được hứng;
- trần chỉ đếm dòng, không đếm byte và quota;
- một lượt cron không có lease, ngân sách chưa đo;
- chưa có cổng nào chặn việc bật Worker trước LH2b.

---

## TB (Trung bình) — phải sửa trước khi tick LH2

### TB-1. Khi mạch "hub chết" mở, request không được hứng nhận 503 mà không hề được chuyển tới hub

**Chỗ:** `apps/catchnet/src/worker.ts:159-168` (bỏ qua chuyển tiếp khi `receivedAt < circuit.openUntil`) và `worker.ts:186` (`!catchable → 503`).

**Lệch spec:**
- §4.1 xét `sources_sync` **trước**: "sourceKey không có trong sources_sync → chuyển tiếp hub; hub lỗi → 503".
- Mạch chỉ áp cho nhánh sẽ hứng: "mạch đang mở → bỏ qua chuyển tiếp, **ghi D1 luôn**".
- Code thì áp mạch cho **mọi** request, rồi mới xét `catchable`.

**Kịch bản:**
1. Neon autosuspend thức dậy chậm, hoặc một request verify nặng, làm một lần ingest vượt 4s. Mạch mở 30s trong isolate đó.
2. LH2b chưa có, nên `sources_sync` rỗng và **mọi** source đều "không được hứng".
3. Trong 30s đó, mọi webhook vào isolate nhận 503 ngay, dù hub đã sống lại sau 1s.
4. GitHub không gửi lại, nên các sự kiện đó chỉ còn trong "Recent deliveries" chờ bấm tay.
5. Khi gọi thẳng Render (trước LH2), cùng request đó chờ được tới 10s và thành công.

Kể cả khi đã có LH2b, các request sau vẫn dính cùng lỗi:
- GET bắt tay (Meta `hub.challenge`);
- provider lệch;
- source chưa kịp sync.

Với các request đó Worker **tệ hơn** gọi thẳng.

**Sửa:**
- Khi mạch mở: `getSource` + `catchable` trước.
- Hứng được thì ghi D1 luôn. Không hứng được thì vẫn chuyển tiếp như thường, tức là mạch không áp cho nhánh này.
- Thêm ca test vào `[LH:T5]` (phần c): source không có trong `sources_sync`, mạch đang mở, hub sống → nhận phản hồi của hub, không phải 503.

### TB-2. Trần chống xả rác đếm *dòng*, không đếm *byte* và không khớp quota D1 free

**Chỗ:** `apps/catchnet/src/config.ts:320-321` (mặc định 2.000/key, 50.000 toàn bảng), `store.ts:67-78`, `migrations/0001_init.sql:236-256`. Câu quota trong ADR-214 ("≈ 4 dòng ghi mỗi lần hứng → quota free 100k/ngày ≈ 25k lần hứng") tự mâu thuẫn với `MAX_ROWS = 50.000`.

**Kịch bản:**
1. Render free ngủ hằng ngày. Request đầu đánh thức Render, timeout 4s, mạch mở. Từ đó mọi request có `sourceKey` hợp lệ đi thẳng vào D1.
2. `sourceKey` nằm công khai trong URL webhook. Ai biết nó (một provider, log của bên thứ ba, ảnh chụp màn hình) cũng gửi được body ≤ 1MB.
3. Theo **byte:** 2.000 dòng × 1MB = **2GB** cho một key. D1 free giới hạn một database **500MB** (theo hiểu biết của reviewer; dev phải tra lại trang chính thức như §1.2 yêu cầu).
   - DB đầy thì mọi `INSERT` lỗi → 503 cho **mọi** source. Đúng BB-3 nhưng lưới chết.
   - `moveDead` (INSERT vào `inbox_dead`) cũng lỗi, nên dòng hỏng không rời được hàng.
4. Theo **quota ghi:** chưa chạm trần dòng thì đã hết quota. Khoảng 25k lần hứng là đã đốt hết 100k dòng ghi/ngày.
   - Từ đó tới 00:00 UTC, mọi `deleteRow`/`markRetry` của cron đều lỗi.
   - Dòng hợp lệ đã ack 2xx nằm im, cron gửi lại cùng 25 dòng đầu mỗi phút. Hub nuốt bản trùng nên vô hại, nhưng không tiến được.
5. Trần theo key chỉ bảo vệ *các key khác về số dòng*, không bảo vệ được dung lượng hay quota dùng chung.

**Sửa (chọn tối thiểu):**
- Thêm bộ đếm **byte** trong `inbox_count` (cột `bytes`, cùng trigger), trần `CATCHNET_MAX_BYTES` toàn bảng (vd 300MB) và theo key (vd 50MB).
- Hạ `CATCHNET_MAX_ROWS` mặc định xuống dưới quota ghi/ngày, vd 15.000.
- Sửa câu quota trong ADR-214, ghi nguồn đã tra.

### TB-3. Lượt cron không có lease và ngân sách chưa được chứng minh, nên dòng đầu hàng có thể chặn cả hàng tới khi hết hạn 7 ngày

**Chỗ:**
- `apps/catchnet/src/store.ts:81-87`: `dueRows` lấy cả BLOB của 25 dòng **trong một câu**.
- `worker.ts:273-279`: `replayOne` lỗi → log, trả `'ok'`, **không** `markRetry`.
- `worker.ts:207-252`: `next_at` chỉ được đẩy **sau** khi gọi hub.
- `config.ts:318`: kẹp batch tới 40.

**Kịch bản:**
1. Trên Workers, D1 trả BLOB dạng **mảng số**, như comment `toBytes` của dev đã ghi. Một body GitHub `push` 500KB thành mảng JS 500k phần tử. 25 dòng như vậy thì vài chục MB mảng số, cộng `Uint8Array.from`, cộng sha256 + 2 HMAC mỗi dòng.
2. Theo hiểu biết của reviewer (chưa đối chiếu trang chính thức), gói free cho mỗi invocation, kể cả cron:
   - CPU 10ms;
   - bộ nhớ 128MB;
   - 50 truy vấn D1;
   - 50 subrequest ra ngoài.
3. Đếm truy vấn D1 của một lượt: `dueRows` 1, cộng 1 cho mỗi dòng, hoặc 2 nếu `moveDead` dùng `batch` mà D1 đếm theo từng câu.
   - Lượt toàn dòng chết: 25 → khoảng 51.
   - Kẹp 40 → tới khoảng 81.
4. Hệ quả khi vượt (invocation bị giết, hoặc truy vấn thứ 51 ném lỗi): những dòng chưa tới `markRetry`/`deleteRow` giữ nguyên `next_at`. Vì `ORDER BY next_at`, phút sau **đúng các dòng đó** lại đứng đầu, lại vượt, lặp mãi.
5. Sau 7 ngày, cả hàng thành `expired` → `inbox_dead`. Đây là sự kiện Worker **đã trả 2xx** cho provider (lời hứa BB-3 của ADR-214), và không có cảnh báo nào ngoài dòng log JSON.
6. Cùng cơ chế: một dòng làm `replayOne` ném lỗi lặp lại (D1 lỗi khi `markRetry`, dữ liệu dòng hỏng) giữ chỗ đầu hàng mãi, vì nhánh `catch` không đẩy `next_at`.

**Sửa:**
- **Lease trước khi gửi.** Một câu `UPDATE inbox SET next_at = now + 5m WHERE id IN (…)` cho cả lô vừa chọn, hoặc `UPDATE … RETURNING` để chọn và giữ chỗ cùng lúc. Lượt bị giết thì dòng tự lùi chứ không đứng đầu mãi.
- **Hai bước:** `SELECT id, length(body)` theo index trước, rồi nạp body **từng dòng** khi gửi. Dừng lô khi tổng byte vượt ngân sách (vd 2MB/lượt).
- Kẹp `CATCHNET_REPLAY_BATCH` theo ngân sách truy vấn D1 đã **tra lại** (H10/§4.4 "dev tra lại"). Ghi số và nguồn vào §16.
- Nhánh `catch` ở `worker.ts:275` gọi `markRetry` theo kiểu best-effort.
- `LH2-VIEC-MAY-CONG-TY.md` thêm bước đo trên workerd: lô 25 dòng × body 1MB, ghi CPU ms, bộ nhớ, số truy vấn D1.

### TB-4. Tách LH2b được, nhưng thiếu cổng chặn bật Worker; không có LH2b thì Worker tệ hơn gọi thẳng

**Chỗ:**
- `SPEC-hub-sap.md` mục "LH2 … Nợ (1)" chỉ *đề xuất* LH2b.
- Bảng thứ tự H12 và checklist §15b không có LH2b.
- `docs/DEPLOYMENT.md` không có điều kiện bật.
- ADR-215 ghi "nợ §16".

**Lý do tách tạm được:**
- Phía Worker của §4.5 đã có: `/_admin/sources/*`, resync theo trang, token constant-time.
- Phía hub đẩy dữ liệu sang là code hub-api, có giao diện tới `buildAck`, vòng 10 phút và log/metric riêng. Thành một story riêng là hợp lý.

**Vì sao chưa thể coi lưới là "xong":**
- Khi `sources_sync` rỗng, mọi request lúc hub vắng đều nhận 503.
- Với cold start của Render (30–60s), provider gọi qua Worker nhận 503 sau 4s, rồi thêm 30s 503 do mạch (TB-1). Gọi thẳng thì cùng request đó chờ được Render thức.
- Đổi `HUB_INGEST_PUBLIC_URL` sang `workers.dev` trước LH2b là **lùi**, không phải tiến.

**Sửa:**
- Ghi LH2b vào bảng H12 (sau LH2, **trước** LH6) và vào checklist §15b.
- Thêm cổng tường minh vào DEPLOYMENT §3.6 và vào ADR-214/215: "không trỏ source nào vào `workers.dev` và không deploy Worker thật trước khi LH2b ĐẠT".
- Tick LH2 ở §15b với nhãn "phần Worker" để `verify:map` không hiểu nhầm là lưới đã chạy.

---

## Thấp

**L1. `changes === 1` có thể sai trên D1 thật** (`store.ts:77`).
- `INSERT` kéo theo hai trigger. node:sqlite trả `sqlite3_changes()` (chỉ tính dòng trực tiếp), nhưng chưa chắc D1 `meta.changes` tính như vậy.
- Nếu D1 đếm cả dòng trigger thì Worker ghi xong mà vẫn trả 503 (BB-3 vẫn an toàn) và lưới không bao giờ trả ack.
- Dùng `changes > 0`. Bước 3(a) ở máy công ty sẽ bắt được.

**L2. Target sau chuẩn hoá có thể rời `/hooks/*`** (`sign.ts:68-73`, `worker.ts:141`, `worker.ts:351`).
- Kiểm tra `^/hooks` chạy trên target **thô**. `requestTarget` gọi `new URL`, mà `new URL` gộp `%2e%2e`: `/hooks/%2e%2e/api/v1/x` → `/api/v1/x`.
- Nếu workerd giữ `%2e%2e` trong `req.url`, Worker sẽ chuyển tiếp (kèm `Authorization`/cookie và header lưới) tới API hub bất kỳ. Khi đó Worker thành proxy cho toàn bộ hub, đi ra từ IP Cloudflare.
- Không vào D1, vì `HOOK_RE` khớp trên target thô.
- Sửa: sau `requestTarget`, kiểm `HOOK_RE` trên path của target đã chuẩn hoá; lệch thì trả 404.

**L3. 2xx thiếu `x-hub-outcome` vẫn được coi là thành công** (`classify.ts:182`, `classify.ts:209`).
- ADR-221 bảo đảm mọi 2xx của `/hooks` đều mang outcome (lớp 1).
- Nếu `HUB_ORIGIN_URL` đặt nhầm sang một host fallback 200 (SPA, trang bảo trì), Worker sẽ trả 200 cho provider và phát lại sẽ **xoá** dòng. Sự kiện mất lặng lẽ.
- Sửa: 2xx không outcome → coi là "hub vắng" khi chuyển tiếp, retry khi phát lại, và log `catchnet_misconfigured`.

**L4. Thiếu secret thì vẫn chuyển tiếp, không ký** (`worker.ts:103`, `worker.ts:174-176`).
- Đánh đổi chấp nhận được, nhưng hub sẽ chấm điểm và phạt **IP egress Cloudflare dùng chung**. Một nguồn rác làm 429 cho mọi provider đi qua lưới.
- Log `catchnet_misconfigured` hiện chỉ ghi ở nhánh hub vắng. Nên log ở cả nhánh chuyển tiếp (throttle theo isolate) và để `/_health` báo `signing: false`.

**L5. Hạn giữ của Worker không kẹp theo `EVENT_RETENTION_DAYS`** (`config.ts:290-293`).
- ADR-214 chỉ nói dòng nằm giữa hai hạn sẽ thành `inbox_dead`. Với provider ký **không** có timestamp (GitHub, PayOS) thì không phải vậy.
- Kịch bản: header lưới quá hạn nên hub bỏ qua, request thành "gọi thẳng", verify vẫn qua. Nếu `raw_events` gốc (ca forward timeout nhưng đã COMMIT) đã bị cleanup thì UNIQUE không còn, và sự kiện được **giao lại lần hai** sau nhiều ngày.
- Hiếm, vì mặc định 7 = 7. Sửa: ghi luật "Worker `CATCHNET_RETENTION_DAYS` ≤ `EVENT_RETENTION_DAYS`" vào DEPLOYMENT và sửa câu trong ADR-214.

**L6. `finishResync` không dọn gì khi lượt resync rỗng** (`store.ts:163-172`).
- Hub không còn source nào thì `MIN(updated_at)` là NULL, nên key cũ ở lại mãi.
- Sửa: lượt rỗng mà `final` thì xoá mọi dòng có `sync_id` khác lượt đó.

**L7. Vài lỗi nhỏ ở cửa vào.**
- `decodeURIComponent` ném lỗi khi gặp `%` hỏng → 503 `internal` ở `/_admin` (`worker.ts:333`). Nên trả 422.
- Body chunked không có `content-length` bị đọc trọn bằng `arrayBuffer()` rồi mới kiểm 1MB (`worker.ts:142-145`). Body lớn chiếm bộ nhớ isolate. Nên đọc stream có trần.

**L8. Phát lại gặp 429 `refused` của cổng phạt (IP gốc đang bị phạt) sẽ retry tới 7 ngày.**
- Mỗi dòng như vậy giữ chỗ trong trần theo key và tốn một subrequest mỗi 30 phút.
- Chấp nhận được (H2 yêu cầu 429 → retry), nhưng nên ghi vào ADR-216 phần đánh đổi.

**L9. nginx `geo` (ADR-223).**
- Dải IP đủ: 15 dải IPv4 và 7 dải IPv6, khớp danh sách Cloudflare công bố mà reviewer biết.
- Khi lưới tắt, khoá `"~^1:"` giữ nguyên hành vi EG1.
- `geo` đọc `$remote_addr` sau realip. Với Render (`0.0.0.0/0` + `recursive off`), nginx lấy phần tử **cuối** của XFF, nên client giả XFF không được.
- Còn hai điểm, đều đã ghi ADR (mức Thấp):
  - Worker riêng của kẻ xấu trên Cloudflare vẫn được nới.
  - Cần đo trên Render rằng `$remote_addr` của request gọi thẳng **không** rơi vào dải Cloudflare. Edge của Render có thể chạy trên Cloudflare; nếu XFF cuối là IP Cloudflare thì R2-L1 vô hiệu với mọi IP. Thêm việc này vào checklist bật lưới.

**L10. `docs/TEST-MAP.md` sinh lại trên máy không có kết quả `verify`.**
- Toàn bộ cột trạng thái thành "chưa chạy" (mất trạng thái ✅ của 300+ mã).
- Sinh lại trên CI/Linux trước khi gộp, hoặc tách khỏi commit LH2.

**L11. ADR và giấy tờ.**
- ADR-214 phần "Chọn" quá dài so với luật "3 dòng" (§12). Nên chuyển chi tiết luồng sang spec §16.
- Số ADR 214/215/216/222/223 nằm trong dải 211–229 và không trùng (đã grep). ADR-220 vẫn chưa ghi (L6 cũ của LH-URL), ghi khi bật Worker.
- `LH2-VIEC-MAY-CONG-TY.md` nên thêm các bước sau:
  - query có ký tự WHATWG mã hoá (`|`, `'`): xem hub giả nhận gì, và chữ ký có qua `verifyCatchnetHeaders` không;
  - ca `%2e%2e` (L2);
  - đo lượt cron (TB-3);
  - `meta.changes` (L1).

---

## Trả lời từng câu hỏi soi

1. **BB-3 / mất dữ liệu.**
   - Không có đường 2xx nào trước khi ghi bền: `passThrough` chỉ chạy khi hub trả lời rõ, và `ackResponse` chỉ sau `insertCaught` thành công.
   - D1 lỗi (`[LH:T6]`), vượt trần, key lạ, thiếu secret, exception (`handleFetch` catch) → 503.
   - Forward timeout 4s mà hub đã COMMIT: Worker hứng rồi ack. Phát lại cùng bytes và cùng header provider nên khoá chống trùng giữ nguyên (id của provider hoặc `bodyHashKey`; `x-catchnet-id` không nằm trong khoá). Hub trả `duplicate` → xoá dòng. Đúng thiết kế.
   - Rủi ro mất còn lại nằm ở TB-3 (kẹt hàng tới khi `expired`), L3 (origin sai) và L5 (giao lại hai lần, không phải mất).
2. **Ký và bytes.**
   - Ký `href.slice(origin.length)`, giữ `?` đứng một mình. Vector chung qua cả 3 ca. Ca `?` còn chờ workerd thật xác nhận dòng request (bước 3 ở máy công ty).
   - Body là `arrayBuffer` → `Uint8Array`, không `text()`.
   - Header bị lọc: `cf-*`, `x-forwarded-*`, `x-real-ip`, `cdn-loop`, hop-by-hop, `accept-encoding`; `x-catchnet-*` và `x-hub-outcome` do client tự đặt bị bỏ.
   - Mỗi header lưới đặt bằng `set` nên chỉ một giá trị. METHOD viết hoa.
   - So token admin bằng `crypto.subtle.timingSafeEqual` sau khi kiểm độ dài.
   - Từng trường khớp `verifyCatchnetHeaders`:
     - ULID khớp `ID_RE`;
     - ms khớp `MS_RE`;
     - IP từ `cf-connecting-ip`, thiếu thì `0.0.0.0`, đều qua `net.isIP`;
     - mode thuộc tập cố định;
     - chữ ký có dạng `v1=<64 hex>`;
     - chữ ký body là `id.hex(sha256)`.
3. **Phân loại phản hồi.**
   - Thứ tự trong `replayDecision` đúng H2/T-5/ADR-222. 429 xét trước outcome; 503 `rejectStatus` (`rejected`) → dead.
   - 3xx, 431 và 400 không outcome → retry 3 lần rồi dead. 413 do hub/nginx gắn `rejected` → dead (Worker đã chặn > 1MB từ trước nên hầu như không xảy ra).
   - Outcome lạ được coi là không có outcome.
   - Ca lọt: 2xx không outcome (L3).
   - "Dừng lô": không gây starvation lâu dài, vì dòng đã thử được đẩy lùi và dòng chưa gửi giữ chỗ. Head-of-line chỉ xảy ra khi không kịp `markRetry` (TB-3).
4. **D1/quota.**
   - Mỗi lần hứng: khoảng 3 đọc (`getSource`, 2 bộ đếm) và 4–5 ghi.
   - Cron rảnh: 1 truy vấn, 0 dòng đọc. `next_at` có index, `dueRows` đọc đúng N dòng.
   - Trigger không lệch qua xoá, `moveDead` hay `expired`. `purgeDead` chỉ xoá `inbox_dead` nên đúng là không đụng bộ đếm. Không dùng `REPLACE` trên `inbox`.
   - Quota/byte: TB-2. Ngân sách truy vấn/subrequest/CPU: TB-3.
5. **Bảo mật.**
   - Token ≥ 32 ký tự, thiếu thì `/_admin` trả 503, so constant-time (lộ độ dài, chấp nhận được).
   - Worker không giữ secret provider, không verify.
   - Secret < 32 ký tự thì chuyển tiếp không ký (L4).
   - Log không chứa body hay secret; chỉ có id, `sourceKey`, status và tên lỗi. `sourceKey` nằm trong log Cloudflare riêng của tài khoản, chấp nhận được.
   - Proxy qua `%2e%2e`: L2.
6. **H6.** `catch_methods` mặc định là `POST`. HEAD không bao giờ được hứng; GET chỉ được hứng khi source khai. Bắt tay trong body (Slack) bị hứng như ADR-215 đã chấp nhận. `inbox_dead` được dọn ở lượt đầu giờ khi `dead_at` quá 7 ngày. Lưu ý TB-1: GET bắt tay bị mạch chặn.
7. **nginx `geo`.** Xem L9: đủ dải, lưới tắt thì giữ hành vi cũ, không giả được bằng XFF trên cấu hình Render. Còn điều kiện phải đo trên Render.
8. **Monorepo/CI.**
   - `"!apps/catchnet"` hoạt động: đã kiểm bằng `npm query` và đọc mã nguồn map-workspaces.
   - Lock gốc chỉ thêm đúng một dòng. jest gốc bỏ qua `apps/catchnet`.
   - Job CI `catchnet` hợp lý: Node 22 cho `node:sqlite`, cache theo lock riêng, timeout 10 phút.
   - `.dockerignore` loại `.wrangler` và `.dev.vars`; `node_modules` đã bị loại từ trước.
9. **ADR/spec.**
   - Số ADR đúng dải, không trùng.
   - Bốn chỗ lệch spec có chủ ý:
     - phát lại theo `next_at`: đứng vững vì đúng lý do quota, và lần đầu `next_at = received_at`;
     - bộ đếm bằng trigger: đứng vững;
     - mạch chỉ mở khi timeout: đứng vững, **nhưng** áp sai phạm vi (TB-1);
     - thiếu secret vẫn chuyển tiếp: tạm được, xem L4.
   - LH2b: xem TB-4. Tách được, nhưng phải thành cổng.

## Điều kiện để ĐẠT

- Sửa TB-1 đến TB-4, mỗi mục có test hoặc dòng ghi tương ứng:
  - TB-1: ca mới trong `[LH:T5]`;
  - TB-2: test trần byte trong `[LH:T10]`;
  - TB-3: test lease, tức là lượt bị "giết" giữa chừng thì phút sau dòng khác được gửi;
  - TB-4: sửa H12, §15b và DEPLOYMENT.
- Chạy `LH2-VIEC-MAY-CONG-TY.md` (đã bổ sung các bước ở L11) ở máy công ty và ghi số vào §16.
- Mục Thấp ghi vào §16 làm nợ; nên sửa luôn L1–L3 vì mỗi mục chỉ vài dòng.

---

## Phản hồi của dev (Amelia, 2026-10-15)

| Mục | Xử lý | Bằng chứng |
|---|---|---|
| TB-1 | Mạch chỉ áp cho request hứng được (`getSource` + `catchable` trước); không hứng được thì chuyển tiếp như thường | `[LH:T5] (phần d)` |
| TB-2 | `inbox_count` thêm `bytes` + khoá `#dead`, `day:<n>` (trigger). Trần `MAX_BYTES` 300 MB (gồm dead), `MAX_KEY_BYTES` 50 MB, `MAX_ROWS` 15.000, `MAX_PER_DAY` 5.000. Số liệu gói free tra 2026-10-15 trên developers.cloudflare.com, ghi ở ADR-224 | `[LH:T10] (phần c)` |
| TB-3 | Cron 3 bước: chọn id + `length(body)` theo index → lease cả lô +5 phút (một câu) → nạp body từng dòng. Lô ≤ 10 dòng (3 + 4×10 = 43 < 50 truy vấn D1/subrequest), ≤ 2 MB body. Nhánh `catch` đã được lease che | `[LH:T8] (phần d/f/g)`; bước đo workerd ở `LH2-VIEC-MAY-CONG-TY.md` §3b |
| TB-4 | LH2b vào H12 (trước LH6), §15b, DEPLOYMENT §3.6, ADR-214/215, `wrangler.toml`. Chưa code LH2b | — |
| L1 | `changes > 0` | test máy công ty §3b |
| L2 | `safeHookTarget`: chặn `..`/`%2e`/`%2f`/`%5c` trên target thô **và** bản WHATWG, chỉ cho `/hooks/` → 404 | `[LH:T10] (phần d)` |
| L3 | 2xx không outcome = cấu hình sai: chuyển tiếp coi là hub vắng, phát lại retry (không xoá), log `catchnet_misconfigured` | `[LH:T18] (phần a)`, `[LH:T8] (phần a/h)` |
| L4 | Log một lần/isolate khi chuyển tiếp không ký; `/_health` có `signing` | — |
| L5 | Luật `CATCHNET_RETENTION_DAYS` ≤ `EVENT_RETENTION_DAYS` ở DEPLOYMENT §3.6 + ADR-214 | — |
| L6 | Resync rỗng + `final` dọn key cũ hơn lượt đó | `[LH:T7] (phần c)` |
| L7 | `%` hỏng → 422; body chunked đọc có trần 1 MB | `[LH:T7] (phần c)`, `[LH:T10] (phần e)` |
| L8 | Ghi vào đánh đổi ADR-216 | — |
| L9 | Thêm bước đo `ip` của request gọi thẳng vào DEPLOYMENT §3.6 | việc Admin trên Render |
| L10 | TEST-MAP lấy lại bản master, chỉ chèn 18 dòng `LH:*` | `git diff eb7eebc -- docs/TEST-MAP.md` |
| L11 | ADR-214 còn 3 dòng; thêm bước WHATWG/`%2e%2e`/cron/`meta.changes` vào file máy công ty | — |

**Còn nợ:** CPU/bộ nhớ thật của một lượt cron chỉ đo được trên workerd (máy công ty). ADR-220 ghi khi bật Worker. Code LH2b chưa làm.

**Thay đổi so với bản cũ:**
- Batch mặc định giảm từ 25 xuống 10/lượt, nên 5.000 dòng mất khoảng 8,3 giờ.
- Dòng mới thêm cột `bytes`; `/_admin/stats` có thêm `pendingBytes`, `deadBytes`, `caughtToday`.
- Migration `0001` sửa tại chỗ. Chấp nhận được vì chưa áp lên D1 thật nào.

---

## Lượt 2 (Winston, 2026-10-15)

**Phạm vi:** `c54b575` (code) + `79e4c0a` (giấy), diff `0654b6f..79e4c0a`.

**Đã chạy (máy nhà):**
- `apps/catchnet`: `npx vitest run` → 3 file, **31/31 pass**. `npx tsc -p tsconfig.json --noEmit` → exit 0.
- Thử `safeHookTarget` trên Node: chép đúng logic + `requestTarget`, chạy 15 target (kết quả ở mục L2).
- Tra trang chính thức ngày 2026-10-15:
  - `developers.cloudflare.com/workers/platform/limits/`
  - `developers.cloudflare.com/d1/platform/limits/`
  - `developers.cloudflare.com/d1/platform/pricing/`

### Kết luận lượt 2: **CHƯA ĐẠT** — 0 Nặng · 1 TB (TB-2 còn hở một nửa) · 6 Thấp mới

Đã đóng: TB-1, TB-3, TB-4. TB-2 mới đóng phần *body*. Trần byte chưa tính header và target, mà hai phần này lớn gấp nhiều lần mức dự phòng.

### Từng TB

**TB-1: ĐÓNG.**
- `handleHook` chỉ bỏ qua bước chuyển tiếp khi đủ ba điều kiện:
  - `canCatch`, tức có secret và path khớp `HOOK_RE`;
  - mạch đang mở;
  - `lookup` trả về một source hứng được.
- Mọi trường hợp khác vẫn chuyển tiếp như thường:
  - key chưa sync;
  - provider lệch;
  - GET bắt tay;
  - D1 lỗi lúc tra (`'error'`). Khi đó Worker vẫn chuyển tiếp, và nếu hub vắng thì tra lại ở nhánh hứng.
- **Key chưa sync + mạch mở + hub sống:** nhận phản hồi thật của hub, không còn 503 oan. Có test `[LH:T5] (phần d)`.
- **Key đã sync + hub chậm một lần:** trong 30s Worker ghi D1 rồi ack, cron phát lại sau khoảng 1–2 phút. Sự kiện đến trễ chứ không mất, đúng §4.1.
- Hai điểm nhỏ, chấp nhận được:
  - Một lần chuyển tiếp thành công (từ request không hứng được) **không** đóng mạch sớm.
  - Request không hứng được tốn thêm 1 lần đọc D1 khi mạch mở.

**TB-2: CHƯA ĐÓNG HẾT.** Phần đã đúng:
- **Không race giữa các isolate.** D1 là một SQLite ghi tuần tự, nên `INSERT … SELECT … WHERE` cùng trigger chạy nguyên tử trong một câu. Điều kiện có `+ ?12 <= max`, nên vượt trần là **0 byte**, không phải "vượt một ít".
- **Trigger không lệch:**
  - Không có chỗ nào `UPDATE body`/`source_key`. `leaseRows`/`markRetry` chỉ đụng `next_at`/`attempts`/`last_*`.
  - `moveDead` bỏ `INSERT OR REPLACE`. Đúng: REPLACE xoá ngầm mà không kích trigger DELETE khi `recursive_triggers` tắt.
  - Ca `expired` đi qua `moveDead`, nên trừ ở `inbox` và cộng ở `#dead`.
  - `purgeDead` kích `inbox_dead_count_del`.
- **Khoá ngày:**
  - Câu kiểm và trigger cùng dùng `CAST(x / 86400000 AS INTEGER)`, nên D1 bind số dạng REAL hay INTEGER cũng ra cùng khoá.
  - Đếm theo giờ Worker, khớp mốc reset 00:00 UTC của quota.
  - Khoá ngày không giảm khi xoá, đúng ý đồ.
  - `source_key` chỉ gồm `[A-Za-z0-9_-]`, nên không đụng được `*`, `#dead`, `day:*`.
- **Số free tier khớp nguồn** dev ghi:
  - D1: 500 MB/DB; 2 MB/dòng; 50 truy vấn/invocation; 5M đọc + 100k ghi/ngày; index tính thêm; reset 00:00 UTC.
  - Workers: 50 subrequest, 10 ms CPU (cả Cron), 128 MB.
  - Trang Workers ghi rõ subrequest gồm cả lời gọi D1, nên cách dev cộng truy vấn D1 + fetch vào cùng một ngân sách là đúng mô hình.

**TB-2a (mới, TB). Trần byte chỉ đếm `body`; `headers_json` và `target` không bị đếm, không bị kẹp.**
- **Chỗ:**
  - trigger `inbox_count_ins` / `inbox_dead_count_ins` dùng `length(NEW.body)`;
  - `insertCaught` dùng `?12 = r.body.byteLength`;
  - `storableHeaders` không có trần.
- **Số liệu** (cùng trang limits tra hôm nay): Workers nhận tới **128 KB header** và **URL 16 KB**. Một dòng có thể chứa khoảng 144 KB không bị đếm, kể cả khi body rỗng.
- **Kịch bản:** cùng mô hình đe doạ của TB-2 lượt 1, tức một `sourceKey` bị lộ, gửi lúc hub vắng.
  - POST body 0 byte, header 128 KB, mỗi lần 1 dòng. Trần byte không tăng.
  - Trần dòng của key: 2.000 × 144 KB ≈ **288 MB**. Hai key lộ là ≈ 576 MB, vượt 500 MB.
  - Chỉ cần **một** key: dòng rác bị hub từ chối khi phát lại (`rejected`) sẽ sang `inbox_dead`. Hàng chết không có trần dòng, và trần byte của nó cũng chỉ đếm body. Key được giải phóng, kẻ xấu nạp lại.
  - Trần ngày 5.000 × 144 KB ≈ **720 MB/ngày**. DB đầy trong chưa tới một ngày, đúng hệ quả TB-2 lượt 1 đã nêu: mọi `INSERT` của mọi source trả 503, `moveDead` lỗi, lưới chết.
  - BB-3 vẫn giữ, nhưng mục tiêu của TB-2 ("trần đếm byte, không làm chết lưới") chưa đạt.
- **Sửa (chọn một, đều vài dòng):**
  - **(a)** Đếm đủ. Trigger dùng `length(NEW.body) + length(CAST(NEW.headers_json AS BLOB)) + length(CAST(NEW.target AS BLOB))`. Phải CAST, vì `length(TEXT)` đếm ký tự chứ không đếm byte. Đổi `?12` trong `insertCaught` thành tổng ba phần tính bằng `TextEncoder`, và áp cho cả `#dead`.
  - **(b)** Kẹp trước khi hứng. `JSON.stringify(headers)` > 16 KB hoặc target > 4 KB thì không hứng (503) nhưng vẫn chuyển tiếp như thường. Nên làm thêm bước này dù chọn (a).
  - Thêm một ca vào `[LH:T10] (phần c)`: body rỗng, header lớn, phải chạm trần byte.

**TB-3: ĐÓNG** (còn ghi chú Thấp N1–N3).
- Có đủ ba bước: `dueIds` (id + `length(body)` theo index) → `leaseRows` một câu → `loadRow` từng dòng.
- `[LH:T8] (phần f)` chứng minh lượt bị giết thì lượt sau gửi dòng khác.
- **Dòng hết lease** quay lại tự nhiên vì `next_at = lúc lease + 5'` ≤ now.
  - Dòng bị lease mà chưa gửi (lô dừng vì hub vắng) **không** bị tăng `attempts`. Đúng.
  - Nhánh `catch` không `markRetry`, nhưng lease đã đẩy dòng lùi, nên không còn giữ đầu hàng.
- **Một lượt chạy quá 5 phút:** cần khoảng 2 nhóm × timeout 4s + độ trễ D1, cỡ chục giây. Trần wall-clock của Cron là 15 phút, nên về lý thuyết vẫn có thể xảy ra nếu D1 treo. Nếu xảy ra thì gửi trùng, và hub nuốt bằng khoá chống trùng (id provider / `bodyHashKey`; `x-catchnet-id` không nằm trong khoá) → `duplicate` → xoá. Chấp nhận được, **nhưng phải ghi vào phần đánh đổi của ADR-216** (xem N2).
- **Đếm truy vấn:**
  - Mỗi dòng: `loadRow` 1 + fetch 1 + kết quả tối đa 2 (`moveDead` là batch 2 câu). `deleteRow`/`markRetry` chỉ 1.
  - Trigger chạy trong cùng câu, không tính thêm.
  - Cố định: `dueIds` 1 + `leaseRows` 1. Ở phút 00 có thêm `purgeDead`, giờ là **batch 2 câu**, nên tổng là **4** chứ không phải 3.
  - Trường hợp xấu nhất: 4 + 4×10 = **44** < 50. Dev ghi 43 là lệch 1, nhưng vẫn dưới trần. Sửa con số trong ADR-224 khi tiện.
  - `redirect: 'manual'` nên không có subrequest ẩn do chuyển hướng.

**TB-4: ĐÓNG.**
- Cổng LH2b đã có ở bảng H12 (dòng 4b, LH6 phụ thuộc LH2b), §15b, DEPLOYMENT §3.6, ADR-214 (Đánh đổi), ADR-215 và `wrangler.toml`.
- Nhãn "(phần Worker; tick khi review ĐẠT)" ở §15b đúng như đã yêu cầu.

### Các mục Thấp lượt 1

**L2 `safeHookTarget`: ĐẠT.** Kết quả thử:

| Target | Kết quả | Ghi chú |
|---|---|---|
| `%2e%2e` | 404 | |
| `%2E.` | 404 | |
| `.\t.` / `.\n.` | 404 | WHATWG xoá tab/xuống dòng thành `..`, bản chuẩn hoá bắt được. Đây là lý do cần kiểm hai lớp. |
| `x;/../` | 404 | |
| `\` / `%5c` / `%2f` | 404 | |
| `./../` | 404 | |
| `%252e%252e` | lọt | Vẫn dưới `/hooks/`. nginx giải mã một lần thành chữ `%2e`, không phải dấu chấm; Express không giải mã lại path. An toàn. |
| `//` | lọt | `/hooks//api`, vẫn dưới `/hooks/`. |
| `．．` (U+FF0E) | lọt | WHATWG mã hoá thành `%EF%BC%8E`, không phải dấu chấm. An toàn. |
| `.%00.` | lọt | Không phải dot-segment. An toàn. |
| `..` nằm trong query | lọt | Đúng: query không phải path. |

Còn một điểm, xem N4.

**L3: ĐẠT, không làm kẹt lô.**
- 2xx không outcome được xử lý như `absent`, nên lô dừng sau nhóm đầu, `markRetry` lùi dần 1/2/5/10/30', và 5 dòng còn lại chờ hết lease.
- Không dòng nào kẹt đầu hàng. Sau 7 ngày dòng thành `expired`.
- Trong lúc cấu hình sai thì không giao được gì. Đó là hành vi đúng, kèm log `catchnet_misconfigured` mỗi dòng.
- Ở chiều chuyển tiếp: hứng rồi ack nếu hứng được, không thì 503. Không có 2xx giả.

**L1, L4–L11: ĐẠT.**
- `changes > 0` an toàn theo cả hai cách đếm, vì WHERE sai thì không có trigger nào chạy và kết quả là 0.
- `readCapped` dừng đọc khi vượt trần.
- `%` hỏng → 422.
- Resync rỗng dùng `COALESCE(MIN, startedAt)`.
- ADR-214/215/216 đã gọn 3 dòng.

### Hồi quy

- **BB-3 giữ nguyên.** 2xx chỉ đến từ hai nguồn:
  - `passThrough`, khi hub trả lời rõ, và giờ 2xx không outcome **không** còn đi qua đây;
  - `ackResponse`, sau `insertCaught` trả `true`.
- Nhánh mạch mở (`catchIt` trực tiếp) cũng ghi D1 trước khi ack.
- Mọi lỗi trả 503. `handleFetch` vẫn bắt exception → 503.
- **Chữ ký và bytes không đổi:**
  - `callHub` vẫn ký `requestTarget(href)` và body thô.
  - `readCapped` ghép chunk thành `Uint8Array` nguyên bytes, không `text()`.
  - D1 vẫn lưu `rawTarget` thô.

### ADR và migration

- ADR-214/215/216/222/223/224 nằm trong dải 211–229, không trùng; master đang dùng 230–233.
- ADR-224 đủ 3 dòng và có nguồn. Cần sửa hai chỗ: "43" thành 44, và bổ sung TB-2a / N1.
- **Migration `0001` sửa tại chỗ:** chấp nhận, vì chưa áp lên D1 `--remote` nào và cổng TB-4 cấm deploy. Kèm hai điều kiện:
  1. Ghi vào `LH2-VIEC-MAY-CONG-TY.md`: nếu máy công ty (hoặc spike LH-S) đã từng `migrations apply --local`, phải xoá `apps/catchnet/.wrangler/state` trước. `CREATE TABLE IF NOT EXISTS` không thêm cột `bytes` vào bảng cũ, và D1 cũng đã ghi `0001` là đã áp.
  2. Sau lần `--remote` đầu tiên, chỉ thêm migration mới, không sửa `0001` nữa.

### Thấp mới (ghi §16 làm nợ; không chặn nếu TB-2a đã sửa)

**N1. Con số "≈ 11 dòng ghi/sự kiện" chỉ đúng với đường suôn sẻ.**
- Chi phí của cron không bị đếm vào trần ngày:
  - lease khoảng 2 dòng ghi mỗi dòng (bảng + index `next_at`);
  - `markRetry` khoảng 2;
  - `moveDead` khoảng 6–7.
- Hub vắng cả ngày: mỗi lượt có 10 lease + 5 retry ≈ 30 dòng ghi → 1.440 lượt ≈ **43k/ngày**. Cộng 5.000 lần hứng × khoảng 5 = 25k, tổng vẫn dưới 100k.
- Ngày hub trở lại với 15.000 dòng tồn: khoảng 14.400 × 6 ≈ 86k, cộng lần hứng mới, **có thể vượt 100k**.
- Hệ quả khi vượt:
  - `INSERT` lỗi → 503, BB-3 vẫn giữ.
  - `deleteRow` lỗi → dòng gửi lại sau lease, hub nuốt bản trùng.
  - Không mất dữ liệu, nhưng phải ghi vào phần đánh đổi của ADR-224.

**N2. `dueIds` → `leaseRows` là hai câu, không nguyên tử.**
- Hai invocation chồng nhau (`__scheduled` bấm tay, hoặc cron chồng lượt) có thể chọn cùng id và gửi hai lần.
- Lượt dài hơn 5 phút cũng gây gửi trùng.
- Hub nuốt cả hai trường hợp nhờ UNIQUE. Ghi vào ADR-216. Nếu muốn kín hơn: `UPDATE inbox SET next_at=? WHERE id IN (SELECT id … LIMIT ?) RETURNING id, length(body)`.

**N3. Kiểm `expired` nằm sau `loadRow`.**
- Nếu chính việc nạp một body (BLOB 1 MB dạng mảng số) làm lượt vượt CPU/bộ nhớ, dòng đó **không bao giờ** tới được nhánh `expired`. Nó quay lại mỗi 5 phút mãi mãi và kéo chết các dòng cùng lô (các dòng này chỉ bị gửi trùng, không mất).
- Sửa: `dueIds` trả thêm `received_at`, và chuyển dòng quá hạn sang dead bằng SQL (`moveDead` vốn đã chép bằng `INSERT … SELECT`, không nạp body vào JS) trước khi lease.
- Phụ thuộc vào số đo ở máy công ty §3b.

**N4. `safeHookTarget` và route `/hooks` không phân biệt hoa thường (`/i`), còn `HOOK_RE` thì phân biệt.**
- `/HOOKS/github/k` được chuyển tiếp tới hub.
- `location /hooks` của nginx phân biệt hoa thường, nên request rơi vào location khác và đi vòng qua `limit_conn` / cầu chì của `/hooks`.
- Express mặc định không phân biệt hoa thường, nên vẫn có thể vào route ingest.
- Sửa: bỏ cờ `i`, chỉ nhận `/hooks/` chữ thường.

**N5. Phần đếm `#dead` chỉ chạy bằng `UPDATE`, không upsert.**
- Nếu dòng `#dead` mất (ai đó xoá tay), mọi câu cộng sẽ âm thầm không làm gì và trần đếm thiếu.
- Nên đổi sang `INSERT … ON CONFLICT DO UPDATE` như khoá source.

**N6. Số "43 truy vấn"** trong code comment, ADR-224 và bảng phản hồi: ở phút 00 thực tế là 44, vì `purgeDead` là batch 2 câu.

### Điều kiện để ĐẠT (lượt 3)

1. Sửa **TB-2a** theo (a) hoặc (b), kèm ca test header lớn + body rỗng trong `[LH:T10]`.
2. Cập nhật ADR-224: 44 truy vấn, đánh đổi N1, và việc trần byte giờ tính cả header/target.
3. Ghi N1–N6 vào §16 làm nợ. Sửa luôn N4 và N5 vì mỗi mục chỉ 1–3 dòng.
4. Ghi điều kiện xoá `.wrangler/state` vào `LH2-VIEC-MAY-CONG-TY.md`.

### Phản hồi lượt 2 (Amelia, 2026-10-15)

| Mục | Xử lý | Bằng chứng |
|---|---|---|
| TB-2a | Làm cả (a) và (b). (a) Trigger và `insertCaught` đếm `body + headers_json + target` theo byte (`length(CAST(… AS BLOB))`, `rowBytes` dùng TextEncoder). Trần dòng toàn bảng và trần theo key tính cả `inbox_dead`, nên dòng bị từ chối giữ chỗ của key tới khi `purgeDead` dọn. (b) Header JSON > 16 KB hoặc target > 4 KB thì không hứng; vẫn chuyển tiếp như thường, hub vắng thì 503 | `[LH:T10]` phần f (body rỗng + header lớn chạm trần 1 MB ở dòng 75; bộ đếm khớp `SUM` theo byte), phần g, phần h |
| N1 | Ghi đánh đổi vào ADR-224 | — |
| N2 | Tài liệu D1 (`/d1/sql-api/sql-statements/`, tra 2026-10-15) không nói tới `RETURNING`, nên giữ hai câu. Ghi vào ADR-216 rằng lượt chồng nhau có thể gửi trùng và UNIQUE ở PG nuốt. Thêm bước thử ở máy công ty §3c | — |
| N3 | `dueIds` trả thêm `received_at`; dòng quá hạn sang dead bằng SQL trước lease, không nạp body | `[LH:T8]` phần i |
| N4 | Bỏ `/i`; `/HOOKS` trả 404 | `[LH:T10]` phần i |
| N5 | Mọi cộng/trừ bộ đếm dùng UPSERT | `[LH:T10]` phần h |
| N6 | Đổi 43 thành 44 trong code và ADR-224 | — |
| Migration | `LH2-VIEC-MAY-CONG-TY.md`: xoá `.wrangler/state` trước khi áp local; sau lần `--remote` đầu thì không sửa `0001` | — |

vitest 36/36, tsc sạch, `verify:map` 0 trùng. TEST-MAP vẫn giữ trạng thái master, chỉ chèn dòng `LH:*`.

---

## Lượt 3 (Winston, 2026-10-15)

**Phạm vi:** `214a995` (code) + `5cf181a` (giấy), diff `3eb3e7b..5cf181a`.

**Đã chạy (máy nhà):** `apps/catchnet` `npx vitest run` → **36/36 pass**. `npx tsc -p tsconfig.json --noEmit` → exit 0.

### Kết luận lượt 3: **ĐẠT** — 0 Nặng · 0 TB · 3 Thấp mới

TB-2a đã đóng. Không có hồi quy nào chạm BB-3, chữ ký hay bytes.

**Điều kiện tick LH2 ở §15b** (giữ nguyên từ lượt 1):
- Chạy `LH2-VIEC-MAY-CONG-TY.md` §1–§3c ở máy công ty.
- Ghi số đo vào §16. Quan trọng nhất là CPU và bộ nhớ của một lượt cron, cùng `meta.changes`.
- Cổng LH2b vẫn giữ: chưa deploy Worker thật.

### TB-2a: ĐÓNG

**1. Công thức JS khớp SQL.**
- Phía JS, `rowBytes` cộng ba phần:
  - `body.byteLength`;
  - số byte UTF-8 của `JSON.stringify(headers)`;
  - số byte UTF-8 của `target`.
- Phía trigger: `length(body) + length(CAST(headers_json AS BLOB)) + length(CAST(target AS BLOB))`.
- Hai bên đo trên **cùng** dữ liệu:
  - `insertCaught` bind đúng chuỗi `JSON.stringify(r.headers)` làm `headers_json`;
  - `target` là `inc.rawTarget` ở cả hai chỗ.
- D1 lưu TEXT dạng UTF-8, nên `CAST AS BLOB` trả về đúng số byte UTF-8. Có CAST thì `length` cũng không dừng ở ký tự NUL như khi đếm trên TEXT.
- Giá trị header là ByteString, gồm byte 0x80–0xFF, nên không có surrogate lẻ. Cả hai phía đều mã hoá ra 2 byte.
- Body rỗng: `COALESCE(?7, X'')` cho `length` = 0, khớp `byteLength` = 0.
- Hệ quả: điều kiện `+ ?12 <= max` và số trigger cộng vào bằng nhau từng byte. Test `[LH:T10] (phần f)` còn đối chiếu bộ đếm với `SUM` theo byte.

**2. Trigger cho dòng chết.**
- `moveDead` là batch: INSERT vào `inbox_dead` (cộng 1 cho key và `#dead`) rồi DELETE khỏi `inbox` (trừ 1 cho key và `*`).
- Key giữ nguyên số đếm; phần còn lại chuyển từ `*` sang `#dead`.
- `purgeDead` trừ khỏi key và `#dead`. Dòng đếm của key chỉ bị xoá khi `n<=0 AND bytes<=0`.
- Bỏ hai dòng seed `*`/`#dead` không sao: câu kiểm dùng `COALESCE`, và UPSERT tự tạo lại dòng (N5).

**3. Kẹp (b).**
- Header JSON > 16 KB hoặc target > 4 KB thì `canCatch=false`.
- Hub sống thì vẫn chuyển tiếp như thường. Hub vắng thì trả 503 và không ghi D1.
- Kẹp nằm **trước** nhánh mạch mở, nên request quá khổ không bao giờ bị hứng.
- Header của provider thật cỡ 1–4 KB; query VNPay cỡ 1 KB. Không chặn nhầm.

**4. Kịch bản "khoá key 7 ngày": có đổi bản chất, nhưng hẹp hơn và không phải DoS dễ hơn.**
- **Trước lượt 3:**
  - Chỉ cần một key lộ là làm đầy D1 cho **mọi** source (TB-2a).
  - Hoặc key được "giải phóng" sau mỗi vòng bị hub từ chối, nên kẻ xấu nạp lại vô hạn.
- **Bây giờ:**
  - Key lộ chỉ khoá được **nhánh hứng của chính source đó**: tối đa 2.000 dòng / 50 MB.
  - Khoá kéo dài tới khi `purgeDead` dọn, tức 7 ngày tính từ `dead_at`, có thể tới khoảng 14 ngày tính từ lúc nhận.
  - Trong thời gian đó, hub sống thì source vẫn chạy bình thường (chuyển tiếp). Hub vắng thì nhận 503 và provider tự retry, giống hệt khi gọi thẳng Render.
  - Không mất dữ liệu, BB-3 vẫn giữ.
- **Khoá toàn lưới** cần ≥ 6 key lộ (6 × 50 MB = 300 MB) hoặc ≥ 8 key (8 × 2.000 dòng = 15.000 dòng). ADR-224 đã ghi "nhiều key lộ" trong phần đánh đổi.
- Kết luận: phạm vi hẹp hơn hẳn, đánh đổi chấp nhận được.
- Còn thiếu đường gỡ khoá → **R2** bên dưới.

### Thấp lượt 2: đã xử lý

- **N1, N2:** đã ghi vào phần đánh đổi của ADR-224 và ADR-216.
  - N2 giữ hai câu SQL vì tài liệu D1 không xác nhận `RETURNING`. Có bước thử ở máy công ty §3c. Chấp nhận.
- **N3:** dòng quá hạn chuyển sang dead bằng `INSERT … SELECT` trước khi lease và không nạp body vào JS. `moveDead` dùng `COALESCE(?, last_status/last_error)`, nên giữ được lỗi cuối khi `status=null`.
  - Ngân sách truy vấn: `1 + 2k + 1 + 4(10−k) + 2 = 44 − 2k ≤ 44`.
- **N4:** `/HOOKS/...` → 404 cả ở `handleFetch` lẫn `safeHookTarget`.
- **N5:** mọi trigger đều dùng UPSERT.
- **N6:** sửa thành 44.

### Hồi quy

- **BB-3:**
  - `ackResponse` vẫn chỉ trả sau khi `insertCaught` trả `changes > 0`.
  - Nhánh oversize trả 503.
  - Nhánh dead/expired không đụng tới đường trả lời cho provider.
- **Chữ ký và bytes:** `callHub`/`requestTarget`/`readCapped` không đổi.
- **Thứ tự lượt cron:** chọn → dead hoá dòng quá hạn → lease → gửi. Dòng quá hạn không bị gửi thêm lần nào.

### Thấp mới

**R1. Nhánh dead hoá dòng quá hạn trong `runReplay` không có try/catch.**
- Một lần `moveDead` lỗi sẽ ném lỗi ra khỏi `runReplay` **trước** bước lease. Lỗi có thể do D1 lỗi tạm, hết quota ghi (N1), hoặc DB đầy làm INSERT vào `inbox_dead` thất bại.
- Khi đó cả lượt bỏ dở, kể cả các dòng còn sống lẽ ra gửi được và giải phóng chỗ. Dòng quá hạn vẫn đứng đầu, nên phút sau lặp lại.
- Trước lượt 3, lỗi này bị `replayOne(...).catch` khoanh lại trong một dòng.
- Hệ quả: chậm chứ không mất. Lỗi tạm thì tự hết; hết quota thì hết khi quota reset lúc 00:00 UTC.
- Sửa: bọc từng `moveDead` trong try/catch, log `catchnet_d1_error`, rồi đưa dòng đó vào lease để nó lùi 5 phút.

**R2. Không có đường gỡ khoá key và không có tín hiệu cho từng key.**
- Dòng chết giữ trần của key tới 7 ngày.
- Ca hợp lệ cũng dính: dev xoay secret sai giữa lúc hub vắng, hàng trăm dòng thành `rejected`, và source mất lưới hứng 7 ngày. Dấu hiệu duy nhất là log `catchnet_overflow`.
- Đề xuất, nợ §16 (làm cùng LH2b hoặc console):
  - `/_admin/stats` trả thêm `n`/`bytes` của từng key đang gần trần;
  - thêm `DELETE /_admin/dead/:key` (Bearer) để Admin gỡ khoá sau khi đã xem hàng chết.

**R3.** `LH2-VIEC-MAY-CONG-TY.md` nên thêm một bước:
- Trên D1 local, sau khi hứng một request có header chứa ký tự ≥ 0x80, so `SELECT bytes FROM inbox_count WHERE k='*'` với `rowBytes` mà Worker log ra.
- Mục đích: xác nhận D1 thật lưu TEXT dạng UTF-8 giống node:sqlite.

### ADR

- ADR-216 và ADR-224 vẫn 3 dòng, số không đổi.
- Phần "Chọn" của ADR-224 đã dài, gần chạm luật 3 dòng. Lần sửa sau nên chuyển phần số liệu sang §16.
