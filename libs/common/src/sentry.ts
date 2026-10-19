import { CAUSES, Cause, SENTRY_CAUSES } from './causes';
import { errInfo, setUnexpectedHook, BuiltLine, CanonicalInput } from './log-line';
import { scrubDeep, logger } from './logger';
import { scrubSecrets } from './auth/redact';

/**
 * LOGGING.md §11 (ADR-251, ADR-258) — Sentry BACKEND cho hub-api + hub-worker.
 *
 * MỘT cửa: `reportUnexpected(err, ctx)`. Không nơi nào khác gọi `Sentry.captureException`.
 * - Cổng: `blame === 'hub'` VÀ cause thuộc `SENTRY_CAUSES` (lỗi lạ chưa phân loại). Lỗi của provider/đích/khách/hạ tầng -> bỏ.
 * - An toàn: lỗi đi vào Sentry dưới dạng "thế thân" (message qua `errInfo`, frame stack qua `scrubSecrets`); `beforeSend` bỏ
 *   request/user/breadcrumbs/extra/server_name, lọc tag theo allowlist rồi `scrubDeep` toàn event. Không bộ lọc thứ hai.
 * - Chống bão: fingerprint [svc, cause, class, chặng] + dedupe cửa sổ + trần `SENTRY_MAX_PER_MIN`, đếm TRONG BỘ NHỚ (0 Redis, R1).
 * - Không `SENTRY_DSN` -> `initSentry` return ngay: không require SDK, không handler toàn cục, `reportUnexpected` là no-op.
 * - SDK nạp bằng `require` có điều kiện (không import tĩnh) để đường no-op không tốn RAM/thời gian khởi động.
 */
export type SentryService = 'hub-api' | 'hub-worker';

