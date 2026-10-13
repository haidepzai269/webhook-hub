# REVIEW BP2 — `68ba412..2be4121` (b8933d0, 779d575, 2be4121)

Reviewer độc lập, 2026-10-13. Chỉ đọc. Các đột biến thử đã `git checkout` trả lại.

## Kết luận: **ĐẠT** (kèm 2 việc Trung bình nên làm trước merge, phần còn lại ghi nợ)

Không tìm thấy ca nào làm mất delivery, kẹt vĩnh viễn, gửi khi circuit OPEN hay gửi trùng mới so với trước.

## Đã chạy

- `npx jest apps/hub-worker apps/hub-api/test/redis-budget.spec.ts libs`: 78 suite qua, 22 skip (DB/Redis thật), 589 test qua, 89 skip.
- `tsc --noEmit` cho hub-worker và hub-api: sạch.
- `verify:map`: 400 mã, 0 mồ côi, 0 ma, 0 trùng. Đã `git checkout docs/TEST-MAP.md`.
- Đột biến (chạy `delivery-*` + `redis-budget`):
  - Bỏ `deliveryMsg = {...gợi ý đúng}`: 6 test đỏ.
  - `freshAttemptHeaders` không xoá `since`: 1 test đỏ.
  - Ghi DB chỉ lần đầu (bỏ nhịp 2 phút): 1 test đỏ.
  - **Bỏ `releaseHeldProbe()` ở nhánh gợi ý lệch đích: không test nào đỏ** (xem TB-1).

## Soát theo từng điểm

1. **Đúng đắn gửi hàng**
   - Probe giành theo gợi ý, sau đó row khác đích: `releaseHeldProbe` nhả đúng `probeFor`/token (delivery.consumer.ts:330). Giành lại cho đích thật thì `releaseProbe` dùng `heldToken` + `destinationId` thật (:380-381).
   - Các nhánh `!row`, archived, processed hit, thua lease, throttle đều nhả probe.
   - Hint OPEN quá trần thì nạp row, rồi quyết định lại bằng view của đích thật. Nhờ đó không ghi lần thử thất bại oan (T11b).
2. **Message cũ và rolling deploy**
   - Hint chỉ dùng khi có đủ cả `destinationId` (string) lẫn `rateLimitRps` (số nguyên). Thiếu một trong hai thì đi đường cũ (:270-273).
   - `rateLimitRps` là `Int @default(0)`, không null (schema.prisma:579), nên mọi nơi tạo message đều cho hint đầy đủ.
   - Worker cũ: parse bỏ qua khoá lạ; republish thì làm rơi hint, message quay về đường cũ.
   - Worker cũ vẫn đếm `x-circuit-deferrals` và giữ nguyên `since` khi spread header. An toàn.
3. **F7 và sweeper**
   - Tính tay: với nhịp vòng c ≤ 120s, mốc `next_attempt_at` cũ nhất là khoảng 2c − 60s, tức ≤ ~3 phút (c = 119s). Ngưỡng là RETRYING 5 phút và PENDING 10 phút, nên không nhân bản. Với c > 120s, hệ thống ghi mỗi vòng như trước BP2.
   - Lưu ý: chú thích của T8 viết "tệ nhất −2 phút". Thực tế là −3 phút, nhưng vẫn trong hạn.
   - `since` và `written-at` chỉ bị xoá ở `freshAttemptHeaders` (:136-137), và hàm này được dùng ở mọi lần chuyển sang lần thử mới (kể cả lần quá trần).
   - Header chỉ do hub ghi, broker giữ nguyên qua DLX. Giá trị rác thì được coi là `now` (`headerEpoch`).
4. **C2**
   - `TOTAL_RETRY_WINDOW_MS = 20.320.000` ms (đã kiểm), đúng bằng cửa sổ cũ cộng 6 × 30 phút.
   - Một nguồn duy nhất (`retry-window.ts`). Cả 4 nơi QT dùng đều import hằng số: storage-api, `retryWindowFloor`, `assertRetentionSafe`, storage.job.
   - Đặt env cao hơn thì bị kẹp; giá trị rác hoặc ≤ 0 thì về mặc định. Riêng giá trị dương quá nhỏ thì có vấn đề (TH-2).
5. **R1 và Lua**
   - `LUA_GATE` là đúng 1 EVAL. Mọi khoá đều khai báo trong KEYS, chỉ dùng GET/PTTL/INCR/EXPIRE (hợp lệ trên Upstash).
   - Bảng trả về không có nil, nên không bị cắt mảng. Redis lỗi thì fail-open (degraded).
   - So với MGET và `LUA_STATE_AND_THROTTLE` cũ: đọc cùng `open`/`failures`, không mất trạng thái nào. Probe vẫn là lệnh riêng như cũ.
   - `recheckThrottle` không INCR lần hai khi gate đã INCR.
