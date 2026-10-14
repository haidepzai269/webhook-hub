import { performance } from 'perf_hooks';

/**
 * BP1 review M3 (gốc ở hub-worker `delivery.consumer.ts`, dời về đây ở review PK10 T-b để hub-api dùng chung): lỗi lặp lại
 * không log mỗi lần. Tối đa một dòng mỗi `intervalMs`, kèm số lần đã gộp. Đếm trong bộ nhớ (0 lệnh Redis).
 */
export const LOG_THROTTLE_INTERVAL_MS = 30_000;
export class LogThrottle {
  private lastAt = -Infinity;
  private suppressed = 0;
  constructor(
    private readonly intervalMs = LOG_THROTTLE_INTERVAL_MS,
    // Đồng hồ đơn điệu (review L2-1): chỉnh giờ hệ thống/NTP không làm log im lâu hay bật lại sớm. Test tiêm đồng hồ giả.
    private readonly now: () => number = () => performance.now(),
  ) {}
  /** Trả số lần đã gộp từ dòng log trước (>= 0) nếu được log lúc này; null nếu phải im. */
  take(): number | null {
    const t = this.now();
    if (t - this.lastAt < this.intervalMs) {
      this.suppressed++;
      return null;
    }
    const n = this.suppressed;
    this.lastAt = t;
    this.suppressed = 0;
    return n;
  }
}
