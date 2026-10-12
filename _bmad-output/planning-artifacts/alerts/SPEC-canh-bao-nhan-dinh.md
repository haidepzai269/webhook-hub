# SPEC — Cảnh báo & Nhận định cho người vận hành hub (CB)

> Ghi ngày 2026-10-12. Phòng party-mode viết theo quyết định của Admin; phiên dev sẽ làm.
> Mã test: tiền tố **`CB:`** (`[CB:T1]`…). Trước khi viết test đầu tiên, thêm nguồn `CB` vào `verify/spec-sources.json`,
> nếu không `verify:map` sẽ báo mọi `[CB:Tn]` là mã ma.
> Nguồn đối chiếu: `docs/ARCHITECTURE.md` (BB-1..5, §5.4c, ADR-020/045/048/063), `docs/ERRORS.md`,
> `libs/database/prisma/schema.prisma`, `apps/hub-worker/src/{circuit,consumers,scheduler}`, `libs/common/src/mail`,
> `apps/hub-api/src/modules/realtime/realtime.gateway.ts`, `apps/web/src/components/ui/sonner.tsx`.

## 0. Admin đã quyết

| # | Quyết định |
|---|---|
| Q1 | **Người nhận là người vận hành hub** (`users.is_operator = true`). Nội dung cảnh báo phải **chi tiết theo từng project**: mỗi cảnh báo gắn đúng một project và trỏ tới đúng đối tượng trong project đó. |
| Q2 | Kênh: **chuông trong console** cho mọi cảnh báo. Cảnh báo **quan trọng ngay** thì thêm **banner/toast (phải đẹp)**. Trong **Cài đặt** có công tắc **"Gửi cảnh báo về email của tôi"**: bật lên thì gửi email, **phân loại** loại nào được gửi. |
| Q3 | Phòng **chỉ viết spec**, không code. Admin đưa spec cho phiên dev. |

Ngoài phạm vi đợt này: cảnh báo cho owner/developer của project (schema vẫn chừa chỗ, xem §3.3), Telegram/Slack,
Prometheus `rule_files` (P2, §9).

## 1. Hiện trạng (đã kiểm trong code)

- **Không có kênh cảnh báo nào ra ngoài.** Telegram self-alert vẫn là mục ⭐ chưa làm ở ROADMAP:144, ADR-063 ghi "tự cảnh báo chưa có".
- **`Destination.alertOnOpen` là cờ chết.** Cột có trong schema và `destination-view.ts` vẫn trả ra, nhưng không có code nào đọc nó. UI đang hứa một việc không làm.
- **Không có nhận định tính toán nào.** Chỉ có: badge circuit (realtime `circuit.changed`), `orphan-banner`, `health-card`, tỉ lệ thành công tổng ở `/overview`.
- **Dữ liệu đã đủ:** `DeliveryAttempt(responseStatus, durationMs, createdAt)`, `Delivery.status=DEAD`,
  `RawEvent(signatureValid, status, receivedAt)`, `SourceConnection(status, lastFix, lastCheckedAt)`, `Destination.circuitState`.
- **Một chi tiết quan trọng cho luật cảnh báo:** `delivery.consumer.ts:366` coi mọi 4xx (trừ 408/429) là non-retryable,
  nên DEAD **ngay lần thử đầu**. Vì thế endpoint trả 401 không gây "retry storm": mỗi sự kiện chết ngay và im lặng.
  Đây là trường hợp nguy hiểm nhất và đang không ai thấy.
- Socket realtime hiện **gắn một project mỗi kết nối** (`s.data.tenantId`, kiểm lại R-3 ở `realtime.gateway.ts:188`).
- Mail: `createMailSender()` ở `libs/common/src/mail` (driver `log | gmail | resend | capture`). Hiện chỉ auth dùng.
- Console chưa có trang **Cài đặt**.

## 2. Hai khái niệm, hai hình dạng