6. **"Hoãn oan" do gợi ý lệch** — thực tế gần như **không xảy ra**:
   - `subscription.destinationId` không sửa được qua API nào. `updateSubscription` chỉ nhận name/isActive/template/eventTypes/sourceIds (api.controller.ts:392-399; service-resources chỉ nhận isActive).
   - Replay chụp đích hiện tại.
   - Vì vậy ADR-196 mô tả kịch bản "subscription đổi đích" là không đúng (TH-4).
7. **BB-5 (sweeper)**: chạy trong `systemTx`, join theo khoá chính, FK `Restrict` (schema.prisma:643), nên INNER JOIN không làm rơi dòng. Riêng tiền lệ điều kiện tenant chưa được giữ (TH-3).
8. **Test**: mã `[BP:T5..T11]` và T22a khớp spec. Còn thiếu một số ca (TB-1, TB-2).
9. **Docs**
   - `CIRCUIT_MAX_DEFERRALS` đã bị xoá khỏi `.env.example`, DEPLOYMENT, ARCHITECTURE. Chỉ còn trong ADR-054 cũ, đúng tinh thần append-only.
   - ADR-196 dài hơn "3 dòng" nhưng giữ khuôn Vấn đề/Chọn/Đánh đổi như ADR-195. Lý do lấy từ khối "Vì sao sửa".

## Phát hiện

### Cao
Không có.

### Trung bình

**TB-1 — Thiếu test nhả probe khi gợi ý lệch đích; thiếu T22 ca HALF_OPEN.**
- Vị trí: `delivery-gate.spec.ts`, `redis-budget.spec.ts`.
- Kịch bản hỏng: ai đó refactor làm mất `releaseHeldProbe()` ở delivery.consumer.ts:330 → probe của đích gợi ý bị khoá 30s. Đột biến này đã sống sót qua toàn bộ test.
- Ngoài ra, spec §13 `[BP:T22]` đòi ca "HALF_OPEN có probe ≤ 3 lệnh", nhưng `redis-budget.spec.ts` không có ca HALF_OPEN nào.
- Cách sửa:
  - Thêm ca vào `delivery-gate.spec`: `{'dest-stale': 'HALF_OPEN', probe: true}` cùng row `dest-1`, rồi expect `releaseProbe('dest-stale', token)`.
  - Thêm T22(b) vào `redis-budget`.

**TB-2 — `LUA_GATE` chưa chạy trên Redis thật trong lượt này.**
- Vị trí: suite `describeRedis` trong `circuit-breaker.spec.ts` bị skip. Còn fake trong `redis-budget` và `circuit-breaker.spec` thì tự cài lại logic, nhận script bằng regex `/PTTL/`.
- Kịch bản hỏng: Lua sai cú pháp hoặc sai ARGV (ví dụ đảo rps với TTL) mà vẫn xanh toàn bộ unit test. Lỗi chỉ lộ khi deploy, và khi đó mọi delivery rơi vào fail-open (degraded): throttle và circuit mất tác dụng.
- Cách sửa: trước khi merge, chạy `circuit-breaker.spec.ts` với `REDIS_URL` (LOCAL), hoặc ghi rõ bước này vào DoD.

### Thấp

**TH-1 — Probe rò ở `catch` ngoài cùng, nay rộng hơn.**
- Vị trí: delivery.consumer.ts:279-305.
- Probe giành **trước** `findDeliveryForSend`. Nếu DB ném lỗi transient, nhánh catch (BP1) không nhả probe, nên đích bị khoá dò 30s. Đây là nợ T5 cũ của BP1, nhưng BP2 mở rộng cửa sổ ra cả bước nạp row.
- Cách sửa: trong `catch` gọi `releaseHeldProbe` (đưa `probeToken`/`probeFor` ra ngoài khối `try`).

**TH-2 — `circuitMaxDeferMs` nhận giá trị dương quá nhỏ.**
- Vị trí: retry-window.ts:23-27.
- `'0.5'` cho ra 0, `'1'` cho ra 1ms. Khi đó mỗi lần OPEN đốt ngay một lượt, cả thang 6 lần thử thành DEAD trong khoảng 6 phút trong lúc đích chập chờn.
- Cách sửa: kẹp dưới, ví dụ `Math.max(60_000, …)` (≥ TTL tầng hoãn), hoặc coi < 60s là giá trị rác.

