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

  function buildFakePrisma(opts: { subs?: number; findRawEvent?: jest.Mock; verification?: string[] } = {}) {
    const outboxRows: any[] = [];
    const subs = Array.from({ length: opts.subs ?? 2 }, (_, i) => ({
      id: `sub-${i}`,
      destination: { id: `dest-${i}`, name: `Đích ${i}`, type: 'webhook', verification: opts.verification?.[i] ?? 'VERIFIED' },
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
        // S3-2: push đủ trường để qua validator catalog (repo.push)
        body: { ref: 'refs/heads/main', commits: [], repository: { name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r' }, sender: { login: 'u' } },
        bodyRaw: Buffer.from('{}'),
        contentType: 'application/json',
      });
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue({ findRawEventById }),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      rawEvent: { findUnique: jest.fn(() => { throw new Error('BB-5: không được gọi prisma.rawEvent trực tiếp'); }) },
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
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

  it('[AF:#16][MS:U29] S1-2: mỗi delivery có 1 dòng outbox delivery.requested trong CÙNG transaction, KHÔNG gọi channel.publish', async () => {
    const { prisma, outboxRows } = buildFakePrisma({ subs: 2 });
    const consumer = new NormalizeConsumer(prisma);
    const channel = buildChannel();

    await consumer.handleMessage(buildMsg(), channel);

    expect(channel.publish).not.toHaveBeenCalled();
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.every((r) => r.topic === 'delivery.requested')).toBe(true);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('[AF:#15] S1-1: payload outbox chỉ có tham chiếu — không config, signingSecret, event', async () => {
    const { prisma, outboxRows } = buildFakePrisma({ subs: 1 });
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), buildChannel());

    const payload = outboxRows[0].payload;
    expect(Object.keys(payload).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'tenantId']);
    expect(payload).toMatchObject({ deliveryId: 'del-1', tenantId: TENANT, attemptCount: 0, attemptGeneration: 1 });
  });

  it('[MS:U18] (phần c) S5: event lưu sourceId của raw_event; subscription lọc theo sourceIds (rỗng HOẶC chứa source)', async () => {
    const { prisma, tx } = buildFakePrisma({ subs: 1 });
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), buildChannel());
    expect(tx.event.create.mock.calls[0][0].data.sourceId).toBe('src-1');
    const where = tx.subscription.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ sourceIds: { isEmpty: true } }, { sourceIds: { has: 'src-1' } }]);
  });

  it('[MS:U30] S6: đích webhook PENDING/FAILED -> KHÔNG tạo delivery (không outbox); VERIFIED vẫn tạo', async () => {
    const { prisma, tx, outboxRows } = buildFakePrisma({ subs: 3, verification: ['PENDING', 'VERIFIED', 'FAILED'] });
    const channel = buildChannel();
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), channel);
    expect(tx.delivery.create).toHaveBeenCalledTimes(1);
    expect(tx.delivery.create.mock.calls[0][0].data.subscriptionId).toBe('sub-1');
    expect(outboxRows).toHaveLength(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('S8: verificationConfig của source (nạp CÙNG raw_event) được chuyển cho adapter.normalize — lõi không đọc', async () => {
    const cfg = { scheme: 'hmac-sha256', header: 'x-s', idempotency: { field: 'id' }, eventType: 'bank.x' };
    const findRawEvent = jest.fn().mockResolvedValue({
      id: rawEventId, headers: {}, body: { id: 1 }, bodyRaw: Buffer.from('{"id":1}'), contentType: 'application/json', source: { verificationConfig: cfg },
    });
    const { prisma, tx } = buildFakePrisma({ subs: 0, findRawEvent });
    const spy = jest.spyOn(ProviderRegistry.get('generic'), 'normalize');
    const msg = { content: Buffer.from(JSON.stringify({ rawEventId, sourceId: 'src-1', tenantId: TENANT, provider: 'generic', correlationId: 'corr-1' })), properties: { headers: {} } } as any;
    await new NormalizeConsumer(prisma).handleMessage(msg, buildChannel());
    expect(spy.mock.calls[0][1]).toMatchObject({ verificationConfig: cfg, sourceId: 'src-1' });
    expect(tx.event.create.mock.calls[0][0].data).toMatchObject({ type: 'bank.x', normalized: false });
  });

  it('[KN:U16] (phần e) event probe của provider (PayOS confirm-webhook) -> LƯU event probe:true, KHÔNG tra subscription (kể cả `*`), 0 delivery, 0 outbox, vẫn ack', async () => {
    // Bộ mẫu cố định của tài liệu PayOS (bằng chứng KQ1, SPEC-ket-noi §11). Lõi không biết đây là PayOS: chỉ đọc cờ `probe`.
    const data = { orderCode: 123, amount: 3000, description: 'VQRIO123', accountNumber: '12345678', reference: 'TF230204212323', transactionDateTime: '2023-02-04 18:25:00', currency: 'VND', paymentLinkId: '124c33293c43417ab7879e14c8d9eb18' };
    const findRawEvent = jest.fn().mockResolvedValue({
      id: rawEventId, headers: {}, body: { code: '00', desc: 'success', success: true, data, signature: 'x' }, bodyRaw: Buffer.from('{}'), contentType: 'application/json',
    });
    const { prisma, tx, outboxRows } = buildFakePrisma({ subs: 2, findRawEvent });
    const channel = buildChannel();
    const msg = { content: Buffer.from(JSON.stringify({ rawEventId, sourceId: 'src-1', tenantId: TENANT, provider: 'payos', correlationId: 'corr-1' })), properties: { headers: {} } } as any;
    await new NormalizeConsumer(prisma).handleMessage(msg, channel);
    expect(tx.event.create).toHaveBeenCalledTimes(1);
    expect(tx.event.create.mock.calls[0][0].data).toMatchObject({ type: 'payos.webhook_test', normalized: false, probe: true });
    expect(tx.subscription.findMany).not.toHaveBeenCalled();
    expect(tx.delivery.create).not.toHaveBeenCalled();
    expect(outboxRows).toHaveLength(0);
    expect(tx.processedMessage.create).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('[KN:U16] (phần f) event KHÔNG probe vẫn ghi probe:false và đi định tuyến như cũ', async () => {
    const { prisma, tx } = buildFakePrisma({ subs: 1 });
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), buildChannel());
    expect(tx.event.create.mock.calls[0][0].data.probe).toBe(false);
    expect(tx.subscription.findMany).toHaveBeenCalled();
    expect(tx.delivery.create).toHaveBeenCalledTimes(1);
  });

  it('[AF:#22] S1-5: đọc raw_event qua repo.findRawEventById (scope tenant), không qua prisma.rawEvent', async () => {
    const { prisma, findRawEventById } = buildFakePrisma();
    await new NormalizeConsumer(prisma).handleMessage(buildMsg(), buildChannel());
    expect(prisma.forTenant).toHaveBeenCalledWith(TENANT);
    expect(findRawEventById).toHaveBeenCalledWith(rawEventId);
    expect(prisma.rawEvent.findUnique).not.toHaveBeenCalled();
  });

  it('[AF:#18] S1-3: lỗi tạm -> q.normalize.retry.30s với header tăng dần; vượt 5 lần -> nack vào DLQ', async () => {
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
