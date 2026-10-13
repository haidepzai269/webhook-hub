jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import { CIRCUIT_DEFERRALS_HEADER, CIRCUIT_DEFERRED_SINCE_HEADER, DEFER_WRITTEN_AT_HEADER, DeliveryConsumer, countsTowardCircuit } from '../src/consumers/delivery.consumer';
import { CIRCUIT_MAX_DEFER_MS, circuitMaxDeferMs } from '@hub/messaging';
import { SenderRegistry } from '../src/senders/sender.registry';
import { Prisma } from '@prisma/client';
import {
  DB_CONFIG,
  DB_SIGNING_SECRET,
  DELIVERY_ID,
  TENANT_ID,
  buildChannel,
  buildDeliveryRow,
  buildFakeCircuitBreaker,
  buildLegacyMsg,
  buildSlimMsg,
  toAmqpMsg,
} from './delivery-fixtures';

/** BP2: bản republish mang gợi ý ĐÚNG với row vừa đọc (buildDeliveryRow: dest-1, rps 0). */
const ROW_HINT = { destinationId: 'dest-1', rateLimitRps: 0 };

/**
 * DeliveryConsumer (§3.3 Deliver, §5.4 Circuit breaker, S1-1 message chỉ mang tham chiếu, S1-2 lease)
 *
 * 1. BB-3 — không gọi sender.send() hai lần cho cùng một lần gửi (deliveryId + generation + attemptNo).
 * 2. §5.4 — circuit OPEN đẩy sang tầng retry DÀI NHẤT; throttle giữ tầng NGẮN nhất.
 * 3. S1-1 — cấu hình đích và signing secret LUÔN đọc từ DB, message chuyển tiếp không mang secret.
 * 4. S1-2 — claimForSend trả 0 (worker khác đã nhận) thì không gửi, chỉ ack.
 */
