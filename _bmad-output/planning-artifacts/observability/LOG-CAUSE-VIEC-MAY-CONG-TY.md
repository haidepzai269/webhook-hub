# Bàn giao: giám sát + log có nguyên nhân (2026-10-18) — việc cho máy kia

Phiên này (máy nhà) dừng giữa review lần 2 của giai đoạn 2A theo yêu cầu Admin. Máy kia đọc file này rồi làm tiếp.
Luật giữ nguyên: coordinator KHÔNG tự code — code giao agent dev (Sonnet), xong giao agent review Sonnet RIÊNG, lặp tới ĐẠT;
gitleaks v8.18.4 qua trước push (bước riêng); commit theo path; không chạm hạ tầng thật khi chưa hỏi Admin.

## Đã xong và đã vào `master`

| PR | Nội dung | ADR |
|---|---|---|
| #11 | `/health/live` (không I/O) + `/health/ready` (Postgres cứng; Redis/RabbitMQ mềm → 200 `degraded`), heartbeat hub-worker, `HEARTBEAT_URL` | 248 |
| #12 | Dockerfile mặc định không build `apps/web` (Render OOM 8GB ở `next build`); `BUILD_WEB=1` chỉ cho compose `web` | 253 |
| #13 | Bộ theo dõi hạ tầng LOCAL (`docker compose --profile monitoring up -d`), 32 luật, Watchdog, dashboard "Hạ tầng"; thiết kế log/Sentry (`docs/LOGGING.md`) | 249–252 |

Production (Render) đã kiểm: `/health/live` 200. Render Health Check Path = `/health/live`. `HEARTBEAT_URL` đã đặt trên Render,
Healthchecks.io check `hub-worker` Up, ping mỗi phút, kiểu Cron `*/5 7-22 * * *` (Asia/Ho_Chi_Minh).

## Đang dở: nhánh `feat/log-cause` (giai đoạn 2A — log tự nói nguyên nhân), CHƯA PR

Spec: `docs/LOGGING.md` (§10 kế hoạch, §12 trạng thái/lệch), ADR-250, ADR-254, ADR-255.
Commit: `2bcaa70` (libs/common causes/slow-thresholds/trace-context/log-line) · `cca10e5` (ingest.done mọi đường kể cả từ chối,
traceparent vào outbox, `x-hub-cold`, `exposedHeaders`) · `618bc5b` (relay đóng dấu publish, normalize.done, delivery.attempt,
replay = trace mới) · `cda2d30` (growth.window 60s, cause cho circuit/alert/storage, event-loop, metric nhãn cause) ·
`5f1f806` (docs, ADR-254/255) · `52a8d7e` (sửa theo review lần 1) · + merge `master`.

Admin đã chốt 8 quyết định: trace_id = correlationId bỏ `-`; lấy mẫu thành công 10% deployed; ngưỡng chậm 500ms/3s/5s;
replay = trace mới + `replayOf`; tắt Session Replay; một công cụ Sentry cho lỗi+vitals; `x-hub-cold`; tracesSampleRate web 0.1.
Vercel Hobby: hub KHÔNG tính thương mại.

### Review lần 1: CHƯA ĐẠT → đã sửa ở `52a8d7e`
- M-1 không test khoá "/hooks luôn sinh trace mới" → thêm 7 test.
- M-2 logger chỉ scrub chuỗi cấp 1; `storeRejected` log Error thô → `scrubDeep` trong pino `formatters.log` + `errInfo`.
- m-1 `clean()` giữ `user:pass@` của URL → cắt. m-2..m-6: test trần baseline growth-window, replay UUID ở api.controller,
  siết regex penalty, 503 thống nhất requestId + `Retry-After: 5`, ADR-254 bổ sung.
- Dev báo: 87 suite / 779 test xanh, 0 đỏ, tsc sạch; mutation R1–R5 đỏ đúng. **Dev KHÔNG chạy lại toàn bộ apps/hub-api.**

