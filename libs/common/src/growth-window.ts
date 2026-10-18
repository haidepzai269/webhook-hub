import { Cause } from './causes';
import { BuiltLine, CanonicalLogger } from './log-line';
import { newTraceId } from './trace-context';

/**
 * LOGGING.md §2.3/§3 (ADR-250): "TĂNG NHANH vì đâu" — log TỔNG HỢP theo cửa sổ 60s (`growth.window`), không phải mỗi sự kiện.
 * Nguồn dữ liệu là CHÍNH các canonical line (observer thấy cả dòng bị lấy mẫu bỏ) -> 0 lệnh Redis, 0 truy vấn DB, không thêm
 * điểm đo ở đường nóng. Mọi bộ đếm nằm trong bộ nhớ, có trần số khoá; `tenant_id` chỉ là thuộc tính của dòng (không là nhãn metric).
 */
export interface GrowthSettings {
  windowMs: number;
  /** `growth.burst_source`: lưu lượng cửa sổ > factor × đường nền. */
  burstFactor: number;
  /** Dưới ngưỡng tuyệt đối này (sự kiện / cửa sổ) không bao giờ báo — traffic thấp dao động ngẫu nhiên. */
  minCount: number;
  /** `growth.dup_flood`: tỉ lệ trùng của một source vượt ngưỡng này (và đủ minCount). */
  dupRatio: number;
  /** `growth.dlq_swell`: số delivery DEAD / cửa sổ. */
  dlqMin: number;
  /** `growth.backlog`: số cửa sổ liên tiếp có chờ hàng đợi / tuổi outbox vượt ngưỡng chậm. */
  backlogWindows: number;
  /** `growth.retry_storm`: tỉ lệ lần thử thất bại còn retry của một đích. */
  retryRatio: number;
  maxKeys: number;
}

export const DEFAULT_GROWTH: GrowthSettings = { windowMs: 60_000, burstFactor: 5, minCount: 100, dupRatio: 0.5, dlqMin: 20, backlogWindows: 3, retryRatio: 0.5, maxKeys: 5000 };

function num(v: string | undefined, d: number, min = 0): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > min ? n : d;
}

export function resolveGrowth(env: Record<string, string | undefined> = process.env): GrowthSettings {
  const d = DEFAULT_GROWTH;
  return {
    windowMs: num(env.GROWTH_WINDOW_MS, d.windowMs, 999),
    burstFactor: num(env.GROWTH_BURST_FACTOR, d.burstFactor, 1),
    minCount: Math.round(num(env.GROWTH_MIN_COUNT, d.minCount)),
    dupRatio: Math.min(1, num(env.GROWTH_DUP_RATIO, d.dupRatio)),
    dlqMin: Math.round(num(env.GROWTH_DLQ_MIN, d.dlqMin)),
    backlogWindows: Math.round(num(env.GROWTH_BACKLOG_WINDOWS, d.backlogWindows)),
    retryRatio: Math.min(1, num(env.GROWTH_RETRY_RATIO, d.retryRatio)),
    maxKeys: d.maxKeys,
  };
}

export interface GrowthSignal {
  cause: Cause;
  svc: 'hub-api' | 'hub-worker';
  tenantId?: string;
  sourceId?: string;
  destinationId?: string;
  provider?: string;
  windowS: number;
  count: number;
  baselinePerMin?: number;
  factor?: number;
  duplicateRatio?: number;
  lastCause?: string;
  hint: string;
}

interface Counter {
  total: number;
  dup: number;
  ok: number;
  retry: number;
  dead: number;
  tenantId?: string;
  provider?: string;
  deadCauses: Map<string, number>;
}

const newCounter = (): Counter => ({ total: 0, dup: 0, ok: 0, retry: 0, dead: 0, deadCauses: new Map() });

const EWMA = 0.3;

