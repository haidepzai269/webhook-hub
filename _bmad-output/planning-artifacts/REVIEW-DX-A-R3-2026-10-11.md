# Review DX-A — vòng 3 (phạm vi hẹp) — 2026-10-11

**Phạm vi:** `1d42325` (R2-M1: `ORCHESTRATED_METHODS` trong proxy `scopeToTenant`), `dc55957` (SDK `parseRetryAfter`, CLI kẹp 1–30 s, `--from latest` bỏ cuộc sau 10 lần), `56acbd7` (ADR-145, ARCHITECTURE §18, RESUME-dx).
Chỉ review nội dung ĐÃ COMMIT (`git show`). WIP chưa commit của KN trong `tenant-scoped.repository.ts` là phần thêm thuần (addSourceSecret, *SourceConnection), không đụng proxy hay polling.

## Kết luận: **GO-with-fixes** — không có Blocker/High

R2-M1 đã sửa đúng: mỗi `assignPollSeq` / `hasUnassignedPollSeq` / `maxPollCursor` đi qua proxy nên mỗi lời gọi là một tx riêng (`set_config app.project_id` + advisory lock theo tenant, commit ngay). Đã chạy bằng `hub_app` (RLS bật): xanh. Còn một Medium: bất biến "phương thức điều phối không được đụng `this.prisma`" mới chỉ nằm trong comment, chưa có test hay gate nào giữ.

## Bằng chứng đã chạy

| Kiểm tra | Kết quả |
|---|---|
| Role của `DATABASE_URL` (lấy qua `verify/lib/compose.hostUrls()`, hubv :15433) | `current_user=hub_app, rolsuper=false, rolbypassrls=false` |
| `RUN_DB_TESTS=1 jest polling-db.spec.ts polling-commit-order-db.spec.ts` (app = hub_app, fixture = owner) | 2 suite · 10/10 test xanh, có test R2-M1 tiến độ `[5,3,1]` |
| `jest libs/hub-sdk` (listen/sdk/trigger) + `redis-budget.spec.ts` + `polling-params.spec.ts` | 5 suite · 39/39 xanh |
| `npm run verify:gates` | 14 luật · 0 vi phạm · 7 ngoại lệ có lý do |
| `tsc --noEmit -p apps/hub-api/tsconfig.json`, `-p libs/hub-sdk/tsconfig.json` | exit 0 (cây làm việc = HEAD + WIP KN chỉ thêm, không sửa) |
| Thăm dò RLS: `hub_app` truy vấn `hub.events` KHÔNG đặt `app.project_id` | `count=0`, `max(poll_seq)=NULL` — đóng an toàn (fail-closed), không lỗi |

## Phát hiện

