# REVIEW-F3 — `feat/bp-f3` (`1c84d84` code + `e6e3aec` docs) so với `origin/master` `d417118`

Reviewer: Murat 🧪 · 2026-10-15 · Worktree `C:\wt\ui`

## Kết luận: **CHƯA ĐẠT** (0 Nặng · 2 TB · 9 Thấp)

Phần thiết kế và phép tính đều đúng. Lua đọc tay không thấy lỗi cú pháp hay lỗi logic. Ngân sách R1 giữ nguyên 1 lệnh client. TOTAL đúng 27.250.000 ms. Kịch bản T16 không bị nới tiêu chí.

Lý do CHƯA ĐẠT:

- Bản Lua thật **chưa chạy lần nào**.
- ADR-234 ghi kết quả mô phỏng như thể đã chạy rồi.

Muốn lên ĐẠT cần ba việc:

1. Job CI `db (L1)` xanh. Job này có `redis:7-alpine`, nên việc này **không cần máy công ty**.
2. Sửa câu chữ ADR-234 theo TB-2.
3. Chaos T16 có thể chạy sau khi gộp, nhưng ADR phải ghi rõ "chưa đo".

### Đã tự kiểm

- Jest L0 `--maxWorkers=1`, 5 suite: circuit-breaker, redis-budget, cleanup-job, storage-api, storage-clean. Kết quả **63 pass, 11 skip** (11 ca skip là L1, vì máy không có Redis/PG).
- `tsc --noEmit` ba project hub-worker, hub-api, libs/messaging: sạch.
- Tính tay mô hình 500 hàng dồn 1 giây/vòng, ra `[2,4,8,16,32,64,64,64,64,64,64,54]` và hết ở +110 s. Khớp kỳ vọng của test L1. Đây là tính tay, chưa phải bằng chứng chạy.
- TOTAL: 10s + 1m + 5m + 30m + 2h + 150s + 60m + 30s + 6 × (30m + 5m + 190s + 60s) = 27.250.000 ms = 7h34m10s. Đúng.
- ADR-234 không trùng số trên mọi nhánh local/remote (`git grep ADR-234`).

---

## TB

### TB-1 — Lua `LUA_GATE` mới chưa từng chạy; L0 chỉ kiểm bản sao JS của Lua

- **Vị trí:**
  - `apps/hub-worker/src/circuit/circuit-breaker.service.ts:66-102`;
  - fake ở `apps/hub-worker/test/circuit-breaker.spec.ts:94-116`;
  - fake ở `apps/hub-api/test/redis-budget.spec.ts:36-57`.
- **Vấn đề:** cả hai fake nhận diện script bằng `script === LUA_GATE` hoặc `/PTTL/`, rồi **viết lại** logic bằng JS. Mọi ca L0 mới đều kiểm bản sao đó:
  - `[BP:T15] (phần d/e)`;
  - `[BP:T22] (phần f)`.

  Bản sao còn lệch với Lua thật ở ba chỗ:
  - hardcode `5` thay vì `DELIVERY_RAMP_MAX_DOUBLINGS`;
  - **bỏ điều kiện `ext > PTTL`**: fake ghi `pexpires` vô điều kiện;
  - không mô phỏng PTTL.
- **Kịch bản lỗi:** một lỗi runtime trong Lua làm `eval` ném lỗi. Ví dụ `tonumber(nil)` so sánh nếu ai đổi thứ tự ARGV, hoặc gõ sai tên biến. Khi đó `getState` rơi vào `catch` và trả `{CLOSED, degraded}`. Hệ quả:
  - **circuit breaker và throttle tắt im lặng cho mọi đích**, vì fail-open;
  - L0 vẫn xanh 100%.

  Chỉ L1 (`describeRedis`) bắt được, mà L1 chưa chạy.
- **Nhánh chưa test ở tầng nào:** `ext > PTTL` ("không rút ngắn").
  - Với cấu hình mặc định, nhánh này hầu như không quyết định gì. Ở bậc cuối el ≥ 50 s thì PTTL ≤ 20 s ≤ ext.
  - Với `DELIVERY_RAMP_STEP_SECONDS=1`: bậc cuối tới ở 5 s, PTTL ≈ 56 s, ext = 2 s. **Nếu thiếu guard thì khoá bị cắt còn 2 s.** Đây đúng là lỗi mà guard sinh ra để chặn.
  - Hiện không có test L0 hay L1 nào đi qua ca step nhỏ có gia hạn.
