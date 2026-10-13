# SPEC BP — Áp lực ngược: retry không tự phá đích, không tự phá hub

> Phòng party viết ngày 2026-10-13. Spec chỉ mô tả việc cần làm, **chưa có code**. Admin giao cho phiên dev.
> Tiền tố mã test là `BP:`. Phải thêm namespace `BP` vào `verify/spec-sources.json` **trước** khi viết test đầu tiên, theo dạng khai báo của `KN`.
> **Số ADR bắt đầu từ ADR-195.** `feat/qt` đã dùng tới ADR-191, còn 192–194 để trống làm đệm. Phải grep lại cả ba chỗ trước khi ghi: `git grep -o "ADR-19[0-9]" master feat/qt feat/edge -- docs _bmad-output`.
> Thứ tự giao dev ở §11. **BP1 là vá lỗi**, làm trước, độc lập với phần còn lại.
> **Mỗi mục có khối "Vì sao sửa"** (chuyện gì hỏng, kịch bản cụ thể, vì sao chọn cách này mà không chọn cách khác). Agent dev phải dùng khối này làm dòng **Vấn đề / Đánh đổi** của ADR tương ứng và làm thân commit message. Không viết lại lý do theo trí nhớ. Nếu lúc code thấy lý do không còn đúng thì dừng lại và báo phòng, không âm thầm làm khác.

## ĐÍNH CHÍNH SAU QT (2026-10-13, phòng party) — mục này thắng phần thân

> Phòng đã đọc code `feat/qt` (worktree `C:\wt\qt`, HEAD `0f90ee6`, **chưa merge vào master** — master vẫn `9b32cac`). Chỗ nào phần thân bên dưới nói khác mục này thì **mục này đúng**. Dòng code ghi theo `0f90ee6`; sau khi QT vào master phải grep lại.

**C1 — BP2 §3.1 + `[BP:T5]`: thêm nơi tạo message giao hàng.**
- QT gom việc tạo delivery + outbox `delivery.requested` về **một hàm**: `routeEventToSubscriptions` ở `apps/hub-worker/src/consumers/route-event.ts:14` (gọi `buildDeliveryMessage` ở `:35`; `sub.destinationId` đã có sẵn ở `:28`/`:40`). Hàm này dùng chung cho:
  - normalize: `apps/hub-worker/src/consumers/normalize.consumer.ts:176`;
  - event do hub tự phát: `emitHubEvent` ở `apps/hub-worker/src/scheduler/hub-events.ts:15` (gọi route ở `:41`), với hai nơi gọi là `apps/hub-worker/src/scheduler/storage-alerts.ts:166` (`hub.project.storage`) và `apps/hub-worker/src/scheduler/storage.job.ts:512` (`hub.project.cleanup_suggested`).
- Vì vậy BP2 điền `destinationId` **trong `route-event.ts`**, không sửa riêng ở normalize. Một chỗ sửa phủ được cả event chuẩn lẫn event `hub.*`.
- Danh sách đủ cho `[BP:T5]`: `route-event.ts:35` · `delivery.sweeper.ts` (SQL `INSERT ... 'delivery.requested'`, `:70`) · `apps/hub-api/src/modules/api/api.controller.ts:666` (replay một delivery) **và `:807`** (replay hàng loạt, topic `delivery.replayed`, phần thân bỏ sót) · `slim()` ở `delivery.consumer.ts:132`. `[BP:T5]` phải có ít nhất một ca đi qua `emitHubEvent`.

**C2 — §9: `TOTAL_RETRY_WINDOW_MS` là sàn dọn của QT.**
- Hằng số ở `libs/messaging/src/retry-window.ts` (hiện bằng 10s+1m+5m+30m+2h + 5×30s = 9.520.000 ms ≈ 2h38m40s). QT dùng nó làm sàn cho:
  - lệnh Dọn / Xoá hẳn: `apps/hub-api/src/modules/storage/storage-api.ts:193`, `:265`, `:385`;
  - sàn lần hai ở worker: `retryWindowFloor` trong `apps/hub-worker/src/scheduler/storage-clean.ts:43` → `cleanStorageBatch` (`libs/database/src/tenant-scoped.repository.ts:1536`);
  - dọn tự động: `assertRetentionSafe` ở `apps/hub-worker/src/scheduler/cleanup.job.ts:49`;
  - gợi ý dọn: `apps/hub-worker/src/scheduler/storage.job.ts:447`, `:485`.
- BP sửa hằng số **trong cùng commit** với story sinh ra phần cộng thêm:
  - BP2 thêm `6 × CIRCUIT_MAX_DEFER_MS` khi `CIRCUIT_MAX_DEFER_MS` ra đời;
  - BP5 thêm `NORMALIZE_MAX_DEFER_MS`.
- Giá trị mặc định của hai biến này phải export từ `retry-window.ts`, để hub-api và hub-worker dùng cùng một nguồn. Biến môi trường **chỉ được đặt thấp hơn** giá trị mặc định (kẹp lại). Đặt cao hơn mà sàn không đổi theo thì sàn dọn sai, và đó là lỗi đúng sai.
- Sau BP2+BP5, cửa sổ ≈ 2h38m40s + 3h + 1h = **6h38m40s**. Các lệnh dọn có `olderThan` dưới khoảng 6h39m (ví dụ `3h`, trước đây hợp lệ) sẽ bị từ chối 400.
- Test QT bị ảnh hưởng (grep `TOTAL_RETRY_WINDOW_MS` trong test):
  - `apps/hub-worker/test/cleanup-job.spec.ts:81`: so **tổng cứng**, chắc chắn đỏ, phải sửa. Dòng `:83` vẫn qua, chỉ chú thích "2h36m" bị cũ.
  - `apps/hub-api/test/storage-api.spec.ts:81` và `apps/hub-worker/test/storage-clean-runner.spec.ts:80`: tính động, vẫn đúng.
  - `libs/common/test/storage-clean.spec.ts:15`: `FLOOR = 2.6h` viết cứng, không import hằng số. Test vẫn qua nhưng không còn phản ánh sàn thật.
  - `libs/common/test/cleanup-advisor.spec.ts:70`: tự truyền floor, không đổi.

**C3 — Thứ tự nhánh.**
- BP làm trên `feat/bp`, mở từ master **sau khi** QT vào master. Không mở từ `9b32cac`.
- Phần thân viết rằng "`normalize-errors.ts`, `delivery.consumer.ts` đã bị QT sửa". Phòng đã kiểm lại `git diff master...feat/qt` và thấy:
  - `normalize-errors.ts`: QT sửa 4 dòng, chuyển `NORMALIZE_MAX_RETRIES` sang re-export từ `@hub/messaging`;
  - `normalize.consumer.ts`: QT sửa +10/−43 dòng, tách route sang `route-event.ts`;
  - `delivery.consumer.ts`: tại `0f90ee6` QT **chưa** sửa file này.
- Dù vậy, vẫn mở nhánh sau khi QT merge và grep lại số dòng. F1–F3 trỏ `delivery.consumer.ts` theo master, và QT có thể còn commit thêm.

**C4 — Circuit breaker: thời điểm "thử lại lúc" phải lấy từ PTTL thật của `:open` (60s hoặc 300s).**
- Kết quả kiểm: **đã kiểm, không cộng cứng ở tầng cảnh báo hay nhận định.**
  - `evalCircuitOpen` (`libs/common/src/alerts/rules.ts:357-365`) chỉ nhận `halfOpenAt` tuỳ chọn.
  - `alert.evaluator.ts:381-383` **không truyền** `halfOpenAt`. Hệ quả: câu "Thử lại lúc …" (`libs/common/src/alerts/text.ts:454`) hiện không bao giờ hiện.
  - I-dest (`libs/common/src/alerts/insights.ts:108`) chỉ dùng `circuitState`, không tính giờ.
- Chỗ 60s **đang viết cứng** nằm ở đường gửi, không ở cảnh báo:
  - `circuit-breaker.service.ts:16-21`, `:200` (`CIRCUIT_OPEN_SECONDS = 60`);
  - `delivery.consumer.ts:29` (`CIRCUIT_DEFER = retryQueueForDelay(CIRCUIT_OPEN_MS)`) và `:200` (`nextAttemptAt = now + CIRCUIT_DEFER.ttlMs`);
  - `:261` (hoãn vì lease, 1 phút, không thuộc circuit).
  BP3 thay các chỗ này bằng PTTL mà gate trả về.
