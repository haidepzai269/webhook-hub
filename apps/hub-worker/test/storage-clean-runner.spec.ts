import { TOTAL_RETRY_WINDOW_MS } from '@hub/messaging';
import { StorageCleanRunner, STORAGE_CLEAN_LEASE_MS, STORAGE_CLEAN_MAX_ATTEMPTS } from '../src/scheduler/storage-clean.runner';
import { CLEAN_STATEMENT_TIMEOUT_MS, CLEAN_TX_TIMEOUT_MS } from '../src/scheduler/storage-clean';

/** QT4 (SPEC-han-muc-dung-luong §5.5 + E2, ADR-184): worker chạy lệnh dọn theo lô — store giả. */
const T = 't-1';
const MB = 1024 * 1024;

function fake(batches: { events: number; rejected: number; freedBytes: number; done: boolean; level?: any }[], o: { failAt?: number; lostAt?: number } = {}) {
  const log: string[] = [];
  const txOpts: unknown[] = [];
  const recorded: any[] = [];
  const audits: any[] = [];
  const cleanArgs: any[] = [];
  let i = 0;
  const job = {
    id: 'job-1',
    tenantId: T,
    action: 'trim',
    importance: ['low'],
    olderThan: '3d',
    cutoff: new Date('2026-10-09T00:00:00Z'),
    sourceId: null,
    origin: 'manual',
    suggestionId: null,
    advisor: null,
    requestedBy: 'user-1',
    eventsAffected: 0,
    rejectedAffected: 0,
    freedBytes: 0n,
  };
  const prisma: any = {
    storageClaimCleanJobAcrossTenants: jest.fn().mockResolvedValueOnce({ id: 'job-1', tenantId: T, attempts: 3 }).mockResolvedValue(null),
    findProjectById: jest.fn(async () => ({ id: T, storageQuotaMb: 10 })),
    tenantTx: jest.fn(async (t: string, fn: any, opts: unknown) => {
      txOpts.push(opts);
      log.push(`tx:${t}`);
      return fn({ $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => log.push(`raw:${strings.join('?')}:${vals.join(',')}`)) });
    }),
    forTenant: jest.fn((_t: string, tx?: unknown) => ({
      findStorageCleanJob: jest.fn(async () => job),
      cleanStorageBatch: jest.fn(async (a: any) => {
        if (!tx) throw new Error('lô phải chạy trong transaction');
        cleanArgs.push(a);
        if (o.failAt === i) {
          i++;
          throw new Error('P1001 db mất kết nối');
        }
        return { level: null, ...batches[i++] };
      }),
      recordCleanJobBatch: jest.fn(async (id: string, r: any) => {
        if (!tx) throw new Error('tiến độ phải cùng transaction với lô');
        recorded.push({ id, ...r });
        return o.lostAt === recorded.length - 1 ? 0 : 1; // 0 dòng = fencing không khớp (lệnh đã bị nhận lại)
      }),
      createAuditLog: jest.fn(async (a: any) => {
        if (!tx) throw new Error('audit phải cùng transaction với lô cuối');
        audits.push(a);
      }),
    })),
  };
  return { prisma, log, txOpts, recorded, audits, cleanArgs };
}

