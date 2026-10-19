/**
 * Graceful shutdown của hub-worker (ARCHITECTURE §5.6, review SPEC-1 #3, BP5 C5 — ADR-200), tách khỏi `main.ts` để test được
 * THỨ TỰ (review BP5 lượt 1):
 *  1. huỷ consume — không nhận message mới;
 *  2. `backpressure.shutdown()` — message đang CHỜ permit trả về ngay: không xử lý, không republish, không ack (đóng channel
 *     -> RabbitMQ giao lại cho tiến trình khác);
 *  3. chờ handler ĐÃ có permit ghi DB + ack xong (`inFlight.waitIdle`), song song với các việc nền đang dừng — cùng ngân sách;
 *  4. mới đóng channel / kết nối.
 */
export interface GracefulStopDeps {
  cancelConsumers: () => Promise<void>;
  backpressure: { shutdown(): void } | null;
  inFlight: { waitIdle(timeoutMs: number): Promise<boolean>; readonly count: number };
  /** Việc nền đang dừng (lượt cảnh báo, vòng email) — chờ SONG SONG với handler, không cộng dồn ngân sách. */
  background?: Promise<unknown>[];
  /** Ngân sách chờ handler (SHUTDOWN_TIMEOUT_MS − 5s cho việc đóng kết nối). */
  waitBudgetMs: number;
  closeAll: () => Promise<void>;
}

export async function gracefulStop(d: GracefulStopDeps): Promise<{ idle: boolean; stillRunning: number }> {
  await d.cancelConsumers();
  d.backpressure?.shutdown();
  const [, idle] = await Promise.all([Promise.all(d.background ?? []), d.inFlight.waitIdle(Math.max(0, d.waitBudgetMs))]);
  const stillRunning = d.inFlight.count;
  await d.closeAll();
  return { idle, stillRunning };
}

/** Trần flush Sentry khi tắt thành công / khi quá hạn (ADR-258 bổ sung): thành công nằm TRONG ngân sách, quá hạn chỉ thêm một nhát ngắn. */
export const SENTRY_FLUSH_MS = 2_000;
export const SENTRY_FLUSH_AFTER_TIMEOUT_MS = 300;

/**
 * Chạy `work` trong ngân sách `timeoutMs` (SHUTDOWN_TIMEOUT_MS), flush Sentry nằm TRONG ngân sách đó: sau khi `work` xong, flush tối đa
 * min(2s, phần còn lại). Quá hạn -> flush thêm tối đa 300 ms rồi ném (tổng ≤ timeoutMs + 300 ms, dưới SIGKILL ~30s của Render).
 */
export async function shutdownWithinBudget(
  work: () => Promise<void>,
  timeoutMs: number,
  flush: (ms: number) => Promise<unknown>,
  now: () => number = Date.now,
): Promise<void> {
  const deadline = now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await work();
        await flush(Math.max(0, Math.min(SENTRY_FLUSH_MS, deadline - now())));
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Shutdown timeout vượt quá giới hạn')), timeoutMs);
      }),
    ]);
  } catch (e) {
    await flush(SENTRY_FLUSH_AFTER_TIMEOUT_MS).catch(() => undefined);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