- **Cần:**
  - CI `db (L1)` xanh trên chính commit này;
  - thêm một ca L1 `DELIVERY_RAMP_STEP_SECONDS=1` + lưu lượng 100 rps: PTTL sau gate phải ≥ PTTL trước, không bị rút ngắn;
  - nên cho fake mô phỏng `ext > pttl` theo một PTTL ảo.

### TB-2 — ADR-234 ghi kết quả L1 như đã có, trong khi L1 chưa chạy

- **Vị trí:** `docs/adr/README.md:2372`, dòng **Đánh đổi**.
- **Vấn đề:** ADR viết "Mô phỏng L1 (Redis thật, đồng hồ giả) **cho thấy** 500 hàng dồn 1 giây/vòng xả hết ở +110 s, không giây nào > 64". Nhưng chính `F3-VIEC-MAY-CONG-TY.md` nói L1 "chưa chạy lần nào".
- **Kịch bản lỗi:** ADR là append-only và được trích vào báo cáo đồ án. Nếu L1 đỏ, có hai khả năng:
  - lý do là PTTL, đúng như F3-VIEC đã cảnh báo;
  - Upstash/Redis xử lý `PTTL` trong script khác đi.

  Khi đó nhật ký quyết định đang khẳng định một kết quả không tồn tại. Điều này vi phạm luật kiểm chứng VF (RED→PROBED→REVIEWED, ADR-067).
- **Cần:** đổi thành "Kỳ vọng (tính tay, L1 **chưa chạy**): …". Đặt sẵn dòng "Đo lại: L1 — chưa · T16 — chưa" để điền sau.

---

## Thấp

### Thấp-1 — Lệch đồng hồ: trần 180 s chỉ đúng nếu không có skew, trong khi tài liệu nói "không bao giờ"

- **Vị trí:**
  - `circuit-breaker.service.ts:75,95`;
  - `docs/ARCHITECTURE.md:354`;
  - comment ở `circuit-breaker.service.ts:55-57`.
- **Cách đang làm:** rampStart lấy từ `Date.now()` của worker đã probe. `now` lấy từ `Date.now()` của worker đang gate. Script không dùng `TIME`, nhờ vậy deterministic, an toàn cho replication và cho Redis < 5 (verbatim replication). Lựa chọn này tốt.
- **Kịch bản lỗi:** worker B chạy chậm D giây so với worker A, là worker đặt `rampStart`. Khi đó:
  - `el` của B nhỏ hơn thật D giây, nên `left = RAMP_MAX − el` lớn hơn D giây;
  - B `PEXPIRE` khoá tới rampStart + 180 s + D (theo đồng hồ Redis);
  - B vẫn thấy `el < RAMP_MAX`, nên ramp còn áp thêm D giây.

  Mỗi lần thử bị giữ tới 190 s + D, vượt phần `DELIVERY_RAMP_DEFER_MS` đã cộng vào TOTAL.
- **Đánh giá:** NTP thường lệch cỡ ms, nên rủi ro thực tế thấp. Nhưng câu "ramp không bao giờ sống quá RAMP_MAX" ở code, ARCHITECTURE và ADR là nói quá.
- **Sửa:** ghi "≤ RAMP_MAX + độ lệch đồng hồ giữa các worker", hoặc dùng `TIME` cho cả `SET :ramp` lẫn gate.

### Thấp-2 — Gia hạn `2 × step` không tính tới nhịp `retry.10s`; env bước nhỏ làm F3 mất tác dụng

- **Vị trí:** `circuit-breaker.service.ts:94`; ADR-234 dòng Chọn ("giữ được env bước nhỏ cho test/demo").
- **Kịch bản lỗi:** `DELIVERY_RAMP_STEP_SECONDS=4`:
  - ext = 8 s, nhưng hàng bị chặn chỉ quay lại sau 10 s;
  - wave cuối gia hạn khoá thêm 8 s, khoá hết hạn trước wave kế tiếp;
  - backlog còn lại dội về hết tốc. **Đúng lỗi F3 cần sửa, chỉ khác là xảy ra khi step < 5 s.**
- **Đánh giá:** mặc định 10 s → ext 20 s > 10 s, nên cấu hình mặc định không dính.
- **Sửa:** `ext = max(2 × step, retry.10s + 1 bậc)`, hoặc ghi rõ hạn chế này trong ADR/DEPLOYMENT.

### Thấp-3 — Hạ `DELIVERY_RAMP_SECONDS` giờ có thể làm hồi phục *chậm hơn*

