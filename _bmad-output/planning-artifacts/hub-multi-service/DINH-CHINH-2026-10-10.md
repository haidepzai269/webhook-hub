# Đính chính SPEC hub-multi-service sau đợt vá biên bản 9/10 (commit `0b2cef4`)

> Ngày 10/10/2026 tối, party mode (Winston, Amelia, John, Sally, Mary cùng Admin).
> **File này THẮNG** `SPEC-hub-multi-service.md` và `audit-fix-2026-10-10/SPEC-3-dung-chuan.md` ở mọi chỗ mâu thuẫn.
> Lý do tồn tại: SPEC S0–S14 viết **trước** khi đợt 9/10 code xong, nên bảng hiện trạng §3 đã cũ; SPEC-3 (của đợt 9/10) chưa làm và đâm vào S14.

---

## 🟢 00. MỞ LẠI ĐỢT ĐA SERVICE: Admin chốt (10/10 tối muộn). **§00 thắng §0**

> Admin: "phần auth … tạm wait, giữ nguyên context … Trước tiên các bạn đọc SPEC-hub-multi-service.md (S0–S14) … rồi giao 1 agent dev khác dev spec + 1 agent review sau khi xong."

**Thứ tự toàn dự án (mới):**
`SPEC-3 ✅ → VF1 → VF2 → VF7 (agent VF đang chạy) → ĐA SERVICE (file này) → review → AU1–AU6 (agent auth làm tiếp, khớp lại với code đa service) → VF3…`
Đây đúng là thứ tự SPEC-auth §8 và SPEC-verification §11 gợi ý. Nhờ vậy AU1 **không** phải tự tạo `projects`, và phần API key của AU4 **không** bị cắt (DINH-CHINH-AUTH §2 hết hiệu lực khi đa service xong).

**Phạm vi:** toàn bộ S1–S12 + phần còn lại của S14. S13 (RLS) **không làm ở đây**, vì AU6 thay nó. Bảng mới phải mang `tenant_id` đúng khuôn để AU6 bật policy được.

**Đã xong, không làm lại** (xem §2, §4):
- S0 (outbox `delivery.requested`, đợt 9/10). Chỉ còn kiểm luồng GitHub → shop.
- **Lõi S14**, dưới tên S3-2: catalog, validator, `normalized`, `data.raw`, 4 adapter, Shop đọc `payment.received`, metric `hub_normalize_schema_errors_total`, `docs/EVENT-CATALOG.md`, test U34–U45 và U50.
  **Còn lại của S14:**
  - `POST /events` kiểm 422 `schema_mismatch` (U49), làm ở S4;
  - `mapping` của GenericAdapter (U46–U48 + `diagnose` `mapping_field_missing`), làm ở S8/S9;
  - SDK re-export type, làm ở S11.
- Wildcard subscription (S3-3). S5 chỉ thêm `sourceIds`, khoá ngoại ghép, kiểm cùng project, và API `/v1/p`.

### 00.1 Xung đột đã soi lại (10/10 tối muộn) và cách xử lý

