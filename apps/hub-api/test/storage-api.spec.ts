import { HttpException } from '@nestjs/common';
import { ROLE_SCOPES } from '@hub/common';
import { TOTAL_RETRY_WINDOW_MS } from '@hub/messaging';
import { createCleanJob, getCleanJob, getStorageOverview } from '../src/modules/storage/storage-api';
import { StorageController } from '../src/modules/storage/storage.controller';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';

/** QT4 (SPEC-han-muc-dung-luong §5.5 + E5, ADR-184): API dung lượng + lệnh dọn bằng store giả. */
const P = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-12T12:00:00Z');
const MB = 1024 * 1024;

function job(o: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    status: 'PENDING',
    action: 'trim',
    importance: ['low'],
    olderThan: '3d',
    cutoff: new Date(NOW - 3 * 86_400_000),
    sourceId: null,
    origin: 'manual',
    suggestionId: null,
    advisor: null,
    eventsAffected: 0,
    rejectedAffected: 0,
    freedBytes: 0n,
    batches: 0,
    error: null,
    createdAt: new Date(NOW),
    startedAt: null,
    finishedAt: null,
    ...o,
  };
}

function store(o: { usage?: any; sources?: any[]; source?: any; traffic?: number; jobs?: any[]; quotaMb?: number | null } = {}) {
  const calls: { tx: string[]; audits: any[]; created: any[] } = { tx: [], audits: [], created: [] };
  const repo = (inTx: boolean) => ({
    findProjectUsage: jest.fn(async () => o.usage ?? null),
    findSources: jest.fn(async () => o.sources ?? []),
    findSourceById: jest.fn(async () => o.source ?? null),
    trafficBytesSince: jest.fn(async () => o.traffic ?? 0),
    listStorageCleanJobs: jest.fn(async () => o.jobs ?? []),
    findStorageCleanJob: jest.fn(async (id: string) => (o.jobs ?? []).find((j) => j.id === id) ?? null),
    createStorageCleanJob: jest.fn(async (input: any) => {
      if (!inTx) throw new Error('phải ghi trong transaction');
      calls.created.push(input);
      return job({ ...input, eventsAffected: 0 });
    }),
    createAuditLog: jest.fn(async (a: any) => {
      if (!inTx) throw new Error('audit phải cùng transaction');
      calls.audits.push(a);
    }),
  });
  const s: any = {
    findProjectById: jest.fn(async () => ({ id: P, storageQuotaMb: o.quotaMb ?? 10 })),
    forTenant: jest.fn((_t: string, tx?: unknown) => repo(!!tx)),
    tenantTx: jest.fn(async (t: string, fn: (tx: unknown) => Promise<unknown>) => {
      calls.tx.push(t);
      return fn({ tx: true });
    }),
  };
  return { s, calls };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    const r = (e as HttpException).getResponse() as Record<string, unknown>;
    return { status: (e as HttpException).getStatus(), ...r };
  }
};

