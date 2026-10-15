# Kết quả chaos LOCAL — `[BP:T4]` `[BP:T16]` `[BP:T21]` (phần b)

> Chạy ngày **2026-10-15**, stack `hubv` (docker compose, LOCAL — ADR-019, C8). Kịch bản `verify/scenarios/chaos-bp.ts`, đồ nghề `verify/lib/chaos.ts` (ADR-193).
> Máy: Linux 12 CPU / 31 GB RAM, Docker 29.6.1. Không agent nặng nào khác chạy jest/tsc/docker trong lúc đo (đã chờ máy rảnh theo C8).
> Code: nhánh `feat/chaos-bp` mở từ `master` `35918bd`. Lượt 1 (cả ba kịch bản) chạy trên image dựng từ `35918bd`. Lượt 2 và 3 (chỉ T4) chạy sau khi vá P2010 (ADR-194, xem §4).
> Chạy lại: `npm run verify:up && npm run verify:chaos:bp` (~35 phút), hoặc `npm run verify:chaos -- --tag bp-t4|bp-t21|bp-t16`. Số chi tiết (chuỗi mẫu 1 s, cửa sổ, log) nằm ở `verify/.results/chaos-bp-T*.json`.

## 0. Cách đo

- **Số "lần gọi Prisma".** Đọc từ `/metrics` của hub-worker mỗi 1 s (một `docker compose exec` chạy suốt kịch bản, không mở cổng ra ngoài). Mỗi lane có bộ đếm riêng:
  - delivery: `hub_delivery_infra_errors_total`;
  - normalize: `hub_normalize_deferred_total` + `hub_normalize_retries_total`.

  Khi DB chết, mỗi lần một message chạm DB là một lần gọi thất bại. Có hai giới hạn khi đọc con số này:
  - Bộ đếm tăng lúc lần gọi **thất bại**, không phải lúc bắt đầu. Prisma `connect_timeout` là 5 s, nên permit được cấp ngay trước khi factor lên 1 có thể báo lỗi muộn tới 5 s. Vì vậy "chế độ dò ổn định" được tính từ lúc factor = 1 cộng 6 s. Số thô tính từ đúng lúc factor = 1 vẫn được ghi riêng.
  - Bộ đếm **không** gồm truy vấn của scheduler (relay outbox, sweeper, alert, storage). Phần này nằm ngoài BP5 (§7.5, P2) và được ghi riêng bên dưới.
- **Phá dưới tải** (`preloadBacklog`). Trình tự:
  1. Dừng hub-worker.
  2. Provider giả bắn N id. hub-api vẫn COMMIT và trả 2xx; outbox dồn lại.
  3. Bật lại worker.
  4. Phá ngay khi AMQP passive-declare thấy đủ message READY ở `q.normalize` và `q.delivery.main`.

  Đích của T4 chậm 1 s (sink `PUT /_mode delayMs`) để lane delivery có hàng dồn.
- **0 mất / 0 trùng** đếm bằng Postgres (BB-2), theo id delivery của GitHub:
  - mỗi id có đúng 1 raw ACCEPTED, 1 event, 1 delivery SUCCEEDED;
  - không có delivery trùng `(event, subscription)`;
  - mọi id đã nhận 2xx đều có raw (BB-3).
- **Đích chết** (T16): sink `PUT /_mode?path=… {"mode":"fail"}` trả 500 nhưng vẫn ghi lại request, nhờ vậy đếm được số request đập vào đích chết. Endpoint đã xác minh challenge, URL giữ nguyên.

## 1. `[BP:T4]` — giết Postgres (SIGKILL) 60 s dưới tải

Tải lúc phá:
- Lượt 3 (lượt cuối): 2000 id, `q.normalize` có 1618 READY, `q.delivery.main` có 116 READY.
- Lượt 1: 1612 / 331. Lượt 2: 1545 / 393.