- Khi ai đó điền `halfOpenAt` (BP3 hoặc sau này): lấy `now + PTTL(:open)` **đúng lúc trip** (giá trị vừa `SET EX`, 60 hoặc 300), rồi ghi cùng `UPDATE circuit_state` ở `circuit-breaker.service.ts:226`. Evaluator và I-dest **không** gọi Redis mỗi tick (quota Upstash). **Cấm** suy ra bằng `openedAt + 60s`.

**C5 — BP5 khi tắt máy (bổ sung §7.3).**
- `SHUTDOWN_TIMEOUT_MS = 25000` (`apps/hub-worker/src/main.ts:156`). Trình tự hiện tại: cancel consumer → `inFlight.waitIdle(25000 − 5000)`. Con số này **nhỏ hơn** `BACKPRESSURE_HOLD_MAX_MS = 60000`.
- Message đang chờ permit **không được** để `waitIdle` chờ. Khi `shuttingDown`, `acquire()` trả về ngay kết quả `shutdown`, và handler thoát luôn:
  - không xử lý, không republish (republish sẽ tạo bản trùng với bản RabbitMQ giao lại);
  - không ack;
  - để message **unacked**. Channel đóng thì RabbitMQ giao lại cho tiến trình khác.
  - Message đang giữ không được tính vào `inFlight`. Chỉ message đã có permit mới được tính.
- Thêm **`[BP:T24]`** (BP5): controller ở `factor = 1` giữ 5 message rồi gửi SIGTERM. Shutdown xong dưới 25s; 5 message đó không ack, không nack đốt lượt, không republish; message đã có permit chạy xong rồi ack.

**C6 — Admin đã trả lời §15.**
- **Q2:** giữ OPEN tối đa **5 phút** (60s → 300s). Không thêm tầng 2m, không sửa `topology.ts`.
- **Q3:** làm BP5 **trong đợt này**, theo thứ tự BP1 → BP2 → BP3 → BP4 → BP5 → BP6.
- **Q1** (phụ lục đã nộp chưa): **chờ Admin**. BP6 làm trước phần trong repo (`ARCHITECTURE.md`, `DEPLOYMENT.md`, `docs/adr/README.md`, `CLAUDE.md`, `[BP:T23]`). Phụ lục `.docx` để sau, khi có Q1.

**C7 — Số ADR.** Phòng đã grep lại ngày 2026-10-13:
- master `docs` có số lớn nhất là ADR-188;
- `feat/qt` dùng ADR-190 và 191 (`C:\wt\qt\docs\adr\README.md`);
- `feat/edge` và `feat/edge-nginx` dừng ở ADR-187;
- `origin/feat/edge-all` và `origin/feat/qt-final` dừng ở ADR-191;
- không worktree nào có ADR-19x chưa commit.
→ **ADR-195..200 còn trống.** Trước khi ghi vẫn phải grep lại một lần.

**C8 — Chạy chaos.** Chỉ chạy `[BP:T4]`, `[BP:T16]`, `[BP:T21]` (LOCAL, docker-compose) khi trên máy **không có agent nặng nào khác** đang chạy jest, tsc hay docker. Máy có RAM 16GB, WSL bị giới hạn 6GB. Nếu đang có agent khác chạy thì báo coordinator và chờ, không chạy chen vào.

**C9 — BP2: message mang thêm gợi ý `rateLimitRps` (phòng chọn phương án A, 2026-10-13, lúc code BP2).**
- Phát hiện: §3.2/§6 đòi gate (1 lệnh) **trước** khi nạp row, kể cả nhánh "vượt throttle → retry.10s, 0 truy vấn DB", nhưng `rate_limit_rps` chỉ nằm trong DB (`destination.rateLimitRps`). Chỉ có `destinationId` thì đích có throttle phải INCR thêm sau khi nạp → 3 lệnh/delivery, phá R1 (`redis-budget.spec.ts` "đích CÓ throttle vẫn 2 lệnh").
- Quyết định: `DeliveryMessage` thêm gợi ý tuỳ chọn `rateLimitRps` cạnh `destinationId`, điền ở **cùng mọi nơi** (route-event, sweeper SQL, replay đơn, replay hàng loạt, `slim()`). Gate trước khi nạp dùng gợi ý; sau khi nạp, `destinationId` hoặc `rateLimitRps` khác row thật thì gate lại với giá trị thật (+1 lệnh, ca hiếm), không đếm throttle hai lần làm hoãn oan. Message thiếu gợi ý đi đường cũ (nạp rồi gate).
- R1: gợi ý đúng → đích có throttle vẫn 2 lệnh/delivery; gợi ý lệch → 3 lệnh, là ca ngoại lệ đã biết, có test.
- Đánh đổi với ADR-042 (ghi ở ADR-196): message mang một mẩu **cấu hình** chứ không chỉ tham chiếu; giá trị thật vẫn đọc từ DB và kiểm lại trước khi gửi; không có bí mật. `syncObserved` không chạy ở lần hoãn trước khi nạp (không có `persistedState`) → DB thấy OPEN→HALF_OPEN trễ một nhịp, chấp nhận.

**C10 — `[BP:T22]` phần b: HALF_OPEN có probe KHÔNG phải ≤ 3 lệnh (review BP2 lượt 2, 2026-10-13).**
- Đếm như mọi ca khác của R1 (tổng lệnh của delivery, gồm PUBLISH): HALF_OPEN có probe = gate + giành probe + DEL (probe thành công) + PUBLISH delivery = **4 lệnh**, cộng **một PUBLISH `hub:realtime:circuit` mỗi lần đổi trạng thái** (`syncObserved` OPEN→HALF_OPEN, đóng mạch →CLOSED). Bằng đúng trước BP2 (MGET thay cho EVAL). Ca hiếm: một probe mỗi đích mỗi 30s.
- Muốn ≤ 3 thật thì gộp `tryAcquireProbe` vào `LUA_GATE` — để BP4 (sửa chính script này). `[BP:T22]` (phần b) assert chuỗi lệnh đầy đủ, không lọc PUBLISH.

## 0. Bối cảnh

Admin đọc dòng 9 của phụ lục `PhuLuc_MoTaYeuCauKyThuat_WebhookHub.docx` ("retry nhiều mức tăng dần + circuit breaker + outbound throttle") và cho rằng retry liên tục là tự tay phá hệ thống. Admin dẫn bài VNJUG tóm tắt Canva *Worker Backpressure Part 1* (Mikalai Barysau, 17/09/2026).

Bài Canva có ba ý được dùng trong spec này:

1. **Vấn đề là nhịp, không phải số lần.** Trong 32,5 giờ quá tải, Canva ghi nhận 1.795.025 lần thử thất bại nhưng chỉ 22 message vào DLQ. Họ không ngừng retry. Worker chỉ tự giảm số việc nhận vào.
2. **Circuit breaker đóng/mở không có bước đệm.** Mạch vừa đóng lại thì cả đống việc dồn vào một lúc, làm dependency vừa hồi phục ngã lại.
3. **Lùi hẳn rồi thì làm sao biết dependency đã sống lại?** Canva hẹn trả lời ở Part 2. Hub đã có câu trả lời: probe HALF_OPEN, đúng một request dò.

Phòng tách **hai loại phụ thuộc** (đây là nguyên tắc của cả spec):

| Loại | Ví dụ | Lỗi thì ai chậm lại | Cơ chế |
|---|---|---|---|
| **Đích của khách** | URL webhook của project `cafe` | **Chỉ đích đó** | Circuit + throttle + slow-start **theo destination** (BP2–BP4) |
| **Hạ tầng của chính hub** | Postgres (Neon) | **Cả worker**, kiểu Canva | Bộ điều khiển áp lực ngược trong tiến trình (BP5) |

Không bao giờ lấy lỗi của đích làm tín hiệu giảm tốc cả worker. Làm vậy là một đích chết của `cafe` làm chậm `bookstore`, tức noisy neighbor theo chiều ngược.

## 1. Những gì đọc được trong code (2026-10-13, master `9b32cac`)