| | **Cảnh báo (alert)** | **Nhận định (insight)** |
|---|---|---|
| Bản chất | *Đẩy*: hub chủ động báo | *Kéo*: diễn giải khi người dùng mở trang |
| Có trạng thái? | Có: `OPEN → RESOLVED`, có trễ (hysteresis) | Không. Tính lúc đọc, **không lưu** |
| Ở đâu | Bảng `hub.alerts` + chuông + banner/toast + email | Câu chữ trên Tổng quan / Destinations / Sources |
| Ai tính | Job `AlertEvaluator` trong `hub-worker` | `hub-api`, truy vấn lúc đọc |

Cả hai dùng chung **một khuôn câu**: `{ title, message, fix, actions[] }`, cùng tinh thần `docs/ERRORS.md`.
Không bao giờ chỉ hiện một con số. Ví dụ, thay vì "failure 40%", viết:

> **Endpoint `bookstore-orders` từ chối xác thực (401) — 12/12 lần từ 14:02.**
> 12 sự kiện đã ngừng thử (DEAD) vì 4xx không được retry. Thường do secret phía nhận đã đổi.
> [Xem lượt giao] [Kiểm tra lại endpoint] [Phát lại DLQ]

## 3. Mô hình dữ liệu

### 3.1 `hub.alerts` (bảng nghiệp vụ, có `tenant_id`, đi qua `TenantScopedRepository`, bật RLS như các bảng khác)

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid | |
| `tenant_id` | uuid | = project. **BB-5** |
| `rule` | varchar(64) | mã luật ở §4, ví dụ `destination.auth_rejected` |
| `severity` | enum `critical \| warning \| info` | lấy từ luật, không tính lại |
| `subject_type` | enum `destination \| source \| project` | |
| `subject_id` | uuid | id đối tượng (project-level thì = tenant_id) |
| `state` | enum `OPEN \| RESOLVED` | |
| `opened_at`, `last_seen_at`, `resolved_at` | timestamptz | `last_seen_at` = lần cuối luật còn đúng |
| `facts` | jsonb | số liệu để dựng câu: `{count, total, sinceAt, httpStatus, sample: {deliveryId,…}}`. **Không** chứa payload, secret hay header |
| `acknowledged_at`, `acknowledged_by` | timestamptz, uuid? | "Đã xem". Chỉ tắt banner, **không** đóng cảnh báo |
| `email_state` | enum `NONE \| PENDING \| SENT \| SUPPRESSED \| FAILED` | outbox email, §6 |
| `email_attempts` | int | |

**Bất biến chống trùng:** `CREATE UNIQUE INDEX … ON hub.alerts (tenant_id, rule, subject_id) WHERE state = 'OPEN'`.
Hai instance worker cùng đánh giá thì chỉ một bản ghi OPEN sống sót (`INSERT … ON CONFLICT DO UPDATE SET last_seen_at, facts`).
**Postgres là trọng tài** của cảnh báo, giống BB-2. Redis không giữ gì của cảnh báo.

Index đọc: `(tenant_id, state, opened_at desc)`; `(state, severity, opened_at desc)` cho chuông của operator (đọc qua escape hatch có tên, §5.1).

### 3.2 `hub.alert_preferences` (gắn **người dùng**, không gắn tenant)

Cùng loại với `users`, nên đi qua `IdentityRepository` (như `users`/`auth_sessions`), không qua `TenantScopedRepository`.
Ghi rõ lý do này trong ADR để reviewer không bắt nhầm là lỗi BB-5.

| Cột | Ghi chú |
|---|---|
| `user_id` (PK) | chỉ operator mới tạo được |
| `email_enabled` | bool, mặc định `false` |
| `email_rules` | text[]: các luật được gửi email. Mặc định khi bật = mọi luật `critical` |
| `email_on_resolve` | bool, mặc định `false` |
| `muted_projects` | uuid[]: tắt **email** cho project này (chuông vẫn hiện) |
| `updated_at` | |

