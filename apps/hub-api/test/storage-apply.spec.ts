import { HttpException } from '@nestjs/common';
import { RuleAdvisor, suggestionId } from '@hub/common';
import { applySuggestion } from '../src/modules/storage/storage-api';
import { StorageController } from '../src/modules/storage/storage.controller';
import { ServiceStorageController } from '../src/modules/storage/service-storage.controller';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';

/** QT4b (SPEC-han-muc-dung-luong §5.6, ADR-187): `apply` gợi ý — tính lại khi gọi, 409 kèm bộ mới, idempotent, audit có advisor. */
const P = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-12T12:00:00Z');
const MB = 1048576;
const LOW = suggestionId('rules@1', ['low'], 'trim', '3d', null);
const BUCKETS = [{ sourceId: null, importance: 'low', ageDays: 4, events: 100, bytes: 8 * MB }];

function store(o: { stored?: any[]; buckets?: any[] } = {}) {
  const st = { jobs: [] as any[], audits: [] as any[], saved: [] as any[][], locks: [] as string[] };
  const repo = (inTx: boolean) => ({
    findProjectUsage: jest.fn(async () => ({ usedBytes: 40n * BigInt(MB), level: 'WARN_85', bloatFactor: 2, byBucket: o.buckets ?? BUCKETS, suggestions: o.stored ?? [] })),
    findStoragePolicies: jest.fn(async () => []),
    findKeepLongerSourceIds: jest.fn(async () => []),
    trafficBytesSince: jest.fn(async () => 0),
    saveStorageSuggestions: jest.fn(async (s: any[]) => st.saved.push(s)),
    lockAndFindCleanJobForSuggestion: jest.fn(async (id: string, since: Date) => {
      if (!inTx) throw new Error('khoá phải trong transaction');
      st.locks.push(id);
      return st.jobs.find((j) => j.suggestionId === id && j.createdAt >= since) ?? null;
    }),
    createStorageCleanJob: jest.fn(async (input: any) => {
      const j = { ...input, status: 'PENDING', eventsAffected: 0, rejectedAffected: 0, freedBytes: 0n, batches: 0, error: null, createdAt: new Date(NOW), startedAt: null, finishedAt: null };
      st.jobs.push(j);
      return j;
    }),
    createAuditLog: jest.fn(async (a: any) => st.audits.push(a)),
  });
  const s: any = {
    findProjectById: jest.fn(async () => ({ id: P, storageQuotaMb: 50 })),
    forTenant: jest.fn((_t: string, tx?: unknown) => repo(!!tx)),
    tenantTx: jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
  return { s, st };
}

async function err(p: Promise<unknown>): Promise<Record<string, any>> {
  try {
    await p;
  } catch (e) {
    return { status: (e as HttpException).getStatus(), ...((e as HttpException).getResponse() as Record<string, unknown>) };
  }
  throw new Error('không ném');
}

describe('QT4b: POST …/storage/suggestions/:id/apply', () => {
  it('[QT:T25] (phần a) tính lại tại thời điểm gọi -> tạo lệnh dọn (origin suggestion) + audit ghi suggestionId + advisor', async () => {
    const stored = await new RuleAdvisor(() => NOW).suggest({ usedBytes: 0, quotaBytes: 1, level: 'OK', growthPerDay: 0, buckets: BUCKETS as any, policies: [], keepLongerSourceIds: [] });
    const { s, st } = store({ stored });
    const v = await applySuggestion(s, P, LOW, 'user-1', { now: NOW + 60_000 });
    expect(v).toMatchObject({ status: 'PENDING', action: 'trim', importance: ['low'], olderThan: '3d', origin: 'suggestion', suggestionId: LOW, advisor: 'rules@1' });
    expect(st.audits).toEqual([
      expect.objectContaining({ action: 'storage.clean.requested', actor: 'user-1', metadata: expect.objectContaining({ suggestionId: LOW, advisor: 'rules@1', origin: 'suggestion' }) }),
    ]);
  });

  it('[QT:T25] (phần b) gọi HAI lần cùng id -> CÙNG lệnh dọn (idempotent, khoá theo (project, id) trong transaction)', async () => {
    const { s, st } = store();
    const a = await applySuggestion(s, P, LOW, 'u', { now: NOW });
    const b = await applySuggestion(s, P, LOW, 'u', { now: NOW + 5_000 });
    expect(b.id).toBe(a.id);
    expect(st.jobs).toHaveLength(1);
    expect(st.locks).toEqual([LOW, LOW]);
  });

  it('[QT:T25] (phần c) gợi ý không còn trong bộ hiện tại (đã dọn hết) -> 409 suggestion_stale KÈM bộ mới (và lưu bộ mới); hết hạn -> 409; không tạo lệnh', async () => {
    const gone = store({ buckets: [{ sourceId: null, importance: 'junk', ageDays: 3, events: 2, bytes: 100 }] });
    const e1 = await err(applySuggestion(gone.s, P, LOW, 'u', { now: NOW }));
    expect(e1).toMatchObject({ status: 409, error: 'suggestion_stale' });
    expect((e1.suggestions as any[]).map((x) => x.importance)).toEqual([['junk']]);
    expect(gone.st.saved).toEqual([e1.suggestions]);
    expect(gone.st.jobs).toHaveLength(0);

    const expired = store({ stored: [{ id: LOW, expiresAt: new Date(NOW - 1).toISOString() }] });
    const e2 = await err(applySuggestion(expired.s, P, LOW, 'u', { now: NOW }));
    expect(e2).toMatchObject({ status: 409, error: 'suggestion_stale' });
    expect((e2.suggestions as any[])[0]).toMatchObject({ id: LOW, expiresAt: new Date(NOW + 86_400_000).toISOString() });
    expect(expired.st.jobs).toHaveLength(0);
    // id rác -> 404 như không tồn tại
    expect(await err(applySuggestion(store().s, P, 'sug_xyz', 'u', { now: NOW }))).toMatchObject({ status: 404 });
  });

  it('quyền: apply cần storage:write ở console và ở /v1/p (API key); trả 202', () => {
    for (const C of [StorageController, ServiceStorageController]) {
      expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, C.prototype.apply)).toBe('storage:write');
      expect(Reflect.getMetadata('__httpCode__', C.prototype.apply)).toBe(202);
    }
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, ServiceStorageController.prototype.overview)).toBe('storage:read');
  });
});
