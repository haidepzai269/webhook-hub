jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import {
  DeliveryConsumer,
  INFRA_DEFERRALS_HEADER,
  UNKNOWN_ERRORS_HEADER,
  UNKNOWN_ERROR_MAX,
} from '../src/consumers/delivery.consumer';
import { classifyInfraError } from '../src/consumers/infra-errors';
import { classifyNormalizeError } from '../src/consumers/normalize-errors';
import { deliveryInfraErrors } from '../src/metrics';
import { SenderRegistry } from '../src/senders/sender.registry';
import { EXCHANGES, ROUTING_KEYS } from '@hub/messaging';
import { buildChannel, buildFakeCircuitBreaker, buildSlimMsg } from './delivery-fixtures';

/**
 * BP1 (SPEC-ap-luc-nguoc §2, ADR-195): `catch` ngoài cùng của DeliveryConsumer không bao giờ requeue ngay.
 * Lỗi hạ tầng -> retry.10s, không đốt lượt; lỗi lạ -> retry.1m, lần thứ 5 publish bản sao vào DELIVERY_DLX rồi ack.
 */
function fakePrisma(err: unknown) {
  const repo = {
    findDeliveryForSend: jest.fn().mockRejectedValue(err),
    claimForSend: jest.fn(),
    deferDelivery: jest.fn(),
  };
  const prisma: any = { forTenant: jest.fn().mockReturnValue(repo), processedMessage: { findUnique: jest.fn() } };
  return { prisma, repo };
}

function amqpMsg(body: unknown, headers: Record<string, unknown> = {}) {
  return { content: Buffer.from(JSON.stringify(body)), properties: { headers: { 'x-correlation-id': 'corr-1', ...headers } } } as any;
}

/** Message vừa republish -> message RabbitMQ sẽ giao lại sau TTL (header giữ nguyên khi dead-letter về queue chính). */
function redelivered(channel: any, call = 0) {
  const [, content, opts] = channel.sendToQueue.mock.calls[call];
  return { content, properties: { headers: opts.headers } } as any;
}

async function counterValue(kind: string): Promise<number> {
  const m = await deliveryInfraErrors.get();
  return m.values.find((v) => v.labels.kind === kind)?.value ?? 0;
}

const p1001 = () =>
  new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: '5.22.0' });

