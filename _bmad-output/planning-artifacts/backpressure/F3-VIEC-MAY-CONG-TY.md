# F3 bậc cuối (ADR-241) — việc còn phải chạy ở máy công ty

Nhánh `feat/bp-f3`, code ở commit `1c84d84` + bản vá review `REVIEW-F3` (commit sau `d1a1020`, xem `git log`; tách từ master `d417118`). Kéo nhánh về, ở **HEAD của nhánh** thì chạy hai việc dưới đây.

**Mục 1 (L1) không cần máy công ty:** job CI `db (L1)` có `redis:7-alpine` và chạy đúng các ca này. Coordinator push nhánh → CI xanh là bằng chứng (review F3 TB-1). Máy công ty chỉ cần nếu CI không chạy được.

Máy nhà đã chạy L0 (6 suite, 68 pass, 11 skip L1), tsc 3 project và `verify:map`.
Máy nhà KHÔNG có Postgres/Redis và không dựng docker, nên hai việc này chưa chạy lần nào.

## 1. L1 trên Redis thật (bắt buộc trước khi gộp)

```
npm run verify:up
npm run verify:db
```

Muốn chạy riêng suite circuit breaker thì dùng lệnh dưới (stack hubv phải đang chạy, URL lấy từ `.env.hubv`, đừng in ra):

```
RUN_DB_TESTS=1 REDIS_URL=<redis hubv> npx jest --maxWorkers=1 apps/hub-worker/test/circuit-breaker.spec.ts
```

**Tiêu chí ĐẠT:** `verify:db` xanh, và trong `apps/hub-worker/test/circuit-breaker.spec.ts` các ca sau đều pass:

- **`[BP:T16] (phần c)`**, lưu lượng đều 100 rps:
  - giây 0–179 có `ok` bằng đúng trần 2,4,8,16,32 rồi 64;
  - từ giây 180 trở đi `ok` = 100 và không còn `rampCap`;
  - mọi lần gia hạn có hạn ≤ rampStart + 180 s;
  - khoá hết trong khoảng (rampStart + 179 s, rampStart + 180 s];
  - lưu lượng 10 rps thì không gia hạn lần nào và khoá hết đúng ở 70 s.
- **`F3 (ADR-232 + ADR-241)`**, 500 hàng:
  - mô hình dồn 1 giây/vòng ra `[2,4,8,16,32,64,64,64,64,64,64,54]`, xả hết ở +110 s;
  - mô hình rải 2 giây/vòng ra `[2,2,4,4,8,8,16,16,32,32,64,64,64,64,60,60]`;
  - không giây nào vượt 64.
- **`[BP:T16] (phần d)`** (review F3 TB-1), Lua thật với `DELIVERY_RAMP_STEP_SECONDS=1`, 100 rps đều:
  - trần 2,4,8,16,32 rồi 64 (không vượt 64);
  - không giây nào PTTL bị rút ngắn (guard `ext > PTTL`), lần gia hạn đầu ở giây 50;
  - khoá hết trong (rampStart + 179 s, rampStart + 180 s];
  - `:ramp` hỏng giá trị → `{CLOSED, failures: 0}`, không ramp.
- Các ca L1 cũ vẫn xanh: `[BP:T15] (phần c)`, `[BP:T16] (phần a)`, LUA_GATE trên Redis thật.

Nếu ca dồn 1 giây/vòng đỏ ở đúng giây vừa gia hạn, nghi ngay `PTTL` trong Lua: script chỉ gia hạn khi `ext > PTTL`. Còn test dựa vào việc PTTL tăng để biết đã gia hạn.

## 2. Chaos T16 (L3, khoảng 12–15 phút)

```
npm run verify:chaos -- --tag bp-t16
```

Nếu runner không nhận tag `bp-t16` qua `verify:chaos`, dùng lệnh này:

```
npm run verify:chaos:bp -- --tag bp-t16
```

**Tiêu chí ĐẠT** (`chaos-bp-T16.json` + log):

- Tiền đề:
  - đúng 500 delivery hoãn, 0 SUCCEEDED lúc đích sống lại;
  - worker không khởi động lại.
- **Mới:** khoá `:ramp` không sống quá 180 s kể từ rampStart (`rampLenMs` ≤ 181 000).
- Không giây nào trong ramp vượt trần (2..64, rồi giữ 64 tới khi khoá hết hạn).
- **Sau ramp:** không giây nào > 64/s. Đây là tiêu chí F3 từng trượt với 149/s; ADR-241 đặt ra để sửa đúng chỗ này.
- 500/500 SUCCEEDED, 0 DEAD, 0 trùng.

Ghi kết quả vào hai chỗ:

- `CHAOS-BP-KET-QUA.md`, mục T16 / F3;
- dòng "Đo lại" ở cuối ADR-241 (`docs/adr/README.md`).

Nếu T16 PASS, tách kịch bản khỏi trạng thái "đỏ có chủ đích" (nợ Thấp #7).