| # | Ở đâu | Thực tế | Hệ quả |
|---|---|---|---|
| F1 | `delivery.consumer.ts:416-418` | Mọi ngoại lệ chưa xử lý, **kể cả Postgres mất kết nối ở bước 0**, đều đi vào `channel.nack(msg, false, true)` | **Vòng lặp nóng.** RabbitMQ giao lại message ngay lập tức, 20 prefetch × N worker quay tít, đập liên tục vào Neon đang hỏng và xả log. Đây chính là "retry liên tục tự phá" mà Admin lo, nằm ngay trong hub. |
| F2 | `delivery.consumer.ts:133` → `:195-208` | Mỗi lần hoãn vì circuit đều tốn: **nạp delivery** (join event, subscription, destination, có cả payload) + 1–2 lệnh Redis + `UPDATE deferDelivery` + republish. Lặp lại **mỗi phút cho từng message** | Đích chết thì hub tự dội DB của chính nó. 10.000 delivery chờ ≈ 10.000 lần đọc nặng + 10.000 `UPDATE` mỗi phút lên Neon. |
| F3 | `delivery.consumer.ts:40` + `:399` | Trần là 30 lần hoãn, sau đó tính một lần thử rồi **reset về 0** ở tầng kế | Một delivery có thể bị hoãn tới khoảng 6 × 30 = 180 lần. Mỗi lần ≥ 1 lệnh Redis, so với ngân sách ≤ 2 lệnh/delivery (R1, ADR-062). Quota Upstash free là 500.000 lệnh/tháng (`DEPLOYMENT.md:323`), nên 1.000 delivery của **một** đích chết 3 giờ đốt khoảng 180.000 lệnh, tức hơn một phần ba quota tháng. |
| F4 | `redis-budget.spec.ts` | **Không có ca nào cho đường hoãn hay throttle** | Ngân sách Redis chỉ được kiểm ở đường thuận lợi. |
| F5 | `circuit-breaker.service.ts:168-180` | Probe thành công thì xoá 3 khoá, về CLOSED ngay. `rate_limit_rps` mặc định 0 | Hàng hoãn dội về theo prefetch × số worker vào đúng lúc đích vừa dậy. Đây là cú dội Canva mô tả. |
| F6 | `normalize.consumer.ts:236-259` | Lỗi tạm thì vào `retry.30s`, tối đa 5 lần (≈ 2,5 phút), sau đó vào `q.normalize.dlq` | Neon chết hơn 2,5 phút thì cả lô rơi vào DLQ, phải renormalize bằng tay. Đây là hình dạng "trước backpressure" của Canva. |
| F7 | `delivery.sweeper.ts:34-35`, `:52` | Sweeper **bỏ qua** delivery PENDING có `next_attempt_at` còn mới. Lý do: tránh nhân bản message mỗi 10 phút trong lúc OPEN | **Không được bỏ** `UPDATE deferDelivery`. Phòng từng đề xuất bỏ, đề xuất đó sai. Chỉ được ghi **thưa đi** (BP2). |
| F8 | Phụ lục dòng 28 | Hứa "jitter ±20%" | `ARCHITECTURE.md` §4 và §5.4c **cố tình không jitter** ở tầng retry. Giấy hứa một điều code không làm. |
| F9 | `feat/qt` `libs/messaging/src/retry-window.ts` | `TOTAL_RETRY_WINDOW_MS` = tổng 5 tầng + 5 × 30s ≈ 2 giờ 38 phút | **Thiếu thời gian hoãn vì circuit** (tới khoảng 6 × 30 phút). Cửa sổ thật dài hơn, nên mốc dọn an toàn của QT bị đánh giá thấp. BP phải sửa hằng số này (§9). |

## 2. BP1 — Chặn vòng lặp nóng khi hạ tầng hub lỗi (vá lỗi, làm trước)

> **Vì sao sửa**
> - **Chuyện gì hỏng:** `nack(requeue=true)` trả message về **đầu** queue, và RabbitMQ giao lại ngay lập tức, không có độ trễ nào. Lỗi do Postgres chết không tự khỏi trong vài mili giây, nên message lại lỗi, lại requeue. Mỗi worker có 20 message (prefetch) quay vòng như vậy.
> - **Kịch bản:** Neon autosuspend lâu, hoặc mất mạng 2 phút. Hai worker × 20 message quay liên tục, mỗi vòng mở một kết nối Prisma mới tới đúng cái DB đang cố dậy, và mỗi vòng ghi một dòng `log.error`. Log trên Render bị xả đầy, Neon bị dội đúng lúc yếu nhất. Message cũng không bao giờ vào DLQ, vì requeue không tăng bộ đếm nào.
> - **Đây chính là điều Admin lo:** "retry liên tục = tự tay phá". Nó không nằm ở tầng retry 10s→2h (tầng đó có nhịp), mà nằm ở một dòng `catch` không có nhịp.
> - **Vì sao chọn hoãn vào `retry.10s` mà không chọn `nack(false)`:** `nack(false)` cho message vào DLQ ngay, trong khi lỗi DB thường tự hết sau vài phút. Hoãn có độ trễ thì message vẫn sống, mà DB được nghỉ 10 giây giữa các lần.
> - **Vì sao không tăng `attemptCount`:** lần thử chưa hề gọi tới đích. Đốt lượt thử vì lỗi của chính hub thì khách mất webhook vì lỗi không phải của họ.
> - **Vì sao lỗi `unknown` có trần 5 lần:** lỗi lạ có thể là bug cố định (poison message). Không có trần thì nó chạy mãi mỗi phút. Postgres vẫn là nguồn sự thật, sweeper sẽ hồi sinh nếu cần, nên vào DLQ không làm mất dữ liệu.

**Phạm vi:** `delivery.consumer.ts`, nhánh `catch` ngoài cùng.

1. Tách bộ phân loại lỗi hạ tầng thành hàm dùng chung `classifyInfraError(err): 'transient' | 'unknown'`. Đặt trong `libs/common` hoặc cạnh `normalize-errors.ts`. `classifyNormalizeError` giữ nguyên hành vi và gọi lại hàm này. Bảng mã Prisma và mã mạng giữ nguyên như hiện tại.
2. Lỗi `transient`, tức Postgres hoặc mạng:
   - **Không requeue ngay.** Republish message gọn (`slim()`) vào `q.delivery.retry.10s`, header `x-infra-deferrals` + 1, **không tăng `attemptCount`**, rồi `ack`.
   - Báo tín hiệu `infra_fail` cho bộ điều khiển BP5 (trước khi có BP5 thì chỉ đếm metric).
3. Lỗi `unknown` (bug, dữ liệu lạ): republish vào `q.delivery.retry.1m`, header `x-unknown-errors` + 1. Tới lần thứ 5 thì `nack(requeue=false)`, để bản sao vào DLQ broker, và log `error` một lần.
   - **Đính chính khi code BP1 (2026-10-13, ADR-195):** `q.delivery.main` **không có DLX** (`libs/messaging/src/topology.ts`, chỉ `{ durable: true }`), nên `nack(requeue=false)` là vứt message chứ không vào `q.delivery.dlq`. Phòng chọn: lần thứ 5 `channel.publish(x.hub.delivery.dlx, dead, slim())` (header `x-dead-reason: unknown_error` + `x-unknown-errors`), publish xong mới `ack`; publish ném lỗi thì không ack. `[BP:T2]` kiểm "publish DLX đúng một lần rồi ack, không nack".
   - Postgres vẫn là nguồn sự thật. Nếu delivery còn PENDING/RETRYING thì sweeper sẽ hồi sinh nó, tối đa một lần mỗi 10 phút. Có giới hạn, không thành vòng lặp nóng.
4. **Lease:** nếu lỗi xảy ra sau `claimForSend`, delivery đang DELIVERING. Lần sau message quay lại sẽ thua lease 60s và đi nhánh hoãn 1 phút sẵn có. Không cần thêm gì.
5. Metric: `hub_delivery_infra_errors_total{kind}`.

`nack(requeue=true)` **không còn xuất hiện** ở consumer nào (grep phải ra 0).

## 3. BP2 — Hoãn rẻ: chặn ở cửa trước khi nạp DB