**TH-3 — SQL sweeper không lặp điều kiện tenant ở JOIN.**
- Vị trí: delivery.sweeper.ts:80-81.
- Đúng về dữ liệu (join theo khoá chính, FK Restrict), nhưng lệch tiền lệ `findDeadDeliveries` (tenant-scoped.repository.ts:704-705), vốn có `AND s.tenant_id = d.tenant_id`.
- Cách sửa: thêm `AND sub.tenant_id = s.tenant_id` và `AND dst.tenant_id = sub.tenant_id`. Không tốn gì mà giữ phong cách BB-5.

**TH-4 — ADR-196 mô tả sai nguồn gây lệch gợi ý.**
- Vị trí: docs/adr/README.md:2082.
- `destinationId` của subscription là bất biến qua API, nên "hoãn oan tới 30 phút" chỉ xảy ra khi sửa DB tay.
- Các ca lệch thật mà ADR không nêu:
  - (a) Đích bị lưu trữ trong lúc OPEN: delivery chưa DEAD ngay mà chờ hết OPEN. Bị chặn bởi thời gian OPEN (60s, BP3 tới 5 phút), sau đó probe nạp row và cho DEAD.
  - (b) `rateLimitRps` được **nâng hoặc bỏ**: message đang bay vẫn bị throttle theo gợi ý cũ ở nhánh trước-nạp (:291-296), vì không nạp row nên không sửa được gợi ý. Message không kẹt, chỉ chạy theo trần cũ cho tới khi giao xong.
- Cách sửa: sửa câu trong ADR và nêu (a), (b).
- Nếu muốn chặt hơn mà rẻ: cho lần ghi thưa (`deferDelivery`, mỗi 2 phút) `RETURNING` `destination_id` của subscription bằng UPDATE…FROM, rồi so với gợi ý. Khi đó lệch được phát hiện trong ≤ 2 phút, không thêm truy vấn.

**TH-5 — Thời gian hoãn thật có thể vượt trần tính toán.**
- Vị trí: delivery.consumer.ts:121.
- Trần chỉ được kiểm ở mỗi vòng (~60s+), nên một lần thử có thể hoãn tới `max + 1 vòng`. Cả thang có thể vượt `6 × max` vài phút; lệch so với `TOTAL_RETRY_WINDOW_MS` cỡ 6–12 phút.
- Rủi ro nhỏ vì dọn tự động có sàn ≥ 1 ngày. Riêng lệnh dọn tay với `olderThan` sát 5h39m thì bị ảnh hưởng.
- Cách sửa:
  - so `now − since + CIRCUIT_DEFER.ttlMs > max`, hoặc
  - cộng thêm `6 × CIRCUIT_DEFER.ttlMs` vào cửa sổ.

**TH-6 — `since` không reset ở các nhánh hoãn khác.**
- Các nhánh hoãn vì throttle, lease và lỗi hạ tầng (BP1) giữ nguyên `since`. Kịch bản: DB sập 40 phút ngay sau một lần hoãn vì circuit; DB về mà mạch vẫn OPEN thì lần hoãn kế tiếp bị coi là quá trần ngay.
- Ngữ nghĩa này giống bộ đếm cũ, không phải hồi quy, chỉ ghi nhận.

**TH-7 — Chú thích và độ phủ của T8.**
- Vị trí: delivery-lease-sweeper.spec.ts:219.
- Chú thích ghi "tệ nhất −2 phút", nên sửa thành ~−3 phút và dùng −3 trong test.
- T8 là test DB, bị skip khi không có Postgres. Thuộc tính "mốc luôn trong hạn" hiện chỉ được kiểm ở nhịp 1 phút qua T7. Như vậy đủ cho mức unit, nhưng cần chạy T8 ở LOCAL một lần.

---

# Lượt 2 — `2be4121..50f35bb`

## Kết luận lượt 2: **ĐẠT**

Lượt sửa không sinh lỗi mới. Còn hai việc nhỏ:
- Đính chính spec cho `[BP:T22]` phần b (mục 1).
- Thêm 2 assert Lua (mục 2).

Không việc nào chặn merge.

## Đã chạy

