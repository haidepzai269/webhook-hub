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

  it('giành được khoá (SET NX EX 300) -> xoá theo lô tới khi một lô < 5000, rồi nhả khoá của mình', async () => {
    const prisma: any = {
      // outbox: 5000 rồi 12 (2 lô) · processed: 3 · raw REJECTED: 0
      $executeRaw: jest.fn().mockResolvedValueOnce(CLEANUP_BATCH).mockResolvedValueOnce(12).mockResolvedValueOnce(3).mockResolvedValueOnce(0),
    };
    const redis = buildRedis('OK');
    const result = await new CleanupJob(prisma, redis).runOnce();

    expect(redis.set).toHaveBeenCalledWith(CLEANUP_LOCK_KEY, expect.any(String), 'EX', 300, 'NX');
    expect(result).toEqual({ skipped: false, outbox: CLEANUP_BATCH + 12, processedMessages: 3, rejectedRawEvents: 0 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, CLEANUP_LOCK_KEY, expect.any(String));
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
});
