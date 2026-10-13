import { GUARDS_METADATA } from '@nestjs/common/constants';
import { withoutReplayWhenTrimmed } from '../src/modules/flow/flow-lib';
import { ProjectsController } from '../src/modules/console/projects.controller';
import { OperatorGuard } from '../src/modules/console/operator.guard';
import { getStorageOverview } from '../src/modules/storage/storage-api';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';

/**
 * QT7 (SPEC-han-muc-dung-luong §5.1, §9, §10): phần server của console — event đã Dọn không hứa Replay, operator thấy mức
 * sử dụng + ghi đè hạn mức (OperatorGuard, audit cùng transaction), "N/20 nguồn" ở GET storage.
 */
const P = '11111111-1111-4111-8111-111111111111';
const MB = 1048576;

const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return toErrorBody(e, 'r');
  }
  throw new Error('không ném lỗi');
};

describe('QT7 console — server', () => {
  it('[QT:T20] (phần c) hành trình event đã Dọn: bỏ hành động replay_delivery khỏi mọi chặng/nhánh (server 409 event_trimmed — giao diện không hứa); chưa dọn giữ nguyên', () => {
    const flow = {
      stages: [{ key: 'x', actions: ['replay_delivery', 'open_dlq'] as any }],
      branches: [{ deliveryId: 'd1', stages: [{ actions: ['replay_delivery'] as any }, { actions: undefined }] }],
    };
    const trimmed = withoutReplayWhenTrimmed(flow, new Date());
    expect(trimmed.stages[0].actions).toEqual(['open_dlq']);
    expect(trimmed.branches[0].stages[0].actions).toEqual([]);
    expect(withoutReplayWhenTrimmed(flow, null)).toBe(flow);
  });

  it('operator: danh sách project có cột mức sử dụng (ước tính, %, nấc, hạn mức ghi đè); người thường không có', async () => {
    const prisma: any = {
      identity: () => ({ listMemberships: async () => [{ projectId: P, slug: 'a', name: 'A', environment: 'test', role: 'owner' }] }),
      listProjects: async () => [{ id: P, slug: 'a', name: 'A', environment: 'test', storageQuotaMb: 100 }],
      operatorProjectUsage: async () => [{ tenantId: P, usedBytes: 80 * MB, level: 'WARN_70' }],
    };
    const ctrl = new ProjectsController(prisma);
    const op = await ctrl.list({ principal: { kind: 'user', id: 'u', isOperator: true } } as any);
    expect(op[0]).toMatchObject({ usage: { estimated: true, usedBytes: 80 * MB, quotaBytes: 100 * MB, usedPct: 80, level: 'WARN_70', quotaOverrideMb: 100 } });
    const user = await ctrl.list({ principal: { kind: 'user', id: 'u', isOperator: false } } as any);
    expect(user[0]).not.toHaveProperty('usage');
  });

  it('operator ghi đè hạn mức: OperatorGuard; 1–102400 hoặc null; ghi + audit cùng transaction; body sai -> 422 validation', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ProjectsController.prototype.setStorageQuota)).toEqual([OperatorGuard]);
    const writes: any[] = [];
    const prisma: any = {
      findProjectById: async () => ({ id: P, storageQuotaMb: null }),
      tenantTx: async (_t: string, fn: any) => fn({ tx: true }),
      setProjectStorageQuota: async (id: string, mb: number | null, tx: any) => writes.push({ id, mb, tx: !!tx }),
      forTenant: (_t: string, tx: any) => ({ createAuditLog: async (a: any) => writes.push({ audit: a.action, meta: a.metadata, tx: !!tx }) }),
    };
    const ctrl = new ProjectsController(prisma);
    expect(await ctrl.setStorageQuota('op', P, { storageQuotaMb: 200 })).toEqual({ id: P, storageQuotaMb: 200, quotaBytes: 200 * MB });
    expect(writes).toEqual([
      { id: P, mb: 200, tx: true },
      { audit: 'project.storage_quota_changed', meta: { before: null, after: 200 }, tx: true },
    ]);
    expect((await ctrl.setStorageQuota('op', P, { storageQuotaMb: null })).storageQuotaMb).toBeNull();
    for (const bad of [{ storageQuotaMb: 0 }, { storageQuotaMb: 1.5 }, { storageQuotaMb: '50' }, { storageQuotaMb: 50, x: 1 }, null]) {
      expect((await errOf(ctrl.setStorageQuota("op", P, bad))).status).toBe(422); // khuôn validation của controller (invalid())
    }
  });

  it('GET storage trả "N/20 nguồn": đếm source chưa lưu trữ + trần SOURCE_LIMIT_PER_PROJECT', async () => {
    const repo = {
      findProjectUsage: async () => null,
      findSources: async () => [{ id: 's1', name: 'a' }, { id: 's2', name: 'b', archivedAt: new Date() }, { id: 's3', name: 'c', archivedAt: null }],
      trafficBytesSince: async () => 0,
      listStorageCleanJobs: async () => [],
    };
    const s: any = { findProjectById: async () => ({ id: P }), forTenant: () => repo };
    const v = await getStorageOverview(s, P, { lockEnabled: false, autoCleanEnabled: false });
    expect(v.sources).toEqual({ count: 2, limit: 20 });
  });
});