/** Khoá tag được phép rời hệ thống (allowlist, không phải denylist). */
const TAG_ALLOW: ReadonlySet<string> = new Set(['svc', 'cause', 'blame', 'stage', 'trace_id', 'request_id', 'tenant_id', 'origin', 'attempt', 'provider', 'http_status']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STAGE_RE = /^[a-z_]{1,24}$/;
const IGNORED_ERROR = /\b(ECONNRESET|EPIPE)\b|request aborted|aborted/i;

export interface ReportContext {
  /** Mặc định `fail.hub_unknown` (catch-all). Phải thuộc `SENTRY_CAUSES` và `blame === 'hub'` mới được gửi. */
  cause?: Cause;
  /** Chặng ổn định cho fingerprint (`ingest`|`normalize`|`delivery`|`relay`|`http`|`process`…). Không dùng id/giá trị biến thiên. */
  stage?: string;
  traceId?: string;
  requestId?: string;
  tenantId?: string;
  attempt?: number;
  provider?: string;
  httpStatus?: number;
  /** `uncaughtException` | `unhandledRejection` … */
  origin?: string;
  /** Bên gọi đã phân loại lỗi này là hạ tầng tạm thời (`classifyInfraError`) -> không gửi. */
  infra?: boolean;
}

export interface SentryStats {
  enabled: boolean;
  sent: number;
  /** Bị trần SENTRY_MAX_PER_MIN chặn. */
  dropped: number;
  /** Trùng fingerprint trong cửa sổ dedupe. */
  deduped: number;
}

interface SentryState {
  sdk: any;
  svc: SentryService;
  maxPerMin: number;
  dedupeMs: number;
  seen: Map<string, number>;
  minuteStart: number;
  minuteCount: number;
  lastDropLogAt: number;
  stats: SentryStats;
  handlersInstalled: boolean;
  onUncaught?: (err: unknown, origin: string) => void;
}

let state: SentryState | null = null;

const posInt = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

/**
 * Tên class RẺ (không dựng message) — dùng cho fingerprint trước khi qua dedupe/trần. Phải cùng kết quả với `errInfo(err).class`
 * (test khoá), vì thế thân đặt `name` bằng đúng giá trị này.
 */
export function errClass(err: unknown): string {
  if (err === null || err === undefined || typeof err === 'string') return 'Error';
  const e = err as { name?: unknown; constructor?: { name?: string }; class?: unknown; code?: unknown; msg?: unknown };
  if ('class' in e && 'code' in e && 'msg' in e) return scrubSecrets(String(e.class)).slice(0, 80); // ErrInfo dựng sẵn
  return scrubSecrets(typeof e.name === 'string' && e.name && e.name !== 'Error' ? e.name : e.constructor?.name && e.constructor.name !== 'Object' ? e.constructor.name : 'Error').slice(0, 80);
}

/** Email là PII, không có trong luật `scrubSecrets` (mẫu ngắn < MIN_SECRET_MATCH_LEN) -> che riêng ở đường Sentry. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
export function maskEmails(s: string): string {
  return s.replace(EMAIL_RE, '***@***');
}

/**
 * Message tự do (JSON.parse lộ ~10 ký tự đầu của body; poison message; tên/email trong chuỗi lạ) là nguồn PII -> với
 * `fail.poison_message` và SyntaxError chỉ gửi class + code, bỏ hẳn message.
 */
function messageless(cause: Cause, cls: string): boolean {
  return cause === 'fail.poison_message' || cls === 'SyntaxError';
}

/** Thế thân của lỗi: message sạch (`errInfo`, che email), chỉ giữ dòng frame của stack (đã scrub). Không mang `cause`/thuộc tính lạ. */
function surrogate(err: unknown, cls: string, dropMsg: boolean): Error {
  const info = errInfo(err);
  const msg = dropMsg ? (info.code === 'UNKNOWN' ? '' : info.code) : maskEmails(info.msg);
  const safe = new Error(msg);
  safe.name = cls;
  const rawStack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
  const frames = rawStack.split('\n').filter((l) => /^\s+at\s/.test(l)).slice(0, 60).map((l) => maskEmails(scrubSecrets(l)).slice(0, 300));
  safe.stack = [`${cls}: ${msg}`, ...frames].join('\n');
  return safe;
}

/** Fingerprint ổn định: không message, không id. Cùng bug -> cùng issue dù xảy ra 10 000 lần. */
export function sentryFingerprint(svc: string, cause: string, errClass: string, stage: string): string[] {
  return [svc, cause, errClass, stage];
}

/** `beforeSend`: loại mọi trường có thể mang dữ liệu khách; phần còn lại qua `scrubDeep` (bộ luật chung với log). Trả null = bỏ event. */
export function scrubSentryEvent(event: any): any {
  if (!event || typeof event !== 'object') return null;
  const msgs = [event.message, ...(event.exception?.values ?? []).map((v: any) => `${v?.type ?? ''} ${v?.value ?? ''}`)].join(' ');
  if (IGNORED_ERROR.test(msgs)) return null;
  const { request: _r, user: _u, breadcrumbs: _b, extra: _e, server_name: _s, modules: _m, ...rest } = event;
  const out: any = rest;
  if (out.tags && typeof out.tags === 'object') {
    out.tags = Object.fromEntries(Object.entries(out.tags).filter(([k]) => TAG_ALLOW.has(k) || k === 'environment' || k === 'release'));
  }
  if (out.contexts && typeof out.contexts === 'object') {
    const keep: Record<string, unknown> = {};
    for (const k of ['trace', 'runtime']) if (out.contexts[k]) keep[k] = out.contexts[k];
    out.contexts = keep;
  }
  // Lớp cuối: che email ở MỌI chuỗi của event (JSON-safe: ký tự email không cần escape).
  return JSON.parse(maskEmails(JSON.stringify(scrubDeep(out, 0))));
}

export interface InitSentryOptions {
  /** Chỉ cho test: transport giả (không gửi gì ra mạng). */
  transport?: (opts: any) => any;
  /** Chỉ cho test: không cài handler uncaughtException/unhandledRejection. */
  noProcessHandlers?: boolean;
}

/** Trả `true` nếu Sentry bật. Không DSN -> `false`, không làm gì cả. Gọi MỘT lần ở đầu `bootstrap`. */
export function initSentry(svc: SentryService, env: NodeJS.ProcessEnv = process.env, opts: InitSentryOptions = {}): boolean {
  if (state) return true;
  const dsn = (env.SENTRY_DSN ?? '').trim();
  if (!dsn) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('@sentry/node');
    sdk.init({
      dsn,
      environment: (env.SENTRY_ENVIRONMENT ?? '').trim() || (env.DEPLOY_ENV ?? '').trim() || (env.RENDER ? 'deployed' : 'local'),
      release: (env.SENTRY_RELEASE ?? '').trim() || undefined,
      sendDefaultPii: false,
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      defaultIntegrations: false, // không tự bắt uncaught/unhandled (bỏ qua cổng blame), không breadcrumb console/http, không context máy
      integrations: [],
      maxBreadcrumbs: 0,
      maxValueLength: 200,
      sendClientReports: false,
      shutdownTimeout: 2000,
      // Không đặt tracesSampleRate: tracing tắt (chỉ lỗi — §11.5).
      beforeSend: scrubSentryEvent,
      beforeBreadcrumb: () => null,
      ...(opts.transport ? { transport: opts.transport } : {}),
    });
    state = {
      sdk,
      svc,
      maxPerMin: posInt(env.SENTRY_MAX_PER_MIN, 10),
      dedupeMs: posInt(env.SENTRY_DEDUPE_WINDOW_MS, 300_000),
      seen: new Map(),
      minuteStart: 0,
      minuteCount: 0,
      lastDropLogAt: 0,
      stats: { enabled: true, sent: 0, dropped: 0, deduped: 0 },
      handlersInstalled: false,
    };
    setUnexpectedHook(canonicalHook);
    if (!opts.noProcessHandlers) installProcessHandlers();
    return true;
  } catch (e) {
    // Sentry hỏng không được làm hub không khởi động.
    logger.warn({ err: errInfo(e) }, 'Sentry: khởi tạo thất bại -> tắt');
    state = null;
    return false;
  }
}