| # | Xung đột | Xử lý |
|---|---|---|
| X1 | Ngữ pháp wildcard: §4.6 cấm `*` đứng một mình, trả 422. S3-3 (Admin chọn theo SPEC-3) cho phép `*`, trả 400 | **Giữ S3-3**: `*` hợp lệ, dùng chung `libs/common/src/event-pattern.ts`. Route `/api/v1` trả 400, route `/v1/p` trả 422 (bảng lỗi của SPEC). U17/U19 sửa: `*` hợp lệ |
| X2 | S2 console admin (JWT env, `?projectId=` tuỳ chọn, mặc định `DEFAULT_TENANT_ID`) và SPEC-auth §2.3 (`?projectId=` bắt buộc + membership) | **Làm S2 đúng SPEC đa service** (admin env = operator/root theo ADR-056). AU3 sẽ thay guard sau. Gom việc đọc `projectId` vào **một chỗ** (decorator hoặc guard `ProjectScope`) để AU3 chỉ thay một chỗ. **Không** rải `req.query.projectId` khắp controller |
| X3 | §0 SPEC: luật dev cũ | Từ VF2, mọi story theo **SPEC-verification §6**: RED → GREEN → GATED → PROBED, commit có khối `Verify:` (`npm run verify -- --evidence`), mã test `[MS:U12]`/`[MS:T5]`. REVIEWED do phiên review làm |
| X4 | E2E T1–T15 ở §7.2 dùng `docker compose down -v` stack dev, curl `localhost:4000`, `scratch/echo.js` | DINH-CHINH-AUTH §8 #5/#6: E2E chạy trên **`hubv`** (cổng 14000), đích nhận thử là **sink** của VF1 (trả challenge, ghi lại request, `?mode=fail`/`?mode=slow`). Stack dev **không** `down -v` |
| X5 | Seed S12 (`cafe`/`bookstore`) và `verify:seed` | Gộp làm một (DINH-CHINH-AUTH §8 #4): `verify:seed` = seed S12 + phần riêng của verify |
| X6 | S11: Shop tự đăng ký endpoint | Seed **không** tạo endpoint Shop nữa, kể cả `verify:seed` (§8 #3). Compose tự seed (ADR-066) phải sinh key `shop` và truyền `HUB_URL` cho shop |
| X7 | Đường dẫn ingest | `/hooks/<provider>/<sourceKey>` (§8 #7) |
| X8 | Retention §4.10 | Giữ §3 file này: **không** xoá `raw_events` ACCEPTED. Orphans phải loại raw cũ hơn N ngày |
| X9 | Ngân sách Redis R1 (ADR-062/064): ≤ 4 cố định + ≤ 2/delivery | `ApiKeyGuard`, challenge, polling **không** chạm Redis. `POST /events` đi qua `persistAccepted`, nên giữ đúng số lệnh của `/hooks`. Thêm ca `/events` vào `redis-budget.spec.ts` |
| X10 | Header gửi đi: S6 bỏ `X-Hub-*` | Sửa luôn: Shop (S11), `scripts/e2e-smoke.sh`, k6, `apps/web` playground nếu có hiển thị. DoD grep theo §2 dòng 10 |
| X11 | S7 đổi nghĩa `after` của `GET /api/v1/events` | Sửa `apps/web/src/lib/hub/queries.ts` (`useEvents`) trong cùng commit. UI không được vỡ (§2 dòng 11) |
| X12 | Phiên party mode `webhook-hub-54` đang viết kịch bản Admin tự chạy cho đa service, dựa trên code thật | Hết mỗi story, ghi route, tên trường, mã lỗi **thật** vào §7 "Lệch / ghi chú" để phiên đó đối chiếu |
| X13 | Sau đa service, auth làm tiếp | Không đụng `apps/hub-api/src/modules/auth/*` ngoài phần S2/S3 cần. `ApiKeyGuard` dựng `request.principal = {kind:'key', tenantId, scopes}` (SPEC-auth §2.1) để `@RequireScope` sau này dùng chung cho user |
| X14 | ADR | Lấy số cuối bằng grep ngay trước khi ghi. Agent VF và phiên khác đang ghi song song |
| X15 | Kịch bản Admin tự chạy `verification/KICH-BAN-TEST-DA-SERVICE.md` (chạy trên `hubv`: API 14000, sink `http://sink:4100`, admin `VERIFY_ONLY_admin_password`) dựa trên 4 giả định | **Giữ đúng**, nếu lệch thì ghi §7: (1) `GET /api/v1/projects` trả mảng (hoặc `{items}`), mỗi phần tử có `id` và `slug`; (2) tạo key → `{id, key, connectionString}`; tạo endpoint → `{id, verification, signingSecret}`; tạo source → `{id, webhookUrl}`; (3) SSRF guard trên `hubv` cho phép `http://sink:4100` (IP private trong mạng docker) **chỉ ngoài production**; (4) `scripts/e2e-smoke.sh` chạy được với `HUB_URL=http://localhost:14000` và `PG_CONTAINER=<postgres của hubv>`, kể cả sau X10 |
| X16 | Một agent khác đang làm giao diện Event Flow (`event-flow-ui/SPEC-event-flow-ui.md`) trên nhánh worktree `feat/event-flow-ui`, sẽ rebase lên master sau đợt này | Phần web của đợt đa service chỉ sửa **tối thiểu cho khỏi vỡ** (X11). **Không** làm lại trang events, dashboard hay trace. Không đụng `libs/common/src/flow/**` và `apps/hub-api/src/modules/flow/**`. API mới giữ hình dạng ổn định để UI dùng: `verification`, `sourceIds`, `normalized`, `projectId` |
| X17 | Hợp đồng nối với UI Event Flow (`event-flow-ui/SPEC-event-flow-ui.md` §6A) | Ghi vào §7: tên **thật** của helper/guard đọc `projectId` (X2); tên mới của các hàm repo bị đổi; tên cột mới (`verification`, `verification_error`, `source_ids`, `normalized`, `seq`, `source_id`); giá trị enum mới (`api`, `generic`, `PENDING/VERIFIED/FAILED`). **Không** đổi tên hay xoá các cột và trạng thái delivery/attempt hiện có mà UI đang đọc (`status`, `attempt_count`, `next_attempt_at`, `circuit_state`, `duration_ms`, `response_*`). Nếu bắt buộc phải đổi thì ghi ADR và ghi §7 |

**Thứ tự làm (thay §5):**
`S0 (kiểm) → S1 → S2 → S3 → S4 (+U49) → S5 → S6 → S7 → S10 → [dừng: báo cáo chặng A] → S8 (+mapping) → S9 → S11 → S12 → cập nhật tài liệu (§5 SPEC)`

Agent dev **không dừng chờ** review giữa chặng: Admin muốn một agent dev chạy hết rồi một agent review. Hết chặng A thì ghi bảng §7 cho chặng A, rồi làm tiếp chặng B.

---

## ⛔ 0. (ĐÃ XONG, giữ làm lịch sử) PHẠM VI ĐỢT SPEC-3: Admin chốt 10/10 tối

> "cứ làm mỗi SPEC-3 thôi, tôi báo bên kia để authentication vào 1 Spec khác rồi"

- **Làm:** S3-1, S3-2 (theo nghĩa mới ở dưới), S3-3, S3-4, S3-5, S3-6 của `audit-fix-2026-10-10/SPEC-3-dung-chuan.md`.
- **HOÃN toàn bộ S0–S14** của `SPEC-hub-multi-service.md` (project, api key, `/v1/p/*`, Standard Webhooks, polling, GenericAdapter, SDK, shop-as-service). Lý do: một phiên khác đang viết spec đăng ký/đăng nhập (ADR-056) đụng `schema.prisma`, auth, S2. Các mục §2/§3/§5 bên dưới **để dành** cho lúc mở lại đợt đa service.
- **Không** tạo bảng `projects`, `api_keys`, `users`; **không** đụng `apps/hub-api/src/modules/auth/*`.

**S3-2 nghĩa mới = "một đầu ra duy nhất" = phần lõi của S14 (§4.14 SPEC đa service), chỉ phần không phụ thuộc đa service:**

| Làm ngay (thuộc S3-2) | Hoãn (cùng đợt đa service) |
|---|---|
| `libs/common/src/canonical/` (`payment.ts`, `repo.ts`, `time.ts`, `index.ts`): catalog §4.14.2, `validateCanonical`, `isReservedType`, `parseProviderTime` — viết tay, không zod/ajv | `POST /events` kiểm 422 `schema_mismatch` (U49) |
| Sửa 4 adapter PayOS/SePay/Stripe/GitHub theo bảng ánh xạ §4.14.2 + luật §4.14.1 (`normalized`, `data.raw`, `subject`, kiểu chưa ánh xạ → `<provider>.<kiểu gốc>`) | `mapping` của GenericAdapter (§4.14.4, U46–U48) |
| `NormalizedEvent` thêm `normalized?: boolean`; cột `events.normalized` (migration, default true); body gửi tới đích webhook thêm `normalized` | SDK re-export type |
| `NormalizeConsumer`: kiểu dành riêng sai khuôn → lỗi vĩnh viễn (ADR-044) + metric `hub_normalize_schema_errors_total{source}` (U45) | Shop thành service thật (S11) |
| Shop: đọc `payment.received`, `data.amount`, tìm mã đơn trong `data.memo` rồi `data.reference`; xoá `transferAmount`/`content`/`orderCode` ở nhánh webhook; ≤ 300 dòng | |
| Seed: subscription Shop + Telegram → `payment.received` / `payment.*`; template theo S3-3 (dòng dưới) | |
| UI tối thiểu để không vỡ: placeholder `payment.succeeded` ở form subscription, payload mẫu playground, mọi chỗ `apps/web` đọc `data.transferAmount`/`data.description` | |
| `docs/EVENT-CATALOG.md` (catalog v1, bảng ánh xạ, luật ổn định hình dạng, bảng ánh xạ sang CloudEvents) | |
| Test U34–U45, U50 của SPEC đa service §7.1 | |

**Không** làm phần CloudEvents của SPEC-3 S3-2 (`specversion`, `source` URI, cột `events.provider`). Hiện `source` của event = tên provider; giữ nguyên.

**S3-3** theo SPEC-3, sửa cho khớp tên mới: pattern `^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$` (`*` đứng một mình hợp lệ), sai → 400; hàm thuần `libs/common/src/event-pattern.ts`; `payment.*` khớp nhiều cấp. Seed: bỏ `order.paid`; Telegram `['payment.*']`, template `Giao dịch mới
Nguồn: {{source}}
Số tiền: {{data.amount}} {{data.currency}}
Nội dung: {{data.memo}}
Mã tham chiếu: {{data.reference}}`; Shop `['payment.received']`.

**S3-1, S3-4, S3-5, S3-6** đúng như SPEC-3. Lưu ý S3-1: khoá idem dự phòng = hash body; `extractSignature(req)` thêm vào interface; `ingest.service.ts` gọi nó (đã có `redactHeaders` từ đợt 9/10 — `signature_header` của SePay phải ra `Apikey ***`). S3-5 đếm cả đường ingest hiện tại (R1 đã chốt: ≤4 cố định + ≤2/đích, giữ GET idem).

**Thứ tự:** `S3-1 → S3-2 → S3-3 → S3-4 → S3-5 → S3-6`, mỗi story một commit (A3). Ghi kết quả vào cột "Kết quả (dev)" của `audit-fix-2026-10-10/REVIEW-CHECKLIST.md` (dòng 5–13, 27, 38, 40, 41 và các dòng khác gắn S3-x) + mục "Lệch khi làm" cuối SPEC-3.

---

## 1. Quyết định của Admin (10/10 tối)

| # | Câu hỏi | Admin chốt | Hệ quả |
|---|---|---|---|
| A1 | SPEC-3 vs S14 | **Làm theo SPEC-3**, riêng S3-2: "chỉ có **1 đầu ra duy nhất**" (đã thống nhất với phiên bên kia) | S3-1, S3-3, S3-4, S3-5, S3-6 làm đúng SPEC-3. **S3-2 bị thay bằng S14**: chỉ có catalog §4.14 (`payment.received/sent/failed/refunded`, `repo.*`). **Không** có `payment.succeeded`, `bank.transfer.*`, không đổi body sang CloudEvents (`specversion`, `source` URI, đổi tên `provider`). Ánh xạ sang CloudEvents chỉ viết trong `docs/EVENT-CATALOG.md` |
| A2 | Retention `raw_events` ACCEPTED | **Theo đợt 9/10** (SPEC-1 S1-4, ADR-045) | **Không bao giờ xoá `raw_events` ACCEPTED.** §4.10 chỉ còn: xoá `events` cũ hơn `N` ngày (cascade `deliveries`, `delivery_attempts`) + những gì `CleanupJob` đã xoá. Xem §3 |
| A3 | Commit | **Mỗi story một commit**, trên `master`, **không push** | Message có mã story, vd `feat(S3): api key guard + scopes`, kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` |
| A4 | Volume sạch | Phiên **review** được chạy `docker compose down -v` | Phiên **dev** thì không (dev chạy trên DB hiện có, nhờ đó kiểm luôn migrate trên dữ liệu cũ) |

---

## 2. Hiện trạng thật (thay bảng §3 của SPEC)

| # | SPEC nói | Code thật sau `0b2cef4` | Làm gì |
|---|---|---|---|
| 1 | S0: normalize còn `channel.publish` (dual-write) | **Đã xong** ở S1-2: outbox topic **`delivery.requested`**, relay định tuyến qua `TOPIC_ROUTES` (`apps/hub-worker/src/scheduler/outbox.relay.ts`) | S0 chỉ còn **kiểm** luồng GitHub → shop thật. U29 đổi `delivery.created` → `delivery.requested`. Topic mới nếu cần thì thêm vào `TOPIC_ROUTES` |
| 2 | §0: entrypoint `db push --accept-data-loss`; "cột mới phải default/nullable" | Đã chuyển sang **`prisma migrate deploy`**, baseline `0_init` + 3 migration ngày 10/10 | **Mọi thay đổi schema = một thư mục migration mới** trong `libs/database/prisma/migrations/` (tạo bằng `prisma migrate dev --create-only` hoặc viết SQL tay). Không dùng `db push`. Migration phải chạy được trên DB đang có dữ liệu |
| 3 | `audit_logs` không ai ghi | Đã có `withAudit` trong `api.controller.ts` (ghi cùng transaction, ADR-050) | Tái dùng cho `api_key.*`, `endpoint.*`, `project.*` |
| 4 | `createSubscription` không kiểm tenant | S1-5 đã kiểm destination cùng tenant (404) | S5 chỉ thêm `sourceIds`, wildcard, khoá ngoại ghép |
| 5 | Khoá ngoại ghép subscription→destination | Hiện là FK đơn, **`ON DELETE RESTRICT`** (ADR-054, migration `20261010020000_...`) | FK ghép mới **phải giữ RESTRICT**. `deliveries.subscription_id` vẫn RESTRICT; `deliveries.event_id` vẫn CASCADE |
| 6 | S10: `timeout: 5000` gắn cứng, axios trả 500 | Đã có `SEND_TIMEOUT_MS` + `AbortSignal.timeout` + đọc stream ≤64KB trong `apps/hub-worker/src/senders/http-limits.ts` | S10 chỉ còn: đọc `DELIVERY_TIMEOUT_MS` từ env (kẹp 1000–10000) vào `SEND_TIMEOUT_MS`. U28 khoá hành vi qua `describeSendError` (chuỗi chứa `timeout`) + retryable + `recordFailure` |
| 7 | §4.10: không có job cleanup | Đã có `apps/hub-worker/src/scheduler/cleanup.job.ts` (lock `cleanup:lock`, env `CLEANUP_RETENTION_DAYS`, assert retention > tổng TTL retry, `CLEANUP_INTERVAL_MS`) | **Mở rộng job này**, không tạo job thứ hai. Xem §3 |
| 8 | Rủi ro §8.1: `signingSecret` đi qua RabbitMQ | ADR-042 đã gỡ: message chỉ còn tham chiếu | Bỏ rủi ro này |
| 9 | ADR mới "số tiếp theo" | Số cuối hiện là **056** (ADR-056 do phiên song song ghi: đăng ký/đăng nhập người dùng) | Bắt đầu từ **ADR-057**. Có phiên khác đang ghi ADR song song → **luôn** kiểm số cuối ngay trước khi ghi |
| 10 | DoD: grep `X-Hub-Signature` = 0 | Header `x-hub-signature-256` là chữ ký **GitHub chiều vào** (adapter, `redact-headers.ts`, playground) — hợp lệ | DoD grep đổi thành: `grep -rnE "X-Hub-(Signature|Event-Id|Timestamp)([^-]|$)" apps libs` chỉ còn ở test/comment lịch sử |
| 11 | "Spec này không làm UI" | UI mới **đang chạy** ở `apps/web` và dùng API cũ | Dev phải sửa **tối thiểu để UI không vỡ**: `useEvents` (`apps/web/src/lib/hub/queries.ts`) theo nghĩa `after` mới của S7; placeholder `payment.succeeded` ở form subscription và payload mẫu ở playground theo S14. **Không** làm màn mới (project switcher, key UI… để phiên UI) |
| 12 | Realtime | `trace.ingested` phát in-process ở hub-api; `event.received` có `deliveries[]` | `POST /v1/p/:project/events` đi qua `persistAccepted` nên **cũng** phát `trace.ingested` như `/hooks` |
| 13 | Ngân sách Redis (R1) | ≤ 4 lệnh cố định / sự kiện + ≤ 2 / đích; giữ GET idem | `ApiKeyGuard`, challenge, polling **không** chạm Redis. `persistAccepted` giữ đúng thứ tự §3.1 (SET NX **sau** COMMIT) |
| 14 | Shop `main.ts:105-175` | Hiện 211 dòng; verify `x-hub-*` ở dòng ~107; `SIGNING_SECRET` fallback ở dòng 14 | S11 vẫn ≤ 300 dòng |
| 15 | Mock | `/mock/*` chỉ bật khi không phải production (đợt 9/10) | Giữ nguyên |

---

## 3. Retention sau quyết định A2 (thay §4.10)

- Env: giữ **một** biến. Tên chính `EVENT_RETENTION_DAYS`; `CLEANUP_RETENTION_DAYS` vẫn đọc được làm alias (đừng làm vỡ `.env` cũ). Mặc định 7. Assert hiện có (retention > tổng TTL retry) giữ nguyên.
- `CleanupJob` thêm một bước: xoá `events` có `received_at < now() - N ngày` theo lô (cascade sang `deliveries`, `delivery_attempts`). Các bước cũ giữ nguyên: outbox đã publish, `processed_messages`, `raw_events` **REJECTED**.
- **Không xoá `raw_events` ACCEPTED** (ADR-045). Event bị xoá thì raw_event vẫn còn → vẫn renormalize/replay được qua `/api/v1/raw-events/orphans` + renormalize (S2-x đợt 9/10). Ghi ADR: "polling (A) chỉ lấy lại được trong N ngày; bằng chứng gốc giữ vô hạn; đánh đổi dung lượng Neon".
- Xoá xuyên project: escape hatch hạ tầng có tên rõ trên `PrismaService` (như các bước cleanup hiện có) + ADR.
- **Cẩn thận:** event bị xoá → raw_event của nó sẽ hiện trong danh sách "orphans" (ACCEPTED không có event). Orphans phải loại raw_event cũ hơn N ngày, nếu không banner orphan ở dashboard sẽ báo động giả sau 7 ngày.

---

## 4. Gộp SPEC-3 vào đợt này

| SPEC-3 | Số phận | Ghi chú gộp |
|---|---|---|
| **S3-1** chữ ký PayOS timingSafe, SePay bắt buộc `Apikey`, khoá idem dự phòng = `sha256(rawBody)` 32 hex, `extractSignature()` | **Làm, ngay sau S0** | Sửa interface adapter **trước** S8. Khi S8 thêm `ctx?: AdapterContext`, giữ `extractSignature(req)`. GenericAdapter (S8) cũng phải có `extractSignature` (trả header đã cấu hình, che nếu là `static-token`) |
| **S3-2** CloudEvents + `payment.succeeded`/`bank.transfer.*` | **Thay bằng S14** (A1) | Không làm. Ghi một dòng trong ADR S14 (ADR-053 đã có, thêm ADR mới nếu cần) rằng S3-2 bị thay |
| **S3-3** wildcard + seed + template | **Làm theo SPEC-3**, gộp vào S5 | Ngữ pháp pattern theo SPEC-3: `^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$` → **`*` đứng một mình được phép** (thắng §4.6). Vẫn cấm `*.paid`, `payment.*.x`, chữ hoa. Hàm sinh ứng viên ở `libs/common/src/event-pattern.ts`, ứng viên gồm cả `*`. Mã lỗi: `/api/v1/*` trả 400 (SPEC-3), `/v1/p/*` trả 422 (SPEC). U17/U19 sửa theo: `*` hợp lệ. Seed theo S14: Telegram `['payment.*']`, template `Giao dịch mới\nNguồn: {{source}}\nSố tiền: {{data.amount}} {{data.currency}}\nNội dung: {{data.memo}}\nMã tham chiếu: {{data.reference}}`; bỏ `order.paid`. Shop không còn được seed (S11) |
| **S3-4** `/metrics`, Grafana, k6 | **Làm, chặng B** | Thêm metric `hub_normalize_schema_errors_total{source}` của S14 vào cùng chỗ |
| **S3-5** đếm Redis bằng test | **Làm, chặng B** (sau S11, để đếm cả đường `/events`) | |
| **S3-6** docs nói đúng code | **Làm cuối cùng** | Gộp với "cập nhật tài liệu" §5 của SPEC: ARCHITECTURE.md, .env.example, CLAUDE.md, EVENT-CATALOG.md |

---

## 5. Thứ tự làm (thay §5 của SPEC)

**Chặng A** (xong thì dừng, chờ review A):
`S0 (kiểm) → S3-1 → S1 → S2 → S3 → S4 → S5 (+S3-3) → S6 → S7 (+§3 retention) → S10`

**Chặng B** (sau review A):
`S8 → S9 → S14 (thay S3-2) → S11 → S12 → S3-4 → S3-5 → S3-6`

**Bỏ:** S13 (RLS) — ghi "hướng phát triển" trong ADR. SPEC-dev-experience (DX1–DX3) là đợt sau.

---

## 6. Luật cho phiên dev (bổ sung §0 của SPEC)

- Jest: `npx jest -w 2`; test DB: `RUN_DB_TESTS=1 npx jest -w 2 <pattern>`. **Không** chạy jest không giới hạn worker.
- **Không** `docker compose down -v`. Được `docker compose up -d --build <service>`.
- **Không** gửi Telegram thật (không bắn sự kiện khớp subscription Telegram trên docker; dùng endpoint echo/mock).
- **Không** đưa `.env` vào commit hay image. **Không** push.
- Topology chỉ ở `libs/messaging/topology.ts`; **không đổi args** queue đã tồn tại.
- Mỗi story: code → test → `npx jest -w 2` xanh → commit. Đánh `[x]` vào §9 SPEC, ghi "Lệch so với spec" nếu có.
- Hết chặng: ghi bảng "Kết quả (dev)" ở cuối file này (§7).

## 7. Kết quả (dev điền)

| Story | Commit | Test mới | Lệch / ghi chú |
|---|---|---|---|
| S0 | (chỉ kiểm, không commit) | U29 gắn `[AF:#16][MS:U29]` ở commit S1 | `e2e-smoke.sh` trên DEV (c96bf6b) OK; `grep channel.publish apps/hub-worker/src/consumers` = 1 (DLX DEAD ở delivery.consumer, không phải dual-write) |
| S3-1 | `7310537` | `signature-s3-1.spec.ts` (15) | ADR-058; `signature_header` chuỗi trần (dòng cũ có ngoặc kép); hash body cả GitHub/Stripe |
| S3-2 (= lõi S14) | `bb9ef98` | canonical-* (U34–U44, U50), `normalize-canonical.spec.ts` (U45), `webhook-body-normalized.spec.ts`, Shop `readPayment` | ADR-059; migration `20261010030000_event_normalized_flag`; validator từ chối cả khoá lạ |
| S3-3 | `0d62668` | `event-pattern.spec.ts`, `subscription-pattern.spec.ts`, `subscription-match-db.spec.ts` | ADR-060; 400 trả `{error:"invalid_event_pattern"}` |
| S1 | `aa2692c` | `project-schema-db.spec.ts` | ADR-071; migration `20261011000000_projects_api_keys`; bảng `projects`, `api_keys(tenant_id, service_name, key_prefix, key_hash, scopes, read_types, source_id, last_used_at, revoked_at)`; cột `sources.verification_config`, `events.seq` (BIGINT, JSON ra **chuỗi**), `events.source_id`, `destinations.verification` (enum `EndpointVerification` PENDING/VERIFIED/FAILED, default VERIFIED), `destinations.verified_at`, `destinations.verification_error`, `subscriptions.source_ids uuid[]`; enum `ProviderEnum` + `generic`, `api`; enum `ProjectEnv` test/live. FK ghép `subscriptions(destination_id, tenant_id)` RESTRICT thay FK đơn. Không đổi/xoá cột delivery/attempt nào (X17) |
| S2 | `3d3b5ed` | `console-projects-db.spec.ts` | ADR-072. `POST /api/v1/projects` 201 · 409 `{error:"slug_taken"}` · 422 `{error:"validation_failed",field,message}`; `GET /api/v1/projects` trả **mảng** `[{id,slug,name,environment,createdAt}]`; `POST /api/v1/projects/:projectId/keys` 201 `{id,serviceName,keyPrefix,scopes,readTypes,sourceId,createdAt,key,connectionString}`; scopes rỗng 422 field `scopes`; `DELETE …/keys/:keyId` 204 (lần 2 vẫn 204); key khác project / project lạ 404 `{error:"not_found"}`. Audit `project.created`, `api_key.created`, `api_key.revoked`. **`?projectId=` đọc DUY NHẤT ở `apps/hub-api/src/modules/console/project-scope.guard.ts` (`ProjectScopeGuard`)** (X2/X17) |
| S3 | `6c72d65` | `api-key.guard.spec.ts` (U20–U23) | ADR-073. `GET /v1/p/:project/me` → `{project:{slug,name,environment},serviceName,scopes}`; 401 `{error:"invalid_api_key"}` → 404 `{error:"not_found"}` → 403 `{error:"missing_scope",required}`; `request.principal = {kind:'key', id, tenantId, scopes, serviceName}`; 0 lệnh Redis |
| S4 | `b11406e` | `api.adapter.spec.ts` (U16), `publish-canonical.spec.ts` (U49), `redis-budget.spec.ts` (X9) | ADR-074. `POST /v1/p/:project/events` 202 `{eventId:null,rawEventId,duplicate:false}`, trùng 200 `{duplicate:true}`, 422 `validation_failed{field}` / `schema_mismatch{field}`, source api tắt 409 `{error:"source_inactive"}`; khoá idem `api:<key>` (>251 ký tự → `api:sha256:<hex>`); source `api_<keyId>` tạo cùng transaction với key. **Lệch:** trần body thật = 100KB (body-parser Nest, cũng đúng cho `/hooks`) → 413, không phải 1MB/422 |
| S5 (+S3-3) | `ce33fb0` | `service-resources.spec.ts`, `subscription-match-db.spec.ts` (U18), `repository-scope.spec.ts` | ADR-075. `POST/GET /v1/p/:project/endpoints` → `{id,name,url,verification,verificationError,verifiedAt,createdAt}` (+`signingSecret` chỉ khi hub sinh, S6); `POST/GET /v1/p/:project/subscriptions` → `{id,name,endpointId,eventTypes,sourceIds,isActive,createdAt}`; endpoint khác project 404 `{error:"not_found"}`; pattern sai 422 `validation_failed{field:"eventTypes"}`; `sourceIds` lạ 422 `{error:"unknown_source",ids}` (cả console). **Lệch (X17):** hàm repo cũ `findActiveSubscriptionsForEventType` **GIỮ NGUYÊN** cho nhánh UI; hàm mới `findActiveSubscriptionsForEvent(type, sourceId)` (normalize dùng). Audit actor `key:<keyId>` |
| S6 | `b4193a6` | `standard-webhooks.spec.ts` (U1–U6), `endpoint-verifier.spec.ts`, `ssrf-metadata.spec.ts`, U30 | ADR-076. Header gửi đi `webhook-id`(=event.id)/`webhook-timestamp`/`webhook-signature: v1,<base64>`, **không còn `X-Hub-*`**; Shop verify bằng `swVerify`. `POST /v1/p/:project/endpoints/:id/verify` 200 `{verification,verificationError}`. Lý do FAILED: `timeout`, `http_<status>`, `challenge_mismatch`, `ssrf_blocked`, `invalid_json`, **thêm `unreachable`** (từ chối kết nối/DNS). X15(3): IP private được phép khi `NODE_ENV=development` (hubv); **169.254/16 + fe80::/10 bị chặn mọi môi trường**. X15(4): `e2e-smoke.sh` chạy được trên hubv khi export `HUB_SIGNING_SECRET/GITHUB_WEBHOOK_SECRET/DEMO_SEPAY_APIKEY` từ `.env.verify` |
| S7 | `2b5f16f` | `polling-db.spec.ts` (U24–U27), `polling-params.spec.ts`, `retention-db.spec.ts`, `cleanup-job.spec.ts` | ADR-077. **Lệch:** cửa sổ lắng lọc theo cột MỚI `events.created_at` (clock_timestamp lúc INSERT, migration `20261011010000_events_created_at`), không theo `received_at`. `GET /v1/p/:project/events` → `{events:[{id,seq,type,source,sourceId,subject,data,normalized,correlationId,occurredAt,receivedAt}],nextCursor}` (seq/nextCursor CHUỖI); 422 field `after/limit/types/status/wait`. Dashboard `GET /api/v1/events`: `before=<id>` (giảm dần, như cũ), `after=<seq>` (tăng dần); `useEvents` gửi `before`. Retention: `EVENT_RETENTION_DAYS` (alias `CLEANUP_RETENTION_DAYS`), escape hatch `PrismaService.deleteExpiredEventsBatch`; orphans loại raw > N ngày |
| S10 | `775ca17` | `delivery-timeout.spec.ts`, U28 | ADR-078. Số đo T10 (hubv): timeout 5000 → project bên cạnh p50 1712ms / p95 2463ms; 10000 → p50 6424ms / p95 7005ms; đích chậm circuit OPEN |
| S8 | `c3610d1` (+ `58f7e45` cổng sig-compare) | `generic.adapter.spec.ts` (U7–U14, U46–U48), `ingest-generic.spec.ts`, `service-sources.spec.ts` | ADR-079. `POST/GET /v1/p/:project/sources` (manage:sources) → `{id,name,provider,sourceKey,webhookUrl,isActive,verificationConfig,createdAt}`; provider lạ/`api` → 422 field `provider`; lỗi config → 422 field `verificationConfig.<đường dẫn>`; console `/api/v1/sources` dùng cùng bộ kiểm (đổi từ nhận-gì-lưu-nấy sang 422). Thiếu khoá chống trùng → raw REJECTED (`signature_valid=true`) + 422 `{error:"missing_idempotency_key"}`. ACK generic `{ok:true}` / `{ok:true,duplicate:true}`. Interface adapter thêm `ctx?`, `sensitiveHeaders?`. Probe P-MS-S8-01 đỏ U12 + T9(d) |
| S9 | `50651b4` | U15, U48(b), `service-sources.spec.ts` (inspect) | ADR-080. `GET /v1/p/:project/sources/:id/inspect?since=` → `[{id,receivedAt,status,diagnosis}]`, `diagnosis.reason` ∈ ok/missing_header(+expectedHeader,candidateHeaders)/signature_mismatch/token_mismatch/timestamp_out_of_range/missing_idempotency_key(+expectedField|expectedHeader)/mapping_field_missing/mapping_field_invalid(+field)/config_invalid; adapter không cài → `{ok: signatureValid}`; since sai → 422 |
| S14 | (lõi trong S3-2 `bb9ef98`) | U34–U45, U50 | Phần đa service (POST /events, mapping, SDK) hoãn |
| S11 | `bb70d92` | `libs/hub-sdk/test/sdk.spec.ts` (U31–U33) | ADR-081. `@hub/sdk` workspace mới (`libs/hub-sdk`). Shop: `HUB_SIGNING_SECRET` bắt buộc, `HUB_URL`, `SHOP_PUBLIC_URL`; tự `ensure` endpoint `shop` + subscription `payment.received`; seed KHÔNG tạo đích Shop. Sau review: MS-R2 Shop chỉ nhận `source ∈ {payos,sepay}` (`SHOP_PAYMENT_SOURCES`), MS-R4 `ensure` luôn `/verify` kèm secret. Probe P-MS-S11-01 đỏ U32 |
| S12 | `5496b3e` | `seed-demo-db.spec.ts` (T14 phần a) | ADR-082. Project `cafe` (test, SePay `src_sepay_cafe`) + `bookstore` (live, PayOS `src_payos_bookstore`), key `<slug>-be` + source api, endpoint `<slug>-endpoint` VERIFIED (`/mock/echo/<slug>` hoặc sink hubv), sub `payment.*`. `SEED_DEMO_PROJECTS`, `DEMO_ENDPOINT_BASE_URL`. L1 dùng `MASTER_KEY` của `.env.verify`. Sau review (MS-R6): seed không in key, key demo qua `SEED_CAFE_API_KEY`/`SEED_BOOKSTORE_API_KEY` hoặc script tự tạo |
| S3-4 | `db67292` | `metrics.spec.ts`, `worker-metrics.spec.ts` | ADR-061; thêm `INGEST_RATE_LIMIT_PER_MIN`; k6 p95 23,6ms; outbox lag ≈21s ở 100 RPS |
| S3-5 | `8292940` | `redis-budget.spec.ts` | ADR-062; 1 đích = 6, 2 đích = 8; Upstash free 500K/tháng |
| S3-6 | `66df7c5` | — | ADR-063; `PHU-LUC-SUA.md` (docx không còn ở Downloads → câu cũ lấy từ BB09) |
| S3-review#1 | `01790b3` | canonical-sepay/payos (thiếu id) | providerTxnId `sha:`+hash body; docker: 2 lần → 1 event |
| S3-review#2 | `34fa59a` | redis-budget (ca throttle), circuit-breaker (Lua thật) | ADR-064; MONITOR 2 đích có throttle 10 → 8 lệnh |
| S3-review#3 | `1695aee`, `cc4b2ed` | outbox-relay (lô) | ADR-065; k6 lag 43,2s → 0,65s |
| S3-review#4 | `624c60e` | canonical-sepay (receivedAt), normalize-canonical | thời gian dự phòng = raw_events.received_at |
| S3-review#5 | `4af13e4` | U44, U50 (amount 0) | docker: PayOS code 01 amount 0 → payment.failed |
| S3-review#6 | `eace50d` | worker-metrics (token) | docker: 401/200 cả api lẫn worker |
| S3-review#7 | `e3c2249` | seed-env (seedTelegramActive) | ADR-066; down -v + up: tự seed, Telegram TẮT; restart không nhân đôi |

## 8. Kết quả review (phiên review điền)

| Chặng | Phát hiện | Mức | Trạng thái |
|---|---|---|---|
| SPEC-3 (review 10/10, volume sạch) | **#1 CONFIRMED** — SePay thiếu cả `id` lẫn `referenceCode`: ingest ACCEPTED + 200 cho SePay, nhưng `sepay.adapter.ts:56` cho `providerTxnId=null` → validator từ chối → normalize DLQ, **0 event** (hồi quy do S3-2; bằng chứng "1 event" ở checklist dòng 7 là đo trước S3-2). Tái hiện: POST `/hooks/sepay/src_sepay_main` body không `id`/`referenceCode`, `Apikey` đúng → `q.normalize.dlq` +1, `hub_normalize_schema_errors_total{source="sepay"}` +1. Thực tế SePay luôn gửi `id` nên xác suất thấp. Đề xuất: `providerTxnId = id ?? referenceCode ?? 'sha:'+bodyHashKey(rawBody)` (cùng khoá idem) hoặc ghi rõ trong EVENT-CATALOG rằng thiếu cả hai = lỗi vĩnh viễn | Trung | Mở |
| SPEC-3 | **#2 CONFIRMED** — Ngân sách Redis R1 bị vượt trên cấu hình demo: `redis-cli MONITOR`, 1 SePay → 2 đích = **10 lệnh** (4 + 2×[mget, eval throttle, publish]); R1 cho 8. Cả 3 đích seed có `rate_limit_rps` (10/10/20) nên throttle là đường nóng; `redis-budget.spec.ts` dùng `rateLimitRps:0` nên không bắt được. PHU-LUC mục 10 và DEPLOYMENT §5.2 (quota ÷6/÷8) lạc quan ~15–25%. Đề xuất: gộp đọc circuit + INCR throttle vào MỘT Lua (2 lệnh/delivery) hoặc seed `rateLimitRps=0`; thêm ca test có throttle | Trung | Mở |
| SPEC-3 | **#3 PLAUSIBLE (từ code)** — Trần thông lượng outbox relay: `LIMIT 50` mỗi ~500ms (±100ms), publish tuần tự chờ confirm + UPDATE từng dòng trong một transaction → < 100 dòng/s/worker. Mỗi sự kiện sinh 1 + N dòng outbox ⇒ ở 100 RPS với 1 đích (200 dòng/s) lag tăng không chặn (dev đo đỉnh 21s với kiểu không có đích). p95 ingest 23ms của k6 chỉ đo tới ACK, không đo đầu-cuối. Đề xuất: lặp ngay khi batch đầy (không ngủ), UPDATE `id = ANY(...)` một lần, publish rồi `waitForConfirms` theo lô; báo cáo ghi kèm lag | Trung | Mở |
| SPEC-3 | **#4 PLAUSIBLE** — Thời gian dự phòng khi thiếu `transactionDateTime`/`transactionDate`/`created` là `new Date()` LÚC NORMALIZE (`payos.adapter.ts:69`, `sepay.adapter.ts:54`, `stripe.adapter.ts:84`), không phải `raw_events.received_at`: retry/renormalize cho `paidAt` khác nhau và có thể muộn hàng phút. Đề xuất: truyền `receivedAt` của raw_event qua `NormalizeContext` | Thấp | Mở |
| SPEC-3 | **#5 PLAUSIBLE** — PayOS `code≠"00"` có `amount` 0/thiếu (chưa thấy trong tài liệu PayOS, PayOS thường chỉ gửi webhook giao dịch thành công) → validator (`amount>0`) từ chối `payment.failed` → lỗi vĩnh viễn. Đề xuất: nới `amount ≥ 0` riêng cho `payment.failed` hoặc ghi rõ trong catalog | Thấp | Mở |
| SPEC-3 | **#6 PLAUSIBLE** — Worker `/metrics` (9101) không có `METRICS_TOKEN` như hub-api; nếu deploy theo phương án C/D (DEPLOYMENT §3.2) mà lộ cổng thì ai cũng đọc được. Upstash tính `EVAL` = 1 lệnh: tài liệu Upstash không nói rõ (đã tìm), con số quota dựa trên giả định này | Thấp | Mở |
| SPEC-3 | Ghi nhận, không phải lỗi: validator từ chối khoá lạ không phá luật 7 (luật 7 ràng buộc hợp đồng với consumer; thêm trường = sửa catalog cùng commit); `signature_header` dòng cũ còn ngoặc kép chỉ ảnh hưởng hiển thị (volume sạch không có). Hồi quy 9/10: smoke OK, outbox 0 secret, `raw_events` 0 chỗ chứa key SePay (lỗ dòng 15 đã đóng), audit ghi `subscription.create/update`, không có `if (provider===…)` trong lõi, mọi so chữ ký qua `timingSafeCompare`/SDK dùng `timingSafeEqual`, BB-1 grep sạch (chỉ `orderCode` trong khoá idem của adapter PayOS + comment/test). Jest `-w 2` 350 pass/34 skip; `RUN_DB_TESTS=1` 384/384; tsc api/worker/shop/web = 0. Telegram tắt suốt buổi (0 delivery telegram); 4 subscription tạm "REVIEW …" (đích Discord mock) để `isActive=false` | — | Đóng |
| Đa service S1–S11 (**pha 1, tĩnh**, `aa2692c..bb70d92`, chưa E2E) | **MS-R1 CONFIRMED (probe chạy `validateAndPinUrl` với NODE_ENV=production)** — SSRF guard để lọt IPv6 ánh xạ IPv4 và `::`: `http://[::ffff:127.0.0.1]:4000/`, `http://[::ffff:10.0.0.1]/`, `http://[::]/` đều PASS (`libs/crypto/src/ssrf.ts` `isPrivateIp` dòng ~9–38 chỉ xét `::1`/fc/fd/fe8x; `isLinkLocalIp` thì bắt được `::ffff:169.254.x`). Code cũ từ ngày 1, nhưng S5/S6 mở nó cho **key service** (`manage:endpoints`): challenge POST tới địa chỉ nội bộ và trả về `http_<status>` / `timeout` / `unreachable` → dò cổng nội bộ được, `/verify` gọi lặp lại không giới hạn. Đề xuất: chuẩn hoá `::ffff:a.b.c.d` / `::ffff:XXXX:XXXX` về IPv4 rồi mới kiểm, chặn `::`, `::ffff:0:0/96`, `64:ff9b::/96`; thêm test cho từng dạng | Cao | Mở |
| Đa service (pha 1) | **MS-R2 CONFIRMED (đọc code)** — Shop tin `payment.received` từ **mọi** source: `apps/shop/src/payment.ts:41` chỉ kiểm `type` + `VND`; `ensure` của Shop tạo subscription `sourceIds=[]`. Bất kỳ key nào trong project `default` có `publish:events` đều `POST /v1/p/default/events {type:"payment.received", data:{memo:"DH…", amount…}}` (qua validator vì đúng khuôn, U49) → đơn Shop thành PAID mà không có tiền thật. Đề xuất: Shop bỏ qua `source ∈ {api, generic}`, hoặc `ensure` với `sourceIds` = source PayOS/SePay; cân nhắc chặn publish kiểu `payment.*` qua `/events` trừ khi key có cờ riêng | Trung | Mở |
| Đa service (pha 1) | **MS-R3 CONFIRMED (đọc code)** — `POST /v1/p/:project/subscriptions` (`service-resources.controller.ts` `createSubscription`) lấy `findDestinationById` mà **không** kiểm `type==='webhook'` (khác `verifyEndpoint`, `listEndpoints`), còn `GET /subscriptions` trả cả subscription Telegram/Discord của admin (lộ `endpointId`). Key `manage:endpoints` gắn được đích Telegram/Discord của operator vào `*` → spam kênh admin. Ngoài ra subscription push không bị `readTypes` giới hạn (spec chỉ áp `readTypes` cho polling) → key `readTypes=["order.*"]` vẫn nhận `payment.*` qua push. Đề xuất: chỉ cho `type='webhook'`; list chỉ trả subscription tới đích webhook; giao `eventTypes` với `readTypes` nếu `readTypes` là ranh giới quyền | Trung | Mở |
| Đa service (pha 1) | **MS-R4 CONFIRMED (đọc code)** — SDK `endpoints.ensure` gặp endpoint đã VERIFIED thì **không** so/đổi secret: Shop đổi `HUB_SIGNING_SECRET` → hub vẫn ký bằng secret cũ → Shop 401 mọi webhook → retry → DEAD, log Shop chỉ báo "endpoint VERIFIED". Đề xuất: `ensure` luôn chạy `/verify` khi có `signingSecret` (challenge ký bằng secret đã lưu sẽ fail → lộ lệch), hoặc thêm API xoay secret | Trung | Mở |
| Đa service (pha 1) | **MS-R5 PLAUSIBLE** — (a) Cửa sổ lắng 2s theo `events.created_at`: lý lẽ đúng hơn SPEC (received_at không bảo vệ khi renormalize) và ADR-077 đã ghi rủi ro; transaction normalize > 2s sau INSERT (khoá, DB chậm) vẫn làm cursor vượt qua → mất vĩnh viễn với polling. Đề xuất pha 2 đo thời gian INSERT→COMMIT p99, hoặc dùng `pg_snapshot_xmin` / xid thay cửa sổ thời gian. (b) Long-poll không có trần số kết nối chờ: N client × 1 truy vấn/s (Neon pool nhỏ). (c) Delivery đã tạo / replay vẫn gửi khi endpoint chuyển FAILED sau `/verify`. (d) `/v1/p` chưa có API nộp/xoay secret source (spec §4.2 "nộp secret") | Thấp | Mở |
| Đa service (pha 1) | **MS-R6 Thấp/vệ sinh** — `source-input.ts`: danh sách `CREATABLE_PROVIDERS` cứng + `if (provider === 'generic')` ở tầng API (không phải ingest/worker, nhưng thêm provider phải sửa file này); `/hooks/:provider/:sourceKey` không so `source.provider` với provider trên path (cũ, không leo thang vì vẫn cần secret của source); `api_keys.scopes` nullable trong migration → `key.scopes.includes` 500 nếu dữ liệu tay; seed in nguyên `HUB_URL` (chứa key) ra log kể cả khi key lấy từ env; `ProjectsController.create` gọi `tx.project.create` trực tiếp thay vì escape hatch có tên; raw_event của `/events` mang `origin:'webhook'` | Thấp | Mở |
| Đa service (pha 1) — đạt | Cô lập: `ApiKeyGuard` so slug của project GẮN VỚI KEY (không tra slug path) → 404 cùng body (U22); mọi `:id` qua `forTenant`; FK ghép subscription→đích RESTRICT; `?projectId=` chỉ ở `ProjectScopeGuard`. Key: chỉ sha256, key thô một lần, tra theo hash, revoke hiệu lực ngay, `lastUsedAt` ≤1/phút trong bộ nhớ, không cấp được `manage:keys`. `/events` qua `persistAccepted` chung, 2xx sau COMMIT, SET NX sau COMMIT, Redis lỗi không đổi kết quả; `/hooks/api/*` 401 (probe: 6 adapter `verify(req, [])` = false). Standard Webhooks: `msgId.ts.body`, `whsec_` base64, nhiều chữ ký, 300s, timingSafeEqual; không còn `X-Hub-*` gửi đi; challenge qua SSRF guard, timeout 10s, không theo redirect (http.request), link-local chặn mọi môi trường, private chỉ khi `NODE_ENV=development` (chặt hơn X15). Normalize bỏ qua webhook chưa VERIFIED. Polling: `seq`, `failed` đúng generation mới nhất, long-poll dừng theo `res.close`, trần 20s, 0 Redis; retention không đụng raw ACCEPTED, orphans loại raw > N ngày. Generic: HMAC trên rawBody, thử mọi secret, field cấp một, không fallback ulid, mapping chỉ payment, `diagnose` chỉ trả tên. SDK che key (private field, toJSON, inspect, lỗi), `verifyWebhook` timingSafeEqual; Shop verify trước khi trả challenge, không còn secret gắn cứng, main.ts 217 dòng. X17: không đổi cột delivery/attempt, giữ `findActiveSubscriptionsForEventType`. **Unit (L0) trên worktree `bb70d92`: 474 pass / 0 fail / 0 skip** (= baseline). Luật verify §6: S1 không có RED, S2 không có mã `[MS:]` và số L0/L1 lẫn test S3 chưa commit, S8 `ingest-generic`/`service-sources` "viết cùng code" (chưa thấy đỏ), S11 chỉ U32 thấy đỏ qua probe; T6/T7/T8/T11 chạy tay. §7 thiếu dòng S8/S9/S11 (X12) | — | Ghi nhận |
| Sự cố do phiên review | `git worktree remove --force` trên worktree tạm có **junction** `node_modules` → xoá xuyên junction: `C:\webhook-hub\node_modules` rỗng, `libs/database/node_modules` mất, và qua symlink workspace `@hub/*` **370 file tracked trong `apps/` + `libs/` bị xoá khỏi cây làm việc** (HEAD `5496b3e` còn nguyên; file docs đang sửa không bị đụng). Phiên review bị chặn quyền khi khôi phục. Cần chạy: `git ls-files -d -- apps libs` (xem) → `git checkout -- apps libs` → `npm ci` → `npm run prisma:generate`; file chưa track trong `apps/`/`libs/` (vd `dist/`, `apps/web/node_modules`, `.next`) phải build/cài lại | **Cao (môi trường)** | Mở |
| Đa service **pha 2 (E2E trên hubv, HEAD `7202269`)** | **MS-P2-1 CONFIRMED (E2E)**: đi vòng qua MS-R2. Key project `default` có `manage:sources` gọi `POST /v1/p/default/sources {"provider":"sepay","secret":"attacker_apikey_1"}` → 201 `src_sepay_<ulid>`. Sau đó ký webhook SePay giả bằng `Authorization: Apikey attacker_apikey_1`, `content`=mã đơn, `transferAmount`=giá đơn → 200 → event `source=sepay` → Shop chuyển đơn **PAID 69000** mà không có tiền thật. Bộ lọc `SHOP_PAYMENT_SOURCES` (`apps/shop/src/payment.ts:38,47`) tin vào `source`, nhưng `source` chỉ là tên provider; `CREATABLE_PROVIDERS` (`source-input.ts:6`) cho key tạo payos/sepay tuỳ ý. Đối chứng: `/events` gửi `payment.received` hợp khuôn → Shop `IGNORED` (phần MS-R2 gốc chạy đúng). Đề xuất: Shop `ensure` với `sourceIds` = id các source thanh toán do operator tạo; hoặc `/v1/p/*/sources` không cho key tạo provider thanh toán (chỉ `generic`), hoặc gắn cờ `trusted` cho source do console tạo và Shop chỉ tin cờ đó | Trung | Mở |
| Đa service pha 2 | **MS-P2-2 CONFIRMED (E2E, volume sạch)**: hồi quy seed do S12 (`5496b3e`, `libs/database/src/seed.ts:207-216`). `seedDemoProjects()` chạy **trước** kiểm `prisma.source.count() > 0`, nên trên DB rỗng nó tạo `src_sepay_cafe`/`src_payos_bookstore`/`api_*` trước. Seed chính thấy có 4 source rồi bỏ qua, nên project `default` **không có** `src_payos_main`, `src_sepay_main`, `src_github_main`, cũng không có đích Telegram/Discord hay subscription. Tái hiện: `npm run verify:reset` → log `Đã có 4 source(s) trong DB, bỏ qua seed`; `e2e-smoke.sh` thì GitHub/SePay đều **404**, `SMOKE FAILED`. Ảnh hưởng mọi `down -v && up` (dev cũng vậy, vì `SEED_DEMO_PROJECTS` mặc định true) và DB mới khi deploy: luồng Shop chính chết. L1 `seed-demo-db.spec.ts` không bắt được. Lách tạm trên hubv: boot với `SEED_DEMO_PROJECTS=false`, sau đó `exec -e SEED_DEMO_PROJECTS=true … seed`. Đề xuất: kiểm "đã seed chưa" theo source của project `default` (vd `src_sepay_main`), không đếm toàn bảng; hoặc gọi `seedDemoProjects()` sau seed chính; thêm test L1 seed trên DB rỗng phải ra đủ 3 source main | **Cao** | Mở |
| Đa service pha 2 | **MS-P2-3 CONFIRMED (E2E)**: Redis chết thì kết quả vẫn đúng (BB-2: `/events` 202, gửi lại 200 duplicate, SePay 200 rồi duplicate; DB có 1 raw và 1 event mỗi khoá), nhưng **mỗi request mất 8,6–18,3s**. Nguyên nhân: `apps/hub-api/src/modules/redis/redis.service.ts:20` chỉ đặt `maxRetriesPerRequest: 1`, không có `commandTimeout` và không `enableOfflineQueue:false`, nên 3 lệnh (eval rate-limit, get, set) mỗi lệnh chờ reconnect. Provider như GitHub và Stripe cắt ở khoảng 10s, sẽ coi là lỗi và retry (không mất, vì đã COMMIT trước, nhưng tạo bão retry). Lỗi có từ trước đợt này; `/events` thừa hưởng. Đề xuất: `enableOfflineQueue:false` + `commandTimeout` 100–200ms, hoặc circuit nội bộ "Redis down → bỏ qua đường tắt" | Trung | Mở |
| Đa service pha 2 | **MS-P2-4 CONFIRMED (chạy `validateAndPinUrl` + `EndpointVerifier` của image hub-api với `NODE_ENV=production`)**: mọi dạng trong MS-R1 đều bị chặn (`ssrf_blocked`). Còn lọt (`libs/crypto/src/ssrf.ts` `isPrivateIpv4`/`isPrivateIp`): `192.0.0.0/24`, `198.18.0.0/15`, multicast `224/4`, `255.255.255.255`, NAT64 local-use `64:ff9b:1::/48`, 6to4 `2002::/16` (vd `2002:7f00:1::` nhúng 127.0.0.1), `::ffff:0:a.b.c.d`. Ở `development`, `isLinkLocalIp` không mở NAT64 nên `[64:ff9b::a9fe:a9fe]` đi qua. Muốn khai thác phải có route NAT64/6to4, nên xác suất thấp. Đề xuất: dùng allowlist "global unicast" (vd `ipaddr.js` `range()==='unicast'`), chặn phần còn lại | Thấp | Mở |
| Đa service pha 2 | **MS-P2-5 CONFIRMED (migrate trên DB có dữ liệu)**: `20261011000000_projects_api_keys` chỉ chèn project `default`. Dữ liệu cũ có `tenant_id` khác (thử `2222…`) **không có dòng `projects`**: console không thấy, không tạo được key; các bảng nghiệp vụ không có FK tới `projects` nên migrate vẫn chạy. Đề xuất: `INSERT INTO projects SELECT DISTINCT tenant_id … ON CONFLICT DO NOTHING` (slug `tenant-<8 ký tự>`) | Thấp | Mở |
| Đa service pha 2 | **MS-P2-6 CONFIRMED (T13.5)**: với 2 worker, mỗi instance tự chạy lượt riêng theo lịch ngẫu nhiên của mình. worker-1 lúc 15:10:00 xoá 3 event; worker-2 lúc 15:10:10 chạy, xoá 0. Lock chỉ chặn chạy chồng nhau, nên với N worker có N lượt/giờ (vô hại, chỉ tốn truy vấn). Đề xuất: lock giữ suốt `intervalMs` (TTL = interval, không xoá khi xong) nếu muốn đúng "một lượt mỗi chu kỳ". Ghi thêm: CORS trả `Access-Control-Allow-Origin: *` cùng `Allow-Credentials: true` (cũ) | Thấp | Mở |
| Đa service pha 2: **đạt** | `npm run verify`: L0 497/0/0, L1 75/0/0, skip 0, = baseline; `verify:map` 198 mã / 0 mồ côi / 0 ma / 0 trùng. Trên `verify:reset` sạch, phải lách seed (MS-P2-2) để T1–T15 có đủ thế giới. Smoke OK. **T1–T15 PASS** (T10 chỉ phần chức năng: timeout 5000ms "timeout tổng 5000ms", RETRYING, circuit OPEN, project bên cạnh trễ 0,7–1,1s; T14.4 Socket.IO **chưa kiểm**). Chín mục pha 1 để lại: (1) SSRF production chặn đủ, challenge tới đích chậm 30s → `timeout` sau 10,1s, redirect 302/307 → `http_30x`, delivery không theo redirect (sink 0); (2) migrate 3 migration đa service trên DB có dữ liệu cũ bằng `prisma migrate deploy` thật (DB `migtest` tạm trên postgres hubv, đã xoá): seq/source_id/created_at được backfill, cột delivery/attempt còn nguyên, FK ghép chặn chèn chéo tenant, `EventOrigin` có `api`, `scopes` NOT NULL; (3) L1 đầy đủ, skip 0; (4) `/events` `payment.received` hợp khuôn → Shop `IGNORED` (nhưng xem MS-P2-1); (5) key gắn đích Telegram → 404, GET subscriptions không lộ; (6) đổi `HUB_SIGNING_SECRET` của Shop → audit `secretRotated:true`, đơn sau đó PAID, delivery SUCCEEDED; (7) MONITOR `/events` 2 đích = eval+get+set+publish + 2×(mget+publish) = 8 ≤ 4+2×2; (8) long-poll `wait=20` ngắt ở 3s → đúng 3 truy vấn poll (log_statement), không còn sau đó; (9) xem (1). Chaos: kill worker giữa 20 publish → 20 event, 20 delivery SUCCEEDED, sink nhận mỗi `webhook-id` đúng 1 lần; Redis stop → đúng nhưng chậm (MS-P2-3). Cô lập: key bookstore gọi events / verify endpoint / inspect source của cafe, và gọi project không tồn tại → đều 404 `{"error":"not_found"}`, body và header giống hệt; console `?projectId=` lạ hoặc sai định dạng → 404. X17: diff schema chỉ đổi quan hệ subscription→destination (FK ghép), không đổi hay xoá cột delivery/attempt; tên ở §7 khớp code (`ProjectScopeGuard`, `findActiveSubscriptionsForEventType` + `findActiveSubscriptionsForEvent`, `verification`/`verification_error`/`source_ids`/`normalized`/`seq`/`source_id`, enum `api`/`generic`/`PENDING|VERIFIED|FAILED`, `EventOrigin.api`) | — | Ghi nhận |

### 7b. Sửa sau review pha 1 (dev điền)

| Mục | Commit | Kết quả | Ghi chú / X17 |
|---|---|---|---|
| MS-R1 | `3130339` | Sửa | ADR-083: IPv6 mở 8 hextet (ánh xạ/nhúng IPv4, `::`, NAT64, fc00::/7, fe80::/10), IPv4 thêm 100.64/10; `/verify` 5 lần/phút/endpoint → 429 `rate_limited` |
| MS-R2 | `4da8f29` | Sửa | ADR-084: Shop chỉ nhận `payment.received` có `source ∈ {payos, sepay}` (env `SHOP_PAYMENT_SOURCES`) |
| MS-R3 | `a3893fb` | Sửa | ADR-085: `/v1/p` subscription chỉ tới đích webhook (khác → 404), GET lọc webhook; `eventTypes` ⊆ `readTypes` → 422 `outside_read_types {field, invalid}` |
| MS-R4 | `d16433c` | Sửa | ADR-086: `POST …/endpoints/:id/verify {signingSecret?}` → `{verification, verificationError, secretRotated}`; chỉ lưu secret mới khi VERIFIED |
| MS-R5 a–d, MS-R6 phần còn lại | `7202269` | Ghi nhận | ADR-087 mục "Để lại" (lý do từng mục) |
| MS-R6 làm | `7202269` | Sửa | `api_keys.scopes`/`read_types` NOT NULL; **enum `EventOrigin` thêm `api`** (X17 — UI đọc `origin`); `/events` → `origin:'api'`; seed chỉ in prefix key |
| MS-P2-2 | `3ef6339` | Sửa | ADR-088: seed default theo dữ liệu của default, demo chạy sau; L1 trên DB tạm rỗng (migrate deploy + seed thật). `verify:reset` sạch → smoke OK không chỉnh tay |
| MS-P2-1 | `5a047c6` | Sửa | ADR-089: subscription ghim `sourceKeys`; `PATCH /v1/p/:project/subscriptions/:id {isActive}`; SDK `ensure({sourceKeys, exclusive})`; Shop ghim `SHOP_PAYMENT_SOURCE_KEYS` (mặc định `src_payos_main,src_sepay_main`). Không chặn key tạo source provider thanh toán (lý do ở ADR) |
| MS-P2-3 | `0209a98` | Sửa | ADR-090: `fastFailRedisOptions` (không offline queue, `REDIS_COMMAND_TIMEOUT_MS` 300). Redis dừng: ingest 17–44ms (trước 8,6–18,3s) |
| MS-P2-4 | `f44f711` + `cfac69b` | Sửa | ADR-091: allowlist global unicast. `f44f711` vào khi L0 đỏ 1 test chập chờn (timeout jest 5s), sửa ở `cfac69b` |
| MS-P2-5 | `a193aad` | Sửa | ADR-092: migration `20261011030000_backfill_projects_for_tenants` |
| MS-P2-6 | `b5d0f91` | Sửa | ADR-093: lock cleanup ~0,9 chu kỳ không nhả; CORS `corsOptions()` (`WEB_PUBLIC_URL`/`CORS_ORIGINS`) |
