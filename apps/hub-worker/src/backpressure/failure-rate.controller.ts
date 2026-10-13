import { backpressureFactor } from '../metrics';
import { BACKPRESSURE_HOLD_MAX_MS, backpressureHoldMaxMs } from '@hub/messaging';

/**
 * BP5 (SPEC-ap-luc-nguoc §7, ADR-200): áp lực ngược kiểu Canva cho HẠ TẦNG CỦA CHÍNH HUB (hiện chỉ `db` = Postgres).
 *
 * - Cục bộ trong tiến trình: không Redis, không gọi mạng, đếm trong bộ nhớ (Redis có quota và có thể chết — một bộ điều khiển
 *   phụ thuộc Redis để bảo vệ khỏi lỗi hạ tầng thì lại thêm một hạ tầng có thể lỗi).
 * - Tín hiệu CHỈ là lỗi hạ tầng của hub (`classifyInfraError === 'transient'`). Lỗi của ĐÍCH không bao giờ là tín hiệu (§0:
 *   một đích chết của `cafe` không được làm chậm `bookstore`).
 * - Cửa sổ trượt 30s (bucket 1s); mỗi 1s: tỷ lệ lỗi > set point (5%, ≥ 10 mẫu) -> factor +0.25 (lùi nhanh), ngược lại −0.1
 *   (hồi chậm) — AIMD đảo chiều.
 * - MỘT factor (một tín hiệu) cho phụ thuộc, nhưng MỖI consumer (lane: normalize, delivery) một semaphore riêng, MAX = prefetch
 *   của consumer đó (20) — review BP5 TB-1: một semaphore chung thì delivery treo HTTP ở một đích chậm chiếm hết permit và
 *   normalize của MỌI tenant xếp hàng sau (lỗi của đích làm chậm tenant khác, trái §0). Lúc khoẻ thông lượng như trước BP5.
 * - permits (mỗi lane) = max(1, ceil(MAX × (1 − factor))); factor = 1 -> CHẾ ĐỘ DÒ: 1 permit, các lần bắt đầu xử lý của lane
 *   cách nhau ≥ `probeIntervalMs` (giống HALF_OPEN của circuit — câu trả lời cho phần Canva để dành Part 2).
 * - Không đổi `prefetch` lúc chạy (hành vi `basic.qos` với consumer đang mở không chắc chắn): message vượt permit chờ trong
 *   tiến trình (unacked) tối đa `holdMaxMs`, quá thì người gọi republish không đốt lượt (`timeout`).
 * - Tắt máy (C5): `shutdown()` trả ngay `shutdown` cho mọi message đang chờ — người gọi KHÔNG xử lý, KHÔNG republish,
 *   KHÔNG ack; channel đóng thì RabbitMQ giao lại.
 */
export type BackpressureOutcome = 'ok' | 'infra_fail';
export type Release = () => void;
export type AcquireResult = { kind: 'permit'; release: Release } | { kind: 'timeout' } | { kind: 'shutdown' };

export interface BackpressureController {
  record(outcome: BackpressureOutcome): void;
  factor(): number;
  acquire(lane?: string): Promise<AcquireResult>;
}

export interface FailureRateOptions {
  dependency: string;
  maxPermits?: number;
  setPoint?: number;
  probeIntervalMs?: number;
  holdMaxMs?: number;
  windowSeconds?: number;
  minSamples?: number;
  now?: () => number;
}

export const BACKPRESSURE_DEFAULTS = {
  maxPermits: 20,
  setPoint: 0.05,
  probeIntervalMs: 5_000,
  holdMaxMs: BACKPRESSURE_HOLD_MAX_MS,
  windowSeconds: 30,
  minSamples: 10,
} as const;

