/**
 * S3-5 — ngân sách Redis được ĐẾM bằng test (R1, ADR-062): ≤ 4 lệnh cố định cho mỗi sự kiện
 * (ingest + normalize) + ≤ 2 lệnh cho mỗi delivery. Mọi client ioredis trong hub-api lẫn hub-worker
 * được thay bằng một client giả có Proxy đếm lệnh. Ai thêm một lệnh Redis vào đường nóng là test đỏ.
 *
 * Kỳ vọng (đường thành công, đích không cấu hình throttle, circuit CLOSED và chưa từng lỗi):
 *   ingest     3 = EVAL rate limit + GET idem + SET NX idem (sau COMMIT)
 *   normalize  1 = PUBLISH hub:realtime:events (gộp mọi event/đích của raw event)
 *   delivery   2 = MGET circuit + PUBLISH hub:realtime:deliveries   (recordSuccess khi failures=0: 0 lệnh)
 *   => 1 đích = 6, 2 đích = 8.
 */
const calls: string[] = [];
const store = new Map<string, string>();

function fakeRedis() {
  const impl: Record<string, (...a: any[]) => any> = {
    // không phải lệnh tới server — không đếm
    connect: async () => undefined,
    on: () => undefined,
    disconnect: () => undefined,
    quit: async () => 'OK',
    // lệnh thật — đếm
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: any[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    eval: async (script: string, n: number, ...rest: any[]) => {
      const key = rest[0];
      if (/redis\.call\('GET'/.test(script)) {
        // LUA_STATE_AND_THROTTLE: KEYS open, failures, throttle
        const [open, failures, throttle] = rest.slice(0, n);
        let t = -1;
        if (!store.get(open) && Number(store.get(failures) ?? 0) < Number(rest[n])) {
          t = Number(store.get(throttle) ?? 0) + 1;
          store.set(throttle, String(t));
        }
        return [store.get(open) ?? '', store.get(failures) ?? '', t];
      }
      if (/INCR/.test(script)) {
        const n = Number(store.get(key) ?? 0) + 1;
        store.set(key, String(n));
        return n;
      }
      return 0;
    },
    mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null),
    del: async (...keys: string[]) => keys.filter((k) => store.delete(k)).length,
    publish: async () => 1,
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
  };
  const NOT_COMMANDS = new Set(['connect', 'on', 'disconnect', 'quit']);
  return new Proxy(impl, {
    get(target, prop: string) {
      if (prop === 'then') return undefined;
      const fn = target[prop];
      if (!fn) {
        // Lệnh chưa giả lập -> vẫn đếm và trả null, để test lộ ra lệnh mới
        return async () => {
          calls.push(prop);
          return null;
        };
      }
      return (...args: any[]) => {
        if (!NOT_COMMANDS.has(prop)) calls.push(prop);
        return fn(...args);
      };
    },
  });
}

jest.mock('ioredis', () => jest.fn().mockImplementation(() => fakeRedis()));

import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { RedisService } from '../src/modules/redis/redis.service';
import { NormalizeConsumer } from '../../hub-worker/src/consumers/normalize.consumer';
import { DeliveryConsumer } from '../../hub-worker/src/consumers/delivery.consumer';
import { CircuitBreakerService } from '../../hub-worker/src/circuit/circuit-breaker.service';
import { SenderRegistry } from '../../hub-worker/src/senders/sender.registry';

const MASTER = 'test-master-key-at-least-32-characters!!';
const TENANT = '00000000-0000-0000-0000-000000000001';
const API_KEY = 'sepay-budget-key';
const RAW = '11111111-1111-1111-1111-111111111111';

const sepayBody = {
  id: 777001, gateway: 'MBBank', transactionDate: '2026-10-10 10:00:00', accountNumber: '0123', code: null,
  content: 'DH1 thanh toan', transferType: 'in', transferAmount: 50000, accumulated: 0, referenceCode: 'FT1', description: 'x',
};

async function runIngest() {
  const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: RAW }) }, outbox: { create: jest.fn() } };
  const prisma: any = {
    findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({
      id: 'src-sepay', tenantId: TENANT, isActive: true, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(API_KEY, MASTER) }],
    }),
    rawEvent: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const raw = JSON.stringify(sepayBody);
  const res = await new IngestService(prisma, new RedisService()).ingestWebhook({
    provider: 'sepay', sourceKey: 'src_sepay_main', headers: { authorization: `Apikey ${API_KEY}` }, rawBody: Buffer.from(raw), body: JSON.parse(raw),
  });
  expect(res.status).toBe(200);
}