describe('DeliveryConsumer (§3.3, §5.4, S1-1, S1-2)', () => {
  function buildFakePrisma(opts: { row?: any; claim?: number; lease?: any } = {}) {
    const processed = new Set<string>();
    const row = opts.row === undefined ? buildDeliveryRow() : opts.row;

    const tx = {
      deliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
      delivery: {
        findFirst: jest.fn().mockResolvedValue({ id: DELIVERY_ID, tenantId: TENANT_ID }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      processedMessage: {
        create: jest.fn(async ({ data }: any) => {
          const key = `${data.consumer}:${data.messageId}`;
          if (processed.has(key)) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          processed.add(key);
          return data;
        }),
      },
    };

    const repo = {
      findDeliveryForSend: jest.fn().mockResolvedValue(row),
      claimForSend: jest.fn().mockResolvedValue(opts.claim ?? 1),
      updateDeliveryStatus: jest.fn().mockResolvedValue({}),
      deferDelivery: jest.fn().mockResolvedValue(1),
      getDeliveryLeaseState: jest.fn().mockResolvedValue(opts.lease ?? { status: 'SUCCEEDED', attemptGeneration: 1, attemptCount: 1 }),
    };

    const prisma: any = {
      forTenant: jest.fn().mockReturnValue(repo),
      processedMessage: {
        findUnique: jest.fn(async ({ where }: any) => {
          const key = `${where.consumer_messageId.consumer}:${where.consumer_messageId.messageId}`;
          return processed.has(key) ? { ...where.consumer_messageId } : null;
        }),
      },
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    return { prisma, repo, tx };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('không gọi sender.send() lần thứ hai khi message bị requeue sau khi đã COMMIT xong (processed_messages hit)', async () => {
    const { prisma } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const sendSpy = jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 10 });
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel1 = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(channel1.ack).toHaveBeenCalledTimes(1);
    expect(channel1.nack).not.toHaveBeenCalled();

    const channel2 = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel2);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(channel2.ack).toHaveBeenCalledTimes(1);
    expect(channel2.nack).not.toHaveBeenCalled();
  });

  it('transaction ném P2002 khi ghi processed_messages (race 2 worker) -> ack, không nack, không throw', async () => {
    const { prisma, tx } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const sendSpy = jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 10 });
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    tx.processedMessage.create = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`consumer`,`messageId`)', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['consumer', 'messageId'] },
      }),
    );

    const channel = buildChannel();
    await expect(consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel)).resolves.toBeUndefined();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('[BB:3] (phần c) gửi xong nhưng GHI KẾT QUẢ ném lỗi lạ (Error thường -> nhánh unknown của BP1: retry.1m) -> message quay lại, KHÔNG ack trước khi republish (ack trước khi lưu = mất bằng chứng giao, message không quay lại). Ca P1001 -> retry.10s nằm ở delivery-infra-errors.spec (BP:T1 phần c)', async () => {
    const { prisma } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 5 }) } as any);
    prisma.$transaction = jest.fn().mockRejectedValue(new Error('lỗi lạ khi ghi kết quả (không thuộc bảng mã hạ tầng)'));

    const channel = buildChannel();
    // Ack khi CHƯA có bản republish nào = message không còn đường quay lại.
    const ackBeforeRepublish = jest.fn();
    channel.ack.mockImplementation(() => {
      if (channel.sendToQueue.mock.calls.length === 0) ackBeforeRepublish();
    });
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);
    expect(ackBeforeRepublish).not.toHaveBeenCalled();
    // BP1: không còn requeue ngay; lỗi lạ -> retry.1m, attemptCount giữ nguyên (lần sau idempotency/lease quyết định).
    expect(channel.nack).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
    expect(JSON.parse(channel.sendToQueue.mock.calls[0][1].toString()).attemptCount).toBe(0);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('vẫn gửi lại ở tầng retry kế tiếp trong cùng generation (message_id khác), message retry GỌN', async () => {
    const { prisma } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const sendSpy = jest.fn().mockResolvedValue({ status: 503, body: 'down', error: 'Service Unavailable', durationMs: 10 });
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel1 = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg({ attemptCount: 0 })), channel1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(channel1.sendToQueue).toHaveBeenCalledWith('q.delivery.retry.10s', expect.any(Buffer), expect.anything());
    const retried = JSON.parse(channel1.sendToQueue.mock.calls[0][1].toString());
    expect(retried).toEqual({ ...buildSlimMsg({ attemptCount: 1 }), ...ROW_HINT });

    const channel2 = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg({ attemptCount: 1 })), channel2);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('[AF:#25] S2-1: circuit OPEN -> không gọi sender; vào q.delivery.retry.1m, attemptCount GIỮ NGUYÊN; ghi next_attempt_at; không publish', async () => {
    const { prisma, repo } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('OPEN'));
    const pub = (consumer as any).redisPub.publish as jest.Mock;
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    const before = Date.now();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg({ attemptCount: 2 })), channel);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(repo.claimForSend).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).toHaveBeenCalledWith('q.delivery.retry.1m', expect.any(Buffer), expect.anything());
    expect(JSON.parse(channel.sendToQueue.mock.calls[0][1].toString())).toEqual({ ...buildSlimMsg({ attemptCount: 2 }), ...ROW_HINT });
    const [, nextAt] = repo.deferDelivery.mock.calls[0];
    expect(nextAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(pub).not.toHaveBeenCalled(); // DEFERRED không publish (ngân sách Redis)
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('S2-1: HALF_OPEN mà KHÔNG giành được probe -> xử lý như OPEN (1m), không gửi', async () => {
    const { prisma } = buildFakePrisma();
    const cb = buildFakeCircuitBreaker('HALF_OPEN', { probe: false });
    const consumer = new DeliveryConsumer(prisma, cb);
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);
    expect(cb.tryAcquireProbe).toHaveBeenCalledWith('dest-1');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledWith('q.delivery.retry.1m', expect.anything(), expect.anything());
  });

  it('S2-1: HALF_OPEN giành được probe -> gửi thử; thành công -> recordSuccess với view HALF_OPEN', async () => {
    const { prisma } = buildFakePrisma({ row: buildDeliveryRow({ circuitState: 'OPEN' }) });
    const cb = buildFakeCircuitBreaker('HALF_OPEN', { probe: true });
    const consumer = new DeliveryConsumer(prisma, cb);
    const sendSpy = jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 7 });
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // DB đang ghi OPEN, Redis suy ra HALF_OPEN -> đồng bộ trước khi gửi
    expect(cb.syncObserved).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: 'dest-1', tenantId: TENANT_ID }),
      expect.objectContaining({ state: 'HALF_OPEN' }),
    );
    expect(cb.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({ destinationId: 'dest-1' }), expect.objectContaining({ state: 'HALF_OPEN' }));
  });

  it('S2-1: giành probe nhưng lease thua (claim=0) -> nhả probe, không gửi', async () => {
    const { prisma } = buildFakePrisma({ claim: 0 });
    const cb = buildFakeCircuitBreaker('HALF_OPEN', { probe: true });
    const consumer = new DeliveryConsumer(prisma, cb);
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), buildChannel());
    expect(sendSpy).not.toHaveBeenCalled();
    expect(cb.releaseProbe).toHaveBeenCalledWith('dest-1', 'probe-token');
  });

  it('review SPEC-1 #3: claim thua vì lease DELIVERING còn hạn cho ĐÚNG lần gửi -> hoãn vào 1m (không bỏ), không gửi', async () => {
    const { prisma } = buildFakePrisma({ claim: 0, lease: { status: 'DELIVERING', attemptGeneration: 1, attemptCount: 0 } });
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);
    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledWith('q.delivery.retry.1m', expect.anything(), expect.anything());
    expect(JSON.parse(channel.sendToQueue.mock.calls[0][1].toString())).toEqual({ ...buildSlimMsg(), ...ROW_HINT });
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('review SPEC-1 #3: claim thua mà delivery đã sang lần thử khác / đã xong -> ack bỏ, không đẩy lại', async () => {
    for (const lease of [
      { status: 'SUCCEEDED', attemptGeneration: 1, attemptCount: 1 },
      { status: 'DELIVERING', attemptGeneration: 1, attemptCount: 3 },
      { status: 'RETRYING', attemptGeneration: 1, attemptCount: 1 },
    ]) {
      const { prisma } = buildFakePrisma({ claim: 0, lease });
      const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
      jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn() } as any);
      const channel = buildChannel();
      await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);
      expect(channel.sendToQueue).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalledTimes(1);
    }
  });

  // ---------------- S2-2 ----------------

  it('S2-2: RETRYING ghi next_attempt_at = now + TTL tầng kế và publish delivery.attempt đủ trường', async () => {
    const { prisma, tx } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const pub = (consumer as any).redisPub.publish as jest.Mock;
    jest
      .spyOn(SenderRegistry, 'get')
      .mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 503, body: 'x', durationMs: 12 }) } as any);

    const before = Date.now();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg({ attemptCount: 0 })), buildChannel());

    const data = tx.delivery.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('RETRYING');
    expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 10_000);
    expect(data.nextAttemptAt.getTime()).toBeLessThan(before + 20_000);

    expect(pub).toHaveBeenCalledTimes(1);
    const [channelName, raw] = pub.mock.calls[0];
    expect(channelName).toBe('hub:realtime:deliveries');
    expect(JSON.parse(raw)).toMatchObject({
      tenantId: TENANT_ID,
      correlationId: 'corr-1',
      eventId: 'evt-1',
      deliveryId: DELIVERY_ID,
      destinationId: 'dest-1',
      attemptNo: 1,
      generation: 1,
      status: 'RETRYING',
      httpStatus: 503,
      ms: 12,
      nextQueue: 'q.delivery.retry.10s',
    });
    expect(JSON.parse(raw).nextAttemptAt).toEqual(data.nextAttemptAt.toISOString());
  });

  it('S2-2: SUCCEEDED xoá next_attempt_at và publish status SUCCEEDED kèm httpStatus/ms', async () => {
    const { prisma, tx } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const pub = (consumer as any).redisPub.publish as jest.Mock;
    jest
      .spyOn(SenderRegistry, 'get')
      .mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 204, body: '', durationMs: 5 }) } as any);
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), buildChannel());
    expect(tx.delivery.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'SUCCEEDED', nextAttemptAt: null });
    expect(JSON.parse(pub.mock.calls[0][1])).toMatchObject({ status: 'SUCCEEDED', httpStatus: 204, ms: 5, attemptNo: 1 });
  });

  it('outbound throttle (rateLimitRps đọc từ DB) hết token -> giữ tầng NGẮN nhất (10s)', async () => {
    const { prisma } = buildFakePrisma({ row: buildDeliveryRow({ rateLimitRps: 5 }) });
    const cb = buildFakeCircuitBreaker('CLOSED');
    // Review SPEC-3 #2: throttle đọc cùng lệnh với circuit (getState trả throttleAllowed)
    cb.getState.mockResolvedValue({ state: 'CLOSED', failures: 0, throttleAllowed: false });
    const consumer = new DeliveryConsumer(prisma, cb);
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);

    expect(cb.getState).toHaveBeenCalledWith('dest-1', 5);
    expect(cb.checkThrottle).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledWith('q.delivery.retry.10s', expect.anything(), expect.anything());
  });

  // ---------------- S1-1 ----------------

  it('S1-1: message KIỂU CŨ (có config/signingSecret giả) vẫn gửi bằng config + secret đọc từ DB', async () => {
    const { prisma, repo } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const sendSpy = jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 10 });
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildLegacyMsg()), channel);

    expect(repo.findDeliveryForSend).toHaveBeenCalledWith(DELIVERY_ID);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [config, , event, signingSecret] = sendSpy.mock.calls[0];
    expect(config).toEqual(DB_CONFIG);
    expect(signingSecret).toBe(DB_SIGNING_SECRET);
    expect(event.id).toBe('evt-1');
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('S1-1: message kiểu cũ bị hoãn (circuit OPEN) được đẩy tiếp dưới dạng GỌN — không còn config/signingSecret/event', async () => {
    const { prisma } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('OPEN'));
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn() } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildLegacyMsg()), channel);

    const forwarded = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString());
    // BP2: destinationId/rateLimitRps của message cũ chỉ còn là GỢI Ý (luôn kiểm lại với DB), không phải cấu hình gửi.
    expect(Object.keys(forwarded).sort()).toEqual(['attemptCount', 'attemptGeneration', 'correlationId', 'deliveryId', 'destinationId', 'rateLimitRps', 'tenantId']);
  });

  it('S1-1: DEAD -> bản sao vào DLQ là message GỌN', async () => {
    const { prisma } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    jest
      .spyOn(SenderRegistry, 'get')
      .mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 404, body: 'nope', durationMs: 1 }) } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildLegacyMsg()), channel);

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const dead = JSON.parse(channel.publish.mock.calls[0][2].toString());
    expect(dead).not.toHaveProperty('config');
    expect(dead).not.toHaveProperty('signingSecret');
    expect(dead).not.toHaveProperty('event');
  });

  it('S1-1: delivery không còn trong DB (đã xoá) -> ack + không gửi', async () => {
    const { prisma } = buildFakePrisma({ row: null });
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  // ---------------- S1-2 ----------------

  it('S1-2: claimForSend trả 0 (worker khác đã nhận lần gửi này) -> không gửi, chỉ ack', async () => {
    const { prisma, repo } = buildFakePrisma({ claim: 0 });
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);

    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg({ attemptCount: 2, attemptGeneration: 3 })), channel);

    expect(repo.claimForSend).toHaveBeenCalledWith(DELIVERY_ID, 3, 2);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  // ---------------- Review SPEC-2 #3 (ADR-054): chỉ lỗi phía đích tính vào circuit ----------------

  it.each([400, 401, 403, 404, 410, 422])('#3: HTTP %i -> DEAD như cũ nhưng KHÔNG gọi recordFailure', async (status) => {
    const { prisma, tx } = buildFakePrisma();
    const cb = buildFakeCircuitBreaker('CLOSED');
    const consumer = new DeliveryConsumer(prisma, cb);
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status, body: 'x', durationMs: 1 }) } as any);
    const channel = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);
    expect(cb.recordFailure).not.toHaveBeenCalled();
    expect(tx.delivery.updateMany.mock.calls[0][0].data.status).toBe('DEAD');
    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 408, 429])('#3: HTTP %i -> recordFailure (lỗi phía đích)', async (status) => {
    const { prisma } = buildFakePrisma();
    const cb = buildFakeCircuitBreaker('CLOSED');
    const consumer = new DeliveryConsumer(prisma, cb);
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status, body: 'x', durationMs: 1 }) } as any);
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), buildChannel());
    expect(cb.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('#3: lỗi mạng/timeout (sender trả 500 + error) -> recordFailure', async () => {
    const { prisma } = buildFakePrisma();
    const cb = buildFakeCircuitBreaker('CLOSED');
    const consumer = new DeliveryConsumer(prisma, cb);
    jest
      .spyOn(SenderRegistry, 'get')
      .mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 500, error: 'connect ECONNREFUSED', durationMs: 1 }) } as any);
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), buildChannel());
    expect(cb.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('[MS:U28] S10: sender trả timeout (500 + error chứa "timeout") -> RETRYING (không DEAD), recordFailure được gọi', async () => {
    const { prisma, tx } = buildFakePrisma();
    const cb = buildFakeCircuitBreaker('CLOSED');
    const consumer = new DeliveryConsumer(prisma, cb);
    jest
      .spyOn(SenderRegistry, 'get')
      .mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 500, error: 'timeout tổng 5000ms (AbortSignal)', durationMs: 5000 }) } as any);
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), buildChannel());
    expect(cb.recordFailure).toHaveBeenCalledTimes(1);
    expect(tx.delivery.updateMany.mock.calls[0][0].data.status).toBe('RETRYING');
  });

  it('#3: probe HALF_OPEN nhận 404 -> nhả probe (đúng token), giữ HALF_OPEN (không recordFailure/recordSuccess)', async () => {
    const { prisma } = buildFakePrisma();
    const cb = buildFakeCircuitBreaker('HALF_OPEN', { probe: true });
    const consumer = new DeliveryConsumer(prisma, cb);
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 404, body: 'x', durationMs: 1 }) } as any);
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), buildChannel());
    expect(cb.recordFailure).not.toHaveBeenCalled();
    expect(cb.recordSuccess).not.toHaveBeenCalled();
    expect(cb.releaseProbe).toHaveBeenCalledWith('dest-1', 'probe-token');
  });

  it('#3: countsTowardCircuit — bảng quyết định', () => {
    for (const s of [0, 500, 502, 503, 504, 408, 429]) expect(countsTowardCircuit(s)).toBe(true);
    for (const s of [200, 204, 400, 401, 403, 404, 409, 410, 413, 422]) expect(countsTowardCircuit(s)).toBe(false);
  });

  // ---------------- Review SPEC-2 #4 (ADR-054): trần hoãn vì circuit ----------------

  const withDeferrals = (body: unknown, n: number) => {
    const m = toAmqpMsg(body);
    m.properties.headers[CIRCUIT_DEFERRALS_HEADER] = n;
    return m;
  };
  /** BP2: đã hoãn từ `agoMs` trước (trần tính theo thời gian). */
  const deferredSince = (body: unknown, agoMs: number) => {
    const m = toAmqpMsg(body);
    m.properties.headers[CIRCUIT_DEFERRALS_HEADER] = 30;
    m.properties.headers[CIRCUIT_DEFERRED_SINCE_HEADER] = Date.now() - agoMs;
    m.properties.headers[DEFER_WRITTEN_AT_HEADER] = Date.now() - 30_000;
    return m;
  };
  const OVER_CAP = CIRCUIT_MAX_DEFER_MS + 60_000;

  it('#4: mỗi lần hoãn +1 header x-circuit-deferrals (thiếu header = 0)', async () => {
    const { prisma } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('OPEN'));
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn() } as any);
    const c1 = buildChannel();
    await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), c1);
    expect(c1.sendToQueue.mock.calls[0][2].headers[CIRCUIT_DEFERRALS_HEADER]).toBe(1);
    const c2 = buildChannel();
    await consumer.handleMessage(withDeferrals(buildSlimMsg(), 7), c2);
    expect(c2.sendToQueue.mock.calls[0][2].headers[CIRCUIT_DEFERRALS_HEADER]).toBe(8);
  });

  it('[BP:T9] (phần a) #4: vượt trần THỜI GIAN CIRCUIT_MAX_DEFER_MS -> ghi attempt "circuit OPEN quá lâu", RETRYING tầng kế theo attemptCount, xoá since, KHÔNG gọi đích/không chạm circuit', async () => {
    const { prisma, repo, tx } = buildFakePrisma();
    const cb = buildFakeCircuitBreaker('OPEN');
    const consumer = new DeliveryConsumer(prisma, cb);
    const sendSpy = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: sendSpy } as any);
    const channel = buildChannel();
    const before = Date.now();
    await consumer.handleMessage(deferredSince(buildSlimMsg({ attemptCount: 1 }), OVER_CAP), channel);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(cb.recordFailure).not.toHaveBeenCalled();
    expect(repo.claimForSend).toHaveBeenCalledWith(DELIVERY_ID, 1, 1); // vẫn qua lease -> không nhân bản với sweeper
    const attempt = tx.deliveryAttempt.create.mock.calls[0][0].data;
    expect(attempt).toMatchObject({ attemptNo: 2, responseStatus: null });
    expect(attempt.error).toMatch(/circuit OPEN quá lâu/);
    const data = tx.delivery.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('RETRYING');
    expect(data.attemptCount).toBe(2);
    // tầng kế sau lần thử thứ 2 là retry.1m (getNextRetryQueue theo attemptCount, như lỗi retryable)
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
    expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(data.nextAttemptAt.getTime()).toBeLessThan(before + 120_000);
    const [, , opts] = channel.sendToQueue.mock.calls[0];
    expect(opts.headers[CIRCUIT_DEFERRALS_HEADER]).toBe(0); // lần thử mới -> đếm lại
    expect(opts.headers).not.toHaveProperty(CIRCUIT_DEFERRED_SINCE_HEADER); // BP2: lần thử thật -> xoá since
    expect(opts.headers).not.toHaveProperty(DEFER_WRITTEN_AT_HEADER);
    expect(JSON.parse(channel.sendToQueue.mock.calls[0][1].toString())).toEqual({ ...buildSlimMsg({ attemptCount: 2 }), ...ROW_HINT });
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('#4: vượt trần ở lần thử cuối -> DEAD + DLQ', async () => {
    const { prisma, tx } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('OPEN'));
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn() } as any);
    const channel = buildChannel();
    await consumer.handleMessage(deferredSince(buildSlimMsg({ attemptCount: 5 }), OVER_CAP), channel);
    const data = tx.delivery.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('DEAD');
    expect(data.lastError).toMatch(/circuit OPEN quá lâu/);
    expect(channel.publish).toHaveBeenCalledTimes(1);
  });

  it('[BP:T9] (phần b) CIRCUIT_MAX_DEFER_MS: mặc định 30 phút từ @hub/messaging; env chỉ KẸP THẤP HƠN (C2); bậy -> mặc định', () => {
    expect(CIRCUIT_MAX_DEFER_MS).toBe(1_800_000);
    expect(circuitMaxDeferMs(undefined)).toBe(CIRCUIT_MAX_DEFER_MS);
    expect(circuitMaxDeferMs('600000')).toBe(600_000);
    expect(circuitMaxDeferMs('99999999')).toBe(CIRCUIT_MAX_DEFER_MS); // cao hơn -> kẹp (sàn dọn QT không theo kịp)
    expect(circuitMaxDeferMs('0')).toBe(CIRCUIT_MAX_DEFER_MS);
    // review BP2 TH-2: dương nhưng quá nhỏ -> kẹp dưới 60s (một vòng hoãn), không đốt lượt ngay mỗi lần OPEN
    expect(circuitMaxDeferMs('0.5')).toBe(60_000);
    expect(circuitMaxDeferMs('1')).toBe(60_000);
    expect(circuitMaxDeferMs('59999')).toBe(60_000);
    expect(circuitMaxDeferMs('60000')).toBe(60_000);
    expect(circuitMaxDeferMs('abc')).toBe(CIRCUIT_MAX_DEFER_MS);
  });

  it('#4: HALF_OPEN không giành được probe cũng đếm và cũng chịu trần (thời gian, BP2)', async () => {
    const { prisma, tx } = buildFakePrisma();
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('HALF_OPEN', { probe: false }));
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn() } as any);
    await consumer.handleMessage(deferredSince(buildSlimMsg(), OVER_CAP), buildChannel());
    expect(tx.deliveryAttempt.create.mock.calls[0][0].data.error).toMatch(/circuit HALF_OPEN quá lâu/);
  });
});
