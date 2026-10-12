import { NotFoundException } from '@nestjs/common';
import { TenantScopedRepository } from '@hub/database';
import { aesGcmEncrypt } from '@hub/crypto';
import { ApiController } from '../src/modules/api/api.controller';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { assembleTopology } from '../src/modules/flow/topology.assemble';
import { ConsoleEndpointsController } from '../src/modules/console/endpoints.controller';

/**
 * ADR-161: "Xoá" trên bản đồ luồng = LƯU TRỮ (archived_at + is_active=false), không DELETE. Repo THẬT trên Prisma giả
 * trong bộ nhớ — kiểm scope tenant (BB-5), audit cùng transaction, subscription treo được lưu trữ theo, và source đã lưu
 * trữ bị ingest từ chối y như source tắt.
 */
const MASTER = 'test-master-key-at-least-32-characters!!';
beforeAll(() => (process.env.MASTER_KEY = MASTER));

const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SRC = '11111111-1111-1111-1111-111111111111';
const SRC2 = '11111111-1111-1111-1111-222222222222';
const DEST = '22222222-2222-2222-2222-222222222222';
const SUB_ONLY_SRC = '33333333-3333-3333-3333-333333333331';
const SUB_ANY = '33333333-3333-3333-3333-333333333332';
const SUB_MULTI = '33333333-3333-3333-3333-333333333333';

type Row = Record<string, any>;

/** Principal của developer (guard thật gắn `scopes`) — `requireAlsoScope` đóng mặc định. */
const DEV: any = { principal: { kind: 'user', scopes: ['read:project', 'manage:sources', 'manage:endpoints'] } };

