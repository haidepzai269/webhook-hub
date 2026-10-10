jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import { Prisma } from '@prisma/client';
import { ProviderRegistry } from '@hub/providers';
import { NormalizeConsumer } from '../src/consumers/normalize.consumer';
import { classifyNormalizeError, NORMALIZE_MAX_RETRIES } from '../src/consumers/normalize-errors';

const TENANT = '00000000-0000-0000-0000-000000000001';

function prismaKnown(code: string) {
  return new Prisma.PrismaClientKnownRequestError(`fake ${code}`, { code, clientVersion: 'test' });
}

describe('classifyNormalizeError (S1-3)', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'])('Prisma %s -> transient', (code) => {
    expect(classifyNormalizeError(prismaKnown(code))).toBe('transient');
  });

  it.each(['P2002', 'P2003', 'P2025'])('Prisma %s (lỗi dữ liệu) -> permanent', (code) => {
    expect(classifyNormalizeError(prismaKnown(code))).toBe('permanent');
  });

  it('PrismaClientInitializationError -> transient', () => {
    expect(classifyNormalizeError(new Prisma.PrismaClientInitializationError('db down', 'test'))).toBe('transient');
  });

  it.each(['ECONNRESET', 'ETIMEDOUT'])('lỗi mạng %s -> transient', (code) => {
    expect(classifyNormalizeError(Object.assign(new Error('net'), { code }))).toBe('transient');
  });

  it('adapter ném lỗi / JSON hỏng / provider lạ -> permanent', () => {
    expect(classifyNormalizeError(new Error('adapter normalize failed'))).toBe('permanent');
    expect(classifyNormalizeError(new SyntaxError('Unexpected token'))).toBe('permanent');
    expect(classifyNormalizeError(new Error("Provider 'x' chưa đăng ký"))).toBe('permanent');
  });
});

