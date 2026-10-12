import { logger } from '@hub/common';
import {
  STORAGE_CALIBRATE_LOCK_KEY,
  STORAGE_LEVEL_LOCK_KEY,
  STORAGE_MEASURE_STATEMENT_TIMEOUT_MS,
  STORAGE_MEASURE_TX_TIMEOUT_MS,
  StorageJob,
  isStorageMeasureTimeout,
} from '../src/scheduler/storage.job';
import { storageCalibrations, workerRegistry } from '../src/metrics';

const MB = 1024 * 1024;

/** Redis giả dùng chung cho nhiều instance: SET NX EX đúng ngữ nghĩa (khoá còn hạn thì trả null). */
function sharedRedis() {
  const keys = new Map<string, string>();
  return {
    keys,
    set: jest.fn(async (k: string, v: string, _ex: string, _ttl: number, nx: string) => {
      if (nx === 'NX' && keys.has(k)) return null;
      keys.set(k, v);
      return 'OK';
    }),
    on: jest.fn(),
    quit: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
  } as any;
}

function tickRow(o: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: 't-a',
    usedBytes: 0,
    level: 'OK',
    calibratedBytes: 0,
    calibratedAt: new Date(),
    calibratedAtToken: '2026-10-12 08:00:00.123456+00',
    freedSinceCalibration: 0,
    bloatFactor: 2,
    quotaMb: 1,
    trafficBytesSinceCalibration: 0,
    ...o,
  };
}

function fakePrisma(rows: any[], extra: Record<string, unknown> = {}) {
  const updates: { tenantId: string; usedBytes: number; level: string; calibratedAtToken?: string | null }[] = [];
  const prisma: any = {
    // tenantTx thật mở transaction tương tác; ở đây chỉ chuyển `tx` giả vào fn (đủ để kiểm options truyền xuống)
    tenantTx: jest.fn(async (tenantId: string, fn: (tx: any) => Promise<unknown>, _opts?: unknown) => fn({ __tx: tenantId })),
    storageLevelTickAcrossTenants: jest.fn(async () => rows),
    storageProjectsDueForCalibrationAcrossTenants: jest.fn(async () => []),
    databaseSizeBytes: jest.fn(async () => 100 * MB),
    forTenant: (tenantId: string) => ({
      updateStorageUsage: jest.fn(async (m: any) => {
        updates.push({ tenantId, ...m });
        return 1;
      }),
    }),
    ...extra,
  };
  return { prisma, updates };
}

