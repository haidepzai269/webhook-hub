/**
 * CB1 (SPEC-canh-bao-nhan-dinh §4 + DINH-CHINH-2026-10-12): danh mục luật cảnh báo — ngưỡng là HẰNG SỐ có tên, mỗi
 * luật là MỘT hàm thuần `(input, ctx{now, current}) → { open, facts }`. Không I/O, không Date.now(): `now` tiêm vào.
 *
 * Hợp đồng chung:
 * - `ctx.current` = cảnh báo đang OPEN của (rule, subject) này (null nếu chưa mở). Hysteresis đọc `current.facts`.
 * - Kết quả `open: true`  -> evaluator upsert dòng OPEN (`INSERT … ON CONFLICT` trên unique index một phần), facts mới.
 *   Kết quả `open: false` -> nếu đang OPEN thì RESOLVED (facts mới, có `reason` khi đóng vì Ngắt/lưu trữ); chưa mở thì thôi.
 * - Mọi luật CHUNG cho mọi provider (không `if (provider === …)`, BB-1: không biết đơn hàng/số tiền).
 * - Probe của provider (PayOS confirm ADR-159, GitHub `ping` ADR-162) KHÔNG tính: input của luật source đặt tên
 *   `nonProbe…` — truy vấn tổng hợp (CB2) phải lọc `NOT e.probe` như bảng nhật ký.
 * - Đối tượng đã Ngắt (`isActive=false`) hoặc lưu trữ (`archivedAt`) -> không mở mới; đang mở thì đóng với
 *   `facts.reason = 'inactive' | 'archived'` (lưu trữ thắng Ngắt).
 * - Phân loại HTTP dùng CHÍNH `classifyHttpOutcome` của delivery.consumer (`libs/common/src/http-outcome.ts`).
 */
import { classifyHttpOutcome, isRetryableFailure } from '../http-outcome';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ ngưỡng (có tên, có test — CB:T1)

/** Chu kỳ đánh giá mặc định (`ALERT_EVAL_INTERVAL_MS`). */
export const ALERT_EVAL_INTERVAL_MS = 60_000;

/** `destination.auth_rejected`: ≥ 3 attempt 401/403 LIÊN TIẾP gần nhất, trong 30 phút. */
export const AUTH_REJECTED_MIN_STREAK = 3;
export const AUTH_REJECTED_WINDOW_MS = 30 * MIN;
/** `destination.client_error`: ≥ 3 attempt 4xx khác (trừ 401/403/408/429) liên tiếp, cùng cửa sổ. */
export const CLIENT_ERROR_MIN_STREAK = 3;
export const CLIENT_ERROR_WINDOW_MS = 30 * MIN;
/** Hai luật trên đóng khi có 1 attempt 2xx, HOẶC 30 phút không có attempt mới. */
export const STREAK_QUIET_CLOSE_MS = 30 * MIN;

/** `destination.failing`: ≥ 10 attempt trong 15 phút và ≥ 50% là thất bại hub sẽ retry (5xx/timeout/mạng/408/429). */
export const FAILING_WINDOW_MS = 15 * MIN;
export const FAILING_MIN_ATTEMPTS = 10;
export const FAILING_OPEN_RATIO = 0.5;
/** Đóng khi tỉ lệ < 20% trong 2 lượt đánh giá liền (hysteresis). */
export const FAILING_CLOSE_RATIO = 0.2;
export const CALM_EVALS_TO_CLOSE = 2;
/**
 * Review CB1 (Thấp 3): một lượt "êm" chỉ được đếm khi cách lượt êm trước ≥ ~một chu kỳ đánh giá — hai evaluator chạy song
 * song (D4, không khoá) không được rút "2 lượt liền" thành vài giây. 0.9 × chu kỳ để chịu lệch hẹn giờ.
 */
export const CALM_MIN_SPACING_MS = Math.round(0.9 * ALERT_EVAL_INTERVAL_MS);

/** `source.connection_broken` (review CB1, Q3): PENDING lâu hơn 15 phút = kết nối kẹt, coi như hỏng. */
export const CONNECTION_PENDING_STUCK_MS = 15 * MIN;

