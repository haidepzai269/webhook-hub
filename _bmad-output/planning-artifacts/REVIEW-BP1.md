# REVIEW BP1 — commit `e18564c` (so với master `3513901`)

Reviewer độc lập, 2026-10-13. Chỉ đọc. Mọi đột biến thử đã `git checkout` trả lại.

## Kết luận: **CẦN SỬA** (nhẹ)

Không có lỗi mức Cao. Lõi đúng: không còn `nack(requeue=true)`. transient đi `retry.10s` và không đốt lượt. unknown đi `retry.1m`, tới lần thứ 5 publish vào DLX rồi mới ack. Republish/publish luôn chạy trước ack, và publish ném lỗi thì không ack. Bảng mã lỗi giữ nguyên. Cần sửa 3 mục Trung bình (M1–M3) trước khi tick `[x] BP1`. Mỗi mục sửa chỉ vài dòng.

## Đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx jest apps/hub-worker` | 22 suite pass, 4 skip (DB) · 185 pass, 27 skip |
| `npx tsc --noEmit -p apps/hub-worker` | 0 lỗi |
| `npm run verify:map` | 400 mã · 314 có test · 0 mồ côi · 0 ma · 0 trùng; `BP:T1..T3` map đúng file:dòng (đã `git checkout docs/TEST-MAP.md`) |

Đột biến trên `delivery.consumer.ts`, chạy `delivery-infra-errors.spec` + `delivery-consumer.spec`:

| Đột biến | Kết quả |
|---|---|
| `n >= MAX` → `n > MAX` (off-by-one) | ĐỎ (2) |
| transient: ack trước sendToQueue | ĐỎ |
| transient: `slim(attemptCount+1)` (đốt lượt) | ĐỎ |
| ack trong catch trong cùng (publish DLX ném) | ĐỎ |
| `x-infra-deferrals` không tăng | ĐỎ |
| unknown: ack trước sendToQueue | ĐỎ (BB:3 c) |
| nhãn metric `kind` = `err.message` | ĐỎ |
| **bỏ `...headers` ở nhánh unknown republish** | **XANH** |
| **bỏ `...headers` ở nhánh transient** | **XANH** |
| **bỏ `...headers` ở publish DLX** | **XANH** |

## Đã kiểm, đúng

- **Bộ đếm** (`delivery.consumer.ts:446-447`): `n = header + 1`. Bốn lần republish mang 1, 2, 3, 4; lần thứ 5 publish DLX. Không lệch một (đột biến `>` làm test đỏ).
- **Thứ tự**: transient `:442→:443`, DLX `:452→:456`, unknown `:460→:461` đều publish trước ack. Publish ném lỗi thì rơi vào `:462`, không ack và không throw ra ngoài.
- **`slim()`** (`:146`, `libs/common/src/delivery-message.ts:7-15`): giữ deliveryId, tenantId, attemptGeneration, attemptCount, correlationId, tức đủ trường hiện có. Hàm thuần nên không ném lỗi.
- **`publish` trả false**: amqplib vẫn đệm message, nên không mất. Kênh không phải confirm: publish và ack đi cùng một channel nên broker xử lý theo thứ tự. Khe broker sập giữa publish và ack giống các nhánh hoãn sẵn có, và sweeper đỡ được.
- **`classifyInfraError`** (`infra-errors.ts:126-143`): khớp từng dòng với bảng cũ. `classifyNormalizeError` cho `unknown` → `permanent`, còn `null` → `permanent` như trước. Hành vi normalize giữ nguyên.
- **Vòng lặp nóng khác**: `grep -E "\.(nack|reject|nackAll|recover)\("` trên `apps/` và `libs/` chỉ còn `nack(...,false,false)` ở `normalize.consumer.ts:89,226` (q.normalize có DLX) và `delivery.consumer.ts:135` (nợ §16). Hai handler đều bắt hết ngoại lệ, và `InFlightTracker.track` nuốt reject, nên không có requeue ngầm.
- **Gửi trùng sau 2xx mà ghi kết quả lỗi**: delivery ở trạng thái DELIVERING. Message quay lại sau 10s/1m thì thua lease 60s (`tenant-scoped.repository.ts:840-852`) và đi nhánh hoãn 1m (`:269-278`). Hết lease thì gửi lại, tức at-least-once. `webhook-id = event.id` giữ nguyên qua retry (`webhook.sender.ts:31-35`), nên đích dedupe được. Rủi ro này giống hệt trước BP1 (requeue cũng ra kết quả này), không phải hồi quy. Telegram/Discord không có khoá idempotency; đó là nợ cũ.
- **Metric** (`metrics.ts:195-200`): Counter trong bộ nhớ, 0 lệnh Redis. `kind` chỉ có 2 giá trị. Topology không đổi.
- **ADR-195**: đủ 3 dòng Vấn đề/Chọn/Đánh đổi, lý do lấy gần nguyên văn khối "Vì sao sửa". Câu "`q.delivery.main` không khai báo DLX, nack(false) là vứt" khớp `topology.ts:110`. Số ADR không trùng (192–194 để trống).