export function sentryStats(): SentryStats {
  return state ? { ...state.stats } : { enabled: false, sent: 0, dropped: 0, deduped: 0 };
}

/** Một cửa. Không bao giờ ném, không await. Trả event id nếu đã gửi, ngược lại null. */
export function reportUnexpected(err: unknown, ctx: ReportContext = {}, now: number = Date.now()): string | null {
  const s = state;
  if (!s) return null;
  try {
    const cause: Cause = ctx.cause ?? 'fail.hub_unknown';
    const def = CAUSES[cause];
    if (!def || def.blame !== 'hub' || !SENTRY_CAUSES.has(cause) || ctx.infra) return null;
    const cls = errClass(err); // rẻ: kiểm dedupe + trần TRƯỚC khi dựng thế thân (errInfo/regex/stack)
    const stage = ctx.stage ?? 'other';
    const fp = sentryFingerprint(s.svc, cause, cls, stage);
    const key = fp.join('|');

    const last = s.seen.get(key);
    if (last !== undefined && now - last < s.dedupeMs) {
      s.stats.deduped++;
      return null;
    }
    if (now - s.minuteStart >= 60_000) {
      s.minuteStart = now;
      s.minuteCount = 0;
    }
    if (s.minuteCount >= s.maxPerMin) {
      s.stats.dropped++;
      if (now - s.lastDropLogAt >= 60_000) {
        s.lastDropLogAt = now;
        logger.warn({ cause: 'fail.hub_unknown', sentryDropped: s.stats.dropped, maxPerMin: s.maxPerMin }, 'Sentry: vượt SENTRY_MAX_PER_MIN, bỏ bớt event (log vẫn đủ)');
      }
      return null;
    }
    s.minuteCount++;
    s.seen.delete(key);
    s.seen.set(key, now);
    if (s.seen.size > 500) {
      const oldest = s.seen.keys().next().value;
      if (oldest !== undefined) s.seen.delete(oldest);
    }

    const safe = surrogate(err, cls, messageless(cause, cls));
    const tags: Record<string, string> = { svc: s.svc, cause, blame: def.blame, stage: STAGE_RE.test(stage) ? stage : 'other' };
    // Thẻ id: kiểm định dạng trước khi gắn; sai (có thể mang PII/secret) thì BỎ thẻ, không "làm sạch".
    const put = (k: string, v: unknown, re: RegExp) => {
      const t = v === undefined || v === null ? '' : String(v);
      if (t && re.test(t)) tags[k] = t;
    };
    put('trace_id', ctx.traceId, /^[0-9a-f]{32}$/);
    put('request_id', ctx.requestId, /^[A-Za-z0-9._-]{1,128}$/);
    put('tenant_id', ctx.tenantId, ID_RE);
    put('attempt', ctx.attempt, /^\d{1,3}$/);
    put('provider', ctx.provider, /^[a-z0-9_-]{1,32}$/);
    put('http_status', ctx.httpStatus, /^[1-5]\d\d$/);
    put('origin', ctx.origin, /^[A-Za-z]{1,40}$/);

    const id: string | undefined = s.sdk.withScope((scope: any) => {
      scope.setTags(tags);
      scope.setFingerprint(fp);
      scope.setLevel('error');
      return s.sdk.captureException(safe);
    });
    s.stats.sent++;
    return id ?? null;
  } catch {
    return null;
  }
}

