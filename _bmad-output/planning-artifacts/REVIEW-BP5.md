# REVIEW BP5 — `27302c6..b30dfc0`

Reviewer độc lập, 2026-10-13. Chỉ đọc.
- Trước khi review: đã `git fetch`, xác nhận HEAD = origin/feat/bp = `b30dfc0`, đang ở nhánh `feat/bp`.
- Worktree sạch (chỉ còn các file `REVIEW-*`).

## Kết luận: **CẦN SỬA** (1 mức Trung bình, sửa rẻ). Không có mức Cao.

## Đã chạy

- `npx jest apps/hub-worker apps/hub-api/test/redis-budget.spec.ts apps/hub-api/test/storage-api.spec.ts libs` → 80 suite qua (22 skip), 618 test qua (97 skip).
- `tsc` cả 4 app: hub-api, hub-worker, web, shop đều 0 lỗi.
- `verify:map`: 400 mã, 334 có test, 0 mồ côi, 0 ma, 0 trùng. Đã `git checkout docs/TEST-MAP.md`.
- `verify:gates`: 20 luật, 0 vi phạm.

## Soát theo từng điểm

**1. Mất hoặc treo message**
- **Đốt lượt:** cả spill lẫn hoãn đều không đốt lượt.
  - Delivery spill: dùng `retry.10s`, `attemptCount` và header giữ nguyên (delivery.consumer.ts:256-266).
  - Normalize spill: dùng `retry.30s`, giữ `x-normalize-retry` (normalize.consumer.ts:100-103).
  - Normalize hoãn khi `factor > 0`: không tăng lượt (:233-249).
- **Treo unacked:** không có message nào bị giữ unacked mãi.
  - Chờ permit tối đa `holdMaxMs` rồi spill.
  - Khi tắt máy, `shutdown()` trả kết quả ngay; message để unacked, channel đóng thì RabbitMQ giao lại.
- **Rò permit:** không có. `release` gắn vào `.finally` của `handleMessage`, mà `handleMessage` là async nên lỗi đồng bộ cũng thành promise reject (gate.ts:54). `release` còn chống gọi hai lần (failure-rate.controller.ts:204-212).
- **Deadlock khi permits = 1:** không có. Handler không xin permit thứ hai.
- **Chế độ dò:** khi `f = 1`, release gọi `pump`, `pump` hẹn `probeTimer` đúng lúc được bắt đầu lần kế (:221-229), nên không bị kẹt.

**2. Spill không có trần thời gian và sàn dọn của QT**
- `TOTAL_RETRY_WINDOW_MS` = 22.540.000 + 3.600.000 = 26.140.000 ms ≈ **7h15m40s**. Con số đúng.
- Raw chưa normalize xong không bị dọn âm thầm:
  - Raw ACCEPTED không bao giờ bị retention xoá (ADR-045).
  - Lệnh dọn QT xếp raw chưa có `processed_messages` normalize, còn trong `CLEANUP_RETENTION_DAYS`, vào mức **`high`** (tenant-scoped.repository.ts:2082-2088). Mức này chỉ dọn được khi người dùng xác nhận Cao; tự dọn không đặt được mức Cao.
- Vì vậy **không có đường mất dữ liệu tự động**. Vẫn còn một ca biên, xem TH-1.

**3. Tín hiệu**
- Chỉ `classifyInfraError === 'transient'` được tính là lỗi.
- Lỗi của đích không bao giờ thành tín hiệu: sender không ném lỗi, kết quả HTTP được tính `ok`.
- Mọi lệnh Redis trong đường delivery và normalize đều có `catch`/`.catch`. Vì vậy một ECONNREFUSED của Redis không lọt được vào nhánh `catch` ngoài cùng để bị đếm thành lỗi DB.
- Bảng mã chỉ thêm 57P01/02/03 và 08000/001/003/004/006. **Không** có 08P01 (protocol violation) hay 08007. Regex nội dung chỉ áp cho `PrismaClientUnknownRequestError`.
- amqplib "Channel closed" vẫn là `unknown`.

**4. C12 ("thiếu mẫu mà còn lỗi thì giữ factor")** — không kẹt:
- `tick()` gọi `failureRate()`, hàm này `prune` cửa sổ trước khi đếm lỗi (:116-145).
- Không còn traffic: sau 30s lỗi cũ trôi khỏi cửa sổ, factor giảm 0,1 mỗi giây, khoảng 10s là về 0.
- DB sống lại mà vẫn ở chế độ dò: các lần dò thành công, lỗi cũ trôi khỏi cửa sổ sau 30s, factor hồi.

