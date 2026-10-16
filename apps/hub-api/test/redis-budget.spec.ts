/**
 * S3-5 — ngân sách Redis được ĐẾM bằng test (R1, ADR-062): ≤ 4 lệnh cố định cho mỗi sự kiện
 * (ingest + normalize) + ≤ 2 lệnh cho mỗi delivery. Mọi client ioredis trong hub-api lẫn hub-worker
 * được thay bằng một client giả có Proxy đếm lệnh. Ai thêm một lệnh Redis vào đường nóng là test đỏ.
 *
 * Kỳ vọng (đường thành công, đích không cấu hình throttle, circuit CLOSED và chưa từng lỗi):
 *   ingest     3 = EVAL rate limit + GET idem + SET NX idem (sau COMMIT)
 *              (EG3, ADR-178: EVAL rate limit chạy SAU verify -> request sai chữ ký 0 lệnh)
 *   normalize  1 = PUBLISH hub:realtime:events (gộp mọi event/đích của raw event)
 *   delivery   2 = EVAL gate circuit(+throttle) + PUBLISH hub:realtime:deliveries   (recordSuccess khi failures=0: 0 lệnh)
 *              (BP2 §6, ADR-196: gate LUÔN một EVAL — thay MGET; message có gợi ý thì gate TRƯỚC khi nạp DB)
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
      if (/PTTL/.test(script)) {
        // LUA_GATE (BP2 §6 + BP4): KEYS open, failures, throttle, ramp; ARGV ngưỡng, rps, nowMs, ramp start, ramp step, TTL.
        const [open, failures, throttle, ramp, probe] = rest.slice(0, n);
        let t = -1;
        let cap = -1;
        if (!store.get(open) && Number(store.get(failures) ?? 0) < Number(rest[n])) {
          if (store.get(ramp)) {
            const el = Math.max(0, Number(rest[n + 2]) - Number(store.get(ramp)));
            const last = Math.max(0, Math.ceil(Number(rest[n + 6]) / Number(rest[n + 4])) - 1); // F3: kẹp bậc cuối
            cap = Number(rest[n + 3]) * 2 ** Math.min(20, last, Math.floor(el / (Number(rest[n + 4]) * 1000)));
          }
          if (Number(rest[n + 1]) > 0 || cap > 0) {
            t = Number(store.get(throttle) ?? 0) + 1;
            store.set(throttle, String(t));
          }
        }
        // ADR-233: cờ :probe đang bị giữ (chỉ khi HALF_OPEN)
        const held = !store.get(open) && Number(store.get(failures) ?? 0) >= Number(rest[n]) && probe && store.get(probe) ? 1 : 0;
        return [store.get(open) ? 1 : 0, store.get(failures) ?? '', store.get(open) ? 60_000 : -2, t, cap, held];
      }
      if (/redis\.call\('DEL'/.test(script) && /'SET'/.test(script)) {
        // LUA_CLOSE_AND_RAMP (BP4): DEL 4 khoá + SET :ramp
        rest.slice(0, 4).forEach((k: string) => store.delete(k));
        store.set(rest[4], String(rest[n]));
        return 1;
      }
      if (/EXISTS/.test(script)) {
        // LUA_ACQUIRE_PROBE: KEYS open, failures, probe; ARGV token, TTL, ngưỡng
        const [open, failures, probe] = rest.slice(0, n);
        if (store.get(open) || Number(store.get(failures) ?? 0) < Number(rest[n + 2]) || store.get(probe)) return 0;
        store.set(probe, String(rest[n]));
        return 1;
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
import { createHash, createHmac } from 'crypto';
import { IngestController } from '../src/modules/ingest/ingest.controller';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { RedisService } from '../src/modules/redis/redis.service';
import { ProjectsController } from '../src/modules/console/projects.controller';
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
      id: 'src-sepay', tenantId: TENANT, provider: 'sepay', isActive: true, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(API_KEY, MASTER) }],
    }),
    rawEvent: { create: jest.fn() },
    // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
    tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
    systemTx(_r: any, fn: any) { return this.$transaction(fn); },
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
    // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
    tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
    systemTx(_r: any, fn: any) { return this.$transaction(fn); },
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
    // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
    tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
    systemTx(_r: any, fn: any) { return this.$transaction(fn); },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const consumer = new DeliveryConsumer(prisma, new CircuitBreakerService(prisma));
  const channel: any = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn(), publish: jest.fn() };
  const msg = { deliveryId: row.id, tenantId: TENANT, attemptGeneration: 1, attemptCount: 0, correlationId: 'c' };
  await consumer.handleMessage({ content: Buffer.from(JSON.stringify(msg)), properties: { headers: {} } } as any, channel);
  expect(channel.ack).toHaveBeenCalled();
  expect(tx.deliveryAttempt.create).toHaveBeenCalled();
}

/**
 * BP2 (ADR-196, C9): message mang GỢI Ý `destinationId` + `rateLimitRps` -> gate TRƯỚC khi nạp DB.
 * `real` = cấu hình thật trong row; `hint` = gợi ý trong message (có thể lệch).
 */
