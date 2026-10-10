import { TenantScopedRepository } from '../src/tenant-scoped.repository';

/** S1-5: phòng thủ chiều sâu ở repo — lọc tenant cả ở bảng con được join tới. */
describe('TenantScopedRepository — scope tenant ở quan hệ (S1-5, S1-1)', () => {
  const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  function fakeClient() {
    return {
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
      delivery: { findFirst: jest.fn().mockResolvedValue(null) },
      rawEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
  }

  it('findActiveSubscriptionsForEventType lọc destination.tenantId (không trả subscription trỏ sang đích tenant khác)', async () => {
    const client = fakeClient();
    await new TenantScopedRepository(client, T).findActiveSubscriptionsForEventType('payment.received');
    const where = client.subscription.findMany.mock.calls[0][0].where;
    // S3-3: ứng viên wildcard
    expect(where).toMatchObject({
      tenantId: T,
      isActive: true,
      eventTypes: { hasSome: ['payment.received', 'payment.*', '*'] },
      destination: { tenantId: T },
    });
  });

  it('[MS:U18] (phần b) findActiveSubscriptionsForEvent: không rõ source -> chỉ sub không lọc; có source -> rỗng HOẶC chứa source', async () => {
    const client = fakeClient();
    const repo = new TenantScopedRepository(client, T);
    await repo.findActiveSubscriptionsForEvent('payment.received', null);
    await repo.findActiveSubscriptionsForEvent('payment.received', 'S1');
    const [w0, w1] = client.subscription.findMany.mock.calls.map((c: any) => c[0].where);
    expect(w0).toMatchObject({ tenantId: T, isActive: true, destination: { tenantId: T }, OR: [{ sourceIds: { isEmpty: true } }] });
    expect(w1.OR).toEqual([{ sourceIds: { isEmpty: true } }, { sourceIds: { has: 'S1' } }]);
  });

  it('findDeliveryForSend lọc tenant ở delivery, subscription VÀ destination', async () => {
    const client = fakeClient();
    await new TenantScopedRepository(client, T).findDeliveryForSend('d1');
    const where = client.delivery.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: 'd1', tenantId: T, subscription: { tenantId: T, destination: { tenantId: T } } });
  });

  it('findRawEventById lọc qua source.tenantId (raw_events không có cột tenant_id)', async () => {
    const client = fakeClient();
    await new TenantScopedRepository(client, T).findRawEventById('r1');
    expect(client.rawEvent.findFirst.mock.calls[0][0].where).toEqual({ id: 'r1', source: { tenantId: T } });
  });
});
