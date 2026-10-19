# Kết quả chaos LOCAL — `[BP:T4]` `[BP:T16]` `[BP:T21]` (phần b)

> **Số chính thức: lượt cuối, chạy ngày 2026-10-15 trên HEAD `9717787`** của nhánh `feat/chaos-bp`. Lượt này chạy sau khi đã gộp `origin/master` `4c9b6ac` và có đủ các sửa: ADR-194 (P2010, bản siết theo review TB-1), ADR-231 (F2), ADR-232 (F3), ADR-233 (R1 probe). Image `hubv` được dựng lại bằng `verify:up`.
> Môi trường: stack `hubv` (docker compose, LOCAL — ADR-019, C8). Máy Linux 12 CPU / 31 GB, Docker 29.6.1. Trước khi chạy đã kiểm `pgrep -af 'jest|tsc'` và `compose -p hubv ps`: không có agent nặng nào khác.
> Kịch bản `verify/scenarios/chaos-bp.ts`, đồ nghề `verify/lib/chaos.ts` (ADR-193). Số chi tiết (chuỗi mẫu 1 s, cửa sổ, log) nằm ở `verify/.results/chaos-bp-T*.json`.
> Chạy lại: `npm run verify:up && npm run verify:chaos:bp` (khoảng 27 phút), hoặc `npm run verify:chaos -- --tag bp-t4|bp-t21|bp-t16`.
> Các lượt trước (từ `35918bd`, trước các sửa trên) nằm ở §7 Lịch sử.

## 0. Cách đo

- **Số "lần chạm DB".** Đọc `/metrics` của hub-worker mỗi 1 s, qua một `docker compose exec` chạy suốt kịch bản; không mở cổng ra ngoài.
  - Lane delivery đếm bằng `hub_delivery_infra_errors_total`.
  - Lane normalize đếm bằng `hub_normalize_deferred_total` + `hub_normalize_retries_total`.
  - Khi DB chết, mỗi lần một message chạm DB là một lần gọi Prisma thất bại.
- **Giới hạn của cách đếm này:**
  - Bộ đếm tăng lúc lỗi, không tăng lúc bắt đầu. Prisma `connect_timeout` là 5 s, nên **chặn trên được tính từ mốc factor = 1 cộng 6 s**. Đợt đầu (từ lúc phá tới mốc đó) được ghi riêng.
  - Số đếm **chỉ gồm đường consumer (normalize + delivery)**. Scheduler (relay outbox, sweeper, alert, storage) nằm ngoài BP5 (§7.5) và được ghi riêng ở F4.
- **Sai số của mẫu 1 s.** Một "cửa sổ ≤ 5 s" là khoảng giữa hai mẫu cách nhau ≤ 5 s, không phải mọi khoảng 5 s liên tục. Mốc lấy mẫu lệch nhịp dò tới khoảng 1 s, nên số trung bình mỗi 5 s có thể nhích quá 2 (ví dụ 2,04) mà max theo cửa sổ vẫn bằng 2. Log được đếm theo `time` của từng dòng pino.
- **Phá dưới tải** (`preloadBacklog`):
  1. Dừng hub-worker.
  2. Bắn N id. hub-api vẫn COMMIT và trả 2xx; outbox dồn lại.
  3. Bật lại worker.
  4. Phá ngay khi AMQP passive-declare thấy đủ message READY ở `q.normalize` và `q.delivery.main`.

  Mốc phá là lúc phát lệnh. Đích của T4 chậm 1 s (sink `PUT /_mode delayMs`).
- **0 mất / 0 trùng** đếm bằng Postgres (BB-2), theo id delivery của GitHub. Mỗi id phải có đúng 1 raw ACCEPTED, 1 event và 1 delivery SUCCEEDED; không có delivery trùng; mọi id đã nhận 2xx đều có raw (BB-3).
- **Đích chết** (T16): sink `PUT /_mode {"mode":"fail"}` trả 500 nhưng vẫn ghi lại request.

## 1. `[BP:T4]` — giết Postgres (SIGKILL) 60 s dưới tải — **PASS đủ 11/11 tiêu chí**

Tải lúc phá: 2000 id, `q.normalize` có 1534 READY, `q.delivery.main` có 419 READY.