> **Vì sao sửa**
> - **Chuyện gì hỏng:** circuit breaker bảo vệ **đích** (không gọi HTTP khi đích chết) nhưng không bảo vệ **hub**. Để biết message thuộc đích nào, consumer phải nạp row trước. Đó là một truy vấn join 4 bảng, kéo cả payload sự kiện về. Sau đó mới hỏi Redis xem mạch có OPEN không. Mạch OPEN thì bỏ hết những gì vừa nạp, `UPDATE` một dòng, rồi republish. Một phút sau lặp lại.
> - **Kịch bản:** một đích của khách chết 3 giờ, có 1.000 delivery chờ. Mỗi phút hub tự làm 1.000 lần đọc nặng + 1.000 `UPDATE` + 1.000 lệnh Redis, chỉ để quyết định "chưa gửi". Cộng cả 6 lần thử, mỗi lần tối đa 30 lần hoãn, thì khoảng 180.000 lệnh Upstash, tức **hơn một phần ba quota cả tháng** (500.000) cho một đích chết của một khách. Neon free cũng chỉ có 1 connection (`connection_limit=1`), nên các truy vấn này giành pool với ingest.
> - **Vì sao đưa `destinationId` vào message:** có nó thì hỏi Redis **trước**. Mạch OPEN thì dừng luôn: 0 truy vấn DB, 1 lệnh Redis. Đây là cách duy nhất để lần hoãn rẻ mà không phải tách queue theo đích. `destinationId` chỉ là tham chiếu, không chứa cấu hình hay bí mật, nên không trái ADR-042 (message chỉ mang tham chiếu, cấu hình luôn đọc từ DB).
> - **Vì sao phải kiểm lại `hint == row`:** subscription có thể đã đổi đích sau khi message được tạo. Tin gợi ý mà không kiểm thì có thể gửi vào một đích đang OPEN, hoặc hoãn oan một đích đang sống.
> - **Vì sao KHÔNG bỏ hẳn `UPDATE deferDelivery`** (phòng từng đề xuất, và đã sai): sweeper (`delivery.sweeper.ts:34`) nhìn `next_attempt_at` để biết delivery PENDING nào đang hoãn hợp lệ. Bỏ cột đó thì cứ 10 phút sweeper tưởng message bị mất và ghi thêm một bản sao. Khi mạch đóng, các bản sao dội vào đích cùng lúc, tức là làm đúng điều mà spec này muốn chặn.
> - **Vì sao 2 phút:** sweeper quét PENDING khi mốc cũ hơn 10 phút, và RETRYING khi cũ hơn 5 phút. Ghi mỗi ≤ 2 phút, với mốc = now + TTL tầng hoãn (≤ 5 phút), thì mốc lưu luôn còn trong hạn. Ghi ít đi khoảng 2–5 lần mà không động vào sweeper.
> - **Vì sao trần tính theo thời gian thay vì số lần:** BP3 làm OPEN dài tới 5 phút. Trần 30 **lần** khi đó thành 30 × 5 phút = 2,5 giờ, chứ không còn 30 phút như ý định ban đầu. Đo bằng thời gian thì ý nghĩa không đổi, dù TTL hoãn là bao nhiêu. Thêm nữa, việc reset bộ đếm về 0 ở mỗi tầng (`:399`) đang làm tổng số lần hoãn nhân lên 6 mà không ai thấy.

### 3.1. Message mang `destinationId`

- `DeliveryMessage` thêm trường **tuỳ chọn** `destinationId: string`. Đây là một tham chiếu, không phải cấu hình, nên đúng tinh thần ADR-042. `buildDeliveryMessage` và `parseDeliveryMessage` giữ trường này; message cũ không có trường thì vẫn đọc được.
- Mọi nơi tạo message giao hàng phải điền trường này:
  - normalize, khi ghi outbox `delivery.requested`;
  - `delivery.sweeper.ts`: câu SQL join thêm `subscriptions.destination_id` vào payload;
  - replay trong `apps/hub-api/src/modules/api/api.controller.ts`;
  - mọi chỗ republish trong `delivery.consumer.ts`. `slim()` đã dựng lại từ `deliveryMsg`, nên chỉ cần giữ trường.
- Kiểm bằng lệnh grep `buildDeliveryMessage\|delivery.requested`: mọi chỗ gọi đều phải có `destinationId`.

### 3.2. Thứ tự mới trong `DeliveryConsumer`

```
có destinationId?
  ├─ có  → GATE (1 lệnh Redis, §6) ──┬─ OPEN / HALF_OPEN không giành được probe → HOÃN (§3.3), 0 truy vấn DB
  │                                   ├─ CLOSED nhưng vượt throttle/ramp → retry.10s, 0 truy vấn DB
  │                                   └─ được gửi → nạp row (bước 0) → kiểm row.destinationId == hint
  │                                         └─ khác (subscription đổi đích) → gate lại với id thật (hiếm, +1 lệnh)
  └─ không (message cũ) → luồng hiện tại: nạp row rồi mới gate
```

- Gate trả về `view`. Các bước sau **dùng lại** `view` đó, không gọi `getState` lần hai, để không tăng bộ đếm throttle hai lần.
- HALF_OPEN và giành được probe: nạp row rồi gửi như hiện tại. Mọi nhánh bỏ ngang phải nhả probe (`releaseProbe`), như code đang làm.

### 3.3. Hoãn: ghi DB thưa đi, trần tính theo thời gian

- **Vẫn ghi `next_attempt_at`** (F7), nhưng chỉ ghi khi header `x-defer-written-at` chưa có hoặc đã cũ hơn **2 phút**. `deferDelivery` là `updateMany` theo `id` + `tenant_id`, không cần đọc trước. Ghi `nextAttemptAt = now + TTL của tầng hoãn`.
  - Biên an toàn với sweeper: PENDING bị quét khi `next_attempt_at` cũ hơn 10 phút, RETRYING khi cũ hơn 5 phút. Ghi mỗi ≤ 2 phút + TTL tầng hoãn ≤ 5 phút thì không bao giờ chạm ngưỡng quét.
  - Nếu có quét nhầm thì vẫn an toàn nhờ lease + `processed_messages`; chỉ tốn thêm việc.
- **Trần tính theo thời gian, không theo số lần.** Header `x-circuit-deferred-since` (epoch ms) được đặt ở lần hoãn đầu tiên của một lần thử, và xoá khi lần thử thật diễn ra (thay cho chỗ reset ở dòng 399).
  - `CIRCUIT_MAX_DEFER_MS`, mặc định `1800000` (30 phút, bằng hành vi cũ 30 × 1m).
  - Vượt trần thì nạp row và ghi một lần thử thất bại, đi tầng kế, như hiện tại.
  - Bỏ `CIRCUIT_MAX_DEFERRALS`. Message cũ còn header `x-circuit-deferrals` mà chưa có `since` thì coi `since = now`.
- Hoãn **không** publish realtime, như hiện tại.

## 4. BP3 — OPEN kéo dài dần, hoãn tới hết OPEN

Hiện tại OPEN luôn là 60s. Đích chết 3 giờ thì mỗi message bị hỏi lại mỗi phút.

> **Vì sao sửa**
> - **Chuyện gì hỏng:** OPEN cố định 60s nghĩa là hub coi mọi sự cố như sự cố một phút. Đích chết 3 giờ thì có khoảng 180 lần probe vào đích, và mỗi message trong hàng bị bốc ra, bỏ vào lại khoảng 180 lần. Probe thất bại lần đầu đã là bằng chứng sự cố không ngắn, vậy mà hub vẫn hỏi lại với nhịp cũ.
> - **Vì sao kéo dài theo số probe thất bại:** đây là backoff ở cấp **đích**, không phải ở cấp message. Một probe thất bại cho biết đích chưa dậy, nên lần sau chờ lâu hơn là hợp lý. Đây cũng là chỗ bài Canva chê circuit breaker "đóng/mở cứng": cái hub cần thêm là nhịp chờ thích ứng, không phải bỏ circuit breaker.
> - **Vì sao trần 300s mà không cao hơn:** đích hồi phục thì phải chờ hết OPEN hub mới biết. 5 phút là mức tối đa phòng thấy chấp nhận được cho một khách vừa sửa xong server. Cao hơn (30 phút) thì một sự cố 10 phút biến thành 37 phút trễ.
> - **Vì sao chỉ hai mức 60s và 300s:** hai giá trị này khớp hai tầng TTL sẵn có (`1m`, `5m`). Mức 120s sẽ rơi vào tầng 5m (tầng ngắn nhất có TTL ≥ thời gian chờ), tức hoãn thừa 3 phút. Muốn mức khác thì phải thêm queue, nghĩa là sửa `topology.ts` và đụng cạm bẫy `PRECONDITION_FAILED` (Q2).
> - **Vì sao `:failures` phải sống lâu hơn `:open`:** HALF_OPEN là trạng thái **suy ra** từ "hết `:open` mà `:failures` còn". Nếu `:failures` hết trước thì mạch nhảy thẳng về CLOSED, bỏ qua probe, và cả hàng dội vào đích chưa chắc đã sống.

