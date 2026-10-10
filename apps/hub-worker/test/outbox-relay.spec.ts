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
