import {
  CleanupJob,
  CLEANUP_BATCH,
  CLEANUP_LOCK_KEY,
  TOTAL_RETRY_WINDOW_MS,
  DEFAULT_RETENTION_DAYS,
  INGEST_DUPLICATES_KEEP_DAYS,
  assertRetentionSafe,
  resolveRetentionDays,
  resolveTrafficRetentionDays,
} from '../src/scheduler/cleanup.job';

/** S1-4: job dọn dẹp — khoá Redis và ràng buộc an toàn retention > tổng TTL retry. */
describe('CleanupJob (S1-4)', () => {
  function buildRedis(setResult: string | null) {
    return {
      set: jest.fn().mockResolvedValue(setResult),
      eval: jest.fn().mockResolvedValue(1),
      on: jest.fn(),
    } as any;
  }

  afterEach(() => {
    delete process.env.CLEANUP_RETENTION_DAYS;
    delete process.env.EVENT_RETENTION_DAYS;
  });

  it('không giành được khoá -> không chạy câu DELETE nào', async () => {
    const prisma: any = { systemTx(_r: any, fn: any) { return fn(this); }, $executeRaw: jest.fn() };
    const job = new CleanupJob(prisma, buildRedis(null));
    const result = await job.runOnce();
    expect(result.skipped).toBe(true);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('Redis lỗi khi giành khoá -> bỏ lượt, không DELETE', async () => {
    const prisma: any = { systemTx(_r: any, fn: any) { return fn(this); }, $executeRaw: jest.fn() };
    const redis = buildRedis(null);
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await new CleanupJob(prisma, redis).runOnce();
    expect(result.skipped).toBe(true);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('[AF:#21] MS-P2-6: giành được khoá (SET NX EX ~0,9 chu kỳ) -> xoá theo lô tới khi một lô < 5000, KHÔNG nhả khoá', async () => {
    const prisma: any = {
      // outbox: 5000 rồi 12 (2 lô) · processed: 3 · raw REJECTED: 0
      systemTx(_r: any, fn: any) { return fn(this); }, // AU6: cleanup đi qua systemTx
      $executeRaw: jest.fn().mockResolvedValueOnce(CLEANUP_BATCH).mockResolvedValueOnce(12).mockResolvedValueOnce(3).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0),
      deleteExpiredEventsBatch: jest.fn().mockResolvedValue(0),
      identity: () => ({ deleteExpiredSessionsBatch: jest.fn().mockResolvedValue(0), deleteExpiredEmailTokensBatch: jest.fn().mockResolvedValue(0) }),
    };
    const redis = buildRedis('OK');
    const result = await new CleanupJob(prisma, redis).runOnce();

    // MS-P2-6: lock giữ ~90% chu kỳ (mặc định 1h -> 3240s) và KHÔNG nhả khi xong -> N worker = 1 lượt/chu kỳ
    expect(redis.set).toHaveBeenCalledWith(CLEANUP_LOCK_KEY, expect.any(String), 'EX', 3240, 'NX');
    expect(result).toEqual({ skipped: false, outbox: CLEANUP_BATCH + 12, processedMessages: 3, rejectedRawEvents: 0, events: 0, authSessions: 0, emailTokens: 0, ingestDuplicates: 0, sourceTraffic: 0 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(6); // + ingest_duplicates (CB6) + source_traffic_minutely (EG4)
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('retention mặc định (7 ngày) > tổng TTL retry; giá trị nhỏ hơn bị từ chối lúc load', () => {
    expect(DEFAULT_RETENTION_DAYS * 86_400_000).toBeGreaterThan(TOTAL_RETRY_WINDOW_MS);
    // 10s + 1m + 5m + 30m + 2h + 5×30s
    expect(TOTAL_RETRY_WINDOW_MS).toBe(10_000 + 60_000 + 300_000 + 1_800_000 + 7_200_000 + 150_000);
    expect(() => assertRetentionSafe(0)).toThrow(/không an toàn/);
    expect(() => assertRetentionSafe(0.1)).toThrow(); // 2,4 giờ < 2h36m
    expect(() => assertRetentionSafe(1)).not.toThrow();
    process.env.CLEANUP_RETENTION_DAYS = '0';
    expect(() => resolveRetentionDays()).toThrow();
    process.env.CLEANUP_RETENTION_DAYS = '3';
    expect(resolveRetentionDays()).toBe(3);
  });

  it('[MS:T13] (phần a) S7 retention: xoá events quá N ngày theo lô qua escape hatch có tên (cascade delivery/attempt), KHÔNG đụng raw ACCEPTED', async () => {
    process.env.EVENT_RETENTION_DAYS = '9';
    const prisma: any = {
      systemTx(_r: any, fn: any) { return fn(this); }, // AU6: cleanup đi qua systemTx
      $executeRaw: jest.fn().mockResolvedValue(0),
      deleteExpiredEventsBatch: jest.fn().mockResolvedValueOnce(CLEANUP_BATCH).mockResolvedValueOnce(7),
      identity: () => ({ deleteExpiredSessionsBatch: jest.fn().mockResolvedValue(0), deleteExpiredEmailTokensBatch: jest.fn().mockResolvedValue(0) }),
    };
    const result = await new CleanupJob(prisma, buildRedis('OK')).runOnce();
    expect(result.events).toBe(CLEANUP_BATCH + 7);
    expect(prisma.deleteExpiredEventsBatch).toHaveBeenCalledWith(9 * 86_400, CLEANUP_BATCH);
    const sqls = prisma.$executeRaw.mock.calls.map((c: any) => c[0].strings.join('?'));
    expect(sqls.some((q: string) => /raw_events/.test(q) && /ACCEPTED/.test(q))).toBe(false);
  });

  it('AU2 (SPEC-auth §5.3): CÙNG job dọn auth_sessions hết hạn > 30 ngày và email_tokens hết hạn > 7 ngày, theo lô, qua IdentityRepository', async () => {
    const sessions = jest.fn().mockResolvedValueOnce(CLEANUP_BATCH).mockResolvedValueOnce(4);
    const tokens = jest.fn().mockResolvedValueOnce(2);
    const prisma: any = {
      systemTx(_r: any, fn: any) { return fn(this); }, // AU6: cleanup đi qua systemTx
      $executeRaw: jest.fn().mockResolvedValue(0),
      deleteExpiredEventsBatch: jest.fn().mockResolvedValue(0),
      identity: () => ({ deleteExpiredSessionsBatch: sessions, deleteExpiredEmailTokensBatch: tokens }),
    };
    const result = await new CleanupJob(prisma, buildRedis('OK')).runOnce();
    expect(result).toMatchObject({ authSessions: CLEANUP_BATCH + 4, emailTokens: 2 });
    expect(sessions).toHaveBeenCalledWith(30, CLEANUP_BATCH);
    expect(tokens).toHaveBeenCalledWith(7, CLEANUP_BATCH);
  });

  it('CB6 (ADR-171): CÙNG job (cùng khoá Redis) dọn ingest_duplicates có bucket quá 30 ngày, theo lô, qua systemTx', async () => {
    const prisma: any = {
      systemTx: jest.fn(function (this: any, _r: any, fn: any) { return fn(prisma); }),
      $executeRaw: jest.fn().mockResolvedValue(0),
      deleteExpiredEventsBatch: jest.fn().mockResolvedValue(0),
      identity: () => ({ deleteExpiredSessionsBatch: jest.fn().mockResolvedValue(0), deleteExpiredEmailTokensBatch: jest.fn().mockResolvedValue(0) }),
    };
    prisma.$executeRaw.mockImplementation(async (q: any) => (/ingest_duplicates/.test(q.strings.join('?')) ? (prisma.dupCalls = (prisma.dupCalls ?? 0) + 1) === 1 ? CLEANUP_BATCH : 9 : 0));
    const result = await new CleanupJob(prisma, buildRedis('OK')).runOnce();
    expect(result.ingestDuplicates).toBe(CLEANUP_BATCH + 9);
    const dup = prisma.$executeRaw.mock.calls.map((c: any) => c[0]).filter((q: any) => /ingest_duplicates/.test(q.strings.join('?')));
    expect(dup).toHaveLength(2);
    expect(dup[0].strings.join('?')).toMatch(/bucket < now\(\) - make_interval\(days => \?::int\)/);
    expect(dup[0].values).toEqual([INGEST_DUPLICATES_KEEP_DAYS, CLEANUP_BATCH]);
    expect(INGEST_DUPLICATES_KEEP_DAYS).toBe(30);
    // không có khoá -> không dọn gì (cùng nhánh SKIPPED như phần còn lại)
    const skipped = await new CleanupJob(prisma, buildRedis(null)).runOnce();
    expect(skipped).toMatchObject({ skipped: true, ingestDuplicates: 0 });
  });

  it('EG4 (ADR-179): CÙNG job dọn source_traffic_minutely có minute quá TRAFFIC_RETENTION_DAYS (mặc định 7, kẹp 1–90), theo lô, qua systemTx', async () => {
    const prisma: any = {
      systemTx: jest.fn(function (this: any, _r: any, fn: any) { return fn(prisma); }),
      $executeRaw: jest.fn().mockResolvedValue(0),
      deleteExpiredEventsBatch: jest.fn().mockResolvedValue(0),
      identity: () => ({ deleteExpiredSessionsBatch: jest.fn().mockResolvedValue(0), deleteExpiredEmailTokensBatch: jest.fn().mockResolvedValue(0) }),
    };
    prisma.$executeRaw.mockImplementation(async (q: any) => (/source_traffic_minutely/.test(q.strings.join('?')) ? (prisma.n = (prisma.n ?? 0) + 1) === 1 ? CLEANUP_BATCH : 4 : 0));
    const result = await new CleanupJob(prisma, buildRedis('OK')).runOnce();
    expect(result.sourceTraffic).toBe(CLEANUP_BATCH + 4);
    const q = prisma.$executeRaw.mock.calls.map((c: any) => c[0]).filter((x: any) => /source_traffic_minutely/.test(x.strings.join('?')));
    expect(q).toHaveLength(2);
    expect(q[0].strings.join('?')).toMatch(/minute < now\(\) - make_interval\(days => \?::int\)/);
    expect(q[0].values).toEqual([7, CLEANUP_BATCH]);
    expect([resolveTrafficRetentionDays('0'), resolveTrafficRetentionDays('abc'), resolveTrafficRetentionDays('500'), resolveTrafficRetentionDays('14')]).toEqual([1, 7, 90, 14]);
  });

  it('S7: EVENT_RETENTION_DAYS là tên chính, CLEANUP_RETENTION_DAYS là alias; giá trị không an toàn vẫn bị từ chối', () => {
    expect(resolveRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    process.env.CLEANUP_RETENTION_DAYS = '10';
    expect(resolveRetentionDays()).toBe(10);
    process.env.EVENT_RETENTION_DAYS = '3';
    expect(resolveRetentionDays()).toBe(3);
    process.env.EVENT_RETENTION_DAYS = '0';
    expect(() => resolveRetentionDays()).toThrow(/không an toàn/);
  });
});