describe('QT4: StorageCleanRunner — lệnh dọn theo lô', () => {
  it('[QT:T10] (phần b) chạy THEO LÔ tới khi lô không đầy; mỗi lô một transaction ngắn có hạn + statement_timeout; tiến độ + audit cùng transaction', async () => {
    const f = fake([
      { events: 1000, rejected: 0, freedBytes: 4 * MB, done: false },
      { events: 1000, rejected: 0, freedBytes: 3 * MB, done: false },
      { events: 12, rejected: 0, freedBytes: 1000, done: true },
    ]);
    const r = await new StorageCleanRunner(f.prisma).tick();
    expect(r).toEqual([{ id: 'job-1', tenantId: T, status: 'DONE', batches: 3, events: 2012, rejected: 0, freedBytes: 7 * MB + 1000 }]);
    expect(f.prisma.storageClaimCleanJobAcrossTenants).toHaveBeenCalledWith(STORAGE_CLEAN_LEASE_MS, STORAGE_CLEAN_MAX_ATTEMPTS);
    expect(f.prisma.tenantTx).toHaveBeenCalledTimes(3);
    expect(f.txOpts.every((x: any) => x.timeout === CLEAN_TX_TIMEOUT_MS)).toBe(true);
    expect(f.log.filter((l) => l.startsWith('raw:') && l.includes('statement_timeout') && l.includes(String(CLEAN_STATEMENT_TIMEOUT_MS)))).toHaveLength(3);
    expect(f.cleanArgs[0]).toMatchObject({ action: 'trim', importance: ['low'], limit: 1000, quotaBytes: 10 * MB, sourceId: null });
    // sàn retry window áp ở worker, không chỉ ở API
    expect(Date.now() - f.cleanArgs[0].floor.getTime()).toBeGreaterThanOrEqual(TOTAL_RETRY_WINDOW_MS - 5_000);
    expect(f.recorded.map((x) => x.done)).toEqual([false, false, true]);
    expect(f.audits).toEqual([
      expect.objectContaining({
        action: 'storage.clean.completed',
        entityId: 'job-1',
        actor: 'user-1',
        metadata: expect.objectContaining({ events: 2012, freedBytes: 7 * MB + 1000, freedMb: 7 }),
      }),
    ]);
  });

  it('[QT:T33] (phần a) lô trả nấc đổi (vd LOCKED -> CRITICAL_95 khi < 90%) -> báo NGAY qua StorageJob.reportLevelChange (không chờ lượt 60s)', async () => {
    const f = fake([{ events: 5, rejected: 2, freedBytes: 3 * MB, done: true, level: { from: 'LOCKED', to: 'CRITICAL_95', usedBytes: 8.9 * MB } }]);
    const storage: any = { reportLevelChange: jest.fn(async () => undefined) };
    await new StorageCleanRunner(f.prisma, storage).tick();
    expect(storage.reportLevelChange).toHaveBeenCalledWith({ tenantId: T, from: 'LOCKED', to: 'CRITICAL_95', usedBytes: 8.9 * MB, quotaBytes: 10 * MB });
  });

  it('lô lỗi giữa chừng -> lệnh giữ RUNNING (lease hết thì chạy lại từ chỗ còn lại), không audit "completed", không ném ra vòng lặp', async () => {
    const f = fake([{ events: 1000, rejected: 0, freedBytes: 10, done: false }], { failAt: 1 });
    const r = await new StorageCleanRunner(f.prisma).tick();
    expect(r[0]).toMatchObject({ status: 'RUNNING', batches: 1 });
    expect(f.recorded).toHaveLength(1);
    expect(f.audits).toHaveLength(0);
  });

  it('review QT-S2 L1: ghi tiến độ có fencing (attempts của lượt nhận); 0 dòng (worker khác đã nhận lại) -> bỏ lô (rollback), dừng, không audit', async () => {
    const f = fake(
      [
        { events: 1000, rejected: 0, freedBytes: 1, done: false },
        { events: 7, rejected: 0, freedBytes: 1, done: true },
      ],
      { lostAt: 1 },
    );
    const r = await new StorageCleanRunner(f.prisma).tick();
    expect(r[0]).toMatchObject({ status: 'LOST', batches: 1, events: 1000 });
    expect(f.recorded.map((x) => x.attempts)).toEqual([3, 3]);
    expect(f.audits).toHaveLength(0); // lô cuối ném trước khi ghi audit -> rollback cả lô
  });

  it('đang tắt (stop) -> dừng ở ranh giới lô, không nhận lệnh mới', async () => {
    const f = fake([
      { events: 1000, rejected: 0, freedBytes: 1, done: false },
      { events: 1000, rejected: 0, freedBytes: 1, done: false },
    ]);
    const runner = new StorageCleanRunner(f.prisma);
    runner.stop();
    const r = await runner.tick();
    expect(r[0]).toMatchObject({ status: 'RUNNING', batches: 1 });
    expect(f.prisma.storageClaimCleanJobAcrossTenants).toHaveBeenCalledTimes(1);
  });
});
