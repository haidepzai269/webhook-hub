import { logger } from '@hub/common';

/** Chu kỳ ghi bộ đếm bản trùng xuống Postgres (cùng nhịp `metrics.tick` — 5s). */
export const DUPLICATE_FLUSH_MS = 5_000;
const HOUR_MS = 3_600_000;

export type DuplicateSink = (tenantId: string, rows: { sourceId: string; bucket: Date; n: number }[]) => Promise<unknown>;

/**
 * CB6 (ADR-171): đếm bản trùng hub đã chặn để nhận định `I-dup` đọc từ POSTGRES (không Redis — ngân sách R1 không đổi).
 *
 * - `record()` chỉ cộng một số trong bộ nhớ: KHÔNG I/O, không nằm trên đường ACK (BB-3 không đổi — ACK trùng vẫn 200 ngay).
 * - Lần `record()` đầu sau một lượt ghi hẹn MỘT timer `DUPLICATE_FLUSH_MS` (unref); không có bản trùng thì không có timer.
 * - Ghi: mỗi project MỘT câu `INSERT … ON CONFLICT DO UPDATE n = n + …` (qua `forTenant`, RLS). Lỗi ghi -> cộng trả lại vào
 *   bộ nhớ để lượt sau thử lại (bộ đếm là bằng chứng, không phải trọng tài — mất vài số khi tiến trình bị SIGKILL là chấp nhận).
 */
export class DuplicateCounter {
  private pending = new Map<string, { tenantId: string; sourceId: string; bucket: number; n: number }>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly sink: DuplicateSink,
    private readonly flushMs = DUPLICATE_FLUSH_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  record(tenantId: string, sourceId: string): void {
    const bucket = Math.floor(this.clock() / HOUR_MS) * HOUR_MS;
    const k = `${tenantId}|${sourceId}|${bucket}`;
    const cur = this.pending.get(k);
    if (cur) cur.n++;
    else this.pending.set(k, { tenantId, sourceId, bucket, n: 1 });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.flushMs <= 0 || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Lượt lỗi đã cộng trả phần chưa ghi -> hẹn lượt sau.
      void this.flush().then(() => this.pending.size > 0 && this.schedule());
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Số bản trùng chưa ghi (test/metrics). */
  pendingCount(): number {
    let n = 0;
    for (const v of this.pending.values()) n += v.n;
    return n;
  }

  /** Ghi hết phần đang chờ. Gọi chồng thì chờ lượt đang chạy rồi ghi tiếp phần mới. */
  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    const byTenant = new Map<string, { sourceId: string; bucket: Date; n: number }[]>();
    for (const v of batch.values()) {
      const rows = byTenant.get(v.tenantId) ?? [];
      rows.push({ sourceId: v.sourceId, bucket: new Date(v.bucket), n: v.n });
      byTenant.set(v.tenantId, rows);
    }
    this.flushing = (async () => {
      for (const [tenantId, rows] of byTenant) {
        try {
          await this.sink(tenantId, rows);
        } catch (err: any) {
          logger.warn({ err: err?.message, tenantId, rows: rows.length }, 'Không ghi được bộ đếm bản trùng -> giữ lại cho lượt sau');
          for (const r of rows) {
            const k = `${tenantId}|${r.sourceId}|${r.bucket.getTime()}`;
            const cur = this.pending.get(k);
            if (cur) cur.n += r.n;
            else this.pending.set(k, { tenantId, sourceId: r.sourceId, bucket: r.bucket.getTime(), n: r.n });
          }
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /** Tắt tiến trình: huỷ timer, ghi nốt (một lần, không thử lại). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }
}
