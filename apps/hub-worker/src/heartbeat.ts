import { logger } from '@hub/common';
import { workerHeartbeat } from './metrics';

/**
 * ADR-248 — heartbeat của hub-worker. CHỈ trong bộ nhớ (0 lệnh Redis, giữ ngân sách R1).
 * `beat()` được gọi khi vòng lặp làm việc THẬT hoàn tất một lượt (outbox relay: đọc Postgres + publish + COMMIT thành
 * công) — không phải "process còn sống". Lượt lỗi / chưa có channel thì không beat -> timestamp cũ dần.
 */
/** Quá ngưỡng này kể từ lượt thành công cuối thì heartbeat coi là cũ (relay tick ~0.5s, một lô tối đa 15s). */
export const HEARTBEAT_MAX_AGE_MS = 45_000;

let lastBeatMs: number | null = null;

export function beat(nowMs: number = Date.now()): void {
  lastBeatMs = nowMs;
  workerHeartbeat.set(nowMs / 1000);
}

/** null nếu chưa beat lần nào. */
export function heartbeatAgeMs(nowMs: number = Date.now()): number | null {
  return lastBeatMs === null ? null : nowMs - lastBeatMs;
}

export function isHeartbeatFresh(maxAgeMs: number = HEARTBEAT_MAX_AGE_MS, nowMs: number = Date.now()): boolean {
  const age = heartbeatAgeMs(nowMs);
  return age !== null && age <= maxAgeMs;
}

export function resetHeartbeatForTest(): void {
  lastBeatMs = null;
  workerHeartbeat.reset();
}

// ---------------------------------------------------------------- heartbeat ngoài (dead-man's switch)

const EXTERNAL_TIMEOUT_MS = 5_000;
const MIN_INTERVAL_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
type WarnLog = { warn: (obj: Record<string, unknown>, msg: string) => void };

export interface ExternalHeartbeatOpts {
  url: string | undefined;
  intervalMs?: number;
  fetchFn?: typeof fetch;
  now?: number;
  maxAgeMs?: number;
  log?: WarnLog;
}

/** Chỉ http/https hợp lệ; trả chuỗi URL chuẩn hoá hoặc null. KHÔNG bao giờ ném, không log giá trị. */
export function parseHeartbeatUrl(raw: string | undefined): string | null {
  const t = raw?.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * MỘT lượt: heartbeat nội bộ còn tươi mới GET URL. Không bao giờ ném.
 * URL kiểu Healthchecks.io là BÍ MẬT: không log URL, không log `e.message` (lỗi parse/DNS của fetch nhúng URL vào message) —
 * chỉ `e.name` + `e.cause.code`. `redirect: 'error'` để URL không bị chuyển hướng sang nơi khác.
 * Trả: 'sent' | 'stale' (nội bộ cũ, cố ý im để dịch vụ ngoài báo) | 'error'.
 */
export async function pingExternalOnce(o: ExternalHeartbeatOpts & { url: string }): Promise<'sent' | 'stale' | 'error'> {
  const now = o.now ?? Date.now();
  if (!isHeartbeatFresh(o.maxAgeMs ?? HEARTBEAT_MAX_AGE_MS, now)) return 'stale';
  const log = o.log ?? logger;
  try {
    const res = await (o.fetchFn ?? fetch)(o.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) });
    if (!res.ok) {
      log.warn({ status: res.status }, 'HEARTBEAT_URL trả không phải 2xx');
      return 'error';
    }
    return 'sent';
  } catch (e: any) {
    log.warn({ errName: String(e?.name ?? 'Error'), code: e?.cause?.code ?? e?.code ?? null }, 'HEARTBEAT_URL gọi lỗi (bỏ qua, lượt sau thử lại)');
    return 'error';
  }
}

/** Tắt mặc định: không đặt URL -> null, không timer, không fetch. URL sai -> log KHÔNG kèm giá trị và vô hiệu. */
export function startExternalHeartbeat(o: ExternalHeartbeatOpts): { stop: () => void } | null {
  if (!o.url?.trim()) return null;
  const url = parseHeartbeatUrl(o.url);
  if (!url) {
    (o.log ?? logger).warn({}, 'HEARTBEAT_URL không hợp lệ (cần http/https) — heartbeat ngoài bị vô hiệu');
    return null;
  }
  const requested = Number.isFinite(o.intervalMs) && (o.intervalMs as number) > 0 ? (o.intervalMs as number) : DEFAULT_INTERVAL_MS;
  const interval = Math.max(MIN_INTERVAL_MS, requested);
  const timer = setInterval(() => {
    void pingExternalOnce({ ...o, url, now: undefined });
  }, interval);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function startExternalHeartbeatFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return startExternalHeartbeat({ url: env.HEARTBEAT_URL, intervalMs: Number(env.HEARTBEAT_INTERVAL_MS) || DEFAULT_INTERVAL_MS });
}
