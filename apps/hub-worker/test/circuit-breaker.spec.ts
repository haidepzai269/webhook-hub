import Redis from 'ioredis';
import {
  CircuitBreakerService,
  CircuitTarget,
  CIRCUIT_CHANNEL,
  FAIL_OPEN_PROBE,
  LUA_ACQUIRE_PROBE,
  LUA_INCR_EXPIRE,
  LUA_RELEASE_PROBE,
} from '../src/circuit/circuit-breaker.service';

/**
 * Redis giả trong bộ nhớ, đủ cho circuit breaker: MGET, SET (EX/NX), DEL nhiều khoá, INCR, EXPIRE,
 * MULTI/EXEC, PUBLISH. Hết hạn khoá mô phỏng bằng `expireNow(key)` (không phụ thuộc đồng hồ thật).
 * `writes` đếm mọi lệnh GHI để kiểm ngân sách Redis (S3-5).
 */
function fakeRedis() {
  const store = new Map<string, string>();
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
      if (script === LUA_RELEASE_PROBE) {
        if (store.get(keys[0]) === argv[0]) return store.delete(keys[0]) ? 1 : 0;
        return 0;
      }
      throw new Error('script lạ');
    }),
    multi: jest.fn(() => {
      calls.push('multi');
      const ops: Array<() => void> = [];
      const chain: any = {
        set: (k: string, v: string) => (ops.push(() => store.set(k, v)), chain),
        del: (...ks: string[]) => (ops.push(() => ks.forEach((k) => store.delete(k))), chain),
        expire: () => chain,
        exec: async () => (ops.forEach((op) => op()), []),
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
    updateDestinationCircuitState: jest.fn(async (id: string, to: string) => {
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
  it('mặc định CLOSED, getState chỉ dùng MỘT lệnh MGET', async () => {
    const redis = fakeRedis();
    const cb = new CircuitBreakerService(fakePrisma().prisma, redis);
    expect(await cb.getState(DEST)).toEqual({ state: 'CLOSED', failures: 0 });
    expect(redis.calls).toEqual(['mget']);
  });

  it('5 lần lỗi -> OPEN; ghi DB circuit_state và publish ĐÚNG MỘT lần lên hub:realtime:circuit', async () => {
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

  it('hết TTL :open -> HALF_OPEN (suy ra, không lưu); hai worker cùng lúc chỉ MỘT giành được probe', async () => {
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
    expect(redis.del).toHaveBeenCalledWith(K('failures'), K('open'), K('probe'));
    expect(redis.store.size).toBe(0);
    expect(db.get(DEST)).toBe('CLOSED');
    expect(JSON.parse(redis.publish.mock.calls[0][1])).toMatchObject({ from: 'HALF_OPEN', to: 'CLOSED' });
  });

  it('probe thất bại -> OPEN lại ngay (không cần đủ 5 lần nữa), nhả :probe', async () => {
    const redis = fakeRedis();
    const { prisma, db } = fakePrisma({ [DEST]: 'HALF_OPEN' });
    const cb = new CircuitBreakerService(prisma, redis);
    redis.store.set(K('failures'), '5');
    await cb.tryAcquireProbe(DEST);
    const after = await cb.recordFailure(target('HALF_OPEN'), await cb.getState(DEST));
    expect(after.state).toBe('OPEN');
    expect(redis.store.get(K('open'))).toBe('OPEN');
    expect(redis.store.has(K('probe'))).toBe(false);
    expect(db.get(DEST)).toBe('OPEN');
  });

  it('gửi thành công khi failures == 0 -> 0 lệnh Redis, 0 lệnh DB', async () => {
    const redis = fakeRedis();
    const { prisma, repo } = fakePrisma();
    const cb = new CircuitBreakerService(prisma, redis);
    expect(await cb.recordSuccess(target(), { state: 'CLOSED', failures: 0 })).toBe('CLOSED');
    expect(redis.calls).toHaveLength(0);
    expect(repo.updateDestinationCircuitState).not.toHaveBeenCalled();
  });

  it('thành công khi CLOSED nhưng còn failures > 0 -> DEL bộ đếm (reset "liên tiếp"), không đổi trạng thái, không publish', async () => {
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
    expect(repo.updateDestinationCircuitState).toHaveBeenCalledWith(DEST, 'CLOSED');
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
const describeRedis = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
describeRedis('CircuitBreakerService — script Lua trên Redis THẬT (ADR-054)', () => {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  const dest = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const k = (s: string) => `circuit:${dest}:${s}`;
  const cb = new CircuitBreakerService(fakePrisma().prisma, redis);

  afterAll(async () => {
    await redis.del(k('failures'), k('open'), k('probe'), `throttle:destination:${dest}:${Math.floor(Date.now() / 1000)}`);
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

  it('throttle dùng cùng script INCR+EXPIRE', async () => {
    // tránh rơi đúng ranh giới giây (cửa sổ cố định 1s)
    while (Date.now() % 1000 > 600) await new Promise((r) => setTimeout(r, 20));
    expect(await cb.checkThrottle(dest, 2)).toBe(true);
    expect(await cb.checkThrottle(dest, 2)).toBe(true);
    expect(await cb.checkThrottle(dest, 2)).toBe(false);
  });
});
