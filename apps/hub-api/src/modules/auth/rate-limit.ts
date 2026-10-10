import { logger } from '@hub/common';

/**
 * SPEC-auth §5.5 — rate limit đường console (KHÔNG tính vào ngân sách R1 của ingest).
 * Redis là đường tắt (BB-2): mỗi lần kiểm đúng MỘT `EVAL`. Script INCR+EXPIRE giống hệt `LUA_RATE_LIMIT`
 * của ingest (DINH-CHINH-AUTH §4 #2), chỉ trả thêm TTL để có `Retry-After`.
 * Redis lỗi → bộ đếm trong bộ nhớ của instance (lỏng hơn vì chia theo instance, nhưng KHÔNG tắt hẳn);
 * cảnh báo tối đa một lần mỗi phút.
 */
export const LUA_HIT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('TTL', KEYS[1])}`;

export const LUA_PEEK = `return {tonumber(redis.call('GET', KEYS[1]) or '0'), redis.call('TTL', KEYS[1])}`;

export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RateDecision {
  allowed: boolean;
  count: number;
  retryAfterS: number;
}

export class AuthRateLimiter {
  private readonly memory = new Map<string, { count: number; resetAt: number }>();
  private lastWarn = 0;

  constructor(
    private readonly redis: RateLimitRedis | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Đếm một lần thử; `allowed = count ≤ limit`. */
  async hit(key: string, limit: number, windowS: number): Promise<RateDecision> {
    const r = await this.viaRedis(LUA_HIT, key, windowS);
    const [count, ttl] = r ?? this.memoryHit(key, windowS);
    return { allowed: count <= limit, count, retryAfterS: Math.max(ttl, 1) };
  }

  /** Xem bộ đếm mà không tăng (khoá email sau N lần SAI): `allowed = count < limit`. */
  async peek(key: string, limit: number): Promise<RateDecision> {
    const r = await this.viaRedis(LUA_PEEK, key);
    const [count, ttl] = r ?? this.memoryPeek(key);
    return { allowed: count < limit, count, retryAfterS: Math.max(ttl, 1) };
  }

  private async viaRedis(script: string, key: string, windowS?: number): Promise<[number, number] | null> {
    if (!this.redis) return null;
    try {
      const out = (await (windowS === undefined ? this.redis.eval(script, 1, key) : this.redis.eval(script, 1, key, windowS))) as unknown[];
      return [Number(out?.[0] ?? 0), Number(out?.[1] ?? -1)];
    } catch (err) {
      const t = this.now();
      if (t - this.lastWarn > 60_000) {
        this.lastWarn = t;
        logger.warn({ err: (err as Error).message }, 'Rate limit auth: Redis lỗi -> dùng bộ đếm trong bộ nhớ (BB-2)');
      }
      return null;
    }
  }

  private memoryHit(key: string, windowS: number): [number, number] {
    const t = this.now();
    const cur = this.memory.get(key);
    const entry = cur && cur.resetAt > t ? { count: cur.count + 1, resetAt: cur.resetAt } : { count: 1, resetAt: t + windowS * 1000 };
    this.memory.set(key, entry);
    if (this.memory.size > 10_000) this.sweep(t);
    return [entry.count, Math.ceil((entry.resetAt - t) / 1000)];
  }

  private memoryPeek(key: string): [number, number] {
    const t = this.now();
    const cur = this.memory.get(key);
    return cur && cur.resetAt > t ? [cur.count, Math.ceil((cur.resetAt - t) / 1000)] : [0, -2];
  }

  private sweep(t: number) {
    for (const [k, v] of this.memory) if (v.resetAt <= t) this.memory.delete(k);
  }
}
