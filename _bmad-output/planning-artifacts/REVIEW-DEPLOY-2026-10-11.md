# Review triển khai (2026-10-11)

## hub-all: `18b5d4c` (ADR-129), hub-api + hub-worker chung một container Render free

> Review chỉ đọc. Source không sửa gì. Không đọc `.env`, `.env.deploy.local` hay `KEYS-CAN-LAY.md`.
> hubv dựng lại từ HEAD (`verify:reset`), rồi chạy `scripts/hub-all-e2e.sh`. Script này tự trả hubv về hai service; đã xác nhận `hubv-hub-api-1` và `hubv-hub-worker-1` cùng chạy sau đó.

### 1. Bộ kiểm

| Lệnh | Kết quả |
|---|---|
| `npm run verify` | L0 **648/0/0** · L1 **144/0/0** · map 259 mã · 0 mồ côi · 0 ma · 0 trùng |
| `verify:gates` | 14 luật · 0 vi phạm |
| `bash scripts/hub-all-e2e.sh` | **HUB-ALL E2E OK** (chi tiết ở mục 2) |

### 2. Kết quả e2e (image thật, Linux, `mem_limit: 512m`)

| Bước | Kết quả |
|---|---|
| Spec supervisor HA1–HA3 trong `node:22-alpine` (tín hiệu POSIX thật) | 3/3 |
| Tiến trình trong container | PID 1 = `node docker/hub-all.js`, cộng **2** tiến trình con `--max-old-space-size=200` (api) và `=220` (worker). BB-4 giữ được: hai process, hai pool, hai AMQP connection |
| RSS lúc tải nhẹ | supervisor 51 MB · api 116 MB · worker 116 MB. `docker stats`: **118,6 MiB / 512 MiB** (23 %, cgroup tính trang dùng chung một lần) |
| Smoke + Shop: tạo đơn → SePay | smoke OK · đơn → **PAID** (worker trong container giao được) |
| `kill -9` tiến trình worker | supervisor gửi SIGTERM cho api, thoát `1`, **RestartCount 0 → 1**, `/health` lên lại |
| `docker stop` (SIGTERM) | dừng trong **1 s**, ExitCode **0**. Worker `code=0` (drain gọn); **api `signal=SIGTERM`** (xem D-2) |

### 3. Đối chiếu từng điểm được giao kiểm

| Điểm | Đánh giá |
|---|---|
| Chuyển tín hiệu | SIGTERM/SIGINT → `stopAll` gửi cho cả hai con. Quá `SHUTDOWN_TIMEOUT_MS` (25 s) thì SIGKILL rồi thoát 1, vẫn dưới mốc ~30 s của Render ✓ |
| Zombie / orphan | Con là `node` chạy trực tiếp; Prisma dùng engine dạng thư viện nên không có tiến trình cháu. Node làm PID 1 không reap cháu, nhưng ở đây không có cháu ✓ |
| Mã thoát | con chết ngoài ý muốn (kể cả thoát `0`) → thoát 1 để Render khởi động lại. Dừng theo yêu cầu: thoát 0 nếu cả hai về gọn (`143`/`130`/tín hiệu được chấp nhận), thoát 1 nếu phải SIGKILL ✓ |
| Hai con chết cùng lúc | con đầu kích `stopAll`; `kill` lên con đã chết thì vô hại; `finish` chạy một lần (cờ `finished`) ✓ |
| Lỗi spawn | sự kiện `error` → đánh dấu exited, `failed`, dừng hết ✓ |
| Crash loop ở prestart | `set -e`: migrate lỗi → container thoát ≠ 0 → Render khởi động lại theo backoff của nó. Không có trạng thái nửa sống ✓ |
| Migrate chạy hai lần / đua | `hub_prestart` chạy **một lần** trước `exec node docker/hub-all.js`; con chạy thẳng `dist/main.js`, không qua entrypoint. Khi deploy chồng (container cũ và mới cùng sống), `prisma migrate deploy` có advisory lock riêng ✓ |
| Log | ghi theo **dòng** (readline) nên không trộn giữa dòng. JSON giữ nguyên, thêm `proc`. Xem D-1 (giả trường) và D-4 (backpressure) |
| `connection_limit` | `new URL` + `searchParams.set`: **thay** giá trị cũ (`=1`), giữ `pgbouncer=true`, `sslmode`, `schema`, `pool_timeout` (đã thử với chuỗi kiểu Neon). Mật khẩu có ký tự đặc biệt được percent-encode, Prisma giải mã lại như cũ. Parse lỗi → giữ URL gốc. **Không bao giờ log URL** ✓ |
| Heap so với 512 MB | 200 + 220 MB old-space là **trần**, không phải mức dùng. Lúc nhẹ cả container 119 MiB. Chưa đo dưới tải (D-3) |
| Compose local | `docker-compose.yml` **không đổi** ở commit này (lần sửa cuối là `8afb866`). Local và hubv vẫn hai service (BB-4). Biến thể all-in-one chỉ nằm ở `docker-compose.verify-allinone.yml` (worker đặt `profiles: ["two-services"]`) ✓ |
| Runbook §3 | Đúng: `DIRECT_URL` = owner (container này chạy migrate), `DATABASE_URL` = `hub_app` cho cả hai con, supervisor ghi đè `connection_limit`, `SHUTDOWN_TIMEOUT_MS=25000`, danh sách **KHÔNG đặt** (`HUB_APP_DB_PASSWORD`, `RUN_SEED`, `*_FAKE_*`, `GITHUB_OAUTH_BASE_URL`…) ✓ |
| Bí mật trong runbook | Quét `HUONG-DAN-DEPLOY.md` và `docs/DEPLOYMENT.md` (chuỗi kết nối có mật khẩu, `GOCSPX`, `ghp_`, `re_…`, hex ≥ 40, `AIza`): chỉ có **placeholder** (`rediss://default:...@...`, `amqps://user:pass@xxx`) ✓ |