**5. C5 (tắt máy)** — trình tự đúng: cancel 2 consumer → `backpressure.shutdown()` → `waitIdle` (main.ts:194-200).
- `inFlight` chỉ đếm message đã có permit (gate.ts:54-56).
- `exitOnChannelClose` bị bỏ qua khi `shuttingDown` (:137).
- `main.ts` chưa có test. Rủi ro thấp: trình tự chỉ 3 lệnh, và T24 đã kiểm hành vi của controller + gate. Đề xuất, nếu muốn chặt: tách `gracefulStop({ channels, tags, backpressure, inFlight, timeout })` khỏi `main.ts`, rồi test thứ tự gọi bằng spy (cancel trước `shutdown`, `shutdown` trước `waitIdle`) và kiểm message đang giữ không bị ack, nack hay republish.

**6. Worker thoát khi channel đóng**
- Ở môi trường deployed, worker chạy chung container **hub-all** với hub-api. Supervisor thấy một tiến trình con thoát ngoài ý muốn thì dừng cả container (docker/hub-all.js:162-168). Render khởi động lại container khi nó thoát.
- Hệ quả: một lần channel đóng làm ingest cũng tắt tới khi container lên lại. Provider tự retry (BB-3), nên không mất sự kiện.
- Đường "connection đóng" đã hành xử như vậy từ trước. BP5 chỉ thêm một nguyên nhân kích hoạt.
- Crash loop chỉ xảy ra khi lỗi channel lặp lại theo một nguyên nhân cố định (ví dụ ack hai lần). Trước đây ca đó cho ra worker zombie, nên thoát và khởi động lại vẫn tốt hơn. Xem TH-2.

**7. R1, metric và env**
- 0 lệnh Redis thêm.
- Label metric thuộc tập cố định (`dependency=db`, `consumer` 2 giá trị, `reason` 4 giá trị).
- Env sai thì về mặc định.
- `NORMALIZE_MAX_DEFER_MS` được kẹp trong khoảng [30s, 60 phút].

**8. Test mô phỏng T4/T21**
- Đều dùng fake timer và có cận trên.
- T4 mô phỏng prefetch bằng cách giao 20 message mỗi giây, trong khi message đang giữ không trừ vào prefetch. Như vậy mô phỏng **nặng hơn** thực tế (prefetch thật giới hạn 20 message unacked), nên cận trên vẫn đứng.
- T21: DB chết 10 phút, DLQ ≤ 5, cuối cùng không còn message nào treo. Đúng điều spec yêu cầu.

## Phát hiện

### Trung bình

**TB-1 — Một bộ permit `MAX = 20` dùng chung cho normalize và delivery, và permit được giữ trong suốt lần gọi HTTP tới đích.**
- Vị trí: worker.module.ts:31, gate.ts:54, failure-rate.controller.ts:42.
- Ở `factor = 0`, tổng số việc chạy đồng thời mỗi tiến trình giảm từ 40 (20 + 20 theo prefetch) xuống **20**.
- Kịch bản hỏng:
  - Đích của tenant `cafe` chậm hoặc timeout 10s (`DELIVERY_TIMEOUT_MS`).
  - 20 delivery tới đích đó chiếm hết 20 permit.
  - Normalize của **mọi** tenant phải xếp hàng sau chúng, mỗi message chờ cỡ 10–20s.
- Trước BP5, normalize không phụ thuộc gì vào độ chậm của đích. Đây là lỗi của đích làm chậm tenant khác, trái §0 (chính nguyên tắc BP5 nêu: "đích chỉ là của một tenant"). Chưa đủ 60s để spill, nên không mất dữ liệu, chỉ trễ và giảm thông lượng.
- Cách sửa rẻ: **một factor (một tín hiệu), hai semaphore** (normalize và delivery, mỗi cái `MAX = prefetch = 20`). Spec §7.1 chỉ yêu cầu "một controller cho mỗi dependency", không đòi một semaphore. Phương án khác: `MAX = 40`.
- Thêm test: 20 delivery treo 10s ở factor 0 thì normalize vẫn bắt đầu ngay.

### Thấp