/** Chỉ cho test: số fingerprint đang giữ trong bộ nhớ (trần 500). */
export function sentryInternalSeenSize(): number {
  return state?.seen.size ?? 0;
}

/** Móc từ canonical line: chặng suy từ `msg` (ổn định), không từ stage_ms. */
function canonicalHook(input: CanonicalInput, b: BuiltLine): void {
  const stage = input.msg === 'ingest.done' ? 'ingest' : input.msg === 'normalize.done' ? 'normalize' : input.msg === 'delivery.attempt' ? 'delivery' : 'other';
  reportUnexpected(input.err, {
    cause: b.cause ?? undefined,
    stage,
    traceId: input.traceId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    attempt: input.attempt,
    provider: input.provider,
    httpStatus: input.httpStatus,
  });
}

/** Đẩy event còn trong hàng đợi ra ngoài, tối đa `timeoutMs` (mặc định 2s — nằm TRONG SHUTDOWN_TIMEOUT_MS). Không ném. */
export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
  const s = state;
  if (!s || timeoutMs <= 0) return true;
  try {
    return Boolean(await s.sdk.flush(timeoutMs));
  } catch {
    return false;
  }
}

/** `uncaughtException` bắt cả `unhandledRejection` (Node ≥ 15, chế độ `throw`; `origin` phân biệt). Giữ đúng hành vi cũ: log, rồi thoát mã 1. */
function installProcessHandlers(): void {
  const s = state;
  if (!s || s.handlersInstalled) return;
  s.handlersInstalled = true;
  s.onUncaught = (err: unknown, origin: string) => {
    try {
      // `err` thô: logger tự scrub và GHI CẢ STACK (scrubError) TRƯỚC khi flush — không mất stack khi tiến trình sắp chết.
      logger.error({ cause: 'fail.hub_unknown', blame: 'hub', origin, err }, 'Lỗi không bắt được -> báo Sentry rồi thoát');
      reportUnexpected(err, { cause: 'fail.hub_unknown', stage: 'process', origin });
    } catch {
      /* vẫn phải thoát */
    }
    void flushSentry(2000).finally(() => process.exit(1));
  };
  process.on('uncaughtException', s.onUncaught);
}

/** Chỉ cho test: tháo handler, đóng SDK, về trạng thái tắt. */
export async function closeSentry(): Promise<void> {
  const s = state;
  state = null;
  setUnexpectedHook(null);
  if (!s) return;
  if (s.onUncaught) process.removeListener('uncaughtException', s.onUncaught);
  try {
    await s.sdk.close(500);
  } catch {
    /* bỏ qua */
  }
}