- Thêm khoá `circuit:{id}:trips`, INCR mỗi lần **probe thất bại** đưa mạch về OPEN, DEL khi CLOSED.
- Thời lượng OPEN: lần đầu **60s**. Từ lần probe thất bại thứ nhất trở đi là **300s**. Biến `CIRCUIT_OPEN_MAX_SECONDS` mặc định 300, kẹp trong 60–300. Hai giá trị này khớp đúng hai tầng TTL sẵn có là `1m` và `5m`.
- `:failures` phải sống quá `:open` cộng một khoảng HALF_OPEN: `EXPIRE failures = openSeconds + 120`. Nếu không, mạch nhảy thẳng về CLOSED mà không qua probe. Ràng buộc này đã ghi ở `circuit-breaker.service.ts:20`, nay áp cho cả 300s.
- Gate trả về **PTTL của `:open`**. Hoãn vào `retryQueueForDelay(pttl)`, nên được tầng 1m hoặc 5m.
- HALF_OPEN không giành được probe: vẫn hoãn vào `1m`, như cũ.
- Đánh đổi (Sally và John đã cãi nhau): đích hồi phục thì phải chờ tối đa khoảng 5 phút hub mới biết. Đổi lại, một đích chết lâu chỉ tốn khoảng 1 lệnh Redis mỗi 5 phút cho mỗi message, thay vì mỗi phút.
- **P2, không làm trong spec này:** nút "Thử lại ngay" trên console để xoá `:open` và đưa mạch sang HALF_OPEN; hiển thị "tự thử lại lúc hh:mm" ở cấp đích.

## 5. BP4 — Khởi động chậm (slow-start) sau khi đích hồi phục

> **Vì sao sửa**
> - **Chuyện gì hỏng:** một probe thành công chỉ chứng minh đích chịu được **một** request, không chứng minh nó chịu được cả hàng tồn. Hiện tại probe thành công thì xoá khoá và về CLOSED ngay, trong khi `rate_limit_rps` mặc định là 0 (không giới hạn). Toàn bộ hàng hoãn quay về theo tốc độ prefetch × số worker.
> - **Kịch bản:** server của khách chết 20 phút vì hết RAM. Họ restart xong, probe trả 200. Ngay sau đó 500 delivery dội vào trong vài giây, server hết RAM lần nữa, mạch lại OPEN. Khách thấy toast đỏ lần thứ hai và kết luận hub đánh sập họ. Bài Canva gọi đây là đợt tải dồn dập ngay khi breaker vừa cho gọi lại.
> - **Vì sao slow-start mà không jitter (phụ lục hứa jitter ±20%):** jitter ở tầng retry không làm được với TTL theo queue, vì per-message TTL gây head-of-line blocking (§4 ARCHITECTURE). Kể cả làm được, jitter ±20% của 1 phút chỉ rải hàng ra trong khoảng 24 giây, và đích vẫn nhận gần như cả hàng. Slow-start chặn trực tiếp **tốc độ** vào đích, tức đúng thứ cần bảo vệ.
> - **Vì sao nhân đôi theo thời gian (2 → 4 → … → 64):** đây là cách TCP slow-start dò năng lực đường truyền. Đích yếu thì lỗi sớm ở mức thấp, mạch OPEN lại với ít thiệt hại. Đích khoẻ thì sau 60 giây đã chạy gần hết tốc. Nhân đôi đủ nhanh, không cần tham số theo từng khách.
> - **Vì sao không dùng `rate_limit_rps` cố định cho mọi đích:** đúng điều Canva viết, ngưỡng cố định khó chọn, quá chặt lúc bình thường hoặc quá lỏng lúc sự cố. Ramp chỉ áp trong 60 giây sau sự cố, phần thời gian còn lại không giới hạn gì.
> - **Vì sao chỉ ramp khi có probe thành công:** mạch tự về CLOSED vì khoá hết hạn nghĩa là chưa từng OPEN, đích không có hàng tồn, nên không cần ramp.

- Khi **probe thành công** (`recordSuccess` với `failures > 0`), trong **cùng một lệnh**: DEL `failures`, `open`, `probe`, `trips` + SET `circuit:{id}:ramp = nowMs EX DELIVERY_RAMP_SECONDS`. Dùng `MULTI` hoặc Lua.
- Gate (§6), khi CLOSED và còn `:ramp`:
  - `rampCap = RAMP_START_RPS × 2^floor((now − rampStart) / RAMP_STEP_SECONDS)`
  - `cap = min(rate_limit_rps nếu > 0, rampCap)`
  - INCR khoá throttle của giây hiện tại. Vượt `cap` thì đẩy sang `retry.10s` (nhánh `THROTTLE_DEFER` sẵn có): không tăng lượt thử, không ghi DB.
- Mặc định: `DELIVERY_RAMP_START_RPS=2`, `DELIVERY_RAMP_STEP_SECONDS=10`, `DELIVERY_RAMP_SECONDS=60`. Trần cuối khoảng 64 rps, sau đó khoá hết hạn và trở về bình thường. `DELIVERY_RAMP_SECONDS=0` thì tắt.
- Lỗi trong lúc ramp tính bình thường. Đủ ngưỡng thì OPEN và DEL `:ramp`.
- Mạch về CLOSED vì các khoá **tự hết hạn** (không có probe) thì không ramp, vì không có OPEN nào xảy ra.
- Đây là **câu trả lời thay cho jitter** (F8): hàng hoãn chảy về đích theo nhịp tăng dần, không dồn thành một cục.

## 6. Gate: một script Lua thay cho `MGET` và `LUA_STATE_AND_THROTTLE`

Gộp lại thành `LUA_GATE`, **luôn đúng 1 lệnh**, có hay không có throttle cũng vậy.

> **Vì sao sửa:** hiện có hai đường. Đích không throttle dùng `MGET`; đích có throttle dùng `EVAL`. Thêm ramp (BP4) thì đích không throttle cũng có thể cần INCR, mà `MGET` không INCR được. Nếu để hai lệnh riêng thì vượt ngân sách ≤ 2 lệnh/delivery (R1, ADR-062). Gộp vào một script thì giữ được ngân sách, đọc và tăng cùng lúc một cách nguyên tử, và trả luôn PTTL cho BP3 mà không cần thêm lệnh.

- `KEYS`: `open`, `failures`, `throttle:{giây}`, `ramp`
- `ARGV`: ngưỡng lỗi, `rate_limit_rps`, `nowMs`, ramp start, ramp step, TTL throttle
- Trả về: `{state, failures, openPttl, throttleAllowed | -1}`
- Chỉ INCR bộ đếm throttle khi CLOSED **và** có trần (rps > 0 hoặc còn `:ramp`). Không có trần thì không INCR. Giữ đúng tinh thần "0 lệnh throttle khi không giới hạn".
- Redis lỗi thì fail-open (CLOSED, `degraded`), như cũ.
- `tryAcquireProbe` vẫn là lệnh riêng, chỉ chạy khi HALF_OPEN. Đây là trường hợp hiếm, đã có trong ngân sách.
- Ghi chú `DEPLOYMENT.md:325` vẫn đúng: chưa xác nhận Upstash tính 1 `EVAL` là 1 lệnh.

## 7. BP5 — Áp lực ngược kiểu Canva cho hạ tầng của chính hub