export class GrowthWindow {
  private bySource = new Map<string, Counter>();
  private byDestination = new Map<string, Counter>();
  private readonly baseline = new Map<string, number>();
  private backlogStreak = 0;
  private windowMaxWaitMs = 0;
  private overflow = 0;

  constructor(readonly settings: GrowthSettings = resolveGrowth(), private readonly slowWaitMs = 5000) {}

  /** Cho `CanonicalObserver`: nhìn MỌI dòng (kể cả bị mẫu/gộp bỏ). Không ném. */
  observe(b: BuiltLine): void {
    try {
      const r = b.record;
      if (r.msg === 'ingest.done' && typeof r.source_id === 'string') {
        const c = this.slot(this.bySource, r.source_id);
        if (!c) return;
        c.total++;
        if (r.outcome === 'duplicate') c.dup++;
        c.tenantId ??= r.tenant_id;
        c.provider ??= r.provider;
      } else if (r.msg === 'delivery.attempt') {
        const wait = Number(b.stageMs.queue_wait ?? 0) + Number(b.stageMs.outbox_lag ?? 0);
        if (wait > this.windowMaxWaitMs) this.windowMaxWaitMs = wait;
        if (typeof r.destination_id === 'string' && (r.outcome === 'ok' || r.outcome === 'retry' || r.outcome === 'dead')) {
          const c = this.slot(this.byDestination, r.destination_id);
          if (!c) return;
          c.total++;
          c[r.outcome as 'ok' | 'retry' | 'dead']++;
          c.tenantId ??= r.tenant_id;
          if (r.outcome === 'dead') {
            const k = String(r.last_cause ?? r.cause ?? 'unknown');
            c.deadCauses.set(k, (c.deadCauses.get(k) ?? 0) + 1);
          }
        }
      } else if (r.msg === 'normalize.done') {
        const wait = Number(b.stageMs.queue_wait ?? 0) + Number(b.stageMs.outbox_lag ?? 0);
        if (wait > this.windowMaxWaitMs) this.windowMaxWaitMs = wait;
      }
    } catch {
      /* quan sát không bao giờ ném */
    }
  }

  private slot(map: Map<string, Counter>, key: string): Counter | null {
    let c = map.get(key);
    if (c) return c;
    if (map.size >= this.settings.maxKeys) {
      this.overflow++;
      return null;
    }
    c = newCounter();
    map.set(key, c);
    return c;
  }