/** Bộ khớp `where` tối thiểu cho các truy vấn mà repo dùng ở đây. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('has' in v) return (row[k] ?? []).includes(v.has);
      return true; // quan hệ lồng (destination: {...}) — không cần trong bộ giả này
    }
    return (row[k] ?? null) === v;
  });
}

function build() {
  const db = {
    sources: [
      { id: SRC, tenantId: T, name: 'payos', provider: 'payos', isActive: true, archivedAt: null, secrets: [] },
      { id: SRC2, tenantId: T, name: 'sepay', provider: 'sepay', isActive: true, archivedAt: null, secrets: [] },
    ] as Row[],
    destinations: [{ id: DEST, tenantId: T, name: 'shop', type: 'webhook', isActive: true, archivedAt: null }] as Row[],
    subscriptions: [
      { id: SUB_ONLY_SRC, tenantId: T, destinationId: DEST, name: 'chỉ payos', sourceIds: [SRC], isActive: true, archivedAt: null },
      { id: SUB_ANY, tenantId: T, destinationId: DEST, name: 'mọi nguồn', sourceIds: [], isActive: true, archivedAt: null },
      { id: SUB_MULTI, tenantId: T, destinationId: DEST, name: 'payos+sepay', sourceIds: [SRC, SRC2], isActive: true, archivedAt: null },
    ] as Row[],
    audit: [] as Row[],
    deliveries: [] as Row[],
    connections: [{ id: 'c1', sourceId: SRC, tenantId: T, status: 'CONNECTED', credentialsEncrypted: 'enc-creds' }] as Row[],
    locks: 0,
    queries: [] as string[],
  };
  const table = (rows: () => Row[]) => ({
    findFirst: jest.fn(async ({ where }: any) => rows().find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async ({ where }: any) => rows().filter((r) => matches(r, where))),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows().filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
  });
  const client: any = {
    source: table(() => db.sources),
    destination: table(() => db.destinations),
    subscription: table(() => db.subscriptions),
    sourceConnection: table(() => db.connections),
    auditLog: { create: jest.fn(async ({ data }: any) => (db.audit.push(data), data)) },
    delivery: { findFirst: jest.fn(async ({ where }: any) => db.deliveries.find((d) => d.id === where.id && d.tenantId === where.tenantId) ?? null) },
    // SQL thô của repo: khoá advisory, array_remove (T4); set_config của RLS bỏ qua.
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: any[]) => {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) db.locks += 1;
      if (sql.includes('array_remove')) {
        const [sourceId, tenantId] = vals;
        let n = 0;
        for (const s of db.subscriptions) {
          if (s.tenantId === tenantId && s.archivedAt === null && s.sourceIds.includes(sourceId)) {
            s.sourceIds = s.sourceIds.filter((x: string) => x !== sourceId);
            n += 1;
          }
        }
        return n;
      }
      return 0;
    }),
    $queryRaw: jest.fn(async (q: any) => (db.queries.push(q.sql ?? String(q)), [])),
  };
  const prisma: any = {
    forTenant: (tenantId: string, c?: any) => new TenantScopedRepository(c ?? client, tenantId),
    tenantTx(_t: any, fn: any, o?: any) {
      return this.$transaction(fn, o);
    },
    $transaction: jest.fn(async (fn: any) => fn(client)),
  };
  return { controller: new ApiController(prisma), db, client, prisma };
}

describe('ADR-161 — lưu trữ source/đích/subscription ("Xoá" trên bản đồ luồng)', () => {
  it('source: archived_at + is_active=false, audit CÙNG transaction; chỉ sub không còn nguồn sống bị lưu trữ theo', async () => {
    const { controller, db, prisma } = build();
    const r = await controller.archiveSource(T, 'user:1', SRC, { reason: 'bỏ PayOS' }, DEV);
    expect(r).toMatchObject({ archived: true, id: SRC, archivedSubscriptionIds: [SUB_ONLY_SRC] });
    const src = db.sources.find((s) => s.id === SRC)!;
    expect(src.archivedAt).toBeInstanceOf(Date);
    expect(src.isActive).toBe(false);
    // Sub lọc riêng PayOS -> lưu trữ; sub mọi nguồn / sub còn nguồn sepay sống -> giữ nguyên.
    const sub = (id: string) => db.subscriptions.find((s) => s.id === id)!;
    expect(sub(SUB_ONLY_SRC)).toMatchObject({ isActive: false, archivedAt: src.archivedAt });
    expect(sub(SUB_ANY)).toMatchObject({ isActive: true, archivedAt: null });
    // T4: sub nhiều nguồn còn sống bỏ id source đã lưu trữ khỏi bộ lọc.
    expect(sub(SUB_MULTI)).toMatchObject({ isActive: true, archivedAt: null, sourceIds: [SRC2] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.audit).toEqual([
      expect.objectContaining({
        tenantId: T,
        action: 'source.archive',
        entityType: 'source',
        entityId: SRC,
        actor: 'user:1',
        reason: 'bỏ PayOS',
        metadata: expect.objectContaining({ archivedSubscriptionIds: [SUB_ONLY_SRC] }),
      }),
    ]);
  });

  it('source thứ hai lưu trữ -> sub nhiều nguồn hết nguồn sống mới bị lưu trữ', async () => {
    const { controller, db } = build();
    await controller.archiveSource(T, 'u', SRC, {}, DEV);
    const r = await controller.archiveSource(T, 'u', SRC2, {}, DEV);
    expect(r.archivedSubscriptionIds).toEqual([SUB_MULTI]);
    expect(db.subscriptions.find((s) => s.id === SUB_ANY)).toMatchObject({ archivedAt: null });
  });

  it('BB-5: tenant khác -> 404, không đổi gì, không audit', async () => {
    const { controller, db } = build();
    await expect(controller.archiveSource(OTHER, 'u', SRC, {}, DEV)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.archiveDestination(OTHER, 'u', DEST, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.archiveSubscription(OTHER, 'u', SUB_ANY, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(db.sources.every((s) => s.archivedAt === null && s.isActive)).toBe(true);
    expect(db.destinations[0]).toMatchObject({ archivedAt: null, isActive: true });
    expect(db.subscriptions.every((s) => s.archivedAt === null)).toBe(true);
    expect(db.audit).toHaveLength(0);
  });

  it('đã lưu trữ -> 404 (không audit lần hai); PATCH bật lại source đã lưu trữ -> 404', async () => {
    const { controller, db } = build();
    await controller.archiveSource(T, 'u', SRC, {}, DEV);
    await expect(controller.archiveSource(T, 'u', SRC, {}, DEV)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.updateSource(T, 'u', SRC, { isActive: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.sources.find((s) => s.id === SRC)!.isActive).toBe(false);
    expect(db.audit.map((a) => a.action)).toEqual(['source.archive']);
  });

  it('đích: lưu trữ kèm MỌI subscription của nó (không cạnh treo); audit liệt kê id', async () => {
    const { controller, db } = build();
    const r = await controller.archiveDestination(T, 'u', DEST, {});
    expect(r.archivedSubscriptionIds.sort()).toEqual([SUB_ONLY_SRC, SUB_ANY, SUB_MULTI].sort());
    expect(db.destinations[0]).toMatchObject({ isActive: false, archivedAt: expect.any(Date) });
    expect(db.subscriptions.every((s) => s.archivedAt instanceof Date && s.isActive === false)).toBe(true);
    expect(db.audit).toEqual([expect.objectContaining({ action: 'destination.archive', entityId: DEST })]);
    // Đích lưu trữ không sửa/bật lại được.
    await expect(controller.updateDestination(T, 'u', DEST, { isActive: true })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('subscription: lưu trữ một mình, audit cùng transaction', async () => {
    const { controller, db } = build();
    await expect(controller.archiveSubscription(T, 'u', SUB_ANY, {})).resolves.toMatchObject({ archived: true, id: SUB_ANY });
    expect(db.subscriptions.filter((s) => s.archivedAt).map((s) => s.id)).toEqual([SUB_ANY]);
    expect(db.audit).toEqual([expect.objectContaining({ action: 'subscription.archive', entityId: SUB_ANY })]);
  });

  it('"Ngắt"/"Kết nối lại" đích qua PATCH isActive (audit ghi trường)', async () => {
    const { controller, db } = build();
    await controller.updateDestination(T, 'u', DEST, { isActive: false });
    expect(db.destinations[0].isActive).toBe(false);
    expect(db.audit[0]).toMatchObject({ action: 'destination.update', metadata: { fields: ['isActive'], isActive: false } });
    await controller.updateDestination(T, 'u', DEST, { isActive: true });
    expect(db.destinations[0].isActive).toBe(true);
  });

  it('normalize không khớp subscription đã lưu trữ hay đích đã Ngắt/lưu trữ', async () => {
    const { client } = build();
    await new TenantScopedRepository(client, T).findActiveSubscriptionsForEvent('payment.received', SRC);
    expect(client.subscription.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: T,
      isActive: true,
      archivedAt: null,
      destination: { tenantId: T, isActive: true, archivedAt: null },
    });
  });
});

describe('ADR-161 — ingest từ chối source đã lưu trữ y như source tắt', () => {
  function svcWith(source: Row) {
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      forTenant: () => ({ findSourceById: jest.fn().mockResolvedValue(source) }),
      $transaction: jest.fn(),
    };
    const redis: any = { checkRateLimit: jest.fn().mockResolvedValue(true), getIdempotencyKey: jest.fn(), setIdempotencyKey: jest.fn() };
    return { svc: new IngestService(prisma, redis), prisma, redis };
  }
  const base = { id: SRC, tenantId: T, provider: 'sepay', verificationConfig: null, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt('x', MASTER) }] };
  const req = { provider: 'sepay' as any, sourceKey: 'src_sepay_x', headers: { 'content-type': 'application/json' }, rawBody: Buffer.from('{"id":1}'), body: { id: 1 }, contentType: 'application/json' };

  it('/hooks: lưu trữ (is_active=false) -> cùng 404 với source tắt; không ghi gì, không chạm Redis', async () => {
    const inactive = await svcWith({ ...base, isActive: false, archivedAt: null }).svc.ingestWebhook(req as any);
    const { svc, prisma, redis } = svcWith({ ...base, isActive: false, archivedAt: new Date() });
    const archived = await svc.ingestWebhook(req as any);
    expect(archived).toEqual(inactive);
    expect(archived.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.checkRateLimit).not.toHaveBeenCalled();
  });

  it('/hooks: phòng thủ — archived_at có mà is_active còn true vẫn 404', async () => {
    const r = await svcWith({ ...base, isActive: true, archivedAt: new Date() }).svc.ingestWebhook(req as any);
    expect(r.status).toBe(404);
  });

  it('/v1/p publish: source api đã lưu trữ -> 409 source_inactive như source tắt', async () => {
    const r = await svcWith({ ...base, provider: 'api', isActive: true, archivedAt: new Date() }).svc.publishFromService(T, SRC, { ...req, provider: 'api' } as any);
    expect(r).toEqual({ status: 409, body: { error: 'source_inactive' } });
  });
});

describe('ADR-161 — topology mang trạng thái Ngắt + cờ kết nối provider (dữ liệu, không theo tên provider)', () => {
  it('đích is_active=false -> node active=false; source có source_connections -> providerConnected', () => {
    const topo = assembleTopology(
      '15m',
      {
        sources: [
          { id: 'S1', name: 'a', provider: 'payos', sourceKey: 'k1', isActive: true, connections: [{ id: 'c1' }] },
          { id: 'S2', name: 'b', provider: 'payos', sourceKey: 'k2', isActive: false, connections: [] },
        ],
        subscriptions: [],
        destinations: [
          { id: 'D1', name: 'd', type: 'webhook', isActive: false, circuitState: 'CLOSED', rateLimitRps: 0 },
          { id: 'D2', name: 'e', type: 'webhook', circuitState: 'CLOSED', rateLimitRps: 0 },
        ],
      },
      [],
      { events: 0, unmapped: 0, p50: null, p95: null, orphans: 0, pending: 0 },
      [],
      [],
      [],
    );
    const n = (id: string) => topo.nodes.find((x) => x.id === id) as any;
    expect(n('src:S1')).toMatchObject({ active: true, providerConnected: true });
    expect(n('src:S2')).toMatchObject({ active: false, providerConnected: false });
    expect(n('dst:D1').active).toBe(false);
    expect(n('dst:D2').active).toBe(true); // thiếu cột (dữ liệu cũ) = đang chạy
  });
});

describe('ADR-161 (review) — by-id bỏ qua mục lưu trữ, khoá cấu hình, replay, scope', () => {
  const at = new Date('2026-10-12T00:00:00Z');

  it('T1: findSourceById/findDestinationById/findSubscriptionById mặc định bỏ qua mục lưu trữ; includeArchived thì thấy', async () => {
    const { db, client } = build();
    db.sources[0].archivedAt = at;
    db.destinations[0].archivedAt = at;
    db.subscriptions[0].archivedAt = at;
    const repo = new TenantScopedRepository(client, T);
    expect(await repo.findSourceById(SRC)).toBeNull();
    expect(await repo.findDestinationById(DEST)).toBeNull();
    expect(await repo.findSubscriptionById(SUB_ONLY_SRC)).toBeNull();
    expect(await repo.findSourceById(SRC, { includeArchived: true })).toMatchObject({ id: SRC });
    expect(await repo.findDestinationById(DEST, { includeArchived: true })).toMatchObject({ id: DEST });
  });

  it('C1/T2: tạo subscription trên đích đã lưu trữ -> 404, không tạo; kiểm đích SAU khoá cấu hình trong transaction', async () => {
    const { controller, db, client } = build();
    client.subscription.create = jest.fn();
    db.destinations[0].archivedAt = at;
    await expect(controller.createSubscription(T, 'u', { destinationId: DEST, name: 'x', eventTypes: ['payment.*'] })).rejects.toBeInstanceOf(NotFoundException);
    expect(client.subscription.create).not.toHaveBeenCalled();
    expect(db.locks).toBe(1);
    expect(db.audit).toHaveLength(0);
  });

  it('T2: tạo subscription với sourceIds trỏ source đã lưu trữ -> 422 unknown_source (kiểm trong transaction)', async () => {
    const { controller, db, client } = build();
    client.subscription.create = jest.fn();
    db.sources[0].archivedAt = at;
    const err = await controller.createSubscription(T, 'u', { destinationId: DEST, name: 'x', eventTypes: ['payment.*'], sourceIds: [SRC] }).catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ error: 'unknown_source', ids: [SRC] });
    expect(client.subscription.create).not.toHaveBeenCalled();
  });

  it('T2: lưu trữ source/đích/subscription đều lấy khoá cấu hình luồng trong transaction', async () => {
    const { controller, db } = build();
    await controller.archiveSubscription(T, 'u', SUB_ANY, {});
    await controller.archiveSource(T, 'u', SRC, {}, DEV);
    await controller.archiveDestination(T, 'u', DEST, {});
    expect(db.locks).toBe(3);
  });

  it('T1: PATCH subscription đã lưu trữ -> 404, không audit', async () => {
    const { controller, db } = build();
    db.subscriptions[1].archivedAt = at;
    await expect(controller.updateSubscription(T, 'u', SUB_ANY, { isActive: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.audit).toHaveLength(0);
  });

  it('L1: lưu trữ source đòi thêm manage:endpoints (403 missing_scope), không đổi gì', async () => {
    const { controller, db } = build();
    const req: any = { principal: { kind: 'user', scopes: ['read:project', 'manage:sources'] } };
    const err = await controller.archiveSource(T, 'u', SRC, {}, req).catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ error: 'missing_scope', required: 'manage:endpoints' });
    expect(db.sources[0].archivedAt).toBeNull();
    const ok: any = { principal: { kind: 'user', scopes: ['manage:sources', 'manage:endpoints'] } };
    await expect(controller.archiveSource(T, 'u', SRC, {}, ok)).resolves.toMatchObject({ archived: true });
  });

  it('T3: replay đơn — đích/sub lưu trữ -> 409 destination_archived; đích Ngắt -> 409 destination_inactive', async () => {
    const { controller, db } = build();
    const D1 = '55555555-5555-5555-5555-555555555551';
    const D2 = '55555555-5555-5555-5555-555555555552';
    db.deliveries.push(
      { id: D1, tenantId: T, status: 'DEAD', attemptGeneration: 1, subscription: { archivedAt: null, destination: { id: DEST, isActive: false, archivedAt: at } } },
      { id: D2, tenantId: T, status: 'DEAD', attemptGeneration: 1, subscription: { archivedAt: null, destination: { id: DEST, isActive: false, archivedAt: null } } },
    );
    const e1 = await controller.replayDelivery(T, 'u', D1, {}).catch((e) => e);
    expect([e1.getStatus(), e1.getResponse().error]).toEqual([409, 'destination_archived']);
    const e2 = await controller.replayDelivery(T, 'u', D2, {}).catch((e) => e);
    expect([e2.getStatus(), e2.getResponse().error]).toEqual([409, 'destination_inactive']);
  });

  it('T3: replay hàng loạt (xem trước) chỉ chọn delivery có subscription + đích chưa lưu trữ và đích đang bật', async () => {
    const { controller, db } = build();
    await controller.replayBulk(T, 'u', { dryRun: true, reason: 'thử lại sau sự cố' });
    const sql = db.queries.join('\n');
    expect(sql).toMatch(/s\.archived_at IS NULL/);
    expect(sql).toMatch(/dst\.archived_at IS NULL AND dst\.is_active/);
  });
});

describe('ADR-161 (review) — xoay secret endpoint ở console', () => {
  it('T1: endpoint bị lưu trữ giữa chừng (update không ghi được) -> 404, KHÔNG trả secret chưa lưu, không audit', async () => {
    const { client, db, prisma } = build();
    db.destinations[0].createdByKeyId = null;
    client.destination.updateMany = jest.fn(async () => ({ count: 0 })); // bị lưu trữ ngay trước UPDATE
    const ctrl = new ConsoleEndpointsController(prisma, { challenge: jest.fn() } as any);
    const err = await ctrl.rotateSecret(T, 'user-1', DEST).catch((e: any) => e);
    expect(err.getStatus()).toBe(404);
    expect(db.audit).toHaveLength(0);
  });

  it('T1: endpoint đã lưu trữ -> 404 ngay (findWebhook bỏ qua mục lưu trữ)', async () => {
    const { db, prisma, client } = build();
    db.destinations[0].archivedAt = new Date();
    const ctrl = new ConsoleEndpointsController(prisma, { challenge: jest.fn() } as any);
    const err = await ctrl.rotateSecret(T, 'user-1', DEST).catch((e: any) => e);
    expect(err.getStatus()).toBe(404);
    expect(client.destination.updateMany).not.toHaveBeenCalled();
  });
});

describe('ADR-161 (review 3) — credentials provider, scope đóng mặc định, abandon', () => {
  it('lưu trữ source xoá credentials mã hoá + DISCONNECTED trong CÙNG tx; audit ghi providerConnectionWiped', async () => {
    const { controller, db, prisma } = build();
    await controller.archiveSource(T, 'u', SRC, {}, DEV);
    expect(db.connections[0]).toMatchObject({ credentialsEncrypted: null, status: 'DISCONNECTED', lastError: 'source_archived' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.audit[0].metadata).toMatchObject({ providerConnectionWiped: true });
  });

  it('requireAlsoScope đóng mặc định: không có principal/scopes -> 403, không đổi gì', async () => {
    const { controller, db } = build();
    const err = await controller.archiveSource(T, 'u', SRC, {}).catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(db.sources[0].archivedAt).toBeNull();
  });

  it('abandonDelivery chỉ đụng PENDING/RETRYING — không bao giờ DELIVERING (lease đang gửi)', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    await new TenantScopedRepository({ delivery: { updateMany } } as any, T).abandonDelivery('d1', 'destination_archived: x');
    expect((updateMany.mock.calls[0] as any)[0].where).toEqual({ id: 'd1', tenantId: T, status: { in: ['PENDING', 'RETRYING'] } });
  });
});


describe('ADR-161 (review 3) — kết nối provider trên source vừa bị lưu trữ', () => {
  it('callConnect: source bị lưu trữ trong lúc gọi provider -> 404, không ghi kết nối; cấu hình MỚI ở provider được dọn', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SourceConnectionService } = require('../src/modules/console/source-connection.service');
    const repo = {
      lockFlowConfig: jest.fn(async () => undefined),
      findSourceById: jest.fn(async () => null), // đã lưu trữ -> repo coi như không tồn tại
      updateSourceConnection: jest.fn(),
      addSourceSecret: jest.fn(),
      createAuditLog: jest.fn(),
    };
    const prisma: any = { tenantTx: async (_t: string, fn: any) => fn({}), forTenant: () => repo };
    const svc = new SourceConnectionService(prisma, { HUB_PUBLIC_URL: 'https://hub.example.com' });
    const connector = {
      spec: { defaultBaseUrl: 'https://provider.example', fields: [] },
      connect: jest.fn(async () => ({ remoteRef: 'remote-new', display: 'x' })),
      disconnect: jest.fn(async () => undefined),
    };
    const err = await (svc as any)
      .callConnect(T, 'user:u', SRC, 'payos', connector, { k: 'v' }, 'https://hub.example.com/hooks/payos/k', 'source.connect', null)
      .catch((e: any) => e);
    expect(err.getStatus()).toBe(404);
    expect(repo.lockFlowConfig).toHaveBeenCalled();
    // Không ghi FAILED/save_failed; chỉ phòng thủ M1: xoá credentials + DISCONNECTED (idempotent với tx lưu trữ).
    expect(repo.updateSourceConnection).toHaveBeenCalledTimes(1);
    expect(repo.updateSourceConnection).toHaveBeenCalledWith(SRC, expect.objectContaining({ credentialsEncrypted: null, status: 'DISCONNECTED', lastError: 'source_archived' }));
    expect(repo.createAuditLog).not.toHaveBeenCalled();
    expect(connector.disconnect).toHaveBeenCalledWith(expect.objectContaining({ remoteRef: 'remote-new' }));
  });
});

describe('ADR-161 (review 4, M1) — lưu trữ chen giữa các bước kết nối provider', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SourceConnectionService } = require('../src/modules/console/source-connection.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ProviderRegistry } = require('@hub/providers');
  const live = { id: SRC, tenantId: T, provider: 'payos', sourceKey: 'k', isActive: true, archivedAt: null, secrets: [] };

  /** `liveReads` = số lần findSourceById còn thấy source trước khi nó "bị lưu trữ". */
  function setup(liveReads: number, existingConn: Row | null) {
    let reads = 0;
    const repo = {
      lockFlowConfig: jest.fn(async () => undefined),
      findSourceById: jest.fn(async () => (reads++ < liveReads ? live : null)),
      findSourceConnection: jest.fn(async () => existingConn),
      claimSourceConnection: jest.fn(async () => ({ ...existingConn, status: 'PENDING' })),
      createSourceConnection: jest.fn(async () => ({})),
      updateSourceConnection: jest.fn(async () => ({})),
      addSourceSecret: jest.fn(),
      createAuditLog: jest.fn(),
    };
    const prisma: any = { tenantTx: async (_t: string, fn: any) => fn({}), forTenant: () => repo };
    const connector = {
      spec: { defaultBaseUrl: 'https://provider.example', fields: [{ name: 'apiKey', label: 'API key' }] },
      connect: jest.fn(async () => ({ remoteRef: 'remote-new', display: 'x' })),
      disconnect: jest.fn(async () => undefined),
    };
    jest.spyOn(ProviderRegistry, 'has').mockReturnValue(true);
    jest.spyOn(ProviderRegistry, 'get').mockReturnValue({ connector } as any);
    const svc = new SourceConnectionService(prisma, { HUB_PUBLIC_URL: 'https://hub.example.com' });
    return { svc, repo, connector };
  }
  const CONN = { sourceId: SRC, status: 'CONNECTED', remoteRef: 'remote-old', credentialsEncrypted: null };
  const body = { credentials: { apiKey: 'k-123' } };
  afterEach(() => jest.restoreAllMocks());

  it('retry: lưu trữ giữa load và tx giành kết nối -> 404, không claim, không gọi provider', async () => {
    const { svc, repo, connector } = setup(1, CONN); // load thấy; tx giành kết nối thì đã lưu trữ
    const err = await svc.retry(T, 'user:u', SRC, body).catch((e: any) => e);
    expect(err.getStatus()).toBe(404);
    expect(repo.lockFlowConfig).toHaveBeenCalled();
    expect(repo.claimSourceConnection).not.toHaveBeenCalled();
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('connectExisting (chưa có kết nối): lưu trữ trước tx tạo -> 404, không tạo PENDING/credentials', async () => {
    const { svc, repo, connector } = setup(1, null);
    const err = await svc.connectExisting(T, 'user:u', SRC, body).catch((e: any) => e);
    expect(err.getStatus()).toBe(404);
    expect(repo.createSourceConnection).not.toHaveBeenCalled();
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it('retry: lưu trữ GIỮA giành kết nối và gọi provider -> 404; gỡ cấu hình mới + cũ ở provider; xoá credentials + DISCONNECTED', async () => {
    const { svc, repo, connector } = setup(2, CONN); // load + tx giành thấy; tx ghi kết quả thì đã lưu trữ
    const err = await svc.retry(T, 'user:u', SRC, body).catch((e: any) => e);
    expect(err.getStatus()).toBe(404);
    expect(repo.claimSourceConnection).toHaveBeenCalledTimes(1);
    expect(connector.disconnect).toHaveBeenCalledWith(expect.objectContaining({ remoteRef: 'remote-new' }));
    expect(connector.disconnect).toHaveBeenCalledWith(expect.objectContaining({ remoteRef: 'remote-old' }));
    expect(repo.updateSourceConnection).toHaveBeenCalledTimes(1);
    expect(repo.updateSourceConnection).toHaveBeenCalledWith(SRC, expect.objectContaining({ credentialsEncrypted: null, status: 'DISCONNECTED', lastError: 'source_archived' }));
    expect(repo.createAuditLog).not.toHaveBeenCalled();
  });

  it('connectExisting: lưu trữ GIỮA tạo kết nối và gọi provider -> 404 + credentials xoá, DISCONNECTED', async () => {
    const { svc, repo, connector } = setup(2, null);
    const err = await svc.connectExisting(T, 'user:u', SRC, body).catch((e: any) => e);
    expect(err.getStatus()).toBe(404);
    expect(repo.createSourceConnection).toHaveBeenCalledTimes(1);
    expect(connector.disconnect).toHaveBeenCalledWith(expect.objectContaining({ remoteRef: 'remote-new' }));
    expect(repo.updateSourceConnection).toHaveBeenCalledWith(SRC, expect.objectContaining({ credentialsEncrypted: null, status: 'DISCONNECTED' }));
  });

  it('L2: disconnect trên source đã lưu trữ giữ lời nhắc source_archived (không xoá lastError/lastFix)', async () => {
    const { svc, repo } = setup(0, { ...CONN, credentialsEncrypted: null });
    repo.findSourceById.mockImplementation(async () => ({ ...live, archivedAt: new Date() })); // includeArchived thấy
    await svc.disconnect(T, 'user:u', SRC);
    expect(repo.updateSourceConnection).toHaveBeenCalledWith(SRC, expect.objectContaining({ status: 'DISCONNECTED', lastError: 'source_archived', lastFix: expect.stringMatching(/dashboard provider/) }));
  });
});
