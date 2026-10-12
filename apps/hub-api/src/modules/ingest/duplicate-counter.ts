import { logger } from '@hub/common';

/** Chu kỳ ghi bộ đếm bản trùng xuống Postgres (cùng nhịp `metrics.tick` — 5s). */
export const DUPLICATE_FLUSH_MS = 5_000;
const HOUR_MS = 3_600_000;

type Row = { sourceId: string; bucket: Date; n: number };
export type DuplicateSink = (tenantId: string, rows: Row[]) => Promise<unknown>;

const rowOrder = (a: Row, b: Row) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.bucket.getTime() - b.bucket.getTime());

/** Postgres 23503 (foreign_key_violation) — Prisma raw: `P2010` + `meta.code`, hoặc mã nằm trong message. */
export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (!e) return false;
  if (e.meta?.code === '23503' || e.code === '23503') return true;
  return typeof e.message === 'string' && /\b23503\b|foreign key constraint/i.test(e.message);
}

/**
 * CB6 (ADR-171): đếm bản trùng hub đã chặn để nhận định `I-dup` đọc từ POSTGRES (không Redis — ngân sách R1 không đổi).
 *
 * - `record()` chỉ cộng một số trong bộ nhớ: KHÔNG I/O, không nằm trên đường ACK (BB-3 không đổi — ACK trùng vẫn 200 ngay).
 * - Lần `record()` đầu sau một lượt ghi hẹn MỘT timer `DUPLICATE_FLUSH_MS` (unref); không có bản trùng thì không có timer.
 * - Ghi: mỗi project MỘT câu `INSERT … ON CONFLICT DO UPDATE n = n + …` (qua `forTenant`, RLS). Lỗi ghi -> cộng trả lại vào
 *   bộ nhớ để lượt sau thử lại (bộ đếm là bằng chứng, không phải trọng tài — mất vài số khi tiến trình bị SIGKILL là chấp nhận).
 * - Review CB6 (Thấp 4): vi phạm khoá ngoại (23503 — source đã bị xoá giữa hai lượt) thì ghi lại TỪNG DÒNG và BỎ dòng hỏng
 *   (không cộng trả mãi mãi); log một lần mỗi lượt có dòng bị bỏ. Lỗi tạm (DB mất) chỉ log khi chuyển sang trạng thái lỗi.
 * - Review CB6 (Thấp 5): dòng trong một câu xếp theo (sourceId, bucket) — nhiều instance cùng upsert khoá dòng theo cùng
 *   thứ tự, không deadlock.
 * - Shutdown: `main.ts` gọi `close()` khi SIGTERM/SIGINT, có trần thời gian trong `SHUTDOWN_TIMEOUT_MS`.
 */
export class DuplicateCounter {
  private pending = new Map<string, { tenantId: string; sourceId: string; bucket: number; n: number }>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;
  /** Đang trong chuỗi lỗi ghi tạm thời — chỉ log lần đầu. */
  private failing = false;

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
    const byTenant = new Map<string, Row[]>();
    for (const v of batch.values()) {
      const rows = byTenant.get(v.tenantId) ?? [];
      rows.push({ sourceId: v.sourceId, bucket: new Date(v.bucket), n: v.n });
      byTenant.set(v.tenantId, rows);
    }
    this.flushing = (async () => {
      for (const [tenantId, rows] of [...byTenant].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        rows.sort(rowOrder);
        try {
          await this.sink(tenantId, rows);
          this.failing = false;
        } catch (err: any) {
          if (isForeignKeyViolation(err)) await this.writeRowByRow(tenantId, rows);
          else this.keepForRetry(tenantId, rows, err);
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /** Lô bị khoá ngoại từ chối: ghi từng dòng, dòng nào vẫn 23503 thì bỏ (source không còn), dòng khác giữ như cũ. */
  private async writeRowByRow(tenantId: string, rows: Row[]): Promise<void> {
    let dropped = 0;
    for (const r of rows) {
      try {
        await this.sink(tenantId, [r]);
      } catch (err: any) {
        if (isForeignKeyViolation(err)) dropped += r.n;
        else this.keepForRetry(tenantId, [r], err);
      }
    }
    if (dropped > 0) logger.warn({ tenantId, dropped }, 'Bộ đếm bản trùng: source không còn (khoá ngoại) -> bỏ số đếm của nó');
  }

  private keepForRetry(tenantId: string, rows: Row[], err: any): void {
    if (!this.failing) logger.warn({ err: err?.message, tenantId, rows: rows.length }, 'Không ghi được bộ đếm bản trùng -> giữ lại cho lượt sau');
    this.failing = true;
    for (const r of rows) {
      const k = `${tenantId}|${r.sourceId}|${r.bucket.getTime()}`;
      const cur = this.pending.get(k);
      if (cur) cur.n += r.n;
      else this.pending.set(k, { tenantId, sourceId: r.sourceId, bucket: r.bucket.getTime(), n: r.n });
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
