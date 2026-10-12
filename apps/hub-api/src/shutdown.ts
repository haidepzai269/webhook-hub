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

export function installShutdown(flush: () => Promise<void>, env: NodeJS.ProcessEnv = process.env): void {
  const shutdownTimeoutMs = parseInt(env.SHUTDOWN_TIMEOUT_MS || '25000', 10);
  let started = false;
  const handle = (signal: string) => {
    if (started) return;
    started = true;
    logger.info(`Nhận tín hiệu ${signal} — ghi nốt bộ đếm bản trùng rồi thoát`);
    void flushThenExit(flush, { shutdownTimeoutMs: Number.isFinite(shutdownTimeoutMs) ? shutdownTimeoutMs : 25_000, exit: (c) => process.exit(c) });
  };
  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}