async function runNormalize(destinations: number) {
  const subs = Array.from({ length: destinations }, (_, i) => ({ id: `sub-${i}`, destination: { id: `dest-${i}`, name: `d${i}`, type: 'webhook' } }));
  let seq = 0;
  const tx = {
    event: { create: jest.fn(async ({ data }: any) => data) },
    subscription: { findMany: jest.fn().mockResolvedValue(subs) },
    delivery: { create: jest.fn(async ({ data }: any) => ({ ...data, id: `del-${++seq}` })) },
    outbox: { create: jest.fn() },
    processedMessage: { create: jest.fn() },
  };
  const raw = JSON.stringify(sepayBody);
  const prisma: any = {
    forTenant: () => ({ findRawEventById: async () => ({ id: RAW, headers: {}, body: JSON.parse(raw), bodyRaw: Buffer.from(raw), contentType: 'application/json' }) }),
    processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const channel: any = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn() };
  const payload = { rawEventId: RAW, sourceId: 'src-sepay', tenantId: TENANT, provider: 'sepay', correlationId: 'c' };
  await new NormalizeConsumer(prisma).handleMessage({ content: Buffer.from(JSON.stringify(payload)), properties: { headers: {} } } as any, channel);
  expect(channel.ack).toHaveBeenCalled();
  expect(tx.delivery.create).toHaveBeenCalledTimes(destinations);
}

async function runDelivery(i: number, rateLimitRps = 0) {
  const now = new Date();
  const row = {
    id: `del-${i}`, tenantId: TENANT, attemptGeneration: 1, attemptCount: 0, status: 'PENDING',
    event: { id: 'evt-1', tenantId: TENANT, type: 'payment.received', source: 'sepay', subject: null, data: {}, normalized: true, occurredAt: now, receivedAt: now, correlationId: 'c', rawEventId: RAW, parentEventId: null, origin: 'webhook', rawEvent: null },
    subscription: {
      id: `sub-${i}`, template: '',
      destination: { id: `dest-${i}`, type: 'webhook', configEncrypted: aesGcmEncrypt('{"url":"https://x.example.com"}', MASTER), signingSecretEncrypted: null, rateLimitRps, circuitState: 'CLOSED' },
    },
  };
  const tx = {
    deliveryAttempt: { create: jest.fn() },
    delivery: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue({ id: row.id }) },
    processedMessage: { create: jest.fn() },
  };
  const repo = {
    findDeliveryForSend: jest.fn().mockResolvedValue(row),
    claimForSend: jest.fn().mockResolvedValue(1),
    updateDeliveryStatus: jest.fn().mockResolvedValue({}),
    updateDestinationCircuitState: jest.fn().mockResolvedValue(0),
  };
  const prisma: any = {
    forTenant: () => repo,
    processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const consumer = new DeliveryConsumer(prisma, new CircuitBreakerService(prisma));
  const channel: any = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn(), publish: jest.fn() };
  const msg = { deliveryId: row.id, tenantId: TENANT, attemptGeneration: 1, attemptCount: 0, correlationId: 'c' };
  await consumer.handleMessage({ content: Buffer.from(JSON.stringify(msg)), properties: { headers: {} } } as any, channel);
  expect(channel.ack).toHaveBeenCalled();
  expect(tx.deliveryAttempt.create).toHaveBeenCalled();
}