- **Vị trí:** `libs/messaging/src/retry-window.ts:120` (maxSeconds mặc định 180 bất kể `seconds`) và `deliveryRampLastStep`.
- **Kịch bản lỗi:** `DELIVERY_RAMP_SECONDS=10`, `STEP=10`:
  - bậc cuối = 0, nên trần = 2 rps ngay từ đầu, và `atLast` đúng ngay;
  - backlog 500 làm gate bị chặn liên tục, khoá được gia hạn tới 180 s;
  - đích chỉ nhận **2 rps trong 3 phút** (360 hàng), rồi phần còn lại mới dội về.

  Trước ADR-234, cấu hình này hết ramp sau 20 s. Người vận hành hạ env để ramp ngắn lại thì nhận về ramp 2 rps dài 9 lần. Cửa sổ retry vẫn an toàn.
- **Sửa:** mặc định `maxSeconds = min(180, 3 × keySeconds)`, hoặc ghi cảnh báo ở DEPLOYMENT.

### Thấp-4 — Thấp-9 kẹp *số lần nhân đôi*, không kẹp *trần cuối*

- **Vị trí:** `retry-window.ts:115`. `DELIVERY_RAMP_START_RPS` chỉ có kẹp dưới (≥ 1), không có kẹp trên.
- **Kịch bản:** `DELIVERY_RAMP_START_RPS=5000` → trần cuối 160.000 rps.
- **Đánh giá:** lỗ này có từ BP4, không phải lỗi mới. Nhưng ADR-234/ARCHITECTURE tuyên bố "trần cuối ≤ start × 32" như đã đóng Thấp-9, trong khi bàn giao §3 ghi "kẹp trần cuối".
- **Sửa:** kẹp `start` (ví dụ ≤ mặc định, giống các env BP khác) hoặc ghi rõ.

### Thấp-5 — Báo cáo dev "env RAMP_MAX tối thiểu 70 s" không chính xác

- **Vị trí:** `retry-window.ts:119-120`.
- **Chi tiết:**
  - Sàn thật là `seconds + step`. Ví dụ `DELIVERY_RAMP_SECONDS=20`, `STEP=5` cho sàn 25 s, và test `[BP:T15] (phần d)` cũng khoá đúng giá trị 25.
  - `DELIVERY_RAMP_MAX_SECONDS=0` hoặc âm sẽ lấy **180**, không phải "tắt". Hướng này đúng (không nới), nhưng DEPLOYMENT.md:592 không nói.

  Code đúng, chỉ báo cáo và tài liệu thiếu.

### Thấp-6 — `:ramp` hỏng giá trị: hành vi đổi lặng lẽ

- **Vị trí:** `circuit-breaker.service.ts:75-78`.
- **Chi tiết:** với `rs` không phải số, `tonumber(rs) or 0` cho `el ≈ 1,7e12`, lớn hơn RAMP_MAX, nên **tắt ramp**. Trước ADR-234, giá trị hỏng cho trần bậc cuối (64).
- **Đánh giá:** tắt ramp khớp với nguyên tắc "mất `:ramp` → gửi bình thường", nên chấp nhận được. Khoá hỏng sống ≤ 70 s và không được gia hạn. Tuy vậy chưa có test và chưa có dòng tài liệu nào.

### Thấp-7 — ADR-234 nằm trong dải PK, trong khi nợ Thấp #3 chưa sửa

- **Vị trí:** `docs/adr/README.md:2368` (tiêu đề tự ghi "dải PK 234+").
- **Chi tiết:** `_bmad-output/planning-artifacts/hub-sap/SPEC-hub-sap.md:93` vẫn ghi "PK dùng 230+". Agent PK grep master **trước khi** nhánh này gộp sẽ lấy 234, gây chồng số.
- **Sửa:** sửa dòng 93 thành "PK: 230, 235+" cùng lượt gộp.
- **Định dạng:** ADR đúng khuôn 3 dòng (Vấn đề / Chọn / Đánh đổi), nhưng dòng Chọn quá dài. Có thể chấp nhận.

### Thấp-8 — `docs/TEST-MAP.md` sinh lại trên Windows, mất toàn bộ trạng thái

- **Vị trí:** `docs/TEST-MAP.md` (diff 591 dòng trong commit code).
- **Chi tiết:** mọi dòng "✅ pass" thành "chưa chạy", header thành "commit —". Phần lớn churn không liên quan F3. Bản master trước đó có ghi chú "Sinh lại trên Linux/CI trước khi merge".
- **Sửa:** sinh lại trên CI/Linux sau khi L1 xanh, hoặc tách khỏi commit F3.