  /** Đóng cửa sổ: trả các tín hiệu vượt ngưỡng, cập nhật đường nền, xoá bộ đếm. */
  flush(): GrowthSignal[] {
    const s = this.settings;
    const windowS = Math.round(s.windowMs / 1000);
    const out: GrowthSignal[] = [];

    for (const [sourceId, c] of this.bySource) {
      const base = this.baseline.get(`s:${sourceId}`);
      const limit = Math.max(s.minCount, s.burstFactor * (base ?? s.minCount));
      const dupRatio = c.total > 0 ? c.dup / c.total : 0;
      if (c.total >= s.minCount && c.total > limit) {
        out.push({
          cause: 'growth.burst_source', svc: 'hub-api', tenantId: c.tenantId, sourceId, provider: c.provider, windowS, count: c.total,
          baselinePerMin: base === undefined ? undefined : Math.round(base), factor: base ? Math.round((c.total / base) * 10) / 10 : undefined, duplicateRatio: Math.round(dupRatio * 100) / 100,
          hint: dupRatio >= s.dupRatio ? `wrong.duplicate chiếm ${Math.round(dupRatio * 100)}%: provider đang bắn lặp` : 'tăng lưu lượng thật của source này; xem rate limit và slow.*',
        });
      }
      if (c.total >= s.minCount && dupRatio >= s.dupRatio) {
        out.push({
          cause: 'growth.dup_flood', svc: 'hub-api', tenantId: c.tenantId, sourceId, provider: c.provider, windowS, count: c.total, duplicateRatio: Math.round(dupRatio * 100) / 100,
          hint: 'provider retry bão? kiểm độ trễ ACK của hub và ACK provider nhận được',
        });
      }
      this.baseline.set(`s:${sourceId}`, base === undefined ? c.total : base * (1 - EWMA) + c.total * EWMA);
    }

    let dead = 0;
    const deadCauses = new Map<string, number>();
    for (const [destinationId, c] of this.byDestination) {
      dead += c.dead;
      for (const [k, v] of c.deadCauses) deadCauses.set(k, (deadCauses.get(k) ?? 0) + v);
      const attempts = c.ok + c.retry + c.dead;
      if (attempts >= s.minCount && (c.retry + c.dead) / attempts >= s.retryRatio) {
        out.push({
          cause: 'growth.retry_storm', svc: 'hub-worker', tenantId: c.tenantId, destinationId, windowS, count: attempts,
          hint: `${Math.round(((c.retry + c.dead) / attempts) * 100)}% lần thử thất bại: một đích hỏng làm đầy hàng đợi retry; xem circuit`,
        });
      }
    }
    if (dead >= s.dlqMin) {
      const top = [...deadCauses.entries()].sort((a, b) => b[1] - a[1])[0];
      out.push({ cause: 'growth.dlq_swell', svc: 'hub-worker', windowS, count: dead, lastCause: top?.[0], hint: `${dead} delivery DEAD/${windowS}s; nhóm theo last_cause` });
    }

    this.backlogStreak = this.windowMaxWaitMs > this.slowWaitMs ? this.backlogStreak + 1 : 0;
    if (this.backlogStreak >= s.backlogWindows) {
      out.push({ cause: 'growth.backlog', svc: 'hub-worker', windowS, count: this.backlogStreak, hint: `chờ hàng đợi/outbox > ${this.slowWaitMs}ms liên tiếp ${this.backlogStreak} cửa sổ: thêm worker` });
    }

    // Đường nền chỉ nhớ các khoá còn xuất hiện gần đây: giữ tối đa maxKeys (Map giữ thứ tự chèn -> bỏ cũ nhất).
    while (this.baseline.size > s.maxKeys) {
      const k = this.baseline.keys().next().value;
      if (k === undefined) break;
      this.baseline.delete(k);
    }
    this.bySource = new Map();
    this.byDestination = new Map();
    this.windowMaxWaitMs = 0;
    this.overflow = 0;
    return out;
  }
}

/** Ghi tín hiệu thành dòng `growth.window` (warn, luôn ghi). */
export function emitGrowth(canonical: CanonicalLogger, g: GrowthSignal): void {
  canonical.emit({
    svc: g.svc,
    msg: 'growth.window',
    outcome: 'ok',
    traceId: newTraceId(),
    tenantId: g.tenantId,
    sourceId: g.sourceId,
    destinationId: g.destinationId,
    provider: g.provider,
    cause: g.cause,
    totalMs: 0,
    extra: {
      window_s: g.windowS,
      count: g.count,
      ...(g.baselinePerMin !== undefined ? { baseline_per_min: g.baselinePerMin } : {}),
      ...(g.factor !== undefined ? { factor: g.factor } : {}),
      ...(g.duplicateRatio !== undefined ? { duplicate_ratio: g.duplicateRatio } : {}),
      ...(g.lastCause ? { last_cause: g.lastCause } : {}),
      hint: g.hint,
    },
  });
}

/** Đồng hồ cửa sổ của tiến trình (timer `unref` — không giữ tiến trình sống). Trả hàm dừng. */
export function startGrowthTicker(gw: GrowthWindow, canonical: CanonicalLogger, onSignal?: (g: GrowthSignal) => void): () => void {
  const timer = setInterval(() => {
    try {
      for (const g of gw.flush()) {
        emitGrowth(canonical, g);
        onSignal?.(g);
      }
    } catch {
      /* tổng hợp không bao giờ làm hỏng tiến trình */
    }
  }, gw.settings.windowMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
