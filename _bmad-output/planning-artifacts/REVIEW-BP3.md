# REVIEW BP3 — `8758c8c..fb59363`

Reviewer độc lập, 2026-10-13. Chỉ đọc; HEAD giữ ở `feat/bp`. Đột biến đều đã `git checkout` trả lại. Redis tạm (cổng 56380) đã dừng.

## Kết luận: **ĐẠT**

Không có mức Cao hay Trung bình. Còn 5 mục mức Thấp, đều không chặn merge.

## Đã chạy

- **Jest:** `npx jest apps/hub-worker apps/hub-api/test/redis-budget.spec.ts libs` → 78 suite qua (22 skip); 596 test qua (94 skip).
- **tsc:** hub-worker và hub-api sạch.
- **`verify:map`:** 400 mã, 324 có test, 0 mồ côi, 0 ma, 0 trùng. Đã checkout lại `TEST-MAP.md`.
- **`verify:gates`:** 20 luật, 0 vi phạm.
- **Redis thật:** `RUN_DB_TESTS=1 REDIS_URL=…` chạy circuit-breaker, delivery-gate, alert-evaluator, cleanup-job, delivery-defer, redis-budget → **75/75 qua**.
- **Đột biến:**

| Đột biến | Kết quả |
|---|---|
| TTL `:failures` cứng 180s | 3 đỏ |
| OPEN luôn 60s | 3 đỏ |
| CLOSED không xoá `:trips` | 2 đỏ |
| `halfOpenAt` = now + 60s | 1 đỏ |
| Cửa sổ dùng vòng 1m | 1 đỏ |
| Bỏ kẹp env | 1 đỏ |
| `:trips` tăng cả ở trip đầu | 2 đỏ |
| Không NULL `circuit_half_open_at` khi rời OPEN | sống ở đây (test DB bị skip). Đã có test bắt: `delivery-lease-sweeper.spec.ts:247`, CI job `db` chạy |
| Bỏ kẹp PTTL ≤ 300s | sống. Tương đương: TTL tối đa là 300s |
| HALF_OPEN dùng PTTL | sống. Tương đương: gate chỉ trả PTTL khi OPEN |

## Soát theo từng điểm

**1. Đúng đắn của circuit**
- Chuỗi chuyển trạng thái:
  - Trip đầu khi CLOSED → OPEN 60s.
  - `:failures` sống 180s, nên có 120s HALF_OPEN.
  - Probe thất bại (view là HALF_OPEN) → OPEN `circuitOpenMaxSeconds()`.
  - `:failures` và `:trips` EXPIRE `open + 120` (circuit-breaker.service.ts:228-240).
  - Probe thành công → DEL 4 khoá trong một lệnh (:206).
- Không khoá nào sống vĩnh viễn: `:trips` luôn được INCR cùng EXPIRE trong một MULTI.
- `:failures` không hết hạn trước `:open`, nên không mất bước HALF_OPEN.
- Env (retry-window.ts:31-36): rỗng, âm hoặc rác → 300; `>300` → 300; `<60` → 60.

**2. `circuitDeferTier`** (retry-window.ts:43-46)
- Gate chỉ đặt `openPttlMs` khi PTTL > 0. Vì vậy các ca PTTL −1/−2/0, HALF_OPEN, degraded hay `undefined` đều rơi về 60s → `retry.1m`.
- Degraded nghĩa là view CLOSED, không hoãn: fail-open như trước.
- Khi OPEN, PTTL từ 61s đến 300s đều vào `retry.5m`. Message có thể chờ thừa tới ~4 phút sau khi OPEN hết. Spec §4 và ADR-197 đã chấp nhận điều này.
- Không có nhánh nào gửi khi còn OPEN: mỗi lần quay lại đều qua gate.

**3. Cửa sổ retry**
- `TOTAL_RETRY_WINDOW_MS` = 9.520.000 + 6 × (1.800.000 + 300.000) = 22.120.000 ms = 6h08m40s.
- Hoãn tối đa thật trong một lần thử: lần hoãn cuối được quyết định khi `now − since ≤ 30 phút`, rồi chờ thêm ≤ 5 phút. Tổng ≤ 35 phút, khớp với cửa sổ.
- Mọi nơi QT dùng vẫn import hằng số này: storage-api :193/:265/:385, `retryWindowFloor`, `assertRetentionSafe`, storage.job.
- `CIRCUIT_DEFER_ROUND_MS` giờ suy ra từ chính `circuitDeferTier`: đã một nguồn, đóng nợ §16.

