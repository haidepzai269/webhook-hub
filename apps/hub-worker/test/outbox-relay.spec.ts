import { OutboxRelay, routeForTopic } from '../src/scheduler/outbox.relay';

/**
 * S1-4 phát hiện khi kiểm trên docker: lúc chưa có channel (đang thử kết nối AMQP lại),
 * nhánh `!channel` gọi scheduleNext() rồi `finally` gọi lần nữa -> số timer nhân đôi mỗi
 * 500ms -> worker OOM sau ~40s chờ broker. Relay phải giữ đúng MỘT vòng lặp.
 */
describe('OutboxRelay', () => {
  afterEach(() => jest.useRealTimers());

  it('chưa có channel: chờ 20 vòng vẫn chỉ có 1 timer, không nhân đôi', async () => {
    jest.useFakeTimers();
    const prisma: any = { $transaction: jest.fn() };
    const relay = new OutboxRelay(prisma);
    relay.start();
    for (let i = 0; i < 20; i++) {
      await jest.advanceTimersByTimeAsync(700);
    }
    expect(jest.getTimerCount()).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    relay.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('TOPIC_ROUTES (S1-2): delivery.requested/replayed -> x.hub.delivery, event.received -> x.hub.events', () => {
    expect(routeForTopic('delivery.requested')).toEqual({ exchange: 'x.hub.delivery', routingKey: 'deliver' });
    expect(routeForTopic('delivery.replayed')).toEqual({ exchange: 'x.hub.delivery', routingKey: 'deliver' });
    expect(routeForTopic('event.received')).toEqual({ exchange: 'x.hub.events', routingKey: 'event.received' });
    expect(routeForTopic('la-lam')).toEqual({ exchange: 'x.hub.events', routingKey: 'event.received' });
  });
});

/** Review SPEC-3 #3: publish theo lô, chờ confirm theo lô, MỘT câu UPDATE, lô đầy thì chạy lượt kế ngay. */
describe('OutboxRelay — lô (review #3)', () => {
  const { RELAY_BATCH } = require('../src/scheduler/outbox.relay');

  function setup(n: number, opts: { failAt?: number } = {}) {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: BigInt(i + 1), topic: i % 2 ? 'delivery.requested' : 'event.received', payload: { correlationId: `c${i}` }, age_s: 3 - i * 0.001,
    }));
    const order: string[] = [];
    const pending: Array<() => void> = [];
    const channel: any = {
      publish: jest.fn((_ex: string, _rk: string, _buf: Buffer, _o: any, cb: (e?: Error) => void) => {
        order.push('publish');
        const idx = channel.publish.mock.calls.length;
        // confirm đến SAU (bất đồng bộ) — relay không được chờ từng cái trước khi publish cái kế
        pending.push(() => cb(opts.failAt === idx ? new Error('nack') : undefined));
        return true;
      }),
    };
    const tx: any = {
      $queryRawUnsafe: jest.fn(async () => rows),
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: any[]) => {
        order.push('update');
        return { sql: strings.join('?'), vals };
      }),
    };
    const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const relay = new OutboxRelay(prisma);
    const flush = () => pending.splice(0).forEach((f) => f());
    return { relay, channel, tx, order, flush };
  }

  it('publish cả lô trước, confirm theo lô, rồi MỘT UPDATE id = ANY(...)', async () => {
    const { relay, channel, tx, order, flush } = setup(5);
    const p = relay.relayBatch(channel);
    await new Promise((r) => setImmediate(r));
    expect(channel.publish).toHaveBeenCalledTimes(5); // không đợi confirm từng cái
    expect(tx.$executeRaw).not.toHaveBeenCalled(); // chưa confirm thì chưa đánh dấu
    flush();
    expect(await p).toBe(5);
    expect(order).toEqual(['publish', 'publish', 'publish', 'publish', 'publish', 'update']);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ids] = tx.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('id = ANY(');
    expect(ids).toEqual(['1', '2', '3', '4', '5']);
  });

  it('một message bị nack -> ném (rollback cả lô), KHÔNG UPDATE', async () => {
    const { relay, channel, tx, flush } = setup(3, { failAt: 2 });
    const p = relay.relayBatch(channel);
    await new Promise((r) => setImmediate(r));
    flush();
    await expect(p).rejects.toThrow('nack');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('lô đầy -> lượt kế chạy NGAY (0ms); lô lẻ -> chờ ~500ms', async () => {
    jest.useFakeTimers();
    const prisma: any = { $transaction: jest.fn() };
    const relay = new OutboxRelay(prisma);
    relay.setChannel({} as any);
    const spy = jest.spyOn(relay, 'relayBatch').mockResolvedValueOnce(RELAY_BATCH).mockResolvedValueOnce(3).mockResolvedValue(0);
    relay.start();
    // lượt 1 (đầy) sau ~500ms; lượt 2 chạy NGAY sau đó trong cùng khoảng (không chờ thêm ~500ms)
    await jest.advanceTimersByTimeAsync(601);
    expect(spy).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(100); // lô lẻ -> chưa chạy lượt 3
    expect(spy).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(700);
    expect(spy).toHaveBeenCalledTimes(3);
    relay.stop();
  });
});