/** Biến môi trường §10 (bậy -> mặc định). */
export function backpressureOptionsFromEnv(env: Record<string, string | undefined> = process.env): Omit<FailureRateOptions, 'dependency'> {
  const num = (v: string | undefined, ok: (n: number) => boolean, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && ok(n) ? n : d;
  };
  return {
    setPoint: num(env.BACKPRESSURE_SET_POINT, (n) => n > 0 && n < 1, BACKPRESSURE_DEFAULTS.setPoint),
    probeIntervalMs: num(env.BACKPRESSURE_PROBE_INTERVAL_MS, (n) => n >= 100, BACKPRESSURE_DEFAULTS.probeIntervalMs),
    // nguồn + kẹp ở @hub/messaging (cửa sổ retry cộng theo mặc định -> chỉ được THẤP hơn)
    holdMaxMs: backpressureHoldMaxMs(env.BACKPRESSURE_HOLD_MAX_MS),
  };
}

interface Waiter {
  resolve: (r: AcquireResult) => void;
  timer: NodeJS.Timeout;
}

/** Semaphore của một consumer (lane). */
interface Lane {
  inUse: number;
  lastStartAt: number;
  waiters: Waiter[];
  probeTimer: NodeJS.Timeout | null;
}

export class FailureRateController implements BackpressureController {
  readonly dependency: string;
  private readonly maxPermits: number;
  private readonly setPoint: number;
  private readonly probeIntervalMs: number;
  readonly holdMaxMs: number;
  private readonly windowSeconds: number;
  private readonly minSamples: number;
  private readonly now: () => number;

  /** bucket theo giây: [giây epoch, ok, fail] */
  private buckets: { sec: number; ok: number; fail: number }[] = [];
  private f = 0;
  private readonly lanes = new Map<string, Lane>();
  private shuttingDown = false;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(o: FailureRateOptions) {
    this.dependency = o.dependency;
    this.maxPermits = o.maxPermits ?? BACKPRESSURE_DEFAULTS.maxPermits;
    this.setPoint = o.setPoint ?? BACKPRESSURE_DEFAULTS.setPoint;
    this.probeIntervalMs = o.probeIntervalMs ?? BACKPRESSURE_DEFAULTS.probeIntervalMs;
    this.holdMaxMs = o.holdMaxMs ?? BACKPRESSURE_DEFAULTS.holdMaxMs;
    this.windowSeconds = o.windowSeconds ?? BACKPRESSURE_DEFAULTS.windowSeconds;
    this.minSamples = o.minSamples ?? BACKPRESSURE_DEFAULTS.minSamples;
    this.now = o.now ?? Date.now;
    backpressureFactor.set({ dependency: this.dependency }, 0);
  }

