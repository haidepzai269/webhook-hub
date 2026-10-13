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
} from '../src/circuit/circuit-breaker.service';
import { describeDb } from '../../../libs/database/test/support/test-db';
import { circuitOpenMaxSeconds } from '@hub/messaging';
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
        // BP2 §6: KEYS open, failures, throttle; ARGV ngưỡng, rps, TTL. INCR chỉ khi CLOSED và rps > 0.
        const [open, failures, throttle] = keys;
        let t = -1;
        if (!store.has(open) && parseInt(store.get(failures) ?? '0', 10) < Number(argv[0]) && Number(argv[1]) > 0) {
          t = parseInt(store.get(throttle) ?? '0', 10) + 1;
          store.set(throttle, String(t));
        }
        return [store.has(open) ? 1 : 0, store.get(failures) ?? '', store.has(open) ? 60_000 : -2, t];
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

  it('probe thành công -> CLOSED, xoá :failures :open :probe bằng MỘT lệnh DEL', async () => {
    const redis = fakeRedis();
    const { prisma, db } = fakePrisma({ [DEST]: 'HALF_OPEN' });
    const cb = new CircuitBreakerService(prisma, redis);
    redis.store.set(K('failures'), '5');
    expect(await cb.tryAcquireProbe(DEST)).toEqual(expect.any(String));
    const view = await cb.getState(DEST);
    redis.calls.length = 0;

    expect(await cb.recordSuccess(target('HALF_OPEN'), view)).toBe('CLOSED');
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(K('failures'), K('open'), K('probe'), K('trips')); // BP3: + :trips, vẫn MỘT lệnh
    expect(redis.store.size).toBe(0);
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
    await redis.del(k('failures'), k('open'), k('probe'), k('trips'), `throttle:destination:${dest}:${Math.floor(Date.now() / 1000)}`);
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
    await cb.releaseProbe(dest, t1);
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

  it('BP2 §6 LUA_GATE: Redis LỖI (cổng chết) -> fail-open CLOSED degraded, không ném', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on('error', () => {});
    const cbDead = new CircuitBreakerService(fakePrisma().prisma, dead);
    expect(await cbDead.getState(dest, 5)).toEqual({ state: 'CLOSED', failures: 0, degraded: true });
    dead.disconnect();
  });

  it('throttle dùng cùng script INCR+EXPIRE', async () => {
    // tránh rơi đúng ranh giới giây (cửa sổ cố định 1s)
    while (Date.now() % 1000 > 600) await new Promise((r) => setTimeout(r, 20));
    expect(await cb.checkThrottle(dest, 2)).toBe(true);
    expect(await cb.checkThrottle(dest, 2)).toBe(true);
    expect(await cb.checkThrottle(dest, 2)).toBe(false);
  });
});