| # | Mức | Vấn đề | Đề xuất |
|---|---|---|---|
| R3-M1 | **Medium** | **Bất biến của `ORCHESTRATED_METHODS` không có gì giữ.** Proxy trả về phương thức đã `.bind(receiver)`; bên trong, `this.prisma` (thuộc tính, không phải hàm) đi qua nhánh `typeof value !== 'function'` → **client gốc, chưa set `app.project_id`**. Code hiện tại đúng (chỉ gọi 3 phương thức repo), nhưng chỉ cần ai đó viết `this.prisma.$queryRaw` trong `latestPollCursor` hoặc thêm một tên vào tập này là hỏng. Hậu quả khi chạy bằng `hub_app`: RLS đóng an toàn nên **không lộ chéo tenant** (BB-5 vẫn giữ nhờ lọc `tenant_id` ở tầng app + RLS), nhưng **sai mà không báo**: truy vấn ra 0 dòng / `max=NULL`. Ví dụ `max` → `0n` → `after=latest` trả cursor 0 → `listen` dội lại toàn bộ lịch sử. Trên kết nối owner/superuser (test cũ, script) thì không có RLS chặn. Không gate grep nào (`verify/lib/gates.ts`) hay test nào nhắc tới `ORCHESTRATED`. | Thêm test unit (rẻ, không cần DB) trong `libs/database/test`: (a) export `ORCHESTRATED_METHODS`; với mỗi tên, `TenantScopedRepository.prototype[name].toString()` không được khớp `/this\.prisma\|\$queryRaw\|\$executeRaw\|\$transaction/`. (b) Kiểm tra lúc chạy: dựng repo trên client giả có `$transaction(cb)` đặt cờ `inTx`, mọi `$queryRaw`/`$executeRaw`/model trên client gốc thì **ném lỗi** nếu `!inTx`; gọi `latestPollCursor()` → không ném, và mỗi lời gọi con mở đúng một `$transaction`. Có thể làm thêm: trong proxy, khi chạy một phương thức điều phối thì thay `this.prisma` bằng một client "độc" (getter ném lỗi) để vi phạm lộ ra ngay lúc chạy, không phải 0 dòng im lặng. |
| R3-L1 | Low | Comment `LATEST_MAX_ATTEMPTS` ghi "≈ 40 s với backoff 1/2/5 s". Thực tế: controller trả `retryAfter: 1` → 9 lần ngủ × 1 s ≈ 9 s + thời gian request. 40 s chỉ đúng với 5xx không có Retry-After (1+2+5×7 = 38 s). | Sửa comment (≈ 10 s với 503 của `after=latest`, ≈ 40 s với 5xx không có Retry-After). |
| R3-L2 | Low | Trần bỏ cuộc: 10 request × (10 lô × 1000) ≈ 100k event tồn được cấp mỗi lần chạy `listen --from latest`. Project chỉ dùng push có backlog lớn hơn (vd sau k6 local) sẽ thoát mã 1. Không mất tiến độ (lô đã commit), chạy lại thì đi tiếp, và thông báo có `fix` rõ ràng. | Chấp nhận; nếu muốn thì ghi một dòng vào RUNBOOK/ADR-145 ("backlog > ~100k: chạy lại hoặc `--from <cursor>`"). |
| R3-I1 | Info | `maxPollCursor` giờ đọc NGOÀI advisory lock (tx riêng, sau lô cuối). Đã kiểm: vẫn đúng. Các lần gán bị tuần tự hoá bởi `pg_advisory_xact_lock` giữ tới COMMIT, và `nextval` tăng đơn điệu, nên thứ tự commit trùng thứ tự cursor. Lần gán nào không nằm trong snapshot của `max` sẽ commit sau và có cursor lớn hơn mọi giá trị đã thấy → không bỏ sót event commit sau lời gọi. Event mà một poller khác gán đúng trong khe hở có cursor ≤ max: event đó đã commit TRƯỚC khi `latest` trả về, nên coi là "lịch sử" là hợp lệ. | Không cần làm gì. |
| R3-I2 | Info | Gọi bên trong tx có sẵn: `grep` HEAD thấy chỗ gọi DUY NHẤT là `service-resources.controller.ts:327` qua `forTenant(tenantId)` với client gốc mặc định. Không có chỗ nào gọi trong `tx`. Nhánh tx có sẵn (đặt `app.project_id` một lần, các lô chung tx) đã được ghi trong ADR-145. | Không cần làm gì. |
| R3-I3 | Info | Gọi đồng thời: hai caller `latest` hoặc `latest` + `pollEvents` xen lô nhau dưới advisory lock. `hasUnassignedPollSeq` chỉ được kiểm khi lô cuối đầy; nếu caller khác đã cấp xong thì trả `max` (đúng). | Không cần làm gì. |
| R3-I4 | Info | CLI: `retryDelayMs` kẹp `[1 s, 30 s]` cho 429/503 có Retry-After. `parseRetryAfter`: header là chữ số → giây; HTTP-date → `ceil(Δ)` ≥ 0; header rác → lấy `retryAfter` của body. Chuỗi kiểu `"-1"`/`"1.5"` có thể bị `Date.parse` của V8 hiểu thành ngày quá khứ → 0 → kẹp 1 s (vô hại). Vòng `--from latest` đếm đúng: tối đa 10 request, lỗi không tạm thời thoát ngay, abort → 0. Vòng poll chính không giới hạn số lần nhưng luôn ngủ ≥ 1 s → **không có retry storm**. | Không cần làm gì. |
| R3-I5 | Info | Docs `56acbd7`: ADR-145 (vấn đề/chọn/đánh đổi) và ARCHITECTURE §18 khớp với code. | — |

## Việc cần làm trước khi đóng DX-A

1. R3-M1: thêm test hoặc guard cho `ORCHESTRATED_METHODS` (ưu tiên kiểm tra lúc chạy (b), vì nó bắt được cả khi viết thông qua helper).
2. R3-L1: sửa comment (tuỳ chọn).