**4. C4 (`circuit_half_open_at`)**
- `halfOpenAt = now + openSeconds` được tính ngay lúc trip và ghi cùng `updateMany` đổi `circuit_state`. Trạng thái khác OPEN → NULL (tenant-scoped.repository.ts:309-314).
- Evaluator đọc cột này qua `findAlertDestinations` sẵn có, không gọi Redis, không dùng `openedAt + 60`.
- Facts được làm mới mỗi tick khi alert còn mở (alert.evaluator.ts:465), nên câu "Thử lại lúc …" theo kịp các lần trip lại.
- Về đánh đổi "UPDATE có điều kiện không ghi được thì mốc cũ một nhịp": **chấp nhận được**, vì chỉ ảnh hưởng câu hiển thị. Xem TH-1 để tránh in ra giờ đã qua.

**5. Migration**
- Chỉ `ADD COLUMN` nullable, có `lock_timeout 5s`, theo tiền lệ của 3 migration QT. Không có DML, nên không cần `app.rls_system`.
- Policy RLS của `destinations` theo dòng, không bị ảnh hưởng.
- Schema Prisma khớp (`DateTime? @db.Timestamptz(6)`).
- BB-5 giữ nguyên: ghi qua `TenantScopedRepository`, đọc qua truy vấn đã scope `tenant_id`.

**6. R1**
- `LUA_GATE` không đổi, vẫn 1 EVAL. Đường gửi nóng không thêm lệnh nào.
- `:trips` chỉ thêm 2 lệnh vào MULTI khi probe thất bại (hiếm).

## Phát hiện

### Thấp

**TH-1 — Câu cảnh báo có thể in giờ đã qua.**
- Vị trí: libs/common/src/alerts/text.ts:454.
- Kịch bản:
  - `syncObserved` OPEN→HALF_OPEN ghi DB lỗi (lỗi bị nuốt ở `transition`), hoặc gate đang degraded.
  - Lần trip lại không đổi được dòng (DB vẫn OPEN), nên `circuit_half_open_at` giữ mốc cũ trong quá khứ.
  - Alert hiển thị "Thử lại lúc 10:01" trong khi đã 10:04.
- Sửa rẻ, chọn một trong hai:
  - `text.ts` bỏ câu khi `halfOpenAt < now`;
  - hoặc điều kiện UPDATE thêm `OR (state = 'OPEN' AND circuit_half_open_at < ${halfOpenAt})`.

**TH-2 — `:trips` chưa ai đọc.**
- Vị trí: circuit-breaker.service.ts:239.
- Spec yêu cầu và ADR-197 đã ghi lý do. Chi phí là 2 lệnh mỗi lần probe thất bại, nhưng không có metric hay log nào lấy giá trị ra.
- Đề nghị: log `trips` ở dòng `warn` khi trip, hoặc để dành cho BP4/BP6.

**TH-3 — Một trip lần đầu có thể rút ngắn OPEN 300s xuống 60s.**
- Vị trí: circuit-breaker.service.ts:236 (`SET EX` ghi đè TTL).
- Kịch bản: một request gửi với view CLOSED (ví dụ fail-open khi Redis chập chờn) thất bại *sau* lần trip lại 300s. Khi đó `recordFailure` thấy `failures ≥ 5` và đặt lại `:open` EX 60.
- Hầu như không xảy ra: request thường kết thúc trong ≤ 10s, còn probe chạy sau ≥ 60s.
- Nếu muốn chặt: dùng `SET … EX openSeconds` có điều kiện "chỉ khi PTTL hiện tại nhỏ hơn" (Lua), hoặc chấp nhận và ghi nhận.

