import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { GrowthWindow, resolveGrowth, setCanonicalObserver, slowThresholds } from '@hub/common';

/**
 * Chỉ số Prometheus của hub-api (S3-4). Đếm TRONG BỘ NHỚ của tiến trình — 0 lệnh Redis (ngân sách R1).
 * Registry riêng (không dùng registry toàn cục) để test độc lập.
 */
export const apiRegistry = new Registry();
collectDefaultMetrics({ register: apiRegistry });

export const ingestRequests = new Counter({
  name: 'hub_ingest_requests_total',
  help: 'Số request webhook vào /hooks theo provider và kết quả',
  labelNames: ['provider', 'outcome', 'cause'] as const,
  registers: [apiRegistry],
});

export const ingestDuration = new Histogram({
  name: 'hub_ingest_duration_seconds',
  help: 'Thời gian xử lý một request /hooks (nhận -> COMMIT -> ACK)',
  labelNames: ['provider'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [apiRegistry],
});

/**
 * ADR-180: kiểm email đã tồn tại qua Bloom filter. `negative` = filter nói chưa có (0 truy vấn DB);
 * `positive_confirmed` / `false_positive` = filter nói có, DB xác nhận / bác bỏ; `db_fallback` = filter chưa sẵn sàng
 * hoặc đã vượt dung lượng -> hỏi thẳng DB.
 */
export const emailFilterChecks = new Counter({
  name: 'hub_email_filter_checks_total',
  help: 'Số lần kiểm email đã tồn tại theo kết quả của Bloom filter',
  labelNames: ['result'] as const,
  registers: [apiRegistry],
});

export const emailFilterSize = new Gauge({
  name: 'hub_email_filter_size',
  help: 'Số email đã nạp vào Bloom filter của instance này',
  registers: [apiRegistry],
});

/**
 * EG2 (SPEC-chong-qua-tai §4.2, ADR-177): hộp phạt IP trong bộ nhớ của `/hooks/*`. `reason` chỉ có hai giá trị cố định
 * (không gắn IP/sourceKey vào nhãn — tránh nổ cardinality).
 */
export const penaltyBans = new Counter({
  name: 'hub_ingest_penalty_bans_total',
  help: 'Số lần hộp phạt bắt đầu tạm chặn (unknown_source = IP; bad_signature = cặp IP + sourceKey)',
  labelNames: ['reason'] as const,
  registers: [apiRegistry],
});

export const penaltyBlocked = new Counter({
  name: 'hub_ingest_penalty_blocked_total',
  help: 'Số request /hooks bị hộp phạt chặn (429 ip_temporarily_blocked)',
  labelNames: ['reason'] as const,
  registers: [apiRegistry],
});

/** Đính chính ADR-177: đủ ngưỡng nhưng KHÔNG phạt — `capacity` (số ban chạm trần). */
export const penaltyBansSkipped = new Counter({
  name: 'hub_ingest_penalty_bans_skipped_total',
  help: 'Số lần đủ ngưỡng phạt nhưng không phạt vì số ban đã chạm trần (capacity)',
  labelNames: ['reason', 'cause'] as const,
  registers: [apiRegistry],
});

export const penaltyEntries = new Gauge({
  name: 'hub_ingest_penalty_entries',
  help: 'Số khoá hộp phạt đang giữ trong bộ nhớ của instance này (có trần EDGE_PENALTY_MAX_ENTRIES)',
  registers: [apiRegistry],
});

export const unknownSourceTotal = new Counter({
  name: 'hub_ingest_unknown_source_total',
  help: 'Số request /hooks có sourceKey không tồn tại (404, không thuộc tenant nào — không lưu vào DB)',
  registers: [apiRegistry],
});

/** EG4 (ADR-179): số request lưu lượng bị bỏ vì ghi DB lỗi quá trần bộ đệm 10 phút (số liệu quan sát được phép thiếu). */
export const trafficFlushDropped = new Counter({
  name: 'hub_traffic_flush_dropped_total',
  help: 'Số request của bảng lưu lượng theo source bị bỏ vì ghi Postgres lỗi quá trần bộ đệm 10 phút',
  registers: [apiRegistry],
});

/** D9: request /hooks có IP loopback/private — hộp phạt bỏ qua. > 50% lưu lượng /hooks (trừ provider api) = cấu hình IP thật sai. */
export const penaltySkippedPrivate = new Counter({
  name: 'hub_ingest_penalty_skipped_private_total',
  help: 'Số request /hooks hộp phạt không chấm điểm vì IP loopback/private/dùng chung (đếm một lần mỗi request)',
  registers: [apiRegistry],
});

/** Review lượt 3: tổng số cặp tốt (ip, sourceKey) trong bộ nhớ — có trần EDGE_PENALTY_GOOD_MAX_ENTRIES. */
export const penaltyGoodEntries = new Gauge({
  name: 'hub_ingest_penalty_good_entries',
  help: 'Số cặp (IP, sourceKey) đã verify đúng đang nhớ ở instance này (trần EDGE_PENALTY_GOOD_MAX_ENTRIES)',
  registers: [apiRegistry],
});

/** QT3 (ADR-182/189): request bị 507 `project_storage_full` (khoá chiều ghi, `STORAGE_LOCK_ENABLED=1`). */
export const storageRejectedTotal = new Counter({
  name: 'hub_ingest_storage_rejected_total',
  help: 'Số request /hooks + publish bị 507 vì project đầy hạn mức dung lượng',
  labelNames: ['path'] as const,
  registers: [apiRegistry],
});

/** QT E5 (ADR-189): `STORAGE_LOCK_ENABLED=0` — request LẼ RA bị 507 nếu bật khoá (vẫn được nhận). */
export const storageWouldRejectTotal = new Counter({
  name: 'hub_ingest_storage_would_reject_total',
  help: 'Số request /hooks + publish lẽ ra bị 507 nếu bật STORAGE_LOCK_ENABLED (khoá đang tắt nên vẫn nhận)',
  labelNames: ['path'] as const,
  registers: [apiRegistry],
});

/** QT4b (§5.6, ADR-187): gợi ý bị hàng rào `assertSuggestionSafe` loại khi `apply` tính lại (cùng tên metric với hub-worker). */
export const cleanupSuggestionsRejectedApi = new Counter({
  name: 'hub_cleanup_suggestions_rejected_total',
  help: 'Số gợi ý dọn bị hàng rào an toàn loại, theo advisor',
  labelNames: ['advisor'] as const,
  registers: [apiRegistry],
});

// ---- LOGGING.md §7 (ADR-250): metric nối với log — nhãn `cause` là enum đóng (~33 giá trị), KHÔNG tenant/source/destination ----

/** Mỗi canonical line ĐÃ GHI hoặc BỊ LẤY MẪU BỎ đều đếm ở đây — số trên Grafana không phụ thuộc mẫu log. */
export const logEventsTotal = new Counter({
  name: 'hub_log_events_total',
  help: 'Số dòng canonical log (ghi hoặc bị lấy mẫu bỏ) theo svc, msg, cause',
  labelNames: ['svc', 'msg', 'cause'] as const,
  registers: [apiRegistry],
});

export const slowTotal = new Counter({
  name: 'hub_slow_total',
  help: 'Số lần vượt ngưỡng chậm theo nguyên nhân slow.* (ngưỡng SLOW_*_MS)',
  labelNames: ['svc', 'cause'] as const,
  registers: [apiRegistry],
});

export const stageDuration = new Histogram({
  name: 'hub_stage_duration_seconds',
  help: 'Thời gian từng chặng của một request ingest (verify, redis, db_read, db_commit, ack_build, other…)',
  labelNames: ['svc', 'stage'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [apiRegistry],
});

/** p99 độ trễ event loop (giây) — cờ `slow.hub_cpu`; đọc mỗi nhịp 5s, trong bộ nhớ. */
export const eventLoopLag = new Gauge({
  name: 'hub_event_loop_lag_seconds',
  help: 'p99 độ trễ event loop của tiến trình (perf_hooks.monitorEventLoopDelay)',
  registers: [apiRegistry],
});

export const growthTotal = new Counter({
  name: 'hub_growth_total',
  help: 'Số cửa sổ growth.window kích hoạt theo nguyên nhân growth.*',
  labelNames: ['cause'] as const,
  registers: [apiRegistry],
});

/** `growth.window` của hub-api (burst_source, dup_flood): tổng hợp trong bộ nhớ từ chính các canonical line; ticker 60s ở main.ts. */
export const apiGrowth = new GrowthWindow(resolveGrowth(), slowThresholds().queueWaitMs);

setCanonicalObserver((b) => {
  if (b.svc !== 'hub-api') return;
  apiGrowth.observe(b);
  logEventsTotal.inc({ svc: b.svc, msg: String(b.record.msg), cause: b.cause ?? '' });
  if (b.slowCause) slowTotal.inc({ svc: b.svc, cause: b.slowCause });
  for (const [stage, ms] of Object.entries(b.stageMs)) if (typeof ms === 'number' && ms > 0) stageDuration.observe({ svc: b.svc, stage }, ms / 1000);
  if (b.record.msg === 'growth.window' && b.cause) growthTotal.inc({ cause: b.cause });
});