/** `delivery.dead_spike`: ≥ 10 delivery mới DEAD trong 1 giờ (D9: không tính DEAD vì đích/subscription đã lưu trữ). */
export const DEAD_SPIKE_WINDOW_MS = HOUR;
export const DEAD_SPIKE_MIN = 10;
/** D9: `last_error` của delivery bị worker đánh DEAD vì đích đã lưu trữ (delivery.consumer, ADR-161). */
export const DESTINATION_ARCHIVED_ERROR_PREFIX = 'destination_archived:';

/** `source.signature_failing`: ≥ 5 request chữ ký sai trong 15 phút VÀ ≥ 50% request của source; đóng < 20% × 2 lượt. */
export const SIGNATURE_WINDOW_MS = 15 * MIN;
export const SIGNATURE_MIN_INVALID = 5;
export const SIGNATURE_OPEN_RATIO = 0.5;
export const SIGNATURE_CLOSE_RATIO = 0.2;

/** `source.silent`: baseline 7 ngày, cần ≥ 20 sự kiện; im lặng quá max(6h, 4 × khoảng cách trung vị). */
export const SILENT_BASELINE_WINDOW_MS = 7 * DAY;
export const SILENT_MIN_BASELINE_EVENTS = 20;
export const SILENT_MIN_GAP_MS = 6 * HOUR;
export const SILENT_GAP_MULTIPLIER = 4;

/** `normalize.backlog`: ≥ 1 raw_event ACCEPTED chưa chuẩn hoá quá 10 phút. */
export const BACKLOG_MIN_AGE_MS = 10 * MIN;
export const BACKLOG_MIN = 1;

/** Email (CB5, D1): trần 6 email/giờ/người; mở lại trong 30 phút sau RESOLVED thì không gửi lại (chống flapping). */
export const EMAIL_MAX_PER_USER_PER_HOUR = 6;
export const FLAP_SUPPRESS_MS = 30 * MIN;

// ------------------------------------------------------------------ danh mục

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertSubjectType = 'destination' | 'source' | 'project';

export const ALERT_RULES = {
  'destination.auth_rejected': { severity: 'critical', subjectType: 'destination' },
  'destination.client_error': { severity: 'warning', subjectType: 'destination' },
  'destination.failing': { severity: 'warning', subjectType: 'destination' },
  'destination.circuit_open': { severity: 'warning', subjectType: 'destination' },
  'delivery.dead_spike': { severity: 'critical', subjectType: 'project' },
  'source.signature_failing': { severity: 'critical', subjectType: 'source' },
  'source.connection_broken': { severity: 'critical', subjectType: 'source' },
  'source.silent': { severity: 'warning', subjectType: 'source' },
  'normalize.backlog': { severity: 'warning', subjectType: 'project' },
} as const satisfies Record<string, { severity: AlertSeverity; subjectType: AlertSubjectType }>;

export type AlertRuleCode = keyof typeof ALERT_RULES;
export const ALERT_RULE_CODES = Object.keys(ALERT_RULES) as AlertRuleCode[];

/** Mặc định khi bật email (§3.2): mọi luật `critical`. */
export const DEFAULT_EMAIL_RULES: AlertRuleCode[] = ALERT_RULE_CODES.filter((c) => ALERT_RULES[c].severity === 'critical');

// ------------------------------------------------------------------ hợp đồng hàm luật

export type CloseReason = 'archived' | 'inactive' | 'disconnected';

export interface AlertFacts {
  [k: string]: unknown;
  reason?: CloseReason;
}

export interface RuleContext {
  now: Date;
  /** Cảnh báo đang OPEN của (rule, subject) — null nếu chưa mở. */
  current: { openedAt: Date; facts: AlertFacts } | null;
}

export interface RuleDecision<F extends AlertFacts = AlertFacts> {
  open: boolean;
  facts: F;
}

/** Trạng thái vòng đời của destination/source (ADR-161). */
export interface SubjectLifecycle {
  isActive: boolean;
  archivedAt: Date | null;
}

/** Một lần thử giao (`delivery_attempts`). `status` null/0 = không có phản hồi. */
export interface AttemptSample {
  status: number | null;
  at: Date;
}

const iso = (d: Date) => d.toISOString();

