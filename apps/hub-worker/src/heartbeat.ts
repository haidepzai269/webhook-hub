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
type WarnLog = { warn: (obj: Record<string, unknown>, msg: string) => void };

export interface ExternalHeartbeatOpts {
  url: string | undefined;
  intervalMs?: number;
  fetchFn?: typeof fetch;
  now?: number;
  maxAgeMs?: number;
  log?: WarnLog;
}

/**
 * MỘT lượt: heartbeat nội bộ còn tươi mới GET URL. Không bao giờ ném. Không log URL (URL kiểu Healthchecks.io là bí mật).
 * Trả: 'sent' | 'stale' (nội bộ cũ, cố ý im để dịch vụ ngoài báo) | 'error'.
 */
export async function pingExternalOnce(o: ExternalHeartbeatOpts & { url: string }): Promise<'sent' | 'stale' | 'error'> {
  const now = o.now ?? Date.now();
  if (!isHeartbeatFresh(o.maxAgeMs ?? HEARTBEAT_MAX_AGE_MS, now)) return 'stale';
  const log = o.log ?? logger;
  try {
    const res = await (o.fetchFn ?? fetch)(o.url, { method: 'GET', signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) });
    if (!res.ok) {
      log.warn({ status: res.status }, 'HEARTBEAT_URL trả không phải 2xx');
      return 'error';
    }
    return 'sent';
  } catch (e: any) {
    log.warn({ err: e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? 'lỗi mạng') }, 'HEARTBEAT_URL gọi lỗi (bỏ qua, lượt sau thử lại)');
    return 'error';
  }
}

/** Tắt mặc định: không đặt URL -> trả null, không timer, không fetch. */
export function startExternalHeartbeat(o: ExternalHeartbeatOpts): { stop: () => void } | null {
  const url = o.url?.trim();
  if (!url) return null;
  const interval = Number.isFinite(o.intervalMs) && (o.intervalMs as number) > 0 ? (o.intervalMs as number) : 60_000;
  const timer = setInterval(() => {
    void pingExternalOnce({ ...o, url, now: undefined });
  }, interval);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export function startExternalHeartbeatFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return startExternalHeartbeat({ url: env.HEARTBEAT_URL, intervalMs: Number(env.HEARTBEAT_INTERVAL_MS) || 60_000 });
}
