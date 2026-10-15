import Redis from 'ioredis';
import {
  CircuitBreakerService,
  CircuitTarget,
  CIRCUIT_CHANNEL,
  FAIL_OPEN_PROBE,
  LUA_ACQUIRE_PROBE,
  LUA_INCR_EXPIRE,
  LUA_RELEASE_PROBE,
  LUA_GATE,
  LUA_CLOSE_AND_RAMP,
} from '../src/circuit/circuit-breaker.service';
import { describeDb } from '../../../libs/database/test/support/test-db';
import {
  DELIVERY_RAMP_MAX_DOUBLINGS,
  DELIVERY_RAMP_MAX_SECONDS,
  circuitOpenMaxSeconds,
  deliveryRampCapAt,
  deliveryRampConfig,
  deliveryRampExtendMs,
  deliveryRampKeySeconds,
  deliveryRampLastStep,
} from '@hub/messaging';
import { logger } from '@hub/common';

/**
 * Redis giả trong bộ nhớ, đủ cho circuit breaker: MGET, SET (EX/NX), DEL nhiều khoá, INCR, EXPIRE,
 * MULTI/EXEC, PUBLISH. Hết hạn khoá mô phỏng bằng `expireNow(key)` (không phụ thuộc đồng hồ thật).
 * `writes` đếm mọi lệnh GHI để kiểm ngân sách Redis (S3-5).
 */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const calls: string[] = [];
  const writes = () => calls.filter((c) => !['mget', 'get'].includes(c)).length;
  const r: any = {
    store,
    calls,
    writes,
    pexpires: [] as Array<[string, number]>,
    rampExp: new Map<string, number>(),
    expireNow: (k: string) => store.delete(k),
    mget: jest.fn(async (...keys: string[]) => {
      calls.push('mget');
      return keys.map((k) => store.get(k) ?? null);
    }),
    get: jest.fn(async (k: string) => {
      calls.push('get');
      return store.get(k) ?? null;
    }),
    set: jest.fn(async (k: string, v: string, ...args: any[]) => {
      calls.push('set');
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (...keys: string[]) => {
      calls.push('del');
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
    incr: jest.fn(async (k: string) => {
      calls.push('incr');
      const n = parseInt(store.get(k) ?? '0', 10) + 1;
      store.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => {
      calls.push('expire');
      return 1;
    }),
    publish: jest.fn(async () => {
      calls.push('publish');
      return 1;
    }),
    // Mô phỏng ĐÚNG ngữ nghĩa ba script Lua (ADR-054); bản thật được kiểm trên Redis thật ở cuối file.
    eval: jest.fn(async (script: string, numKeys: number, ...rest: any[]) => {
      calls.push('eval');
      const keys = rest.slice(0, numKeys);
      const argv = rest.slice(numKeys).map(String);
      if (script === LUA_INCR_EXPIRE) {
        const n = parseInt(store.get(keys[0]) ?? '0', 10) + 1;
        store.set(keys[0], String(n));
        return n;
      }
      if (script === LUA_ACQUIRE_PROBE) {
        const [open, failures, probe] = keys;
        if (store.has(open)) return 0;
        if (parseInt(store.get(failures) ?? '0', 10) < Number(argv[2])) return 0;
        if (store.has(probe)) return 0;
        store.set(probe, argv[0]);
        return 1;
      }
      if (script === LUA_GATE) {
        // BP2 §6 + BP4: KEYS open, failures, throttle, ramp, probe; ARGV ngưỡng, rps, nowMs, ramp start, ramp step, TTL,
        // bậc cuối (F3 + Thấp-9), trần tuyệt đối ms (ADR-234). INCR chỉ khi CLOSED và có trần (rps > 0 hoặc còn :ramp).
        // Bậc cuối + bị chặn -> PEXPIRE :ramp trong script, CHỈ khi dài hơn PTTL (ghi vào `pexpires`).
        // PHẠM VI FAKE (review F3 TB-1): hạn khoá là `rampExp` theo đồng hồ GIẢ (nowMs của ARGV), không tự hết hạn; không có
        // = PTTL −1 như Redis. Bản sao JS chỉ để kiểm consumer/ngân sách — Lua THẬT kiểm ở khối Redis thật cuối file (CI db L1).
        const [open, failures, throttle, ramp, probe] = keys;
        let t = -1;
        let cap = -1;
        let atLast = false;
        let el = 0;
        const now = Number(argv[2]);
        if (!store.has(open) && parseInt(store.get(failures) ?? '0', 10) < Number(argv[0])) {
          if (store.has(ramp)) {
            el = Math.max(0, now - (Number(store.get(ramp)) || 0));
            if (el < Number(argv[7])) {
              const last = Math.max(0, Math.min(DELIVERY_RAMP_MAX_DOUBLINGS, Number(argv[6])));
              const steps = Math.min(last, Math.floor(el / (Number(argv[4]) * 1000)));
              atLast = steps >= last;
              cap = Number(argv[3]) * 2 ** steps;
            }
          }
          if (Number(argv[1]) > 0 || cap > 0) {
            t = parseInt(store.get(throttle) ?? '0', 10) + 1;
            store.set(throttle, String(t));
            if (atLast && t > cap) {
              const ext = Math.min(Number(argv[8]), Number(argv[7]) - el);
              const pttl = r.rampExp.has(ramp) ? r.rampExp.get(ramp) - now : -1;
              if (ext > pttl) {
                r.rampExp.set(ramp, now + ext);
                r.pexpires.push([ramp, ext]);
              }
            }
          }
        }
        // ADR-233: cờ :probe đang bị giữ, chỉ khi HALF_OPEN (hết :open, failures ≥ ngưỡng)
        const held = !store.has(open) && parseInt(store.get(failures) ?? '0', 10) >= Number(argv[0]) && probe !== undefined && store.has(probe) ? 1 : 0;
        return [store.has(open) ? 1 : 0, store.get(failures) ?? '', store.has(open) ? 60_000 : -2, t, cap, held];
      }
      if (script === LUA_CLOSE_AND_RAMP) {
        keys.slice(0, 4).forEach((k2: string) => store.delete(k2));
        store.set(keys[4], argv[0]);
        ttls.set(keys[4], Number(argv[1]));
        r.rampExp.set(keys[4], Number(argv[0]) + Number(argv[1]) * 1000);
        return 1;
      }
      if (script === LUA_RELEASE_PROBE) {
        if (store.get(keys[0]) === argv[0]) return store.delete(keys[0]) ? 1 : 0;
        return 0;
      }
      throw new Error('script lạ');
    }),
    // BP3: TTL (giây) đặt trong MULTI — để kiểm OPEN 60/300s và `:failures`/`:trips` sống quá `:open`.
    ttls,
    multi: jest.fn(() => {
      calls.push('multi');
      const ops: Array<() => unknown> = [];
      const chain: any = {
        set: (k: string, v: string, ...args: any[]) => (
          ops.push(() => {
            store.set(k, v);
            const i = args.indexOf('EX');
            if (i >= 0) ttls.set(k, Number(args[i + 1]));
            return 'OK';
          }),
          chain
        ),
        del: (...ks: string[]) => (ops.push(() => ks.filter((k) => store.delete(k)).length), chain),
        incr: (k: string) => (
          ops.push(() => {
            const n = parseInt(store.get(k) ?? '0', 10) + 1;
            store.set(k, String(n));
            return n;
          }),
          chain
        ),
        expire: (k: string, sec: number) => (ops.push(() => (ttls.set(k, Number(sec)), 1)), chain),
        // như ioredis: [[err, kết quả], …] theo thứ tự lệnh
        exec: async () => ops.map((op) => [null, op()]),
      };
      return chain;
    }),
  };
  return r;
}

/** DB giả: `destinations.circuit_state` — update CÓ ĐIỀU KIỆN (khác giá trị mới) trả số dòng đổi. */
function fakePrisma(initial: Record<string, string> = {}) {
  const db = new Map<string, string>(Object.entries(initial));
  const repo = {
    updateDestinationCircuitState: jest.fn(async (id: string, to: string, _halfOpenAt?: Date | null) => {
      if ((db.get(id) ?? 'CLOSED') === to) return 0;
      db.set(id, to);
      return 1;
    }),
  };
  return { db, repo, prisma: { forTenant: jest.fn(() => repo) } as any };
}

const DEST = 'dest-1';
const K = (s: string) => `circuit:${DEST}:${s}`;
const target = (persisted: CircuitTarget['persistedState'] = 'CLOSED'): CircuitTarget => ({
  destinationId: DEST,
  tenantId: 'tenant-1',
  persistedState: persisted,
});

describe('CircuitBreakerService — 3 trạng thái, probe SET NX (S2-1)', () => {
  it('review #2: getState(dest, rps>0) dùng MỘT lệnh EVAL (không MGET riêng); CLOSED tiêu RPS, HALF_OPEN không', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    expect(await cb.getState(DEST, 2)).toEqual({ state: 'CLOSED', failures: 0, throttleAllowed: true, throttleCount: 1 });
    expect(redis.calls).toEqual(['eval']);
    expect((await cb.getState(DEST, 2)).throttleAllowed).toBe(true);
    expect((await cb.getState(DEST, 2)).throttleAllowed).toBe(false);
    redis.store.set(`circuit:${DEST}:failures`, '5');
    expect(await cb.getState(DEST, 2)).toEqual({ state: 'HALF_OPEN', failures: 5 });
    expect(redis.calls.filter((c: string) => c !== 'eval')).toEqual([]);
  });

  it('mặc định CLOSED, gate (getState) LUÔN đúng MỘT lệnh EVAL, không INCR throttle khi không có trần (BP2 §6)', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    expect(await cb.getState(DEST)).toEqual({ state: 'CLOSED', failures: 0 });
    expect(redis.calls).toEqual(['eval']);
    expect([...redis.store.keys()].filter((k: string) => k.startsWith('throttle:'))).toEqual([]);
  });

  it('BP2 §6: OPEN -> gate trả PTTL của :open (cho BP3); recheckThrottle so lại bộ đếm cũ với rps thật, KHÔNG INCR lần hai', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    redis.store.set(`circuit:${DEST}:open`, 'OPEN');
    expect(await cb.getState(DEST, 3)).toEqual({ state: 'OPEN', failures: 0, openPttlMs: 60_000 });
    redis.store.delete(`circuit:${DEST}:open`);
    const v1 = await cb.getState(DEST, 1); // count 1
    const v2 = await cb.getState(DEST, 1); // count 2 -> vượt rps gợi ý 1
    expect(v2).toMatchObject({ throttleAllowed: false, throttleCount: 2 });
    redis.calls.length = 0;
    expect(await cb.recheckThrottle(DEST, v2, 5)).toMatchObject({ throttleAllowed: true, throttleCount: 2 }); // rps thật 5
    expect(await cb.recheckThrottle(DEST, v1, 0)).toEqual({ state: 'CLOSED', failures: 0 }); // rps thật 0 -> bỏ throttle
    expect(redis.calls).toEqual([]); // 0 lệnh
    // gợi ý rps 0 (không INCR) mà rps thật > 0 -> MỘT INCR
    const v0 = await cb.getState(DEST, 0);
    redis.calls.length = 0;
    expect((await cb.recheckThrottle(DEST, v0, 10)).throttleAllowed).toBe(true);
    expect(redis.calls).toEqual(['eval']);
  });

  it('[AF:#24] 5 lần lỗi -> OPEN; ghi DB circuit_state và publish ĐÚNG MỘT lần lên hub:realtime:circuit', async () => {
    const redis = fakeRedis();
    const { prisma, db, repo } = fakePrisma();
    const cb = new CircuitBreakerService(prisma, redis);
    const t = target();
    for (let i = 1; i <= 5; i++) {
      const view = await cb.getState(DEST);
      const after = await cb.recordFailure(t, view);
      expect(after.state).toBe(i < 5 ? 'CLOSED' : 'OPEN');
    }
    expect(await cb.getState(DEST)).toMatchObject({ state: 'OPEN', failures: 5 });
    expect(db.get(DEST)).toBe('OPEN');
    expect(repo.updateDestinationCircuitState).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = redis.publish.mock.calls[0];
    expect(channel).toBe(CIRCUIT_CHANNEL);
    expect(JSON.parse(raw)).toMatchObject({ tenantId: 'tenant-1', destinationId: DEST, from: 'CLOSED', to: 'OPEN', failures: 5 });
    expect(redis.publish).not.toHaveBeenCalledWith('hub:alerts', expect.anything());
    // INCR+EXPIRE gộp thành MỘT lệnh EVAL mỗi lần lỗi (ADR-054) — không còn incr/expire rời
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
    expect(redis.eval.mock.calls.filter((c: any[]) => c[0] === LUA_INCR_EXPIRE)).toHaveLength(5);
  });

  it('[AF:#23] hết TTL :open -> HALF_OPEN (suy ra, không lưu); hai worker cùng lúc chỉ MỘT giành được probe', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    const t = target();
    for (let i = 0; i < 5; i++) await cb.recordFailure(t, await cb.getState(DEST));
    redis.expireNow(K('open'));

    expect((await cb.getState(DEST)).state).toBe('HALF_OPEN');
    const [a, b] = await Promise.all([cb.tryAcquireProbe(DEST), cb.tryAcquireProbe(DEST)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(redis.store.get(K('probe'))).toBe(a ?? b); // giá trị khoá = token của chủ
  });

  it('syncObserved: DB còn OPEN mà Redis suy ra HALF_OPEN -> ghi DB + publish một lần; gọi lại không publish nữa', async () => {
    const redis = fakeRedis();
    const { prisma, db } = fakePrisma({ [DEST]: 'OPEN' });
    const cb = new CircuitBreakerService(prisma, redis);
    redis.store.set(K('failures'), '5');
    const t = target('OPEN');
    await cb.syncObserved(t, await cb.getState(DEST));
    await cb.syncObserved(t, await cb.getState(DEST));
    expect(db.get(DEST)).toBe('HALF_OPEN');
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(JSON.parse(redis.publish.mock.calls[0][1])).toMatchObject({ from: 'OPEN', to: 'HALF_OPEN' });
  });

  it('[BP:T14] (phần a) probe thành công -> CLOSED: MỘT lệnh xoá 4 khoá (failures, open, probe, trips) + đặt :ramp = now EX 60', async () => {
    const redis = fakeRedis();
    const { prisma, db } = fakePrisma({ [DEST]: 'HALF_OPEN' });
    const cb = new CircuitBreakerService(prisma, redis);
    redis.store.set(K('failures'), '5');
    redis.store.set(K('trips'), '2');
    expect(await cb.tryAcquireProbe(DEST)).toEqual(expect.any(String));
    const view = await cb.getState(DEST);
    redis.calls.length = 0;
    const before = Date.now();

    expect(await cb.recordSuccess(target('HALF_OPEN'), view)).toBe('CLOSED');
    expect(redis.calls.filter((c: string) => c !== 'publish')).toEqual(['eval']); // MỘT lệnh
    expect(redis.eval.mock.calls.at(-1)![0]).toBe(LUA_CLOSE_AND_RAMP);
    expect(redis.del).not.toHaveBeenCalled();
    expect([...redis.store.keys()]).toEqual([K('ramp')]);
    expect(Number(redis.store.get(K('ramp')))).toBeGreaterThanOrEqual(before);
    expect(redis.ttls.get(K('ramp'))).toBe(70); // F3 (ADR-232): ramp 60s + một bậc 10s kẹp ở trần cuối
    expect(db.get(DEST)).toBe('CLOSED');
    expect(JSON.parse(redis.publish.mock.calls[0][1])).toMatchObject({ from: 'HALF_OPEN', to: 'CLOSED' });
  });

  it('[BP:T12] (phần a) probe thất bại -> OPEN lại ngay với TTL 300s (không phải 60s); :failures và :trips sống quá :open; nhả :probe; halfOpenAt = lúc trip + 300s', async () => {
    const redis = fakeRedis();
    const { prisma, db, repo } = fakePrisma({ [DEST]: 'HALF_OPEN' });
    const cb = new CircuitBreakerService(prisma, redis);
    redis.store.set(K('failures'), '5');
    await cb.tryAcquireProbe(DEST);
    const before = Date.now();
    const warn = jest.spyOn(logger, 'warn');
    const after = await cb.recordFailure(target('HALF_OPEN'), await cb.getState(DEST));
    expect(after).toMatchObject({ state: 'OPEN', openPttlMs: 300_000 });
    // review BP3 TH-2: một dòng log mỗi lần trip, kèm :trips lấy từ kết quả MULTI (không thêm lệnh)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ destinationId: DEST, openSeconds: 300, probeFailed: true, trips: 1 }), expect.stringContaining('OPEN'));
    warn.mockRestore();
    expect(redis.store.get(K('open'))).toBe('OPEN');
    expect(redis.ttls.get(K('open'))).toBe(300);
    expect(redis.ttls.get(K('failures'))).toBeGreaterThan(300);
    expect(redis.store.get(K('trips'))).toBe('1');
    expect(redis.ttls.get(K('trips'))).toBeGreaterThan(300);
    expect(redis.store.has(K('probe'))).toBe(false);
    expect(db.get(DEST)).toBe('OPEN');
    const [, to, halfOpenAt] = repo.updateDestinationCircuitState.mock.calls.at(-1)! as [string, string, Date];
    expect(to).toBe('OPEN');
    expect(halfOpenAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(halfOpenAt.getTime()).toBeLessThan(before + 301_000);
  });

  it('[BP:T12] (phần b) trip LẦN ĐẦU (đủ ngưỡng khi CLOSED) -> OPEN 60s, không tăng :trips; halfOpenAt = lúc trip + 60s; CIRCUIT_OPEN_MAX_SECONDS kẹp 60..300', async () => {
    const redis = fakeRedis();
    const { prisma, repo } = fakePrisma();
    const cb = new CircuitBreakerService(prisma, redis);
    redis.store.set(K('failures'), '4');
    const before = Date.now();
    const after = await cb.recordFailure(target('CLOSED'), await cb.getState(DEST));
    expect(after).toMatchObject({ state: 'OPEN', openPttlMs: 60_000 });
    expect(redis.ttls.get(K('open'))).toBe(60);
    expect(redis.ttls.get(K('failures'))).toBe(180);
    expect(redis.store.has(K('trips'))).toBe(false);
    const halfOpenAt = repo.updateDestinationCircuitState.mock.calls.at(-1)![2] as Date;
    expect(halfOpenAt.getTime() - before).toBeGreaterThanOrEqual(60_000);
    expect(halfOpenAt.getTime() - before).toBeLessThan(61_000);
    expect(circuitOpenMaxSeconds(undefined)).toBe(300);
    expect(circuitOpenMaxSeconds('120')).toBe(120);
    expect(circuitOpenMaxSeconds('9999')).toBe(300); // chỉ được thấp hơn (cửa sổ retry tính theo 300)
    expect(circuitOpenMaxSeconds('10')).toBe(60);
    expect(circuitOpenMaxSeconds('abc')).toBe(300);
    // trạng thái khác OPEN -> halfOpenAt NULL
    await cb.recordSuccess(target('OPEN'), { state: 'HALF_OPEN', failures: 5 });
    expect(repo.updateDestinationCircuitState.mock.calls.at(-1)).toEqual([DEST, 'CLOSED', null]);
  });

  it('[BP:T14] (phần b) KHÔNG ramp khi: tắt (DELIVERY_RAMP_SECONDS=0), hay thành công lúc CLOSED còn failures (chưa từng OPEN) -> DEL 4 khoá như cũ; trip OPEN xoá :ramp; cấu hình kẹp', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma({ [DEST]: 'HALF_OPEN' }).prisma, redis);
    process.env.DELIVERY_RAMP_SECONDS = '0';
    try {
      redis.store.set(K('failures'), '5');
      await cb.recordSuccess(target('HALF_OPEN'), { state: 'HALF_OPEN', failures: 5 });
      expect(redis.del).toHaveBeenCalledWith(K('failures'), K('open'), K('probe'), K('trips'));
      expect(redis.store.has(K('ramp'))).toBe(false);
    } finally {
      delete process.env.DELIVERY_RAMP_SECONDS;
    }
    redis.store.set(K('failures'), '2');
    await cb.recordSuccess(target('CLOSED'), { state: 'CLOSED', failures: 2 });
    expect(redis.store.has(K('ramp'))).toBe(false);
    // đang ramp mà lỗi đủ ngưỡng -> OPEN và dừng ramp
    redis.store.set(K('ramp'), String(Date.now()));
    redis.store.set(K('failures'), '4');
    await cb.recordFailure(target('CLOSED'), { state: 'CLOSED', failures: 4 });
    expect(redis.store.has(K('ramp'))).toBe(false);
    expect(redis.store.get(K('open'))).toBe('OPEN');
    expect(deliveryRampConfig({})).toEqual({ startRps: 2, stepSeconds: 10, seconds: 60, maxSeconds: 180 });
    expect(deliveryRampConfig({ DELIVERY_RAMP_SECONDS: '600', DELIVERY_RAMP_START_RPS: '0', DELIVERY_RAMP_STEP_SECONDS: 'x' })).toEqual({ startRps: 2, stepSeconds: 10, seconds: 60, maxSeconds: 180 });
    // START chỉ kẹp thấp hơn 2 (review F3 Thấp-4); RAMP_MAX mặc định min(180, 3 × (30 + 4)) = 102 (Thấp-3)
    expect(deliveryRampConfig({ DELIVERY_RAMP_SECONDS: '30', DELIVERY_RAMP_START_RPS: '5', DELIVERY_RAMP_STEP_SECONDS: '4' })).toEqual({ startRps: 2, stepSeconds: 4, seconds: 30, maxSeconds: 102 });
    expect(deliveryRampConfig({ DELIVERY_RAMP_START_RPS: '1' }).startRps).toBe(1);
  });

  it('[BP:T15] (phần d) ADR-234 L0 — kẹp cấu hình: RAMP_MAX chỉ kẹp xuống (≤ 180, ≥ ramp + một bậc); bậc cuối ≤ 5 lần nhân đôi dù bước 1s (Thấp-9)', () => {
    // RAMP_MAX: env chỉ kẹp THẤP hơn; nới lên 600 -> vẫn 180; thấp hơn khoá gốc (70s) -> nâng lên 70; bậy -> 180
    expect(deliveryRampConfig({ DELIVERY_RAMP_MAX_SECONDS: '600' }).maxSeconds).toBe(180);
    expect(deliveryRampConfig({ DELIVERY_RAMP_MAX_SECONDS: '120' }).maxSeconds).toBe(120);
    expect(deliveryRampConfig({ DELIVERY_RAMP_MAX_SECONDS: '30' }).maxSeconds).toBe(70);
    expect(deliveryRampConfig({ DELIVERY_RAMP_MAX_SECONDS: 'x' }).maxSeconds).toBe(180);
    expect(deliveryRampConfig({ DELIVERY_RAMP_MAX_SECONDS: '0' }).maxSeconds).toBe(180);
    expect(deliveryRampConfig({ DELIVERY_RAMP_SECONDS: '20', DELIVERY_RAMP_STEP_SECONDS: '5', DELIVERY_RAMP_MAX_SECONDS: '10' }).maxSeconds).toBe(25);
    // Thấp-3: hạ ramp thì trần hạ theo (10s/10s -> khoá 20s -> RAMP_MAX 60s, không 180s ở 2 rps); env không nới quá mặc định đó
    expect(deliveryRampConfig({ DELIVERY_RAMP_SECONDS: '10' }).maxSeconds).toBe(60);
    expect(deliveryRampConfig({ DELIVERY_RAMP_SECONDS: '10', DELIVERY_RAMP_MAX_SECONDS: '180' }).maxSeconds).toBe(60);
    // Thấp-2: mức gia hạn ≥ một vòng retry.10s + một bậc
    expect(deliveryRampExtendMs(deliveryRampConfig({}))).toBe(20_000);
    expect(deliveryRampExtendMs(deliveryRampConfig({ DELIVERY_RAMP_STEP_SECONDS: '4' }))).toBe(14_000);
    expect(deliveryRampExtendMs(deliveryRampConfig({ DELIVERY_RAMP_STEP_SECONDS: '1' }))).toBe(11_000);
    // Thấp-4: trần cuối tuyệt đối ≤ 64 dù env START lớn
    const big = deliveryRampConfig({ DELIVERY_RAMP_START_RPS: '5000', DELIVERY_RAMP_STEP_SECONDS: '1' });
    expect(deliveryRampCapAt(big, 100_000)).toBe(64);
    expect(DELIVERY_RAMP_MAX_SECONDS).toBe(180);
    // Thấp-9: bước 1s, ramp 60s -> trước đây bậc cuối 59 (kẹp 20 trong Lua = 2M rps); nay ≤ 5 -> trần cuối start × 32
    expect(deliveryRampLastStep(deliveryRampConfig({}))).toBe(5);
    expect(deliveryRampLastStep(deliveryRampConfig({ DELIVERY_RAMP_STEP_SECONDS: '1' }))).toBe(DELIVERY_RAMP_MAX_DOUBLINGS);
    expect(deliveryRampLastStep(deliveryRampConfig({ DELIVERY_RAMP_SECONDS: '30', DELIVERY_RAMP_STEP_SECONDS: '10' }))).toBe(2);
    expect(deliveryRampLastStep(deliveryRampConfig({ DELIVERY_RAMP_SECONDS: '0' }))).toBe(0);
    const fast = deliveryRampConfig({ DELIVERY_RAMP_STEP_SECONDS: '1' });
    for (let ms = 0; ms < 180_000; ms += 500) expect(deliveryRampCapAt(fast, ms)!).toBeLessThanOrEqual(64);
    expect(deliveryRampCapAt(fast, 5_000)).toBe(64);
    // mô hình trần: 2,4,..,64 rồi giữ 64 tới RAMP_MAX; từ RAMP_MAX -> hết ramp
    const d = deliveryRampConfig({});
    expect([0, 10_000, 20_000, 30_000, 40_000, 50_000, 69_999, 179_999].map((ms) => deliveryRampCapAt(d, ms))).toEqual([2, 4, 8, 16, 32, 64, 64, 64]);
    expect(deliveryRampCapAt(d, 180_000)).toBeNull();
    // khoá gốc vẫn ramp + một bậc (gia hạn chỉ do gate, có điều kiện)
    expect(deliveryRampKeySeconds(d)).toBe(70);
  });

  it('[BP:T15] (phần e) ADR-234 gate (fake): bậc cuối + bị chặn -> PEXPIRE :ramp = min(2 × step, còn lại tới RAMP_MAX) trong CÙNG EVAL; quá RAMP_MAX -> hết ramp; bước 1s không vượt start × 32', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    const t0 = 1_800_000_000_000;
    let now = t0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      redis.store.set(K('ramp'), String(t0));
      const burst = async (n: number) => {
        let ok = 0;
        for (let i = 0; i < n; i++) if ((await cb.getState(DEST, 0)).throttleAllowed !== false) ok++;
        return ok;
      };
      // bậc 2 (25s) bị chặn -> không gia hạn
      now = t0 + 25_000;
      expect(await burst(10)).toBe(8);
      expect(redis.pexpires).toEqual([]);
      // bậc cuối (55s): 64 lần đầu không bị chặn -> không gia hạn; lần chặn đầu gia hạn 20s, lần sau cùng thời điểm không (PTTL đã 20s)
      now = t0 + 55_000;
      const before = redis.calls.length;
      expect(await burst(66)).toBe(64);
      expect(redis.calls.length - before).toBe(66);
      expect(redis.pexpires).toEqual([[K('ramp'), 20_000]]);
      // sát RAMP_MAX: gia hạn chỉ phần còn lại
      redis.pexpires.length = 0;
      now = t0 + 171_500;
      await burst(65);
      expect(redis.pexpires).toEqual([[K('ramp'), 8_500]]);
      // quá RAMP_MAX (khoá còn do lệch đồng hồ) -> không trần, không INCR
      now = t0 + 180_000;
      expect(await cb.getState(DEST, 0)).toEqual({ state: 'CLOSED', failures: 0 });
      // Thấp-9: bước 1s -> trần cuối 64 (không phải 2^20 × 2)
      process.env.DELIVERY_RAMP_STEP_SECONDS = '1';
      now = t0 + 50_000;
      expect((await cb.getState(DEST, 0)).rampCap).toBe(64);
      // guard "không rút ngắn" (bước 1s: bậc cuối từ 5s, khoá gốc 61s, mức gia hạn max(2s, 10s + 1s) = 11s)
      redis.pexpires.length = 0;
      redis.rampExp.set(K('ramp'), t0 + 61_000);
      now = t0 + 10_000;
      await burst(70);
      expect(redis.pexpires).toEqual([]); // PTTL 51s > 11s -> không PEXPIRE
      now = t0 + 52_000;
      await burst(70);
      expect(redis.pexpires).toEqual([[K('ramp'), 11_000]]); // PTTL 9s < 11s -> kéo dài
      // `:ramp` hỏng (không phải số) -> không ramp, không INCR (review F3 Thấp-6)
      redis.store.set(K('ramp'), 'hong');
      expect(await cb.getState(DEST, 0)).toEqual({ state: 'CLOSED', failures: 0 });
    } finally {
      delete process.env.DELIVERY_RAMP_STEP_SECONDS;
      jest.restoreAllMocks();
    }
  });

  it('[BP:T15] (phần a) trong ramp: giây 0–9 tối đa 2/s, giây 10–19 tối đa 4/s; cap = min(rps của khách, ramp); recheck với rps thật vẫn giữ ramp', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    const t0 = 1_800_000_000_000;
    let now = t0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      redis.store.set(K('ramp'), String(t0));
      const allowed = async (rps = 0, n = 6) => {
        let ok = 0;
        for (let i = 0; i < n; i++) if ((await cb.getState(DEST, rps)).throttleAllowed !== false) ok++;
        return ok;
      };
      now = t0 + 5_000;
      expect(await allowed()).toBe(2);
      now = t0 + 15_000;
      expect(await allowed()).toBe(4);
      now = t0 + 16_000;
      expect(await allowed(3)).toBe(3); // rps khách 3 < ramp 4
      now = t0 + 17_000;
      expect(await cb.getState(DEST, 0)).toMatchObject({ state: 'CLOSED', rampCap: 4, throttleCount: 1, throttleAllowed: true });
      now = t0 + 55_000;
      expect((await cb.getState(DEST, 0)).rampCap).toBe(64);
      // F3 (ADR-232): bậc thêm sau 60s KẸP ở trần cuối, không nhân đôi lên 128
      now = t0 + 65_000;
      expect((await cb.getState(DEST, 0)).rampCap).toBe(64);
      // review BP4 TH-1: mốc :ramp ở TƯƠNG LAI (đồng hồ worker lệch) -> kẹp đã trôi về 0, cap = start (không phải 1 rps)
      redis.store.set(K('ramp'), String(t0 + 30_000));
      now = t0 + 2_000;
      expect((await cb.getState(DEST, 0)).rampCap).toBe(2);
      redis.store.set(K('ramp'), String(t0));
      // gợi ý rps 100 nhưng rps thật 1: cap = min(1, ramp) — lần 2 trong giây bị chặn, không INCR thêm
      now = t0 + 21_000;
      await cb.getState(DEST, 100);
      const v = await cb.getState(DEST, 100);
      expect(v).toMatchObject({ throttleAllowed: true, throttleCount: 2, rampCap: 8 });
      expect(await cb.recheckThrottle(DEST, v, 1)).toMatchObject({ throttleAllowed: false, throttleCount: 2 });
      expect(await cb.recheckThrottle(DEST, v, 0)).toMatchObject({ throttleAllowed: true }); // bỏ rps -> chỉ còn ramp 8
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('gửi thành công khi failures == 0 -> 0 lệnh Redis, 0 lệnh DB', async () => {
    const redis = fakeRedis();
    const { prisma, repo } = fakePrisma();
    const cb = new CircuitBreakerService(prisma, redis);
    expect(await cb.recordSuccess(target(), { state: 'CLOSED', failures: 0 })).toBe('CLOSED');
    expect(redis.calls).toHaveLength(0);
    expect(repo.updateDestinationCircuitState).not.toHaveBeenCalled();
  });

  it('[AF:#26] thành công khi CLOSED nhưng còn failures > 0 -> DEL bộ đếm (reset "liên tiếp"), không đổi trạng thái, không publish', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    await cb.recordFailure(target(), await cb.getState(DEST));
    await cb.recordSuccess(target(), await cb.getState(DEST));
    expect(redis.store.has(K('failures'))).toBe(false);
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('Redis chết -> fail-open: getState CLOSED (degraded), probe được cấp, ghi lỗi không ném', async () => {
    const broken: any = new Proxy(
      {},
      { get: (_t, p) => (p === 'on' ? () => {} : jest.fn(async () => Promise.reject(new Error('ECONNREFUSED')))) },
    );
    broken.multi = () => {
      throw new Error('ECONNREFUSED');
    };
    const { prisma, repo } = fakePrisma();
    const cb = new CircuitBreakerService(prisma, broken);
    const view = await cb.getState(DEST);
    expect(view).toMatchObject({ state: 'CLOSED', failures: 0, degraded: true });
    expect(await cb.tryAcquireProbe(DEST)).toBe(FAIL_OPEN_PROBE);
    await expect(cb.releaseProbe(DEST, FAIL_OPEN_PROBE)).resolves.toBeUndefined();
    await expect(cb.recordFailure(target(), view)).resolves.toMatchObject({ state: 'CLOSED' });
    // degraded -> không đồng bộ DB theo trạng thái "bịa" khi Redis chết
    await cb.syncObserved(target('OPEN'), view);
    expect(repo.updateDestinationCircuitState).not.toHaveBeenCalled();
  });

  // ---------- Review SPEC-2 #6 (ADR-054) ----------
  it('#6a: không giành được probe khi :open còn (đọc cũ nói HALF_OPEN nhưng ai đó vừa mở lại)', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    redis.store.set(K('failures'), '6');
    redis.store.set(K('open'), 'OPEN');
    expect(await cb.tryAcquireProbe(DEST)).toBeNull();
    expect(redis.store.has(K('probe'))).toBe(false);
  });

  it('#6a: không giành được probe khi failures < ngưỡng (đã về CLOSED)', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    redis.store.set(K('failures'), '2');
    expect(await cb.tryAcquireProbe(DEST)).toBeNull();
  });

  it('#6a: nhả probe CHỈ khi còn là chủ — token khác không xoá được probe của worker khác', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    redis.store.set(K('failures'), '5');
    const mine = await cb.tryAcquireProbe(DEST);
    // probe của "mình" hết hạn, worker khác giành được
    redis.expireNow(K('probe'));
    const theirs = await cb.tryAcquireProbe(DEST);
    expect(theirs).not.toBe(mine);
    await cb.releaseProbe(DEST, mine);
    expect(redis.store.get(K('probe'))).toBe(theirs);
    await cb.releaseProbe(DEST, theirs);
    expect(redis.store.has(K('probe'))).toBe(false);
  });

  it('#6c: thành công khi bản DB đọc kèm delivery nói CLOSED nhưng thật ra đã OPEN -> vẫn UPDATE có điều kiện về CLOSED', async () => {
    const redis = fakeRedis();
    const { prisma, db, repo } = fakePrisma({ [DEST]: 'OPEN' }); // DB thật: OPEN (worker khác vừa ghi)
    const cb = new CircuitBreakerService(prisma, redis);
    redis.store.set(K('failures'), '3');
    await cb.recordSuccess(target('CLOSED'), await cb.getState(DEST)); // persistedState cũ = CLOSED
    expect(repo.updateDestinationCircuitState).toHaveBeenCalledWith(DEST, 'CLOSED', null);
    expect(db.get(DEST)).toBe('CLOSED');
  });

  describe('Outbound Throttle per destination (§5.4b)', () => {
    it('rateLimitRps = 0 -> luôn cho phép, không chạm Redis', async () => {
      const redis = fakeRedis();
      const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
      expect(await cb.checkThrottle('d', 0)).toBe(true);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('chặn khi vượt rateLimitRps trong cùng giây', async () => {
      const redis = fakeRedis();
      const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
      expect(await cb.checkThrottle('d', 3)).toBe(true);
      expect(await cb.checkThrottle('d', 3)).toBe(true);
      expect(await cb.checkThrottle('d', 3)).toBe(true);
      expect(await cb.checkThrottle('d', 3)).toBe(false);
    });
  });
});