### 4. Phát hiện (không có mức Cao)

- **D-1 · Thấp · tiến trình con giả được trường `proc`.**
  - `docker/hub-all.js:35`: `{ proc: tag, ...JSON.parse(line) }`. Spread đứng **sau** nên trường `proc` của dòng log con ghi đè nhãn.
  - Đã thử: con in `{"proc":"supervisor","msg":"spoof"}` thì ra nguyên `"proc":"supervisor"`.
  - Chỉ xảy ra khi code ghi log một object có khoá `proc` ở mức trên cùng. Không phải dữ liệu người dùng trừ khi có chỗ log nguyên object bên ngoài.
  - Sửa: `{ ...JSON.parse(line), proc: tag }`.
- **D-2 · Thấp (có từ trước) · hub-api không drain khi SIGTERM.**
  - Log dừng cho thấy `api thoát (code=null, signal=SIGTERM)`: hub-api không bắt SIGTERM (không có `enableShutdownHooks` hay handler trong `apps/hub-api/src/main.ts`), nên chết ngay. Worker thì drain đúng (`code=0`).
  - Request ingest đang dở bị cắt **trước** khi trả 2xx, provider sẽ gửi lại. BB-3 vẫn an toàn và chống trùng đã có ở BB-2, nên không mất sự kiện.
  - ADR-129 và runbook ghi "cả hai drain" là chưa đúng với api.
  - Sửa: `app.enableShutdownHooks()` + `server.close()` trong hạn, hoặc sửa câu chữ.
- **D-3 · Thấp · chưa đo bộ nhớ dưới tải.**
  - Hai trần heap cộng lại 420 MB, thêm 2 runtime, engine Prisma và supervisor (~51 MB), nên trong trường hợp xấu RSS có thể chạm 512 MB và Render giết vì OOM. Mức đo được lúc nhẹ là 119 MiB.
  - Nên chạy `k6` (local, ADR-019) vào biến thể all-in-one và ghi đỉnh `docker stats` vào ADR-129. Nếu đỉnh > ~400 MiB thì hạ trần heap (vd 160/180).
- **D-4 · Thấp · supervisor bỏ qua backpressure** (`out.write` không chờ `drain`).
  - Khi stdout chậm (Render log), dòng log dồn trong RAM của supervisor, không có giới hạn. Mức log hiện tại nhỏ nên rủi ro thấp.
- **D-5 · Thấp · cả hai tiến trình con kế thừa toàn bộ env, kể cả `DIRECT_URL` (owner).**
  - Runtime chỉ cần `DATABASE_URL` (`hub_app`). Lộ `DIRECT_URL` trong env của worker làm rộng bề mặt nếu bị RCE (vượt RLS).
  - Sửa: supervisor xoá `DIRECT_URL` (và `HUB_APP_DB_PASSWORD` nếu có) khỏi env của hai con, vì migrate đã chạy xong trước đó.
- **D-6 · Thấp · thời hạn trùng nhau.**
  - Supervisor và con đều đọc cùng `SHUTDOWN_TIMEOUT_MS=25000`. Con nào dùng hết 25 s sẽ bị supervisor SIGKILL đúng lúc đang kết thúc.
  - Sửa: cho con hạn thấp hơn, vd 22 s, hoặc supervisor dùng 27 s (vẫn < 30 s).
- **Tài liệu:** `HUONG-DAN-DEPLOY.md` §3 dòng 19 có lỗi định dạng Markdown (`hub*app`, `PAYOS*_`, `NEXT*PUBLIC*\*`). Người làm theo dễ chép sai tên biến; nên đặt các tên biến trong backtick.

### 5. Kết luận

**ĐẠT. Push được.**
- Supervisor đúng ở các nhánh quan trọng: chuyển tín hiệu, không để nửa sống, mã thoát, SIGKILL trước mốc 30 s.
- Migrate chạy một lần. `connection_limit` được ghi đè an toàn và không lộ URL.
- BB-4 giữ nguyên (hai tiến trình; compose local không đổi). Runbook đúng về `DIRECT_URL`/`hub_app` và không chứa bí mật.
- Sáu điểm Thấp (D-1..D-6) không chặn deploy. Nên làm sớm D-5 (bỏ `DIRECT_URL` khỏi env của con) và D-3 (đo RAM dưới tải). D-2 là chuyện cũ của hub-api, chỉ cần sửa câu chữ ADR nếu chưa làm drain.