| Tiêu chí | Lượt 1 (`35918bd`) | Lượt 2 (+vá P2010) | **Lượt 3 (+vá, mốc phá = lúc phát lệnh)** |
|---|---|---|---|
| Postgres chết thật suốt 60 s (kiểm mỗi 5 s) | PASS (0 lần thấy chạy) | PASS | **PASS** |
| Cả hai lane có message chạm DB khi DB chết | PASS (delivery 361, normalize 185 ¹) | PASS (423 / 31 ¹) | **PASS (384 / 320)** |
| Worker không khởi động lại | PASS | PASS | **PASS** |
| factor{db} lên 1 trong ≤ 10 s | PASS (4,0 s) | PASS (4,0 s) | **PASS (4,4 s)** |
| Chế độ dò: mọi cửa sổ ≤ 5 s có ≤ 2 lần chạm DB / tiến trình | PASS (max 2; 18 lần / 48 s = 1,87 / 5 s) | PASS (max 2; 1,84 / 5 s) | **PASS (max 2; 20 lần / 49 s = 2,04 / 5 s ²)** |
| Log delivery hạ tầng gộp ≤ 1 dòng / 30 s | PASS (2 dòng / 60 s) | PASS (2) | **PASS (2)** |
| Log normalize: 0 warn "Lỗi tạm" sau khi factor = 1 | PASS (0) | PASS (0) | **PASS (0)** |
| Log consumer (normalize + delivery) ≤ 5 dòng/s ³ | PASS ¹ | PASS ¹ | **FAIL: 225 dòng/s, tổng 295** |
| Delivery: lỗi DB xếp `transient` (không `unknown`) | PASS (361 / 0) | PASS | **PASS (384 / 0)** |
| DB về: 0 mất / 0 trùng / mọi delivery SUCCEEDED | **FAIL: 1 event kẹt ở `q.normalize.dlq`** (event 1999/2000) | PASS (2000/2000 sau 141 s) | **PASS (2000/2000 sau 138 s)** |

¹ Ở lượt 1 và 2, mốc phá được lấy **sau** khi lệnh `docker compose kill` trả về (khoảng 0,5 s). Postgres thì chết ngay khi lệnh tới daemon, nên đợt lỗi đầu tiên (khoảng 175 normalize) rơi ra ngoài cửa sổ đo. Lượt 3 sửa lại: mốc lấy tại lúc phát lệnh. Kết quả là con số normalize và log đúng hơn, và chính nhờ sửa mốc mà lộ ra phát hiện F2 (§4).

² Giữa hai mẫu 1 s, mỗi lane có đúng 1 lần mỗi 5 s; cửa sổ ≤ 5 s lớn nhất là 2. Trung bình trên 49 s được 2,04 vì biên của cửa sổ đo không trùng nhịp dò. Đây không phải vượt nhịp: max theo cửa sổ vẫn bằng 2.

³ Spec không cho N (`[BP:T4]`: "log không xả quá N dòng/s"). Phiên này đặt **N = 5** trước khi đo và giữ nguyên, không nới.

Số đo thêm ở lượt 3:
- **Vài giây đầu**, trước khi factor lên 1. Đây là đánh đổi đã biết của C12: permit giới hạn số việc chạy đồng thời, không giới hạn tốc độ.
  - Giây 0–1: normalize 221 + 72, delivery 374.
  - Giây 1 → 4,4: 0. Các message còn lại nằm trong `retry.10s`/`retry.30s` hoặc đang chờ permit.
  - 6 s đầu sau factor = 1: thêm 17 lỗi. Đó là permit đã cấp trước khi factor lên 1, chờ hết `connect_timeout`.
- **Spill** (giữ quá 60 s rồi republish, không đốt lượt): 16.
- **Hồi phục.** factor về 0 sau 40,4 s kể từ lúc DB nhận kết nối lại. Lý do: lỗi cũ phải trôi khỏi cửa sổ 30 s, rồi factor giảm 0,1/s. Toàn bộ 2000 delivery xong sau 138 s. Phần lớn thời gian đó là do đích chậm 1 s: 20 prefetch tương đương khoảng 20 delivery/s.
- **Log toàn tiến trình** trong 60 s: 428 dòng warn/error, max 226 dòng/s. Gồm:
  - 293 dòng "Lỗi tạm ở normalize → retry.30s" (F2);
  - 119 dòng "Lỗi trong chu kỳ Outbox Relay", khoảng 2 dòng/s (F4);
  - 12 dòng storage, 2 dòng delivery, 1 dòng alert.
