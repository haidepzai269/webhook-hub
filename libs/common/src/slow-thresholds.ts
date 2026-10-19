/**
 * LOGGING.md §3.2/§6 (ADR-250): MỘT nơi đọc ngưỡng "chậm" + lấy mẫu log từ env — không số cứng rải rác.
 * Đọc MỘT lần lúc dùng đầu tiên (đổi env = restart, như các cấu hình khác); test truyền env tường minh.
 */
export interface SlowThresholds {
  /** `ingest.done`: total_ms vượt ngưỡng này = chậm. */
  ingestMs: number;
  /** `delivery.attempt`: dest_http (chặng gọi đích) vượt ngưỡng này = `slow.destination`. */
  deliveryMs: number;
  /** `normalize.done`: thời gian xử lý của chính handler (không tính chờ) vượt ngưỡng = chậm. */
  normalizeMs: number;
  /** queue_wait (message nằm trong hàng đợi QUÁ hạn) vượt ngưỡng = `slow.queue_wait`. */
  queueWaitMs: number;
  /** outbox_lag (created -> published) vượt ngưỡng = `slow.relay_lag`. */
  relayLagMs: number;
  /** Tiến trình trẻ hơn ngần này giây + request đầu = `slow.cold_start` / header `x-hub-cold`. */
  coldStartWindowS: number;
  /** p99 độ trễ event loop (ms) vượt ngưỡng = `slow.hub_cpu`. */
  eventLoopLagP99Ms: number;
}

export const DEFAULT_SLOW_THRESHOLDS: SlowThresholds = {
  ingestMs: 500,
  deliveryMs: 3000,
  normalizeMs: 1000,
  queueWaitMs: 5000,
  relayLagMs: 3000,
  coldStartWindowS: 60,
  eventLoopLagP99Ms: 200,
};

type Env = Record<string, string | undefined>;

function posInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

export function resolveSlowThresholds(env: Env = process.env): SlowThresholds {
  const d = DEFAULT_SLOW_THRESHOLDS;
  return {
    ingestMs: posInt(env.SLOW_INGEST_MS, d.ingestMs),
    deliveryMs: posInt(env.SLOW_DELIVERY_MS, d.deliveryMs),
    normalizeMs: posInt(env.SLOW_NORMALIZE_MS, d.normalizeMs),
    queueWaitMs: posInt(env.SLOW_QUEUE_WAIT_MS, d.queueWaitMs),
    relayLagMs: posInt(env.SLOW_RELAY_LAG_MS, d.relayLagMs),
    coldStartWindowS: posInt(env.COLD_START_WINDOW_S, d.coldStartWindowS),
    eventLoopLagP99Ms: posInt(env.EVENT_LOOP_LAG_P99_MS, d.eventLoopLagP99Ms),
  };
}

let cached: SlowThresholds | undefined;
export function slowThresholds(): SlowThresholds {
  return (cached ??= resolveSlowThresholds());
}
/** Chỉ cho test. */
export function resetSlowThresholdsForTest(): void {
  cached = undefined;
}

export interface LogSettings {
  /** Tỉ lệ ghi dòng THÀNH CÔNG (0..1). Lỗi/chậm/hoãn/DEAD luôn ghi. */
  successSample: number;
  /** Gộp dòng lặp theo (cause, source|destination) trong cửa sổ này. */
  dedupeWindowMs: number;
}

/** Deployed (Render đặt `RENDER`; hoặc `DEPLOY_ENV=deployed`) mặc định 10%; local 100% (Admin chốt 2026-10-18). */
export function resolveLogSettings(env: Env = process.env): LogSettings {
  const deployed = env.DEPLOY_ENV === 'deployed' || (env.DEPLOY_ENV !== 'local' && !!env.RENDER);
  const raw = env.LOG_SUCCESS_SAMPLE;
  const n = Number(raw);
  const sample = raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : deployed ? 0.1 : 1;
  return { successSample: sample, dedupeWindowMs: posInt(env.LOG_DEDUPE_WINDOW_MS, 30_000) };
}

/**
 * Cờ "request đầu tiên của tiến trình" (cold start): dùng chung cho header `x-hub-cold` và cause `slow.cold_start`.
 * Chỉ trong bộ nhớ (0 Redis, 0 DB). `process.uptime()` miễn phí.
 */
let coldTaken = false;
export function takeColdStart(windowS: number = slowThresholds().coldStartWindowS, uptimeS: number = process.uptime()): boolean {
  if (coldTaken) return false;
  coldTaken = true;
  return uptimeS < windowS;
}
/** Chỉ cho test. */
export function resetColdStartForTest(): void {
  coldTaken = false;
}