## Phát hiện

### Trung bình

**M1 — `x-unknown-errors` không reset khi sang lần thử mới, nên trần 5 thành "5 lần trong cả đời delivery" chứ không còn "5 lần liên tiếp".**
`delivery.consumer.ts:413` spread `msg.properties.headers` vào message tầng retry kế. Dòng này reset `x-circuit-deferrals` về 0 nhưng giữ `x-unknown-errors` (và `x-infra-deferrals`).
- Kịch bản: Neon suspend làm rớt kết nối, Prisma ném `PrismaClientUnknownRequestError` (57P01). Lỗi này không có trong bảng nên bị xếp `unknown`. Lần thử 1 gặp 2 lỗi như vậy, lần thử 3 gặp 2, lần thử 4 gặp 1. Message bị đẩy DLX và ack, dù chưa lần nào lỗi liên tiếp quá 2. Delivery nằm RETRYING cho tới khi sweeper hồi sinh (grace 5 phút + chu kỳ). Không mất dữ liệu, nhưng trễ và trái nghĩa `[BP:T2]` "liên tiếp".
- Cách sửa: ở `:413` thêm `[UNKNOWN_ERRORS_HEADER]: 0, [INFRA_DEFERRALS_HEADER]: 0`, cùng chỗ đang reset circuit. Thêm ca test: header `x-unknown-errors: 4`, gửi lỗi retryable, message tầng kế phải có `x-unknown-errors: 0`.

**M2 — Test không giữ được hợp đồng "header cũ được giữ khi republish".**
Bỏ `...headers` ở `:442`, `:454` hoặc `:460` thì cả 44 test vẫn xanh. Khi mất header, `x-circuit-deferrals` về 0, nên đích chết có thể bị hoãn quá trần ADR-054. `x-attempt` và `x-correlation-id` cũng mất.
- Cách sửa: trong `[BP:T1]` (phần a) và `[BP:T2]` (phần a), cho message vào mang `x-circuit-deferrals: 7` và `x-attempt: 2`, rồi assert `opts.headers` ở cả ba nhánh giữ nguyên hai giá trị này cùng `x-correlation-id`.

**M3 — Riêng BP1 không cho được cận trên mà `[BP:T4]` đòi, nhưng doneOverride lại viết "Logic phủ ở L0 T1/T2/T3".**
Nhánh transient không có trần, và mỗi lượt chạy 1 truy vấn Prisma + 1 dòng `log.warn` (`:441`) cho từng message, mỗi 10s. Khi Postgres chết kiểu fail nhanh (ECONNREFUSED, đúng như `docker stop` ở T4), backlog Q message tạo ra khoảng Q/10 lần gọi Prisma mỗi giây và Q/10 dòng log mỗi giây. Q = 10.000 thì là khoảng 1.000/s mỗi loại. Con số này tỉ lệ với backlog chứ không bị chặn hằng. Prefetch chỉ chặn được khi lỗi chậm (P1001 phải chờ connect_timeout). T1–T3 không kiểm tốc độ nào.
- Cách sửa: chọn một trong hai. (a) Sửa `verify/spec-sources.json` doneOverrides `BP:T4` cho đúng sự thật, ví dụ "cận trên chỉ có sau BP5; BP1 đổi vòng nóng không nhịp thành nhịp 10s/message", và cân nhắc chuyển T4 sang nhóm BP5. (b) Giảm log ngay trong BP1, ví dụ chỉ `warn` khi `infraDeferrals` là 1 hoặc chia hết cho 6, các lần còn lại để `debug`.

