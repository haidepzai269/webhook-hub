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
  CIRCUIT_DEFERRALS_HEADER,
  DeliveryConsumer,
  INFRA_DEFERRALS_HEADER,
  LogThrottle,
  deadErrorHeader,
  UNKNOWN_ERRORS_HEADER,
  UNKNOWN_ERROR_MAX,
} from '../src/consumers/delivery.consumer';
import { classifyInfraError } from '../src/consumers/infra-errors';
import { classifyNormalizeError } from '../src/consumers/normalize-errors';
import { deliveryInfraErrors } from '../src/metrics';
import { SenderRegistry } from '../src/senders/sender.registry';
import { EXCHANGES, ROUTING_KEYS } from '@hub/messaging';
import { buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg } from './delivery-fixtures';

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

/**
 * Review M2: header của message vào (bộ đếm circuit ADR-054, x-attempt, correlation) phải còn nguyên ở mọi nhánh
 * republish/DLX — mất `x-circuit-deferrals` là đích chết bị hoãn quá trần.
 */
const KEEP = { [CIRCUIT_DEFERRALS_HEADER]: 7, 'x-attempt': 2 };
function expectKept(headers: Record<string, unknown>) {
  expect(headers).toMatchObject({ ...KEEP, 'x-correlation-id': 'corr-1' });
}

/**
 * `[BP:T3]` (review L2-2): tìm lời gọi amqplib có thể requeue — đối số requeue phải ghi rõ `false`.
 * amqplib: nack(msg, allUpTo = false, requeue = true) · nackAll(requeue = true) · reject(msg, requeue = true).
 * Bỏ comment trước khi so; bỏ receiver `Promise` (Promise.reject không phải amqplib). Bắt cả lời gọi xuống dòng
 * (đối số lồng tối đa một cấp ngoặc). Receiver gồm cả `ch?.nack`, `getCh().nack`, `arr[i].nack` (review BP1 lượt 3).
 * Giới hạn đã biết: `nack` đã destructure khỏi channel; `ch['nack'](…)`; đối số lồng ngoặc từ 2 cấp; chuỗi chứa `//` hoặc
 * `/*` làm bước bỏ comment cắt mất code phía sau; bắt nhầm promise tự chế ngoài `Promise` (vd. `deferred.reject(err)`).
 */
