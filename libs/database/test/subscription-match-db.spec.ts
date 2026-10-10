import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { TenantScopedRepository } from '../src/tenant-scoped.repository';

/**
 * S3-3 trên Postgres THẬT (RUN_DB_TESTS=1): truy vấn ứng viên `eventTypes && candidates` khớp
 * wildcard đúng như hàm thuần — `payment.*` nhận `payment.failed`, không nhận `paymentx.y`.
 */
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('findActiveSubscriptionsForEventType — wildcard (Postgres, S3-3)', () => {
  const raw = new PrismaClient();
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
  });

  const names = async (type: string) => {
    const rows = await new TenantScopedRepository(raw, tenant).findActiveSubscriptionsForEventType(type);
    return Object.entries(ids)
      .filter(([, id]) => rows.some((r) => r.id === id))
      .map(([n]) => n)
      .sort();
  };

  it('payment.failed -> payment.* và *', async () => {
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
    expect(await new TenantScopedRepository(raw, randomUUID()).findActiveSubscriptionsForEventType('payment.received')).toEqual([]);
  });
});
