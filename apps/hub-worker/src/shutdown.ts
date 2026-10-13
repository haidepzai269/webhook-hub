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
