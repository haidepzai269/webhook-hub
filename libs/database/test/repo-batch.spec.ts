import { TenantScopedRepository } from '../src/tenant-scoped.repository';

/**
 * R-4 (review AU, ADR-119): ba phương thức nóng của đường giao chạy bằng batch transaction `[set_config, truy vấn]`
 * trên client gốc (không phải transaction tương tác); `RLS_HOT_BATCH=0` quay về transaction tương tác (để đo lại).
 */
describe('TenantScopedRepository — batch cho đường giao', () => {
  const T = '11111111-1111-4111-8111-111111111111';
  function fakeClient() {
    const calls: string[] = [];
    const lazy = (tag: string, value: unknown) => ({ tag, then: (ok: (v: unknown) => unknown) => Promise.resolve(value).then(ok) });
    const client: any = {
      $executeRaw: (strings: TemplateStringsArray, ...vals: unknown[]) => lazy(`set_config:${vals[0]}`, 1),
      delivery: { findFirst: (args: any) => lazy(`findFirst:${args.where.tenantId}`, { id: args.where.id }) },
      $transaction: (arg: any) => {
        if (Array.isArray(arg)) {
          calls.push(`batch[${arg.map((q: any) => q.tag).join(',')}]`);
          return Promise.all(arg);
        }
        calls.push('interactive');
        return arg(client);
      },
    };
    return { client, calls };
  }

  afterEach(() => delete process.env.RLS_HOT_BATCH);

  it('[AR:R-4] findDeliveryForSend / getDeliveryLeaseState: MỘT batch [set_config(tenant), truy vấn đã lọc tenant]; RLS_HOT_BATCH=0 -> transaction tương tác', async () => {
    const { client, calls } = fakeClient();
    const repo = new TenantScopedRepository(client, T);
    expect(await repo.findDeliveryForSend('d1')).toEqual({ id: 'd1' });
    expect(await repo.getDeliveryLeaseState('d2')).toEqual({ id: 'd2' });
    expect(calls).toEqual([`batch[set_config:${T},findFirst:${T}]`, `batch[set_config:${T},findFirst:${T}]`]);
    process.env.RLS_HOT_BATCH = '0';
    calls.length = 0;
    await repo.findDeliveryForSend('d3');
    expect(calls).toEqual(['interactive']);
  });
});
