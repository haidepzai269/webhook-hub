import { CleanupJob } from '../src/scheduler/cleanup.job';

/** QT5 (SPEC-han-muc-dung-luong §5.4 + E5, ADR-186/189): dọn tự động trong cleanup job (cùng khoá) + retention trừ byte. */
const MB = 1048576;
const T = 't-auto';

function fake(targets: any[], batch: (spec: any) => any = () => ({ events: 3, rejected: 0, freedBytes: 2 * MB, done: true, level: null })) {
  const st = { specs: [] as any[], audits: [] as any[], recompute: [] as any[], txOpts: [] as any[] };
  const prisma: any = {
    systemTx(_r: any, fn: any) {
      return fn(this);
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    deleteExpiredEventsBatchAccounted: jest.fn().mockResolvedValue({ deleted: 0, freed: [] }),
    deleteExpiredRejectedBatchAccounted: jest.fn().mockResolvedValue({ deleted: 0, freed: [] }),
    identity: () => ({ deleteExpiredSessionsBatch: jest.fn().mockResolvedValue(0), deleteExpiredEmailTokensBatch: jest.fn().mockResolvedValue(0) }),
    storageAutoCleanTargetsAcrossTenants: jest.fn(async () => targets),
    findProjectById: jest.fn(async () => ({ storageQuotaMb: 10 })),
    tenantTx: jest.fn(async (_t: string, fn: any, opts: any) => {
      st.txOpts.push(opts);
      return fn({ $executeRaw: jest.fn() });
    }),
    forTenant: jest.fn((_t: string, tx?: unknown) => ({
      cleanStorageBatch: jest.fn(async (a: any) => {
        if (!tx) throw new Error('lô phải trong transaction');
        st.specs.push(a);
        return batch(a);
      }),
      createAuditLog: jest.fn(async (a: any) => st.audits.push({ ...a, inTx: !!tx })),
      recomputeStorageLevel: jest.fn(async (q: number) => {
        st.recompute.push(q);
        return { from: 'LOCKED', to: 'WARN_85', usedBytes: 8.5 * MB };
      }),
    })),
  };
  return { prisma, st };
}
const redis = () => ({ set: jest.fn().mockResolvedValue('OK'), on: jest.fn() }) as any;

describe('QT5: dọn tự động trong cleanup job', () => {
  const env = process.env.STORAGE_AUTO_CLEAN_ENABLED;
  afterEach(() => {
    if (env === undefined) delete process.env.STORAGE_AUTO_CLEAN_ENABLED;
    else process.env.STORAGE_AUTO_CLEAN_ENABLED = env;
  });

  it('[QT:T18] (phần a) chỉ chạy mức CÓ policy; KHÔNG BAO GIỜ Cao/Giữ (kể cả dòng giả), Rác chỉ Xoá hẳn; above_85 không chạy khi < 85%; audit system:auto-clean có số dòng + MB; 0 dòng -> không audit', async () => {
    process.env.STORAGE_AUTO_CLEAN_ENABLED = '1';
    const { prisma, st } = fake([
      {
        tenantId: T,
        quotaMb: 10,
        usedBytes: 5 * MB, // 50% < 85%
        policies: [
          { importance: 'junk', action: 'delete', afterDays: 1, trigger: 'always' },
          { importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' },
          { importance: 'medium', action: 'trim', afterDays: 5, trigger: 'above_85' },
          { importance: 'high', action: 'delete', afterDays: 1, trigger: 'always' },
          { importance: 'keep', action: 'delete', afterDays: 1, trigger: 'always' },
          { importance: 'junk', action: 'trim', afterDays: 1, trigger: 'always' },
        ],
      },
    ]);
    const job = new CleanupJob(prisma, redis());
    expect(job.autoCleanEnabled).toBe(true);
    const r = await job.runOnce();
    expect(st.specs.map((x) => [x.action, x.importance])).toEqual([
      ['delete', ['junk']],
      ['trim', ['low']],
    ]);
    expect(st.specs.flatMap((x) => x.importance)).not.toEqual(expect.arrayContaining(['high']));
    expect(st.specs.flatMap((x) => x.importance)).not.toEqual(expect.arrayContaining(['keep']));
    // cutoff = now − afterDays; sàn retry window truyền xuống lô
    expect(Math.abs(Date.now() - 3 * 86_400_000 - st.specs[1].cutoff.getTime())).toBeLessThan(5_000);
    expect(st.specs[1].floor).toBeInstanceOf(Date);
    expect(st.audits).toHaveLength(2);
    expect(st.audits[1]).toMatchObject({ action: 'storage.auto_clean', actor: 'system:auto-clean', metadata: expect.objectContaining({ importance: 'low', events: 3, freedBytes: 2 * MB, freedMb: 2 }) });
    expect(r.autoClean).toEqual({ enabled: true, projects: 1, events: 6, rejectedSamples: 0, freedBytes: 4 * MB });
    // review QT-S2 L5: audit nằm TRONG transaction của lô (lô COMMIT thì audit COMMIT cùng)
    expect(st.audits.every((a) => a.inTx)).toBe(true);

    // ≥ 85% -> above_85 chạy; lô trả 0 dòng -> không audit
    const hot = fake([{ tenantId: T, quotaMb: 10, usedBytes: 9 * MB, policies: [{ importance: 'medium', action: 'trim', afterDays: 5, trigger: 'above_85' }] }], () => ({
      events: 0,
      rejected: 0,
      freedBytes: 0,
      done: true,
      level: null,
    }));
    await new CleanupJob(hot.prisma, redis()).runOnce();
    expect(hot.st.specs.map((x) => x.importance)).toEqual([['medium']]);
    expect(hot.st.audits).toHaveLength(0);
  });

  it('[QT:T30] (phần d) STORAGE_AUTO_CLEAN_ENABLED=0 (mặc định): policy vẫn có nhưng job KHÔNG dọn (không đọc policy, không lô nào); bật lên thì dọn', async () => {
    delete process.env.STORAGE_AUTO_CLEAN_ENABLED;
    const off = fake([{ tenantId: T, quotaMb: 10, usedBytes: 9 * MB, policies: [{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' }] }]);
    const r = await new CleanupJob(off.prisma, redis()).runOnce();
    expect(r.autoClean.enabled).toBe(false);
    expect(off.prisma.storageAutoCleanTargetsAcrossTenants).not.toHaveBeenCalled();
    expect(off.st.specs).toHaveLength(0);
    process.env.STORAGE_AUTO_CLEAN_ENABLED = '1';
    const on = fake([{ tenantId: T, quotaMb: 10, usedBytes: 9 * MB, policies: [{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' }] }]);
    expect((await new CleanupJob(on.prisma, redis()).runOnce()).autoClean.enabled).toBe(true);
    expect(on.st.specs).toHaveLength(1);
  });

  it('dọn tự động theo LÔ có trần mỗi lượt; lô trả nấc đổi -> báo StorageJob ngay; không có khoá Redis -> không dọn gì', async () => {
    process.env.STORAGE_AUTO_CLEAN_ENABLED = '1';
    let i = 0;
    const { prisma, st } = fake([{ tenantId: T, quotaMb: 10, usedBytes: 9 * MB, policies: [{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' }] }], () => ({
      events: 1000,
      rejected: 0,
      freedBytes: 1,
      done: false,
      level: ++i === 1 ? { from: 'LOCKED', to: 'CRITICAL_95', usedBytes: 9 * MB } : null,
    }));
    const storage: any = { reportLevelChange: jest.fn(async () => undefined) };
    await new CleanupJob(prisma, redis(), storage).runOnce();
    expect(st.specs).toHaveLength(20); // AUTO_CLEAN_MAX_BATCHES
    // L5: chạm trần lô -> MỘT audit trong tx lô cuối, số cộng dồn cả 20 lô
    expect(st.audits).toEqual([expect.objectContaining({ action: 'storage.auto_clean', inTx: true, metadata: expect.objectContaining({ events: 20_000 }) })]);
    expect(storage.reportLevelChange).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T, from: 'LOCKED', to: 'CRITICAL_95' }));
    const locked = fake([{ tenantId: T, quotaMb: 10, usedBytes: 9 * MB, policies: [{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' }] }]);
    const noLock = { set: jest.fn().mockResolvedValue(null), on: jest.fn() } as any;
    expect((await new CleanupJob(locked.prisma, noLock).runOnce()).skipped).toBe(true);
    expect(locked.st.specs).toHaveLength(0);
  });

  it('[QT:T18] (phần d) review QT-S2 L5: lô 1 COMMIT, lô 2 lỗi -> audit phần đã COMMIT (ngoài tx, đường dự phòng duy nhất)', async () => {
    process.env.STORAGE_AUTO_CLEAN_ENABLED = '1';
    let i = 0;
    const { prisma, st } = fake([{ tenantId: T, quotaMb: 10, usedBytes: 9 * MB, policies: [{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' }] }], () => {
      if (++i === 2) throw new Error('statement timeout');
      return { events: 1000, rejected: 0, freedBytes: 5, done: false, level: null };
    });
    await new CleanupJob(prisma, redis()).runOnce();
    expect(st.audits).toEqual([expect.objectContaining({ inTx: false, metadata: expect.objectContaining({ events: 1000, freedBytes: 5 }) })]);
  });

  it('[QT:T33] (phần d) retention 7 ngày trừ byte giải phóng theo tenant (trong câu xoá) rồi tính lại nấc NGAY + báo đổi nấc', async () => {
    const { prisma, st } = fake([]);
    prisma.deleteExpiredEventsBatchAccounted = jest.fn().mockResolvedValue({ deleted: 5, freed: [{ tenantId: T, bytes: 3 * MB }] });
    prisma.deleteExpiredRejectedBatchAccounted = jest.fn().mockResolvedValue({ deleted: 2, freed: [{ tenantId: T, bytes: 8000 }] });
    const storage: any = { reportLevelChange: jest.fn(async () => undefined) };
    const r = await new CleanupJob(prisma, redis(), storage).runOnce();
    expect(r).toMatchObject({ events: 5, rejectedRawEvents: 2 });
    expect(st.recompute).toEqual([10 * MB]); // một lần cho tenant bị đụng, theo hạn mức của project
    expect(storage.reportLevelChange).toHaveBeenCalledWith({ tenantId: T, from: 'LOCKED', to: 'WARN_85', usedBytes: 8.5 * MB, quotaBytes: 10 * MB });
  });
});