### 3.3 `alertOnOpen`

Bỏ khỏi `destination-view.ts` và mọi UI. Cột giữ lại, đánh dấu `@deprecated`, và drop ở một migration sau.
Thay bằng luật `destination.circuit_open` (§4), luôn bật, tắt email qua §3.2. Ghi ADR.
Mở rộng sau: cảnh báo cho thành viên project thì thêm `alert_reads(user_id, alert_id)`; bảng `alerts` không phải đổi.

## 4. Danh mục luật

Mọi luật **chung cho mọi provider**. Không có luật nào biết "đơn hàng" hay `payment.*` (BB-1).
Ngưỡng là hằng số trong `libs/common/src/alerts/rules.ts`, có tên, có test. Không đọc ngưỡng từ DB đợt này.

| Mã luật | Mức | Mở khi (đánh giá mỗi 60s) | Đóng khi | Câu + hành động |
|---|---|---|---|---|
| `destination.auth_rejected` | **critical** | ≥ 3 attempt **liên tiếp gần nhất** trả 401/403 trong 30 phút | 1 attempt 2xx, **hoặc** 30 phút không có attempt mới | "Từ chối xác thực ({status}) — {n}/{n} lần từ {since}. {dead} sự kiện đã DEAD (4xx không retry). Thường do secret đổi." → Xem lượt giao · Kiểm tra lại endpoint · Phát lại DLQ |
| `destination.client_error` | warning | ≥ 3 attempt liên tiếp trả 4xx khác (trừ 401/403/408/429) | như trên | "Bên nhận trả {status}: request bị từ chối về nội dung. Kiểm tra bên nhận có hiểu kiểu sự kiện." |
| `destination.failing` | warning | ≥ 10 attempt trong 15 phút **và** ≥ 50% là 5xx/timeout/lỗi mạng | tỉ lệ < 20% trong 2 lượt đánh giá liền | "Bên nhận lỗi/chậm — {pct}% của {total} lần. Hub **vẫn đang retry giúp bạn** (tầng {tier})." |
| `destination.circuit_open` | warning | `circuit_state` = OPEN | về CLOSED | "Hub tạm ngưng gửi tới đích này để bảo vệ nó. Thử lại lúc {halfOpenAt}." (thay `alertOnOpen`) |
| `delivery.dead_spike` | **critical** | ≥ 10 delivery mới DEAD trong 1 giờ trong project | < 10 trong cửa sổ 1 giờ | "{n} sự kiện đã ngừng thử trong 1 giờ." → Mở DLQ (lọc sẵn) · Phát lại hàng loạt |
| `source.signature_failing` | **critical** | ≥ 5 raw_event `signatureValid=false` trong 15 phút **và** ≥ 50% số request của source đó | < 20% trong 2 lượt | "Chữ ký sai {n}/{total}. **Hoặc secret nguồn sai, hoặc có người đang gửi request giả.**" → Xem request bị từ chối · Xoay secret |
| `source.connection_broken` | **critical** | `SourceConnection.status` ∈ {FAILED, DRIFTED} | về CONNECTED | Dùng lại `lastError` + `lastFix` có sẵn. DRIFTED: "Webhook ở phía PayOS đã bị đổi/gỡ, hub sẽ không nhận được tiền về." |
| `source.silent` | warning | Source đang active, có ≥ 20 sự kiện ACCEPTED trong 7 ngày qua, và **không có sự kiện nào trong `max(6h, 4 × khoảng cách trung vị)`** | có sự kiện mới | "Nguồn im lặng {h} giờ (bình thường ~{gap} phút một sự kiện). Provider có thể đã ngừng gửi." |
| `normalize.backlog` | warning | ≥ 1 raw_event ACCEPTED chưa chuẩn hoá quá 10 phút (cùng truy vấn với `orphan-banner`) | hết | "{n} sự kiện thô chưa được chuẩn hoá." → Chuẩn hoá lại |