**TH-1 — Spill không có trần thời gian, nên lời hứa của sàn 7h15m bị hở.**
- Vị trí: gate.ts:42-50. C12 đã ghi nhận.
- Kịch bản: DB chập chờn nhiều giờ (factor > 0 kéo dài), một raw cứ bị spill mãi, chưa normalize được, đã quá 7h15m. Người dùng dọn mức Cao (`confirmHigh`). Raw bị dọn body, normalize về sau đọc thân rỗng, vào DLQ. Mất sự kiện, dù người dùng đã xác nhận.
- Cách sửa: spill đặt `x-normalize-deferred-since` nếu chưa có, dùng chung trần `NORMALIZE_MAX_DEFER_MS` với nhánh hoãn. Quá trần thì đi đường đốt lượt / DLQ (raw thành ứng viên renormalize), thay vì spill vô hạn.
- Nhánh hoãn normalize cũng có thể vượt trần thêm khoảng một vòng 30s + 60s giữ, nhưng cửa sổ không cộng phần này. Nên cộng một vòng như đã làm với circuit.

**TH-2 — Đường thoát khi channel đóng.**
- Có thể thêm log mã lỗi của channel (`err.code`) vào dòng `error` trước khi thoát để phân biệt lỗi lặp, phục vụ chẩn đoán crash loop.
- Nên ghi vào DEPLOYMENT: ở hub-all, worker thoát nghĩa là cả container khởi động lại, ingest gián đoạn tới khi lên lại.

**TH-3 — `main.ts` chưa có test.** Đề xuất ở mục 5.

---

# Lượt 2 — `b30dfc0..c3ffa41`

## Kết luận lượt 2: **ĐẠT**

Bốn mục của lượt 1 (TB-1, TH-1, TH-2, TH-3/C5) đã đóng, không phát hiện lỗi mới. Còn hai điểm Thấp: một cần ghi lại, một không cần sửa.

HEAD = origin/feat/bp = `c3ffa41`, nhánh `feat/bp`.

## Đã chạy

- jest (`apps/hub-worker` + `libs` + `storage-api`): 607 qua, 97 skip.
- tsc hub-worker + hub-api: sạch.
- verify:map: 0 mồ côi, 0 ma, 0 trùng. Đã checkout lại `TEST-MAP.md`.
- verify:gates: 0 vi phạm.
- Đột biến (cả hai đã trả lại):
  - Dùng chung một lane (bỏ `acquire(consumer)`): **3 test đỏ**.
  - Đảo thứ tự `shutdown()` trước `cancelConsumers()` trong `gracefulStop`: **1 test đỏ**.

## Từng mục

**TB-1 — Đóng**
- Thiết kế mới: một factor, một semaphore cho mỗi lane (failure-rate.controller.ts:70-76, :213-268). `runGated` gọi `acquire(consumer)` (gate.ts:39).
- Test: 20 delivery treo HTTP mà 20 normalize vẫn bắt đầu ngay; delivery thứ 21 phải chờ.
- Lúc khoẻ, mỗi tiến trình lại chạy được 40 việc đồng thời, như trước BP5.

**(1) Chế độ dò: 2 lần / 5s mỗi tiến trình. T4 vẫn đúng, nhưng chỉ đo một lane**
- T4 chỉ chạy lane delivery, nên kết luận "≤ 1 lần / giây sau giây thứ 5" vẫn đúng cho lane đó.
- Trần thật của cả tiến trình khi DB chết là ≤ 2 lần gọi DB mỗi 5s (mỗi lane 1). Mức này vẫn đúng tinh thần §7.1 "một message đi dò mỗi 5 giây": đó là nhịp mỗi lane, tức 2 lần gọi thay vì 1.
- **Thấp:** ghi rõ điều này vào C12/ADR-200. Nếu muốn T4 phủ đủ, cho T4 bơm thêm lane normalize và assert ≤ 2 lần / 5s / tiến trình.

**(2) Cửa sổ 7h16m10s không cộng thời gian giữ chờ permit — Thấp, không có đường mất dữ liệu**
- Con số 26.170.000 ms = 7h16m10s đã kiểm bằng chạy thật.
- Mỗi vòng normalize khi đang lùi có thể tốn tới 30s chờ queue + 60s giữ. Vì vậy:
  - Trần 60 phút có thể vượt khoảng 90s.
  - Sau trần còn 5 lượt × (30s + 60s) ≈ 7,5 phút, trong khi cửa sổ chỉ cộng 5 × 30s = 2,5 phút.
  - Tổng hụt cỡ 6–7 phút.