/** Đối tượng Ngắt/lưu trữ -> quyết định đóng (kèm lý do); còn dùng -> null (luật chạy tiếp). */
export function lifecycleClose(subject: SubjectLifecycle): RuleDecision | null {
  if (subject.archivedAt) return { open: false, facts: { reason: 'archived' } };
  if (!subject.isActive) return { open: false, facts: { reason: 'inactive' } };
  return null;
}

/** Tỉ lệ an toàn (total = 0 -> 0). */
function ratio(n: number, total: number): number {
  return total > 0 ? n / total : 0;
}

/** Số lượt "êm" liên tiếp đã ghi ở facts của cảnh báo đang mở. */
function calmStreakOf(current: RuleContext['current']): number {
  const v = current?.facts?.calmStreak;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Thời điểm (ms) lấy từ một trường ISO trong facts; không có / hỏng -> NaN. */
function factTime(facts: AlertFacts | undefined, key: string): number {
  const v = facts?.[key];
  return typeof v === 'string' ? Date.parse(v) : NaN;
}

/**
 * Hysteresis tỉ lệ (failing / signature): mở khi `openNow`; đang mở thì chỉ đóng sau `CALM_EVALS_TO_CLOSE` lượt liền
 * tỉ lệ < ngưỡng đóng. Vùng giữa (đóng ≤ r < mở) giữ trạng thái hiện tại và reset bộ đếm êm.
 */
function ratioHysteresis<F extends AlertFacts>(
  ctx: RuleContext,
  openNow: boolean,
  calmNow: boolean,
  facts: F,
): RuleDecision<F & { calmStreak?: number; lastCalmAt?: string }> {
  if (!ctx.current) return { open: openNow, facts };
  if (openNow || !calmNow) return { open: true, facts: { ...facts, calmStreak: 0 } };
  const prevCalmAt = factTime(ctx.current.facts, 'lastCalmAt');
  const prevStreak = calmStreakOf(ctx.current);
  // Lượt êm quá sát lượt êm trước (evaluator khác vừa đếm) -> không đếm thêm, giữ nguyên bộ đếm.
  if (prevStreak > 0 && !Number.isNaN(prevCalmAt) && ctx.now.getTime() - prevCalmAt < CALM_MIN_SPACING_MS) {
    return { open: true, facts: { ...facts, calmStreak: prevStreak, lastCalmAt: ctx.current.facts.lastCalmAt as string } };
  }
  const calm = prevStreak + 1;
  const next = { ...facts, calmStreak: calm, lastCalmAt: iso(ctx.now) };
  return { open: calm < CALM_EVALS_TO_CLOSE, facts: next };
}

// ------------------------------------------------------------------ destination.auth_rejected / client_error

export interface StreakInput {
  destination: SubjectLifecycle;
  /** Attempt gần nhất của đích, MỚI NHẤT TRƯỚC (truy vấn có LIMIT). */
  attempts: AttemptSample[];
  /** Số delivery của đích đã DEAD trong cửa sổ (tác động — dựng câu "{dead} sự kiện đã DEAD"). */
  dead: number;
}

export interface StreakFacts extends AlertFacts {
  count?: number;
  httpStatus?: number | null;
  sinceAt?: string;
  /** Mốc: attempt mới nhất đã xét ở lượt trước — lượt sau chỉ tìm 2xx trong các attempt MỚI hơn mốc này. */
  lastAttemptAt?: string;
  /** Attempt CÙNG loại (401/403 hoặc 4xx khác) gần nhất — đóng "im" tính theo mốc này. */
  lastMatchAt?: string;
  dead?: number;
}

function streakRule(
  outcome: 'auth_rejected' | 'client_error',
  minStreak: number,
  windowMs: number,
  input: StreakInput,
  ctx: RuleContext,
): RuleDecision<StreakFacts> {
  const closed = lifecycleClose(input.destination);
  if (closed) return closed;
  const now = ctx.now.getTime();
  const latest = input.attempts[0];

  let streak = 0;
  for (const a of input.attempts) {
    if (now - a.at.getTime() > windowMs) break;
    if (classifyHttpOutcome(a.status) !== outcome) break;
    streak++;
  }
  const match = input.attempts.find((a) => classifyHttpOutcome(a.status) === outcome);
  const facts: StreakFacts =
    streak > 0
      ? {
          count: streak,
          httpStatus: latest.status,
          sinceAt: iso(input.attempts[streak - 1].at),
          lastAttemptAt: iso(latest.at),
          lastMatchAt: iso(latest.at),
          dead: input.dead,
        }
      : {};

  if (!ctx.current) return { open: streak >= minStreak, facts };

  // Đang mở (review CB1, TB1):
  // 1) Đóng nếu BẤT KỲ attempt nào mới hơn mốc đã xét là 2xx — 401×3 → 200 → 500 vẫn đóng (đích đã nhận được ít nhất một lần).
  const prev = ctx.current.facts;
  const seen = factTime(prev, 'lastAttemptAt');
  const newer = Number.isNaN(seen) ? input.attempts : input.attempts.filter((a) => a.at.getTime() > seen);
  const success = newer.find((a) => classifyHttpOutcome(a.status) === 'success');
  const watermark = latest ? { lastAttemptAt: iso(new Date(Math.max(latest.at.getTime(), Number.isNaN(seen) ? 0 : seen))) } : {};
  if (success) return { open: false, facts: { ...prev, ...facts, ...watermark, httpStatus: success.status } };
  // 2) Đóng "im" khi 30 phút không có attempt CÙNG LOẠI (không phải "không có attempt nào": 500 liên tục không che 401 cũ).
  //    Mốc lấy max(input, facts) — input có LIMIT, attempt cùng loại có thể đã trôi khỏi danh sách.
  const lastMatch = Math.max(match ? match.at.getTime() : -Infinity, factTime(prev, 'lastMatchAt') || -Infinity);
  const lastMatchFacts = Number.isFinite(lastMatch) ? { lastMatchAt: iso(new Date(lastMatch)) } : {};
  if (!Number.isFinite(lastMatch) || now - lastMatch >= STREAK_QUIET_CLOSE_MS) {
    return { open: false, facts: { ...prev, ...facts, ...watermark, ...lastMatchFacts } };
  }
  // 3) Còn lại giữ mở; số liệu chuỗi cũ giữ nếu chuỗi mới ngắn hơn (lỗi khác loại xen giữa).
  return { open: true, facts: { ...prev, ...(streak > 0 ? facts : {}), ...watermark, ...lastMatchFacts } };
}

/** `destination.auth_rejected` (critical): 401/403 liên tiếp — retry vô ích, mỗi sự kiện DEAD ngay và im lặng. */
export function evalAuthRejected(input: StreakInput, ctx: RuleContext): RuleDecision<StreakFacts> {
  return streakRule('auth_rejected', AUTH_REJECTED_MIN_STREAK, AUTH_REJECTED_WINDOW_MS, input, ctx);
}

/** `destination.client_error` (warning): 4xx khác 401/403/408/429 liên tiếp — request bị từ chối về nội dung. */
export function evalClientError(input: StreakInput, ctx: RuleContext): RuleDecision<StreakFacts> {
  return streakRule('client_error', CLIENT_ERROR_MIN_STREAK, CLIENT_ERROR_WINDOW_MS, input, ctx);
}

// ------------------------------------------------------------------ destination.failing

export interface FailingInput {
  destination: SubjectLifecycle;
  /** HTTP status của mọi attempt trong `FAILING_WINDOW_MS` (null/0 = không phản hồi). */
  statuses: (number | null)[];
}

export interface FailingFacts extends AlertFacts {
  total?: number;
  failed?: number;
  pct?: number;
  calmStreak?: number;
  lastCalmAt?: string;
  /** Review CB1 (Q2): tách theo loại để câu chữ nói đúng ("429 — bên nhận bảo chậm lại", "3xx — kiểm tra URL"). */
  byClass?: { server_error: number; no_response: number; throttled: number; unexpected: number };
}

export function evalDestinationFailing(input: FailingInput, ctx: RuleContext): RuleDecision<FailingFacts> {
  const closed = lifecycleClose(input.destination);
  if (closed) return closed;
  const total = input.statuses.length;
  const failed = input.statuses.filter((s) => isRetryableFailure(s)).length;
  const byClass = { server_error: 0, no_response: 0, throttled: 0, unexpected: 0 };
  for (const s of input.statuses) {
    const o = classifyHttpOutcome(s);
    if (o in byClass) byClass[o as keyof typeof byClass]++;
  }
  const r = ratio(failed, total);
  const facts: FailingFacts = { total, failed, pct: Math.round(r * 100), byClass };
  const enough = total >= FAILING_MIN_ATTEMPTS;
  // Review CB1 (Thấp 4): mẫu quá nhỏ (< FAILING_MIN_ATTEMPTS) cũng là lượt êm — đích hết lưu lượng thì cảnh báo không treo mãi.
  return ratioHysteresis(ctx, enough && r >= FAILING_OPEN_RATIO, !enough || r < FAILING_CLOSE_RATIO, facts);
}

// ------------------------------------------------------------------ destination.circuit_open

export interface CircuitInput {
  destination: SubjectLifecycle;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /** Lúc circuit chuyển HALF_OPEN (nếu biết) — dựng câu "Thử lại lúc …". */
  halfOpenAt?: Date | null;
}

export function evalCircuitOpen(input: CircuitInput, ctx: RuleContext): RuleDecision {
  const closed = lifecycleClose(input.destination);
  if (closed) return closed;
  const facts: AlertFacts = { circuitState: input.circuitState, ...(input.halfOpenAt ? { halfOpenAt: iso(input.halfOpenAt) } : {}) };
  if (input.circuitState === 'OPEN') return { open: true, facts };
  if (input.circuitState === 'CLOSED') return { open: false, facts };
  // HALF_OPEN: đang thử lại — không mở mới, đang mở thì giữ tới khi về CLOSED.
  return { open: !!ctx.current, facts };
}

// ------------------------------------------------------------------ delivery.dead_spike (cấp project)

/**
 * D9: delivery DEAD vì đích bị lưu trữ KHÔNG tính (xoá một đích đang có hàng chờ không được bắn critical giả).
 * Truy vấn tổng hợp (CB2) lọc cùng điều kiện ở SQL; hàm này là định nghĩa tham chiếu, có test.
 */
export function countsTowardDeadSpike(d: { lastError: string | null; destinationArchivedAt: Date | null; subscriptionArchivedAt: Date | null }): boolean {
  if (d.destinationArchivedAt || d.subscriptionArchivedAt) return false;
  return !(d.lastError ?? '').startsWith(DESTINATION_ARCHIVED_ERROR_PREFIX);
}

export interface DeadSpikeInput {
  /** Số delivery thành DEAD trong `DEAD_SPIKE_WINDOW_MS`, ĐÃ loại theo `countsTowardDeadSpike` (D9). */
  dead: number;
}

export function evalDeadSpike(input: DeadSpikeInput, ctx: RuleContext): RuleDecision {
  return { open: input.dead >= DEAD_SPIKE_MIN, facts: { count: input.dead, windowFrom: iso(new Date(ctx.now.getTime() - DEAD_SPIKE_WINDOW_MS)) } };
}

// ------------------------------------------------------------------ source.signature_failing

export interface SignatureInput {
  source: SubjectLifecycle;
  /** Request tới source trong `SIGNATURE_WINDOW_MS`, KHÔNG tính probe. */
  nonProbeRequests: number;
  /** Trong đó `signature_valid = false`. */
  nonProbeInvalid: number;
}

export function evalSignatureFailing(input: SignatureInput, ctx: RuleContext): RuleDecision<FailingFacts> {
  const closed = lifecycleClose(input.source);
  if (closed) return closed;
  const total = input.nonProbeRequests;
  const failed = Math.min(input.nonProbeInvalid, total);
  const r = ratio(failed, total);
  const facts: FailingFacts = { total, failed, pct: Math.round(r * 100) };
  return ratioHysteresis(ctx, failed >= SIGNATURE_MIN_INVALID && r >= SIGNATURE_OPEN_RATIO, r < SIGNATURE_CLOSE_RATIO, facts);
}

// ------------------------------------------------------------------ source.connection_broken

export interface ConnectionInput {
  source: SubjectLifecycle;
  /** null = source không có kết nối hub->provider. */
  connection: {
    status: 'PENDING' | 'CONNECTED' | 'FAILED' | 'DRIFTED' | 'DISCONNECTED';
    lastError: string | null;
    lastFix: string | null;
    /** `source_connections.updated_at` — PENDING quá `CONNECTION_PENDING_STUCK_MS` là kẹt. */
    updatedAt: Date;
  } | null;
  /** D5: nhãn provider lấy từ dữ liệu (registry/adapter), không viết cứng trong câu. */
  providerLabel: string;
}

export function evalConnectionBroken(input: ConnectionInput, ctx: RuleContext): RuleDecision {
  const closed = lifecycleClose(input.source);
  if (closed) return closed;
  const c = input.connection;
  if (!c || c.status === 'DISCONNECTED') return { open: false, facts: { reason: 'disconnected', providerLabel: input.providerLabel } };
  const facts: AlertFacts = { status: c.status, providerLabel: input.providerLabel, lastError: c.lastError, lastFix: c.lastFix };
  if (c.status === 'FAILED' || c.status === 'DRIFTED') return { open: true, facts };
  if (c.status === 'CONNECTED') return { open: false, facts };
  // PENDING quá 15 phút: lượt kết nối đã chết giữa chừng -> coi như hỏng (review CB1, Q3).
  if (ctx.now.getTime() - c.updatedAt.getTime() >= CONNECTION_PENDING_STUCK_MS) {
    return { open: true, facts: { ...facts, stuckSince: iso(c.updatedAt) } };
  }
  // PENDING mới: đang kết nối lại — không mở mới, đang mở thì giữ tới khi CONNECTED.
  return { open: !!ctx.current, facts: ctx.current ? { ...ctx.current.facts, status: c.status } : facts };
}

// ------------------------------------------------------------------ source.silent

export interface SilentInput {
  source: SubjectLifecycle;
  /** Sự kiện ACCEPTED (không probe) trong `SILENT_BASELINE_WINDOW_MS`. */
  nonProbeAccepted7d: number;
  /** Khoảng cách trung vị giữa hai sự kiện liên tiếp trong baseline (ms); null nếu không tính được. */
  medianGapMs: number | null;
  /** Sự kiện (không probe) gần nhất; null nếu chưa có. */
  lastNonProbeEventAt: Date | null;
}

export function silenceThresholdMs(medianGapMs: number | null): number {
  return Math.max(SILENT_MIN_GAP_MS, SILENT_GAP_MULTIPLIER * (medianGapMs ?? 0));
}

export function evalSourceSilent(input: SilentInput, ctx: RuleContext): RuleDecision {
  const closed = lifecycleClose(input.source);
  if (closed) return closed;
  const last = input.lastNonProbeEventAt;
  if (ctx.current) {
    // Đang mở: CHỈ đóng khi có sự kiện mới hơn lúc mở. Không đóng vì baseline 7 ngày trượt xuống < 20 — chính sự im lặng
    // kéo baseline xuống, đóng lúc đó là tự che cảnh báo.
    const seen = typeof ctx.current.facts.lastEventAt === 'string' ? Date.parse(ctx.current.facts.lastEventAt) : NaN;
    const fresh = !!last && (Number.isNaN(seen) ? last.getTime() > ctx.current.openedAt.getTime() : last.getTime() > seen);
    return fresh ? { open: false, facts: { ...ctx.current.facts, lastEventAt: iso(last!) } } : { open: true, facts: ctx.current.facts };
  }
  if (input.nonProbeAccepted7d < SILENT_MIN_BASELINE_EVENTS || !last) return { open: false, facts: {} };
  const threshold = silenceThresholdMs(input.medianGapMs);
  const silentMs = ctx.now.getTime() - last.getTime();
  return {
    open: silentMs > threshold,
    facts: { lastEventAt: iso(last), silentMs, medianGapMs: input.medianGapMs, thresholdMs: threshold, baseline: input.nonProbeAccepted7d },
  };
}

// ------------------------------------------------------------------ normalize.backlog (cấp project)

export interface BacklogInput {
  /** raw_events ACCEPTED chưa có event, cũ hơn `BACKLOG_MIN_AGE_MS` (cùng truy vấn với orphan-banner). */
  stuck: number;
}

export function evalNormalizeBacklog(input: BacklogInput, _ctx: RuleContext): RuleDecision {
  return { open: input.stuck >= BACKLOG_MIN, facts: { count: input.stuck } };
}