Ghi chú thiết kế:
- **Phân loại theo mã HTTP chính là phần "hiểu bản chất webhook"**: 401/403 thì retry vô ích; 5xx/timeout thì hub retry;
  408/429 thì bên nhận bảo "chậm lại". Phải dùng **đúng hàm phân loại** của `delivery.consumer.ts:366` (tách ra
  `libs/common` nếu cần), không định nghĩa lại một bản thứ hai.
- `source.silent` dùng baseline của chính nguồn đó, để nguồn ít sự kiện không kêu sai. Nguồn chưa đủ 20 sự kiện/7 ngày thì không có luật này.
- **Probe không tính** (PayOS confirm probe ADR-159, GitHub `ping` ADR-162). Lọc đúng như bảng nhật ký đang lọc.
- Destination/source đã **Ngắt** (`is_active=false`) hoặc **lưu trữ** (`archived_at`) thì không mở cảnh báo mới. Cảnh báo đang OPEN của nó RESOLVED với `facts.reason='archived'|'inactive'`.

## 5. Backend

### 5.1 `AlertEvaluator` trong `hub-worker` (không tạo tiến trình mới, ADR-020)

- Mỗi 60s (`ALERT_EVAL_INTERVAL_MS`, mặc định 60000). Trong test gọi `evaluateOnce(now)` trực tiếp, có `now` tiêm vào.
- **Không dùng Redis lock.** ARCHITECTURE và `cleanup.job.ts` ghi rõ Redis lock chỉ dành cho cleanup. Dùng
  `pg_try_advisory_xact_lock(<hằng số>)` trong một transaction ngắn. Neon pooled chạy pgbouncer transaction mode,
  nên **không** dùng advisory lock mức session. Lock chỉ để tiết kiệm công; đúng đắn đến từ unique index §3.1.
- Lặp qua project. **Mỗi project truy vấn qua `TenantScopedRepository`** (BB-5). Danh sách project lấy qua `IdentityRepository`, như các job hiện có.
- Một luật = một hàm thuần `(facts) → { open: boolean, facts }` + một truy vấn tổng hợp. Mỗi luật một truy vấn, có `LIMIT`, dùng index sẵn có. Nếu thiếu index thì thêm trong migration.
- Ghi trạng thái: OPEN thì upsert, điều kiện đóng đúng thì RESOLVED. **Chỉ khi trạng thái đổi** mới `PUBLISH hub:realtime:alerts` (và đặt `email_state=PENDING` nếu cần, §6).
- **Ngân sách Redis:** evaluator không nằm trên đường nóng ingest/delivery. `redis-budget.spec.ts` **không được đổi**.
  Publish chỉ xảy ra khi trạng thái chuyển, không phải mỗi tick.
- Một luật ném lỗi thì log, tăng `hub_alert_eval_errors_total{rule}`, rồi chạy tiếp luật khác. Không được làm hỏng cả lượt.
- Metric: `hub_alerts_open{severity}` (gauge), `hub_alert_transitions_total{rule,to}`. Thêm một panel Grafana.
- Shutdown: tôn trọng `SHUTDOWN_TIMEOUT_MS=25000`. Lượt đánh giá đang chạy dừng ở ranh giới luật.

### 5.2 API (`hub-api`, chỉ operator; khuôn lỗi `{error, message, fix, docsUrl, requestId}`)

| Route | Việc |
|---|---|
| `GET /api/v1/alerts?state=&severity=&project=&cursor=` | Danh sách xuyên project, **cursor keyset** `(opened_at, id)`, cấm OFFSET (theo quyết định phân trang 2026-10-12). Mỗi dòng có `project: {id, slug, name}` |
| `GET /api/v1/alerts/summary` | `{ openBySeverity, unacked, perProject: [{project, critical, warning}] }` cho chuông |
| `POST /api/v1/alerts/:id/ack` | Đánh dấu đã xem (idempotent) |
| `POST /api/v1/alerts/ack-all?project=` | |
| `GET/PUT /api/v1/me/alert-preferences` | §3.2. Người không phải operator nhận 403 theo khuôn lỗi |
| `POST /api/v1/me/alert-preferences/test-email` | Gửi thử một email mẫu tới email của chính người dùng (rate limit 3/giờ) |
| `GET /api/v1/projects/:p/insights` | §7, tính lúc đọc |

