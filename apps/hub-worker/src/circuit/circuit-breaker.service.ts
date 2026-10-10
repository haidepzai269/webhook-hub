import { circuitTransitions } from '../metrics';
import { Inject, Injectable, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { CircuitState, logger } from '@hub/common';
import { PrismaService } from '@hub/database';

/** Token DI tuỳ chọn để test tiêm Redis giả; production tự tạo client riêng. */
export const CIRCUIT_REDIS = Symbol('CIRCUIT_REDIS');

/** Kênh pub/sub duy nhất cho thay đổi circuit (thay `hub:alerts`, luôn kèm tenantId — ADR-035). */
export const CIRCUIT_CHANNEL = 'hub:realtime:circuit';

export const CIRCUIT_FAILURE_THRESHOLD = 5;
/** Còn khoá `:open` = OPEN. Hết hạn mà `:failures` còn >= ngưỡng = HALF_OPEN (suy ra, không lưu). */
export const CIRCUIT_OPEN_SECONDS = 60;
export const CIRCUIT_OPEN_MS = CIRCUIT_OPEN_SECONDS * 1000;
/** Lỗi cách nhau hơn 2 phút không còn là "liên tiếp". */
const FAILURES_WINDOW_SECONDS = 120;
/** Lúc OPEN, gia hạn `:failures` qua hết OPEN + một khoảng HALF_OPEN — nếu không, bộ đếm có thể hết hạn trước `:open` và circuit nhảy thẳng về CLOSED mà không probe. */
const FAILURES_AFTER_OPEN_SECONDS = CIRCUIT_OPEN_SECONDS + FAILURES_WINDOW_SECONDS;
const PROBE_SECONDS = 30;

/**
 * Review SPEC-2 #6 (ADR-054): các bước "đọc rồi ghi" gộp thành MỘT script Lua — nguyên tử phía Redis,
 * và mỗi script tính là một lệnh trong ngân sách ≤ 4 lệnh Redis/sự kiện.
 */
/** INCR + EXPIRE ở lần đầu. KEYS[1]=bộ đếm; ARGV[1]=TTL giây. Trả giá trị sau INCR. */
export const LUA_INCR_EXPIRE = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;
/**
 * Review SPEC-3 #2 (ADR-064): đọc circuit + throttle trong MỘT lệnh. KEYS: open, failures, throttle;
 * ARGV: ngưỡng lỗi, TTL cửa sổ throttle (giây). Chỉ tăng bộ đếm throttle khi CLOSED (OPEN/HALF_OPEN thì
 * message không gửi theo đường thường nên không tiêu RPS). Trả {open|'', failures|'', count|-1}.
 */
export const LUA_STATE_AND_THROTTLE = `local open = redis.call('GET', KEYS[1])
local failures = redis.call('GET', KEYS[2])
local t = -1
if (not open) and (tonumber(failures or '0') < tonumber(ARGV[1])) then
  t = redis.call('INCR', KEYS[3])
  if t == 1 then redis.call('EXPIRE', KEYS[3], ARGV[2]) end
end
return {open or '', failures or '', t}`;

/**
 * Giành probe HALF_OPEN: chỉ SET NX khi `:open` KHÔNG tồn tại và `:failures` ≥ ngưỡng (đúng là HALF_OPEN
 * ngay lúc này, không dựa vào MGET đọc trước có thể đã cũ). KEYS: open, failures, probe;
 * ARGV: token, TTL giây, ngưỡng. Trả 1 = giành được.
 */
export const LUA_ACQUIRE_PROBE = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local f = tonumber(redis.call('GET', KEYS[2]) or '0') or 0
if f < tonumber(ARGV[3]) then return 0 end
if redis.call('SET', KEYS[3], ARGV[1], 'NX', 'EX', tonumber(ARGV[2])) then return 1 end
return 0`;
/** Nhả probe CHỈ khi giá trị = token của chính mình (không xoá probe của worker khác sau khi mình hết hạn). */
export const LUA_RELEASE_PROBE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
/** Redis lỗi -> fail-open: coi như giành được probe; token này không bao giờ được gửi tới Redis để nhả. */
export const FAIL_OPEN_PROBE = 'fail-open';

export interface CircuitView {
  state: CircuitState;
  failures: number;
  /**
   * Review SPEC-3 #2: chỉ có khi `getState` được gọi với `rateLimitRps > 0` VÀ circuit CLOSED —
   * script đã tăng bộ đếm throttle trong CÙNG lệnh. `false` = vượt RPS, hoãn. Không có = không áp throttle.
   */
  throttleAllowed?: boolean;
  /** Redis lỗi: trạng thái là fail-open (CLOSED) chứ không phải quan sát thật -> không đồng bộ DB. */
  degraded?: boolean;
}

/** Đích đang xử lý + trạng thái đang ghi trong DB (đọc kèm delivery, không tốn truy vấn riêng). */
export interface CircuitTarget {
  destinationId: string;
  tenantId: string;
  persistedState: CircuitState;
}

/**
 * Circuit breaker 3 trạng thái (S2-1, ADR-048). Redis là nguồn CHẠY; `destinations.circuit_state`
 * chỉ để hiển thị và chỉ được ghi khi trạng thái ĐỔI. Redis chết -> fail-open (ARCHITECTURE §5.4).
 *
 * Khoá `circuit:{destId}`:
 *  - `:failures` INCR, EX 120 đặt ở lần lỗi đầu (Lua, một lệnh);
 *  - `:open`     SET OPEN EX 60;
 *  - `:probe`    SET token NX EX 30 (Lua: chỉ khi thật sự HALF_OPEN) — người gửi thử DUY NHẤT; nhả theo token.
 */
@Injectable()
export class CircuitBreakerService {
  private redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(CIRCUIT_REDIS) redisClient?: Redis,
  ) {
    if (redisClient) {
      this.redis = redisClient;
    } else {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      // Không để ioredis văng 'Unhandled error event' khi Redis chết (S1-4); circuit fail-open như cũ.
      this.redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis (circuit breaker) lỗi'));
      this.redis.connect().catch(() => {});
    }
  }

  private keys(destinationId: string) {
    const base = `circuit:${destinationId}`;
    return { failures: `${base}:failures`, open: `${base}:open`, probe: `${base}:probe` };
  }

  /**
   * MỘT lệnh: MGET khi đích không throttle; khi `rateLimitRps > 0` thì một EVAL gộp đọc circuit + tăng
   * bộ đếm throttle (review SPEC-3 #2) — đường delivery luôn ≤ 2 lệnh (lệnh này + PUBLISH).
   */
  async getState(destinationId: string, rateLimitRps = 0): Promise<CircuitView> {
    const k = this.keys(destinationId);
    try {
      if (rateLimitRps > 0) {
        const throttleKey = `throttle:destination:${destinationId}:${Math.floor(Date.now() / 1000)}`;
        const [openRaw, failuresRaw, count] = (await this.redis.eval(
          LUA_STATE_AND_THROTTLE, 3, k.open, k.failures, throttleKey, CIRCUIT_FAILURE_THRESHOLD, 2,
        )) as [string, string, number];
        const failures = parseInt(failuresRaw || '0', 10) || 0;
        if (openRaw) return { state: 'OPEN', failures };
        if (failures >= CIRCUIT_FAILURE_THRESHOLD) return { state: 'HALF_OPEN', failures };
        return { state: 'CLOSED', failures, throttleAllowed: Number(count) <= rateLimitRps };
      }
      const [open, failuresRaw] = await this.redis.mget(k.open, k.failures);
      const failures = parseInt(failuresRaw ?? '0', 10) || 0;
      if (open) return { state: 'OPEN', failures };
      if (failures >= CIRCUIT_FAILURE_THRESHOLD) return { state: 'HALF_OPEN', failures };
      return { state: 'CLOSED', failures };
    } catch {
      return { state: 'CLOSED', failures: 0, degraded: true };
    }
  }

  /**
   * HALF_OPEN: giành probe bằng MỘT script Lua (ADR-054). Trả token ngẫu nhiên của lần giành (dùng để
   * nhả đúng chủ), hoặc null nếu không giành được. Redis lỗi -> FAIL_OPEN_PROBE (cho gửi, fail-open).
   */
  async tryAcquireProbe(destinationId: string): Promise<string | null> {
    const k = this.keys(destinationId);
    const token = `${process.pid}:${randomUUID()}`;
    try {
      const res = await this.redis.eval(LUA_ACQUIRE_PROBE, 3, k.open, k.failures, k.probe, token, PROBE_SECONDS, CIRCUIT_FAILURE_THRESHOLD);
      return Number(res) === 1 ? token : null;
    } catch {
      return FAIL_OPEN_PROBE;
    }
  }

  /** Giành probe rồi mà không gửi (lease thua, đã xử lý, 4xx) -> nhả để worker khác thử ngay, CHỈ nếu mình còn là chủ. */
  async releaseProbe(destinationId: string, token: string | null): Promise<void> {
    if (!token || token === FAIL_OPEN_PROBE) return;
    try {
      await this.redis.eval(LUA_RELEASE_PROBE, 1, this.keys(destinationId).probe, token);
    } catch {}
  }

  /**
   * Gửi thành công. `failures == 0` và đang CLOSED -> KHÔNG gọi Redis (ngân sách S3-5).
   * Ngược lại một lệnh DEL ba khoá rồi về CLOSED.
   */
  async recordSuccess(target: CircuitTarget, view: CircuitView): Promise<CircuitState> {
    if (view.failures === 0 && view.state === 'CLOSED') {
      if (target.persistedState !== 'CLOSED' && !view.degraded) await this.transition(target, 'CLOSED', 0);
      return 'CLOSED';
    }
    const k = this.keys(target.destinationId);
    try {
      await this.redis.del(k.failures, k.open, k.probe);
    } catch {}
    // `persistedState` đọc kèm delivery có thể đã cũ (worker khác vừa ghi OPEN): KHÔNG dựa vào nó để bỏ
    // qua — UPDATE có điều kiện `circuit_state <> 'CLOSED'` quyết định (review SPEC-2 #6c).
    await this.transition(target, 'CLOSED', 0, true);
    return 'CLOSED';
  }

  /**
   * Gửi thất bại (CHỈ lỗi phía đích: 5xx/408/429/mạng — consumer lọc, ADR-054): INCR+EXPIRE trong MỘT
   * script Lua. Đạt ngưỡng, hoặc probe HALF_OPEN thất bại -> OPEN.
   */
  async recordFailure(target: CircuitTarget, view: CircuitView): Promise<CircuitView> {
    const k = this.keys(target.destinationId);
    let failures: number;
    try {
      failures = Number(await this.redis.eval(LUA_INCR_EXPIRE, 1, k.failures, FAILURES_WINDOW_SECONDS));
    } catch {
      return { state: 'CLOSED', failures: 0, degraded: true };
    }

    if (failures >= CIRCUIT_FAILURE_THRESHOLD || view.state === 'HALF_OPEN') {
      try {
        await this.redis
          .multi()
          .set(k.open, 'OPEN', 'EX', CIRCUIT_OPEN_SECONDS)
          .expire(k.failures, FAILURES_AFTER_OPEN_SECONDS)
          .del(k.probe)
          .exec();
      } catch {
        return { state: 'CLOSED', failures, degraded: true };
      }
      if (target.persistedState !== 'OPEN') {
        logger.warn({ destinationId: target.destinationId, failures }, 'Circuit breaker -> OPEN (hoãn gửi 60s)');
      }
      await this.transition(target, 'OPEN', failures);
      return { state: 'OPEN', failures };
    }
    return { state: view.state === 'OPEN' ? 'OPEN' : 'CLOSED', failures };
  }

  /**
   * Đồng bộ trạng thái QUAN SÁT được (vd. `:open` hết hạn -> HALF_OPEN, hoặc mọi khoá hết hạn ->
   * CLOSED) vào DB khi khác bản đang lưu. Không làm gì nếu Redis đang lỗi.
   */
  async syncObserved(target: CircuitTarget, view: CircuitView): Promise<void> {
    if (view.degraded || view.state === target.persistedState) return;
    await this.transition(target, view.state, view.failures);
  }

  /**
   * Chỉ khi trạng thái ĐỔI: (a) ghi `destinations.circuit_state` bằng UPDATE có điều kiện
   * (`circuit_state <> to`) — nhiều worker cùng thấy một lần đổi thì chỉ một bên đổi được dòng;
   * (b) chỉ bên đó PUBLISH `hub:realtime:circuit`. Lỗi ở đây không được chặn việc gửi.
   */
  private async transition(target: CircuitTarget, to: CircuitState, failures: number, force = false): Promise<void> {
    const from = target.persistedState;
    if (from === to && !force) return;
    target.persistedState = to;
    try {
      const changed = await this.prisma
        .forTenant(target.tenantId)
        .updateDestinationCircuitState(target.destinationId, to);
      if (changed !== 1) return;
      circuitTransitions.inc({ to });
      const msg = { tenantId: target.tenantId, destinationId: target.destinationId, from, to, failures, at: new Date().toISOString() };
      await this.redis.publish(CIRCUIT_CHANNEL, JSON.stringify(msg)).catch(() => {});
      logger.info(msg, 'Circuit đổi trạng thái');
    } catch (err: any) {
      logger.warn({ err: err?.message, destinationId: target.destinationId, to }, 'Không ghi được circuit_state (chỉ ảnh hưởng hiển thị)');
    }
  }

  /**
   * Outbound throttle per destination (§5.4b): cửa sổ CỐ ĐỊNH 1 giây (fixed window), một EVAL;
   * lệch tối đa 2× RPS ở mép cửa sổ — chấp nhận được để bảo vệ đích (ARCHITECTURE §5.4b).
   */
  async checkThrottle(destinationId: string, rateLimitRps: number): Promise<boolean> {
    if (!rateLimitRps || rateLimitRps <= 0) return true;
    try {
      const key = `throttle:destination:${destinationId}:${Math.floor(Date.now() / 1000)}`;
      const count = Number(await this.redis.eval(LUA_INCR_EXPIRE, 1, key, 2));
      return count <= rateLimitRps;
    } catch {
      return true; // fail-open
    }
  }
}
