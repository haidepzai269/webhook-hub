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
| S0 | | | |
| S3-1 | `7310537` | `signature-s3-1.spec.ts` (15) | ADR-058; `signature_header` chuỗi trần (dòng cũ có ngoặc kép); hash body cả GitHub/Stripe |
| S3-2 (= lõi S14) | `bb9ef98` | canonical-* (U34–U44, U50), `normalize-canonical.spec.ts` (U45), `webhook-body-normalized.spec.ts`, Shop `readPayment` | ADR-059; migration `20261010030000_event_normalized_flag`; validator từ chối cả khoá lạ |
| S3-3 | `0d62668` | `event-pattern.spec.ts`, `subscription-pattern.spec.ts`, `subscription-match-db.spec.ts` | ADR-060; 400 trả `{error:"invalid_event_pattern"}` |
| S1 | | | |
| S2 | | | |
| S3 | | | |
| S4 | | | |
| S5 (+S3-3) | | | |
| S6 | | | |
| S7 | | | |
| S10 | | | |
| S8 | | | |
| S9 | | | |
| S14 | (lõi trong S3-2 `bb9ef98`) | U34–U45, U50 | Phần đa service (POST /events, mapping, SDK) hoãn |
| S11 | | | |
| S12 | | | |
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