> **Vì sao sửa**
> - **Chuyện gì hỏng:** worker là "greedy worker" đúng như Canva tả: còn chỗ trong prefetch là nhận việc, dù việc nào cũng sẽ lỗi vì DB chết. Normalize có 5 lượt × 30s ≈ 2,5 phút. DB chết lâu hơn thế thì **mọi** sự kiện nằm trong hàng đều cạn lượt và vào `q.normalize.dlq`. Sau đó phải có người vào console bấm renormalize.
> - **Kịch bản:** Neon gặp sự cố 20 phút lúc 2 giờ sáng. Không có BP5 thì cả lô sự kiện (vd. 3.000 thanh toán PayOS) vào DLQ, có cảnh báo, và sáng ra phải phát lại tay. Có BP5 thì worker tự chậm lại, chỉ một message đi dò mỗi 5 giây, DB về thì tự tăng tốc lại. DLQ gần như không tăng. Số liệu Canva cho cùng hình dạng sự cố: 22 message vào DLQ, so với ước tính khoảng 16.000 nếu không có backpressure.
> - **Vì sao ở đây được giảm tốc cả worker, còn ở đích thì không:** Postgres là phụ thuộc **chung** của mọi tenant. DB chết thì mọi message đều lỗi, nên chậm lại cả worker không phạt oan ai. Ngược lại, đích chỉ là của một tenant (xem §0).
> - **Vì sao cục bộ trong tiến trình, không dùng Redis:** Canva cũng làm cục bộ, không có coordinator, không gọi mạng. Lý do riêng của hub: Redis có quota (Upstash) và có thể chết. Một bộ điều khiển phụ thuộc Redis để bảo vệ khỏi lỗi hạ tầng thì lại thêm một hạ tầng có thể lỗi.
> - **Vì sao lùi nhanh (+0.25) mà hồi chậm (−0.1):** lùi chậm thì trong lúc lùi đã đốt nhiều lượt thử. Hồi nhanh thì DB vừa dậy đã bị dội lại, đúng lỗi BP4 chữa ở phía đích. Đây cùng hình dạng với AIMD của TCP, nhưng đảo chiều.
> - **Vì sao set point 5%:** đây là con số Canva đã chạy thật qua hai sự cố. Dưới mức đó là nhiễu nền (một deadlock lẻ, một lần timeout), không nên phản ứng.
> - **Vì sao có chế độ dò:** factor = 1 mà không còn permit nào thì worker không bao giờ biết DB đã sống lại. Đây là câu Canva bỏ ngỏ cho Part 2. Hub dùng đúng ý tưởng HALF_OPEN đã có: một message đi dò mỗi 5 giây.
> - **Vì sao có trần giữ 60s:** message chờ permit là message đã được giao mà chưa ack. Giữ quá lâu thì đụng `consumer_timeout` của RabbitMQ (broker đóng channel), và chặn cả các message phía sau. Đẩy sang hàng hoãn mà không đốt lượt thì vẫn an toàn, chỉ tốn một lần republish.
> - **Vì sao chỉ hoãn không đốt lượt khi `factor > 0`:** khi DB khoẻ (factor = 0), một lỗi tạm lẻ vẫn nên đi đường 5 lượt cũ, để một message có vấn đề riêng không được hoãn mãi.
> - **Vì sao không đổi `prefetch` lúc chạy:** hành vi của `basic.qos` với consumer đang mở không chắc chắn giữa các phiên bản RabbitMQ và CloudAMQP. Semaphore trong tiến trình thì hoàn toàn nằm trong tay mình và test được.

### 7.1. Bộ điều khiển

`apps/hub-worker/src/backpressure/`:

```ts
interface BackpressureController {
  record(outcome: 'ok' | 'infra_fail'): void;
  factor(): number;                // 0.0 chạy hết tốc .. 1.0 lùi hẳn
  acquire(): Promise<Release>;     // chờ permit
}
```

- Triển khai `FailureRateController`, **cục bộ trong tiến trình**: không Redis, không gọi mạng, chi phí vài phép tính. Giống Canva.
- Cửa sổ trượt 30s, chia thành bucket 1s. `failureRate = infra_fail / tổng`, chỉ tính khi có ≥ 10 mẫu.
- Mỗi 1s:
  - `rate > SET_POINT` thì `factor = min(1, factor + 0.25)` (lùi nhanh);
  - ngược lại `factor = max(0, factor − 0.1)` (hồi chậm).
  - `BACKPRESSURE_SET_POINT` mặc định `0.05`, bằng con số Canva dùng.
- `permits = max(1, ceil(MAX × (1 − factor)))`, với `MAX` = prefetch (20).
- **Lùi hẳn (`factor = 1`) thì vào chế độ dò:** 1 permit, và mỗi lần bắt đầu xử lý cách nhau ít nhất `BACKPRESSURE_PROBE_INTERVAL_MS` (mặc định 5000). Đây là câu trả lời của hub cho câu Canva để dành Part 2: một message duy nhất đi dò đường, giống HALF_OPEN.
- **Một controller cho mỗi dependency**, hiện chỉ có `db` (Postgres), dùng chung cho cả normalize lẫn delivery trong một tiến trình. Redis không có controller: Redis đã fail-open theo thiết kế, lỗi Redis không phải tín hiệu.

### 7.2. Tín hiệu (John: chỉ lỗi của hạ tầng hub)

| Kết quả | Tín hiệu |
|---|---|
| Xử lý xong, kể cả khi đích trả 5xx, 4xx hay timeout | `ok`. **Lỗi của đích không bao giờ là tín hiệu.** |
| `classifyInfraError(err) === 'transient'` ở bất kỳ bước DB nào | `infra_fail` |
| Lỗi `unknown` hoặc lỗi dữ liệu (`permanent`) | không ghi gì |

### 7.3. Giữ message ở đâu

- Handler `await controller.acquire()` **trước** khi xử lý. Message vượt số permit nằm chờ trong tiến trình, vẫn unacked. Worker chết thì RabbitMQ giao lại, không mất gì.
- **Trần giữ** `BACKPRESSURE_HOLD_MAX_MS`, mặc định 60000. Quá trần thì republish sang queue hoãn tương ứng **mà không đốt lượt** (normalize: `retry.30s`, không tăng `x-normalize-retry`; delivery: `retry.10s`, không tăng `attemptCount`), rồi `ack`. Lý do: không giữ quá lâu so với `consumer_timeout` của RabbitMQ, và không chặn các message phía sau.
- Prefetch giữ nguyên 20. Không đổi `basic.qos` lúc đang chạy (hành vi với consumer đang mở không chắc chắn).

### 7.4. Hoãn không đốt lượt ở normalize

- Khi `factor > 0` (hub đã biết DB đang ốm), lỗi `transient` ở normalize **không** tăng `x-normalize-retry`. Thay vào đó đặt header `x-normalize-deferred-since` và đẩy vào `retry.30s`.
- Trần theo thời gian: `NORMALIZE_MAX_DEFER_MS`, mặc định `3600000` (60 phút). Quá trần thì đốt lượt như cũ.
- `factor = 0` (lỗi lẻ tẻ, DB khoẻ) thì hành vi cũ: 5 lượt × 30s rồi vào DLQ.
- Kết quả mong đợi: Neon chết 20 phút thì DLQ tăng gần 0, thay vì cả lô.

### 7.5. Ngoài phạm vi BP5

Ingest (`hub-api`) đã trả 5xx khi DB chết (BB-3), nên provider tự retry. Không đổi. Outbox relay giãn chu kỳ poll khi lỗi liên tiếp: để P2.

### 7.6. Metric

`hub_backpressure_factor{dependency}` (gauge) · `hub_backpressure_held{consumer}` (gauge) · `hub_backpressure_spilled_total{consumer}` · `hub_deliveries_deferred_total{reason="circuit|throttle|ramp|infra"}`. Tất cả đếm trong bộ nhớ, 0 lệnh Redis.

## 8. BP6 — Giấy phải khớp code

> **Vì sao sửa**
> - **Chuyện gì hỏng:** phụ lục là tài liệu nộp cho giảng viên, và hội đồng sẽ đối chiếu với sản phẩm. Phụ lục hứa jitter ±20%, trong khi `ARCHITECTURE.md` ghi rõ là **cố tình không làm**. Hội đồng hỏi "jitter nằm ở đâu trong code" thì không có câu trả lời, và một mục bị trừ điểm vì sai so với chính tài liệu của mình. Đề tài chấm nặng phần "hiểu bản chất".
> - **Dòng 29 cũng lệch:** phụ lục ghi "5 lỗi liên tiếp, thử lại sau 60 giây". Code đếm ≥ 5 lỗi **phía đích** (5xx/408/429/mạng) trong cửa sổ 2 phút, có HALF_OPEN với đúng một probe, và sau BP3 là 60s rồi 300s.
> - **Vì sao sửa giấy theo code chứ không ngược lại:** jitter không làm được với kiến trúc TTL theo queue (BP4 đã nói lý do), còn slow-start giải đúng vấn đề mà jitter nhắm tới. Sửa code cho khớp một câu viết sai là làm ngược.
> - **Vì sao thêm 3 dòng vào §5.4c:** những gì hub cố tình **không** làm (áp lực ngược cả worker theo lỗi đích, tách queue theo đích, auto-scale) là câu hỏi hội đồng chắc chắn hỏi sau khi nghe tới Canva. Có sẵn lý do trong tài liệu kiến trúc thì đó là điểm cộng.