/**
 * Lua THẬT trên Redis thật (docker compose, localhost:6379) — chạy cùng RUN_DB_TESTS=1 (ioredis-mock
 * không có trong repo và eval của nó hạn chế). Khoá dùng id ngẫu nhiên, dọn sau test.
 */
const describeRedis = describeDb; // Redis thật: cùng cổng L1 (RUN_DB_TESTS=1)
describeRedis('CircuitBreakerService — script Lua trên Redis THẬT (ADR-054)', () => {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  const dest = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const k = (s: string) => `circuit:${dest}:${s}`;
  const cb = new CircuitBreakerService(fakePrisma().prisma, redis);

  afterAll(async () => {
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'), k('ramp'), `throttle:destination:${dest}:${Math.floor(Date.now() / 1000)}`);
    await redis.quit();
  });

  it('INCR+EXPIRE một lệnh: đếm đúng, TTL đặt ở lần đầu (~120s)', async () => {
    const t = { destinationId: dest, tenantId: 'tenant-1', persistedState: 'CLOSED' as const };
    for (let i = 0; i < 3; i++) await cb.recordFailure(t, await cb.getState(dest));
    expect(await redis.get(k('failures'))).toBe('3');
    const ttl = await redis.ttl(k('failures'));
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('probe: chưa đủ ngưỡng -> null; đủ ngưỡng mà còn :open -> null; HALF_OPEN -> đúng một token; nhả theo chủ', async () => {
    await redis.set(k('failures'), '2');
    expect(await cb.tryAcquireProbe(dest)).toBeNull();
    await redis.set(k('failures'), '5');
    await redis.set(k('open'), 'OPEN', 'EX', 60);
    expect(await cb.tryAcquireProbe(dest)).toBeNull();
    await redis.del(k('open'));
    const [a, b] = await Promise.all([cb.tryAcquireProbe(dest), cb.tryAcquireProbe(dest)]);
    const owner = a ?? b;
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await redis.get(k('probe'))).toBe(owner);
    const pttl = await redis.ttl(k('probe'));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(30);
    await cb.releaseProbe(dest, 'không-phải-chủ');
    expect(await redis.get(k('probe'))).toBe(owner);
    await cb.releaseProbe(dest, owner);
    expect(await redis.exists(k('probe'))).toBe(0);
  });

  it('review #2: getState(dest, rps) — MỘT EVAL đọc circuit + tăng throttle; OPEN không tiêu RPS (Redis thật)', async () => {
    while (Date.now() % 1000 > 600) await new Promise((r) => setTimeout(r, 20));
    await redis.del(k('failures'), k('open'), k('probe'));
    expect(await cb.getState(dest, 2)).toEqual({ state: 'CLOSED', failures: 0, throttleAllowed: true, throttleCount: 1 });
    expect((await cb.getState(dest, 2)).throttleAllowed).toBe(true);
    expect((await cb.getState(dest, 2)).throttleAllowed).toBe(false);
    const tk = `throttle:destination:${dest}:${Math.floor(Date.now() / 1000)}`;
    expect(Number(await redis.ttl(tk))).toBeGreaterThan(0);
    await redis.set(k('open'), 'OPEN', 'EX', 60);
    await redis.set(k('failures'), '5');
    const open = await cb.getState(dest, 2);
    expect(open).toMatchObject({ state: 'OPEN', failures: 5 });
    expect(open.openPttlMs).toBeGreaterThan(50_000); // BP2 §6: PTTL thật của :open
    expect(open.openPttlMs).toBeLessThanOrEqual(60_000);
    expect(open.throttleCount).toBeUndefined(); // OPEN không tiêu RPS
    await redis.del(k('open'), k('failures'), tk);
    // không trần (rps 0) -> không tạo khoá throttle
    const tk0 = `throttle:destination:${dest}:${Math.floor(Date.now() / 1000)}`;
    expect(await cb.getState(dest, 0)).toEqual({ state: 'CLOSED', failures: 0 });
    expect(await redis.exists(tk0)).toBe(0);
  });

  it('BP2 §6 LUA_GATE trên Redis THẬT: CLOSED (không trần -> không khoá throttle), throttle, OPEN (+PTTL), HALF_OPEN giành/không giành probe — mỗi gate đúng 1 lệnh', async () => {
    while (Date.now() % 1000 > 600) await new Promise((r) => setTimeout(r, 20));
    await redis.del(k('failures'), k('open'), k('probe'));
    const sec = Math.floor(Date.now() / 1000);
    const tk = `throttle:destination:${dest}:${sec}`;
    await redis.del(tk);
    // CLOSED, rps 0 -> không INCR
    expect(await cb.getState(dest, 0)).toEqual({ state: 'CLOSED', failures: 0 });
    expect(await redis.exists(tk)).toBe(0);
    // CLOSED, rps 1 -> INCR; lần 2 vượt
    expect(await cb.getState(dest, 1)).toEqual({ state: 'CLOSED', failures: 0, throttleAllowed: true, throttleCount: 1 });
    expect(await cb.getState(dest, 1)).toMatchObject({ throttleAllowed: false, throttleCount: 2 });
    // TTL cửa sổ throttle = ARGV[3] = 2s (bắt lỗi đảo thứ tự ARGV rps/TTL: khi đó TTL = rps = 1s)
    expect(await redis.pttl(tk)).toBeGreaterThan(1000);
    // recheckThrottle với rps thật lớn hơn: so lại bộ đếm, KHÔNG INCR thêm
    const v = await cb.getState(dest, 1); // count 3
    expect(await cb.recheckThrottle(dest, v, 10)).toMatchObject({ throttleAllowed: true, throttleCount: 3 });
    expect(await redis.get(tk)).toBe('3');
    // ngưỡng lỗi chưa đủ nhưng có failures -> vẫn CLOSED, failures đọc đúng
    await redis.set(k('failures'), '2');
    expect(await cb.getState(dest, 0)).toEqual({ state: 'CLOSED', failures: 2 });
    // OPEN: PTTL thật, không INCR throttle
    await redis.set(k('failures'), '5');
    await redis.set(k('open'), 'OPEN', 'EX', 60);
    const before = await redis.get(tk);
    const open = await cb.getState(dest, 1);
    expect(open).toMatchObject({ state: 'OPEN', failures: 5 });
    expect(open.openPttlMs).toBeGreaterThan(55_000);
    expect(await redis.get(tk)).toBe(before);
    // OPEN mà failures = 0 (vd. :failures đã hết hạn) -> vẫn KHÔNG INCR throttle (bắt đột biến bỏ `not open`)
    await redis.del(k('failures'));
    expect(await cb.getState(dest, 1)).toMatchObject({ state: 'OPEN', failures: 0 });
    expect(await redis.get(tk)).toBe(before);
    await redis.set(k('failures'), '5');
    // HALF_OPEN: hết :open, :failures còn (= ngưỡng) -> giành probe đúng một bên; gate KHÔNG INCR throttle (bắt đột biến `<` -> `<=`)
    await redis.del(k('open'));
    expect(await cb.getState(dest, 1)).toEqual({ state: 'HALF_OPEN', failures: 5 });
    expect(await redis.get(tk)).toBe(before);
    const t1 = await cb.tryAcquireProbe(dest);
    expect(t1).toEqual(expect.any(String));
    expect(await cb.tryAcquireProbe(dest)).toBeNull();
    // ADR-233: probe đang bị giữ -> gate (vẫn 1 lệnh) báo probeHeld, bên thua khỏi gọi tryAcquireProbe
    expect(await cb.getState(dest, 1)).toEqual({ state: 'HALF_OPEN', failures: 5, probeHeld: true });
    await cb.releaseProbe(dest, t1);
    expect(await cb.getState(dest, 1)).toEqual({ state: 'HALF_OPEN', failures: 5 }); // nhả -> trống, giành lại được
    // OPEN thì không báo probeHeld (dù khoá :probe còn sót)
    await redis.set(k('probe'), 'x', 'EX', 30);
    await redis.set(k('open'), 'OPEN', 'EX', 60);
    expect((await cb.getState(dest, 1)).probeHeld).toBeUndefined();
    await redis.del(k('failures'), k('open'), k('probe'), tk);
  });

  it('[BP:T12] (phần c) Redis THẬT: trip lần đầu OPEN 60s; probe thất bại -> OPEN 300s, :failures/:trips sống quá :open, gate trả PTTL ~300s; probe thành công xoá cả :trips', async () => {
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'));
    const t = { destinationId: dest, tenantId: 'tenant-1', persistedState: 'CLOSED' as const };
    for (let i = 0; i < 5; i++) await cb.recordFailure(t, await cb.getState(dest));
    const p1 = await redis.pttl(k('open'));
    expect(p1).toBeGreaterThan(55_000);
    expect(p1).toBeLessThanOrEqual(60_000);
    expect(await redis.exists(k('trips'))).toBe(0);
    // :open hết hạn -> HALF_OPEN -> probe thất bại
    await redis.del(k('open'));
    const half = await cb.getState(dest);
    expect(half.state).toBe('HALF_OPEN');
    const token = await cb.tryAcquireProbe(dest);
    expect(token).toEqual(expect.any(String));
    const warn = jest.spyOn(logger, 'warn');
    const after = await cb.recordFailure(t, half);
    expect(after).toMatchObject({ state: 'OPEN', openPttlMs: 300_000 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ trips: 1, openSeconds: 300 }), expect.any(String)); // TH-2, Redis thật
    warn.mockRestore();
    const p2 = await redis.pttl(k('open'));
    expect(p2).toBeGreaterThan(295_000);
    expect(await redis.ttl(k('failures'))).toBeGreaterThan(300);
    expect(await redis.ttl(k('trips'))).toBeGreaterThan(300);
    expect(await redis.get(k('trips'))).toBe('1');
    expect(await redis.exists(k('probe'))).toBe(0);
    const g = await cb.getState(dest);
    expect(g.state).toBe('OPEN');
    expect(g.openPttlMs).toBeGreaterThan(290_000);
    // hồi phục: probe thành công -> xoá 4 khoá
    await redis.del(k('open'));
    await cb.tryAcquireProbe(dest);
    await cb.recordSuccess(t, await cb.getState(dest));
    expect(await redis.exists(k('failures'), k('open'), k('probe'), k('trips'))).toBe(0);
  });

  it('[BP:T15] (phần c) Redis THẬT: probe thành công đặt :ramp (EX 70 = ramp 60s + bậc kẹp 10s, F3) trong MỘT lệnh; gate theo ramp cho tối đa 2/s rồi 4/s; mất :ramp -> gửi bình thường (BB-2)', async () => {
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'), k('ramp'));
    await redis.set(k('failures'), '5'); // HALF_OPEN
    const t = { destinationId: dest, tenantId: 'tenant-1', persistedState: 'HALF_OPEN' as const };
    const token = await cb.tryAcquireProbe(dest);
    expect(token).toEqual(expect.any(String));
    await cb.recordSuccess(t, await cb.getState(dest));
    expect(await redis.exists(k('failures'), k('open'), k('probe'), k('trips'))).toBe(0);
    const ttl = await redis.ttl(k('ramp'));
    expect(ttl).toBeGreaterThan(65);
    expect(ttl).toBeLessThanOrEqual(70);
    const start = Number(await redis.get(k('ramp')));
    const real = Date.now;
    try {
      for (const [offset, cap] of [[3_000, 2], [13_000, 4], [23_000, 8]] as const) {
        jest.spyOn(Date, 'now').mockImplementation(() => start + offset);
        let ok = 0;
        for (let i = 0; i < 12; i++) if ((await cb.getState(dest, 0)).throttleAllowed !== false) ok++;
        expect(ok).toBe(cap);
        jest.restoreAllMocks();
      }
    } finally {
      Date.now = real;
    }
    // review BP4 TH-1 (Redis thật): mốc :ramp ở tương lai 30s (lệch đồng hồ giữa worker) -> cap = start (2), không phải 1
    await redis.set(k('ramp'), String(Date.now() + 30_000), 'EX', 60);
    expect((await cb.getState(dest, 0)).rampCap).toBe(2);
    await redis.del(k('ramp'));
    expect(await cb.getState(dest, 0)).toEqual({ state: 'CLOSED', failures: 0 }); // không trần -> không INCR, gửi bình thường
  });

  it('[BP:T16] (phần a) mô phỏng trên Redis THẬT: 500 message hoãn dội về ngay khi hồi phục, mỗi giây 60s — không giây nào vượt trần ramp (2,4,8,…,64)', async () => {
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'), k('ramp'));
    const start = 1_900_000_000_000;
    await redis.set(k('ramp'), String(start), 'EX', 60);
    let backlog = 500;
    const sent: number[] = [];
    try {
      for (let sec = 0; sec < 60 && backlog > 0; sec++) {
        jest.spyOn(Date, 'now').mockImplementation(() => start + sec * 1000 + 500);
        let ok = 0;
        // mỗi giây cả hàng còn lại thử (như prefetch × worker dội về), phần vượt quay lại retry.10s
        for (let i = 0; i < Math.min(backlog, 80); i++) if ((await cb.getState(dest, 0)).throttleAllowed !== false) ok++;
        const cap = 2 * 2 ** Math.floor(sec / 10);
        expect(ok).toBeLessThanOrEqual(cap);
        sent.push(ok);
        backlog -= ok;
        jest.restoreAllMocks();
      }
    } finally {
      jest.restoreAllMocks();
      await redis.del(k('ramp'));
    }
    expect(sent[0]).toBe(2);
    expect(sent[10]).toBe(4);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(500 - backlog);
  });

  /**
   * Mô phỏng ramp theo ĐỒNG HỒ GIẢ trên Redis THẬT (ADR-234). TTL thật của `:ramp` không trôi theo đồng hồ giả, nên test giữ
   * "hạn ảo" `virtExp`: trước mỗi giây đặt PTTL thật = virtExp − now (lệnh của TEST, không thuộc ngân sách), sau giây đó PTTL
   * tăng = gate vừa gia hạn trong script -> virtExp = now + PTTL. now ≥ virtExp -> xoá khoá (= hết hạn).
   * `arrivals(sec)` = số lần gate trong giây đó; phần bị chặn quay lại sau 10s nếu `requeue` (nhịp retry.10s).
   */
  async function simulateRamp(start: number, arrivals: (sec: number) => number, o: { requeue: boolean; maxSec: number; env?: Record<string, string> }) {
    const env = o.env ?? {};
    const keySeconds = deliveryRampKeySeconds(deliveryRampConfig(env));
    await redis.set(k('ramp'), String(start), 'EX', keySeconds);
    let virtExp = start + keySeconds * 1000;
    let expiredAt: number | null = null;
    const due = new Map<number, number>();
    const perSec: { sec: number; n: number; ok: number; cap: number | null }[] = [];
    const exps: number[] = [];
    /** PTTL thật của :ramp trước / sau các lần gate trong giây (Lua thật) — kiểm guard "không rút ngắn". */
    const pttls: { sec: number; before: number; after: number }[] = [];
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      for (let sec = 0; sec < o.maxSec; sec++) {
        const now = start + sec * 1000 + 500;
        if (expiredAt === null && now >= virtExp) {
          await redis.del(k('ramp'));
          expiredAt = virtExp;
        }
        const n = arrivals(sec) + (due.get(sec) ?? 0);
        if (n === 0) continue;
        let pBefore = -2;
        if (expiredAt === null) {
          await redis.pexpire(k('ramp'), virtExp - now);
          pBefore = await redis.pttl(k('ramp'));
        }
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        let ok = 0;
        let cap: number | null = null;
        for (let i = 0; i < n; i++) {
          const v = await cb.getState(dest, 0);
          if (v.rampCap !== undefined) cap = v.rampCap;
          if (v.throttleAllowed !== false) ok++;
        }
        jest.restoreAllMocks();
        if (expiredAt === null) {
          const pAfter = await redis.pttl(k('ramp'));
          pttls.push({ sec, before: pBefore, after: pAfter });
          if (pAfter > pBefore) {
            virtExp = now + pAfter;
            exps.push(virtExp);
          }
        }
        perSec.push({ sec, n, ok, cap });
        if (o.requeue && n - ok > 0) due.set(sec + 10, (due.get(sec + 10) ?? 0) + (n - ok));
      }
    } finally {
      jest.restoreAllMocks();
      for (const [key, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[key];
        else process.env[key] = v;
      }
      await redis.del(k('ramp'));
    }
    return { perSec, expiredAt, virtExp, exps, pttls };
  }

  it('F3 (ADR-232 + ADR-234) trên Redis THẬT: 500 message hoãn dội về theo nhịp retry.10s (dồn 1 giây/vòng như chaos đo lại, và rải 2 giây/vòng) — gate gia hạn :ramp ở bậc cuối tới khi hàng hết; KHÔNG giây nào vượt 64, 500/500 trước RAMP_MAX', async () => {
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'), k('ramp'));
    expect(deliveryRampKeySeconds(deliveryRampConfig({}))).toBe(70);
    // Mô hình "dồn 1 giây/vòng" (chaos [BP:T16] đo lại, ADR-232): trước ADR-234 còn 374 message dội về ở +70s (đo được 149/s).
    const a = await simulateRamp(1_950_000_000_000, (s) => (s === 0 ? 500 : 0), { requeue: true, maxSec: 400 });
    expect(a.perSec.reduce((x, r) => x + r.ok, 0)).toBe(500);
    for (const r of a.perSec) expect(r.ok).toBeLessThanOrEqual(64);
    expect(a.perSec.map((r) => r.ok)).toEqual([2, 4, 8, 16, 32, 64, 64, 64, 64, 64, 64, 54]);
    expect(a.perSec.at(-1)!.sec).toBe(110); // hàng hết TRONG ramp (gia hạn), trước RAMP_MAX
    expect(a.virtExp).toBeLessThanOrEqual(1_950_000_000_000 + 180_000);
    // Mô hình cũ "rải 2 giây/vòng": phần dư ở bậc cuối cũng xả trong ramp
    const b = await simulateRamp(1_960_000_000_000, (s) => (s <= 1 ? 250 : 0), { requeue: true, maxSec: 400 });
    expect(b.perSec.reduce((x, r) => x + r.ok, 0)).toBe(500);
    for (const r of b.perSec) expect(r.ok).toBeLessThanOrEqual(64);
    expect(b.perSec.map((r) => r.ok)).toEqual([2, 2, 4, 4, 8, 8, 16, 16, 32, 32, 64, 64, 64, 64, 60, 60]);
  });

  it('[BP:T16] (phần c) ADR-234 L1 Redis THẬT: lưu lượng ĐỀU 100 rps — trần 2..64 rồi giữ 64 nhờ gia hạn ở bậc cuối, ramp hết ĐÚNG ở RAMP_MAX (180s) dù vẫn bị chặn; lưu lượng thấp (10 rps) không gia hạn -> hết ở 70s', async () => {
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'), k('ramp'));
    const start = 1_970_000_000_000;
    const RAMP_MAX = deliveryRampConfig({}).maxSeconds;
    expect(RAMP_MAX).toBe(180);
    const s = await simulateRamp(start, () => 100, { requeue: false, maxSec: RAMP_MAX + 5 });
    for (const r of s.perSec) {
      const cap = deliveryRampCapAt(deliveryRampConfig({}), r.sec * 1000 + 500);
      if (r.sec < RAMP_MAX) {
        expect({ sec: r.sec, ok: r.ok, cap: r.cap }).toEqual({ sec: r.sec, ok: cap, cap });
      } else {
        expect({ sec: r.sec, ok: r.ok, cap: r.cap }).toEqual({ sec: r.sec, ok: 100, cap: null }); // hết ramp: gửi bình thường
      }
    }
    // hạn khoá: gia hạn liên tục ở bậc cuối nhưng KHÔNG BAO GIỜ quá rampStart + RAMP_MAX (PEXPIRE kẹp, không chỉ guard trong gate)
    expect(s.exps.length).toBeGreaterThan(100);
    for (const e of s.exps) expect(e).toBeLessThanOrEqual(start + RAMP_MAX * 1000);
    expect(s.expiredAt).toBeGreaterThan(start + (RAMP_MAX - 1) * 1000);
    expect(s.expiredAt).toBeLessThanOrEqual(start + RAMP_MAX * 1000);
    // lưu lượng 10 rps (< 64 ở bậc cuối): không bị chặn ở bậc cuối -> không gia hạn, khoá hết đúng 70s như ADR-232
    const low = await simulateRamp(start + 1_000_000, () => 10, { requeue: false, maxSec: 75 });
    expect(low.exps).toEqual([]);
    expect(low.expiredAt).toBe(start + 1_000_000 + 70_000);
  });

  it('[BP:T16] (phần d) review F3 TB-1 — Lua THẬT, DELIVERY_RAMP_STEP_SECONDS=1, 100 rps đều: trần 2..64 (≤ 5 lần nhân đôi), guard "không rút ngắn" giữ khoá gốc 61s (không cắt còn 11s), gia hạn chỉ từ khi PTTL < 11s, ramp hết ở RAMP_MAX; `:ramp` hỏng -> không ramp', async () => {
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'), k('ramp'));
    const env = { DELIVERY_RAMP_STEP_SECONDS: '1' };
    const cfg = deliveryRampConfig(env);
    expect(cfg).toMatchObject({ stepSeconds: 1, seconds: 60, maxSeconds: 180 });
    expect(deliveryRampKeySeconds(cfg)).toBe(61);
    expect(deliveryRampExtendMs(cfg)).toBe(11_000);
    const start = 1_980_000_000_000;
    const s = await simulateRamp(start, () => 100, { requeue: false, maxSec: cfg.maxSeconds + 3, env });
    for (const r of s.perSec) {
      if (r.sec < cfg.maxSeconds) {
        const cap = deliveryRampCapAt(cfg, r.sec * 1000 + 500);
        expect({ sec: r.sec, ok: r.ok, cap: r.cap }).toEqual({ sec: r.sec, ok: cap, cap });
      } else {
        expect({ sec: r.sec, ok: r.ok, cap: r.cap }).toEqual({ sec: r.sec, ok: 100, cap: null });
      }
    }
    expect(Math.max(...s.perSec.map((r) => r.ok).slice(0, cfg.maxSeconds))).toBe(64); // Thấp-9: không phải 2 × 2^20
    // guard: bị chặn ở bậc cuối từ giây 5 nhưng PTTL (≈ 61s − el) > 11s -> Lua KHÔNG PEXPIRE; không giây nào PTTL bị rút ngắn
    for (const p of s.pttls) expect({ sec: p.sec, shortened: p.after < p.before - 200 }).toEqual({ sec: p.sec, shortened: false });
    const firstExt = s.pttls.find((p) => p.after > p.before);
    expect(firstExt?.sec).toBe(50); // PTTL 10,5s < 11s lần đầu ở giây 50
    for (const e of s.exps) expect(e).toBeLessThanOrEqual(start + cfg.maxSeconds * 1000);
    expect(s.expiredAt).toBeGreaterThan(start + (cfg.maxSeconds - 1) * 1000);
    expect(s.expiredAt).toBeLessThanOrEqual(start + cfg.maxSeconds * 1000);
    // review F3 Thấp-6: `:ramp` hỏng -> el rất lớn > RAMP_MAX -> gửi bình thường, không INCR, không gia hạn
    await redis.set(k('ramp'), 'hong', 'EX', 60);
    expect(await cb.getState(dest, 0)).toEqual({ state: 'CLOSED', failures: 0 });
    expect(await redis.pttl(k('ramp'))).toBeLessThanOrEqual(60_000);
    await redis.del(k('ramp'));
  });

  it('BP2 §6 LUA_GATE: Redis LỖI (cổng chết) -> fail-open CLOSED degraded, không ném', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on('error', () => {});
    const cbDead = new CircuitBreakerService(fakePrisma().prisma, dead);
    expect(await cbDead.getState(dest, 5)).toEqual({ state: 'CLOSED', failures: 0, degraded: true });
    dead.disconnect();
  });

  it('throttle dùng cùng script INCR+EXPIRE', async () => {
    // Sang hẳn một giây MỚI rồi mới đếm (cửa sổ cố định 1s): ca [BP:T15] (phần c) ở trên INCR khoá throttle của giây hiện tại
    // (mốc :ramp tương lai) — cùng giây thì lần đầu đã thấy count > 1 (chập chờn khi file chạy nhanh).
    const s0 = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === s0) await new Promise((r) => setTimeout(r, 10));
    expect(await cb.checkThrottle(dest, 2)).toBe(true);
    expect(await cb.checkThrottle(dest, 2)).toBe(true);
    expect(await cb.checkThrottle(dest, 2)).toBe(false);
  });
});
