/**
 * Đếm handler message đang chạy (review SPEC-1 #3). Graceful shutdown: huỷ consume để không nhận
 * message mới, `waitIdle(timeout)` chờ các handler đang dở ghi DB + ack xong, RỒI mới đóng channel.
 * Đóng channel giữa lúc handler đang chạy = ack rơi vào channel chết -> message redeliver gặp lease
 * DELIVERING còn hạn.
 */
export class InFlightTracker {
  private readonly running = new Set<Promise<unknown>>();

  get count(): number {
    return this.running.size;
  }

  track<T>(p: Promise<T>): void {
    const tracked = p.then(
      () => undefined,
      () => undefined, // handler tự log lỗi; ở đây chỉ đếm
    );
    this.running.add(tracked);
    tracked.finally(() => this.running.delete(tracked));
  }

  /** true = đã rảnh; false = hết `timeoutMs` mà vẫn còn handler chạy. */
  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.all([...this.running]).then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), left))),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) return this.running.size === 0;
    }
    return true;
  }
}
