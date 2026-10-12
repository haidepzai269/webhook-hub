import { HttpException } from '@nestjs/common';
import { getStoragePolicies, putStoragePolicies } from '../src/modules/storage/storage-api';
import { StorageController } from '../src/modules/storage/storage.controller';
import { ApiController } from '../src/modules/api/api.controller';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';

/** QT5 (SPEC-han-muc-dung-luong §5.4/§5.5 + E5, ADR-186/189): API policy dọn tự động + cờ "Giữ lâu". */
const P = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';

function store(rows: any[] = []) {
  const st = { upserts: [] as any[], audits: [] as any[] };
  const repo = (inTx: boolean) => ({
    findStoragePolicies: jest.fn(async () => rows),
    findLatestAuditLog: jest.fn(async () => ({ createdAt: new Date('2026-10-12T00:00:00Z'), metadata: { importance: 'low', events: 7, freedBytes: 4096 } })),
    upsertStoragePolicies: jest.fn(async (r: any[], by: string) => {
      if (!inTx) throw new Error('phải trong transaction');
      st.upserts.push({ r, by });
    }),
    createAuditLog: jest.fn(async (a: any) => {
      if (!inTx) throw new Error('audit cùng transaction');
      st.audits.push(a);
    }),
  });
  const s: any = {
    forTenant: jest.fn((_t: string, tx?: unknown) => repo(!!tx)),
    tenantTx: jest.fn(async (_t: string, fn: any) => fn({})),
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

describe('QT5: API policy dọn tự động', () => {
  it('[QT:T30] (phần e) GET policies: đủ 3 mức (thiếu -> mặc định Q10); cờ tắt -> nói thật "Đã cài, chưa chạy"; lần chạy gần nhất', async () => {
    const { s } = store([{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'always', updatedBy: 'system:migration', updatedAt: new Date('2026-10-12T00:00:00Z') }]);
    const off = await getStoragePolicies(s, P, { lockEnabled: false, autoCleanEnabled: false });
    expect(off.policies.map((p) => [p.importance, p.action, p.afterDays])).toEqual([
      ['junk', 'delete', 1],
      ['low', 'trim', 3],
      ['medium', 'off', 5],
    ]);
    expect(off).toMatchObject({ autoCleanEnabled: false, status: 'installed_not_running', lastRun: { importance: 'low', events: 7, freedBytes: 4096 } });
    expect(off.message).toMatch(/Đã cài, chưa chạy/);
    const on = await getStoragePolicies(s, P, { lockEnabled: true, autoCleanEnabled: true });
    expect(on).toMatchObject({ status: 'running' });
    expect(on.message).toMatch(/Đang bật dọn tự động/);
  });

  it('[QT:T18] (phần b) PUT policies: Cao/Giữ KHÔNG đặt được; Rác không "Dọn"; afterDays nguyên 1–365; trigger always|above_85 -> 400 đúng field; hợp lệ -> upsert + audit trước/sau CÙNG transaction', async () => {
    const bad: [unknown, string][] = [
      [{ policies: [{ importance: 'high', action: 'trim', afterDays: 3 }] }, 'importance'],
      [{ policies: [{ importance: 'keep', action: 'delete', afterDays: 3 }] }, 'importance'],
      [{ policies: [{ importance: 'audit_logs', action: 'delete', afterDays: 3 }] }, 'importance'],
      [{ policies: [{ importance: 'junk', action: 'trim', afterDays: 3 }] }, 'action'],
      [{ policies: [{ importance: 'low', action: 'trim', afterDays: 0 }] }, 'afterDays'],
      [{ policies: [{ importance: 'low', action: 'trim', afterDays: 1.5 }] }, 'afterDays'],
      [{ policies: [{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'sometimes' }] }, 'trigger'],
      [{ policies: [{ importance: 'low', action: 'trim', afterDays: 3 }, { importance: 'low', action: 'off', afterDays: 3 }] }, 'importance'],
      [{ policies: [] }, 'policies'],
      [null, 'policies'],
    ];
    for (const [body, field] of bad) {
      const { s, st } = store();
      expect(await err(putStoragePolicies(s, P, body, 'u', { lockEnabled: true, autoCleanEnabled: false }))).toMatchObject({ status: 400, error: 'bad_request', field });
      expect(st.upserts).toHaveLength(0);
    }
    const { s, st } = store([{ importance: 'medium', action: 'off', afterDays: 5, trigger: 'always' }]);
    await putStoragePolicies(s, P, { policies: [{ importance: 'medium', action: 'trim', afterDays: 7, trigger: 'above_85' }] }, 'owner-1', { lockEnabled: true, autoCleanEnabled: false });
    expect(st.upserts).toEqual([{ r: [{ importance: 'medium', action: 'trim', afterDays: 7, trigger: 'above_85' }], by: 'owner-1' }]);
    expect(st.audits).toEqual([
      expect.objectContaining({
        action: 'storage.policies.update',
        actor: 'owner-1',
        metadata: expect.objectContaining({ before: [{ importance: 'medium', action: 'off', afterDays: 5, trigger: 'always' }], after: [{ importance: 'medium', action: 'trim', afterDays: 7, trigger: 'above_85' }] }),
      }),
    ]);
  });

  it('quyền: GET policies = storage:read; PUT = storage:write', () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, StorageController.prototype.policies)).toBe('storage:read');
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, StorageController.prototype.putPolicies)).toBe('storage:write');
  });
});

describe('QT5: PATCH sources/:id keepLonger', () => {
  function api() {
    const updates: any[] = [];
    const audits: any[] = [];
    const repo = {
      updateSource: jest.fn(async (id: string, data: any) => {
        updates.push(data);
        return { id, ...data, secrets: [] };
      }),
      createAuditLog: jest.fn(async (a: any) => audits.push(a)),
    };
    const prisma: any = { forTenant: jest.fn(() => repo), tenantTx: jest.fn(async (_t: string, fn: any) => fn({})) };
    const ctrl = new ApiController(prisma);
    (ctrl as any).withAudit = async (_t: string, fn: any) => fn(repo);
    return { ctrl, updates, audits };
  }
  const req = (scopes: string[]) => ({ principal: { kind: 'user', id: 'u', scopes } }) as any;

  it('keepLonger cần THÊM storage:write (developer có manage:sources nhưng không được bật "Giữ lâu"); owner bật được + audit', async () => {
    const a = api();
    const e = await err(a.ctrl.updateSource(P, 'dev', SRC, { keepLonger: true }, req(['manage:sources'])));
    expect(e).toMatchObject({ status: 403, error: 'missing_scope', required: 'storage:write' });
    expect(a.updates).toHaveLength(0);
    const r = await a.ctrl.updateSource(P, 'owner', SRC, { keepLonger: true }, req(['manage:sources', 'storage:write']));
    expect(r).toMatchObject({ id: SRC, keepLonger: true });
    expect(a.updates).toEqual([{ keepLonger: true }]);
    expect(a.audits[0]).toMatchObject({ action: 'source.update', metadata: { keepLonger: true } });
    expect(await err(a.ctrl.updateSource(P, 'owner', SRC, { keepLonger: 'yes' }, req(['storage:write'])))).toMatchObject({ status: 400, field: 'keepLonger' });
    // đổi tên không cần storage:write
    await a.ctrl.updateSource(P, 'dev', SRC, { name: 'x' }, req(['manage:sources']));
    expect(a.updates[1]).toEqual({ name: 'x' });
  });
});
