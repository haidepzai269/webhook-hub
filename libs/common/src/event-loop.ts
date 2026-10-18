import { monitorEventLoopDelay } from 'perf_hooks';

/**
 * LOGGING.md §3.2: `slow.hub_cpu` — p99 độ trễ event loop lấy mẫu LIÊN TỤC trong bộ nhớ (perf_hooks, không I/O), đọc mỗi nhịp
 * `metrics.tick` (5s) -> gauge `hub_event_loop_lag_seconds`. Trả hàm dừng. Timer `unref`.
 */
export function startEventLoopMonitor(onTick: (p99Ms: number) => void, intervalMs = 5000, resolutionMs = 20): () => void {
  const h = monitorEventLoopDelay({ resolution: resolutionMs });
  h.enable();
  const timer = setInterval(() => {
    try {
      const p99 = h.percentile(99) / 1e6; // ns -> ms
      h.reset();
      if (Number.isFinite(p99)) onTick(p99);
    } catch {
      /* đo đạc không bao giờ ném */
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    h.disable();
  };
}