describe('QT2 StorageJob (E2, §6)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.PROJECT_STORAGE_QUOTA_MB;
    delete process.env.DB_DISK_BUDGET_MB;
  });
  afterAll(() => {
    process.env = env;
  });

  it('[QT:T12] (phần a) hai worker đo song song chỉ một lượt chạy (khoá SET NX EX ~0,9 chu kỳ, không nhả); Redis lỗi -> bỏ lượt, không đọc DB', async () => {
    const redis = sharedRedis();
    const a = fakePrisma([tickRow()]);
    const b = fakePrisma([tickRow()]);
    const [ra, rb] = await Promise.all([new StorageJob(a.prisma, redis).runLevelOnce(), new StorageJob(b.prisma, redis).runLevelOnce()]);
    expect([ra.skipped, rb.skipped].sort()).toEqual([false, true]);
    expect(a.prisma.storageLevelTickAcrossTenants.mock.calls.length + b.prisma.storageLevelTickAcrossTenants.mock.calls.length).toBe(1);
    expect(redis.set).toHaveBeenCalledWith(STORAGE_LEVEL_LOCK_KEY, expect.any(String), 'EX', 54, 'NX'); // 60s × 0,9

    const [ca, cb] = await Promise.all([new StorageJob(a.prisma, redis).runCalibrateOnce(), new StorageJob(b.prisma, redis).runCalibrateOnce()]);
    expect([ca.skipped, cb.skipped].sort()).toEqual([false, true]);
    expect(redis.set).toHaveBeenCalledWith(STORAGE_CALIBRATE_LOCK_KEY, expect.any(String), 'EX', 3240, 'NX'); // kiểm mỗi giờ × 0,9

    const broken = sharedRedis();
    broken.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const c = fakePrisma([tickRow()]);
    expect((await new StorageJob(c.prisma, broken).runLevelOnce()).skipped).toBe(true);
    expect(c.prisma.storageLevelTickAcrossTenants).not.toHaveBeenCalled();
  });

  it('[QT:T32] (phần b) lượt cập nhật nấc: used = mốc + bloat × traffic − đã giải phóng; chỉ ghi project có số đổi; đổi nấc gọi hook (lỗi hook không hỏng lượt)', async () => {
    const { prisma, updates } = fakePrisma([
      // 0,5MB mốc + 2 × 0,2MB traffic = 0,9MB / 1MB -> CRITICAL_95? 90% -> WARN_85
      tickRow({ tenantId: 't-a', calibratedBytes: 0.5 * MB, trafficBytesSinceCalibration: 0.2 * MB }),
      // không đổi gì -> không ghi
      tickRow({ tenantId: 't-b', usedBytes: 100, calibratedBytes: 100, level: 'OK' }),
      // 1,2MB − 0,1MB giải phóng = 1,1MB / 1MB -> HARD_LOCKED
      tickRow({ tenantId: 't-c', calibratedBytes: 1.2 * MB, freedSinceCalibration: 0.1 * MB, level: 'WARN_70' }),
      // LOCKED, xuống 92% -> vẫn LOCKED (vùng đệm), nhưng used đổi -> ghi lại số
      tickRow({ tenantId: 't-d', usedBytes: 1 * MB, calibratedBytes: 0.92 * MB, level: 'LOCKED' }),
    ]);
    const job = new StorageJob(prisma, sharedRedis());
    const seen: string[] = [];
    job.onLevelChange.push((c) => {
      seen.push(`${c.tenantId}:${c.from}->${c.to}`);
    });
    job.onLevelChange.push(() => {
      throw new Error('hook hỏng');
    });
    const r = await job.levelTick();
    expect(r.projects).toBe(4);
    expect(updates.map((u) => [u.tenantId, u.level, u.usedBytes])).toEqual([
      ['t-a', 'WARN_85', Math.round(0.9 * MB)],
      ['t-c', 'HARD_LOCKED', Math.round(1.1 * MB)],
      ['t-d', 'LOCKED', Math.round(0.92 * MB)],
    ]);
    expect(seen).toEqual(['t-a:OK->WARN_85', 't-c:WARN_70->HARD_LOCKED']);
    expect(r.changes).toHaveLength(2);
    const metrics = await workerRegistry.getSingleMetricAsString('hub_project_storage_locked');
    expect(metrics).toMatch(/hub_project_storage_locked 2/);
  });

  it('[QT:T32] (phần c) hiệu chỉnh: quét thật đặt lại mốc (freed = 0, used = số quét, bloat = tổng/body_raw), nấc theo số quét; lỗi một project không chặn project khác', async () => {
    const saved: any[] = [];
    const { prisma } = fakePrisma([], {
      storageProjectsDueForCalibrationAcrossTenants: jest.fn(async () => ['p1', 'p2']),
      findProjectById: jest.fn(async (id: string) => ({ id, storageQuotaMb: id === 'p1' ? 1 : null })),
      forTenant: (tenantId: string) => ({
        findProjectUsage: jest.fn(async () => ({ usedBytes: BigInt(800_000), level: 'WARN_70' })),
        measureStorage: jest.fn(async () => {
          if (tenantId === 'p2') throw new Error('timeout');
          return { totalBytes: 1.05 * MB, bodyRawBytes: 0.5 * MB, bySource: { s1: 1.05 * MB } };
        }),
        saveStorageCalibration: jest.fn(async (m: any) => saved.push({ tenantId, ...m })),
      }),
    });
    const job = new StorageJob(prisma, sharedRedis());
    const r = await job.calibrateTick(['p1', 'p2']);
    expect(r).toEqual({ skipped: false, calibrated: ['p1'], failed: ['p2'] });
    expect(saved).toEqual([{ tenantId: 'p1', calibratedBytes: 1.05 * MB, bloatFactor: 2.1, bySource: { s1: 1.05 * MB }, level: 'LOCKED' }]);
    // hạn hiệu chỉnh truyền xuống truy vấn = now − min(24h, (TRAFFIC_RETENTION_DAYS−1) ngày)
    const due: Date = prisma.storageProjectsDueForCalibrationAcrossTenants.mock.calls[0][0];
    expect(Math.abs(Date.now() - 86_400_000 - due.getTime())).toBeLessThan(5_000);
  });

  it('[QT:T14] (phần b) chốt toàn cục: pg_database_size > 80% ngân sách -> hub_storage_near_full = 1; chỉ đọc lại sau 10 phút', async () => {
    process.env.DB_DISK_BUDGET_MB = '100';
    const { prisma } = fakePrisma([]);
    prisma.databaseSizeBytes.mockResolvedValue(81 * MB);
    const job = new StorageJob(prisma, sharedRedis());
    let now = 1_000_000;
    job.clock = () => now;
    const r1 = await job.levelTick();
    expect(r1.disk).toEqual({ sizeBytes: 81 * MB, nearFull: true });
    expect(await workerRegistry.getSingleMetricAsString('hub_storage_near_full')).toMatch(/hub_storage_near_full 1/);
    now += 60_000;
    expect((await job.levelTick()).disk).toBeUndefined();
    expect(prisma.databaseSizeBytes).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    prisma.databaseSizeBytes.mockResolvedValue(10 * MB);
    expect((await job.levelTick()).disk).toEqual({ sizeBytes: 10 * MB, nearFull: false });
    expect(await workerRegistry.getSingleMetricAsString('hub_storage_near_full')).toMatch(/hub_storage_near_full 0/);
  });

  it('[QT:T32] (phần e) quét thật chạy trong tenantTx có hạn rõ ràng (60s, không phải 5s mặc định) + statement_timeout cục bộ; quá hạn -> metric result="timeout", log, job không chết (review M2)', async () => {
    const measureOpts: unknown[] = [];
    const clients: unknown[] = [];
    const warn = jest.spyOn(logger, 'warn').mockImplementation((() => undefined) as any);
    const { prisma } = fakePrisma([], {
      storageProjectsDueForCalibrationAcrossTenants: jest.fn(async () => ['big', 'small']),
      findProjectById: jest.fn(async (id: string) => ({ id, storageQuotaMb: 1 })),
      forTenant: (tenantId: string, client?: unknown) => ({
        findProjectUsage: jest.fn(async () => null),
        measureStorage: jest.fn(async (o: unknown) => {
          measureOpts.push(o);
          clients.push(client);
          if (tenantId === 'big') throw Object.assign(new Error('canceling statement due to statement timeout'), { code: 'P2010', meta: { code: '57014' } });
          return { totalBytes: 10, bodyRawBytes: 10, bySource: {} };
        }),
        saveStorageCalibration: jest.fn(async () => 1),
      }),
    });
    const count = async (result: string) => (await storageCalibrations.get()).values.find((v) => v.labels.result === result)?.value ?? 0;
    const [timeout0, error0] = [await count('timeout'), await count('error')];
    try {
      const r = await new StorageJob(prisma, sharedRedis()).calibrateTick(['big', 'small']);
      expect(r).toEqual({ skipped: false, calibrated: ['small'], failed: ['big'] });
      // tenantTx(tenantId, fn, { timeout: 60s, maxWait }) — repo dựng trên tx của chính transaction đó
      expect(prisma.tenantTx).toHaveBeenCalledWith('big', expect.any(Function), expect.objectContaining({ timeout: STORAGE_MEASURE_TX_TIMEOUT_MS, maxWait: expect.any(Number) }));
      expect(STORAGE_MEASURE_TX_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
      expect(STORAGE_MEASURE_STATEMENT_TIMEOUT_MS).toBeLessThan(STORAGE_MEASURE_TX_TIMEOUT_MS);
      expect(measureOpts).toEqual([{ statementTimeoutMs: STORAGE_MEASURE_STATEMENT_TIMEOUT_MS }, { statementTimeoutMs: STORAGE_MEASURE_STATEMENT_TIMEOUT_MS }]);
      expect(clients).toEqual([{ __tx: 'big' }, { __tx: 'small' }]);
      expect((await count('timeout')) - timeout0).toBe(1);
      expect((await count('error')) - error0).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'big', timeout: true }), expect.stringMatching(/quá hạn/));
    } finally {
      warn.mockRestore();
    }
    expect(isStorageMeasureTimeout({ code: 'P2028', message: 'Transaction API error' })).toBe(true);
    expect(isStorageMeasureTimeout(new Error('Transaction already closed: A query cannot be executed on an expired transaction'))).toBe(true);
    expect(isStorageMeasureTimeout(new Error('relation "hub.x" does not exist'))).toBe(false);
    expect(isStorageMeasureTimeout(null)).toBe(false);
  });

  it('[QT:T32] (phần f) ghi nấc là compare-and-set theo mốc ĐÃ ĐỌC: hiệu chỉnh xen giữa (0 dòng) -> không đếm updated, không báo đổi nấc (review L1)', async () => {
    const tokenRead = '2026-10-12 08:00:00.123456+00';
    let calibratedMeanwhile = true;
    const sent: any[] = [];
    const { prisma } = fakePrisma([tickRow({ tenantId: 't-race', calibratedBytes: 1.2 * MB, level: 'OK', calibratedAtToken: tokenRead })]);
    prisma.forTenant = () => ({
      // DB giả: hiệu chỉnh vừa ghi mốc mới -> `calibrated_at IS NOT DISTINCT FROM <token đã đọc>` không khớp -> 0 dòng
      updateStorageUsage: jest.fn(async (m: any) => {
        sent.push(m);
        return calibratedMeanwhile ? 0 : 1;
      }),
    });
    const job = new StorageJob(prisma, sharedRedis());
    const seen: string[] = [];
    job.onLevelChange.push((c) => void seen.push(`${c.from}->${c.to}`));
    const lost = await job.levelTick();
    expect(sent[0]).toMatchObject({ calibratedAtToken: tokenRead, level: 'HARD_LOCKED' });
    expect(lost).toMatchObject({ updated: 0, changes: [] });
    expect(seen).toEqual([]);
    calibratedMeanwhile = false; // không có hiệu chỉnh xen giữa -> ghi như thường
    const ok = await job.levelTick();
    expect(ok.updated).toBe(1);
    expect(seen).toEqual(['OK->HARD_LOCKED']);
  });

  it('[QT:T12] (phần b) stop() khi đang có lượt chạy dở: trả về ngay (không chờ lượt bay), không hẹn lượt mới, vòng hiệu chỉnh dừng trước project kế (review L5)', async () => {
    jest.useFakeTimers();
    try {
      let releaseLevel: () => void = () => undefined;
      let releaseMeasure: () => void = () => undefined;
      const measured: string[] = [];
      const { prisma } = fakePrisma([], {
        storageLevelTickAcrossTenants: jest.fn(() => new Promise((res) => (releaseLevel = () => res([])))),
        storageProjectsDueForCalibrationAcrossTenants: jest.fn(async () => ['p1', 'p2', 'p3']),
        findProjectById: jest.fn(async (id: string) => ({ id, storageQuotaMb: 1 })),
        forTenant: (tenantId: string) => ({
          findProjectUsage: jest.fn(async () => null),
          measureStorage: jest.fn(() => {
            measured.push(tenantId);
            return new Promise((res) => (releaseMeasure = () => res({ totalBytes: 1, bodyRawBytes: 1, bySource: {} })));
          }),
          saveStorageCalibration: jest.fn(async () => 1),
        }),
      });
      const job = new StorageJob(prisma, sharedRedis());
      job.start();
      await jest.advanceTimersByTimeAsync(91_000); // cả hai timer khởi động (≤ 15s và ≤ 90s) đã nổ, hai lượt đang treo
      expect(prisma.storageLevelTickAcrossTenants).toHaveBeenCalledTimes(1);
      expect(measured).toEqual(['p1']);
      const t0 = performance.now();
      job.stop(); // đồng bộ: không await lượt bay -> không thể kéo dài quá SHUTDOWN_TIMEOUT_MS (25s)
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(jest.getTimerCount()).toBe(0);
      releaseLevel();
      releaseMeasure();
      await jest.advanceTimersByTimeAsync(10 * 3_600_000);
      expect(measured).toEqual(['p1']); // p2, p3 để lượt sau (instance khác / lần khởi động sau)
      expect(prisma.storageLevelTickAcrossTenants).toHaveBeenCalledTimes(1); // không hẹn lượt mới sau khi tắt
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
