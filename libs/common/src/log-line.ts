import { CAUSES, Cause } from './causes';
import { scrubSecrets } from './auth/redact';
import { newSpanId } from './trace-context';
import { DEFAULT_SLOW_THRESHOLDS, SlowThresholds, resolveLogSettings, slowThresholds } from './slow-thresholds';

/**
 * LOGGING.md §3 (ADR-250): "canonical log line" — mỗi sự kiện then chốt đúng MỘT dòng giàu thông tin. Builder THUẦN
 * (`buildCanonical`) + bộ phát (`CanonicalLogger`: lấy mẫu dòng thành công, gộp dòng lặp, đếm metric). Không I/O, không Redis,
 * không DB: chỉ đồng hồ trong bộ nhớ do bên gọi đo quanh lời gọi sẵn có.
 *
 * AN TOÀN (§5): đầu vào KHÔNG có chỗ cho body/secret/chữ ký. `extra` chỉ nhận khoá trong `EXTRA_KEYS` (giá trị chuỗi qua
 * `scrubSecrets`, cắt 120 ký tự); `err` đi qua `errInfo` (Prisma chỉ lấy code + model).
 */
export type CanonicalMsg = 'ingest.done' | 'normalize.done' | 'delivery.attempt' | 'growth.window';
export type CanonicalOutcome =
  | 'accepted' | 'duplicate' | 'rejected' | 'refused' | 'unavailable' | 'handshake' // ingest (hub-outcome.ts)
  | 'ok' | 'failed' | 'retry' | 'dead' | 'deferred' | 'skipped'; // worker

/** Enum chặng (§3.2) — cố định, ≈ 13 giá trị (nhãn `stage` của hub_stage_duration_seconds). */
export const STAGES = ['verify', 'redis', 'db_read', 'db_commit', 'db_write', 'db_persist', 'ack_build', 'outbox_lag', 'queue_wait', 'deliver_prep', 'dest_http', 'adapter', 'other'] as const;
export type Stage = (typeof STAGES)[number];
/** Chặng nằm NGOÀI thời gian xử lý của handler (đã nằm trong total_ms của dòng worker). */
const EXTERNAL_STAGES: readonly Stage[] = ['outbox_lag', 'queue_wait'];

export const EXTRA_KEYS = [
  'policy', 'error', 'content_type', 'next_queue', 'queue', 'defer_ms', 'last_cause', 'replay_of', 'trace_origin', 'clock_skew',
  'circuit', 'parent_span_id', 'dest_host', 'attempt_generation', 'window_s', 'count', 'baseline_per_min', 'factor', 'duplicate_ratio', 'hint', 'tier',
] as const;
const EXTRA_KEY_SET: ReadonlySet<string> = new Set(EXTRA_KEYS);

export interface ErrInfo {
  class: string;
  code: string;
  msg: string;
}

export interface CanonicalInput {
  svc: 'hub-api' | 'hub-worker';
  msg: CanonicalMsg;
  outcome: CanonicalOutcome;
  /** 32 hex (W3C) — LOGGING.md §4. */
  traceId: string;
  spanId?: string;
  requestId?: string;
  /** Kiểu chuẩn SAU normalize (`payment.paid`). Hub không biết "đơn hàng" (BB-1) — không bao giờ trường nghiệp vụ. */
  eventName?: string;
  tenantId?: string;
  sourceId?: string;
  destinationId?: string;
  deliveryId?: string;
  rawEventId?: string;
  /** Đã qua `providerMetricLabel` (không lấy thẳng từ path). */
  provider?: string;
  attempt?: number;
  httpStatus?: number;
  bytes?: number;
  /** Nguyên nhân tường minh (lỗi/hoãn). Không có -> suy `slow.*` nếu vượt ngưỡng. */
  cause?: Cause;
  totalMs: number;
  stageMs?: Partial<Record<Stage, number>>;
  /** Lỗi thô (đi qua `errInfo`) hoặc đã dựng sẵn. */
  err?: unknown | ErrInfo;
  flags?: { cold?: boolean };
  extra?: Partial<Record<(typeof EXTRA_KEYS)[number], string | number | boolean>>;
}

