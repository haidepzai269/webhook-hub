import { ProjectsController } from '../src/modules/console/projects.controller';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';

/**
 * ADR-235 (trang "Tất cả dự án", L0): `GET /api/v1/projects?include=stats` gắn số đếm cho TỪNG dự án qua MỘT lượt đọc
 * tổng hợp — escape hatch có tên theo membership (người thường) hoặc của operator (operator đã thấy mọi project ở GET này
 * từ trước). Không có `include` -> hành vi cũ, không đụng escape hatch. Bản Postgres thật (cô lập A/B): project-stats-db.spec.ts.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const created = new Date('2026-10-01T03:00:00Z');

const row = (tenantId: string, over: Record<string, unknown> = {}) => ({
  tenantId,
  createdAt: created,
  sources: 2,
  endpoints: 1,
  members: 3,
  events24h: 40,
  failedAttempts24h: 5,
  dlq: 2,
  circuitOpen: 1,
  storageLevel: 'LOCKED',
  openAlerts: { critical: 1, warning: 0, info: 2 },
  ...over,
});

const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return toErrorBody(e, 'r');
  }
  throw new Error('không ném lỗi');
};

function fakePrisma() {
  const calls: string[] = [];
  const prisma: any = {
    identity: () => ({
      listMemberships: async () => [
        { projectId: A, slug: 'a', name: 'A', environment: 'test', role: 'owner' },
        { projectId: B, slug: 'b', name: 'B', environment: 'live', role: 'viewer' },
      ],
    }),
    listProjects: async () => [
      { id: A, slug: 'a', name: 'A', environment: 'test', storageQuotaMb: null, createdAt: created },
      { id: C, slug: 'c', name: 'C', environment: 'test', storageQuotaMb: null, createdAt: created },
    ],
    operatorProjectUsage: async () => [],
    memberProjectStatsAcrossTenants: async (userId: string) => {
      calls.push(`member:${userId}`);
      return [row(A), row(B, { sources: 0, endpoints: 0, storageLevel: 'OK', dlq: 0, circuitOpen: 0, openAlerts: { critical: 0, warning: 0, info: 0 } })];
    },
    operatorProjectStatsAcrossTenants: async () => {
      calls.push('operator');
      return [row(A), row(C, { members: 0 })];
    },
  };
  return { prisma, calls };
}

const req = (isOperator: boolean) => ({ principal: { kind: 'user', id: 'user-1', isOperator } }) as any;

describe('GET /api/v1/projects?include=stats (ADR-235)', () => {
  it('người thường: đọc số đếm qua escape hatch THEO MEMBERSHIP của chính mình (userId), không đụng hatch operator; gắn `stats` theo id', async () => {
    const { prisma, calls } = fakePrisma();
    const out: any[] = await new ProjectsController(prisma).list(req(false), 'stats');
    expect(calls).toEqual(['member:user-1']);
    expect(out.map((p) => p.id)).toEqual([A, B]);
    expect(out[0].stats).toEqual({
      createdAt: created.toISOString(),
      sources: 2,
      endpoints: 1,
      members: 3,
      events24h: 40,
      failedAttempts24h: 5,
      dlq: 2,
      circuitOpen: 1,
      storageLevel: 'LOCKED',
      openAlerts: { critical: 1, warning: 0, info: 2 },
    });
    expect(out[1].stats).toMatchObject({ sources: 0, endpoints: 0, storageLevel: 'OK' });
  });

  it('operator: GET /projects vốn trả MỌI project cho operator -> số đếm qua hatch operator; project thiếu dòng số liệu -> stats null (không bịa 0)', async () => {
    const { prisma, calls } = fakePrisma();
    prisma.operatorProjectStatsAcrossTenants = async () => {
      calls.push('operator');
      return [row(A)];
    };
    const out: any[] = await new ProjectsController(prisma).list(req(true), 'stats');
    expect(calls).toEqual(['operator']);
    expect(out.map((p) => [p.id, p.stats === null ? null : p.stats.sources])).toEqual([
      [A, 2],
      [C, null],
    ]);
    expect(out[0]).toHaveProperty('usage'); // cột mức sử dụng của operator vẫn còn
  });

  it('không có include -> hành vi cũ: không gọi escape hatch thống kê, không có trường stats', async () => {
    const { prisma, calls } = fakePrisma();
    const out: any[] = await new ProjectsController(prisma).list(req(false));
    expect(calls).toEqual([]);
    expect(out[0]).not.toHaveProperty('stats');
  });

  it('include lạ -> 422 validation_failed (field include), không đọc gì', async () => {
    const { prisma, calls } = fakePrisma();
    const e = await errOf(new ProjectsController(prisma).list(req(false), 'rows'));
    expect(e.status).toBe(422);
    expect(e.body).toMatchObject({ error: 'validation_failed', field: 'include' });
    expect(calls).toEqual([]);
  });

  it('storageLevel lạ/null từ DB -> chuẩn hoá về nấc hợp lệ (parseStorageLevel), số đếm bigint/string -> number', async () => {
    const { prisma } = fakePrisma();
    prisma.memberProjectStatsAcrossTenants = async () => [row(A, { storageLevel: null, events24h: '7', dlq: BigInt(3) })];
    const out: any[] = await new ProjectsController(prisma).list(req(false), 'stats');
    expect(out[0].stats).toMatchObject({ storageLevel: 'OK', events24h: 7, dlq: 3 });
  });
});
