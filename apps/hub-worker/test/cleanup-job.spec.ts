import {
  CleanupJob,
  CLEANUP_BATCH,
  CLEANUP_LOCK_KEY,
  TOTAL_RETRY_WINDOW_MS,
  DEFAULT_RETENTION_DAYS,
  assertRetentionSafe,
  resolveRetentionDays,
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
    const prisma: any = { $executeRaw: jest.fn() };
    const job = new CleanupJob(prisma, buildRedis(null));
    const result = await job.runOnce();
    expect(result.skipped).toBe(true);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('Redis lỗi khi giành khoá -> bỏ lượt, không DELETE', async () => {
    const prisma: any = { $executeRaw: jest.fn() };
    const redis = buildRedis(null);
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await new CleanupJob(prisma, redis).runOnce();
    expect(result.skipped).toBe(true);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('[AF:#21] MS-P2-6: giành được khoá (SET NX EX ~0,9 chu kỳ) -> xoá theo lô tới khi một lô < 5000, KHÔNG nhả khoá', async () => {
    const prisma: any = {
      // outbox: 5000 rồi 12 (2 lô) · processed: 3 · raw REJECTED: 0
      $executeRaw: jest.fn().mockResolvedValueOnce(CLEANUP_BATCH).mockResolvedValueOnce(12).mockResolvedValueOnce(3).mockResolvedValueOnce(0),
      deleteExpiredEventsBatch: jest.fn().mockResolvedValue(0),
      identity: () => ({ deleteExpiredSessionsBatch: jest.fn().mockResolvedValue(0), deleteExpiredEmailTokensBatch: jest.fn().mockResolvedValue(0) }),
    };
    const redis = buildRedis('OK');
    const result = await new CleanupJob(prisma, redis).runOnce();

    // MS-P2-6: lock giữ ~90% chu kỳ (mặc định 1h -> 3240s) và KHÔNG nhả khi xong -> N worker = 1 lượt/chu kỳ
    expect(redis.set).toHaveBeenCalledWith(CLEANUP_LOCK_KEY, expect.any(String), 'EX', 3240, 'NX');
    expect(result).toEqual({ skipped: false, outbox: CLEANUP_BATCH + 12, processedMessages: 3, rejectedRawEvents: 0, events: 0, authSessions: 0, emailTokens: 0 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
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
      $executeRaw: jest.fn().mockResolvedValue(0),
      deleteExpiredEventsBatch: jest.fn().mockResolvedValue(0),
      identity: () => ({ deleteExpiredSessionsBatch: sessions, deleteExpiredEmailTokensBatch: tokens }),
    };
    const result = await new CleanupJob(prisma, buildRedis('OK')).runOnce();
    expect(result).toMatchObject({ authSessions: CLEANUP_BATCH + 4, emailTokens: 2 });
    expect(sessions).toHaveBeenCalledWith(30, CLEANUP_BATCH);
    expect(tokens).toHaveBeenCalledWith(7, CLEANUP_BATCH);
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