function requeueCalls(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(/([\w$\])]+)\s*\??\.\s*(nackAll|nack|reject)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    if (m[1] === 'Promise') continue;
    const args = m[3].split(',').map((a) => a.trim()).filter(Boolean);
    const requeueArg = m[2] === 'nack' ? args[2] : m[2] === 'reject' ? args[1] : args[0];
    if (requeueArg !== 'false') out.push(m[0].replace(/\s+/g, ' '));
  }
  return out;
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
    await consumer.handleMessage(amqpMsg(buildSlimMsg({ attemptCount: 2 }), KEEP), ch1);
    expect(ch1.nack).not.toHaveBeenCalled();
    expect(ch1.sendToQueue).toHaveBeenCalledTimes(1);
    const [queue, content, opts] = ch1.sendToQueue.mock.calls[0];
    expect(queue).toBe('q.delivery.retry.10s');
    expect(JSON.parse(content.toString()).attemptCount).toBe(2);
    expect(opts.persistent).toBe(true);
    expect(opts.headers[INFRA_DEFERRALS_HEADER]).toBe(1);
    expectKept(opts.headers);
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
    expectKept(ch2.sendToQueue.mock.calls[0][2].headers);
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

    let msg = amqpMsg(buildSlimMsg({ attemptCount: 1 }), KEEP);
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
      expectKept(opts.headers);
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
    expectKept(opts.headers);
    expect(opts.headers['x-dead-error']).toBe("TypeError: Cannot read properties of undefined (reading 'destination')");
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

  it('[BP:T3] grep: không còn nack/reject có thể requeue (đối số requeue phải ghi rõ false) trong apps/hub-worker, apps/hub-api, libs', () => {
    const repoRoot = path.join(__dirname, '../../..');
    const roots = ['apps/hub-worker/src', 'apps/hub-api/src', 'libs'].map((r) => path.join(repoRoot, r));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'test') continue;
          walk(p);
        } else if (p.endsWith('.ts')) files.push(p);
      }
    };
    roots.forEach(walk);
    expect(files.some((f) => f.endsWith('delivery.consumer.ts'))).toBe(true);
    const offenders = files.flatMap((f) => requeueCalls(fs.readFileSync(f, 'utf8')).map((c) => `${path.relative(repoRoot, f)}: ${c}`));
    expect(offenders).toEqual([]);
    // Tự kiểm bộ quét: dạng phải bắt / không được bắt nhầm (review L2-2).
    expect(
      requeueCalls(
        'ch.nack(msg); ch.nack(msg, false); ch.reject(msg); ch.reject(m, true); ch.nackAll(); ch.nackAll(true);\n' +
          'ch?.nack(msg); getCh().nack(msg); chans[0].reject(msg);\n' +
          'ch.nack(\n  msg,\n  false,\n  true,\n);',
      ),
    ).toHaveLength(10);
    expect(
      requeueCalls(
        'Promise.reject(err); ch.nack(msg, false, false /* ghi chú */); ch.nackAll(false); ch.reject(msg, false);\n' +
          '// ch.nack(msg, false, true) trong comment\n/* ch.reject(msg) */',
      ),
    ).toEqual([]);
  });

  it('(review M1) lỗi unknown rải rác qua nhiều lần thử KHÔNG vào DLX: sang lần thử mới thì x-unknown-errors/x-infra-deferrals về 0', async () => {
    const row = buildDeliveryRow();
    const repo = {
      findDeliveryForSend: jest.fn().mockResolvedValue(row),
      claimForSend: jest.fn().mockResolvedValue(1),
      updateDeliveryStatus: jest.fn().mockResolvedValue({}),
      deferDelivery: jest.fn(),
      getDeliveryLeaseState: jest.fn(),
    };
    const tx = {
      deliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
      delivery: { findFirst: jest.fn().mockResolvedValue({ id: row.id }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processedMessage: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue(repo),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantTx: (_t: any, fn: any) => fn(tx),
    };
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 503, body: 'down', durationMs: 3 }) } as any);

    // Lần thử trước đã gặp 4 lỗi lạ + 3 lỗi hạ tầng liên tiếp; lần này gửi được (503) -> sang tầng retry kế.
    const ch = buildChannel();
    await consumer.handleMessage(
      amqpMsg(buildSlimMsg({ attemptCount: 1 }), { [UNKNOWN_ERRORS_HEADER]: UNKNOWN_ERROR_MAX - 1, [INFRA_DEFERRALS_HEADER]: 3 }),
      ch,
    );
    expect(ch.sendToQueue).toHaveBeenCalledTimes(1);
    const [queue, , opts] = ch.sendToQueue.mock.calls[0];
    expect(queue).toBe('q.delivery.retry.1m');
    expect(opts.headers[UNKNOWN_ERRORS_HEADER]).toBe(0);
    expect(opts.headers[INFRA_DEFERRALS_HEADER]).toBe(0);

    // Lỗi lạ đầu tiên của lần thử mới -> chỉ là lần 1, hoãn retry.1m, không DLX.
    repo.findDeliveryForSend.mockRejectedValueOnce(new Error('bug lạ'));
    const ch2 = buildChannel();
    await consumer.handleMessage(redelivered(ch), ch2);
    expect(ch2.publish).not.toHaveBeenCalled();
    expect(ch2.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
    expect(ch2.sendToQueue.mock.calls[0][2].headers[UNKNOWN_ERRORS_HEADER]).toBe(1);
  });

  it('[BP:T1] (phần c) P1001 SAU KHI đích đã nhận 2xx (ghi kết quả lỗi) -> retry.10s, attemptCount giữ nguyên; lần quay lại trong 60s thua lease -> hoãn 1m', async () => {
    // At-least-once (review L2-3): lần quay lại SAU 1m thắng lease đã hết hạn và GỬI LẠI cùng lần thử — đích dedupe
    // bằng `webhook-id = event.id` (giữ nguyên qua retry, webhook.sender.ts). Nếu DB vẫn chết thì vòng 10s lặp tiếp.
    // Test chỉ khẳng định khoảng trong 60s lease: không gọi đích lần hai.
    const row = buildDeliveryRow();
    const repo = {
      findDeliveryForSend: jest.fn().mockResolvedValue(row),
      claimForSend: jest.fn().mockResolvedValueOnce(1).mockResolvedValue(0),
      deferDelivery: jest.fn(),
      getDeliveryLeaseState: jest.fn().mockResolvedValue({ status: 'DELIVERING', attemptGeneration: 1, attemptCount: 0 }),
    };
    const prisma: any = {
      forTenant: jest.fn().mockReturnValue(repo),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantTx: jest.fn().mockRejectedValue(p1001()),
    };
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const send = jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 4 });
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send } as any);

    const ch = buildChannel();
    await consumer.handleMessage(amqpMsg(buildSlimMsg({ attemptCount: 0 }), KEEP), ch);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ch.nack).not.toHaveBeenCalled();
    const [queue, content, opts] = ch.sendToQueue.mock.calls[0];
    expect(queue).toBe('q.delivery.retry.10s');
    expect(JSON.parse(content.toString()).attemptCount).toBe(0);
    expect(opts.headers[INFRA_DEFERRALS_HEADER]).toBe(1);
    expectKept(opts.headers);
    expect(ch.ack).toHaveBeenCalledTimes(1);

    // 10s sau: lease 60s của lần gửi vừa rồi còn hạn -> nhánh hoãn 1 phút sẵn có, KHÔNG gọi đích lần nữa.
    const ch2 = buildChannel();
    await consumer.handleMessage(redelivered(ch), ch2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ch2.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
    expect(ch2.ack).toHaveBeenCalledTimes(1);
  });

  it('(review M3) log lỗi hạ tầng tối đa 1 dòng / 30s / tiến trình, kèm số lần bị gộp; metric vẫn đếm đủ', async () => {
    let now = 1_000_000;
    const t = new LogThrottle(30_000, () => now);
    expect(t.take()).toBe(0);
    now += 1_000;
    expect(t.take()).toBeNull();
    now += 10_000;
    expect(t.take()).toBeNull();
    now += 19_000; // đủ 30s kể từ dòng trước
    expect(t.take()).toBe(2);
    expect(t.take()).toBeNull();

    // Trên consumer thật: 20 message lỗi hạ tầng liên tiếp -> 1 dòng warn, 20 lần metric.
    const { prisma } = fakePrisma(p1001());
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'));
    const { logger } = await import('@hub/common');
    const warn = jest.fn();
    jest.spyOn(logger, 'child').mockReturnValue({ warn, error: jest.fn(), info: jest.fn(), debug: jest.fn() } as any);
    const before = await counterValue('transient');
    for (let i = 0; i < 20; i++) await consumer.handleMessage(amqpMsg(buildSlimMsg()), buildChannel());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await counterValue('transient')).toBe(before + 20);
  });

  it('x-dead-error chỉ giữ tên lỗi + message, cắt 200 ký tự, không stack', () => {
    const e = new RangeError('x'.repeat(500));
    const h = deadErrorHeader(e);
    expect(h.startsWith('RangeError: xxx')).toBe(true);
    expect(h).toHaveLength(200);
    expect(h).not.toMatch(/\n\s+at /);
  });

  it('(BP6, nợ §16 BP1) message delivery HỎNG: bản sao vào x.hub.delivery.dlx (x-dead-reason=parse_error, bỏ secret của message cũ) rồi ack — không nack(false) vứt message; publish ném -> không ack', async () => {
    const consumer = new DeliveryConsumer(fakePrisma(new Error('x')).prisma, buildFakeCircuitBreaker('CLOSED'));
    for (const body of [Buffer.from('không phải json'), Buffer.from(JSON.stringify({ config: { url: 'x' }, signingSecret: 's3cr3t', tenantId: 't' }))]) {
      const ch = buildChannel();
      await consumer.handleMessage({ content: body, properties: { headers: { 'x-correlation-id': 'c' } } } as any, ch);
      expect(ch.nack).not.toHaveBeenCalled();
      expect(ch.publish).toHaveBeenCalledTimes(1);
      const [ex, rk, content, opts] = ch.publish.mock.calls[0];
      expect([ex, rk]).toEqual([EXCHANGES.DELIVERY_DLX, ROUTING_KEYS.DEAD]);
      expect(opts.headers['x-dead-reason']).toBe('parse_error');
      expect(content.toString()).not.toMatch(/s3cr3t|config/);
      expect(ch.ack).toHaveBeenCalledTimes(1);
      expect(ch.publish.mock.invocationCallOrder[0]).toBeLessThan(ch.ack.mock.invocationCallOrder[0]);
    }
    // review BP6 TH-5: không phải JSON (vd. message cũ bị cắt cụt còn secret) -> KHÔNG đưa byte thô vào DLQ, chỉ giữ chỗ
    const cut = Buffer.from('{"deliveryId":"d","signingSecret":"s3cr3t-cut');
    const chCut = buildChannel();
    await consumer.handleMessage({ content: cut, properties: { headers: {} } } as any, chCut);
    const placeholder = JSON.parse(chCut.publish.mock.calls[0][2].toString());
    expect(placeholder).toEqual({ unparsable: true, bytes: cut.length, sha256: require('crypto').createHash('sha256').update(cut).digest('hex') });
    expect(chCut.publish.mock.calls[0][2].toString()).not.toMatch(/s3cr3t/);
    expect(chCut.publish.mock.calls[0][3].headers['x-dead-reason']).toBe('parse_error');
    // spill (BP5) cũng đi cùng đường
    const ch2 = buildChannel();
    consumer.spill({ content: Buffer.from('{'), properties: { headers: {} } } as any, ch2);
    expect(ch2.publish.mock.calls[0][3].headers['x-dead-reason']).toBe('parse_error');
    expect(ch2.nack).not.toHaveBeenCalled();
    // publish ném (channel đóng) -> không ack
    const ch3 = buildChannel();
    ch3.publish.mockImplementation(() => {
      throw new Error('Channel closed');
    });
    await consumer.handleMessage({ content: Buffer.from('x'), properties: { headers: {} } } as any, ch3);
    expect(ch3.ack).not.toHaveBeenCalled();
    expect(ch3.nack).not.toHaveBeenCalled();
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
