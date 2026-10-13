# REVIEW BP6 — `3777547..b44304b` (`56fa384` fix + `b44304b` docs)

Reviewer độc lập, 2026-10-13. Chỉ đọc.
- Đã `git fetch`; HEAD = origin/feat/bp = `b44304b`, đang ở nhánh `feat/bp`.
- `b44304b` đã commit luôn các file `REVIEW-BP1..5.md`. Nội dung khớp bản tôi viết.

## Kết luận: **ĐẠT**

Không có lỗi mức Cao hay Trung bình. Có 5 mục mức Thấp, đều là chỉnh câu chữ trong tài liệu.

## Đã chạy

- `npx jest apps/hub-worker verify/test/bp-docs-sync.spec.ts verify/test/gates.spec.ts`: 246 test qua.
- `tsc` hub-worker: sạch.
- `verify:map`: 400 mã, 335 có test, 0 mồ côi, 0 ma, 0 trùng. Đã `git checkout docs/TEST-MAP.md`.
- `verify:gates`: 20 luật, 0 vi phạm.

## 1. Code `56fa384` — đạt

- **Bỏ bí mật trước khi publish:** `deadLetterUnparsable` (delivery.consumer.ts:91-112) xoá `config`, `signingSecret`, `event`. Đây đúng là ba trường bí mật / dữ liệu của message kiểu cũ (`git show 6bc5773:libs/common/src/types.ts`; `destinationType` không phải bí mật).
- **Thứ tự publish/ack:** publish xong mới ack. Publish ném lỗi thì không ack và không nack, để RabbitMQ giao lại.
- **Nhánh `spill` của BP5** đi cùng hàm này, nên không còn `nack(false)` vứt message.
- **Tín hiệu áp lực ngược:** `handle` trả `'unknown'`, nên không ghi tín hiệu cho bộ điều khiển. Đúng §7.2.
- **Test** kiểm đủ các ý trên: không có secret trong bản sao, thứ tự `publish < ack`, đường spill, và nhánh publish ném.

## 2. Docs khớp code — kiểm 12 khẳng định

| # | Khẳng định | Kết quả | Chứng cứ |
|---|---|---|---|
| 1 | 17 bảng mang `tenant_id` | Đúng | Đếm `@map("tenant_id")` trong `schema.prisma`: 17 model, đúng danh sách |
| 2 | RLS FORCE trên 17 bảng (14 + 3 bảng con) | Đúng | Migrations: 6 + 2 + 2 + 4 bảng có tenant, cộng `raw_events`, `source_secrets`, `delivery_attempts`; không có `DISABLE` hay `NO FORCE` |
| 3 | `provider_enum` có 6 giá trị | Đúng | schema.prisma:13-20 |
| 4 | Grafana 10 panel | Đúng | `webhook-hub.json`: `panels.length = 10` |
| 5 | 13 luật = 9 evaluator + 4 theo sự kiện | Đúng | `ALERT_RULES` có 13 khoá; 3 `project.storage_*` + `hub.storage_near_full` có `driver: 'event'` |
| 6 | §3.1 bước 1b: không có adapter → 400 trước khi chạm Postgres | Đúng | ingest.service.ts:335-355 |
| 7 | Shop ~600 dòng | Đúng | Gate `shop-size` dùng ngưỡng ≤ 600 (verify/lib/gates.ts:322-328) |
| 8 | Polling theo `poll_seq`, `cursor` là chuỗi | Đúng | service-resources.controller.ts:326-372 |
| 9 | Jitter: relay ±100ms, sweeper ±10s, cleanup ±10% | Đúng | outbox.relay.ts:74; delivery.sweeper.ts (±10s); cleanup.job.ts:349 |
| 10 | Tầng retry có TTL cố định 10s / 1m / 5m / 30m / 2h | Đúng | topology.ts:52-56 |
| 11 | CLAUDE.md: "đường hoãn/throttle/ramp ≤ 1 lệnh, **0 truy vấn DB**" | **Sai một nửa** | Throttle/ramp: đúng. Hoãn vì circuit: vẫn **ghi** `next_attempt_at` thưa (≤ 1 lần / 2 phút, F7). Xem TH-1 |
| 12 | Upstash "≤ 50 lệnh / delivery" khi đích chết | **Hơi lạc quan** | Tính lại bên dưới, xem TH-2 |

Tính lại mục 12 cho một lần thử:
- Khoảng 7 vòng 5m: 7 lệnh EVAL.
- 1 lần quá trần: 1 EVAL + 1 PUBLISH realtime.
- Thêm 1–2 vòng 1m trong các khoảng HALF_OPEN, chưa kể lần giành probe.
- Tổng ≈ 9–11 lệnh mỗi lần thử, × 6 lần thử ≈ **55–65 lệnh** (≈ 11–13% quota cho 1.000 delivery).
- Bậc độ lớn và kết luận (giảm khoảng 3 lần so với trước BP) vẫn đúng.

Ngoài ra, §5.4e (ARCHITECTURE.md:161) viết "dùng chung normalize + delivery … 1 message / 5s". Câu này chưa nói rõ là **mỗi lane một semaphore, dò 1 message / 5s mỗi lane**, trong khi bảng ngay bên dưới đã ghi đúng. Xem TH-3.

## 3. ADR-192 — không có lỗ BB-5; danh sách thiếu một mục

Tôi tự grep `(prisma|tx|this.db|client).(… $queryRaw|$executeRaw|$transaction|<model>.<op>)` trên `apps/hub-*/src`.