Đọc xuyên project cho operator: dùng **escape hatch có tên** đã có tiền lệ, đặt tên rõ ràng (vd. `operatorAlertsAcrossTenants`) và có test riêng.
Mọi route khác đọc theo project dùng `TenantScopedRepository`. Ack, ack-all và đổi preferences ghi `AuditLog`.

### 5.3 Realtime

- Kênh Redis `hub:realtime:alerts`, sự kiện socket `alert.changed`, payload `{id, tenantId, rule, severity, state, title}`. Không có `facts` thô.
- Socket hiện gắn một project. Đợt này: socket chỉ đẩy cảnh báo của **project đang mở**. Chuông xuyên project lấy qua
  `GET /alerts/summary`, gọi lại khi có `alert.changed` **và** poll mỗi 30s. **Không** đụng logic kiểm lại R-3 của gateway.
  Phòng đánh đổi có chủ ý: trễ tối đa 30s cho cảnh báo ở project khác, đổi lấy việc không mở thêm một room "operator" mới.

## 6. Email

- **Chỉ gửi khi:** `alert_preferences.email_enabled` **và** `rule ∈ email_rules` **và** project không bị mute **và** người dùng là operator **và** email đã xác minh.
- **Outbox, không gửi trong transaction.** Evaluator đặt `email_state=PENDING` cùng transaction đổi trạng thái. Một vòng gửi
  riêng trong worker lấy dòng bằng `FOR UPDATE SKIP LOCKED`, gửi qua `createMailSender()`, rồi đặt `SENT`.
  Thử tối đa 3 lần, sau đó `FAILED` (log + metric). **Gửi lỗi không bao giờ chặn evaluator.**
- **Chống bão email:** tối đa **6 email/giờ/người**. Vượt trần thì đặt `SUPPRESSED`, và email kế tiếp có dòng
  "…và {k} cảnh báo khác, xem trong console". Một cảnh báo chỉ gửi **một** email lúc mở, cộng một email lúc đóng nếu `email_on_resolve`.
  Cảnh báo đang mở lại mở thêm (flapping) trong 30 phút sau khi RESOLVED thì **không gửi lại**.
- **Nội dung:**
  - Subject: `[Webhook Hub][CRITICAL][bookstore] Endpoint bookstore-orders từ chối xác thực (401)`.
  - Thân (HTML + text): tiêu đề, project, đối tượng, từ lúc nào, số liệu, **tác động** (bao nhiêu sự kiện DEAD), `fix`, nút deep link vào console (đúng bộ lọc), link tới trang Cài đặt để tắt.
  - **Cấm:** payload, header, secret, URL có query của endpoint (có thể chứa token). URL chỉ hiện host.
- Ngôn ngữ email theo ngôn ngữ người dùng đang chọn ở console (vi/en). Nếu chưa lưu thì dùng vi.
- Môi trường: local `MAIL_DRIVER=log` hoặc `capture` (test đọc file JSON). Deployed dùng driver gmail sẵn có (ADR-124).

## 7. Nhận định (insight): tính lúc đọc, không lưu