async function runDeliveryHinted(i: number, o: { real: { destinationId?: string; rateLimitRps: number }; hint: { destinationId?: string; rateLimitRps: number }; headers?: Record<string, unknown>; persistedCircuit?: string; circuitDbWrites?: boolean }) {
  const now = new Date();
  const destId = o.real.destinationId ?? `dest-${i}`;
  const row = {
    id: `del-${i}`, tenantId: TENANT, attemptGeneration: 1, attemptCount: 0, status: 'PENDING',
    event: { id: 'evt-1', tenantId: TENANT, type: 'payment.received', source: 'sepay', subject: null, data: {}, normalized: true, occurredAt: now, receivedAt: now, correlationId: 'c', rawEventId: RAW, parentEventId: null, origin: 'webhook', rawEvent: null },
    subscription: {
      id: `sub-${i}`, template: '',
      destination: { id: destId, type: 'webhook', configEncrypted: aesGcmEncrypt('{"url":"https://x.example.com"}', MASTER), signingSecretEncrypted: null, rateLimitRps: o.real.rateLimitRps, circuitState: o.persistedCircuit ?? 'CLOSED' },
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
    deferDelivery: jest.fn().mockResolvedValue(1),
  };
  // circuitDbWrites: UPDATE circuit_state có điều kiện đổi được dòng -> lộ PUBLISH hub:realtime:circuit thật.
  if (o.circuitDbWrites) repo.updateDestinationCircuitState = jest.fn().mockResolvedValue(1);
  const prisma: any = {
    forTenant: () => repo,
    processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
    tenantTx(_t: any, fn: any, o2?: any) { return this.$transaction(fn, o2); },
    systemTx(_r: any, fn: any) { return this.$transaction(fn); },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const consumer = new DeliveryConsumer(prisma, new CircuitBreakerService(prisma));
  const channel: any = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn(), publish: jest.fn() };
  const msg = {
    deliveryId: row.id, tenantId: TENANT, attemptGeneration: 1, attemptCount: 0, correlationId: 'c',
    destinationId: o.hint.destinationId ?? destId, rateLimitRps: o.hint.rateLimitRps,
  };
  await consumer.handleMessage({ content: Buffer.from(JSON.stringify(msg)), properties: { headers: o.headers ?? {} } } as any, channel);
  expect(channel.ack).toHaveBeenCalled();
  return { repo, tx, channel };
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
      expect(take()).toEqual(['eval', 'publish']);
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

  it('[BP:T6] (phần a) circuit OPEN + message có gợi ý destinationId: 0 truy vấn DB đọc (không nạp row), đúng 1 lệnh Redis (gate)', async () => {
    store.set('circuit:dest-1:open', 'OPEN');
    store.set('circuit:dest-1:failures', '5');
    const { repo, tx, channel } = await runDeliveryHinted(1, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 } });
    expect(take()).toEqual(['eval']);
    expect(repo.findDeliveryForSend).not.toHaveBeenCalled();
    expect(repo.claimForSend).not.toHaveBeenCalled();
    expect(tx.deliveryAttempt.create).not.toHaveBeenCalled();
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
    // Ghi thưa (F7): lần hoãn ĐẦU vẫn ghi next_attempt_at (UPDATE theo id, không đọc); lần trong 2 phút sau thì không.
    expect(repo.deferDelivery).toHaveBeenCalledTimes(1);
    const again = await runDeliveryHinted(1, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 }, headers: channel.sendToQueue.mock.calls[0][2].headers });
    expect(take()).toEqual(['eval']);
    expect(again.repo.findDeliveryForSend).not.toHaveBeenCalled();
    expect(again.repo.deferDelivery).not.toHaveBeenCalled(); // 0 truy vấn DB
  });

  it('[BP:T22] (phần a) ngân sách đường hoãn (F4): hoãn OPEN = 1 lệnh; throttle (gợi ý) = 1 lệnh, 0 truy vấn DB', async () => {
    store.set('circuit:dest-1:open', 'OPEN');
    await runDeliveryHinted(1, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 } });
    expect(take()).toEqual(['eval']);
    store.clear();
    // cửa sổ throttle của giây này (và giây kế, phòng chạm ranh giới giây) đã đầy
    const sec = Math.floor(Date.now() / 1000);
    for (const t of [sec, sec + 1]) store.set(`throttle:destination:dest-2:${t}`, '1000');
    const { repo, channel } = await runDeliveryHinted(2, { real: { rateLimitRps: 5 }, hint: { rateLimitRps: 5 } });
    expect(take()).toEqual(['eval']);
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.10s');
    expect(repo.findDeliveryForSend).not.toHaveBeenCalled();
    expect(repo.deferDelivery).not.toHaveBeenCalled();
  });

  it('[BP:T22] (phần b) HALF_OPEN có probe (gợi ý đúng, đích hồi phục): chuỗi lệnh ĐẦY ĐỦ, không lọc — 4 lệnh + PUBLISH circuit mỗi lần đổi trạng thái (C10)', async () => {
    store.set('circuit:dest-1:failures', '5'); // :open đã hết hạn -> HALF_OPEN; DB còn ghi OPEN
    const { repo } = await runDeliveryHinted(1, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 }, persistedCircuit: 'OPEN', circuitDbWrites: true });
    expect(repo.findDeliveryForSend).toHaveBeenCalledTimes(1);
    // gate · giành probe · PUBLISH circuit (syncObserved OPEN->HALF_OPEN) · EVAL đóng mạch + đặt :ramp (BP4, thay DEL — vẫn 1 lệnh)
    // · PUBLISH circuit (->CLOSED) · PUBLISH delivery = 4 lệnh + 2 PUBLISH circuit — bằng trước BP2; ca hiếm (một probe / đích / 30s).
    // Không gộp acquire vào gate (C10/C11: dù gộp vẫn > 3 vì PUBLISH circuit; đổi ngữ nghĩa getState, rủi ro hơn lợi).
    expect(take()).toEqual(['eval', 'eval', 'publish', 'eval', 'publish', 'publish']);
    expect(store.get('circuit:dest-1:ramp')).toEqual(expect.any(String)); // ramp bắt đầu
  });

  it('[BP:T22] (phần d) ADR-233: HALF_OPEN mà probe ĐANG bị giữ (worker khác đang dò) -> bên thua chỉ [EVAL] gate, 0 truy vấn đọc, hoãn retry.1m', async () => {
    store.set('circuit:dest-1:failures', '5'); // :open hết hạn -> HALF_OPEN
    store.set('circuit:dest-1:probe', 'worker-khac:token'); // probe đang bị giữ
    const { repo, channel } = await runDeliveryHinted(1, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 } });
    expect(take()).toEqual(['eval']); // trước ADR-233: ['eval', 'eval'] (gate + LUA_ACQUIRE_PROBE thua)
    expect(repo.findDeliveryForSend).not.toHaveBeenCalled();
    expect(repo.claimForSend).not.toHaveBeenCalled();
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.1m');
    expect(store.get('circuit:dest-1:probe')).toBe('worker-khac:token'); // không đụng probe của người khác
  });

  it('[BP:T22] (phần c) ramp (BP4): trong ramp gửi được = 2 lệnh (gate + PUBLISH); vượt trần ramp = 1 lệnh, 0 DB', async () => {
    const t0 = Date.parse('2026-10-13T12:00:00.200Z');
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 300); // cố định trong một giây -> cùng bộ đếm throttle
    store.set('circuit:dest-1:ramp', String(t0)); // vừa hồi phục: trần 2/s
    for (let i = 0; i < 2; i++) {
      await runDeliveryHinted(1, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 } });
      expect(take()).toEqual(['eval', 'publish']);
    }
    const { repo, channel } = await runDeliveryHinted(1, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 } });
    expect(take()).toEqual(['eval']);
    expect(channel.sendToQueue.mock.calls[0][0]).toBe('q.delivery.retry.10s');
    expect(repo.findDeliveryForSend).not.toHaveBeenCalled();
    expect(repo.deferDelivery).not.toHaveBeenCalled();
  });

  it('R1 (C9): đích CÓ throttle, gợi ý ĐÚNG -> gate trước khi nạp, vẫn 2 lệnh/delivery (EVAL + PUBLISH)', async () => {
    await runDeliveryHinted(1, { real: { rateLimitRps: 10 }, hint: { rateLimitRps: 10 } });
    expect(take()).toEqual(['eval', 'publish']);
    await runDeliveryHinted(2, { real: { rateLimitRps: 0 }, hint: { rateLimitRps: 0 } });
    expect(take()).toEqual(['eval', 'publish']);
  });

  it('R1 (C9) — CA NGOẠI LỆ ĐÃ BIẾT: gợi ý LỆCH -> 3 lệnh (gate lại / một INCR); rps 5→10 dùng lại bộ đếm cũ -> vẫn 2', async () => {
    // [BP:T11] gợi ý destinationId lệch row thật -> gate lại với id thật (+1 EVAL)
    await runDeliveryHinted(1, { real: { destinationId: 'dest-real', rateLimitRps: 0 }, hint: { destinationId: 'dest-stale', rateLimitRps: 0 } });
    expect(take()).toEqual(['eval', 'eval', 'publish']);
    // gợi ý rps 0 (gate không INCR) mà rps thật 5 -> MỘT INCR (không đếm hai lần)
    await runDeliveryHinted(2, { real: { rateLimitRps: 5 }, hint: { rateLimitRps: 0 } });
    expect(take()).toEqual(['eval', 'eval', 'publish']);
    // gợi ý rps 5, thật 10 -> so lại chính bộ đếm của gate, 0 lệnh thêm
    await runDeliveryHinted(3, { real: { rateLimitRps: 10 }, hint: { rateLimitRps: 5 } });
    expect(take()).toEqual(['eval', 'publish']);
  });

  it('gửi lại y hệt: Redis GET trúng -> chỉ 2 lệnh (EVAL + GET), không transaction', async () => {
    await runIngest();
    take();
    const raw = JSON.stringify(sepayBody);
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({
        id: 'src-sepay', tenantId: TENANT, provider: 'sepay', isActive: true, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(API_KEY, MASTER) }],
      }),
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(),
    };
    const res = await new IngestService(prisma, new RedisService()).ingestWebhook({
      provider: 'sepay', sourceKey: 'k', headers: { authorization: `Apikey ${API_KEY}` }, rawBody: Buffer.from(raw), body: JSON.parse(raw),
    });
    expect(res.status).toBe(200);
    expect(take()).toEqual(['eval', 'get']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('[EG:T8] EG3 (ADR-178): request SAI chữ ký KHÔNG gọi checkRateLimit -> 0 lệnh Redis (trước EG3: 1 EVAL); sự kiện hợp lệ vẫn 3', async () => {
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'rej' }) } };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({
        id: 'src-sepay', tenantId: TENANT, provider: 'sepay', isActive: true, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(API_KEY, MASTER) }],
      }),
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const svc = new IngestService(prisma, new RedisService());
    const spy = jest.spyOn(svc['redis'], 'checkRateLimit');
    const raw = JSON.stringify(sepayBody);
    const res = await svc.ingestWebhook({
      provider: 'sepay', sourceKey: 'src_sepay_main', headers: { authorization: 'Apikey sai-key' }, rawBody: Buffer.from(raw), body: JSON.parse(raw),
    });
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(take()).toEqual([]);
    await runIngest();
    expect(take()).toEqual(['eval', 'get', 'set']);
  });

  it('[PK:T10] (phần b) PK4 bắt tay (E9: không qua EG3, không GET/SET NX idem): 0 lệnh Redis — query-echo, body-echo, hmac-echo sau verify', async () => {
    const SECRET = `zoom-${process.pid}`;
    const sign = (body: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      return { 'x-zm-request-timestamp': ts, 'x-zm-signature': 'v0=' + require('crypto').createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex') };
    };
    const cases: Array<[unknown, any]> = [
      [{ scheme: 'hmac', header: 'x-sig', idempotency: { header: 'x-id' }, eventType: 'acme.x', handshake: { kind: 'query-echo', param: 'challenge' } }, { method: 'GET', query: 'challenge=abc', headers: {}, body: '' }],
      [{ scheme: 'hmac', header: 'x-sig', idempotency: { header: 'x-id' }, eventType: 'acme.x', handshake: { kind: 'body-echo', when: { field: 'type', equals: 'url_verification' }, echo: { field: 'challenge' } } }, { method: 'POST', query: '', headers: {}, body: '{"type":"url_verification","challenge":"c1"}' }],
      [
        { scheme: 'signed-template', template: 'v0:{timestamp}:{body}', signature: { headers: ['x-zm-signature'], prefix: 'v0=' }, timestampHeader: 'x-zm-request-timestamp', toleranceSec: 300, idempotency: { header: 'x-id' }, eventType: 'zoom.x', handshake: { kind: 'hmac-echo', when: { field: 'event', equals: 'endpoint.url_validation' }, tokenParent: 'payload', tokenField: 'plainToken', macField: 'encryptedToken' } },
        { method: 'POST', query: '', headers: null, body: '{"event":"endpoint.url_validation","payload":{"plainToken":"tok_1"}}' },
      ],
    ];
    for (const [verificationConfig, r] of cases) {
      const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'hs' }) }, outbox: { create: jest.fn() } };
      const prisma: any = {
        findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({ id: 'src-g', tenantId: TENANT, provider: 'generic', isActive: true, verificationConfig, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] }),
        tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
        $transaction: jest.fn(async (fn: any) => fn(tx)),
      };
      const res = await new IngestService(prisma, new RedisService()).ingestWebhook({
        provider: 'generic', sourceKey: 'src_generic_hs', headers: r.headers ?? sign(r.body), rawBody: Buffer.from(r.body), body: r.body ? JSON.parse(r.body) : undefined, method: r.method, query: r.query,
      });
      expect(res.status).toBe(200);
      expect(take()).toEqual([]);
      expect(tx.outbox.create).not.toHaveBeenCalled();
    }
  });

  it('[PK:T14] (phần e) PK5 nguồn unverified: nhận = 3 lệnh như mọi nguồn (EVAL + GET + SET), cờ tắt / 413 = 0 lệnh; normalize bỏ subscription không acceptUnverified = vẫn 1 PUBLISH', async () => {
    const UNV = { scheme: 'unverified', eventType: 'momo.ipn', idempotency: { field: 'transId' } };
    const ingest = async (allowUnverified: boolean, body: string) => {
      const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: RAW }) }, outbox: { create: jest.fn() } };
      const prisma: any = {
        findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({ id: 'src-u', tenantId: TENANT, provider: 'generic', isActive: true, verificationConfig: UNV, allowUnverified, secrets: [] }),
        tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
        $transaction: jest.fn(async (fn: any) => fn(tx)),
      };
      return new IngestService(prisma, new RedisService()).ingestWebhook({
        provider: 'generic', sourceKey: 'src_generic_unv', headers: {}, rawBody: Buffer.from(body), body: JSON.parse(body), method: 'POST', query: '',
      });
    };
    expect((await ingest(true, '{"transId":"T1"}')).status).toBe(200);
    expect(take()).toEqual(['eval', 'get', 'set']);
    expect((await ingest(false, '{"transId":"T2"}')).status).toBe(401);
    expect(take()).toEqual([]);
    expect((await ingest(true, JSON.stringify({ transId: 'T3', pad: 'x'.repeat(60 * 1024) }))).status).toBe(413);
    expect(take()).toEqual([]);

    // normalize: raw verified=false, 2 subscription khớp (1 bật acceptUnverified) -> 1 delivery, vẫn đúng 1 PUBLISH (bỏ qua là trong bộ nhớ).
    const subs = [{ id: 'sub-off', destination: { id: 'd0', name: 'd0', type: 'webhook' } }, { id: 'sub-on', acceptUnverified: true, destination: { id: 'd1', name: 'd1', type: 'webhook' } }];
    const tx = {
      event: { create: jest.fn(async ({ data }: any) => data) },
      subscription: { findMany: jest.fn().mockResolvedValue(subs) },
      delivery: { create: jest.fn(async ({ data }: any) => ({ ...data, id: 'del-u' })) },
      outbox: { create: jest.fn() },
      processedMessage: { create: jest.fn() },
    };
    const raw = '{"transId":"T1"}';
    const prisma: any = {
      forTenant: () => ({ findRawEventById: async () => ({ id: RAW, verified: false, headers: {}, body: JSON.parse(raw), bodyRaw: Buffer.from(raw), contentType: 'application/json', source: { verificationConfig: UNV } }) }),
      processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const channel: any = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn() };
    const payload = { rawEventId: RAW, sourceId: 'src-u', tenantId: TENANT, provider: 'generic', correlationId: 'c' };
    await new NormalizeConsumer(prisma).handleMessage({ content: Buffer.from(JSON.stringify(payload)), properties: { headers: {} } } as any, channel);
    expect(channel.ack).toHaveBeenCalled();
    expect(tx.delivery.create).toHaveBeenCalledTimes(1);
    expect(take()).toEqual(['publish']);
  });

  it('[LH:T11] request qua lưới hứng (header lưới ký đúng, kể cả phát lại) đi ĐÚNG đường ingest: 3 lệnh (EVAL + GET + SET), kiểm chữ ký lưới 0 lệnh', async () => {
    const FWD = `fwd-budget-${process.pid}-0123456789abcdef`;
    const prev = process.env.CATCHNET_FORWARD_SECRET;
    process.env.CATCHNET_FORWARD_SECRET = FWD;
    try {
      for (const [mode, id] of [['forward', 777101], ['replay', 777102]] as const) {
        const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: RAW }) }, outbox: { create: jest.fn() } };
        const prisma: any = {
          findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue({
            id: 'src-sepay', tenantId: TENANT, provider: 'sepay', isActive: true, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt(API_KEY, MASTER) }],
          }),
          tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
          $transaction: jest.fn(async (fn: any) => fn(tx)),
        };
        const raw = Buffer.from(JSON.stringify({ ...sepayBody, id }));
        const target = '/hooks/sepay/src_sepay_main';
        const cid = `01JBUDGET${id}`;
        const at = Date.now() - 60_000;
        const ip = '203.0.113.150';
        const h = (s: string) => createHmac('sha256', FWD).update(s).digest('hex');
        const headers: Record<string, string> = {
          authorization: `Apikey ${API_KEY}`, 'content-type': 'application/json',
          'x-catchnet-id': cid, 'x-catchnet-received-at': String(at), 'x-catchnet-client-ip': ip, 'x-catchnet-mode': mode,
          'x-catchnet-signature': `v1=${h(`${cid}.${at}.${ip}.${mode}.POST.${target}`)}`,
          'x-catchnet-body-signature': `v1=${h(`${cid}.${createHash('sha256').update(raw).digest('hex')}`)}`,
        };
        const out: any = {};
        const res: any = {
          set: (hs: Record<string, string>) => Object.assign(out, { headers: { ...(out.headers ?? {}), ...hs } }) && res,
          status: (n: number) => ((out.status = n), res),
          json: (b: unknown) => ((out.body = b), res),
          end: () => res,
          type: () => res,
          send: (b: unknown) => ((out.body = b), res),
        };
        const req: any = { method: 'POST', url: target, originalUrl: target, headers, rawBody: raw, body: JSON.parse(raw.toString()), ip: '198.51.100.7' };
        await new IngestController(new IngestService(prisma, new RedisService())).handleWebhook('sepay', 'src_sepay_main', req, res, headers);
        expect([out.status, out.headers?.['x-hub-outcome']]).toEqual([200, 'accepted']);
        // Đúng là đã đi nhánh lưới (via theo mode) — không phải request thường lọt qua.
        expect(tx.rawEvent.create.mock.calls[0][0].data.via).toBe(`catchnet-${mode}`);
        expect(take()).toEqual(['eval', 'get', 'set']);
      }
    } finally {
      if (prev === undefined) delete process.env.CATCHNET_FORWARD_SECRET;
      else process.env.CATCHNET_FORWARD_SECRET = prev;
    }
  });

  it('X9: POST /v1/p/:project/events đi qua persistAccepted -> ĐÚNG số lệnh như /hooks (EVAL + GET + SET); ApiKeyGuard 0 lệnh', async () => {
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: RAW }) }, outbox: { create: jest.fn() } };
    const prisma: any = {
      forTenant: () => ({ findSourceById: jest.fn().mockResolvedValue({ id: 'src-api', tenantId: TENANT, provider: 'api', isActive: true, secrets: [] }) }),
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const body = { type: 'order.created', data: { total: 1 }, idempotencyKey: 'ord-budget' };
    const svc = new IngestService(prisma, new RedisService());
    const res = await svc.publishFromService(TENANT, 'src-api', {
      provider: 'api', sourceKey: 'api_k', headers: {}, rawBody: Buffer.from(JSON.stringify(body)), body,
    });
    expect(res.status).toBe(202);
    expect(take()).toEqual(['eval', 'get', 'set']);
    // MS-R6: raw_event của /events mang origin 'api'
    expect(tx.rawEvent.create.mock.calls[0][0].data.origin).toBe('api');
    // gửi lại: Redis trúng -> 200 duplicate, 2 lệnh, không transaction
    const again = await svc.publishFromService(TENANT, 'src-api', {
      provider: 'api', sourceKey: 'api_k', headers: {}, rawBody: Buffer.from(JSON.stringify(body)), body,
    });
    expect(again).toEqual({ status: 200, body: { duplicate: true } });
    expect(take()).toEqual(['eval', 'get']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('ADR-235: console GET /api/v1/projects?include=stats (thẻ "Tất cả dự án") = 0 lệnh Redis — số đếm chỉ đọc Postgres; controller không nhận RedisService', async () => {
    const stats = async () => [{ tenantId: TENANT, createdAt: new Date(), sources: 1, endpoints: 1, members: 1, events24h: 1, failedAttempts24h: 0, dlq: 0, circuitOpen: 0, storageLevel: 'OK', openAlerts: { critical: 0, warning: 0, info: 0 } }];
    const prisma: any = {
      identity: () => ({ listMemberships: async () => [{ projectId: TENANT, slug: 't', name: 'T', environment: 'test', role: 'owner' }] }),
      listProjects: async () => [{ id: TENANT, slug: 't', name: 'T', environment: 'test', storageQuotaMb: null }],
      operatorProjectUsage: async () => [],
      memberProjectStatsAcrossTenants: stats,
      operatorProjectStatsAcrossTenants: stats,
    };
    const ctrl = new ProjectsController(prisma);
    await ctrl.list({ principal: { kind: 'user', id: 'u', isOperator: false } } as any, 'stats');
    await ctrl.list({ principal: { kind: 'user', id: 'u', isOperator: true } } as any, 'stats');
    expect(take()).toEqual([]);
    expect((Reflect.getMetadata('design:paramtypes', ProjectsController) ?? []).includes(RedisService)).toBe(false);
  });
});
