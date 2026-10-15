import { circuitTransitions } from '../metrics';
import { Inject, Injectable, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { CircuitState, fastFailRedisOptions, logger } from '@hub/common';
import { PrismaService } from '@hub/database';
import {
  CIRCUIT_OPEN_MS as OPEN_FIRST_MS,
  DELIVERY_RAMP_MAX_DOUBLINGS,
  circuitOpenMaxSeconds,
  deliveryRampConfig,
  deliveryRampKeySeconds,
  deliveryRampLastStep,
} from '@hub/messaging';

/** Token DI tuỳ chọn để test tiêm Redis giả; production tự tạo client riêng. */
export const CIRCUIT_REDIS = Symbol('CIRCUIT_REDIS');

/** Kênh pub/sub duy nhất cho thay đổi circuit (thay `hub:alerts`, luôn kèm tenantId — ADR-035). */
export const CIRCUIT_CHANNEL = 'hub:realtime:circuit';

export const CIRCUIT_FAILURE_THRESHOLD = 5;
/**
 * Còn khoá `:open` = OPEN. Hết hạn mà `:failures` còn >= ngưỡng = HALF_OPEN (suy ra, không lưu).
 * BP3 (ADR-197): OPEN lần đầu 60s; từ lần PROBE thất bại thứ nhất là `CIRCUIT_OPEN_MAX_SECONDS` (60..300, mặc định 300).
 * Nguồn hằng số: `@hub/messaging` retry-window.ts (cùng nguồn với cửa sổ retry).
 */
export const CIRCUIT_OPEN_MS = OPEN_FIRST_MS;
export const CIRCUIT_OPEN_SECONDS = CIRCUIT_OPEN_MS / 1000;
/** Lỗi cách nhau hơn 2 phút không còn là "liên tiếp". */
const FAILURES_WINDOW_SECONDS = 120;
/**
 * Lúc OPEN, gia hạn `:failures` (và `:trips`) qua hết OPEN + một khoảng HALF_OPEN — nếu không, bộ đếm có thể hết hạn trước `:open`
 * và circuit nhảy thẳng về CLOSED mà không probe. BP3: áp cho cả OPEN 300s (`openSeconds + 120`).
 */
const failuresAfterOpenSeconds = (openSeconds: number) => openSeconds + FAILURES_WINDOW_SECONDS;
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
 * BP2 §6 (ADR-196) + BP4 (ADR-198): GATE — MỘT script, LUÔN đúng 1 lệnh, có hay không có throttle/ramp.
 * KEYS: open, failures, throttle:{giây}, ramp, probe. ARGV: ngưỡng lỗi, rate_limit_rps, nowMs, ramp start rps, ramp step (giây),
 * TTL cửa sổ throttle (giây), bậc cuối (`deliveryRampLastStep`, F3 + Thấp-9), trần tuyệt đối ramp (ms, ADR-234).
 * - Trả PTTL của `:open` (BP3 hoãn tới hết OPEN, C4).
 * - CLOSED + còn `:ramp` (BP4, đặt lúc probe thành công): rampCap = start × 2^min(floor((now − rampStart)/step), bậc cuối) —
 *   khoá sống ramp + một bậc (F3), bậc thêm đó giữ trần cuối. Bậc cuối kẹp ≤ DELIVERY_RAMP_MAX_DOUBLINGS (Thấp-9).
 * - ADR-234 (đính chính ADR-232): CHỈ KHI ở bậc cuối VÀ lần này bị throttle (count > rampCap — hàng tồn còn dội) -> `PEXPIRE :ramp`
 *   = min(2 × step, rampStart + RAMP_MAX − now), chỉ khi dài hơn PTTL hiện tại. Trong CÙNG EVAL: không thêm lệnh client. Quá RAMP_MAX (tính từ mốc trong khoá)
 *   -> coi như hết ramp dù khoá còn (lệch đồng hồ) — ramp không bao giờ sống quá RAMP_MAX.
 * - INCR bộ đếm throttle chỉ khi CLOSED VÀ có trần (rps > 0 hoặc còn `:ramp`) — không trần thì 0 lệnh throttle như cũ.
 * Cap thật = min(rps nếu > 0, rampCap) tính ở JS từ hai giá trị trả về (để kiểm lại với rps thật mà không INCR lần hai, C9).
 * - HALF_OPEN (hết `:open`, `:failures` ≥ ngưỡng): trả thêm cờ `:probe` ĐANG bị giữ (ADR-233) — bên thua bỏ qua
 *   `tryAcquireProbe`, hoãn với đúng 1 lệnh. Probe trống thì vẫn giành bằng `LUA_ACQUIRE_PROBE` riêng (nguyên tử, ADR-198/C11:
 *   không gộp giành probe vào gate).
 * Trả {open 1|0, failures|'', openPttl|-2, count|-1, rampCap|-1, probeHeld 1|0}.
 */
export const LUA_GATE = `local open = redis.call('GET', KEYS[1])
local pttl = -2
if open then pttl = redis.call('PTTL', KEYS[1]) end
local failures = redis.call('GET', KEYS[2])
local t = -1
local cap = -1
local atLast = false
local el = 0
if (not open) and (tonumber(failures or '0') < tonumber(ARGV[1])) then
  local rs = redis.call('GET', KEYS[4])
  if rs then
    el = tonumber(ARGV[3]) - (tonumber(rs) or 0)
    if el < 0 then el = 0 end
    -- ADR-234: quá trần tuyệt đối (ARGV[8] ms tính từ rampStart) -> hết ramp, dù khoá còn sống
    if el < tonumber(ARGV[8]) then
      local steps = math.floor(el / (tonumber(ARGV[5]) * 1000))
      -- F3 (ADR-232) + Thấp-9 (ADR-234): kẹp ở bậc CUỐI (ARGV[7], JS đã kẹp ≤ ${DELIVERY_RAMP_MAX_DOUBLINGS}); kẹp lại ở đây phòng ARGV lạ
      local last = tonumber(ARGV[7])
      if last > ${DELIVERY_RAMP_MAX_DOUBLINGS} then last = ${DELIVERY_RAMP_MAX_DOUBLINGS} end
      if last < 0 then last = 0 end
      if steps >= last then steps = last; atLast = true end
      cap = tonumber(ARGV[4]) * (2 ^ steps)
    end
  end
  if (tonumber(ARGV[2]) > 0) or (cap > 0) then
    t = redis.call('INCR', KEYS[3])
    if t == 1 then redis.call('EXPIRE', KEYS[3], ARGV[6]) end
    -- ADR-234: bậc cuối mà vẫn bị ramp chặn -> gia hạn :ramp 2 × step, không quá rampStart + RAMP_MAX; chỉ KÉO DÀI, không
    -- rút ngắn (bước nhỏ + kẹp Thấp-9 thì bậc cuối tới sớm, 2 × step có thể ngắn hơn TTL gốc)
    if atLast and t > cap then
      local ext = 2 * tonumber(ARGV[5]) * 1000
      local left = tonumber(ARGV[8]) - el
      if left < ext then ext = left end
      if ext > redis.call('PTTL', KEYS[4]) then redis.call('PEXPIRE', KEYS[4], math.floor(ext)) end
    end
  end
end
local held = 0
if (not open) and (tonumber(failures or '0') >= tonumber(ARGV[1])) and redis.call('EXISTS', KEYS[5]) == 1 then held = 1 end
local o = 0
if open then o = 1 end
return {o, failures or '', pttl, t, cap, held}`;

/**
 * BP4 (ADR-198): probe thành công -> CLOSED trong MỘT lệnh: DEL failures, open, probe, trips + SET `:ramp` = nowMs EX
 * (ramp giây + một bậc — F3, ADR-232: bậc thêm giữ trần cuối). KEYS: failures, open, probe, trips, ramp. ARGV: nowMs, TTL giây.
 */
export const LUA_CLOSE_AND_RAMP = `redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
redis.call('SET', KEYS[5], ARGV[1], 'EX', tonumber(ARGV[2]))
return 1`;

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
  /** BP2 §6: PTTL (ms) của `:open` khi OPEN — BP3 dùng để hoãn tới hết OPEN (C4). */
  openPttlMs?: number;
  /** BP2: giá trị bộ đếm throttle sau INCR của gate (chỉ có khi đã INCR) — để kiểm lại với rps thật mà KHÔNG đếm lần hai. */
  throttleCount?: number;
  /** BP4: trần slow-start hiện tại (rps) khi đích đang ramp sau khi hồi phục. */
  rampCap?: number;
  /** ADR-233: HALF_OPEN mà `:probe` đang bị giữ (worker khác đang dò) -> KHÔNG gọi `tryAcquireProbe` (1 lệnh thay vì 2). */
  probeHeld?: boolean;
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
 *  - `:failures` INCR, EX 120 đặt ở lần lỗi đầu (Lua, một lệnh); lúc OPEN gia hạn tới hết OPEN + 120s;
 *  - `:open`     SET OPEN EX 60 ở lần trip đầu, EX `CIRCUIT_OPEN_MAX_SECONDS` (300) sau mỗi probe thất bại (BP3);
 *  - `:trips`    số probe thất bại liên tiếp (BP3), xoá khi CLOSED;
 *  - `:probe`    SET token NX EX 30 (Lua: chỉ khi thật sự HALF_OPEN) — người gửi thử DUY NHẤT; nhả theo token;
 *  - `:ramp`     mốc probe thành công, EX ramp + một bậc (BP4 + F3); gate gia hạn ở bậc cuối khi còn throttle, ≤ RAMP_MAX (ADR-234).
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
      this.redis = new Redis(redisUrl, fastFailRedisOptions()); // MS-P2-3
      // Không để ioredis văng 'Unhandled error event' khi Redis chết (S1-4); circuit fail-open như cũ.
      this.redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis (circuit breaker) lỗi'));
      this.redis.connect().catch(() => {});
    }
  }

  private keys(destinationId: string) {
    const base = `circuit:${destinationId}`;
    return { failures: `${base}:failures`, open: `${base}:open`, probe: `${base}:probe`, trips: `${base}:trips`, ramp: `${base}:ramp` };
  }

  /**
   * GATE (BP2 §6, ADR-196): LUÔN đúng MỘT lệnh (EVAL `LUA_GATE`), có hay không có throttle — đường delivery ≤ 2 lệnh
   * (lệnh này + PUBLISH). Gọi được TRƯỚC khi nạp row khi message mang gợi ý `destinationId` + `rateLimitRps`.
   * Redis lỗi -> fail-open (CLOSED, degraded), như cũ.
   */
  async getState(destinationId: string, rateLimitRps = 0): Promise<CircuitView> {
    const k = this.keys(destinationId);
    const rps = rateLimitRps > 0 ? rateLimitRps : 0;
    const ramp = deliveryRampConfig();
    try {
      const now = Date.now();
      const throttleKey = `throttle:destination:${destinationId}:${Math.floor(now / 1000)}`;
      const [openFlag, failuresRaw, pttl, count, capRaw, probeHeld] = (await this.redis.eval(
        LUA_GATE, 5, k.open, k.failures, throttleKey, k.ramp, k.probe,
        CIRCUIT_FAILURE_THRESHOLD, rps, now, ramp.startRps, ramp.stepSeconds, 2, deliveryRampLastStep(ramp), ramp.maxSeconds * 1000,
      )) as [number, string, number, number, number, number];
      const failures = parseInt(failuresRaw || '0', 10) || 0;
      if (Number(openFlag) === 1) {
        const view: CircuitView = { state: 'OPEN', failures };
        if (Number(pttl) > 0) view.openPttlMs = Number(pttl);
        return view;
      }
      if (failures >= CIRCUIT_FAILURE_THRESHOLD) return Number(probeHeld) === 1 ? { state: 'HALF_OPEN', failures, probeHeld: true } : { state: 'HALF_OPEN', failures };
      const rampCap = Number(capRaw) > 0 ? Number(capRaw) : undefined;
      const cap = Math.min(rps > 0 ? rps : Infinity, rampCap ?? Infinity);
      if (Number.isFinite(cap) && Number(count) >= 0) {
        const view: CircuitView = { state: 'CLOSED', failures, throttleAllowed: Number(count) <= cap, throttleCount: Number(count) };
        if (rampCap !== undefined) view.rampCap = rampCap;
        return view;
      }
      return { state: 'CLOSED', failures };
    } catch {
      return { state: 'CLOSED', failures: 0, degraded: true };
    }
  }

  /**
   * BP2 (C9): gợi ý `rateLimitRps` trong message lệch với row thật (đổi cấu hình sau khi message được tạo). Kiểm throttle lại
   * với rps THẬT mà KHÔNG đếm hai lần (không hoãn oan): gate đã INCR -> so lại chính giá trị đó (0 lệnh); gate chưa INCR
   * (gợi ý rps = 0) mà rps thật > 0 -> một INCR (1 lệnh, ca hiếm). Chỉ áp khi CLOSED và không degraded.
   */
  async recheckThrottle(destinationId: string, view: CircuitView, realRps: number): Promise<CircuitView> {
    if (view.state !== 'CLOSED' || view.degraded) return view;
    const { throttleAllowed: _a, throttleCount, ...rest } = view;
    // BP4: cap thật = min(rps thật nếu > 0, rampCap) — ramp vẫn áp dù rps đổi.
    const cap = Math.min(realRps > 0 ? realRps : Infinity, view.rampCap ?? Infinity);
    if (!Number.isFinite(cap)) return rest;
    if (throttleCount !== undefined) return { ...rest, throttleCount, throttleAllowed: throttleCount <= cap };
    // Gate chưa INCR (gợi ý rps 0, không ramp) mà rps thật > 0 -> một INCR.
    return { ...rest, throttleAllowed: await this.checkThrottle(destinationId, realRps) };
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
   * Ngược lại MỘT lệnh rồi về CLOSED: probe HALF_OPEN thành công -> `LUA_CLOSE_AND_RAMP` (DEL 4 khoá + đặt `:ramp`, BP4);
   * còn lại -> DEL `:failures`, `:open`, `:probe`, `:trips`.
   */
  async recordSuccess(target: CircuitTarget, view: CircuitView): Promise<CircuitState> {
    if (view.failures === 0 && view.state === 'CLOSED') {
      if (target.persistedState !== 'CLOSED' && !view.degraded) await this.transition(target, 'CLOSED', 0);
      return 'CLOSED';
    }
    const k = this.keys(target.destinationId);
    const ramp = deliveryRampConfig();
    try {
      if (view.state === 'HALF_OPEN' && ramp.seconds > 0) {
        // BP4 (ADR-198): PROBE thành công -> đích vừa hồi phục, hàng hoãn sắp dội về: xoá 4 khoá + bắt đầu ramp, MỘT lệnh.
        // Chỉ ramp sau probe: mạch tự về CLOSED (khoá hết hạn) hay thành công khi CLOSED còn failures nghĩa là chưa từng OPEN.
        await this.redis.eval(LUA_CLOSE_AND_RAMP, 5, k.failures, k.open, k.probe, k.trips, k.ramp, Date.now(), deliveryRampKeySeconds(ramp));
      } else {
        await this.redis.del(k.failures, k.open, k.probe, k.trips); // BP3: CLOSED -> xoá cả `:trips` (vẫn MỘT lệnh)
      }
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
      // BP3 (ADR-197): probe thất bại (HALF_OPEN) = bằng chứng sự cố không ngắn -> OPEN dài (300s), `:trips` +1.
      const probeFailed = view.state === 'HALF_OPEN';
      const openSeconds = probeFailed ? circuitOpenMaxSeconds() : CIRCUIT_OPEN_SECONDS;
      // C4: "thử lại lúc" = now + PTTL(:open) lấy ĐÚNG LÚC trip = giá trị vừa SET EX (không suy ra từ openedAt + 60s).
      const halfOpenAt = new Date(Date.now() + openSeconds * 1000);
      let trips: number | null = null;
      try {
        const m = this.redis
          .multi()
          .set(k.open, 'OPEN', 'EX', openSeconds)
          .expire(k.failures, failuresAfterOpenSeconds(openSeconds))
          .del(k.probe)
          .del(k.ramp); // BP4: lỗi đủ ngưỡng trong lúc ramp -> OPEN và dừng ramp
        if (probeFailed) m.incr(k.trips).expire(k.trips, failuresAfterOpenSeconds(openSeconds));
        const res = await m.exec();
        // Review BP3 TH-2: `:trips` lấy từ kết quả INCR trong CHÍNH MULTI này (lệnh thứ 5, sau DEL :ramp của BP4) — không thêm lệnh Redis.
        trips = probeFailed ? Number(res?.[4]?.[1]) || null : 0;
      } catch {
        return { state: 'CLOSED', failures, degraded: true };
      }
      // Một dòng cho MỖI lần trip (kể cả trip lại sau probe thất bại), kèm số lần probe thất bại liên tiếp (`:trips`).
      logger.warn({ destinationId: target.destinationId, failures, openSeconds, probeFailed, trips }, `Circuit breaker -> OPEN (hoãn gửi ${openSeconds}s)`);
      await this.transition(target, 'OPEN', failures, false, halfOpenAt);
      return { state: 'OPEN', failures, openPttlMs: openSeconds * 1000 };
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
  private async transition(target: CircuitTarget, to: CircuitState, failures: number, force = false, halfOpenAt: Date | null = null): Promise<void> {
    const from = target.persistedState;
    if (from === to && !force) return;
    target.persistedState = to;
    try {
      const changed = await this.prisma
        .forTenant(target.tenantId)
        .updateDestinationCircuitState(target.destinationId, to, to === 'OPEN' ? halfOpenAt : null);
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