| Tiêu chí | Kết quả |
|---|---|
| Postgres chết thật suốt 60 s (kiểm mỗi 5 s) | PASS (0 lần thấy chạy) |
| Cả hai lane có message chạm DB khi DB chết | PASS (delivery 449, normalize 204) |
| Worker không khởi động lại | PASS |
| factor{db} lên 1 trong ≤ 10 s | PASS (4,2 s) |
| **Đợt đầu** (từ lúc phá tới mốc factor = 1 + 6 s, khoảng 10,2 s) | đo, không có ngưỡng: **634 lần chạm DB** (delivery 439, normalize 195). Khoảng 612 lần rơi vào 1,2 s đầu: giây 0,2 có normalize 173, giây 1,2 có delivery 439. 6 s sau factor = 1 còn 22 lỗi của permit đã cấp trước đó (max thô trong một cửa sổ 5 s: 21) |
| **Chế độ dò**, chặn trên tính từ mốc factor = 1 + 6 s: mọi cửa sổ ≤ 5 s có ≤ 2 lần chạm DB trên đường consumer (normalize + delivery) | PASS: max 2; 19 lần / 49 s = 1,94 / 5 s |
| Chế độ dò theo lane: ≤ 1 / lane / 5 s | PASS: delivery max 1, normalize max 1 |
| Log delivery hạ tầng gộp ≤ 1 dòng / 30 s (khung từ lúc phá tới factor = 0, 100 s) | PASS (3 dòng) |
| Log normalize: 0 warn "Lỗi tạm" sau factor = 1 | PASS (0) |
| Log consumer ≤ 5 dòng/s (N do phiên đặt trước khi đo, spec không cho N) | **PASS: max 2 dòng/s, tổng 4.** Trước khi có ADR-231 con số này là 225/s |
| Delivery: lỗi DB xếp `transient` | PASS (449 / 0 unknown) |
| DB về: 0 mất / 0 trùng / mọi delivery SUCCEEDED | PASS: 2000/2000 sau 139 s; `q.normalize.dlq` 0 → 0 |

Số đo thêm:
- Spill: 16.
- factor về 0 sau 40,2 s kể từ lúc DB nhận kết nối lại.
- Log toàn tiến trình: 140 dòng warn/error trong 100 s, max 4 dòng/s. Trong đó relay outbox 121 dòng (F4), storage 12, consumer 4.
- Đích nhận lặp 20/2000: đây là at-least-once (F5).

## 2. `[BP:T21]` — dừng Postgres 10 phút dưới tải đều — **PASS**

Tải gồm backlog 1500 id (lúc phá `q.normalize` có 940 READY) và tải đều 0,5 sự kiện/s: 305 id, trong đó 300 nhận 5xx và được gửi lại sau khi DB về. Postgres bị `stop`.

| Tiêu chí | Kết quả |
|---|---|
| Postgres chết thật suốt 600 s | PASS |
| Lane normalize có hàng chạm DB khi DB chết | PASS (normalize 611, delivery 165) |
| Worker không khởi động lại | PASS |
| **`q.normalize.dlq` tăng ≤ 5** (đếm bằng `rabbitmqctl` trước/sau) | **PASS: +0** (0 → 0) |
| **DB về: mọi sự kiện được xử lý**, 0 mất / 0 trùng | **PASS**: 1805/1805, xong sau 28 s kể từ khi provider gửi lại xong |
| (đo thêm) chế độ dò 10 phút trên đường consumer: ≤ 2 / 5 s | PASS: max 2; 236 lần / 590 s = 2,00 / 5 s |
| (đo thêm) theo lane: ≤ 1 / lane / 5 s | PASS: delivery 1, normalize 1 |

Số đo thêm:
- factor lên 1 sau 3,8 s.
- Đốt lượt ở đợt đầu (factor = 0): 300 lần, mỗi message tối đa 1 trong 5 lượt. Hoãn không đốt lượt: 311 lần. Spill: 160.
- factor về 0 sau 39,9 s kể từ lúc DB về.
- Log 10 phút: relay 1198 dòng (F4), storage 129, delivery 19 (đã gộp), normalize 1 (đã gộp, ADR-231). Max 4 dòng/s.

## 3. `[BP:T16]` — đích chết 10 phút với 500 delivery hoãn → hồi phục — **PASS sau ADR-241** (lượt 2 dưới đây: "sau ramp ≤ 64/s" FAIL với ADR-232)

### 3.0 Đo lại sau ADR-241 — **PASS** (2026-10-19, máy công ty, master `62a2545`, image build lại từ HEAD)

`npm run verify:chaos -- --tag bp-t16` · 770 s · L3 1/1 xanh · chi tiết `verify/.results/chaos-bp-T16.json`