### Thấp

- **T1 — Bắt ở catch trong cùng khi channel còn sống thì message unacked mãi, chiếm một slot prefetch.** `:462-465` giả định chỉ có lý do "channel đóng". `main.ts:101-112` chỉ nghe `close` của **connection**. Nếu riêng `deliveryChannel` đóng (lỗi mức channel), worker thành zombie: còn sống nhưng không consume, và comment ở `:463` ("giao lại khi channel mới lên") không đúng cho trường hợp này vì main không dựng lại channel. Đây là nợ cũ. Gợi ý: `deliveryChannel.on('close', …)` gọi cùng đường thoát với connection.
- **T2 — Regex của `[BP:T3]` (`delivery-infra-errors.spec.ts:426`) lọt `nack(msg)` và `nack(msg, false)` (mặc định amqplib là requeue=true), `reject(msg)`, và lời gọi xuống dòng. Nó cũng không quét `libs/`.** Gợi ý: bắt `\.(nack|reject)\(` rồi assert tham số requeue được ghi rõ `false`.
- **T3 — Lỗi hạ tầng ngoài bảng bị xếp `unknown`.** Ví dụ: `PrismaClientUnknownRequestError` 57P01 khi Neon cắt kết nối, hoặc amqplib "Channel closed". Hậu quả: khoảng 5 phút sau thì vào DLX, và metric `kind=unknown` bị lẫn lỗi channel. Spec giữ bảng nguyên nên không phải lỗi BP1. Nên ghi vào §16 cho BP5.
- **T4 — Lệch tài liệu.** `q.delivery.dlq` giờ chứa cả bản sao **không DEAD** (`x-dead-reason: unknown_error`), nhưng `ARCHITECTURE.md` §3.3 mục 8 và sơ đồ §4 vẫn ghi "DLQ = bản sao DEAD". Nhánh unknown cũng không để dấu vết nào trong Postgres (`last_error` không đổi), nên console không thấy, chỉ có log và DLQ broker (drop-head). `x-dead-error` mang `err.message` thô, có thể chứa tham số truy vấn Prisma. Nên đưa vào BP6, hoặc thêm một dòng ở §16.
- **T5 — Probe HALF_OPEN không được nhả khi lỗi rơi vào catch ngoài** (`:204` giành probe, catch không gọi `releaseProbe`). Đích bị khoá dò tới hết TTL 30s (`circuit-breaker.service.ts:22`). Đây là nợ cũ, BP1 không làm tệ hơn.
- **T6 — Test `[BB:3]` (phần c)** (`delivery-consumer.spec.ts:213-236`) đặt tên "Postgres mất kết nối" nhưng ném `Error` thường, nên thực tế đi nhánh unknown. Chưa có ca nào cho lỗi P1001 **sau khi đích đã nhận 2xx**, tức đường retry.10s → thua lease → hoãn 1m. Gợi ý: thêm ca này (L0, mock `getDeliveryLeaseState`).

---

## Lượt 2 — commit `f3caa59` (so với `e18564c`)

### Kết luận: **ĐẠT**

M1, M2, M3 đã đóng. Các mục Thấp đều đã sửa hoặc đã ghi nợ ở §16. Bản sửa không đưa vào lỗi mức Trung bình/Cao nào. Còn 3 điểm Thấp mới (L2-1..L2-3), không chặn merge.

### Đã chạy

| Lệnh | Kết quả |
|---|---|
| `npx jest apps/hub-worker` | 22 suite pass, 4 skip · 189 pass, 27 skip |
| `npx tsc --noEmit -p apps/hub-worker` | 0 lỗi |
| `npm run verify:map` | 400 mã · 314 có test · 0 mồ côi · 0 ma. `BP:T1` map 3 ca, `T2` 2 ca, `T3` 1 ca. `T4` không còn thuộc BP1. Đã `git checkout docs/TEST-MAP.md` |