describe('BP1 — DeliveryConsumer không còn vòng lặp nóng requeue (ADR-195)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('[BP:T1] (phần a) Prisma P1001 ở bước 0 -> retry.10s, attemptCount giữ nguyên, x-infra-deferrals+1, ack, KHÔNG nack(requeue=true)', async () => {
    const { prisma } = fakePrisma(p1001());
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const send = jest.fn();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send } as any);
    const before = await counterValue('transient');

    const ch1 = buildChannel();
    await consumer.handleMessage(amqpMsg(buildSlimMsg({ attemptCount: 2 })), ch1);
    expect(ch1.nack).not.toHaveBeenCalled();
    expect(ch1.sendToQueue).toHaveBeenCalledTimes(1);
    const [queue, content, opts] = ch1.sendToQueue.mock.calls[0];
    expect(queue).toBe('q.delivery.retry.10s');
    expect(JSON.parse(content.toString()).attemptCount).toBe(2);
    expect(opts.persistent).toBe(true);
    expect(opts.headers[INFRA_DEFERRALS_HEADER]).toBe(1);
    expect(ch1.ack).toHaveBeenCalledTimes(1);
    // republish TRƯỚC ack: ack trước thì message mất nếu republish không tới.
    expect(ch1.sendToQueue.mock.invocationCallOrder[0]).toBeLessThan(ch1.ack.mock.invocationCallOrder[0]);
    expect(send).not.toHaveBeenCalled();
    expect(await counterValue('transient')).toBe(before + 1);

    // Lần giao lại vẫn lỗi hạ tầng: chỉ bộ đếm hoãn tăng, attemptCount vẫn 2, không bao giờ DLQ vì lỗi của hub.
    const ch2 = buildChannel();
    await consumer.handleMessage(redelivered(ch1), ch2);
    expect(ch2.nack).not.toHaveBeenCalled();
    expect(ch2.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.10s');
    expect(JSON.parse(ch2.sendToQueue.mock.calls[0][1].toString()).attemptCount).toBe(2);
    expect(ch2.sendToQueue.mock.calls[0][2].headers[INFRA_DEFERRALS_HEADER]).toBe(2);
  });

  it('[BP:T1] (phần b) PrismaClientInitializationError và ECONNRESET cũng là lỗi hạ tầng -> retry.10s', async () => {
    for (const err of [
      new Prisma.PrismaClientInitializationError('db down', '5.22.0'),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ]) {
      const { prisma } = fakePrisma(err);
      const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
      const ch = buildChannel();
      await consumer.handleMessage(amqpMsg(buildSlimMsg()), ch);
      expect(ch.nack).not.toHaveBeenCalled();
      expect(ch.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.10s');
      expect(ch.ack).toHaveBeenCalledTimes(1);
    }
  });

  it('[BP:T2] (phần a) lỗi unknown 5 lần liên tiếp -> 4 lần hoãn retry.1m rồi publish DLX ĐÚNG một lần + ack, không nack, không vòng lặp', async () => {
    const { prisma, repo } = fakePrisma(new TypeError("Cannot read properties of undefined (reading 'destination')"));
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const before = await counterValue('unknown');

    let msg = amqpMsg(buildSlimMsg({ attemptCount: 1 }));
    const nacks: unknown[][] = [];
    const dlx: any[][] = [];
    let republished = 0;
    for (let i = 1; i <= UNKNOWN_ERROR_MAX + 3; i++) {
      const ch = buildChannel();
      await consumer.handleMessage(msg, ch);
      nacks.push(...ch.nack.mock.calls);
      dlx.push(...ch.publish.mock.calls);
      if (ch.sendToQueue.mock.calls.length === 0) {
        // Bản sao đã vào DLQ: không còn bản nào quay lại -> vòng lặp dừng. Publish TRƯỚC ack.
        expect(ch.publish).toHaveBeenCalledTimes(1);
        expect(ch.ack).toHaveBeenCalledTimes(1);
        expect(ch.publish.mock.invocationCallOrder[0]).toBeLessThan(ch.ack.mock.invocationCallOrder[0]);
        break;
      }
      republished++;
      const [queue, content, opts] = ch.sendToQueue.mock.calls[0];
      expect(queue).toBe('q.delivery.retry.1m');
      expect(opts.headers[UNKNOWN_ERRORS_HEADER]).toBe(i);
      expect(JSON.parse(content.toString()).attemptCount).toBe(1);
      expect(ch.ack).toHaveBeenCalledTimes(1);
      msg = redelivered(ch);
    }
    expect(republished).toBe(UNKNOWN_ERROR_MAX - 1);
    // q.delivery.main không có DLX (topology.ts): nack(false) là vứt message -> phải publish thẳng vào DELIVERY_DLX.
    expect(nacks).toEqual([]);
    expect(dlx).toHaveLength(1);
    const [exchange, rk, content, opts] = dlx[0];
    expect(exchange).toBe(EXCHANGES.DELIVERY_DLX);
    expect(rk).toBe(ROUTING_KEYS.DEAD);
    expect(JSON.parse(content.toString())).toMatchObject({ deliveryId: buildSlimMsg().deliveryId, attemptCount: 1 });
    expect(opts.persistent).toBe(true);
    expect(opts.headers['x-dead-reason']).toBe('unknown_error');
    expect(opts.headers[UNKNOWN_ERRORS_HEADER]).toBe(UNKNOWN_ERROR_MAX);
    expect(repo.findDeliveryForSend).toHaveBeenCalledTimes(UNKNOWN_ERROR_MAX);
    expect(await counterValue('unknown')).toBe(before + UNKNOWN_ERROR_MAX);
  });

  it('[BP:T2] (phần b) publish DLX ném lỗi (channel đóng) -> KHÔNG ack (fail an toàn: RabbitMQ giao lại), không throw', async () => {
    const { prisma } = fakePrisma(new Error('bug lạ'));
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const ch = buildChannel();
    ch.publish.mockImplementation(() => {
      throw new Error('Channel closed');
    });
    await expect(
      consumer.handleMessage(amqpMsg(buildSlimMsg(), { [UNKNOWN_ERRORS_HEADER]: UNKNOWN_ERROR_MAX - 1 }), ch),
    ).resolves.toBeUndefined();
    expect(ch.publish).toHaveBeenCalledTimes(1);
    expect(ch.ack).not.toHaveBeenCalled();
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it('[BP:T3] grep: không còn nack(..., true) (requeue ngay) trong consumer nào', () => {
    const roots = ['apps/hub-worker/src', 'apps/hub-api/src'].map((r) => path.join(__dirname, '../../..', r));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    roots.forEach(walk);
    expect(files.some((f) => f.endsWith('delivery.consumer.ts'))).toBe(true);
    const offenders = files.flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .map((ln, i) => ({ f, i: i + 1, ln }))
        .filter(({ ln }) => /\.nack\([^)]*,\s*true\s*\)/.test(ln)),
    );
    expect(offenders).toEqual([]);
  });

  it('classifyInfraError: bảng mã giữ nguyên; classifyNormalizeError ánh xạ unknown -> permanent', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']) {
      const e = new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '5.22.0' });
      expect(classifyInfraError(e)).toBe('transient');
      expect(classifyNormalizeError(e)).toBe('transient');
    }
    for (const err of [
      new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: '5.22.0' }),
      new Error('adapter normalize failed'),
      null,
    ]) {
      expect(classifyInfraError(err)).toBe('unknown');
      expect(classifyNormalizeError(err)).toBe('permanent');
    }
    expect(classifyInfraError({ name: 'PrismaClientInitializationError' })).toBe('transient');
    expect(classifyInfraError(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } }))).toBe('transient');
  });
});