| Tiêu chí | Kết quả |
|---|---|
| Tiền đề: 500 delivery hoãn lúc đích sống lại, 0 SUCCEEDED | PASS |
| Worker không khởi động lại (RestartCount 1 → 1) | PASS |
| **ADR-241:** `:ramp` không sống quá RAMP_MAX 180 s kể từ rampStart | **PASS: 101 s** |
| Không giây nào trong ramp vượt trần (2..64, giữ 64 khi được gia hạn) | **PASS**: 0 giây vượt, 499 request trong ramp |
| **Sau ramp ≤ 64/s (F3)** | **PASS: 0 request sau ramp** (lượt trước 149/s) |
| Hồi phục 500/500 SUCCEEDED, 0 DEAD, 0 trùng | PASS: xong 168 s sau khi đích sống (lượt trước 136 s) |

- 10 phút đích chết: 22 request chạm đích (20 lúc mạch còn đóng, probe ở ~61 s và ~361 s; `:trips` 1 → 2).
- Probe thành công 61 s sau khi đích sống. Ramp bắt đầu `01:59:30.731Z`.
- Bậc 64 được gia hạn 4 lần (ramp hết ở 101 s, trong trần 180 s). Mỗi vòng `retry.10s` vẫn dồn vào 1–2 giây (giây ≠ 0: `+50` 0, `+51` 64, `+60` 64, `+61` 64, `+70` 11, `+71` 64, `+81` 64, `+91` 23, `+92` 59), nhưng phần tồn nay đi theo trần 64 thay vì dội về khi khoá hết hạn.
- Đánh đổi đã thấy: hồi phục chậm hơn 32 s so với lượt trước (168 s so với 136 s), đúng như ADR-241 ghi.

| Tiêu chí | Kết quả |
|---|---|
| Tiền đề: lúc đích sống lại có 500 delivery hoãn, 0 SUCCEEDED | PASS |
| Worker không khởi động lại | PASS |
| **Không giây nào trong ramp vượt trần** (2..64 trong 60 s, rồi bậc kẹp 64 tới 70 s, ADR-232) | **PASS**: 0 giây vượt; 307 request trong ramp |
| **Sau ramp** (khoá `:ramp` hết hạn): không giây nào > 64/s (tiêu chí mới của F3) | **FAIL: 192 request còn lại tới ở giây +70 và +71 với 43 và 149/s** |
| Hồi phục: 500/500 SUCCEEDED, 0 DEAD, 0 trùng | PASS: xong 136 s sau khi đích sống |

- Trong 10 phút đích chết chỉ có **23 request** đập vào đích: 21 request đầu (mạch OPEN), rồi 1 probe ở khoảng giây 61 (`:trips` = 1, OPEN 300 s) và 1 probe ở khoảng giây 361 (`:trips` = 2). Khớp BP3.
- Probe kế thành công 61,2 s sau khi đích sống. Ramp bắt đầu `09:20:10.641Z`.
- Số request mỗi giây trong ramp (số/trần), chỉ liệt kê giây ≠ 0: `+0` 2/2 · `+1` 2/2 · `+9` 1/2 · `+10` 2/4 · `+11` 4/4 · `+20` 4/8 · `+21` 8/8 · `+30` 8/16 · `+31` 16/16 · `+40` 32/32 · `+41` 32/32 · `+50` 64/64 · `+51` 64/64 · **`+60` 64/64 (bậc kẹp)** · `+61` 4/64.
- **Vì sao vẫn trượt.** Bậc kẹp 60–70 s chỉ xả thêm một vòng (64 + 4 request). Ở lượt này, vòng `retry.10s` dồn vào khoảng 1 giây, chứ không rải 2 giây như lượt 1, nên phần còn lại (192) về đúng lúc khoá hết hạn. Hướng (b) đã giảm phần dội từ 243 xuống 192, nhưng đỉnh vẫn 149/s (lượt 1: 123/s). Chi tiết ở F3.

## 4. Phát hiện

- **F1 — ĐÃ VÁ (ADR-194, siết theo review TB-1). P2010 bọc 57P01 bị xếp "lỗi dữ liệu".** Hậu quả là normalize đưa event vào DLQ ngay lượt 0 (T4 lượt 1: 1 event).
  - Nay `meta.code` dạng SQLSTATE quyết một mình. Chỉ khi thiếu `meta.code` mới dò câu theo mẫu có neo `` Code: `(57P0[123]|08\d{3})` ``.
  - Có test L1 trên Postgres thật (`infra-errors-db.spec`): `pg_terminate_backend` chính mình → Prisma ném `P2010 {"code":"57P01"}` → `transient`; `'08006'::uuid` → `unknown`.
  - Lượt cuối: DLQ +0 ở cả T4 lẫn T21.
