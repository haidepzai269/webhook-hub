# Phụ lục kỹ thuật — các câu cần sửa cho khớp code (S3-6)

> Ngày 10/10/2026, phiên dev (Amelia). **Không sửa file .docx** — Admin tự sửa.
>
> **Nguồn "câu cũ":** file `C:\Users\admin\Downloads\PhuLuc_MoTaYeuCauKyThuat_WebhookHub.docx` **không còn ở đường dẫn đó** lúc làm (đã tìm trong Downloads/Documents/Desktop). Câu cũ dưới đây lấy nguyên văn từ trích dẫn trong biên bản kiểm chứng `_bmad-output/party-mode/kiem-chung-phu-luc-2026-10-09.html` (BB09, 9 câu). Phần "Thông số kỹ thuật" (số đo) của phụ lục **không** được BB09 trích, nên không đối chiếu được câu chữ — xem mục 10 để lấy số đo mới.
>
> Commit tham chiếu: `7310537` (S3-1), `bb9ef98` (S3-2), `0d62668` (S3-3), `db67292` (S3-4), `8292940` (S3-5) và đợt 9/10 `0b2cef4`.

---

## 1. Xác thực chữ ký

**Câu cũ:** "PayOS: checksum HMAC-SHA256 trên dữ liệu đã sắp xếp khoá; SePay: header Authorization dạng Apikey; GitHub: X-Hub-Signature-256 trên nội dung gốc, so sánh an toàn bằng crypto.timingSafeEqual."

**Câu mới:** "PayOS: checksum HMAC-SHA256 trên trường `data` đã sắp xếp khoá, tính bằng SDK chính chủ, so sánh bằng `crypto.timingSafeEqual`; GitHub: HMAC-SHA256 trong `X-Hub-Signature-256` tính trên **bytes gốc** của body; Stripe: `Stripe-Signature` (SDK chính chủ, bytes gốc, lệch giờ ≤ 5 phút). SePay **không ký nội dung**: xác thực bằng **API key dùng chung** trong header `Authorization: Apikey <key>` (bắt buộc đúng tiền tố), so sánh bằng `timingSafeEqual`. Mọi phép so sánh chữ ký/khoá đều dùng `timingSafeEqual`. Khoá chống trùng dự phòng là hash SHA-256 của body, không bao giờ ngẫu nhiên."

**Bằng chứng:**
- `libs/providers/src/payos.adapter.ts` — `verify()` gọi `crypto.createSignatureFromObj` rồi `timingSafeCompare`; không còn `webhooks.verify(`.
- `libs/providers/src/sepay.adapter.ts` — regex `^apikey[ ]+(\S+)\s*$`, thiếu tiền tố → false.
- `libs/providers/test/signature-s3-1.spec.ts` — spy `crypto.timingSafeEqual` được gọi; SePay thiếu tiền tố → false; cùng body → cùng khoá.
- Docker 10/10: PayOS ký đúng → 200, sai 1 ký tự → 401; SePay `Authorization: <key>` (không tiền tố) → 401 (REVIEW-CHECKLIST dòng 5–8).

## 2. Cấu trúc sự kiện sau chuẩn hoá

**Câu cũ:** "Chuẩn hoá mọi sự kiện về một cấu trúc chung, lấy cảm hứng từ CloudEvents, tách biệt khỏi nghiệp vụ nguồn gửi."

**Câu mới:** "Chuẩn hoá về **một đầu ra duy nhất**: phong bì chung (`id, type, source, subject, occurredAt, receivedAt, normalized, data`) và **catalog kiểu chuẩn** có validator cho hai miền — thanh toán (`payment.received / sent / failed / refunded`, chung các trường `amount` số nguyên đơn vị nhỏ nhất, `currency`, `memo`, `reference`, …) và mã nguồn (`repo.push`, `repo.pull_request.*`, `repo.issue.*`). Cùng một khoản tiền qua PayOS hay SePay ra **cùng một hình dạng dữ liệu**. Kiểu chưa có ánh xạ ra `<provider>.<kiểu gốc>` với `normalized:false`. Body gốc luôn giữ trong `data.raw`. Có bảng ánh xạ sang CloudEvents 1.0 trong tài liệu (body không đổi sang CloudEvents)."

**Bằng chứng:**
- `libs/common/src/canonical/` (validator viết tay), `docs/EVENT-CATALOG.md`.
- `libs/providers/test/canonical-same-shape.spec.ts` (U37: PayOS và SePay cùng tập khoá), `canonical-contract.spec.ts` (U50: 14 fixture khớp catalog tuyệt đối).
- Docker 10/10: hai đơn 69.000đ trả qua PayOS và SePay → `jsonb_object_keys(data - 'raw')` giống hệt; PayOS `code:"01"` → `payment.failed` (REVIEW-CHECKLIST dòng 9–11).