| File | Sửa |
|---|---|
| **Phụ lục** (`C:\Users\admin\Downloads\PhuLuc_MoTaYeuCauKyThuat_WebhookHub.docx`, **ngoài repo**, sửa bằng skill docx) | Dòng 28: bỏ "jitter ±20%", thay bằng "không dùng độ lệch ngẫu nhiên ở tầng thử lại (hàng đợi trễ theo TTL cố định); sau khi đích hồi phục, tốc độ gửi tăng dần (khởi động chậm) để không dồn tải". Dòng 29: "≥ 5 lỗi phía đích trong 2 phút; ngắt 60 giây lần đầu, 5 phút nếu lần dò thất bại; khi nửa mở chỉ cho đúng một yêu cầu dò". Dòng 9: thêm "tự giảm tốc độ xử lý khi hạ tầng của chính hệ thống gặp sự cố". **Chờ Admin trả lời Q1.** |
| `ARCHITECTURE.md` §3.3 | Thứ tự mới (gate trước khi nạp row), BP1, slow-start |
| §4 bảng tham số | Dòng jitter: "không có ở tầng retry; thay bằng slow-start theo đích (§5.4)" |
| §5.4 | OPEN 60s → 300s, `:trips`, `:ramp`, trần hoãn theo thời gian |
| §5.4c "Cố tình không làm" | Thêm: **áp lực ngược cả worker theo lỗi của đích** (vì phạt tenant khác); **tách queue theo đích**; **auto-scale theo độ sâu queue** |
| §5.4e (mới) | "Áp lực ngược khi hạ tầng hub lỗi", tóm tắt BP5 + đối chiếu Canva |
| `DEPLOYMENT.md` | Biến môi trường mới (§10), bỏ `CIRCUIT_MAX_DEFERRALS`, tính lại quota Upstash cho đích chết |
| `docs/adr/README.md` | ADR-195..200 (§12) |
| `CLAUDE.md` | Dòng ngân sách Redis: thêm "đường hoãn/throttle ≤ 1 lệnh, 0 truy vấn DB" |

## 9. Tương tác với nhánh khác

> **Vì sao phải sửa cửa sổ của QT:** QT dùng `TOTAL_RETRY_WINDOW_MS` làm mốc "dữ liệu mới hơn mốc này có thể còn đang retry, không được dọn". Nếu một message còn sống lâu hơn cửa sổ (vì bị hoãn circuit, cái mà hằng số chưa tính), thì `processed_messages` hoặc `outbox` của nó có thể bị dọn trước khi nó chạy xong. Lúc đó lần gửi tiếp theo không còn bản ghi chống trùng, và đích nhận **trùng**. Đây là lỗi đúng sai, không phải lỗi hiệu năng, dù với mặc định dọn theo ngày thì hiếm xảy ra.

- **`feat/qt`** (`libs/messaging/src/retry-window.ts`, `normalize.consumer.ts`, `normalize-errors.ts`): `TOTAL_RETRY_WINDOW_MS` phải cộng thêm `6 × CIRCUIT_MAX_DEFER_MS + NORMALIZE_MAX_DEFER_MS`. Phần cộng circuit là **lỗi đã có từ trước** (F9), nên báo cho phiên giữ `feat/qt` biết. BP rebase sau QT. Nếu QT chưa merge thì BP để hằng số ở `libs/messaging` để QT dùng lại.
- **`normalize-errors.ts`** đang bị QT sửa 4 dòng. BP1 tách `classifyInfraError` ra, nên nhớ rebase cẩn thận.
- `feat/edge`, `feat/edge-nginx`: không đụng.

## 10. Biến môi trường mới

```
CIRCUIT_MAX_DEFER_MS=1800000        # thay CIRCUIT_MAX_DEFERRALS
CIRCUIT_OPEN_MAX_SECONDS=300        # 60..300
DELIVERY_RAMP_START_RPS=2
DELIVERY_RAMP_STEP_SECONDS=10
DELIVERY_RAMP_SECONDS=60            # 0 = tắt slow-start
BACKPRESSURE_SET_POINT=0.05
BACKPRESSURE_PROBE_INTERVAL_MS=5000
BACKPRESSURE_HOLD_MAX_MS=60000
NORMALIZE_MAX_DEFER_MS=3600000
```

## 11. Story và thứ tự

- [x] **BP1** — Vòng lặp nóng (§2). Nhỏ, độc lập. **Làm trước.**
- [x] **BP2** — `destinationId` + gate trước khi nạp + hoãn thưa + trần theo thời gian (§3, §6 phần gate)
- [x] **BP3** — OPEN kéo dài dần (§4). Cần BP2.
- [ ] **BP4** — Slow-start (§5). Cần gate của BP2.
- [ ] **BP5** — Bộ điều khiển áp lực ngược (§7). Cần `classifyInfraError` của BP1.
- [ ] **BP6** — Đồng bộ giấy (§8). Phần phụ lục chờ Q1.

Mỗi story đi theo VF (RED → PROBED → REVIEWED), review riêng, rồi mới commit.

## 12. ADR (ghi khi làm, mỗi ADR 3 dòng)

| ADR | Nội dung |
|---|---|
| 195 | Lỗi hạ tầng ở delivery không bao giờ `requeue=true`; hoãn 10s, không đốt lượt (BP1) |
| 196 | Message giao hàng mang `destinationId` làm gợi ý để gate trước khi nạp DB; trần hoãn tính theo thời gian (BP2) |
| 197 | OPEN 60s → 300s theo số probe thất bại; hoãn tới hết OPEN (BP3) |
| 198 | Slow-start sau probe thành công thay cho jitter (BP4); phụ lục được đính chính |
| 199 | Áp lực ngược cục bộ kiểu Canva, chỉ cho phụ thuộc của chính hub; lỗi đích không bao giờ là tín hiệu (BP5) |
| 200 | Cửa sổ retry của QT phải gồm thời gian hoãn (§9) |

## 13. Test