| Mã | Trang | Nội dung |
|---|---|---|
| `I-dest` | Destinations, từng dòng | Nhãn **một câu** cho 1 giờ qua: *Khoẻ* · *Từ chối xác thực* · *Lỗi/chậm phía nhận (đang retry)* · *Tạm ngưng (circuit)* · *Chưa có lượt giao*. Dùng chung bộ phân loại với §4 |
| `I-dup` | Tổng quan | **"Hôm nay hub đã chặn {n} sự kiện trùng"**, tách theo provider, kèm tooltip giải thích provider gửi lại khi nào. Đây là bằng chứng sống của BB-2/BB-3 cho giáo khảo |
| `I-silent` | Sources, từng dòng | "Sự kiện cuối {relative}" + so với nhịp bình thường của nguồn đó (cùng baseline với `source.silent`) |
| `I-dead` | Tổng quan | "{n} sự kiện đang nằm DLQ, {k} trong 24 giờ qua" + nút sang DLQ |
| `I-latency` | Destinations | **P2**: p95 `durationMs` 1 giờ qua so với 24 giờ trước |

`GET /projects/:p/insights` trả `{ code, level, title, message, fix?, actions[], facts }`. Câu chữ nằm ở **i18n phía web**
(theo khung vi/en đã dựng ở agent C); API chỉ trả `code` + `facts`. Mỗi truy vấn có cửa sổ thời gian và dùng index; `p95` trang Tổng quan không được tụt.

## 8. Console (apps/web)

> Đồ án không chấm giao diện đẹp, nhưng Admin yêu cầu toast/banner **đẹp**. Đẹp ở đây nghĩa là rõ ràng, có thứ bậc, không ồn ào.

### 8.1 Chuông: header, cạnh nút Ngôn ngữ và nút sáng/tối
- Icon chuông + **badge số** = cảnh báo OPEN chưa xem. Màu badge theo mức cao nhất (critical đỏ, warning hổ phách). Số 0 thì không có badge.
- Bấm vào mở popover rộng ~380px:
  - Nhóm **theo project** (chip tên project + số đếm). Trong nhóm, critical đứng trước rồi mới tới mới nhất.
  - Mỗi dòng: chấm mức, tiêu đề một dòng (cắt bằng `…`), thời gian tương đối, tên đối tượng. Bấm vào thì chuyển project nếu cần và mở đúng trang có bộ lọc.
  - Đáy popover: "Đánh dấu đã xem tất cả" · "Xem tất cả →" (`/dashboard/alerts`).
  - Trống thì hiện: "Mọi thứ đang ổn. Hub sẽ báo ở đây khi có chuyện." (có minh hoạ nhỏ, không dùng ảnh nặng).

### 8.2 Banner (critical): khi việc quan trọng phải biết ngay
- Dải ngang **dính đầu vùng nội dung** dashboard, dưới header: viền trái 4px màu `--danger`, nền `--danger-subtle`, icon, chip project.
  Bên trong có **câu chính + câu `fix`**, 1–2 nút hành động, và nút "Đã xem" (gọi ack).
- Nhiều critical cùng lúc thì chỉ hiện **1 banner**, kèm "+{k} cảnh báo nghiêm trọng khác" (mở chuông). Không xếp chồng 5 dải đỏ.
- Banner **vẫn ở đó qua chuyển trang** cho tới khi ack hoặc RESOLVED. Khi RESOLVED, banner đổi sang xanh "Đã ổn trở lại" trong 4s rồi thu lại.
- Hiện ra bằng trượt xuống 200ms + mờ dần. `prefers-reduced-motion` thì chỉ mờ dần. Có `role="alert"`, `aria-live="assertive"`.

### 8.3 Toast (warning, và critical vừa mở ở project khác)
- Dùng `sonner` sẵn có, với một **component toast tuỳ biến** (không dùng toast mặc định): icon mức, chip project, tiêu đề, một dòng mô tả, một nút "Xem".
- Warning tự đóng sau 6s, critical không tự đóng. Hover thì dừng đếm giờ. Tối đa 3 toast hiển thị cùng lúc.
- **Không toast lúc mới tải trang** cho cảnh báo đã cũ, chỉ toast khi có `alert.changed` mới. Không toast khi RESOLVED (chuông tự cập nhật).
- Token màu sáng/tối theo `:root` hiện có, đủ tương phản AA ở cả hai theme. Dịch vi/en.

