jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});

import { Prisma } from '@prisma/client';
import { logger } from '@hub/common';
import { NORMALIZE_MAX_DEFER_MS, normalizeMaxDeferMs } from '@hub/messaging';
import { FailureRateController, backpressureOptionsFromEnv } from '../src/backpressure/failure-rate.controller';
import { runGated } from '../src/backpressure/gate';
import { gracefulStop } from '../src/shutdown';
import { InFlightTracker } from '../src/consumers/in-flight';
import { DeliveryConsumer } from '../src/consumers/delivery.consumer';
import { NORMALIZE_DEFERRED_SINCE_HEADER, NormalizeConsumer } from '../src/consumers/normalize.consumer';
import { NORMALIZE_RETRY_HEADER } from '../src/consumers/normalize-errors';
import { classifyInfraError } from '../src/consumers/infra-errors';
import { classifyNormalizeError } from '../src/consumers/normalize-errors';
import { SenderRegistry } from '../src/senders/sender.registry';
import { backpressureFactor } from '../src/metrics';
import { buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg } from './delivery-fixtures';

/**
 * BP5 (SPEC-ap-luc-nguoc §7, C5, ADR-200): áp lực ngược kiểu Canva cho hạ tầng của chính hub (`db`).
 */
const p1001 = () => new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: '5.22.0' });
const amqp = (body: unknown, headers: Record<string, unknown> = {}) =>
  ({ content: Buffer.from(JSON.stringify(body)), properties: { headers: { 'x-correlation-id': 'corr-1', ...headers } } }) as any;

function clockController(o: Partial<ConstructorParameters<typeof FailureRateController>[0]> = {}) {
  let now = 1_800_000_000_000;
  const c = new FailureRateController({ dependency: 'db', now: () => now, ...o });
  return { c, advance: (ms: number) => (now += ms), at: () => now };
}