describe('NormalizeConsumer (S1-1, S1-2, S1-3, S1-5)', () => {
  const rawEventId = '11111111-1111-1111-1111-111111111111';

  function buildChannel() {
    return { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn(), publish: jest.fn() } as any;
  }

  function buildMsg(headers: Record<string, unknown> = {}) {
    const payload = { rawEventId, sourceId: 'src-1', tenantId: TENANT, provider: 'github', correlationId: 'corr-1' };
    return { content: Buffer.from(JSON.stringify(payload)), properties: { headers: { 'x-correlation-id': 'corr-1', ...headers } } } as any;
  }

  function buildFakePrisma(opts: { subs?: number; findRawEvent?: jest.Mock } = {}) {
    const outboxRows: any[] = [];
    const subs = Array.from({ length: opts.subs ?? 2 }, (_, i) => ({
      id: `sub-${i}`,
      destination: { id: `dest-${i}`, name: `Đích ${i}`, type: 'webhook' },
    }));
    let deliverySeq = 0;
    const tx = {
      event: { create: jest.fn(async ({ data }: any) => data) },
      subscription: { findMany: jest.fn().mockResolvedValue(subs) },
      delivery: { create: jest.fn(async ({ data }: any) => ({ ...data, id: `del-${++deliverySeq}` })) },
      outbox: { create: jest.fn(async ({ data }: any) => outboxRows.push(data)) },
      processedMessage: { create: jest.fn().mockResolvedValue({}) },
    };
    const findRawEventById =
      opts.findRawEvent ??
      jest.fn().mockResolvedValue({
        id: rawEventId,
        headers: { 'x-github-event': 'push' },
        body: { repository: { name: 'r' } },
        bodyRaw: Buffer.from('{}'),
        contentType: 'application/json',
      });
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue({ findRawEventById }),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      rawEvent: { findUnique: jest.fn(() => { throw new Error('BB-5: không được gọi prisma.rawEvent trực tiếp'); }) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    return { prisma, tx, outboxRows, findRawEventById };
  }

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.NORMALIZE_FAULT_FIRST_N;
  });

  it('S2-2: MỘT publish hub:realtime:events cho mỗi raw event, kèm correlationId + deliveries[] (id/tên/loại đích)', async () => {
    const { prisma } = buildFakePrisma({ subs: 2 });
    const consumer = new NormalizeConsumer(prisma);
    const pub = (consumer as any).redisPub.publish as jest.Mock;
    await consumer.handleMessage(buildMsg(), buildChannel());

    expect(pub).toHaveBeenCalledTimes(1);
    const [channelName, raw] = pub.mock.calls[0];
    expect(channelName).toBe('hub:realtime:events');
    const notice = JSON.parse(raw);
    expect(notice).toMatchObject({ tenantId: TENANT, correlationId: 'corr-1', rawEventId });
    expect(notice.events.length).toBeGreaterThanOrEqual(1);
    expect(notice.deliveries).toHaveLength(2 * notice.events.length);
    expect(notice.deliveries[0]).toMatchObject({ deliveryId: 'del-1', destinationId: 'dest-0', destinationName: 'Đích 0', destinationType: 'webhook' });
    // không lộ cấu hình đích
    expect(raw).not.toMatch(/config|secret/i);
  });

  it('S1-2: mỗi delivery có 1 dòng outbox delivery.requested trong CÙNG transaction, KHÔNG gọi channel.publish', async () => {
    const { prisma, outboxRows } = buildFakePrisma({ subs: 2 });
    const consumer = new NormalizeConsumer(prisma);
    const channel = buildChannel();

    await consumer.handleMessage(buildMsg(), channel);

    expect(channel.publish).not.toHaveBeenCalled();
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.every((r) => r.topic === 'delivery.requested')).toBe(true);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('S1-1: payload outbox chỉ có tham chiếu — không config, signingSecret, event', async () => {
    const { prisma, outboxRows } = buildFakePrisma({ subs: 1 });
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), buildChannel());

    const payload = outboxRows[0].payload;
    expect(Object.keys(payload).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'tenantId']);
    expect(payload).toMatchObject({ deliveryId: 'del-1', tenantId: TENANT, attemptCount: 0, attemptGeneration: 1 });
  });

  it('S1-5: đọc raw_event qua repo.findRawEventById (scope tenant), không qua prisma.rawEvent', async () => {
    const { prisma, findRawEventById } = buildFakePrisma();
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), buildChannel());
    expect(prisma.forTenant).toHaveBeenCalledWith(TENANT);
    expect(findRawEventById).toHaveBeenCalledWith(rawEventId);
    expect(prisma.rawEvent.findUnique).not.toHaveBeenCalled();
  });

  it('S1-3: lỗi tạm -> q.normalize.retry.30s với header tăng dần; vượt 5 lần -> nack vào DLQ', async () => {
    const findRawEvent = jest.fn().mockRejectedValue(prismaKnown('P1001'));
    const { prisma } = buildFakePrisma({ findRawEvent });
    const consumer = new NormalizeConsumer(prisma);

    for (let n = 0; n < NORMALIZE_MAX_RETRIES; n++) {
      const channel = buildChannel();
      await consumer.handleMessage(buildMsg(n === 0 ? {} : { 'x-normalize-retry': n }), channel);
      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'q.normalize.retry.30s',
        expect.any(Buffer),
        expect.objectContaining({ persistent: true, headers: expect.objectContaining({ 'x-normalize-retry': n + 1 }) }),
      );
      expect(channel.ack).toHaveBeenCalledTimes(1);
      expect(channel.nack).not.toHaveBeenCalled();
    }

    // Lần thứ 6 (header = 5) -> DLQ
    const last = buildChannel();
    await consumer.handleMessage(buildMsg({ 'x-normalize-retry': NORMALIZE_MAX_RETRIES }), last);
    expect(last.sendToQueue).not.toHaveBeenCalled();
    expect(last.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('S1-3: lỗi dữ liệu (adapter ném) -> DLQ ngay, không retry', async () => {
    const { prisma } = buildFakePrisma();
    jest.spyOn(ProviderRegistry, 'get').mockReturnValue({
      normalize: () => {
        throw new Error('payload hỏng');
      },
    } as any);
    const channel = buildChannel();
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), channel);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('S1-3: NORMALIZE_FAULT_FIRST_N=2 tiêm 2 lỗi P1001 giả rồi chạy bình thường (chỉ ngoài production)', async () => {
    process.env.NORMALIZE_FAULT_FIRST_N = '2';
    const { prisma, outboxRows } = buildFakePrisma({ subs: 1 });
    const consumer = new NormalizeConsumer(prisma);

    const c1 = buildChannel();
    await consumer.handleMessage(buildMsg(), c1);
    const c2 = buildChannel();
    await consumer.handleMessage(buildMsg({ 'x-normalize-retry': 1 }), c2);
    const c3 = buildChannel();
    await consumer.handleMessage(buildMsg({ 'x-normalize-retry': 2 }), c3);

    expect(c1.sendToQueue).toHaveBeenCalledTimes(1);
    expect(c2.sendToQueue).toHaveBeenCalledTimes(1);
    expect(c3.sendToQueue).not.toHaveBeenCalled();
    expect(outboxRows).toHaveLength(1);
  });
});