### VIỆC 1 — review lần 2 (bị dừng giữa chừng, làm lại từ đầu bằng agent review MỚI)
Kiểm `52a8d7e` độc lập, chỉ đọc + mutation an toàn (cp bản gốc + sha256, khôi phục, `git status` y như trước):
1. M-1, M-2, m-1..m-6 thật sự đóng; chạy lại mutation "trustTraceparent → true" và "tắt trần baseline" phải ĐỎ.
2. `scrubDeep` là code MỚI trên mọi dòng log: (a) vòng tham chiếu có treo/stack overflow? (b) Error/Buffer/Date/Map/Set/Prisma
   error xử lý ra sao — mất `err.code`? Buffer thành mảng số khổng lồ? (c) chi phí: micro-bench 100k dòng trước/sau;
   (d) phần vượt trần 8 cấp/60 phần tử/200 khoá bị BỎ hay GIỮ (giữ = secret lọt).
3. Hai chỗ dev cố ý không đổi: `{ error: err.message }` ở ingest (provider không đăng ký) và 2 `err.message` ở normalize.consumer.ts.
4. `x-request-id` client gửi có được validate (độ dài/ký tự) trước khi phản chiếu vào body 503 và log không (log injection).
5. Chạy toàn bộ `apps/hub-api/test` (trừ *-db nếu không có DB) + `apps/hub-worker` + `libs/common`; spec *-db nên chạy với
   Postgres (stack hubv) — lần review trước không chạy được.

### VIỆC 2 — đo k6 p95 ingest trước/sau log (LOCAL, không qua tunnel — CLAUDE.md cạm bẫy #5)
So `master` (trước 2A) với `feat/log-cause`. pino ghi đồng bộ + scrubDeep trên đường nóng chưa từng đo. Ghi số vào LOGGING.md §6.
Lưu ý: lỗi phía đích (`fail.dest_*`) cố ý không gộp → đích hỏng 1000 evt/s = 1000 dòng/s ở worker; xem có ăn hạn mức log Render không.

### VIỆC 3 — mở PR `feat/log-cause` → `master` sau khi ĐẠT + gitleaks.

## Việc kế tiếp (theo thứ tự)
4. Nối Telegram vào Alertmanager LOCAL: `infra/alertmanager/alertmanager.yml` dùng `telegram_configs` + `bot_token_file`
   (mount `/etc/alertmanager/secrets`, file token gitignored). Bot đã thử gửi được: `@webhook_hub_api_bot`, chat riêng.
5. Giai đoạn 2B — Sentry backend (LOGGING.md §11, ADR-251): một cửa `reportUnexpected`, chỉ `blame=hub`, `beforeSend` scrub,
   fingerprint + trần `SENTRY_MAX_PER_MIN`. MỘT project Sentry dùng chung cho hub-api + hub-worker (DSN giống nhau, phân biệt
   bằng thẻ `svc`) — lệch nhẹ so với ADR-251 (tách DSN), ghi ADR. Region EU.
6. Sentry frontend `apps/web` (ADR-252): Session Replay TẮT; console đọc `x-hub-cold`; `global-error.tsx`. Bước 11 console:
   `cause`/`blame` vào `StageReason`, waterfall từ `stage_ms`.
7. Worker tự báo Telegram khi Neon/Upstash gần trần (gói free không có cảnh báo của nhà cung cấp).

## Key — KHÔNG có trong git
`KEYS-CAN-LAY.md` nằm trong `.git/info/exclude` ở máy nhà, chứa secret thật. Đã có: `SENTRY_DSN_HUB_API/WORKER` (cùng giá trị),
`HEARTBEAT_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Máy kia cần thì Admin tự chép (không qua git/chat).
`HEARTBEAT_URL` chỉ đặt trên Render, KHÔNG đặt `.env` local (worker local ping sẽ che worker production chết).

## Ghi chú máy
Ổ C: máy nhà đã nén VHDX Docker 18/10 (13 → 39,8 GB trống). Cách nén: `docs/MONITORING.md` §5.