describe('S3-5 ngân sách Redis (R1: ≤4 cố định/sự kiện + ≤2/delivery)', () => {
  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });
  beforeEach(() => {
    calls.length = 0;
    store.clear();
    jest.spyOn(SenderRegistry, 'get').mockReturnValue({ type: 'webhook', send: jest.fn().mockResolvedValue({ status: 200, body: 'ok', durationMs: 7 }) } as any);
  });
  afterEach(() => jest.restoreAllMocks());

  const take = () => calls.splice(0, calls.length);

  it.each([1, 2])('%i đích: ingest 3 + normalize 1 + 2/đích', async (n) => {
    await runIngest();
    expect(take()).toEqual(['eval', 'get', 'set']);
    await runNormalize(n);
    expect(take()).toEqual(['publish']);
    for (let i = 1; i <= n; i++) {
      await runDelivery(i);
      expect(take()).toEqual(['mget', 'publish']);
    }
  });

  it('review #2: đích CÓ throttle (rateLimitRps>0) vẫn 2 lệnh/đích — EVAL gộp circuit+throttle + PUBLISH', async () => {
    await runIngest();
    await runNormalize(2);
    take();
    await runDelivery(1, 10);
    expect(take()).toEqual(['eval', 'publish']);
    await runDelivery(2, 20);
    expect(take()).toEqual(['eval', 'publish']);
  });

  it('tổng có throttle: 2 đích = 8 (giống không throttle)', async () => {
    await runIngest();
    await runNormalize(2);
    await runDelivery(1, 10);
    await runDelivery(2, 20);
    expect(calls.length).toBe(8);
  });

  it('[AF:#40] tổng: 1 đích = 6, 2 đích = 8 (≤ 4 + 2×N)', async () => {
    for (const [n, expected] of [[1, 6], [2, 8]] as const) {
      calls.length = 0;
      store.clear();
      await runIngest();
      await runNormalize(n);
      for (let i = 1; i <= n; i++) await runDelivery(i);
      expect(calls.length).toBe(expected);
      expect(calls.length).toBeLessThanOrEqual(4 + 2 * n);
    }
  });

  it('gửi lại y hệt: Redis GET trúng -> chỉ 2 lệnh (EVAL + GET), không transaction', async () => {
    await runIngest();
    take();
    const raw = JSON.stringify(sepayBody);
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({
        id: 'src-sepay', tenantId: TENANT, isActive: true, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(API_KEY, MASTER) }],
      }),
      $transaction: jest.fn(),
    };
    const res = await new IngestService(prisma, new RedisService()).ingestWebhook({
      provider: 'sepay', sourceKey: 'k', headers: { authorization: `Apikey ${API_KEY}` }, rawBody: Buffer.from(raw), body: JSON.parse(raw),
    });
    expect(res.status).toBe(200);
    expect(take()).toEqual(['eval', 'get']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('X9: POST /v1/p/:project/events đi qua persistAccepted -> ĐÚNG số lệnh như /hooks (EVAL + GET + SET); ApiKeyGuard 0 lệnh', async () => {
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: RAW }) }, outbox: { create: jest.fn() } };
    const prisma: any = {
      forTenant: () => ({ findSourceById: jest.fn().mockResolvedValue({ id: 'src-api', tenantId: TENANT, provider: 'api', isActive: true, secrets: [] }) }),
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const body = { type: 'order.created', data: { total: 1 }, idempotencyKey: 'ord-budget' };
    const svc = new IngestService(prisma, new RedisService());
    const res = await svc.publishFromService(TENANT, 'src-api', {
      provider: 'api', sourceKey: 'api_k', headers: {}, rawBody: Buffer.from(JSON.stringify(body)), body,
    });
    expect(res.status).toBe(202);
    expect(take()).toEqual(['eval', 'get', 'set']);
    // gửi lại: Redis trúng -> 200 duplicate, 2 lệnh, không transaction
    const again = await svc.publishFromService(TENANT, 'src-api', {
      provider: 'api', sourceKey: 'api_k', headers: {}, rawBody: Buffer.from(JSON.stringify(body)), body,
    });
    expect(again).toEqual({ status: 200, body: { duplicate: true } });
    expect(take()).toEqual(['eval', 'get']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