- **Mọi chỗ ADR liệt kê** (outbox, processed_messages, `rawEvent`/`deliveryAttempt` trong `tenantTx`, `systemTx`, `$transaction` gom transaction, health) đều khớp số dòng.
- **Thiếu `FlowScopedRepository`** (`apps/hub-api/src/modules/flow/flow.repository.ts`: 9 `$queryRaw` và 4 `findMany`/`findFirst` qua `this.db`).
  - Không phải lỗ BB-5: đây là lớp con của `TenantScopedRepository`, nằm trong danh sách cho phép của gate `repo-subclass` (ADR-100).
  - Mọi câu đều lọc `tenant_id = this.tenantId`; với `raw_events` thì lọc `sources.tenant_id`. Đã đọc :31, :39-42, :119-212, :227-293.
  - Mẫu grep của ADR (`prisma|tx`) không bắt được `this.db.`, nên ADR không thể tự nhận là "chính xác". Xem TH-4.
- **Các escape hatch trong `libs/database/src/prisma.service.ts`** (`findSourceBySourceKeyForIngest`, retention, operator…) nằm ngoài phạm vi grep `apps/`. Nên ghi một câu là chúng nằm ở đâu.
- **RLS bảo vệ thật** cho `raw_events` và `delivery_attempts` khi ghi trong `tenantTx`:
  - Policy có `WITH CHECK EXISTS (bảng cha)`, mà bảng cha cũng có RLS theo `app.project_id` (rls_hub_app migration:59-70).
  - `tenantTx` đặt `app.project_id`.
  - Ở deployed, các tiến trình con chạy bằng role `hub_app` (hub-all D-5), không phải owner `BYPASSRLS`.
- **Không thấy chỗ nào** chạm bảng nghiệp vụ có tenant mà không đi qua repo, `tenantTx` hoặc `systemTx`.

## 4. `[BP:T23]` — đạt

- **Cách lấy file:** dùng `git ls-files docs apps libs CLAUDE.md` (md/ts/tsx/js), nên không giòn theo đường dẫn.
- **Cách khớp:** regex `jitter\s*±\s*20\s*%`. Chính file test nằm ở `verify/` nên không tự khớp.
- **Kiểm cấu trúc:** test kiểm thêm §5.4c (3 dòng mới), dòng jitter ở §4, tiêu đề §5.4e và câu trong CLAUDE.md. Các kiểm này bám theo tiêu đề nên hơi giòn, nhưng là chủ đích: giấy phải khớp code.
- **`docs/TEST-MAP.md`** sinh lại không chứa tiêu đề test, nên không tự làm đỏ.
- **Hai loại trừ hợp lý:**
  - `docs/adr/README.md` là append-only; ADR cũ ghi "jitter ±20%" là lịch sử.
  - `_bmad-output/` trích nguyên văn phụ lục.

## 5. `TRA-LOI-JITTER.md` — đúng sự thật

Từng ý đều có chứng cứ trong code:
- TTL cố định theo queue (topology.ts).
- RabbitMQ chỉ cho message hết hạn ở đầu queue, nên TTL theo từng message gây head-of-line blocking.
- Slow-start 2 → 64 rps trong 60s, phần vượt vào `retry.10s` và không ghi DB (`LUA_GATE`, T15/T16).
- OPEN 60s → 300s (ADR-197). Áp lực ngược cho DB (ADR-200).
- Jitter thật có ở các nhịp nền: relay ±100ms, sweeper ±10s, cleanup ±10%.

Không hứa điều nào mà code không làm.

## 6. CLAUDE.md — đạt

- `git diff` chỉ đổi **đúng 2 dòng**: dòng R1 (thêm đường hoãn) và dòng trạng thái 10-11 (`poll_seq`/`cursor`).
- Năm bất biến, quy tắc code và cạm bẫy không bị đụng.

## Phát hiện

### Thấp

- **TH-1** (CLAUDE.md:62): "**0 truy vấn DB**" sai với nhánh hoãn vì circuit, vì nhánh này vẫn ghi `next_attempt_at` thưa.
  - Sửa: "≤ 1 lệnh, 0 truy vấn **đọc** (hoãn circuit ghi `next_attempt_at` thưa ≤ 1 lần/2 phút)".
  - Test T23 đang khớp đúng chuỗi cũ, nên phải sửa cả test.
- **TH-2** (DEPLOYMENT.md:366): "≤ 50 lệnh" → nên ghi "≈ 50–65 lệnh". Lý do: chưa tính PUBLISH ở lần quá trần, các vòng 1m trong HALF_OPEN và lần giành probe. Con số 1.000 delivery ≈ 11–13% quota.
- **TH-3** (ARCHITECTURE.md:161, §5.4e): nói rõ "một factor, mỗi consumer một semaphore (20); chế độ dò 1 message / 5s **mỗi lane**" để đoạn văn khớp với bảng và code sau review BP5 lượt 1.
- **TH-4** (ADR-192): bổ sung `FlowScopedRepository` (lớp con của repo, ADR-100) và một câu về các escape hatch trong `PrismaService`. Mở rộng mẫu grep thêm `this.db.`.
- **TH-5** (`56fa384`): message không phải JSON được giữ nguyên byte khi đưa vào DLQ. Một message kiểu cũ bị cắt cụt (JSON hỏng) có thể còn chuỗi secret trong đó. Ca này rất hiếm; muốn chặt thì thay byte thô bằng `{"unparsable": true, "bytes": n}`.
