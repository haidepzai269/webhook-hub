# REVIEW BP4 — `2fba61f..e862a70` (gồm `43251f7` chú thích BP3 + `e862a70` BP4)

Reviewer độc lập, 2026-10-13. Chỉ đọc.
- Trước khi review: đã `git fetch`, xác nhận HEAD = origin/feat/bp = `e862a70`, nhánh `feat/bp`.
- Các đột biến đều đã `git checkout` trả lại.
- Redis tạm ở cổng 56380 đã dừng.

## Kết luận: **ĐẠT**

Không có mục mức Cao hay Trung bình. Còn 4 mục mức Thấp; mục TH-2 là lỗ hổng có sẵn từ trước BP, nên ghi nợ.

## Đã chạy

- **Jest:** `npx jest apps/hub-worker apps/hub-api/test/redis-budget.spec.ts apps/hub-api/test/storage-api.spec.ts libs` → 79 suite, 607 test qua (96 skip).
- **tsc sau rebase, cả 4 app:** hub-api, hub-worker, web, shop đều 0 lỗi.
- **verify:map:** 400 mã, 327 có test, 0 mồ côi, 0 ma, 0 trùng. Đã `git checkout docs/TEST-MAP.md`.
- **verify:gates:** 20 luật, 0 vi phạm.
- **Redis thật:** circuit-breaker, delivery-gate, cleanup-job, redis-budget → 67/67 qua.
- **12 đột biến:**

  | Đột biến | Kết quả |
  |---|---|
  | Bước ramp 1s | 2 đỏ |
  | Ramp không INCR khi rps = 0 | 2 đỏ |
  | Cap ×2 | 2 đỏ |
  | `:ramp` không TTL | 1 đỏ |
  | Trip không DEL `:ramp` | 1 đỏ |
  | Ramp ở mọi success | 1 đỏ |
  | Bỏ min(rps, ramp) | 1 đỏ |
  | `recheckThrottle` bỏ ramp | 1 đỏ |
  | Chỉ số `:trips` cũ (`res[3]`) | 2 đỏ |
  | Bỏ kẹp env ramp | 1 đỏ |
  | Bỏ kẹp `el < 0` | **sống** (TH-1) |
  | Bỏ trần `steps ≤ 20` | **sống**: tương đương, vì ramp ≤ 60s và bước ≥ 1s nên `steps` ≤ 60, `2^60` vẫn không tràn số double |

## Soát theo từng điểm

**1. Công thức ramp** (circuit-breaker.service.ts:59-72)
- Tràn số: không thể. `steps` bị kẹp ≤ 20, và kể cả không kẹp thì vẫn ≤ 60 vì `DELIVERY_RAMP_SECONDS` bị kẹp ≤ 60 (retry-window.ts:84).
- Chia cho 0: không thể, vì bước ≥ 1 (retry-window.ts:82).
- Giá trị âm: kẹp về 0.
- `nowMs` lấy từ `Date.now()` **của worker** (:164-169), và mốc trong `:ramp` cũng do worker đóng mạch đặt.
  - Lệch đồng hồ giữa các worker chỉ làm lệch bậc ramp tương ứng.
  - Thời lượng ramp do TTL của Redis quyết định, nên lệch đồng hồ không kéo dài được ramp.
- Bộ đếm throttle theo giây dùng chung giữa rps và ramp, nên một lần INCR phục vụ cả hai. Các tổ hợp:

  | Tổ hợp | Hành vi | Đúng? |
  |---|---|---|
  | rps = 0, không ramp | cap = −1, không INCR | như cũ |
  | rps = 0, có ramp | cap = rampCap, có INCR | đúng |
  | rps > 0, có ramp | min(rps, rampCap) | đúng |
  | Ramp hết hạn hoặc mất | chỉ còn rps | fail-open, đúng BB-2 |

- `recheckThrottle` vẫn áp `rampCap` khi rps thật khác gợi ý (:200-205).