- **Đích nhận lặp:** 20 webhook-id tới sink 2 lần. Đây là delivery đang chờ HTTP đúng lúc DB chết: đích đã nhận, nhưng hub chưa ghi được kết quả nên gửi lại. Đây là at-least-once như thiết kế; đích chống trùng bằng `webhook-id`. Postgres vẫn chỉ có 1 delivery cho mỗi event.

## 2. `[BP:T21]` — dừng Postgres 10 phút dưới tải đều (lượt 1, `35918bd`)

Tải gồm hai phần:
- Backlog 1500 id. Lúc phá, `q.normalize` có 933 READY.
- Tải đều 0,5 sự kiện/s suốt 10 phút và thêm 10 s sau khi DB về: 305 id. 300 id nhận 5xx (hoặc lỗi kết nối) và được provider giả gửi lại sau khi DB về.

Postgres bị `stop` (SIGINT, fast shutdown).

| Tiêu chí | Kết quả |
|---|---|
| Postgres chết thật suốt 600 s | **PASS** (0 lần thấy chạy) |
| Lane normalize có hàng chạm DB khi DB chết | **PASS** (normalize 633, delivery 193) |
| Worker không khởi động lại | **PASS** |
| **`q.normalize.dlq` tăng ≤ 5** (đếm chính xác bằng `rabbitmqctl` trước/sau) | **PASS: +0** (1 → 1; message có sẵn là từ T4 lượt 1) |
| **DB về: mọi sự kiện được xử lý**: 0 mất / 0 trùng / mọi delivery SUCCEEDED | **PASS**: 1805/1805, xong sau 28 s kể từ khi provider gửi lại xong |
| (đo thêm) chế độ dò suốt 10 phút: mọi cửa sổ ≤ 5 s có ≤ 2 lần chạm DB | **PASS**: max 2; 234 lần / 589 s = 1,99 / 5 s (nhịp đều 1 normalize + 1 delivery mỗi 5 s) |

Số đo thêm:
- factor lên 1 sau 3,6 s.
- 479 lần đốt lượt ở đợt lỗi đầu, khi factor còn 0. Mỗi message đốt tối đa 1 trong 5 lượt.
- 155 lần hoãn không đốt lượt; 160 spill.
- factor về 0 sau 39,6 s kể từ lúc DB về.
- Log 10 phút có 1192 dòng relay (khoảng 2/s, F4), 120 dòng storage, 19 dòng delivery (gộp 30 s), 10 alert, 9 sweeper. Max 4 dòng/s.
- So với trước BP5 (**ước tính, không đo** — code cũ không còn trong image): với 5 lượt × 30 s, mọi message trong backlog sẽ cạn lượt sau khoảng 2,5 phút, tức khoảng 933 message vào DLQ.

## 3. `[BP:T16]` — đích chết 10 phút với 500 delivery hoãn → hồi phục (lượt 1, `35918bd`)

| Tiêu chí | Kết quả |
|---|---|
| Tiền đề: lúc đích sống lại có 500 delivery hoãn, 0 SUCCEEDED | **PASS** (500 / 0) |
| Worker không khởi động lại | **PASS** |
| **Không giây nào trong 60 s ramp vượt trần (2, 4, 8, 16, 32, 64 rps)** | **PASS**: 0 giây vượt; 256 request trong ramp |
| Hồi phục: 500/500 SUCCEEDED, 0 DEAD, 0 delivery trùng | **PASS**: xong 126 s sau khi đích sống |

Trong 10 phút đích chết, **chỉ 22 request** đập vào đích:
- 20 request đầu đang bay. Mạch OPEN sau 5 lỗi.
- 1 probe ở giây 61, thất bại → OPEN 300 s, `:trips` = 1.
- 1 probe ở giây 361, thất bại → `:trips` = 2.

Từ đó đến hết, `:open` PTTL lặp 300 s, khớp BP3. Trước BP2/BP3, mạch OPEN 60 s cố định, tức khoảng 10 probe và 500 message bị bốc ra, bỏ vào lại mỗi phút.

