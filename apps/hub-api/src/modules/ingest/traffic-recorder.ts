import { logger } from '@hub/common';
import type { SourceTrafficRow } from '@hub/database';
import { isForeignKeyViolation } from './duplicate-counter';
import { clampEnvInt, ipKey } from './penalty-box';

/**
 * EG4 (SPEC-chong-qua-tai §5.2, ADR-179): lưu lượng theo (source, phút, outcome), gộp TRONG BỘ NHỚ rồi đẩy xuống Postgres.
 *
 * - `record()` chỉ cộng vào một Map: KHÔNG I/O, không nằm trên đường ACK (BB-3), 0 lệnh Redis (R1 không đổi).
 * - Mỗi `TRAFFIC_FLUSH_MS` (mặc định 60s): nhóm theo project, mỗi project MỘT câu upsert qua `forTenant` (RLS, BB-5);
 *   dòng xếp theo (source, minute, outcome) -> nhiều instance khoá dòng cùng thứ tự, không deadlock.
 * - Ghi lỗi (DB chậm/chết): giữ lại cho lượt sau, có trần `TRAFFIC_BUFFER_MAX_MS` (10 phút dữ liệu) — phần cũ hơn bị bỏ và
 *   đếm vào `hub_traffic_flush_dropped_total`. Số liệu quan sát: được phép thiếu, không được làm chậm ingest.
 * - Khoá ngoại (source vừa bị xoá giữa hai lượt) -> ghi từng dòng, bỏ dòng hỏng (như DuplicateCounter).
 * - `top_ips`: mỗi ô giữ tối đa `IPS_PER_CELL` IP khác nhau (IP mới quá trần chỉ được đếm vào `count`), ghi 5 IP nhiều nhất.
 */
export type TrafficOutcome = SourceTrafficRow['outcome'];
export type TrafficSink = (tenantId: string, rows: SourceTrafficRow[]) => Promise<unknown>;

const MINUTE_MS = 60_000;
export const TRAFFIC_BUFFER_MAX_MS = 10 * MINUTE_MS;
export const IPS_PER_CELL = 64;

export function resolveTrafficFlushMs(v: string | undefined = process.env.TRAFFIC_FLUSH_MS): number {
  return clampEnvInt(v, 60_000, 5_000, 600_000);
}

interface Cell {
  tenantId: string;
  sourceId: string;
  minute: number;
  outcome: TrafficOutcome;
  count: number;
  ips: Map<string, number>;
}

const OUTCOME_ORDER: Record<TrafficOutcome, number> = { ACCEPTED: 0, DUPLICATE: 1, REJECTED: 2, RATE_LIMITED: 3, BLOCKED: 4 };
const rowOrder = (a: SourceTrafficRow, b: SourceTrafficRow) =>
  a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.minute.getTime() - b.minute.getTime() || OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome];

export class TrafficRecorder {
  private pending = new Map<string, Cell>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;
  private failing = false;

  constructor(
    private readonly sink: TrafficSink,
    private readonly opts: { flushMs?: number; maxAgeMs?: number; clock?: () => number; onDropped?: (n: number) => void } = {},
  ) {}

  private get flushMs() {
    return this.opts.flushMs ?? resolveTrafficFlushMs();
  }
  private now() {
    return (this.opts.clock ?? Date.now)();
  }

  record(tenantId: string, sourceId: string, outcome: TrafficOutcome, ip?: string): void {
    const minute = Math.floor(this.now() / MINUTE_MS) * MINUTE_MS;
    const k = `${tenantId}|${sourceId}|${minute}|${outcome}`;
    let cell = this.pending.get(k);
    if (!cell) {
      cell = { tenantId, sourceId, minute, outcome, count: 0, ips: new Map() };
      this.pending.set(k, cell);
    }
    cell.count++;
    const key = ipKey(ip);
    if (key) {
      const cur = cell.ips.get(key);
      if (cur !== undefined) cell.ips.set(key, cur + 1);
      else if (cell.ips.size < IPS_PER_CELL) cell.ips.set(key, 1);
    }
    this.schedule();
  }

  /** Số request chưa ghi (test/metrics). */
  pendingCount(): number {
    let n = 0;
    for (const c of this.pending.values()) n += c.count;
    return n;
  }

  private schedule(): void {
    if (this.timer || this.flushMs <= 0 || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().then(() => this.pending.size > 0 && this.schedule());
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Bỏ ô cũ hơn trần bộ đệm (10 phút) — chỉ xảy ra khi ghi lỗi liên tục. */
  private prune(): void {
    const cutoff = this.now() - (this.opts.maxAgeMs ?? TRAFFIC_BUFFER_MAX_MS);
    let dropped = 0;
    for (const [k, c] of this.pending) {
      if (c.minute < cutoff) {
        dropped += c.count;
        this.pending.delete(k);
      }
    }
    if (dropped > 0) {
      logger.warn({ dropped }, 'Lưu lượng: bộ đệm vượt trần 10 phút -> bỏ phần cũ nhất');
      try {
        this.opts.onDropped?.(dropped);
      } catch {
        /* metric không làm hỏng gì */
      }
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    this.prune();
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    const byTenant = new Map<string, SourceTrafficRow[]>();
    for (const c of batch.values()) {
      const rows = byTenant.get(c.tenantId) ?? [];
      rows.push({
        sourceId: c.sourceId,
        minute: new Date(c.minute),
        outcome: c.outcome,
        count: c.count,
        topIps: [...c.ips].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([ip, count]) => ({ ip, count })),
      });
      byTenant.set(c.tenantId, rows);
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

  private async writeRowByRow(tenantId: string, rows: SourceTrafficRow[]): Promise<void> {
    let dropped = 0;
    for (const r of rows) {
      try {
        await this.sink(tenantId, [r]);
      } catch (err: any) {
        if (isForeignKeyViolation(err)) dropped += r.count;
        else this.keepForRetry(tenantId, [r], err);
      }
    }
    if (dropped > 0) logger.warn({ tenantId, dropped }, 'Lưu lượng: source không còn (khoá ngoại) -> bỏ số đếm của nó');
  }

  /** Cộng trả vào bộ đệm (top_ips đã cắt còn 5 — chấp nhận, đây là số liệu quan sát). */
  private keepForRetry(tenantId: string, rows: SourceTrafficRow[], err: any): void {
    if (!this.failing) logger.warn({ err: err?.message, tenantId, rows: rows.length }, 'Không ghi được lưu lượng -> giữ lại cho lượt sau (trần 10 phút)');
    this.failing = true;
    for (const r of rows) {
      const minute = r.minute.getTime();
      const k = `${tenantId}|${r.sourceId}|${minute}|${r.outcome}`;
      let cell = this.pending.get(k);
      if (!cell) {
        cell = { tenantId, sourceId: r.sourceId, minute, outcome: r.outcome, count: 0, ips: new Map() };
        this.pending.set(k, cell);
      }
      cell.count += r.count;
      for (const { ip, count } of r.topIps) cell.ips.set(ip, (cell.ips.get(ip) ?? 0) + count);
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