| Mã | Story | Kiểm cái gì |
|---|---|---|
| `[BP:T1]` | BP1 | Prisma P1001 ở bước 0: message vào `retry.10s`, `attemptCount` giữ nguyên, **không** `nack(requeue=true)` |
| `[BP:T2]` | BP1 | Lỗi `unknown` 5 lần liên tiếp: publish DLX đúng một lần rồi ack, không nack, không vòng lặp (đính chính §2 mục 3); publish DLX ném lỗi thì không ack |
| `[BP:T3]` | BP1 | Grep: không còn `nack(msg, false, true)` trong `apps/hub-worker/src` |
| `[BP:T4]` | BP5 | Chaos (local): dừng Postgres 60s khi đang có tải. Số lần gọi Prisma mỗi giây bị chặn trên; log không xả quá N dòng/s. **Đính chính sau review BP1:** BP1 không cho cận trên số lần gọi Prisma (nhánh transient không trần; backlog Q message ≈ Q/10 lần gọi/s khi DB fail nhanh) — cận trên thuộc BP5, nên T4 tính vào BP5. BP1 chỉ chặn log (≤ 1 dòng/30s/tiến trình) và đổi vòng nóng không nhịp thành nhịp 10s/message; số đo trước/sau BP1 vẫn nên ghi lại làm đối chứng |
| `[BP:T5]` | BP2 | Mọi nơi tạo message (normalize, sweeper, replay) đều có `destinationId` |
| `[BP:T6]` | BP2 | Circuit OPEN + message có `destinationId`: **0 truy vấn DB**, đúng 1 lệnh Redis |
| `[BP:T7]` | BP2 | Hoãn 5 lần trong 4 phút: tối đa 2 lần `deferDelivery` |
| `[BP:T8]` | BP2 | Sweeper không quét delivery đang hoãn trong 3 giờ (DB test chạy câu SQL thật) |
| `[BP:T9]` | BP2 | Quá `CIRCUIT_MAX_DEFER_MS`: ghi một lần thử thất bại, đi tầng kế, xoá `since` |
| `[BP:T10]` | BP2 | Message cũ (không có `destinationId`, có `x-circuit-deferrals`) vẫn chạy đúng |
| `[BP:T11]` | BP2 | `destinationId` gợi ý khác row thật: gate lại với id thật, không gửi nhầm khi mạch đang OPEN |
| `[BP:T12]` | BP3 | Probe thất bại lần 1: `:open` có TTL 300; `:failures` sống quá `:open` |
| `[BP:T13]` | BP3 | OPEN còn 250s: hoãn vào `retry.5m` |
| `[BP:T14]` | BP4 | Probe thành công: một lệnh xoá 4 khoá + đặt `:ramp` |
| `[BP:T15]` | BP4 | Trong ramp, giây 0–9 cho tối đa 2 request/s, giây 10–19 tối đa 4; phần vượt vào `retry.10s`, không ghi DB |
| `[BP:T16]` | BP4 | Kịch bản: đích chết 10 phút với 500 hàng hoãn → hồi phục. Không giây nào vượt trần ramp |
| `[BP:T17]` | BP5 | Controller: tỷ lệ lỗi 0% → factor 0; 50% trong 5s → factor 1; về 0% → giảm dần, không nhảy |
| `[BP:T18]` | BP5 | 5xx của đích **không** làm factor đổi |
| `[BP:T19]` | BP5 | Chế độ dò: tối đa 1 lần xử lý mỗi `PROBE_INTERVAL_MS` |
| `[BP:T20]` | BP5 | Giữ quá `HOLD_MAX_MS`: republish không đốt lượt, ack |
| `[BP:T21]` | BP5 | Chaos: Postgres chết 10 phút dưới tải đều. `q.normalize.dlq` tăng ≤ 5 (trước BP5 là cả lô); tất cả được xử lý xong sau khi DB về |
| `[BP:T22]` | Ngân sách | `redis-budget.spec.ts` thêm ca: hoãn OPEN = 1 lệnh; throttle/ramp = 1 lệnh; HALF_OPEN có probe ≤ 3 lệnh |
| `[BP:T23]` | BP6 | `docs-sync`: không còn "jitter ±20%" trong repo; §5.4c có ba dòng mới |

T4, T16 và T21 là số liệu để đưa vào báo cáo. Chạy ở **LOCAL** (ADR-019), có kèm đối chứng trước/sau, giống cách Canva trình bày.

## 14. Cố tình không làm

| Không làm | Vì sao |
|---|---|
| Jitter cho từng message | TTL nằm ở queue. Per-message TTL thì message 2h chặn message 10s (head-of-line blocking). Slow-start giải quyết đúng vấn đề mà jitter nhắm tới. |
| Áp lực ngược cả worker theo lỗi của đích | Phạt tenant khác (§0) |
| Tách queue theo đích | Bùng nổ topology, phá luật "khai báo một chỗ" |
| Auto-scale theo độ sâu queue | Render free không có. Scale lên còn bắn mạnh hơn vào đích yếu, và throttle theo đích đã chặn chuyện đó |
| Thuật toán PID / AIMD tinh chỉnh | Canva cũng để sang Part 2. Bậc thang +0.25/−0.1 là đủ để chứng minh, có test T17 |
| Tín hiệu theo độ trễ | Canva cũng chưa làm |

## 15. Câu hỏi mở cho Admin

- **Q1.** Phụ lục đã nộp cho thầy chưa? Chưa nộp thì BP6 sửa dòng 9, 28, 29. Nộp rồi thì giữ nguyên file và chuẩn bị câu trả lời "jitter ở đâu" cho buổi bảo vệ.
- **Q2.** OPEN tối đa 5 phút (đích hồi phục thì chờ tối đa khoảng 5 phút) có chấp nhận được không? Sally muốn 2 phút, nhưng không có tầng TTL 2m. Muốn có thì phải thêm queue, tức sửa `topology.ts`.
- **Q3.** BP5 có làm ngay, hay để sau BP1–BP4? BP5 lớn nhất và nhiều chữ nhất, nhưng cũng là phần giống Canva nhất, nên dễ ghi điểm "hiểu bản chất".

## 16. Ghi chú / nợ phát hiện khi code

- **Nợ (BP1, 2026-10-13):** nhánh parse lỗi của `DeliveryConsumer` (`parseDeliveryMessage` ném) vẫn `channel.nack(msg, false, false)` kèm log "chuyển DLQ". Vì `q.delivery.main` không có DLX, message đó bị vứt chứ không vào `q.delivery.dlq`. Không sửa trong BP1 theo quyết định của phòng; cách sửa gợi ý giống BP1: publish bản sao vào `x.hub.delivery.dlx` rồi ack.
- **BP1 review M3 (2026-10-13):** BP1 **không** đưa ra cận trên cho số lần gọi Prisma mỗi giây khi DB chết. Nhánh transient không có trần, mỗi message 1 truy vấn mỗi 10s; với lỗi fail nhanh (`ECONNREFUSED`) backlog Q message ≈ Q/10 truy vấn/s. Cận trên thuộc BP5 (bộ điều khiển áp lực ngược) → `[BP:T4]` chuyển sang nhóm BP5. Trong BP1 chỉ log được chặn: tối đa 1 dòng `warn` / 30s / tiến trình kèm số lần bị gộp (bộ đếm trong bộ nhớ); metric `hub_delivery_infra_errors_total` vẫn đếm đủ.
- **Nợ (review BP1 T1):** riêng `deliveryChannel` đóng (lỗi mức channel) mà connection còn sống thì worker thành zombie: còn sống, không consume. `main.ts` chỉ nghe `close` của connection. Gợi ý: `deliveryChannel.on('close', …)` đi cùng đường thoát với connection.
- **Nợ (review BP1 T5):** probe HALF_OPEN giành được ở bước 1 không được nhả khi lỗi rơi vào `catch` ngoài cùng → đích bị khoá dò tới hết TTL probe (30s). Nợ cũ, BP1 không làm tệ hơn.
- **Đề xuất cho BP5 (review BP1 T3):** lỗi hạ tầng ngoài bảng bị xếp `unknown` — `PrismaClientUnknownRequestError` 57P01 (Neon cắt kết nối), amqplib "Channel closed". Hệ quả: ~5 phút vào DLX, metric `kind=unknown` lẫn lỗi hạ tầng. BP1 KHÔNG đổi bảng mã (spec giữ nguyên); BP5 xem xét mở rộng `classifyInfraError`.
- **Nợ (review BP1 T4):** nhánh unknown không để dấu vết trong Postgres (`last_error` không đổi) — console không thấy, chỉ có log và bản sao DLQ broker (drop-head 5000). `x-dead-error` đã bỏ stack, chỉ tên lỗi + message cắt 200 ký tự.
- **Cho BP3 (review BP2 lượt 2):** gộp `CIRCUIT_DEFER_ROUND_MS` (`libs/messaging/src/retry-window.ts`, cộng vào cửa sổ retry) và `CIRCUIT_DEFER` (`delivery.consumer.ts`, tầng hoãn thật) về **một nguồn** — BP3 hoãn theo PTTL tới `retry.5m` nên một vòng hoãn thành 5 phút; hai hằng số lệch nhau là cửa sổ dọn của QT sai.
- **BP3 review (2026-10-13), chỉ ghi nhận:** (TH-3) request gửi với view CLOSED thất bại sau lần trip lại 300s có thể đặt lại `:open` EX 60 (rút OPEN xuống 60s) — hầu như không xảy ra, chấp nhận. (TH-4) rolling deploy với worker BP2: không NULL `circuit_half_open_at`, không DEL `:trips` — vô hại, tự lành ở lần trip kế / sau ≤ 420s. Chi tiết ở đánh đổi ADR-197.
- **Nợ (BP3 review lượt 2, 2026-10-13):** câu "Thử lại lúc …" (`libs/common/src/alerts/text.ts`) so `halfOpenAt` với `ctx.now`. Email dựng ở server nên dùng giờ server; web dùng `Date.now()` của trình duyệt qua `useMinuteClock` — lệch theo đồng hồ máy người dùng và tối đa ~1 phút do nhịp cập nhật. Web nên cộng độ lệch `asOf − Date.now()` (cùng hướng ADR-188). Không sửa code web trong đợt BP.
