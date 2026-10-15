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
