jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import { ProviderRegistry } from '@hub/providers';
import { NormalizeConsumer, CanonicalSchemaError, assertCanonical } from '../src/consumers/normalize.consumer';
import { classifyNormalizeError } from '../src/consumers/normalize-errors';
import { workerRegistry } from '../src/metrics';

const TENANT = '00000000-0000-0000-0000-000000000001';
const rawEventId = '11111111-1111-1111-1111-111111111111';

async function schemaErrors(source: string): Promise<number> {
  const m = await workerRegistry.getSingleMetric('hub_normalize_schema_errors_total')!.get();
  return m.values.find((v) => v.labels.source === source)?.value ?? 0;
}

function envelopeOf(type: string, data: Record<string, unknown>) {
  return {
    id: 'evt_x', tenantId: TENANT, type, source: 'sepay' as const, sourceId: 's', data,
    occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), correlationId: 'c', origin: 'webhook' as const, normalized: true,
  };
}

/**
 * U45 — adapter phát `payment.received` SAI khuôn -> lỗi vĩnh viễn (ADR-044): không có dòng `events`
 * hay `deliveries`, metric `hub_normalize_schema_errors_total{source}` +1, raw_event không bị đụng.
 */
describe('[MS:U45] U45 NormalizeConsumer kiểm catalog', () => {
  afterEach(() => jest.restoreAllMocks());

  function setup() {
    const tx = {
      event: { create: jest.fn() },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
      delivery: { create: jest.fn() },
      outbox: { create: jest.fn() },
      processedMessage: { create: jest.fn() },
    };
    const rawEventMutations = { update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() };
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue({
        findRawEventById: jest.fn().mockResolvedValue({ id: rawEventId, headers: {}, body: { id: 1 }, bodyRaw: Buffer.from('{"id":1}'), contentType: 'application/json' }),
      }),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      rawEvent: rawEventMutations,
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const channel = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn(), publish: jest.fn() } as any;
    const payload = { rawEventId, sourceId: 'src-1', tenantId: TENANT, provider: 'sepay', correlationId: 'corr-1' };
    const msg = { content: Buffer.from(JSON.stringify(payload)), properties: { headers: { 'x-correlation-id': 'corr-1' } } } as any;
    return { tx, prisma, channel, msg, rawEventMutations };
  }

  it('payment.received thiếu providerTxnId + amount thập phân -> DLQ, 0 event/delivery/outbox, metric +1', async () => {
    const { tx, prisma, channel, msg, rawEventMutations } = setup();
    const bad = envelopeOf('payment.received', {
      amount: 1.5, currency: 'VND', method: 'bank_transfer', reference: null, memo: null, counterparty: null,
      account: null, providerTxnId: 'x', paidAt: new Date().toISOString(), raw: {},
    });
    jest.spyOn(ProviderRegistry, 'get').mockReturnValue({ normalize: () => [bad] } as any);
    const before = await schemaErrors('sepay');

    await new NormalizeConsumer(prisma).handleMessage(msg, channel);

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false); // vĩnh viễn -> DLQ, không retry
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(tx.delivery.create).not.toHaveBeenCalled();
    expect(tx.outbox.create).not.toHaveBeenCalled();
    expect(Object.values(rawEventMutations).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(await schemaErrors('sepay')).toBe(before + 1);
  });

  it('assertCanonical: lỗi mang tên trường, phân loại permanent; kiểu không dành riêng thì bỏ qua', () => {
    let err: unknown;
    try {
      assertCanonical([envelopeOf('payment.received', { amount: 1 })], 'sepay');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CanonicalSchemaError);
    expect((err as CanonicalSchemaError).field).toBe('currency');
    expect(classifyNormalizeError(err)).toBe('permanent');
    expect(() => assertCanonical([envelopeOf('stripe.customer.created', { raw: {} })], 'stripe')).not.toThrow();
  });

  it('event đúng khuôn -> ghi events.normalized = true; kiểu chưa ánh xạ -> false', async () => {
    const { tx, prisma, channel, msg } = setup();
    const good = envelopeOf('payment.received', {
      amount: 1000, currency: 'VND', method: 'bank_transfer', reference: null, memo: 'DH1', counterparty: null,
      account: null, providerTxnId: '1', paidAt: new Date().toISOString(), raw: {},
    });
    const free = { ...envelopeOf('sepay.unknown', { raw: {} }), id: 'evt_y', normalized: false };
    jest.spyOn(ProviderRegistry, 'get').mockReturnValue({ normalize: () => [good, free] } as any);

    await new NormalizeConsumer(prisma).handleMessage(msg, channel);

    expect(channel.ack).toHaveBeenCalled();
    expect(tx.event.create.mock.calls.map((c: any) => c[0].data.normalized)).toEqual([true, false]);
  });

  it('review #4: truyền raw_events.received_at vào context normalize (receivedAt ổn định khi renormalize)', async () => {
    const { prisma, channel, msg } = setup();
    const at = new Date('2026-10-10T03:04:05.000Z');
    prisma.forTenant.mockReturnValue({
      findRawEventById: jest.fn().mockResolvedValue({ id: rawEventId, headers: {}, body: {}, bodyRaw: Buffer.from('{}'), contentType: null, receivedAt: at }),
    });
    const normalize = jest.fn().mockReturnValue([]);
    jest.spyOn(ProviderRegistry, 'get').mockReturnValue({ normalize } as any);
    await new NormalizeConsumer(prisma).handleMessage(msg, channel);
    expect(normalize.mock.calls[0][1].receivedAt).toBe('2026-10-10T03:04:05.000Z');
  });
});