  /** Bật nhịp 1s (tiến trình thật). Test gọi `tick()` tay. */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 1_000);
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const l of this.lanes.values()) {
      if (l.probeTimer) clearTimeout(l.probeTimer);
      l.probeTimer = null;
    }
  }

  record(outcome: BackpressureOutcome): void {
    const sec = Math.floor(this.now() / 1000);
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.sec !== sec) {
      b = { sec, ok: 0, fail: 0 };
      this.buckets.push(b);
    }
    if (outcome === 'ok') b.ok++;
    else b.fail++;
  }

  factor(): number {
    return this.f;
  }

  /** Tỷ lệ lỗi trong cửa sổ; null khi < minSamples. */
  failureRate(): number | null {
    this.prune();
    let ok = 0;
    let fail = 0;
    for (const b of this.buckets) {
      ok += b.ok;
      fail += b.fail;
    }
    const total = ok + fail;
    return total >= this.minSamples ? fail / total : null;
  }

  /**
   * Mỗi 1s: lùi nhanh +0.25 khi tỷ lệ lỗi > set point, ngược lại hồi chậm −0.1.
   * Cửa sổ chưa đủ `minSamples` mẫu: còn lỗi hạ tầng nào trong cửa sổ thì GIỮ factor (chế độ dò chỉ có ~6 mẫu / 30s — nếu coi
   * "thiếu mẫu" là "khoẻ" thì factor tự tụt khỏi chế độ dò khi DB vẫn chết, dội cả hàng đang giữ); không có lỗi nào (rảnh hoặc
   * probe thành công) thì hồi như thường.
   */
  tick(): void {
    const rate = this.failureRate();
    if (rate !== null && rate > this.setPoint) this.f = Math.min(1, round2(this.f + 0.25));
    else if (rate === null && this.failuresInWindow() > 0) {
      /* giữ nguyên */
    } else this.f = Math.max(0, round2(this.f - 0.1));
    backpressureFactor.set({ dependency: this.dependency }, this.f);
    for (const l of this.lanes.values()) this.pump(l);
  }

  private failuresInWindow(): number {
    let n = 0;
    for (const b of this.buckets) n += b.fail;
    return n;
  }

  permits(): number {
    if (this.f >= 1) return 1;
    return Math.max(1, Math.ceil(this.maxPermits * (1 - this.f)));
  }

  /** Số message đang chờ permit (mọi lane, hoặc một lane). */
  waiting(lane?: string): number {
    if (lane !== undefined) return this.lanes.get(lane)?.waiters.length ?? 0;
    let n = 0;
    for (const l of this.lanes.values()) n += l.waiters.length;
    return n;
  }

  active(lane?: string): number {
    if (lane !== undefined) return this.lanes.get(lane)?.inUse ?? 0;
    let n = 0;
    for (const l of this.lanes.values()) n += l.inUse;
    return n;
  }

  acquire(lane = 'default'): Promise<AcquireResult> {
    if (this.shuttingDown) return Promise.resolve({ kind: 'shutdown' });
    const l = this.lane(lane);
    if (l.waiters.length === 0 && this.canStart(l)) return Promise.resolve(this.grant(l));
    return new Promise<AcquireResult>((resolve) => {
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = l.waiters.indexOf(w);
          if (i >= 0) l.waiters.splice(i, 1);
          resolve({ kind: 'timeout' });
        }, this.holdMaxMs),
      };
      w.timer.unref?.();
      l.waiters.push(w);
      this.pump(l);
    });
  }

  /** C5: mọi message đang chờ permit nhận `shutdown` NGAY — không xử lý, không republish, không ack. */
  shutdown(): void {
    this.shuttingDown = true;
    this.stop();
    for (const l of this.lanes.values()) {
      for (const w of l.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve({ kind: 'shutdown' });
      }
    }
  }

  private lane(name: string): Lane {
    let l = this.lanes.get(name);
    if (!l) {
      l = { inUse: 0, lastStartAt: -Infinity, waiters: [], probeTimer: null };
      this.lanes.set(name, l);
    }
    return l;
  }

  private canStart(l: Lane): boolean {
    if (l.inUse >= this.permits()) return false;
    if (this.f >= 1 && this.now() - l.lastStartAt < this.probeIntervalMs) return false;
    return true;
  }

  private grant(l: Lane): AcquireResult {
    l.inUse++;
    l.lastStartAt = this.now();
    let released = false;
    return {
      kind: 'permit',
      release: () => {
        if (released) return;
        released = true;
        l.inUse--;
        this.pump(l);
      },
    };
  }

  private pump(l: Lane): void {
    while (l.waiters.length > 0 && this.canStart(l)) {
      const w = l.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(this.grant(l));
    }
    // Chế độ dò: còn người chờ nhưng chưa tới nhịp -> hẹn đúng lúc được bắt đầu tiếp.
    if (l.waiters.length > 0 && this.f >= 1 && l.inUse < 1 && !l.probeTimer) {
      const wait = Math.max(0, this.probeIntervalMs - (this.now() - l.lastStartAt));
      l.probeTimer = setTimeout(() => {
        l.probeTimer = null;
        this.pump(l);
      }, wait);
      l.probeTimer.unref?.();
    }
  }

  private prune(): void {
    const minSec = Math.floor(this.now() / 1000) - this.windowSeconds + 1;
    while (this.buckets.length > 0 && this.buckets[0].sec < minSec) this.buckets.shift();
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Token DI: bộ điều khiển áp lực ngược của phụ thuộc `db` — MỘT cho mỗi tiến trình, dùng chung normalize + delivery (§7.1). */
export const BACKPRESSURE_DB = Symbol('BACKPRESSURE_DB');
