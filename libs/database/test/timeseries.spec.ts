import { randomUUID } from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma } from './support/test-db';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

/**
 * Phần UNIT: không cần DB. Bắt câu SQL mà repo sinh ra và kiểm tra (1) tenant_id duy nhất
 * xuất hiện trong tham số là tenant của repo, (2) bigint của Postgres được đổi sang number.
 */
describe('TenantScopedRepository.getTimeseries (unit)', () => {
  function repoWithCapture(rows: unknown[] = []) {
    const captured: Prisma.Sql[] = [];
    const fake = {
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
        captured.push(sql);
        return rows;
      }),
    };
    return { repo: new TenantScopedRepository(fake as any, TENANT_A), captured };
  }

  it('lọc cả events lẫn deliveries theo tenant của repo, không tenant nào khác', async () => {
    const { repo, captured } = repoWithCapture();
    await repo.getTimeseries('24h');

    expect(captured).toHaveLength(1);
    const sql = captured[0];
    expect(sql.text).toMatch(/hub\.events e[\s\S]*e\.tenant_id = \$\d+::uuid/);
    expect(sql.text).toMatch(/hub\.deliveries d[\s\S]*d\.tenant_id = \$\d+::uuid/);
    const uuidParams = sql.values.filter((v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v));
    expect(uuidParams).toEqual([TENANT_A, TENANT_A]);
  });

  it('24h → bucket giờ, 7d → bucket ngày', async () => {
    const h = repoWithCapture();
    await h.repo.getTimeseries('24h');
    expect(h.captured[0].values).toEqual(expect.arrayContaining(['hour', '1 hour', '23 hours']));

    const d = repoWithCapture();
    await d.repo.getTimeseries('7d');
    expect(d.captured[0].values).toEqual(expect.arrayContaining(['day', '1 day', '6 days']));
  });

  it('từ chối range lạ thay vì nội suy vào SQL', async () => {
    const { repo, captured } = repoWithCapture();
    await expect(repo.getTimeseries('1y' as any)).rejects.toThrow('TimeseriesRange');
    expect(captured).toHaveLength(0);
  });

  it('đổi bigint → number và bucket → ISO string', async () => {
    const { repo } = repoWithCapture([
      { bucket: new Date('2026-10-09T03:00:00Z'), events: 5n, succeeded: 3n, retrying: 1n, dead: 1n },
    ]);
    await expect(repo.getTimeseries('24h')).resolves.toEqual([
      { bucket: '2026-10-09T03:00:00.000Z', events: 5, succeeded: 3, retrying: 1, dead: 1 },
    ]);
  });
});

/**
 * Phần INTEGRATION: chạy trên Postgres local (docker-compose) khi đặt RUN_DB_TESTS=1.
 *   RUN_DB_TESTS=1 DATABASE_URL=postgresql://hub_user:hub_password@localhost:5433/webhook_hub?schema=hub npx jest timeseries
 * Dùng 2 tenant ngẫu nhiên riêng để không đụng dữ liệu demo, xoá sạch sau khi chạy.
 */

describeDb('TenantScopedRepository.getTimeseries (Postgres)', () => {
  const prisma = newTestPrisma('owner');
  // AU6 (SPEC-verification §4.3): fixture bằng owner; repo (code đang test) bằng hub_app -> RLS có hiệu lực.
  const appDb = newTestPrisma('app');
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const runId = randomUUID().slice(0, 8);
  const PERF_EVENTS = 10_000;

  beforeAll(async () => {
    const dest = await prisma.destination.create({
      data: { tenantId: tenantA, name: `ts-${runId}`, type: 'webhook', configEncrypted: 'x' },
    });
    const sub = await prisma.subscription.create({
      data: { tenantId: tenantA, destinationId: dest.id, name: `ts-${runId}`, eventTypes: ['t.test'] },
    });

    // Tenant A: 3 event trong giờ hiện tại, 2 delivery (1 SUCCEEDED, 1 DEAD).
    const now = new Date();
    const evIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `TS${runId}A${String(i).padStart(6, '0')}`;
      evIds.push(id);
      await prisma.event.create({
        data: {
          id, tenantId: tenantA, idempotencyKey: `ts:${runId}:a:${i}`, correlationId: randomUUID(),
          type: 't.test', source: 'test', data: {}, receivedAt: now,
        },
      });
    }
    await prisma.delivery.createMany({
      data: [
        { tenantId: tenantA, eventId: evIds[0], subscriptionId: sub.id, status: 'SUCCEEDED' },
        { tenantId: tenantA, eventId: evIds[1], subscriptionId: sub.id, status: 'DEAD' },
      ],
    });

    // Tenant B: 10k event rải trong 24h — vừa để thử cô lập, vừa đo hiệu năng.
    const rows: Prisma.EventCreateManyInput[] = [];
    for (let i = 0; i < PERF_EVENTS; i++) {
      rows.push({
        id: `TS${runId}B${String(i).padStart(6, '0')}`, tenantId: tenantB, idempotencyKey: `ts:${runId}:b:${i}`,
        correlationId: randomUUID(), type: 't.test', source: 'test', data: {},
        receivedAt: new Date(now.getTime() - (i % (23 * 60)) * 60_000),
      });
    }
    for (let i = 0; i < rows.length; i += 2000) {
      await prisma.event.createMany({ data: rows.slice(i, i + 2000) });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.delivery.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.event.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.subscription.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.destination.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
    await appDb.$disconnect();
  }, 60_000);

  const sum = (rows: { events: number; succeeded: number; dead: number }[], k: 'events' | 'succeeded' | 'dead') =>
    rows.reduce((acc, r) => acc + r[k], 0);

  it('tenant A chỉ thấy dữ liệu của A', async () => {
    const rows = await new TenantScopedRepository(appDb, tenantA).getTimeseries('24h');
    expect(rows).toHaveLength(24);
    expect(sum(rows, 'events')).toBe(3);
    expect(sum(rows, 'succeeded')).toBe(1);
    expect(sum(rows, 'dead')).toBe(1);
  });

  it('tenant B không thấy delivery nào của A, và đủ 10k event của mình', async () => {
    const rows = await new TenantScopedRepository(appDb, tenantB).getTimeseries('24h');
    expect(sum(rows, 'events')).toBe(PERF_EVENTS);
    expect(sum(rows, 'succeeded')).toBe(0);
    expect(sum(rows, 'dead')).toBe(0);
  });

  it('7d → 7 bucket ngày', async () => {
    const rows = await new TenantScopedRepository(appDb, tenantA).getTimeseries('7d');
    expect(rows).toHaveLength(7);
    expect(sum(rows, 'events')).toBe(3);
  });

  it('bucket không lệch khi session TimeZone có DST (generate_series 4 tham số)', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TimeZone = 'America/New_York'`);
      return new TenantScopedRepository(tx, tenantA).getTimeseries('7d');
    });
    expect(rows).toHaveLength(7);
    // Nửa đêm giờ Việt Nam (UTC+7, không DST) = 17:00 UTC.
    for (const r of rows) expect(new Date(r.bucket).getUTCHours()).toBe(17);
    expect(sum(rows, 'events')).toBe(3);
  });

  it('< 200ms với 10k event (DoD A-3)', async () => {
    const repo = new TenantScopedRepository(appDb, tenantB);
    await repo.getTimeseries('24h'); // warm-up (kết nối, plan cache)
    const t0 = performance.now();
    await repo.getTimeseries('24h');
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`getTimeseries(24h) với ${PERF_EVENTS} event: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(200);
  });
});