- **Unit:** `npx jest apps/hub-worker apps/hub-api/test/redis-budget.spec.ts apps/hub-api/test/storage-api.spec.ts libs` cho 79 suite qua, 598 test qua (22 suite / 92 test skip). `tsc` cho hub-worker và hub-api đều sạch.
- **Redis thật:** `redis:7-alpine` ở cổng 56380. `RUN_DB_TESTS=1 REDIS_URL=… npx jest circuit-breaker.spec.ts delivery-gate.spec.ts` cho **34/34 qua**, khớp số dev báo. Container đã `docker stop`.
- **Sự cố đã khắc phục:** trong lúc chạy, một lệnh của tôi lỡ làm HEAD rời khỏi nhánh (detached). Đã `git checkout feat/bp` ngay, không có thay đổi nào.
- **Đột biến Lua** (`LUA_GATE`, chạy lại 2 file trên Redis thật; mỗi lần đều `git checkout` trả lại):

  | Đột biến | Kết quả |
  |---|---|
  | EXPIRE dùng ARGV[2] (đảo rps/TTL) | 2 đỏ |
  | INCR cả khi rps = 0 | 3 đỏ |
  | Bỏ PTTL | 3 đỏ |
  | Bỏ EXPIRE | 3 đỏ |
  | Cờ open lấy theo `failures` | 3 đỏ |
  | **INCR cả khi OPEN** (bỏ `not open`) | **sống** |
  | **Ngưỡng `<` thành `<=`** (HALF_OPEN vẫn INCR throttle) | **sống** |

## Từng mục lượt 1

| Mục | Trạng thái | Ghi chú |
|---|---|---|
| TB-1 | **Đóng** | Có `[BP:T11]` (phần d): nhả probe của đích gợi ý trước khi gate lại, có kiểm thứ tự gọi. Có T22 (phần b), nhưng xem mục 1. |
| TB-2 | **Đóng** | Gate có test Redis thật, cả qua consumer (đếm bằng `sendCommand`), cộng thêm ca Redis chết thì fail-open. Còn 2 đột biến sống (mục 2). |
| TH-1 | **Đóng** | `probeToken`/`probeFor` đưa ra ngoài `try`; `catch` nhả probe theo token (delivery.consumer.ts:263-266, :593-594). Không lo nhả nhầm: `LUA_RELEASE_PROBE` so token, probe đã bị DEL hay đã sang chủ khác thì lệnh không làm gì. Có test cho lỗi ở bước nạp row. |
| TH-2 | **Đóng** | Kẹp dưới 60s (retry-window.ts:35). Đã kiểm `'0.5'`, `'1'`, `'59999'`. |
| TH-3 | **Đóng** | JOIN đã kèm `tenant_id` (delivery.sweeper.ts:81-82). |
| TH-4 | **Đóng** | ADR-196 đã sửa: destinationId bất biến, kèm hai ca lệch có thật (a) và (b). |
| TH-5 | **Đóng** | Xem mục 3. |
| TH-6 | **Đóng** | Đã ghi vào ADR-196 như một đánh đổi, không phải hồi quy. |
| TH-7 | **Đóng** | T8 dùng −3 phút. CI job db chạy test này; tôi không chờ kết quả. |

## (1) `[BP:T22]` phần b — cách đếm "HALF_OPEN có probe ≤ 3 lệnh"

**Ý kiến: cách hiểu của dev ("3 lệnh circuit, không tính PUBLISH") không khớp với cách spec đếm.**

Lý do:
- Cùng một dòng §13, hai ca kia ("hoãn OPEN = 1 lệnh", "throttle = 1 lệnh") đều là **tổng** lệnh của delivery.
- R1/ADR-062 và `redis-budget.spec.ts` luôn tính cả PUBLISH (`delivery 2 = EVAL + PUBLISH`).
- Bộ lọc `x !== 'publish'` còn loại luôn PUBLISH `hub:realtime:circuit`. Đó là lệnh của circuit chứ không phải realtime delivery.
- Test hiện tại mock `updateDestinationCircuitState → 0`, nên không lộ các PUBLISH đó.
- Probe thật thường có thêm 1–2 PUBLISH circuit: `syncObserved` OPEN→HALF_OPEN, và khi đóng mạch thì →CLOSED. Tổng có thể lên 5–6 lệnh.

Tuy vậy, **code không sai**:
- Chuỗi gate + giành probe + DEL + PUBLISH (4 lệnh, cộng PUBLISH circuit khi trạng thái đổi) bằng đúng trước BP2. Trước BP2 là MGET thay cho EVAL.
- Ca này hiếm: một probe mỗi đích mỗi 30s.
- Muốn ≤ 3 thật thì phải gộp `tryAcquireProbe` vào `LUA_GATE`. BP4 sẽ sửa chính script này, nên làm lúc đó là hợp lý.

**Cách sửa đề nghị:**
- Đừng định nghĩa lại cách đếm. Thêm một dòng **đính chính C10** trong spec: "HALF_OPEN có probe = gate + acquire + DEL + PUBLISH (4), + PUBLISH circuit khi đổi trạng thái, bằng trước BP2; gộp acquire vào gate để ở BP4 nếu cần".
- Sửa test cho assert đúng chuỗi lệnh đầy đủ, và không lọc bỏ PUBLISH.

