import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Chỉ số Prometheus của hub-api (S3-4). Đếm TRONG BỘ NHỚ của tiến trình — 0 lệnh Redis (ngân sách R1).
 * Registry riêng (không dùng registry toàn cục) để test độc lập.
 */
export const apiRegistry = new Registry();
collectDefaultMetrics({ register: apiRegistry });

export const ingestRequests = new Counter({
  name: 'hub_ingest_requests_total',
  help: 'Số request webhook vào /hooks theo provider và kết quả',
  labelNames: ['provider', 'outcome'] as const,
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