**2. `LUA_CLOSE_AND_RAMP`** (:79-81, :243-249)
- Chỉ chạy khi `recordSuccess` với view HALF_OPEN. Mà chỉ người giữ probe mới gửi ở HALF_OPEN (hoặc nhánh FAIL_OPEN_PROBE khi Redis lỗi). Vì vậy điều kiện "người probe đóng mạch" vẫn giữ như lệnh DEL trước đây.
- Success lúc CLOSED (còn failures) vẫn dùng DEL thường, không xoá `:ramp`. Đúng: một lần thành công không được dừng ramp.
- Có trip mới trong lúc ramp: `recordFailure` có thêm `DEL :ramp` trong MULTI. Chỉ số `:trips` dời sang `res[4]`, có test bắt.
- Script khai báo đủ 5 KEYS, chỉ dùng DEL/SET, nên chạy được trên Upstash. Số lệnh không đổi: 1 EVAL thay cho 1 DEL.

**3. Các chỗ dev lệch spec (C11) — đồng ý cả ba**
- **Ramp chỉ khi probe thành công.** Thành công lúc CLOSED (1–4 lỗi) nghĩa là mạch chưa từng OPEN, không có hàng tồn. Chỉ ghi nhận một điểm: spec §5 nói "mạch tự về CLOSED vì khoá hết hạn = chưa từng OPEN" là không hoàn toàn đúng. Mạch có thể đi OPEN 300s → HALF_OPEN 120s mà không message nào quay về kịp để làm probe. Khi đó các message ở `retry.5m` (hoãn lúc PTTL < 180s) quay về sau khi khoá hết hạn, không có ramp. Hệ quả nhỏ:
  - hàng tồn tự rải ra trong khoảng ~240s;
  - đích còn chết thì lỗi lại đủ ngưỡng và trip lại.
- **Không gộp `tryAcquireProbe` vào gate.** Gộp vào thì đổi ngữ nghĩa `getState`: mọi nhánh bỏ ngang phải nhả probe. Lợi chỉ được 1 lệnh cho một ca hiếm, mà vẫn không đạt ≤ 3 vì còn PUBLISH circuit.
- **Gate trả `rampCap` thay vì `throttleAllowed`.** Cần như vậy để `recheckThrottle` kiểm lại với rps thật mà không INCR lần hai (C9).

**4. Cửa sổ retry**
- `TOTAL_RETRY_WINDOW_MS` = 9.520.000 + 6 × (1.800.000 + 300.000 + 70.000) = 22.540.000 ms = 6h15m40s.
- Hoãn vì ramp tối đa thật mỗi lần thử: tới hết `:ramp` (≤ 60s, env chỉ kẹp thấp hơn), cộng một vòng `retry.10s`, tức ≤ 70s. Khớp.
- Mọi nơi QT dùng hằng số vẫn import, các test tính động đều qua.
- Throttle theo rps của khách không có trần thời gian: xem TH-2.

**5. R1**
- `LUA_GATE` vẫn đúng 1 EVAL, KEYS khai báo đủ 4. Ramp không thêm lệnh nào.
- Message bị ramp hoãn tốn 1 lệnh mỗi vòng 10s, 0 truy vấn DB khi có gợi ý. Test Redis thật đủ chặt, chỉ trừ TH-1.

**6. tsc:** cả 4 app sạch (đã nêu ở trên).

## Phát hiện

### Thấp

**TH-1 — Chưa có test cho mốc `:ramp` nằm ở tương lai.**
- Vị trí: circuit-breaker.service.ts:65 (`el < 0` kẹp về 0).
- Đột biến "bỏ kẹp" sống: khi đó `floor(âm / step) = −1`, cap = 1 rps.
- Hậu quả nếu mất kẹp: chỉ chặt hơn, không nguy hiểm.
- Sửa:
  - thêm một ca test với `:ramp` = now + 30s, expect cap = start;
  - hoặc dùng `redis.call('TIME')` trong cả hai script, để mốc và `now` cùng một đồng hồ. Redis 7 cho phép; Upstash cần thử.

