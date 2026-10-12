/**
 * CB6 (SPEC-canh-bao-nhan-dinh §7): NHẬN ĐỊNH (insight) — tính LÚC ĐỌC, không lưu, không trạng thái. Mỗi nhận định là MỘT
 * hàm thuần `(dữ liệu đã tổng hợp, now) → Insight`; API (`hub-api`) chỉ trả `code + level + facts (+ actions)`, câu chữ
 * dựng ở web (i18n vi/en) — cùng tinh thần cảnh báo (ADR-170).
 *
 * Không định nghĩa bản thứ hai của bất kỳ phán đoán nào đã có:
 * - `I-dest` phân loại HTTP bằng CHÍNH `classifyHttpOutcome` / `isRetryableFailure` mà `delivery.consumer` dùng để quyết
 *   retry / DEAD (`../http-outcome`, CB:T16) và ngưỡng tỉ lệ của luật `destination.failing`.
 * - `I-silent` dùng CHÍNH `evalSourceSilent` + `silenceThresholdMs` của luật `source.silent` (cùng baseline 7 ngày, cùng
 *   truy vấn `findSourceActivity`).
 * - `I-dead` đếm ĐÚNG tập DLQ (DEAD + chưa bị replay) trừ D9 (DEAD vì đích/subscription lưu trữ) — như `delivery.dead_spike`.
 * BB-1: không biết nghiệp vụ; không `if (provider === …)` — provider chỉ là nhãn dữ liệu trong `I-dup`.
 */
import { classifyHttpOutcome, isRetryableFailure, type HttpOutcome } from '../http-outcome';
import { FAILING_OPEN_RATIO, SILENT_MIN_BASELINE_EVENTS, evalSourceSilent, silenceThresholdMs, type SubjectLifecycle } from './rules';

const HOUR = 3_600_000;

export const INSIGHT_CODES = ['I-dest', 'I-dup', 'I-silent', 'I-dead'] as const;
export type InsightCode = (typeof INSIGHT_CODES)[number];
/** `ok` = không có gì phải làm (vẫn trả để web nói "Khoẻ" thay vì im lặng). */
export type InsightLevel = 'ok' | 'info' | 'warning' | 'critical';
export type InsightSubjectType = 'destination' | 'source' | 'project';

/** Hành động gợi ý — web ánh xạ `code` sang đường dẫn (không trả URL từ API). */
export interface InsightAction {
  code: 'open_dlq' | 'view_deliveries' | 'view_events';
  params?: Record<string, string>;
}

export interface Insight<F extends Record<string, unknown> = Record<string, unknown>> {
  code: InsightCode;
  level: InsightLevel;
  subjectType: InsightSubjectType;
  subjectId: string;
  facts: F;
  actions?: InsightAction[];
}

const iso = (d: Date) => d.toISOString();

// ------------------------------------------------------------------ I-dest (Destinations, từng dòng)

/** Cửa sổ của nhãn đích: 1 giờ qua. */
export const INSIGHT_DEST_WINDOW_MS = HOUR;

export type DestHealth = 'healthy' | 'auth_rejected' | 'client_error' | 'receiver_failing' | 'circuit_open' | 'no_deliveries';

export interface DestInsightInput {
  destinationId: string;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /** Số attempt theo HTTP status trong `INSIGHT_DEST_WINDOW_MS` (null/0 = không phản hồi). */
  statusCounts: { status: number | null; n: number }[];
  /** Attempt mới nhất trong cửa sổ (null nếu không có). */
  latest: { status: number | null; at: Date } | null;
}

export interface DestInsightFacts extends Record<string, unknown> {
  health: DestHealth;
  total: number;
  success: number;
  /** Thất bại hub SẼ retry (5xx/timeout/mạng/408/429/1xx-3xx) — cùng định nghĩa với `destination.failing`. */
  retrying: number;
  byOutcome: Record<HttpOutcome, number>;
  lastStatus: number | null;
  lastAt: string | null;
  circuitState: DestInsightInput['circuitState'];
  windowFrom: string;
}

const LEVEL_OF_HEALTH: Record<DestHealth, InsightLevel> = {
  healthy: 'ok',
  no_deliveries: 'info',
  circuit_open: 'warning',
  receiver_failing: 'warning',
  client_error: 'warning',
  auth_rejected: 'critical',
};

function emptyOutcomes(): Record<HttpOutcome, number> {
  return { success: 0, auth_rejected: 0, client_error: 0, throttled: 0, server_error: 0, no_response: 0, unexpected: 0 };
}