### 8.4 Trang `/dashboard/alerts`
- Bảng **phân trang cursor** (nhóm "làm/đối soát" theo quyết định 2026-10-12). Lọc theo project, mức, trạng thái, luật; bộ lọc nằm trên URL.
- Bấm một dòng mở chi tiết: dòng thời gian (mở → lần thấy cuối → đã xem bởi ai → đóng), `facts` dạng bảng đọc được, các deep link.

### 8.5 Trang `/dashboard/settings` → mục "Cảnh báo" (chỉ operator thấy mục này)
- Công tắc **"Gửi cảnh báo về email của tôi"**, hiện email đích (chỉ đọc, là email tài khoản). Email chưa xác minh thì khoá công tắc và hiện lý do.
- Bật lên thì hiện **bảng phân loại** gồm mỗi luật một dòng: tên dễ hiểu, mô tả một câu, nhãn mức, checkbox "Gửi email".
  Mặc định tick mọi **critical**, không tick warning. Có nút "Chỉ nghiêm trọng" / "Tất cả".
- Tuỳ chọn "Gửi email khi đã ổn trở lại". Danh sách project có thể tắt email riêng.
- Nút **"Gửi email thử"**. Có ghi chú: tối đa 6 email/giờ, phần vượt được gộp.
- Mục Cài đặt nằm trong sidebar (đã thống nhất vi/en ở agent C).

## 9. P2 (không chặn đợt này)
- `prometheus.yml` thêm `rule_files` cho cảnh báo **hạ tầng** (worker chết, outbox lag, RabbitMQ không với tới). Lớp này hub
  **không tự báo được** khi chính nó sập. Phòng ghi lại: cảnh báo lớp ứng dụng đi qua hub, cảnh báo lớp hạ tầng đi qua Prometheus.
- Cảnh báo phát ra thành sự kiện chuẩn `hub.alert.opened|resolved` qua chính pipeline delivery (ý của Amelia). Hay cho
  luận điểm "thêm đích không sửa lõi", nhưng không dùng làm kênh chính, vì lúc pipeline cháy thì nó cháy theo. Nếu làm thì phải thêm vào EVENT-CATALOG + test U50.
- `I-latency`, ngưỡng tuỳ chỉnh theo destination, cảnh báo cho thành viên project.

## 10. Kiểm chứng

| Mã | Kiểm gì |
|---|---|
| CB:T1 | Mỗi luật §4: bộ dữ liệu ngay dưới ngưỡng thì không mở; ngay trên ngưỡng thì mở; điều kiện đóng thì RESOLVED (hàm thuần + `now` tiêm vào) |
| CB:T2 | Hai evaluator chạy **song song** trên cùng DB thì đúng **1** dòng OPEN cho mỗi `(tenant, rule, subject)` |
| CB:T3 | Redis tắt thì evaluator vẫn mở/đóng cảnh báo đúng, chỉ mất realtime (BB-2) |
| CB:T4 | 401 ba lần liên tiếp thì `destination.auth_rejected` mở với `facts.dead` đúng; 1 lần 2xx thì đóng |
| CB:T5 | Probe PayOS/GitHub ping không làm mở `source.signature_failing` hay `source.silent` |
| CB:T6 | Destination bị Ngắt/lưu trữ thì cảnh báo đang mở RESOLVED với lý do, và không mở mới |
| CB:T7 | Không mở flapping: RESOLVED rồi mở lại trong 30 phút thì không có email thứ hai |
| CB:T8 | Email: tôn trọng `email_enabled`, `email_rules`, `muted_projects`, email chưa xác minh. Trần 6/giờ thì SUPPRESSED + dòng "…và k khác". Driver `capture` đọc file |
| CB:T9 | Email **không** chứa payload, secret, query string của URL endpoint (quét nội dung thư capture) |
| CB:T10 | Người không phải operator gọi `/alerts*`, `/me/alert-preferences` nhận 403 khuôn lỗi. Project A không đọc được alert project B qua route theo project (RLS) |
| CB:T11 | `redis-budget.spec.ts` không đổi và vẫn xanh |
| CB:T12 | `/alerts` cursor: không trùng, không sót dòng khi có dòng mới chen vào giữa hai trang |
| CB:T13 | Gửi email lỗi (driver ném lỗi) thì evaluator vẫn chạy, `email_state=FAILED` sau 3 lần |
| CB:T14 | `alertOnOpen` không còn trong response `destination-view` |
| CB:T15 | Web: banner không hiện cho cảnh báo cũ lúc tải trang; critical mới thì hiện 1 banner + "+k"; `prefers-reduced-motion` thì không trượt |
| CB:T16 | Insight `I-dest` dùng **cùng** hàm phân loại với `delivery.consumer` (đổi một chỗ thì test bên kia biết) |

