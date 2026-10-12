/**
 * ADR-180: RealtimeGateway mở MỘT connection subscriber và phục vụ cả kênh của module khác qua `redis-channels.ts`
 * (Upstash giới hạn số kết nối). Kênh realtime của hub-worker vẫn đi `handleRedisMessage` như cũ.
 * Review T-1: subscribe ở MỖI lần 'ready' — kể cả khi lần connect đầu lỗi và ioredis tự kết nối lại.
 */
const fake = {
  status: 'wait',
  instances: 0,
  /** Mỗi lời gọi SUBSCRIBE = một mảng kênh. */
  subscribes: [] as string[][],
  listeners: new Map<string, ((...a: any[]) => void)[]>(),
  failFirstConnect: true,
  emit(ev: string, ...args: any[]) {
    for (const fn of this.listeners.get(ev) ?? []) fn(...args);
  },
  /** Mô phỏng ioredis: tới trạng thái ready rồi phát 'ready'. */
  becomeReady() {
    this.status = 'ready';
    this.emit('ready');
  },
};

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => {
    fake.instances++;
    return {
      get status() {
        return fake.status;
      },
      connect: async () => {
        if (fake.failFirstConnect) {
          fake.status = 'reconnecting'; // ioredis: promise connect bị reject nhưng vẫn tự thử lại
          throw new Error('connect ECONNREFUSED');
        }
        fake.becomeReady();
      },
      subscribe: (...args: unknown[]) => {
        const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (e: Error | null) => void) : null;
        fake.subscribes.push(args as string[]);
        cb?.(null);
        return Promise.resolve(args.length);
      },
      on: (ev: string, fn: (...a: any[]) => void) => {
        fake.listeners.set(ev, [...(fake.listeners.get(ev) ?? []), fn]);
      },
      quit: async () => 'OK',
    };
  }),
);

import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { onRedisChannel } from '../src/modules/redis/redis-channels';

describe('RealtimeGateway — subscriber dùng chung (ADR-180)', () => {
  it('connect đầu lỗi -> kênh (kể cả đăng ký lúc reconnecting) được subscribe khi ready; ready lần hai subscribe lại đủ; tin tới đúng handler', async () => {
    const got: string[] = [];
    const offA = onRedisChannel('hub:test:truoc', (m) => got.push(`truoc:${m}`));
    const gw = new RealtimeGateway({} as never, {} as never);
    const server: any = { use: () => undefined, to: jest.fn(() => ({ emit: jest.fn() })), sockets: { adapter: { rooms: new Map() } } };
    gw.server = server;
    const realtime = jest.spyOn(gw, 'handleRedisMessage');
    gw.afterInit(server);
    await new Promise((r) => setImmediate(r));
    let offB: (() => void) | undefined;
    try {
      expect(fake.instances).toBe(1);
      expect(fake.status).toBe('reconnecting');
      expect(fake.subscribes).toEqual([]); // chưa ready: chưa subscribe gì

      // Đăng ký kênh trong lúc reconnecting -> KHÔNG subscribe ngay, nhưng có mặt ở lần ready.
      offB = onRedisChannel('hub:test:sau', (m) => got.push(`sau:${m}`));
      expect(fake.subscribes).toEqual([]);

      fake.becomeReady(); // ioredis kết nối lại thành công
      expect(fake.subscribes).toHaveLength(1);
      expect(fake.subscribes[0]).toEqual(
        expect.arrayContaining(['hub:realtime:events', 'hub:realtime:deliveries', 'hub:realtime:circuit', 'hub:test:truoc', 'hub:test:sau']),
      );

      // Kênh đăng ký khi ĐÃ ready -> subscribe ngay.
      const offC = onRedisChannel('hub:test:khi-ready', () => undefined);
      expect(fake.subscribes[1]).toEqual(['hub:test:khi-ready']);

      // Mất kết nối rồi ready lần hai -> subscribe lại đủ mọi kênh.
      fake.status = 'reconnecting';
      fake.becomeReady();
      expect(fake.subscribes).toHaveLength(3);
      expect(fake.subscribes[2]).toEqual(expect.arrayContaining(['hub:realtime:events', 'hub:test:truoc', 'hub:test:sau', 'hub:test:khi-ready']));
      offC();

      // Handler 'message' gắn từ đầu (ngoài promise connect), đúng MỘT.
      expect(fake.listeners.get('message')).toHaveLength(1);
      const emit = fake.listeners.get('message')![0];
      emit('hub:test:truoc', 'a');
      emit('hub:test:sau', 'b');
      emit('hub:realtime:events', JSON.stringify({ tenantId: 't-1', events: [] }));
      emit('hub:la', 'bo-qua');
      expect(got).toEqual(['truoc:a', 'sau:b']);
      expect(realtime).toHaveBeenCalledTimes(1);
      expect(realtime).toHaveBeenCalledWith('hub:realtime:events', expect.any(String));
    } finally {
      offA();
      offB?.();
      gw.onModuleDestroy();
    }
  });
});