describe('BP5 — FailureRateController', () => {
  it('[BP:T17] (phần a) tỷ lệ lỗi 0% -> factor 0; 50% trong 5s -> factor 1; về 0% -> giảm dần từng 0.1, không nhảy', () => {
    const { c, advance } = clockController();
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 20; i++) c.record('ok');
      advance(1000);
      c.tick();
    }
    expect(c.factor()).toBe(0);
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 10; i++) c.record('ok');
      for (let i = 0; i < 10; i++) c.record('infra_fail');
      advance(1000);
      c.tick();
    }
    expect(c.factor()).toBe(1);
    expect(c.permits()).toBe(1);
    const seen: number[] = [];
    for (let s = 0; s < 60; s++) {
      for (let i = 0; i < 20; i++) c.record('ok');
      advance(1000);
      const before = c.factor();
      c.tick();
      expect(before - c.factor()).toBeLessThanOrEqual(0.1 + 1e-9); // không nhảy
      seen.push(c.factor());
    }
    expect(seen.at(-1)).toBe(0);
    expect(seen.some((f) => f > 0 && f < 1)).toBe(true); // đi qua các bậc trung gian
  });

  it('[BP:T17] (phần b) < 10 mẫu không phản ứng; set point 5% (nhiễu nền 1 lỗi / 40 không lùi); permits = ceil(20 × (1 − factor)); cấu hình env', () => {
    const { c, advance } = clockController();
    for (let i = 0; i < 9; i++) c.record('infra_fail');
    advance(1000);
    c.tick();
    expect(c.factor()).toBe(0);
    const d = clockController();
    for (let i = 0; i < 39; i++) d.c.record('ok');
    d.c.record('infra_fail');
    d.advance(1000);
    d.c.tick();
    expect(d.c.factor()).toBe(0);
    for (let i = 0; i < 10; i++) d.c.record('infra_fail');
    d.advance(1000);
    d.c.tick();
    expect(d.c.factor()).toBe(0.25);
    expect(d.c.permits()).toBe(15);
    expect(backpressureOptionsFromEnv({})).toEqual({ setPoint: 0.05, probeIntervalMs: 5000, holdMaxMs: 60000 });
    expect(backpressureOptionsFromEnv({ BACKPRESSURE_SET_POINT: '2', BACKPRESSURE_PROBE_INTERVAL_MS: '1', BACKPRESSURE_HOLD_MAX_MS: 'x' })).toEqual({
      setPoint: 0.05,
      probeIntervalMs: 5000,
      holdMaxMs: 60000,
    });
  });

  it('[BP:T18] 5xx / timeout của ĐÍCH không làm factor đổi (tín hiệu `ok`); lỗi hạ tầng của hub thì có', async () => {
    const c = new FailureRateController({ dependency: 'db' });
    const repo = {
      findDeliveryForSend: jest.fn().mockResolvedValue(buildDeliveryRow()),
      claimForSend: jest.fn().mockResolvedValue(1),
      deferDelivery: jest.fn(),
    };
    const tx = {
      deliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
      delivery: { findFirst: jest.fn().mockResolvedValue({ id: 'x' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processedMessage: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = { forTenant: jest.fn().mockReturnValue(repo), processedMessage: { findUnique: jest.fn().mockResolvedValue(null) }, tenantTx: (_t: any, fn: any) => fn(tx) };
    const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'), c);
    const record = jest.spyOn(c, 'record');
    for (const r of [
      { status: 503, body: 'down', error: 'Service Unavailable', durationMs: 3 },
      { status: 0, body: '', error: 'timeout', durationMs: 10_000 },
      { status: 404, body: 'nope', durationMs: 3 },
    ]) {
      jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue(r) } as any);
      for (let i = 0; i < 10; i++) await consumer.handleMessage(amqp(buildSlimMsg()), buildChannel());
    }
    expect(record.mock.calls.every(([o]) => o === 'ok')).toBe(true);
    c.tick();
    expect(c.factor()).toBe(0);
    // lỗi HẠ TẦNG của hub (P1001 ở bước nạp) -> infra_fail
    repo.findDeliveryForSend.mockRejectedValue(p1001());
    for (let i = 0; i < 10; i++) await consumer.handleMessage(amqp(buildSlimMsg()), buildChannel());
    expect(record).toHaveBeenLastCalledWith('infra_fail');
    jest.restoreAllMocks();
  });

  it('[BP:T19] chế độ dò (factor = 1): tối đa 1 lần bắt đầu xử lý mỗi BACKPRESSURE_PROBE_INTERVAL_MS', async () => {
    jest.useFakeTimers();
    try {
      const c = new FailureRateController({ dependency: 'db', minSamples: 1 });
      for (let i = 0; i < 4; i++) {
        c.record('infra_fail');
        c.tick();
      }
      expect(c.factor()).toBe(1);
      const starts: number[] = [];
      const t0 = Date.now();
      const all = Array.from({ length: 6 }, () =>
        c.acquire().then((r) => {
          if (r.kind === 'permit') {
            starts.push(Date.now() - t0);
            r.release(); // xử lý xong ngay — vẫn phải chờ nhịp dò
          }
          return r.kind;
        }),
      );
      await jest.advanceTimersByTimeAsync(26_000);
      expect(await Promise.all(all)).toEqual(['permit', 'permit', 'permit', 'permit', 'permit', 'permit']);
      for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(5_000);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('BP5 — runGated (giữ / spill / tắt máy)', () => {
  it('[BP:T20] giữ quá BACKPRESSURE_HOLD_MAX_MS -> republish KHÔNG đốt lượt rồi ack (normalize: retry.30s giữ x-normalize-retry; delivery: retry.10s giữ attemptCount)', async () => {
    jest.useFakeTimers();
    try {
      const c = new FailureRateController({ dependency: 'db', maxPermits: 1, holdMaxMs: 60_000 });
      // mỗi lane một message đang giữ permit (xử lý treo)
      const busyN = await c.acquire('normalize');
      const busy = await c.acquire('delivery');
      expect(busyN.kind).toBe('permit');
      expect(busy.kind).toBe('permit');
      const inFlight = new InFlightTracker();
      const normalize = new NormalizeConsumer({} as any, c);
      const delivery = new DeliveryConsumer({} as any, buildFakeCircuitBreaker('CLOSED'), c);
      const handleN = jest.spyOn(normalize, 'handleMessage');
      const handleD = jest.spyOn(delivery, 'handleMessage');
      const chN = buildChannel();
      const chD = buildChannel();
      const nMsg = amqp({ rawEventId: 'r1', tenantId: 't', sourceId: 's', provider: 'github' }, { [NORMALIZE_RETRY_HEADER]: 2 });
      const dMsg = amqp(buildSlimMsg({ attemptCount: 3, destinationId: 'dest-1', rateLimitRps: 0 }), { 'x-attempt': 3 });
      const pN = runGated(c, 'normalize', normalize, nMsg, chN, inFlight);
      const pD = runGated(c, 'delivery', delivery, dMsg, chD, inFlight);
      await jest.advanceTimersByTimeAsync(59_000);
      expect(chN.sendToQueue).not.toHaveBeenCalled();
      expect(inFlight.count).toBe(0); // đang chờ permit KHÔNG tính vào inFlight (C5)
      await jest.advanceTimersByTimeAsync(2_000);
      expect(await pN).toBe('spilled');
      expect(await pD).toBe('spilled');
      expect(handleN).not.toHaveBeenCalled();
      expect(handleD).not.toHaveBeenCalled();
      expect(chN.sendToQueue.mock.calls[0][0]).toBe('q.normalize.retry.30s');
      expect(chN.sendToQueue.mock.calls[0][2].headers[NORMALIZE_RETRY_HEADER]).toBe(2);
      expect(chN.sendToQueue.mock.calls[0][2].headers[NORMALIZE_DEFERRED_SINCE_HEADER]).toEqual(expect.any(Number)); // TH-1: trần chung
      expect(chN.ack).toHaveBeenCalledTimes(1);
      expect(chD.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.10s');
      expect(JSON.parse(chD.sendToQueue.mock.calls[0][1].toString())).toMatchObject({ attemptCount: 3, destinationId: 'dest-1' });
      expect(chD.sendToQueue.mock.calls[0][2].headers['x-attempt']).toBe(3);
      expect(chD.ack).toHaveBeenCalledTimes(1);
      if (busy.kind === 'permit') busy.release();
      if (busyN.kind === 'permit') busyN.release();
    } finally {
      jest.useRealTimers();
    }
  });

  it('[BP:T24] (phần a) (C5) factor = 1 giữ 5 message rồi SIGTERM: tắt máy xong ngay (< 25s); 5 message đó KHÔNG ack, KHÔNG nack, KHÔNG republish; message đã có permit chạy xong rồi ack', async () => {
    jest.useFakeTimers();
    try {
      const c = new FailureRateController({ dependency: 'db', minSamples: 1 });
      for (let i = 0; i < 4; i++) {
        c.record('infra_fail');
        c.tick();
      }
      expect(c.factor()).toBe(1);
      const inFlight = new InFlightTracker();
      let finishRunning!: () => void;
      const running = new Promise<void>((r) => (finishRunning = r));
      const handled: string[] = [];
      const handler = {
        handleMessage: jest.fn(async (m: any, ch: any) => {
          handled.push(m.id);
          await running;
          ch.ack(m);
        }),
        spill: jest.fn(),
      };
      const ch = buildChannel();
      const msgs = Array.from({ length: 6 }, (_, i) => ({ ...amqp({ i }), id: `m${i}` }));
      const results = msgs.map((m) => runGated(c, 'delivery', handler as any, m, ch, inFlight));
      await jest.advanceTimersByTimeAsync(10); // m0 lấy permit dò, 5 message còn lại chờ
      expect(handled).toEqual(['m0']);
      expect(inFlight.count).toBe(1);

      const t0 = Date.now();
      c.shutdown(); // trình tự main.ts: cancel consumer -> backpressure.shutdown() -> waitIdle
      const idle = inFlight.waitIdle(20_000);
      finishRunning();
      await jest.advanceTimersByTimeAsync(10);
      expect(await idle).toBe(true);
      expect(Date.now() - t0).toBeLessThan(25_000);
      expect(await Promise.all(results)).toEqual(['done', 'shutdown', 'shutdown', 'shutdown', 'shutdown', 'shutdown']);
      expect(handled).toEqual(['m0']);
      expect(ch.ack).toHaveBeenCalledTimes(1);
      expect(ch.ack.mock.calls[0][0].id).toBe('m0');
      expect(ch.nack).not.toHaveBeenCalled();
      expect(ch.sendToQueue).not.toHaveBeenCalled();
      expect(handler.spill).not.toHaveBeenCalled();
      // sau shutdown, message mới cũng không được xử lý
      expect(await runGated(c, 'delivery', handler as any, { ...amqp({}), id: 'late' } as any, ch, inFlight)).toBe('shutdown');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('BP5 — review lượt 1', () => {
  it('(TB-1) một factor, HAI semaphore: 20 delivery treo HTTP (đích chậm) chiếm hết permit delivery mà normalize vẫn bắt đầu NGAY; lúc khoẻ 40 đồng thời / tiến trình như trước BP5', async () => {
    const c = new FailureRateController({ dependency: 'db' });
    const inFlight = new InFlightTracker();
    let unblock!: () => void;
    const slowHttp = new Promise<void>((r) => (unblock = r));
    const delivery = { handleMessage: jest.fn(() => slowHttp), spill: jest.fn() };
    const started: string[] = [];
    const normalize = { handleMessage: jest.fn(async (m: any) => void started.push(m.id)), spill: jest.fn() };
    const ch = buildChannel();
    const d = Array.from({ length: 20 }, (_, i) => runGated(c, 'delivery', delivery as any, { ...amqp({ i }), id: `d${i}` } as any, ch, inFlight));
    await Promise.resolve();
    expect(c.active('delivery')).toBe(20);
    const n = Array.from({ length: 20 }, (_, i) => runGated(c, 'normalize', normalize as any, { ...amqp({ i }), id: `n${i}` } as any, ch, inFlight));
    expect(await Promise.all(n)).toEqual(Array(20).fill('done'));
    expect(started).toHaveLength(20); // không chờ delivery
    expect(c.waiting('normalize')).toBe(0);
    // delivery thứ 21 thì chờ (prefetch 20 của delivery)
    const extra = runGated(c, 'delivery', delivery as any, { ...amqp({}), id: 'd20' } as any, ch, inFlight);
    await Promise.resolve();
    expect(c.waiting('delivery')).toBe(1);
    unblock();
    expect(await Promise.all([...d, extra])).toEqual(Array(21).fill('done'));
  });

  it('(TH-1) spill normalize dùng chung trần NORMALIZE_MAX_DEFER_MS: trong trần giữ since + không đốt lượt; quá trần đốt lượt; hết lượt -> DLQ', () => {
    const consumer = new NormalizeConsumer({} as any, null);
    const msg = (h: Record<string, unknown>) => amqp({ rawEventId: 'r' }, h);
    const ch1 = buildChannel();
    const since = Date.now() - 10_000;
    consumer.spill(msg({ [NORMALIZE_DEFERRED_SINCE_HEADER]: since, [NORMALIZE_RETRY_HEADER]: 1 }), ch1);
    expect(ch1.sendToQueue.mock.calls[0][2].headers).toMatchObject({ [NORMALIZE_DEFERRED_SINCE_HEADER]: since, [NORMALIZE_RETRY_HEADER]: 1 });
    const ch2 = buildChannel();
    consumer.spill(msg({ [NORMALIZE_DEFERRED_SINCE_HEADER]: Date.now() - NORMALIZE_MAX_DEFER_MS - 1, [NORMALIZE_RETRY_HEADER]: 1 }), ch2);
    expect(ch2.sendToQueue.mock.calls[0][2].headers[NORMALIZE_RETRY_HEADER]).toBe(2);
    expect(ch2.ack).toHaveBeenCalledTimes(1);
    const ch3 = buildChannel();
    consumer.spill(msg({ [NORMALIZE_DEFERRED_SINCE_HEADER]: Date.now() - NORMALIZE_MAX_DEFER_MS - 1, [NORMALIZE_RETRY_HEADER]: 5 }), ch3);
    expect(ch3.sendToQueue).not.toHaveBeenCalled();
    expect(ch3.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('[BP:T24] (phần b) gracefulStop: thứ tự cancel consumer -> backpressure.shutdown() -> waitIdle -> đóng; message đang giữ không ack/nack/republish', async () => {
    const order: string[] = [];
    const c = new FailureRateController({ dependency: 'db', maxPermits: 1 });
    const inFlight = new InFlightTracker();
    const ch = buildChannel();
    let finish!: () => void;
    const work = new Promise<void>((r) => (finish = r));
    const handler = {
      handleMessage: jest.fn(async (m: any, chx: any) => {
        await work;
        chx.ack(m);
      }),
      spill: jest.fn(),
    };
    const running = runGated(c, 'delivery', handler as any, { ...amqp({}), id: 'run' } as any, ch, inFlight);
    const held = [1, 2, 3].map((i) => runGated(c, 'delivery', handler as any, { ...amqp({ i }), id: `h${i}` } as any, ch, inFlight));
    await Promise.resolve();
    expect(c.waiting('delivery')).toBe(3);
    const shutdownSpy = jest.spyOn(c, 'shutdown').mockImplementation(function (this: FailureRateController) {
      order.push('backpressure.shutdown');
      return FailureRateController.prototype.shutdown.call(c);
    });
    const waitIdle = jest.spyOn(inFlight, 'waitIdle').mockImplementation(async (ms: number) => {
      order.push('waitIdle');
      finish();
      await running;
      expect(ms).toBe(20_000);
      return true;
    });
    const res = await gracefulStop({
      cancelConsumers: async () => void order.push('cancel'),
      backpressure: c,
      inFlight,
      background: [Promise.resolve().then(() => order.push('background'))],
      waitBudgetMs: 20_000,
      closeAll: async () => void order.push('closeAll'),
    });
    expect(order.filter((x) => x !== 'background')).toEqual(['cancel', 'backpressure.shutdown', 'waitIdle', 'closeAll']);
    expect(res.idle).toBe(true);
    expect(await Promise.all(held)).toEqual(['shutdown', 'shutdown', 'shutdown']);
    expect(ch.ack).toHaveBeenCalledTimes(1);
    expect(ch.ack.mock.calls[0][0].id).toBe('run');
    expect(ch.nack).not.toHaveBeenCalled();
    expect(ch.sendToQueue).not.toHaveBeenCalled();
    expect(handler.spill).not.toHaveBeenCalled();
    shutdownSpy.mockRestore();
    waitIdle.mockRestore();
  });
});

describe('BP5 §7.4 — normalize hoãn không đốt lượt khi DB đang ốm', () => {
  function normalizeWith(c: FailureRateController | null) {
    const prisma: any = { processedMessage: { findUnique: jest.fn().mockRejectedValue(p1001()) } };
    return new NormalizeConsumer(prisma, c);
  }
  const nMsg = (headers: Record<string, unknown> = {}) => amqp({ rawEventId: 'r1', tenantId: 't', sourceId: 's', provider: 'github' }, headers);

  it('factor > 0: lỗi tạm -> retry.30s, KHÔNG tăng x-normalize-retry, đặt x-normalize-deferred-since; quá NORMALIZE_MAX_DEFER_MS -> đốt lượt như cũ; factor = 0 -> hành vi cũ', async () => {
    const sick = new FailureRateController({ dependency: 'db', minSamples: 1 });
    sick.record('infra_fail');
    sick.tick();
    expect(sick.factor()).toBeGreaterThan(0);
    const ch = buildChannel();
    const before = Date.now();
    await normalizeWith(sick).handleMessage(nMsg({ [NORMALIZE_RETRY_HEADER]: 1 }), ch);
    const h = ch.sendToQueue.mock.calls[0][2].headers;
    expect(ch.sendToQueue.mock.calls[0][0]).toBe('q.normalize.retry.30s');
    expect(h[NORMALIZE_RETRY_HEADER]).toBe(1);
    expect(h[NORMALIZE_DEFERRED_SINCE_HEADER]).toBeGreaterThanOrEqual(before);

    const ch2 = buildChannel();
    await normalizeWith(sick).handleMessage(nMsg({ [NORMALIZE_RETRY_HEADER]: 1, [NORMALIZE_DEFERRED_SINCE_HEADER]: Date.now() - NORMALIZE_MAX_DEFER_MS - 1 }), ch2);
    expect(ch2.sendToQueue.mock.calls[0][2].headers[NORMALIZE_RETRY_HEADER]).toBe(2);

    const ch3 = buildChannel();
    await normalizeWith(new FailureRateController({ dependency: 'db' })).handleMessage(nMsg({ [NORMALIZE_RETRY_HEADER]: 1 }), ch3);
    expect(ch3.sendToQueue.mock.calls[0][2].headers[NORMALIZE_RETRY_HEADER]).toBe(2);
    expect(ch3.sendToQueue.mock.calls[0][2].headers).not.toHaveProperty(NORMALIZE_DEFERRED_SINCE_HEADER);

    expect(normalizeMaxDeferMs(undefined)).toBe(3_600_000);
    expect(normalizeMaxDeferMs('99999999')).toBe(3_600_000);
    expect(normalizeMaxDeferMs('600000')).toBe(600_000);
    expect(normalizeMaxDeferMs('1')).toBe(30_000);
  });
});

describe('BP5 — mô phỏng sự cố DB (L0, đồng hồ giả)', () => {
  /** Broker giả: một queue chính + một queue retry có TTL (dead-letter về queue chính). */
  function broker(retryTtlMs: number) {
    const due: { at: number; msg: any }[] = [];
    const channel: any = {
      ack: jest.fn(),
      nack: jest.fn(),
      publish: jest.fn(),
      sendToQueue: jest.fn((_q: string, content: Buffer, opts: any) => {
        due.push({ at: Date.now() + retryTtlMs, msg: { content, properties: { headers: opts?.headers ?? {} } } });
        return true;
      }),
    };
    return { due, channel };
  }

  it('[BP:T4] (phần a) DB chết 60s dưới tải (200 delivery): số lần gọi Prisma mỗi giây bị chặn trên (≤ 20 = MAX permit; chế độ dò ≤ 1 / 5s); log warn ≤ 1 dòng / 30s', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, 'child');
    try {
      let dbDown = true;
      const calls: number[] = [];
      const c = new FailureRateController({ dependency: 'db' });
      c.start();
      const repo = {
        findDeliveryForSend: jest.fn(async () => {
          calls.push(Date.now());
          if (dbDown) throw p1001();
          return null; // DB về: delivery không còn -> ack
        }),
      };
      const prisma: any = { forTenant: () => repo };
      const consumer = new DeliveryConsumer(prisma, buildFakeCircuitBreaker('CLOSED'), c);
      const warnLines: number[] = [];
      warn.mockImplementation(() => ({ warn: () => warnLines.push(Date.now()), error: jest.fn(), info: jest.fn(), debug: jest.fn() }) as any);
      const { due, channel } = broker(10_000);
      const inFlight = new InFlightTracker();
      const t0 = Date.now();
      for (let i = 0; i < 200; i++) due.push({ at: t0, msg: amqp(buildSlimMsg({ deliveryId: `d-${i}` })) });
      for (let s = 0; s < 90; s++) {
        if (s === 60) dbDown = false;
        const ready = due.filter((d) => d.at <= Date.now());
        for (const r of ready) due.splice(due.indexOf(r), 1);
        // prefetch 20: chỉ 20 message được giao vào tiến trình cùng lúc
        for (const r of ready.slice(0, 20)) void runGated(c, 'delivery', consumer, r.msg, channel, inFlight);
        for (const r of ready.slice(20)) due.push({ at: Date.now() + 100, msg: r.msg });
        await jest.advanceTimersByTimeAsync(1_000);
      }
      const perSecond = new Map<number, number>();
      for (const t of calls.filter((x) => x - t0 < 60_000)) perSecond.set(Math.floor((t - t0) / 1000), (perSecond.get(Math.floor((t - t0) / 1000)) ?? 0) + 1);
      // Trong lúc DB chết: mỗi giây ≤ 20 (MAX permit / prefetch) ở vài giây đầu, rồi chế độ dò
      expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(20);
      expect([...perSecond.entries()].filter(([sec]) => sec >= 5).every(([, n]) => n <= 1)).toBe(true);
      const probing = calls.filter((t) => t - t0 >= 15_000 && t - t0 < 60_000);
      expect(probing.length).toBeLessThanOrEqual(Math.ceil(45_000 / 5_000) + 1);
      // Không có BP5: ~200 message × mỗi 10s = 20 lần gọi/giây suốt 60s
      const firstWindow = warnLines.filter((t) => t - t0 < 60_000);
      expect(firstWindow.length).toBeLessThanOrEqual(2 + 1); // log gộp 30s (BP1)
      // DB về: probe thành công, lỗi cũ trôi khỏi cửa sổ 30s -> factor hồi -> hàng đang giữ được xử lý hết
      expect(c.waiting()).toBe(0);
      expect(calls.filter((t) => t - t0 >= 60_000).length).toBeGreaterThanOrEqual(150);
      c.stop();
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('[BP:T21] (phần a) DB chết 10 phút dưới tải đều (normalize): q.normalize.dlq tăng ≤ 5; DB về thì xử lý hết', async () => {
    jest.useFakeTimers();
    try {
      let dbDown = true;
      const c = new FailureRateController({ dependency: 'db' });
      c.start();
      const prisma: any = {
        processedMessage: {
          findUnique: jest.fn(async () => {
            if (dbDown) throw p1001();
            return { consumer: 'normalize', messageId: 'x' }; // DB về: coi như đã xử lý -> ack
          }),
        },
      };
      const consumer = new NormalizeConsumer(prisma, c);
      const { due, channel } = broker(30_000);
      const inFlight = new InFlightTracker();
      let sent = 0;
      for (let s = 0; s < 900; s++) {
        if (s === 600) dbDown = false;
        if (s < 600 && sent < 300) {
          // tải đều: 1 sự kiện mới mỗi 2 giây
          if (s % 2 === 0) {
            due.push({ at: Date.now(), msg: amqp({ rawEventId: `r-${sent++}`, tenantId: 't', sourceId: 's', provider: 'github' }) });
          }
        }
        const ready = due.filter((d) => d.at <= Date.now());
        for (const r of ready) due.splice(due.indexOf(r), 1);
        for (const r of ready.slice(0, 20)) void runGated(c, 'normalize', consumer, r.msg, channel, inFlight);
        for (const r of ready.slice(20)) due.push({ at: Date.now() + 100, msg: r.msg });
        await jest.advanceTimersByTimeAsync(1_000);
      }
      const dlq = channel.nack.mock.calls.filter(([, , requeue]: any[]) => requeue === false).length;
      expect(dlq).toBeLessThanOrEqual(5);
      expect(due.length).toBe(0); // không còn gì treo
      expect(channel.ack.mock.calls.length).toBeGreaterThan(sent); // ack cả các lần hoãn + lần xử lý cuối
      c.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('BP5 — bảng mã lỗi hạ tầng (nợ §16 của BP1)', () => {
  it('Postgres cắt kết nối (57P01/57P02/57P03, lớp 08) là transient — cả delivery lẫn normalize; amqplib "Channel closed" vẫn unknown', () => {
    const unknownReq = (m: string) => Object.assign(new Error(m), { name: 'PrismaClientUnknownRequestError' });
    for (const err of [
      unknownReq('Error occurred during query execution: ConnectorError(... code: "57P01", message: "terminating connection due to administrator command" ...)'),
      unknownReq('the database system is shutting down'),
      Object.assign(new Error('x'), { code: '57P03' }),
      Object.assign(new Error('x'), { code: '08006' }),
    ]) {
      expect(classifyInfraError(err)).toBe('transient');
      expect(classifyNormalizeError(err)).toBe('transient');
    }
    expect(classifyInfraError(Object.assign(new Error('Channel closed'), { name: 'IllegalOperationError' }))).toBe('unknown');
    expect(classifyInfraError(unknownReq('some other query error'))).toBe('unknown');
  });

  it('metric hub_backpressure_factor{dependency="db"} theo factor', async () => {
    const c = new FailureRateController({ dependency: 'db-metric', minSamples: 1 });
    c.record('infra_fail');
    c.tick();
    const v = (await backpressureFactor.get()).values.find((x) => x.labels.dependency === 'db-metric')?.value;
    expect(v).toBe(0.25);
  });
});