### Thấp-9 — Chaos T16: biên `rampEnd` đo bằng poll và chia đôi giây epoch

- **Vị trí:** `verify/scenarios/chaos-bp.ts:380-382`.
- **Chi tiết:**
  - `rampEnd = Date.now()` sau khi `waitFor` thấy khoá mất. Poll 250 ms cộng RTT, nên trễ tới khoảng 300 ms.
  - Giây epoch chứa `rampEnd` bị cắt làm hai, phần đầu tính vào "trong ramp" (trần 64), phần sau tính vào "sau ramp" (trần 64). Một cục 120 request rơi đúng giây biên có thể lọt cả hai kiểm.

  Lỗ biên này **có từ ADR-232**, không do F3 tạo ra.
- **Kết luận:** tiêu chí **không bị nới**. Nhánh còn thêm kiểm `rampLenMs ≤ RAMP_MAX + 1 s`. Đề xuất (không bắt buộc): kiểm thêm "giây biên gộp ≤ 2 × 64".

---

## Trả lời từng câu hỏi của brief

1. **Lua**
   - Điều kiện `atLast and t > cap` đúng nghĩa "bậc cuối VÀ bị trần ramp chặn". Nếu `rate_limit_rps` của khách < rampCap, gate bị chặn bởi rps chứ không phải ramp, nên không gia hạn. Đúng.
   - Không rút ngắn TTL, nhờ guard `ext > PTTL`. Guard này chưa có test, xem TB-1.
   - PTTL = −1 (khoá không có TTL) thì guard gán TTL. Tốt.
   - `left > 0` luôn đúng, vì nhánh chỉ chạy khi `el < ARGV[8]`.
   - Mọi số đều nguyên, `math.floor(ext)` chỉ để chắc. `el` âm được kẹp về 0.
   - Thời gian lấy từ client. Script không dùng `TIME`, nên deterministic với replication. Lệch đồng hồ: xem Thấp-1.
   - Giá trị hỏng: xem Thấp-6.
2. **Ngân sách Redis**
   - `PEXPIRE`/`PTTL` nằm trong EVAL, nên mọi nhánh vẫn 1 lệnh client, gồm cả bên thua probe ở gate trước và sau khi nạp. Phần e đóng luôn nợ Thấp #4.
   - redis-budget phần f assert `take() == ['eval']` và `findDeliveryForSend`/`deferDelivery` không được gọi. Assert như vậy chặt ở tầng lệnh client. Nếu ai thêm một lệnh client riêng, fake không có method đó sẽ làm hỏng kỳ vọng. Riêng logic trong script thì chỉ kiểm qua bản sao, xem TB-1.
3. **TOTAL_RETRY_WINDOW_MS** = 27.250.000 ms, đúng.
   - Nơi dùng: `isCutoffOutsideRetryWindow` (lệnh dọn `olderThan`), `assertRetentionSafe` (retention ngày), `putStoragePolicies` (`afterDays` ≥ 1 ngày).
   - Hợp đồng API đổi một chỗ: `olderThan` trong khoảng [7h23m10s, 7h34m10s) trước trả 200, nay trả 400. ADR đã ghi.
   - Web console chỉ gợi ý theo ngày (`storage-logic.ts`), nên không gãy.
   - `CLEANUP_RETENTION_DAYS` trong khoảng [0,308; 0,3154) nay ném lỗi lúc khởi động worker. Ca này hầu như không xảy ra.
4. **Env**
   - Kẹp đúng hướng: chỉ thấp hơn 180, không dưới khoá gốc. Parse lỗi hoặc ≤ 0 đều lấy 180.
   - DEPLOYMENT.md:592 đã ghi env mới, nhưng thiếu ý "0 = 180" (Thấp-5) và thiếu cảnh báo Thấp-2/3.
5. **Test**
   - L0 chủ yếu kiểm bản sao JS (TB-1). L1 `simulateRamp` thì hợp lý:
     - dùng hạn ảo `virtExp` và đặt lại PTTL thật trước mỗi giây;
     - PEXPIRE của test không nằm trong ngân sách.
   - Phân tích độ chập chờn: điểm nhạy duy nhất là phép so `pAfter > pBefore` ở các giây 161–179, khi ext ≈ PTTL. Nhưng dù phép so ra kết quả nào, `virtExp` vẫn ≤ start + 180 s và `expiredAt` vẫn nằm trong (start + 179 s, start + 180 s]. Vì vậy test **không chập chờn** theo đồng hồ thật.
   - Chi phí khoảng 19.000 EVAL, vài giây, chạy CI được.