Hồi phục:
- Đích sống ở giây 600. Probe kế thành công sau 60,9 s (lúc đó `:open` còn khoảng 61 s).
- Ramp bắt đầu `07:49:11.409Z`.
- Số request mỗi giây trong ramp (số/trần), chỉ liệt kê giây ≠ 0: `+0` 2/2 · `+1` 2/2 · `+10` 2/4 · `+11` 4/4 · `+20` 4/8 · `+21` 8/8 · `+30` 10/16 · `+31` 16/16 · `+40` 32/32 · `+41` 32/32 · `+50` 64/64 · `+51` 64/64 · `+60` 16/64. Mọi giây khác là 0.

Hàng tồn về theo nhịp `retry.10s`. Mỗi bước 10 s, hàng chỉ có mặt ở gate trong khoảng 2 giây, và cả hai giây đều chạm đúng trần. Gate Lua (BP4) chặn đúng tới từng request.

## 4. Phát hiện

- **F1 — LỖI, đã vá trong commit riêng (ADR-194): P2010 bọc 57P01 bị xếp "lỗi dữ liệu" → normalize đưa thẳng vào DLQ.** T4 lượt 1 bắt được.
  - Khi Postgres bị giết giữa transaction, `$executeRaw` ném `PrismaClientKnownRequestError` mã **P2010** ("Raw query failed. Code: `57P01`. Message: `FATAL: terminating connection due to unexpected postmaster exit`").
  - `classifyInfraError` trả `unknown` cho mọi `KnownRequestError` không nằm trong bảng mã Prisma. Bảng 57P0x/lớp 08 của C12 chỉ được xét cho `UnknownRequestError` và cho lỗi driver. Vì vậy `classifyNormalizeError` trả `permanent` → **DLQ ngay ở lượt 0**. Log ghi: `"code":"P2010","kind":"permanent","retries":0,"msg":"Lỗi dữ liệu ở normalize -> DLQ"`.
  - Delivery gặp cùng lỗi thì đi nhánh `unknown`: hoãn 1 phút, sau 5 lần vào DLQ.
  - Hậu quả: event không mất (raw còn trong Postgres), nhưng kẹt ở DLQ và phải renormalize tay. Đây đúng là thứ BP5 hứa loại bỏ.
  - Cách vá: P2010 có SQLSTATE bên trong (`meta.code` hoặc thông điệp) thuộc 57P01/57P02/57P03/lớp 08 → `transient`. P2010 với lỗi dữ liệu thật (23505, 42601) vẫn giữ nguyên. Test: `backpressure.spec` "bảng mã".
  - Sau khi vá (lượt 2 và 3): log có 10 dòng 57P01 nhưng DLQ +0, 2000/2000.
- **F2 — Ghi nhận, CHƯA sửa (cần phòng quyết): đợt log normalize đầu tiên không gộp.**
  - Trước khi controller kịp tick (factor còn 0, khoảng 1 s), mỗi message normalize lỗi ghi **một dòng warn** "Lỗi tạm ở normalize → retry.30s". Hệ quả: 293 dòng trong khoảng 1 s, max 225 dòng/s, nên T4 trượt tiêu chí N = 5 (lượt 3).
  - Delivery đã được gộp (BP1, 1 dòng/30 s); normalize thì chưa.
  - L0 phần a chỉ kiểm "0 warn sau giây thứ 5", nên không thấy chỗ này.
  - Gợi ý: dùng `LogThrottle` (`@hub/common`) cho nhánh transient của normalize, như delivery. Đánh đổi: mất dòng log theo từng `rawEventId` khi lỗi lẻ tẻ.
- **F3 — Ghi nhận (thiết kế BP4, không vi phạm T16): hết ramp thì phần tồn còn lại dội về một lần.**
  - 60 s ramp chỉ xả được 256 trên 500. Hàng về theo nhịp `retry.10s`, nên mỗi bước 10 s chỉ dùng được khoảng 2 giây có trần.
  - Khoá `:ramp` hết hạn thì 243 request còn lại tới trong **2 giây: 123/s và 120/s**, gần gấp đôi trần cuối 64 rps.
  - Spec §5 chấp nhận việc "sau đó khoá hết hạn và trở về bình thường". Nhưng nếu đích chỉ chịu được khoảng 64 rps thì cú dội cuối vẫn có thể đánh sập nó lần nữa.
  - Hướng xử lý (để phòng quyết): giữ trần cuối thêm một bước, hoặc kéo `DELIVERY_RAMP_SECONDS` theo kích thước hàng tồn.
