import { logger } from '@hub/common';

/** Trần cho việc ghi nốt bộ đếm bản trùng khi tắt (một câu upsert / project) — luôn nằm trong `SHUTDOWN_TIMEOUT_MS`. */
export const DUPLICATE_SHUTDOWN_FLUSH_MS = 5_000;

/**
 * Review CB6 (Thấp 3): hub-api trước đây không bắt SIGTERM (Node chết ngay, mặc định) nên `onModuleDestroy` không bao giờ
 * chạy và số bản trùng chưa ghi bị mất. Bắt SIGTERM/SIGINT MỘT lần: ghi nốt bộ đếm (trần min(5s, SHUTDOWN_TIMEOUT_MS)) rồi
 * thoát — KHÔNG gọi `app.close()` (không đổi hành vi với request đang dở: như cũ, tiến trình dừng), nên ngân sách 25s
 * (Render SIGKILL ~30s) không bị đụng. Lỗi/quá hạn khi ghi -> vẫn thoát 0: bộ đếm là bằng chứng, không phải trọng tài.
 */
export async function flushThenExit(
  flush: () => Promise<void>,
  opts: { shutdownTimeoutMs: number; exit: (code: number) => void },
): Promise<'flushed' | 'timeout' | 'error'> {
  const budget = Math.max(0, Math.min(DUPLICATE_SHUTDOWN_FLUSH_MS, opts.shutdownTimeoutMs));
  let timer: NodeJS.Timeout | undefined;
  let outcome: 'flushed' | 'timeout' | 'error';
  try {
    outcome = await Promise.race([
      flush().then(() => 'flushed' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), budget);
      }),
    ]);
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Shutdown: không ghi nốt được bộ đếm bản trùng');
    outcome = 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
  logger.info({ outcome }, 'Shutdown hub-api');
  opts.exit(0);
  return outcome;
}

/**
 * EG4 (ADR-179): bộ đệm khác cần ghi nốt khi tắt (lưu lượng theo source) tự đăng ký ở đây — chạy SONG SONG với `flush` của
 * `installShutdown`, chung trần thời gian. Lỗi của một bộ không chặn bộ khác (best-effort).
 */
const extraFlushers = new Set<() => Promise<void>>();
export function onShutdownFlush(fn: () => Promise<void>): () => void {
  extraFlushers.add(fn);
  return () => {
    extraFlushers.delete(fn);
  };
}

/** `flush` chính + mọi bộ đã đăng ký, song song; lỗi riêng từng bộ chỉ log. */
export async function flushAll(flush: () => Promise<void>): Promise<void> {
  const results = await Promise.allSettled([flush(), ...[...extraFlushers].map((f) => f())]);
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  if (failed.length) logger.warn({ errs: failed.map((f) => f.reason?.message ?? String(f.reason)) }, 'Shutdown: một số bộ đệm không ghi nốt được');
}

export function installShutdown(flush: () => Promise<void>, env: NodeJS.ProcessEnv = process.env): void {
  const shutdownTimeoutMs = parseInt(env.SHUTDOWN_TIMEOUT_MS || '25000', 10);
  let started = false;
  const handle = (signal: string) => {
    if (started) return;
    started = true;
    logger.info(`Nhận tín hiệu ${signal} — ghi nốt bộ đếm bản trùng rồi thoát`);
    void flushThenExit(() => flushAll(flush), { shutdownTimeoutMs: Number.isFinite(shutdownTimeoutMs) ? shutdownTimeoutMs : 25_000, exit: (c) => process.exit(c) });
  };
  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}