**TH-2 — Throttle rps của khách không có trần thời gian, trong khi retention xoá event không xét trạng thái delivery.** Có sẵn từ trước BP, không do BP4 gây ra.
- Phần an toàn: dọn theo QT (`cleanStorageBatch`) đã loại event còn delivery `PENDING/DELIVERING/RETRYING` (tenant-scoped.repository.ts:1579-1580). Vì vậy cửa sổ 6h15m **không** làm mất dữ liệu.
- Phần hở: `deleteExpiredEventsBatchAccounted` (prisma.service.ts:142-147) xoá event quá N ngày mà **không** kiểm delivery. FK `deliveries.event_id` là `onDelete: Cascade` (schema.prisma:644).
- Kịch bản hỏng:
  - Đích có `rate_limit_rps = 1`, tồn hơn 86.400 delivery, `CLEANUP_RETENTION_DAYS = 1`.
  - Delivery còn đang throttle bị xoá theo event.
  - Worker gặp `!row` thì ack, nên mất webhook âm thầm.
- Để xảy ra cần hàng tồn kéo dài hơn số ngày retention (mặc định 7). Với Upstash thì quota sẽ cạn trước: 1 lệnh / 10s / message. Vì vậy chỉ ở mức Thấp.
- Sửa: thêm `AND NOT EXISTS (… d.status IN ('PENDING','DELIVERING','RETRYING'))` vào truy vấn retention event, giống `cleanStorageBatch`. Hoặc ghi nợ cho BP5/BP6.
- Ghi chú kèm: throttle (cả rps lẫn ramp) không ghi `next_attempt_at`. Một delivery RETRYING bị throttle quá 5 phút sẽ bị sweeper ghi thêm outbox. Không gửi trùng (lease + `processed_messages` chặn), chỉ tốn việc. Ramp thêm tối đa ~70s nên không đổi bản chất.

**TH-3 — Chú thích spec §5 nói chưa đủ.**
- Câu "mạch tự về CLOSED vì khoá hết hạn nghĩa là chưa từng OPEN" chưa đủ: xem ngoại lệ ở mục 3.
- Sửa: thêm một dòng vào C11. Không cần sửa code.

**TH-4 — Kẹp `steps ≤ 20` là mã chết.**
- Giá trị env đã kẹp nên `steps` không bao giờ vượt 20, và đột biến bỏ kẹp sống.
- Giữ làm phòng thủ cũng được. Không cần sửa.

`43251f7` (chú thích BP3 ở text.ts:454-457 và nợ §16): đúng với nhận định lượt 2 của BP3.

---

# Lượt 2 — `e862a70..27302c6` (`ff0fa07` + `27302c6`)

## Kết luận lượt 2: **ĐẠT**

HEAD = origin/feat/bp = `27302c6`, nhánh `feat/bp`.

Lưu ý môi trường: trong lúc review, worktree xuất hiện `M apps/hub-worker/src/metrics.ts` và `?? apps/hub-worker/src/backpressure/`. Đây là việc BP5 đang làm dở của dev, không phải của tôi; tôi không đụng vào. Lệnh `tsc` bên dưới chạy khi các file này đang có mặt.

## Đã chạy

- `tsc` hub-worker + hub-api: sạch.
- `jest libs` + circuit-breaker + cleanup-job: 401 qua (71 skip, gồm `retention-db` vì cần Postgres; CI chạy).
- `verify:map`: 0 mồ côi, 0 ma, 0 trùng. Đã checkout lại `TEST-MAP.md`.
- `verify:gates`: 0 vi phạm.

## TH-1, TH-3, TH-4 (`ff0fa07`) — **đóng**

- **TH-1:** đã có test mốc `:ramp` ở tương lai, cả bản fake lẫn Redis thật, kiểm `rampCap = 2` (circuit-breaker.spec.ts:381-385, :668-670). Đột biến "bỏ kẹp `el < 0`" (khi đó cap = 1) giờ bị bắt.
- **TH-3:** ngoại lệ "mạch tự về CLOSED" đã ghi vào C11.
- **TH-4:** đã có chú thích phòng thủ cho trần `steps`.
- Tick `[x] BP4` hợp lệ.

