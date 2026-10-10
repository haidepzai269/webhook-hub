import { randomUUID } from 'crypto';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';
import { describeDb, newTestPrisma } from './support/test-db';

/**
 * S3-3 trên Postgres THẬT (RUN_DB_TESTS=1): truy vấn ứng viên `eventTypes && candidates` khớp
 * wildcard đúng như hàm thuần — `payment.*` nhận `payment.failed`, không nhận `paymentx.y`.
 */

describeDb('findActiveSubscriptionsForEventType — wildcard (Postgres, S3-3)', () => {
  const raw = newTestPrisma('owner');
  // AU6 (SPEC-verification §4.3): fixture bằng owner; repo (code đang test) bằng hub_app -> RLS có hiệu lực.
  const appDb = newTestPrisma('app');
  const tenant = randomUUID();
  const run = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const dest = await raw.destination.create({ data: { tenantId: tenant, name: `m-${run}`, type: 'webhook', configEncrypted: 'x' } });
    const subs: Record<string, string[]> = {
      wild: ['payment.*'],
      exact: ['payment.received'],
      link: ['payment.link.*'],
      all: ['*'],
      pay: ['pay.*'],
      bare: ['payment'],
    };
    for (const [name, eventTypes] of Object.entries(subs)) {
      ids[name] = (await raw.subscription.create({ data: { tenantId: tenant, destinationId: dest.id, name: `${name}-${run}`, eventTypes } })).id;
    }
  }, 60_000);

  afterAll(async () => {
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await appDb.$disconnect();
  });

  const names = async (type: string) => {
    const rows = await new TenantScopedRepository(appDb, tenant).findActiveSubscriptionsForEventType(type);
    return Object.entries(ids)
      .filter(([, id]) => rows.some((r) => r.id === id))
      .map(([n]) => n)
      .sort();
  };

  it('[AF:#12] payment.failed -> payment.* và *', async () => {
    expect(await names('payment.failed')).toEqual(['all', 'wild']);
  });

  it('payment.link.succeeded -> payment.*, payment.link.*, * (U17: không pay.*, không payment)', async () => {
    expect(await names('payment.link.succeeded')).toEqual(['all', 'link', 'wild']);
  });

  it('paymentx.y -> chỉ *', async () => {
    expect(await names('paymentx.y')).toEqual(['all']);
  });

  it('payment.received -> exact + wild + all; tenant khác -> rỗng', async () => {
    expect(await names('payment.received')).toEqual(['all', 'exact', 'wild']);
    expect(await new TenantScopedRepository(appDb, randomUUID()).findActiveSubscriptionsForEventType('payment.received')).toEqual([]);
  });
});

describeDb('findActiveSubscriptionsForEvent — lọc sourceIds (Postgres, S5)', () => {
  const raw = newTestPrisma('owner');
  const appDb = newTestPrisma('app'); // AU6: repo (code đang test) bằng hub_app
  const tenant = randomUUID();
  const run = randomUUID().slice(0, 8);
  const S1 = randomUUID();
  const S2 = randomUUID();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const dest = await raw.destination.create({ data: { tenantId: tenant, name: `m-${run}`, type: 'webhook', configEncrypted: 'x' } });
    const subs: Record<string, string[]> = { anySrc: [], onlyS1: [S1], s1s2: [S1, S2] };
    for (const [name, sourceIds] of Object.entries(subs)) {
      ids[name] = (await raw.subscription.create({ data: { tenantId: tenant, destinationId: dest.id, name: `${name}-${run}`, eventTypes: ['payment.*'], sourceIds } })).id;
    }
  }, 60_000);

  afterAll(async () => {
    await raw.subscription.deleteMany({ where: { tenantId: tenant } });
    await raw.destination.deleteMany({ where: { tenantId: tenant } });
    await raw.$disconnect();
    await appDb.$disconnect();
  });

  const names = async (sourceId: string | null) => {
    const rows = await new TenantScopedRepository(appDb, tenant).findActiveSubscriptionsForEvent('payment.received', sourceId);
    return Object.entries(ids).filter(([, id]) => rows.some((r) => r.id === id)).map(([n]) => n).sort();
  };

  it('[MS:U18] (phần a) sub sourceIds=[S1], event từ S2 -> không khớp; sourceIds=[] -> khớp', async () => {
    expect(await names(S2)).toEqual(['anySrc', 's1s2']);
    expect(await names(S1)).toEqual(['anySrc', 'onlyS1', 's1s2']);
    expect(await names(randomUUID())).toEqual(['anySrc']);
    expect(await names(null)).toEqual(['anySrc']);
  });
});