type SampleClass = 'sample' | 'dedupe' | 'always';

export interface BuiltLine {
  level: 'info' | 'warn' | 'error';
  record: Record<string, any>;
  /** Cause cuối cùng (tường minh hoặc suy ra). */
  cause: Cause | null;
  /** Cause `slow.*` suy ra từ ngưỡng (kể cả khi cause tường minh thắng) — cho `hub_slow_total`. */
  slowCause: Cause | null;
  sampleClass: SampleClass;
  dedupeKey: string;
  stageMs: Partial<Record<Stage, number>>;
  svc: CanonicalInput['svc'];
}

const int = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** `{class, code, msg}` (§3.1). Prisma: chỉ code + model (message nguyên văn có thể chứa tham số truy vấn — §5). */
export function errInfo(err: unknown): ErrInfo {
  if (err && typeof err === 'object' && 'class' in (err as object) && 'code' in (err as object) && 'msg' in (err as object)) return err as ErrInfo;
  if (err === null || err === undefined) return { class: 'Error', code: 'UNKNOWN', msg: '' };
  if (typeof err === 'string') return { class: 'Error', code: 'UNKNOWN', msg: clean(err) };
  const e = err as { name?: unknown; code?: unknown; errno?: unknown; message?: unknown; meta?: { modelName?: unknown }; cause?: { code?: unknown }; constructor?: { name?: string } };
  const name = typeof e.name === 'string' && e.name && e.name !== 'Error' ? e.name : e.constructor?.name && e.constructor.name !== 'Object' ? e.constructor.name : 'Error';
  const rawCode = e.code ?? e.errno ?? e.cause?.code;
  const code = rawCode === undefined || rawCode === null || rawCode === '' ? 'UNKNOWN' : String(rawCode).slice(0, 40);
  if (name.startsWith('PrismaClient')) {
    const model = typeof e.meta?.modelName === 'string' ? e.meta.modelName : '';
    return { class: name, code, msg: `${code === 'UNKNOWN' ? '' : code} ${model}`.trim().slice(0, 200) };
  }
  return { class: name, code, msg: clean(typeof e.message === 'string' ? e.message : String(err)) };
}