/**
 * Nhãn MỘT câu cho 1 giờ qua. Thứ tự quyết định (mỗi bước dùng hàm phân loại chung):
 *  1. circuit OPEN/HALF_OPEN -> "Tạm ngưng (circuit)" — hub đang tự hoãn, đó là điều người xem cần biết trước tiên;
 *  2. không attempt nào -> "Chưa có lượt giao";
 *  3. attempt MỚI NHẤT là 401/403 -> "Từ chối xác thực" (non-retryable: DEAD ngay, im lặng);
 *  4. attempt mới nhất là 4xx khác -> "Bên nhận từ chối nội dung" (cũng non-retryable);
 *  5. mới nhất là thất bại hub sẽ retry, HOẶC ≥ `FAILING_OPEN_RATIO` số attempt là loại đó -> "Lỗi/chậm phía nhận (đang retry)";
 *  6. còn lại -> "Khoẻ".
 * Lấy attempt MỚI NHẤT cho 401/4xx: đã sửa secret (2xx sau chuỗi 401) thì nhãn hết đỏ ngay, không chờ cửa sổ trôi.
 */
export function buildDestInsight(input: DestInsightInput, now: Date): Insight<DestInsightFacts> {
  const byOutcome = emptyOutcomes();
  let total = 0;
  let retrying = 0;
  for (const { status, n } of input.statusCounts) {
    if (!(n > 0)) continue;
    total += n;
    byOutcome[classifyHttpOutcome(status)] += n;
    if (isRetryableFailure(status)) retrying += n;
  }
  const latest = input.latest;
  const latestOutcome = latest ? classifyHttpOutcome(latest.status) : null;

  let health: DestHealth;
  if (input.circuitState !== 'CLOSED') health = 'circuit_open';
  else if (total === 0 && !latest) health = 'no_deliveries';
  else if (latestOutcome === 'auth_rejected') health = 'auth_rejected';
  else if (latestOutcome === 'client_error') health = 'client_error';
  else if ((latest && isRetryableFailure(latest.status)) || (total > 0 && retrying / total >= FAILING_OPEN_RATIO)) health = 'receiver_failing';
  else health = 'healthy';

  const facts: DestInsightFacts = {
    health,
    total,
    success: byOutcome.success,
    retrying,
    byOutcome,
    lastStatus: latest ? latest.status : null,
    lastAt: latest ? iso(latest.at) : null,
    circuitState: input.circuitState,
    windowFrom: iso(new Date(now.getTime() - INSIGHT_DEST_WINDOW_MS)),
  };
  const actions: InsightAction[] =
    health === 'healthy' || health === 'no_deliveries' ? [] : [{ code: 'view_deliveries', params: { destinationId: input.destinationId } }];
  if (health === 'auth_rejected' || health === 'client_error') actions.push({ code: 'open_dlq', params: { destinationId: input.destinationId } });
  return {
    code: 'I-dest',
    level: LEVEL_OF_HEALTH[health],
    subjectType: 'destination',
    subjectId: input.destinationId,
    facts,
    ...(actions.length ? { actions } : {}),
  };
}

// ------------------------------------------------------------------ I-silent (Sources, từng dòng)

export type SilentState = 'normal' | 'quiet' | 'learning' | 'no_events';

export interface SilentInsightInput {
  sourceId: string;
  source: SubjectLifecycle;
  /** Hàng của `findSourceActivity` (cùng cửa sổ + cùng số mốc như AlertEvaluator); null = không có sự kiện trong cửa sổ. */
  activity: { n: number; lastAt: Date | null; medianGapMs: number | null } | null;
}

export interface SilentInsightFacts extends Record<string, unknown> {
  state: SilentState;
  lastEventAt: string | null;
  medianGapMs: number | null;
  thresholdMs: number;
  /** Số mốc sự kiện trong baseline 7 ngày (cần ≥ `SILENT_MIN_BASELINE_EVENTS` mới biết "nhịp bình thường"). */
  baseline: number;
  minBaseline: number;
}

/**
 * "Sự kiện cuối {relative}" + so với nhịp của CHÍNH nguồn đó. `quiet` đúng khi luật `source.silent` (chưa mở) sẽ mở —
 * gọi thẳng `evalSourceSilent`, không tự tính lại ngưỡng. Nguồn Ngắt/lưu trữ không có nhận định (null).
 */