Đột biến (đã trả lại, cây sạch):

| Đột biến | Kết quả |
|---|---|
| bỏ `...headers` ở transient (`:491`) | ĐỎ (2) |
| bỏ `...headers` ở DLX (`:503`) | ĐỎ |
| bỏ `...headers` ở unknown (`:509`) | ĐỎ |
| bỏ reset `x-unknown-errors` (`:454`) | ĐỎ |
| bỏ reset `x-infra-deferrals` (`:455`) | ĐỎ |
| bỏ throttle log (`:485` → `if (true)`) | ĐỎ |

### Từng mục lượt 1

| Mục | Trạng thái | Chứng cứ |
|---|---|---|
| M1 bộ đếm không reset | Đóng | `delivery.consumer.ts:449-456` reset cả hai về 0, cùng chỗ reset circuit. Ca "(review M1)" kiểm cả lỗi lạ đầu tiên của lần thử mới (→ 1, không DLX) |
| M2 test không giữ header | Đóng | `KEEP` + `expectKept` ở T1(a), T1(c), T2(a) cho cả 3 nhánh. Đột biến bỏ header giờ đỏ |
| M3 cận trên T4 | Đóng | T4 chuyển sang nhóm BP5 (`spec-sources.json` groups + bảng §13 + §16). doneOverride viết lại đúng sự thật. Log transient chỉ còn ≤ 1 dòng/30s/tiến trình |
| T1 channel zombie | Ghi nợ | §16, comment `:512-513` đã sửa cho đúng |
| T2 regex T3 | Sửa | Bắt được nack/reject thiếu đối số requeue, lời gọi xuống dòng, có quét `libs/`. Có tự kiểm 5 dạng (xem L2-2) |
| T3 lỗi ngoài bảng | Ghi nợ | §16 đề xuất cho BP5 |
| T4 tài liệu/DLQ | Sửa | `ARCHITECTURE.md` §3.3 mục 8 + sơ đồ §4 (DLQ hai loại, phân biệt bằng `x-dead-reason`). `deadErrorHeader` chỉ còn tên + message ≤ 200 ký tự, không stack |
| T5 probe | Ghi nợ | §16 |
| T6 BB:3(c) | Sửa | Đổi tên cho đúng nhánh unknown. Ca P1001 sau 2xx là `[BP:T1] (phần c)` |

### Câu hỏi riêng của coordinator

1. **`LogThrottle`** (`:59-77`)
   - Không rò bộ nhớ: trạng thái chỉ là 2 số, mỗi instance consumer một bộ, Nest singleton nên mỗi tiến trình một bộ.
   - Phần unit test tiêm đồng hồ giả, nên không phụ thuộc thời gian thật.
   - Phần chạy trên consumer thật dùng `Date.now` thật, nhưng chỉ cần 20 lời gọi mock xong trong 30s. Thực tế không flaky.
   - Xem L2-1 về đồng hồ.
2. **Regex `[BP:T3]`**: tôi thử riêng ngoài repo.
   - Bắt nhầm (false positive): `Promise.reject(err)` bị tính là vi phạm. `nack(msg, false, false /* ghi chú */)` cũng vậy.
   - Bỏ lọt: `nackAll()` (requeue mặc định true), đối số lồng ngoặc từ 2 cấp, và `nack` đã destructure khỏi channel.
   - Hiện trong phạm vi quét chỉ có 3 lời gọi `nack(…, false, false)`, nên test vẫn xanh đúng. Xem L2-2.
3. **`[BP:T1] (phần c)`**: đúng với thực tế ở các điểm chính.
   - Lease cập nhật `updated_at` lúc claim (`tenant-scoped.repository.ts:847`). Transaction rollback nên `processed_messages` không có dòng. Message quay lại sau 10s, lúc lease 60s còn hạn, nên hoãn 1m mà không gọi đích.
   - Nhưng tên test viết "không gửi lại", trong khi mock để `claimForSend` trả 0 mãi. Thực tế lần quay lại sau 1m sẽ thắng lease đã hết hạn và **gửi lại** (at-least-once, `webhook-id = event.id`).
   - Nếu DB vẫn chết lúc quay lại thì vòng 10s lặp tiếp. Test không thể hiện điều này nhưng cũng không khẳng định ngược lại. Xem L2-3.