6. **Chaos T16:** không nới tiêu chí, xem Thấp-9.
7. **Tài liệu**
   - ARCHITECTURE, DEPLOYMENT, retry-window, storage-api và các comment test đã cập nhật 7h34m10s. Không còn chỗ nào sót "7h23m" ngoài ADR lịch sử.
   - ADR-234 đúng 3 dòng và không chồng số.
   - Hai chỗ phải sửa: câu khẳng định L1 (TB-2) và cụm "không bao giờ" (Thấp-1).

---

## Phản hồi của dev (2026-10-15)

| Mục | Xử lý |
|---|---|
| **TB-1** | Thêm ca L1 `[BP:T16] (phần d)` trong `circuit-breaker.spec.ts` (khối `describeRedis`, chạy trong CI `db (L1)`). Ca này chạy Lua thật với `DELIVERY_RAMP_STEP_SECONDS=1` và 100 rps đều. Kiểm trần 2..64 và kiểm guard `ext > PTTL`: không giây nào PTTL bị rút ngắn, lần gia hạn đầu ở giây 50. Kiểm thêm khoá hết trong (start+179 s, start+180 s], và `:ramp` hỏng thì không ramp. Hai fake JS đã khớp với Lua: dùng `DELIVERY_RAMP_MAX_DOUBLINGS`, có `ext > PTTL` theo hạn ảo `rampExp`, đọc mức gia hạn từ ARGV[9], ghi rõ PHẠM VI FAKE. Fake L0 có thêm ca guard với bước 1 s. **Chưa chạy local** (máy không có Redis). Bằng chứng = CI `db (L1)` sau khi push. |
| **TB-2** | Dòng Đánh đổi của ADR-234 đổi thành "**Kỳ vọng (tính tay, CHƯA chạy)**". Thêm dòng "**Đo lại:** L1 — chưa · T16 — chưa". |
| Thấp-1 | Bỏ "không bao giờ" ở code, ARCHITECTURE và ADR. Nay ghi "≤ RAMP_MAX + độ lệch đồng hồ D giữa các worker (không dùng `TIME`, để script deterministic)". |
| Thấp-2 | Mức gia hạn đổi thành `deliveryRampExtendMs` = max(2 × step, 10 s + step), truyền qua ARGV[9]. Mặc định vẫn 20 s; step 4 → 14 s; step 1 → 11 s. Có test L0. |
| Thấp-3 | `maxSeconds` mặc định = min(180, 3 × (ramp + step)). Ví dụ ramp 10 s / step 10 s → 60 s, không còn 180 s ở 2 rps. Env chỉ kẹp thấp hơn mặc định đó. Có test L0. |
| Thấp-4 | `DELIVERY_RAMP_START_RPS` chỉ kẹp thấp hơn 2, nên trần cuối tuyệt đối ≤ 64. Test cũ `START=5` đổi kỳ vọng thành 2. Có test L0 với `START=5000`. |
| Thấp-5 | DEPLOYMENT đã ghi sàn `RAMP_SECONDS + STEP`, mặc định min(180, 3×…), và "0/bậy → mặc định (không phải tắt)". |
| Thấp-6 | Ghi trong comment `LUA_GATE` và ADR-234. Có test cả fake L0 lẫn L1 Lua thật (`'hong'` → CLOSED, không ramp). |
| Thấp-7 | `SPEC-hub-sap.md:93` → "PK: 230, 235+ (231–234 thuộc BP)". Tiêu đề ADR-234 ghi "PK dùng 235+". |
| Thấp-8 | `docs/TEST-MAP.md` khôi phục bản master `d417118`, giữ nguyên các trạng thái ✅. Chỉ thêm 3 dòng `BP:T15`/`BP:T16`/`BP:T22` (bản master chưa có dòng BP nào). Sinh lại trọn file trên Linux/CI sau. |
| Thấp-9 | **Ghi nợ.** Lỗ biên giây epoch có từ ADR-232. Kiểm "giây biên gộp ≤ 2 × 64" không thêm được gì: hai kiểm "trong ramp ≤ 64" và "sau ramp ≤ 64" đã kéo theo ≤ 128. Phần còn lại là sai số poll 250 ms, chấp nhận. |