## (2) Độ chặt của test Redis thật

Hai đột biến sống, đều là "INCR throttle khi không được INCR". Hậu quả: HALF_OPEN (hoặc OPEN khi `failures` còn dưới ngưỡng) tiêu RPS của đích. Lỗi nhẹ, không ảnh hưởng tính đúng.

Sửa trong test circuit-breaker trên Redis thật (circuit-breaker.spec.ts):
- Sau `getState(dest, 1)` ở HALF_OPEN (failures = 5), assert `redis.get(tk)` không đổi.
- Thêm ca OPEN với `failures` = 0, assert `tk` không đổi.

Ngoài ra:
- Đếm lệnh bằng spy `sendCommand` dễ dính lệnh nền của ioredis (ready-check `INFO`) nếu client chưa sẵn sàng. Hiện vẫn qua, vì spy chỉ gắn sau khi client đã kết nối. Chỉ ghi nhận.
- Khối Redis thật trong delivery-gate.spec dùng `describeDb`, nên `verify:db` sẽ chạy nó. Tốt.

## (3) TH-5 — cửa sổ mới

- `TOTAL_RETRY_WINDOW_MS = 20.680.000 ms = 5h44m40s` (đã chạy và kiểm), bằng `9.520.000 + 6 × (1.800.000 + 60.000)`.
- Cả 4 nơi QT dùng đều import hằng số này:
  - storage-api.ts:193, :265, :385;
  - `retryWindowFloor` trong storage-clean.ts:43;
  - `assertRetentionSafe` trong cleanup.job.ts:49;
  - storage.job.ts:447, :485.
- Các test tính theo hằng số đều qua; cleanup-job.spec cũng đã cập nhật tổng cứng.

Thấp:
- **Chú thích cũ:** storage-api.ts:383 vẫn ghi "~5,6 giờ". Đúng ra là khoảng 5,75 giờ.
- **Hai nguồn cho một con số:** `CIRCUIT_DEFER_ROUND_MS = retryQueueForDelay(60_000)` (retry-window.ts:25) tính riêng, tách khỏi `CIRCUIT_DEFER = retryQueueForDelay(CIRCUIT_OPEN_MS)` trong consumer. Hiện hai giá trị bằng nhau, và chú thích đã nhắc BP3 phải nâng. Đề nghị: BP3 cho consumer dùng chung `CIRCUIT_DEFER_ROUND_MS` (hoặc ngược lại) để chỉ còn một nguồn.

---

# Lượt 3 — `50f35bb..8758c8c`

## Kết luận lượt 3: **ĐẠT**

Không còn mục mở nào của BP2. HEAD vẫn ở `feat/bp` suốt lượt này.

| Kiểm | Kết quả |
|---|---|
| **T22 (phần b)** | Test assert đủ chuỗi lệnh, không lọc gì: `eval, eval, publish, del, publish, publish`. Chuỗi khớp thứ tự trong code: gate → giành probe → `syncObserved` OPEN→HALF_OPEN → `recordSuccess` DEL → →CLOSED → PUBLISH delivery. Test bật `persistedCircuit: 'OPEN'` + `circuitDbWrites`, nên PUBLISH circuit thật hiện ra (redis-budget.spec.ts:322-330). |
| **C10 trong spec** | Đúng: tính tổng lệnh kể cả PUBLISH, bằng trước BP2, việc gộp acquire vào gate để BP4. Nợ "một nguồn cho vòng hoãn" đã ghi vào §16 cho BP3. |
| **Hai đột biến Lua** (Redis thật cổng 56380, đã dừng) | Bản gốc: 34/34 qua. Bỏ `not open`: **2 đỏ**. `<` thành `<=`: **2 đỏ**. Cả hai đột biến đã bị giết; file đã `git checkout` trả lại. |
| **Chú thích storage-api.ts:383** | Đã sửa thành "≈ 5h44m40s — TOTAL_RETRY_WINDOW_MS". |
| **Tick `[x] BP2`** | `verify:map`: 400 mã, 0 mồ côi, 0 ma, 0 trùng. Các mã T5–T11 và T22 (a, b) đều có test. Đã `git checkout docs/TEST-MAP.md`. `redis-budget` + `storage-api`: 19/19 qua. |

Thấp, chỉ ghi nhận: các assert "khoá throttle không đổi" dùng khoá của giây bắt đầu test. Nếu test chạy qua ranh giới giây thì đột biến có thể sống sót ngẫu nhiên. Test vẫn không bao giờ đỏ oan.