4. **Đưa T4 sang BP5 + dòng "Sửa sau review lượt 1" trong ADR-195**: ổn.
   - ADR chưa merge nên thêm dòng thứ 4 không phạm append-only.
   - Nội dung khớp code: reset bộ đếm, log 1 dòng/30s, `x-dead-error` ≤ 200, cận trên thuộc BP5.

### Phát hiện mới (Thấp)

- **L2-1 — `LogThrottle` dùng `Date.now` (đồng hồ tường).**
  - Nếu NTP lùi giờ, `t - lastAt` âm, nên log bị nén cho tới khi đồng hồ vượt mốc cũ thêm 30s. Dòng log gộp cuối cùng (`suppressedSinceLastLog`) không bao giờ được in nếu sự cố kết thúc giữa hai nhịp.
  - Nhánh unknown không được throttle: mỗi message 1 dòng/phút, tối đa 5 dòng.
  - Gợi ý: dùng `performance.now()` làm mặc định, chấp nhận phần còn lại.
- **L2-2 — Regex `[BP:T3]` sẽ đỏ nhầm** khi ai đó viết `Promise.reject(...)` trong `libs/` hoặc `apps/hub-*/src`, hoặc để comment trong đối số. Nó cũng bỏ lọt `nackAll()`.
  - Gợi ý: loại receiver `Promise` (`(?<!Promise)\.(nack|reject)`), bỏ comment trước khi so, thêm `nackAll` vào danh sách cấm, và đưa 2 dạng FP vào phần tự kiểm.
- **L2-3 — Tên ca `[BP:T1] (phần c)` dễ hiểu nhầm là "không bao giờ gửi trùng".**
  - Gợi ý: đổi thành "lần quay lại trong 60s thua lease → hoãn 1m". Thêm một assert hoặc comment rằng sau khi lease hết hạn thì gửi lại theo at-least-once (`webhook-id` không đổi, đích tự lọc trùng).

---

## Lượt 3 — commit `68ba412` (so với `f3caa59`)

### Kết luận: **ĐẠT**

| Lệnh | Kết quả |
|---|---|
| `npx jest delivery-infra-errors.spec delivery-consumer.spec` | 48/48 pass |
| `npx tsc --noEmit -p apps/hub-worker` | 0 lỗi |
| `npm run verify:map` | 400 mã · 314 có test · 0 mồ côi · 0 ma. Cả `BP:T1..T3` đều có test, nên tick `[x] BP1` hợp lệ (nhóm BP1 = T1–T3; T4 đã sang BP5). Đã `git checkout docs/TEST-MAP.md` |

| Mục | Trạng thái |
|---|---|
| L2-1 | Đóng. Mặc định là `performance.now()` (`perf_hooks`, đơn điệu). Test vẫn tiêm đồng hồ giả. |
| L2-2 | Đóng cho các dạng thực tế. `Promise.reject`, comment trong đối số và `nackAll` đã xử lý, có phần tự kiểm cho cả hai chiều. |
| L2-3 | Đóng. Tên test đổi thành "lần quay lại trong 60s"; comment ghi rõ at-least-once và `webhook-id`. |

Tôi thử `requeueCalls()` ngoài repo với các dạng còn lại. Kết quả xếp mức Thấp, không chặn merge.
- **Bỏ lọt:**
  - `ch?.nack(msg)` (optional chaining)
  - `getCh().nack(msg)` (receiver là kết quả lời gọi)
  - `ch['nack'](msg)`
  - đối số lồng ngoặc từ 2 cấp
  - chuỗi chứa `//` hoặc `/*` làm bước bỏ comment cắt mất code phía sau
- **Bắt nhầm:** `deferred.reject(err)`, kiểu promise tự chế ngoài `Promise`.

Muốn chặt hơn chỉ cần một dòng: đổi receiver thành `([\w$\])]+)\s*\??\.\s*`. Bộ quét đã ghi giới hạn "destructure không thấy"; nên ghi thêm các dạng trên vào cùng chỗ đó. Hiện phạm vi quét không có dạng nào trong số này, nên test xanh là đúng.