export function buildSilentInsight(input: SilentInsightInput, now: Date): Insight<SilentInsightFacts> | null {
  if (input.source.archivedAt || !input.source.isActive) return null;
  const a = input.activity;
  const last = a?.lastAt ?? null;
  const baseline = a?.n ?? 0;
  const medianGapMs = a?.medianGapMs ?? null;
  let state: SilentState;
  if (!last) state = 'no_events';
  else if (baseline < SILENT_MIN_BASELINE_EVENTS) state = 'learning';
  else {
    const d = evalSourceSilent(
      { source: input.source, nonProbeAccepted7d: baseline, medianGapMs, lastNonProbeEventAt: last },
      { now, current: null },
    );
    state = d.open ? 'quiet' : 'normal';
  }
  return {
    code: 'I-silent',
    level: state === 'quiet' ? 'warning' : state === 'normal' ? 'ok' : 'info',
    subjectType: 'source',
    subjectId: input.sourceId,
    facts: {
      state,
      lastEventAt: last ? iso(last) : null,
      medianGapMs,
      thresholdMs: silenceThresholdMs(medianGapMs),
      baseline,
      minBaseline: SILENT_MIN_BASELINE_EVENTS,
    },
    ...(state === 'quiet' ? { actions: [{ code: 'view_events' as const, params: { sourceId: input.sourceId } }] } : {}),
  };
}

// ------------------------------------------------------------------ I-dup (Tổng quan)

export interface DupInsightInput {
  projectId: string;
  /** Đầu ngày hôm nay (giờ Việt Nam, cùng múi với biểu đồ dashboard). */
  since: Date;
  /** Số bản trùng hub đã chặn từ `since`, theo provider của source (đếm ở Postgres — ADR-171). */
  byProvider: { provider: string; n: number }[];
}

export interface DupInsightFacts extends Record<string, unknown> {
  total: number;
  byProvider: { provider: string; n: number }[];
  since: string;
}

/** "Hôm nay hub đã chặn {n} sự kiện trùng" — bằng chứng sống của BB-2/BB-3 (Postgres là trọng tài, ACK sau COMMIT). */
export function buildDupInsight(input: DupInsightInput): Insight<DupInsightFacts> {
  const byProvider = input.byProvider
    .filter((r) => r.n > 0)
    .map((r) => ({ provider: r.provider, n: r.n }))
    .sort((x, y) => y.n - x.n || x.provider.localeCompare(y.provider));
  const total = byProvider.reduce((s, r) => s + r.n, 0);
  return {
    code: 'I-dup',
    level: total > 0 ? 'info' : 'ok',
    subjectType: 'project',
    subjectId: input.projectId,
    facts: { total, byProvider, since: iso(input.since) },
  };
}

// ------------------------------------------------------------------ I-dead (Tổng quan)

/** Cửa sổ "mới vào DLQ". */
export const INSIGHT_DEAD_RECENT_MS = 24 * HOUR;
/** Trần đếm DLQ cho nhận định (giữ truy vấn trang Tổng quan nhẹ); chạm trần -> `capped`, web viết "≥ {n}". */
export const INSIGHT_DEAD_COUNT_CAP = 10_000;

export interface DeadInsightInput {
  projectId: string;
  /** DLQ (DEAD, chưa bị replay) đã loại D9, tối đa `INSIGHT_DEAD_COUNT_CAP`. */
  total: number;
  /** Trong đó thành DEAD trong `INSIGHT_DEAD_RECENT_MS`. */
  recent: number;
  capped: boolean;
}

export interface DeadInsightFacts extends Record<string, unknown> {
  total: number;
  recent: number;
  capped: boolean;
  windowHours: number;
}

/** "{n} sự kiện đang nằm DLQ, {k} trong 24 giờ qua" + nút sang DLQ. */
export function buildDeadInsight(input: DeadInsightInput): Insight<DeadInsightFacts> {
  const total = Math.max(0, input.total);
  const recent = Math.min(Math.max(0, input.recent), total);
  return {
    code: 'I-dead',
    level: total === 0 ? 'ok' : recent > 0 ? 'warning' : 'info',
    subjectType: 'project',
    subjectId: input.projectId,
    facts: { total, recent, capped: input.capped, windowHours: INSIGHT_DEAD_RECENT_MS / HOUR },
    ...(total > 0 ? { actions: [{ code: 'open_dlq' as const }] } : {}),
  };
}