- **F2 — ĐÃ VÁ (ADR-231). Đợt warn normalize đầu tiên không gộp.** Lượt 3 đo 225 dòng/s; lượt cuối còn max 2 dòng/s, chỉ 1 dòng normalize (đã gộp) trong toàn bộ T4.
- **F3 — ĐÃ VÁ (ADR-241), chaos T16 đo lại 2026-10-19 PASS: 0 request sau ramp, `:ramp` 101 s ≤ 180 s (§3.0).** _Lịch sử:_ VÁ MỘT PHẦN (ADR-232, hướng b), tiêu chí mới vẫn FAIL. Sau ramp, phần tồn vẫn dội 149/s (trần cuối 64). Cần Admin quyết hướng tiếp: kéo ramp theo kích thước hàng tồn, hoặc giữ trần cuối tới khi hàng hết.
- **R1 — ĐÃ VÁ (ADR-233). Bên thua probe HALF_OPEN tốn 2 lệnh Redis.** Nay gate báo "probe đang bị giữ", bên thua chỉ tốn 1 lệnh (`redis-budget` `[BP:T22]` phần d).
- **F4 — Ghi nhận (ngoài BP5, §7.5 P2).** Khi DB chết, relay outbox và storage ghi khoảng 2 dòng log/s và gọi khoảng 2 truy vấn Prisma/s mà bộ điều khiển không chặn.
- **F5 — Ghi nhận, đúng thiết kế: at-least-once ở đích.** 20/2000 delivery đang bay đúng lúc DB bị giết tới đích 2 lần. Postgres vẫn chỉ có 1 delivery cho mỗi event.

## 5. Trích bằng chứng thô (lượt cuối)

```
# T4 — chuỗi mẫu 1 s (giây | delivery | normalize | factor)
0,2 | 0 | 173 | 0      1,2 | 439 | 0 | 0,25     2,2 | 0 | 0 | 0,5     3,2 | 0 | 0 | 0,75     (factor 1 từ 4,2 s)
log T4 (100 s): "Lỗi tạm ở normalize -> q.normalize.retry.30s (log gộp tối đa 1 dòng/30s)" ×1 · delivery gộp ×3 · relay ×121 · storage ×12
T4: gửi 2000 id (2xx lần đầu 2000) → raw 2000/2000 · event 2000/2000 · delivery 2000/2000 SUCCEEDED · DEAD 0 · trùng 0 (chờ 139 s)

# T21
backlog normalize trước khi phá: q.normalize ready 940
chế độ dò 10 phút: 236 lần / 590 s = 2,00 / 5 s, max 2 (delivery 1, normalize 1) · q.normalize.dlq +0 (0 → 0)
T21: gửi 1805 id (2xx lần đầu 1505) → raw 1805/1805 · event 1805/1805 · delivery 1805/1805 SUCCEEDED · DEAD 0 · trùng 0

# T16
đích SỐNG lại sau 600 s; hàng hoãn: 500 delivery, 0 SUCCEEDED; 23 request đã đập vào đích chết
probe thành công, ramp bắt đầu 2026-10-15T09:20:10.641Z (61 s sau khi đích sống)
ramp (60 s + bậc kẹp): 307 request; 2/2 2/2 … 1/2 2/4 4/4 … 4/8 8/8 … 8/16 16/16 … 32/32 32/32 … 64/64 64/64 … 64/64 4/64 …
sau ramp: 192 request, max 149/s; +70s:43 +71s:149
```

## 6. Kiểm chứng phụ (cùng HEAD, sau lượt cuối)

- `npm run verify:chaos` (VF5, chaos-l3 dùng `verify/lib/chaos.ts`): **6/6 xanh** (213 s).
- `npm run verify:db` (L1): **271/271, 0 skip**. Có `infra-errors-db.spec` (P2010 thật) và test F3 trên Redis thật.
- Ba kịch bản BP KHÔNG chạy trong `verify:chaos`/nightly (tag `chaos-bp`, ADR-193).

## 7. Lịch sử — các lượt trước (từ `35918bd`, trước ADR-194 bản siết, ADR-231, ADR-232, ADR-233)

> Lượt 1 chạy cả ba kịch bản; lượt 2 và 3 chỉ chạy T4 (sau bản vá P2010 đầu tiên). Ở lượt 1 và 2, mốc phá lấy sau khi lệnh trả về, nên đợt lỗi đầu rơi ngoài cửa sổ đo. Câu "/ 5 s / tiến trình" ở dưới nghĩa là "/ 5 s trên đường consumer (normalize + delivery)".

### 7.1 `[BP:T4]` — giết Postgres (SIGKILL) 60 s dưới tải

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

### 7.2 `[BP:T21]` — dừng Postgres 10 phút dưới tải đều (lượt 1, `35918bd`)

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

### 7.3 `[BP:T16]` — đích chết 10 phút với 500 delivery hoãn → hồi phục (lượt 1, `35918bd`)

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

### 7.4 Trích bằng chứng thô (lượt 1–3)

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