- Vì sao không mất dữ liệu:
  - Raw chưa normalize còn mức **`high`** suốt `CLEANUP_RETENTION_DAYS` (≥ 1 ngày), nên tự dọn không đụng tới được.
  - Chỉ còn lệnh dọn tay có `confirmHigh` với `olderThan` sát mốc 7h16m.
  - Sau DLQ, raw vẫn là ứng viên renormalize.
  - Delivery thì đã có ADR-199 che (giữ theo trạng thái).
- Muốn đóng hẳn: cộng `(NORMALIZE_MAX_RETRIES + 1) × BACKPRESSURE_HOLD_MAX_MS` (6 phút) vào cửa sổ. Không bắt buộc.

**(3) Spill quá trần → `nack(false)`: đúng**
- `q.normalize` **có** DLX: `deadLetterExchange: x.hub.normalize.dlx` → `q.normalize.dlq` (topology.ts:88-91, :85-86).
- Vì vậy không dính bẫy của BP1; bẫy đó chỉ ở delivery main, nơi không có DLX.
- Spill trong trần thì giữ `since` và không đốt lượt. Quá trần thì +1 lượt. Hết lượt thì vào DLQ (normalize.consumer.ts:102-121). Có test cho cả 3 nhánh.

**(4) `gracefulStop` — Đóng**
- Thứ tự đúng (shutdown.ts:21-28): cancel → `backpressure.shutdown()` → chờ handler song song với việc nền → `closeAll`.
- Test kiểm cả thứ tự lẫn kết quả: message đang giữ trả `shutdown`, không ack, không nack, không republish, không spill; message đã có permit chạy xong rồi mới ack. Đột biến đảo thứ tự bị bắt.
- `main.ts` dùng đúng hàm này (main.ts:203-222).

**TH-2 — Đóng**
- Log `code` và `reason` của lỗi channel gần nhất trước khi thoát (main.ts:137-150).
- DEPLOYMENT đã ghi rõ: worker chạy chung container hub-all với hub-api, nên worker thoát thì cả container khởi động lại.

---

# Lượt 3 — `c3ffa41..3777547`

## Kết luận lượt 3: **ĐẠT** — BP5 xong

HEAD = origin/feat/bp = `3777547`, nhánh `feat/bp`.

**Kiểm chạy:**
- jest (worker + libs + storage-api): 607 qua.
- tsc hub-worker + hub-api: sạch.
- verify:map: 0 mồ côi, 0 ma, 0 trùng. Đã checkout lại `TEST-MAP.md`.

**T4 — Đạt**
- Mô phỏng chạy cả hai lane: 200 delivery + 100 normalize.
- Sau giây thứ 5, test trượt **mọi** cửa sổ 5s và kiểm mỗi cửa sổ có ≤ 2 lần gọi Prisma cho cả tiến trình. Đây là test thật, đúng mô hình mỗi lane dò 1 lần / 5s.
- Đột biến đổi `probeIntervalMs` xuống 2s → T4 đỏ.

**`backpressureHoldMaxMs()` — Đạt, một nguồn**
- Định nghĩa ở `@hub/messaging` (retry-window.ts:23-28): chỉ cho phép kẹp thấp hơn, khoảng [1s, 60s]; giá trị bậy về 60s.
- Controller dùng đúng nguồn này:
  - `BACKPRESSURE_DEFAULTS.holdMaxMs` lấy từ hằng số `BACKPRESSURE_HOLD_MAX_MS`;
  - `backpressureOptionsFromEnv` gọi `backpressureHoldMaxMs` (failure-rate.controller.ts:48, :63);
  - worker.module tạo controller qua `backpressureOptionsFromEnv`.
- Test env: `600000` → 60s; `30000` → 30s; `10` → 1s.

**Cửa sổ retry — Đạt**
- `TOTAL_RETRY_WINDOW_MS` = 26.530.000 ms = **7h22m10s** (chạy thật), tức cũ cộng 6 × 60s.
- Phần cộng thêm nằm chung nhóm "mỗi lần thử delivery", nhưng 6 × 60s cũng đủ phủ 6 vòng giữ của normalize (1 lần đầu + 5 lượt).
- Mọi nơi QT dùng sàn đều import hằng số này. Các test tính động qua; cleanup-job và storage-clean đã cập nhật số.
- Riêng delivery spill vẫn không có trần, nhưng ADR-199 che (giữ theo trạng thái delivery). Không có đường mất dữ liệu.

**Tick `[x] BP5` — Hợp lệ**
- SPEC §11:380 đã đánh dấu.
- `verify:map` sạch. Các mã T4, T17–T21, T24 đều có test.