describe('QT4: API dung lượng + lệnh dọn', () => {
  it('[QT:T9] (phần b) olderThan mới hơn sàn retry window -> 400 bad_request field=olderThan, KHÔNG ghi lệnh', async () => {
    const { s, calls } = store();
    const hours = Math.floor(TOTAL_RETRY_WINDOW_MS / 3_600_000); // 6h < 6h15m40s (BP2 C2 + BP3 + BP4)
    expect(await code(createCleanJob(s, P, { action: 'trim', importance: ['low'], olderThan: `${hours}h` }, 'u1', { now: NOW }))).toMatchObject({
      status: 400,
      error: 'bad_request',
      field: 'olderThan',
    });
    expect(await code(createCleanJob(s, P, { action: 'trim', importance: ['high'], olderThan: '3d' }, 'u1', { now: NOW }))).toMatchObject({ status: 400, field: 'confirmHigh' });
    expect(await code(createCleanJob(s, P, [] as unknown, 'u1', { now: NOW }))).toMatchObject({ status: 400 });
    expect(calls.created).toHaveLength(0);
    expect(s.tenantTx).not.toHaveBeenCalled();
  });

  it('[QT:T10] (phần a) tạo LỆNH (PENDING) + audit `storage.clean.requested` trong CÙNG transaction của project -> trả id (controller 202)', async () => {
    const { s, calls } = store();
    const v = await createCleanJob(s, P, { action: 'delete', importance: ['medium', 'junk'], olderThan: '5d' }, 'user-1', { now: NOW });
    expect(v).toMatchObject({ status: 'PENDING', action: 'delete', importance: ['junk', 'medium'], olderThan: '5d', origin: 'manual' });
    expect(v.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.tx).toEqual([P]);
    expect(calls.created[0]).toMatchObject({ id: v.id, cutoff: new Date(NOW - 5 * 86_400_000), requestedBy: 'user-1', sourceId: null });
    expect(calls.audits).toEqual([
      expect.objectContaining({ action: 'storage.clean.requested', entityType: 'storage_clean_job', entityId: v.id, actor: 'user-1', metadata: expect.objectContaining({ importance: ['junk', 'medium'] }) }),
    ]);
    const meta = Reflect.getMetadata('__httpCode__', StorageController.prototype.clean);
    expect(meta).toBe(202);
  });

  it('sourceId phải là source của project và không "Giữ lâu"', async () => {
    expect(await code(createCleanJob(store().s, P, { action: 'trim', importance: ['low'], olderThan: '3d', sourceId: SRC }, 'u', { now: NOW }))).toMatchObject({ status: 400, field: 'sourceId' });
    expect(
      await code(createCleanJob(store({ source: { id: SRC, keepLonger: true } }).s, P, { action: 'trim', importance: ['low'], olderThan: '3d', sourceId: SRC }, 'u', { now: NOW })),
    ).toMatchObject({ status: 400, field: 'sourceId' });
    const ok = await createCleanJob(store({ source: { id: SRC, keepLonger: false } }).s, P, { action: 'trim', importance: ['low'], olderThan: '3d', sourceId: SRC }, 'u', { now: NOW });
    expect(ok.sourceId).toBe(SRC);
  });

  it('GET storage: ước tính + nấc + byImportance từ by_bucket + growth/forecast từ traffic 24h; cờ E5 nói thật (lock/autoClean tắt)', async () => {
    const { s } = store({
      quotaMb: 10,
      traffic: 1 * MB,
      sources: [{ id: SRC, name: 'payos', keepLonger: true }],
      usage: {
        usedBytes: 9n * BigInt(MB),
        level: 'WARN_85',
        bloatFactor: 2,
        measuredAt: new Date(NOW),
        calibratedAt: new Date(NOW - 3_600_000),
        bySource: { [SRC]: 5 * MB, _audit: 100 },
        byBucket: [
          { sourceId: SRC, importance: 'keep', ageDays: 2, events: 4, bytes: 4000 },
          { sourceId: null, importance: 'low', ageDays: 5, events: 2, bytes: 200 },
        ],
        suggestions: [{ id: 'sug_1' }],
      },
      jobs: [job({ status: 'DONE', freedBytes: 1234n })],
    });
    const v = await getStorageOverview(s, P, { lockEnabled: false, autoCleanEnabled: false }, NOW);
    expect(v).toMatchObject({
      estimated: true,
      usedBytes: 9 * MB,
      quotaBytes: 10 * MB,
      usedPct: 90,
      level: 'WARN_85',
      lockEnabled: false,
      autoCleanEnabled: false,
      growthPerDay: 2 * MB,
      forecastHours: 12, // (10−9)MB / (2 × 1MB / 24h)
      suggestions: [{ id: 'sug_1' }],
      calibratedAt: new Date(NOW - 3_600_000).toISOString(),
    });
    expect(v.bySource[0]).toEqual({ sourceId: SRC, name: 'payos', keepLonger: true, bytes: 5 * MB });
    expect(v.byImportance.keep).toEqual({ events: 4, bytes: 4000 });
    expect(v.recentCleanJobs[0]).toMatchObject({ status: 'DONE', freedBytes: 1234 });
  });

  it('GET storage: project chưa đo -> OK, 0 byte, không ném; lệnh của project khác / id rác -> 404', async () => {
    const v = await getStorageOverview(store().s, P, { lockEnabled: true, autoCleanEnabled: true }, NOW);
    expect(v).toMatchObject({ usedBytes: 0, level: 'OK', forecastHours: null, suggestions: [], lockEnabled: true, autoCleanEnabled: true });
    expect(await code(getCleanJob(store().s, P, 'không-phải-uuid'))).toMatchObject({ status: 404, error: 'not_found' });
    expect(await code(getCleanJob(store().s, P, SRC))).toMatchObject({ status: 404 });
  });

  it('quyền: storage:read cho owner + developer (viewer KHÔNG); storage:write chỉ owner (người vận hành = owner); route khai đúng scope', () => {
    expect(ROLE_SCOPES.owner).toEqual(expect.arrayContaining(['storage:read', 'storage:write']));
    expect(ROLE_SCOPES.developer).toContain('storage:read');
    expect(ROLE_SCOPES.developer).not.toContain('storage:write');
    expect(ROLE_SCOPES.viewer).not.toContain('storage:read');
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, StorageController.prototype.overview)).toBe('storage:read');
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, StorageController.prototype.clean)).toBe('storage:write');
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, StorageController.prototype.cleanJob)).toBe('storage:read');
  });
});