## 3. Định tuyến và phân phối

**Câu cũ:** "Định tuyến và phân phối sự kiện đã chuẩn hoá đến nhiều đích (webhook tuỳ chỉnh, Telegram, Discord) theo subscription loại sự kiện quan tâm."

**Câu mới:** "Định tuyến theo subscription khớp **chính xác hoặc theo mẫu** (`payment.*` = mọi sự kiện thanh toán, `*` = mọi sự kiện) bằng một truy vấn ứng viên; mẫu sai ngữ pháp bị từ chối (400). Phân phối tới webhook tuỳ chỉnh (ký HMAC `X-Hub-Signature: v1=…` trên `{id}.{timestamp}.{body}`), Telegram (văn bản thuần) và Discord, template `{{path}}` theo từng subscription. Message trong hàng đợi chỉ mang tham chiếu; cấu hình đích được giải mã lúc gửi, không đi qua broker."

**Bằng chứng:** `libs/common/src/event-pattern.ts`; `libs/database/test/subscription-match-db.spec.ts` (Postgres thật: `payment.*` khớp `payment.failed`, không khớp `paymentx.y`); `apps/hub-api/test/subscription-pattern.spec.ts`; ADR-042, ADR-060; Docker: subscription `payment.*` nhận `payment.failed` (REVIEW-CHECKLIST dòng 12).

## 4. Không trùng, không mất

**Câu cũ:** "Transactional Outbox kết hợp 5 lớp chống trùng (Redis đệm nhanh, PostgreSQL trọng tài) và manual ack với RabbitMQ."

**Câu mới:** "**Mọi chặng** đều qua Transactional Outbox (ingest → normalize và normalize → delivery), relay `FOR UPDATE SKIP LOCKED` + publisher confirm, kèm sweeper cứu delivery kẹt và lease chống gửi trùng. Chống trùng nhiều lớp: Redis (đường tắt, được phép sai, ghi **sau** COMMIT), `UNIQUE(source_id, idempotency_key)` của `raw_events` (trọng tài), `UNIQUE(raw_event_id)` của `events`, `UNIQUE(event_id, subscription_id, attempt_generation)` của `deliveries`, `processed_messages` ghi cùng transaction với kết quả. Manual ack; lỗi tạm ở normalize thử lại có giới hạn, lỗi vĩnh viễn phát lại được từ `raw_events`."

**Bằng chứng:** `apps/hub-worker/src/consumers/normalize.consumer.ts` (outbox `delivery.requested`, không `channel.publish`); `apps/hub-worker/src/scheduler/delivery.sweeper.ts`; `delivery-lease-sweeper.spec.ts` (Postgres thật); ADR-043, ADR-044; `docs/ARCHITECTURE.md` §5.1–5.2 (đã sửa 10/10).

## 5. Retry, circuit breaker, throttle

**Câu cũ:** "Tự động thử lại theo nhiều mức thời gian tăng dần, kết hợp circuit breaker và giới hạn tốc độ gửi ra theo từng đích."

**Câu mới:** "Thử lại 5 tầng thời gian tăng dần (10s · 1m · 5m · 30m · 2h), mỗi tầng một queue TTL của RabbitMQ — **không có jitter ở tầng retry** (TTL của queue không cho ngẫu nhiên theo từng message); lỗi 4xx (trừ 408/429) dừng ngay. Circuit breaker **3 trạng thái** (CLOSED → OPEN sau 5 lỗi phía đích → HALF_OPEN với đúng một probe) theo từng đích. Giới hạn tốc độ gửi ra theo từng đích bằng **cửa sổ cố định 1 giây** (không phải token bucket; lệch tối đa 2× ở mép cửa sổ)."

**Bằng chứng:** `libs/messaging/src/topology.ts`; `apps/hub-worker/src/circuit/circuit-breaker.service.ts` (`checkThrottle` cửa sổ 1s, Lua probe); `circuit-breaker.spec.ts`; `grep -rni "token bucket" apps/*/src libs/*/src` = 0; `docs/ARCHITECTURE.md` §5.4, §5.4b, §5.4c "Cố tình không làm".

## 6. DLQ, Replay, audit log

**Câu cũ:** "Dead Letter Queue cho sự kiện thất bại vĩnh viễn, kèm Replay từng sự kiện hoặc hàng loạt, có audit log."