**TH-4 — Rolling deploy: worker BP2 không đụng tới cột mới.**
- Worker BP2 vẫn ghi `circuit_state` nhưng không NULL `circuit_half_open_at`, và không DEL `:trips`.
- Mốc cũ sẽ bị ghi đè ở lần trip tiếp theo; `:trips` tự hết hạn sau ≤ 420s.
- Vô hại, chỉ ghi nhận.

**TH-5 — Độ phủ test ở môi trường này.**
- Test DB của BP3 (`delivery-lease-sweeper.spec.ts:244-247`, kiểm NULL khi rời OPEN) bị skip vì không có Postgres. Đột biến M5 sống sót ở đây.
- Cần xác nhận job `db` trên CI xanh trước khi merge.

---

# Lượt 2 — `fb59363..5d64381`

## Kết luận lượt 2: **ĐẠT**

HEAD giữ ở `feat/bp`.

## Đã chạy

- `npx jest libs/common apps/hub-worker/test/circuit-breaker.spec.ts`: 24 suite qua, 160 test qua (7 skip).
- `verify:map`: 0 mồ côi, 0 ma, 0 trùng. Đã checkout lại `TEST-MAP.md`.
- CI của `fb59363` xanh cả job `db` (theo coordinator), nên TH-5 lượt 1 đã đóng.

## Từng mục

**TH-1 — Đóng (logic); còn một điểm Thấp về nguồn giờ**
- Logic: `ts !== null && ts >= ctx.now` (text.ts:456-457). Biên bằng nhau thì vẫn in câu, đúng: lúc đó chưa qua mốc. Facts thiếu hoặc rác thì `time()` trả null, câu bị bỏ. Có test cho cả hai phía của mốc (alert-rules.spec.ts:252-260).
- Nguồn giờ **không phải** asOf của server ở mọi nơi dựng câu:
  - **Email** (email.ts:162): giờ server, đúng.
  - **Web** (alert-ui.tsx:73): `useMinuteClock()` lấy `Date.now()` của **trình duyệt**, làm tươi mỗi 60s. `GET /alerts` có `asOf`, nhưng chỉ `notify-logic` dùng; câu chữ thì không.
- Hệ quả (chỉ ảnh hưởng hiển thị):
  - Đồng hồ máy khách chạy nhanh → câu bị ẩn sớm.
  - Đồng hồ chạy chậm, hoặc `now` cũ tới 60s → giờ đã qua vẫn hiện thêm tối đa khoảng 1 phút.
- Các câu khác (ví dụ "im lặng 3 giờ") cũng dùng đồng hồ trình duyệt, nên đây là tiền lệ sẵn có, không chặn merge.
- **Việc cần sửa:** chú thích "evaluator/asOf" ở text.ts:454 sai với web. Sửa thành "đồng hồ của nơi dựng câu (server với email, trình duyệt với web)".
- Nếu muốn chặt hơn: web tính độ lệch `asOf − Date.now()` lúc fetch, rồi cộng vào `useMinuteClock`.

**TH-2 — Đóng**
- Không thêm lệnh Redis: số đọc từ kết quả `exec()` của chính MULTI.
- Chỉ số đúng: thứ tự là `set(0)`, `expire(1)`, `del(2)`, `incr(3)`, nên `res[3][1]` là INCR `:trips` (circuit-breaker.service.ts:241-243). Lệnh lỗi trong MULTI làm giá trị thành `NaN || null`, không ném.
- Fake `exec()` mới trả `[[null, kết quả]]` như ioredis. Toàn bộ circuit-breaker.spec vẫn qua, cả trên Redis thật lẫn fake (`trips: 1`).
- Thay đổi hành vi nhỏ: giờ log `warn` ở **mỗi** lần trip, kể cả trip lặp do request đang bay khi `failures ≥ 5`, trong khi trước đây chỉ log khi DB chưa là OPEN. Số dòng log bị chặn bởi số request đang bay, chấp nhận được.

**TH-3, TH-4 — Đóng**
- Đã ghi nợ ở spec §16 và trong phần đánh đổi của ADR-197. Nội dung đúng với nhận định lượt 1.

**Tick `[x] BP3` — Hợp lệ**
- `verify:map` sạch; T12 (a–c) và T13 (a–d) đều có test.