## 11. Story

| Story | Nội dung | Phụ thuộc |
|---|---|---|
| **CB1** | Migration `alerts` + `alert_preferences` + RLS + index; `rules.ts` (ngưỡng + hàm thuần); tách hàm phân loại HTTP ra `libs/common` | — |
| **CB2** | `AlertEvaluator` trong worker (advisory xact lock, upsert, publish khi đổi trạng thái, metrics) | CB1 |
| **CB3** | API §5.2 + realtime `alert.changed` + escape hatch operator có tên | CB1 |
| **CB4** | Console: chuông + banner + toast tuỳ biến + `/dashboard/alerts` | CB3 |
| **CB5** | Cài đặt + email outbox + mẫu thư vi/en + gửi thử | CB2, CB3 |
| **CB6** | Insights `I-dest`, `I-dup`, `I-silent`, `I-dead` | CB1 |
| **CB7** | Bỏ `alertOnOpen` khỏi view/UI; ADR; ARCHITECTURE §5.4c + ROADMAP:144 cập nhật; `verify/spec-sources.json` thêm `CB`; Grafana panel | song song |

Thứ tự gợi ý nếu thiếu thời gian trước buổi bảo vệ: **CB1 → CB2 → CB3 → CB4 (chuông + banner) → CB6 (`I-dup`, `I-dest`) → CB5**.
Cắt được: `/dashboard/alerts` chi tiết, `I-silent`, `source.silent`. **Không cắt được:** CB7 phần `alertOnOpen` (UI đang nói dối).

## 12. ADR cần ghi (grep số trước khi ghi, log append-only)
1. Cảnh báo = bảng Postgres + evaluator trong `hub-worker`. Unique index một phần làm trọng tài; advisory xact lock chỉ để tiết kiệm công; không dùng Redis lock, không tạo tiến trình mới.
2. `alert_preferences` gắn người dùng nên đi qua `IdentityRepository`, không có `tenant_id`. Đây có chủ ý, không phải lỗ BB-5.
3. Bỏ `alertOnOpen` và thay bằng luật `destination.circuit_open`.
4. Email: outbox + SKIP LOCKED, trần 6/giờ/người, chỉ lúc mở (và lúc đóng nếu chọn); nội dung không chứa payload/secret.
5. Chuông xuyên project dùng poll 30s + socket theo project đang mở, không mở room operator (đánh đổi trễ ≤ 30s).

## 13. Bất biến phải giữ (reviewer kiểm)
- BB-1: không luật nào biết nghiệp vụ (đơn hàng, số tiền). · BB-2: Redis mất thì cảnh báo vẫn đúng. · BB-3: không đụng thứ tự ingest.
- BB-4: không tiến trình mới. · BB-5: `alerts` có `tenant_id` + RLS, đọc xuyên project chỉ qua escape hatch có tên.
- Thêm provider mới **không** phải sửa evaluator: luật dựa trên `raw_events`/`deliveries` chung, không có `if (provider === …)`.