**Câu mới:** "Sự kiện thất bại vĩnh viễn được lưu ở trạng thái `DEAD` trong PostgreSQL — **nguồn sự thật của DLQ là Postgres**, hàng đợi DLQ của RabbitMQ chỉ là bản sao để quan sát (có giới hạn 5000). Replay từng delivery hoặc hàng loạt (≤ 500, bắt buộc lý do, có chạy thử `dryRun`), chuẩn hoá lại raw event mồ côi; mọi thao tác ghi `audit_logs` cùng transaction."

**Bằng chứng:** `GET /api/v1/dlq` đọc `deliveries.status='DEAD'`; `POST /api/v1/deliveries/replay-bulk`; `replay-bulk-db.spec.ts`; ADR-050, ADR-052; REVIEW-CHECKLIST dòng 28–29.

## 7. Dashboard realtime

**Câu cũ:** "Hiển thị trực tiếp luồng sự kiện, trạng thái phân phối và trạng thái circuit breaker qua Socket.IO."

**Câu mới:** giữ nguyên câu, có thể thêm: "Socket.IO xác thực JWT ở handshake, phát theo room từng tenant: `trace.ingested`, `event.received`, `delivery.attempt`, `circuit.changed`, `metrics.tick`."

**Bằng chứng:** `apps/hub-api/src/modules/realtime/realtime.gateway.ts`; `realtime-auth.spec.ts`; ADR-049.

## 8. API polling

**Câu cũ:** "Cung cấp API truy vấn (polling) sự kiện cho các hệ thống đích không thể nhận webhook đẩy đến."

**Câu mới:** **chưa sửa được trong đợt này** — `GET /api/v1/events` vẫn sắp giảm dần, `after` đi lùi, chỉ dùng JWT admin. Feed tăng dần + API key thuộc đợt đa service (đang hoãn, DINH-CHINH §0). Đề nghị: tạm ghi "Cung cấp API truy vấn sự kiện (dashboard); feed polling cho hệ thống bên ngoài là hướng phát triển".

**Bằng chứng:** REVIEW-CHECKLIST dòng 33 (⏭).

## 9. Multi-tenant

**Câu cũ:** "Mọi bảng nghiệp vụ gắn tenant_id và mọi truy vấn bắt buộc đi qua lớp kiểm soát phạm vi."

**Câu mới:** "Mọi bảng nghiệp vụ gắn `tenant_id` (trực tiếp hoặc qua khoá ngoại cha) và mọi truy vấn nghiệp vụ đi qua `TenantScopedRepository`; tạo subscription kiểm đích cùng tenant (404); Shop dùng user DB riêng chỉ thấy schema `shop`. Hiện chạy một tenant; bảng tenants, khoá ngoại ghép và RLS là hướng phát triển."

**Bằng chứng:** `subscription-tenant.spec.ts`; ADR-046; REVIEW-CHECKLIST dòng 34–36.

## 10. Số đo (thông số kỹ thuật) — lấy từ hệ thống đã có công cụ

Công cụ đo đã có từ S3-4: `GET /metrics` (hub-api, hub-worker), Grafana dashboard "Webhook Hub", `k6/ingest-github.js`.

| Thông số | Số đo 10/10 (LOCAL, máy dev, chạy thử ngắn) | Lệnh |
|---|---|---|
| p95 ingest (k6, 10→50→100 RPS, mỗi bậc 20s, 2299 request) | **23,6 ms**, lỗi 0% | `k6/README.md` |
| p95 ingest theo Prometheus | ≈ 24 ms | `histogram_quantile(0.95, …hub_ingest_duration_seconds_bucket…)` |
| Outbox lag lớn nhất ở bậc 100 RPS | ≈ 21 s (xả hết sau ~30 s) | `max(hub_outbox_lag_seconds)` |
| Lệnh Redis / sự kiện | ingest 3 + normalize 1 + 2/đích → 1 đích = 6, 2 đích = 8, **kể cả đích có throttle** (MONITOR docker: 2 đích có `rate_limit_rps` = 8 lệnh client; trước review #2 là 10) | `redis-budget.spec.ts`, ADR-062, ADR-064 |

> Câu trong phụ lục kiểu "≤ 4 lệnh Redis mỗi sự kiện" phải đổi thành "≤ 4 lệnh cố định mỗi sự kiện + ≤ 2 lệnh mỗi đích" (R1). Số này đếm một `EVAL` là một lệnh — **chưa xác nhận** Upstash tính như vậy (DEPLOYMENT §5.2). Số p95 nên chạy lại k6 đủ 60s/bậc trước khi ghi vào báo cáo chính thức; outbox lag ở 100 RPS là điểm yếu thật, nên ghi trung thực.