function clean(s: string): string {
  // Số dài (giống số tài khoản/thẻ) không có lý do nằm trong thông điệp lỗi của hub.
  // URL: chỉ giữ host (path/query thường mang token — URL heartbeat, URL đích có ?token=, §5 "host của đích, không path/query").
  return scrubSecrets(s)
    .replace(/\b(https?:\/\/[^\s/"'?#]+)[^\s"']*/gi, '$1/***')
    .replace(/whsec_[A-Za-z0-9+/=_-]+/g, 'whsec_***')
    .replace(/\b\d{9,}\b/g, '***')
    .slice(0, 200);
}

function normalizeEpochMs(v: number): number {
  return v < 1e11 ? v * 1000 : v; // AMQP timestamp chuẩn tính bằng giây
}

/**
 * `queue_wait` = now − max(published_ts, due_ts) (§3.2): chờ CỐ Ý của tầng retry/hoãn không tính, chỉ phần QUÁ hạn.
 * Clamp ≥ 0; âm > 1s -> `clockSkew` (relay và consumer có thể ở instance khác nhau).
 */
export function computeQueueWait(i: { nowMs: number; publishedTs?: number | null; dueTs?: number | null }): { ms: number; clockSkew: boolean } {
  const cands: number[] = [];
  for (const v of [i.publishedTs, i.dueTs]) if (typeof v === 'number' && Number.isFinite(v) && v > 0) cands.push(normalizeEpochMs(v));
  if (cands.length === 0) return { ms: 0, clockSkew: false };
  const raw = i.nowMs - Math.max(...cands);
  if (raw < -1000) return { ms: 0, clockSkew: true };
  return { ms: Math.max(0, Math.round(raw)), clockSkew: false };
}

const DB_STAGES: readonly Stage[] = ['db_read', 'db_commit', 'db_write', 'db_persist'];

/** Suy `slow.*` từ ngưỡng (§3.2 + phân xử §2.3: chặng chiếm ≥ 50% VÀ vượt ngưỡng mới đủ điều kiện). */
function detectSlow(input: CanonicalInput, stage: Partial<Record<Stage, number>>, th: SlowThresholds): Cause | null {
  const ext = EXTERNAL_STAGES.reduce((a, s) => a + int(stage[s]), 0);
  const handler = Math.max(0, int(input.totalMs) - ext);
  const cands: Array<[Cause, number]> = [];
  if (int(stage.queue_wait) > th.queueWaitMs) cands.push(['slow.queue_wait', int(stage.queue_wait)]);
  if (int(stage.outbox_lag) > th.relayLagMs) cands.push(['slow.relay_lag', int(stage.outbox_lag)]);
  if (int(stage.dest_http) > th.deliveryMs) cands.push(['slow.destination', int(stage.dest_http)]);
  const handlerLimit = input.msg === 'ingest.done' ? th.ingestMs : input.msg === 'normalize.done' ? th.normalizeMs : Infinity;
  if (handler > handlerLimit) {
    if (input.flags?.cold) return 'slow.cold_start';
    const db = DB_STAGES.reduce((a, s) => a + int(stage[s]), 0);
    if (db * 2 >= handler) cands.push(['slow.db', db]);
    else if (int(stage.redis) * 2 >= handler) cands.push(['slow.redis', int(stage.redis)]);
    else cands.push(['slow.hub_cpu', handler]);
  }
  if (cands.length === 0) return null;
  return cands.sort((a, b) => b[1] - a[1])[0][0];
}

const DEDUPE_CAUSES: ReadonlySet<Cause> = new Set<Cause>([
  'wrong.signature', 'wrong.unknown_source', 'wrong.payload_shape', 'wrong.policy_blocked',
  'slow.deferred_circuit', 'slow.deferred_throttle', 'slow.deferred_backpressure',
]);

function levelOf(cause: Cause | null): 'info' | 'warn' | 'error' {
  if (!cause) return 'info';
  if (cause === 'wrong.duplicate') return 'info';
  const d = CAUSES[cause];
  if (d.group === 'fail' && d.hubFault) return 'error';
  if (cause === 'wrong.schema_mismatch') return 'error';
  return 'warn';
}

export function buildCanonical(input: CanonicalInput, th: SlowThresholds = DEFAULT_SLOW_THRESHOLDS): BuiltLine {
  const total = int(input.totalMs);
  const stage: Partial<Record<Stage, number>> = {};
  let sum = 0;
  for (const s of STAGES) {
    const v = input.stageMs?.[s];
    if (s === 'other' || v === undefined) continue;
    stage[s] = int(v);
    sum += int(v);
  }
  const other = total - sum;
  if (other > 0 || (input.stageMs && 'other' in input.stageMs)) stage.other = Math.max(0, other);

  const slowCause = detectSlow({ ...input, totalMs: total }, stage, th);
  const cause: Cause | null = input.cause ?? slowCause;

  const record: Record<string, any> = {
    svc: input.svc,
    msg: input.msg,
    trace_id: input.traceId,
    span_id: input.spanId ?? newSpanId(),
    outcome: input.outcome,
  };
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') record[k] = v;
  };
  put('request_id', input.requestId);
  put('event_name', input.eventName);
  put('tenant_id', input.tenantId);
  put('source_id', input.sourceId);
  put('destination_id', input.destinationId);
  put('delivery_id', input.deliveryId);
  put('raw_event_id', input.rawEventId);
  put('provider', input.provider);
  put('attempt', input.attempt);
  put('http_status', input.httpStatus);
  if (cause) {
    record.cause = cause;
    record.blame = CAUSES[cause].blame;
  }
  record.total_ms = total;
  record.stage_ms = stage;
  put('bytes', input.bytes);
  if (input.err !== undefined && input.err !== null) record.err = errInfo(input.err);
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    if (!EXTRA_KEY_SET.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') record[k] = v;
    else if (typeof v === 'string') record[k] = scrubSecrets(v).slice(0, 120);
  }

  const sampleClass: SampleClass = !cause || cause === 'wrong.duplicate' ? 'sample' : DEDUPE_CAUSES.has(cause) ? 'dedupe' : 'always';
  const dedupeKey = `${input.msg}|${cause ?? ''}|${record.policy ?? ''}|${input.sourceId ?? input.destinationId ?? ''}`;
  return { level: levelOf(cause), record, cause, slowCause, sampleClass, dedupeKey, stageMs: stage, svc: input.svc };
}

/** Quan sát MỌI dòng (kể cả bị lấy mẫu bỏ) -> `hub_log_events_total`, `hub_slow_total`, `hub_stage_duration_seconds`. */
export type CanonicalObserver = (b: BuiltLine) => void;
let observer: CanonicalObserver | null = null;
export function setCanonicalObserver(fn: CanonicalObserver | null): void {
  observer = fn;
}

interface LogLike {
  debug?: (o: object, m?: string) => void;
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

export interface CanonicalLoggerOptions {
  log: LogLike;
  successSample?: number;
  dedupeWindowMs?: number;
  thresholds?: SlowThresholds;
  now?: () => number;
  random?: () => number;
  maxKeys?: number;
}

export class CanonicalLogger {
  private readonly log: LogLike;
  private readonly sample: number;
  private readonly windowMs: number;
  private readonly th?: SlowThresholds;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxKeys: number;
  /** Map giữ thứ tự chèn -> LRU thô: khoá cũ nhất bị đẩy ra khi vượt trần. */
  private readonly seen = new Map<string, { at: number; suppressed: number }>();

  constructor(o: CanonicalLoggerOptions) {
    const env = resolveLogSettings();
    this.log = o.log;
    this.sample = o.successSample ?? env.successSample;
    this.windowMs = o.dedupeWindowMs ?? env.dedupeWindowMs;
    this.th = o.thresholds;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.maxKeys = o.maxKeys ?? 1000;
  }

  dedupeSize(): number {
    return this.seen.size;
  }

  /** Phát một dòng. KHÔNG BAO GIỜ ném (log/metric không làm hỏng đường nóng). Trả bản ghi đã ghi, hoặc null nếu bị mẫu/gộp bỏ. */
  emit(input: CanonicalInput): Record<string, any> | null {
    try {
      const b = buildCanonical(input, this.th ?? slowThresholds());
      try {
        observer?.(b);
      } catch {
        /* metric không làm hỏng log */
      }
      let record = b.record;
      if (b.sampleClass === 'sample') {
        if (this.sample < 1) {
          if (!(this.random() < this.sample)) return null;
          record = { ...record, sampled: { rate: this.sample } };
        }
      } else if (b.sampleClass === 'dedupe') {
        const now = this.now();
        const prev = this.seen.get(b.dedupeKey);
        if (prev && now - prev.at < this.windowMs) {
          prev.suppressed++;
          return null;
        }
        if (prev && prev.suppressed > 0) record = { ...record, sampled: { suppressed: prev.suppressed } };
        this.seen.delete(b.dedupeKey);
        this.seen.set(b.dedupeKey, { at: now, suppressed: 0 });
        if (this.seen.size > this.maxKeys) {
          const oldest = this.seen.keys().next().value;
          if (oldest !== undefined) this.seen.delete(oldest);
        }
      }
      const { msg, ...fields } = record;
      this.log[b.level](fields, msg);
      return record;
    } catch {
      return null;
    }
  }
}