- **F4 — Ghi nhận (ngoài BP5, §7.5 P2): relay outbox ghi log 2 dòng/s khi DB chết.** Relay poll mỗi khoảng 500 ms và mỗi lượt lỗi ghi một dòng error: 1192 dòng trong 10 phút (T21). Storage job thêm 1 dòng mỗi 5 s. Cả hai không có nhịp lùi hay gộp log. Đây cũng là nguồn truy vấn Prisma khoảng 2 lần/s nằm ngoài bộ điều khiển BP5.
- **F5 — Ghi nhận: at-least-once ở đích.** Delivery đang chờ HTTP đúng lúc DB bị giết sẽ tới đích 2 lần (20/2000 ở T4). Postgres vẫn chỉ có 1 delivery cho mỗi event. Đây là đúng thiết kế (đích chống trùng bằng `webhook-id`), ghi lại để hội đồng hỏi thì có số.

## 5. Trích bằng chứng thô

```
# T4 lượt 1 — worker log (F1)
{"level":"error","time":"2026-10-15T07:21:07.697Z",...,"err":"\nInvalid `prisma.$executeRaw()` invocation:\n\n\nRaw query failed. Code: `57P01`. Message: `FATAL: terminating connection due to unexpected postmaster exit`","code":"P2010","kind":"permanent","retries":0,"msg":"Lỗi dữ liệu ở normalize -> DLQ"}
# T4 lượt 1 — queue trước/sau: q.normalize.dlq 0 → 1; sổ cái: raw 2000/2000 · event 1999/1999 · delivery 1999/1999 SUCCEEDED

# T4 lượt 3 — chuỗi mẫu 1 s (giây | delivery | normalize | factor)
0,4 | 0 | 221 | 0      1,4 | 374 | 72 | 0,25     2,4 | 0 | 0 | 0,5     3,4 | 0 | 0 | 0,75     (factor 1 từ 4,4 s)
… chế độ dò: mỗi 5 s đúng 1 normalize rồi 1 delivery (cách nhau ~1 s), held normalize 20 / delivery 20

# T21 — chuỗi mẫu (mỗi 5 s)
0,6 | 75 | 499 | 0,25     5,6 | 0 | 16 | 1     10,6 | 1 | 1 | 1     15,6 | 1 | 1 | 1   … 55,6 | 1 | 1 | 1   (giữ tới 600 s)
… 60 s: factor 1, spilled 0 · 121 s: spilled 16 · 301 s: spilled 64 · 600 s: spilled 144
T21: gửi 1805 id (2xx lần đầu 1505) → raw 1805/1805 · event 1805/1805 · delivery 1805/1805 SUCCEEDED · DEAD 0 · trùng 0

# T16
… 61 s: request đập vào đích chết 21, :open PTTL 299744 ms, :trips 1
… 361 s: request đập vào đích chết 22, :open PTTL 299665 ms, :trips 2
đích SỐNG lại sau 600 s; hàng hoãn: 500 delivery, 0 SUCCEEDED; 22 request đã đập vào đích chết
probe thành công, ramp bắt đầu 2026-10-15T07:49:11.409Z (61 s sau khi đích sống)
ramp 60 s: 256 request; 2/2 2/2 0 … 2/4 4/4 … 4/8 8/8 … 10/16 16/16 … 32/32 32/32 … 64/64 64/64 … 16/64
sau ramp: 243 request, max 123/s; +60s:123 +61s:120
```

## 6. Kiểm chứng phụ

- `npm run verify:chaos` (bộ VF5 cũ, chaos-l3 đã chuyển sang dùng `verify/lib/chaos.ts`): **6/6 xanh**, 275 s, chạy sau các lượt BP trên cùng stack.
- Ba kịch bản BP KHÔNG chạy trong `verify:chaos`/nightly (tag `chaos-bp`, ADR-193).