## TH-2 → ADR-199 (`27302c6`) — **đóng**

- **Đúng cột, đúng tập trạng thái:** câu chặn là `d.event_id = ev.id AND d.tenant_id = ev.tenant_id AND d.status IN ('PENDING','DELIVERING','RETRYING')` (prisma.service.ts:146-151).
  - Enum `DeliveryStatus` chỉ có 5 giá trị (schema.prisma:78-84), nên phần bị loại đúng bằng `SUCCEEDED` và `DEAD`.
  - Điều kiện nằm trong `WHERE` trước `LIMIT`, nên event đang bị giữ không chiếm chỗ của lô xoá.
  - `FOR UPDATE OF ev` khoá đúng bảng.
- **Hằng dùng chung:** `IN_FLIGHT_DELIVERY_STATUSES` (constants.ts:36). `cleanStorageBatch` sinh ra đúng chuỗi SQL `('PENDING', 'DELIVERING', 'RETRYING')` như literal cũ, nên hành vi không đổi.
- **An toàn SQL:** `Prisma.raw` chỉ dựng từ mảng hằng `as const`, không có đầu vào người dùng (tenant-scoped.repository.ts:6). `olderThanSeconds` và `limit` vẫn là tham số.
- **Index:** `NOT EXISTS` đi theo unique `deliveries(event_id, subscription_id, attempt_generation)`, có `event_id` đứng đầu (schema.prisma:648).
  - Lưu ý: nếu tồn nhiều event cũ đang bị giữ, mỗi lô vẫn phải quét qua chúng (truy vấn không có `ORDER BY`, lọc theo `received_at`). Chỉ tốn CPU, không sai.
- **Các đường xoá khác:**
  - Lệnh dọn QT: đã chặn, cùng hằng.
  - Retention mẫu REJECTED, raw mồ côi, xoá hẳn raw: không có event hay delivery.
  - Cascade từ `deliveries.subscription_id`: `Restrict`.
  - Source và subscription chỉ lưu trữ, không xoá cứng.
  - Xoá project cascade toàn bộ: đó là chủ đích.
  - Không còn đường xoá theo tuổi nào khác.
- **Test DB** (retention-db.spec.ts:69-89):
  - Giữ đủ 3 trạng thái đang chờ, xoá cả `SUCCEEDED` và `DEAD`.
  - Sau khi delivery chuyển `RETRYING → SUCCEEDED`, lượt sau xoá được.
  - Đủ chặt: bỏ bất kỳ trạng thái nào khỏi tập là test đỏ. Chờ CI job `db`.
- **Số ADR:** 199 dùng cho retention, BP5 dời sang 200, bảng §12 đã sửa. Hợp lý:
  - File ADR chỉ thêm cuối, mới tới 199, chưa ai dùng 200.
  - 192–194 vẫn trống làm đệm cho nhánh khác (C7).
  - Mục §9 cũ không cần số riêng vì đã nằm trong ADR-196/197/198.

## Thấp (ghi nhận, không chặn)

**Race hẹp khi replay một event cũ hơn retention.**
- Kịch bản:
  1. Retention bắt đầu câu lệnh (lấy snapshot).
  2. Replay chèn delivery `PENDING` mới cho event đó và COMMIT.
  3. Retention mới khoá được dòng event. `NOT EXISTS` vẫn đánh giá theo snapshot cũ, nên event bị xoá và CASCADE xoá luôn delivery replay vừa tạo.
  4. Outbox replay chạy, worker gặp `!row` thì ack.
- Cửa sổ chỉ cỡ mili-giây, và chỉ xảy ra với replay event quá N ngày.
- `cleanStorageBatch` cũng có cùng khuôn này từ trước.
- Cách sửa nếu muốn: replay khoá event bằng `SELECT … FOR SHARE` trước khi INSERT, hoặc kiểm `!row` trong cùng transaction. Có thể ghi nợ.
