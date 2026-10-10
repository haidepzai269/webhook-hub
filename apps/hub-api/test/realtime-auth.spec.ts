import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway, computeTick } from '../src/modules/realtime/realtime.gateway';

// Socket.IO phải xác thực JWT ở handshake và cô lập theo tenant (BB-5 ở tầng realtime).
describe('RealtimeGateway — xác thực handshake', () => {
  const jwt = new JwtService({ secret: 'test-secret-at-least-32-characters-long!!' });
  const gateway = new RealtimeGateway(jwt);

  const run = (auth: any) => {
    const socket = { handshake: { auth }, data: {} as any } as any;
    let error: Error | undefined;
    let called = false;
    gateway.authenticate(socket, (err) => {
      called = true;
      error = err;
    });
    return { socket, error, called };
  };

  it('từ chối khi thiếu token', () => {
    const r = run({});
    expect(r.called).toBe(true);
    expect(r.error?.message).toBe('UNAUTHORIZED');
  });

  it('từ chối token ký bằng secret khác', () => {
    const forged = new JwtService({ secret: 'another-secret-another-secret-123456' }).sign({ sub: 'x', tenantId: 't1' });
    expect(run({ token: forged }).error?.message).toBe('UNAUTHORIZED');
  });

  it('từ chối token hợp lệ nhưng thiếu tenantId', () => {
    expect(run({ token: jwt.sign({ sub: 'admin' }) }).error?.message).toBe('UNAUTHORIZED');
  });

  it('chấp nhận token hợp lệ, gắn tenantId ĐÃ VERIFY và join đúng room tenant', () => {
    const r = run({ token: jwt.sign({ sub: 'admin', tenantId: 'tenant-a' }) });
    expect(r.error).toBeUndefined();
    expect(r.socket.data.tenantId).toBe('tenant-a');

    const join = jest.fn();
    gateway.handleConnection({ id: 'c1', data: r.socket.data, join } as any);
    expect(join).toHaveBeenCalledWith('tenant:tenant-a');
  });

});

describe('RealtimeGateway — phát theo room tenant (S2-2)', () => {
  function build() {
    const gateway = new RealtimeGateway(new JwtService({ secret: 'test-secret-at-least-32-characters-long!!' }));
    const emits: { room: string; event: string; data: any }[] = [];
    gateway.server = { to: (room: string) => ({ emit: (event: string, data: any) => emits.push({ room, event, data }) }) } as any;
    return { gateway, emits };
  }

  it('hub:realtime:circuit có tenantId -> chỉ tới room của tenant đó, tên circuit.changed', () => {
    const { gateway, emits } = build();
    const msg = { tenantId: 'tenant-a', destinationId: 'd1', from: 'CLOSED', to: 'OPEN', failures: 5, at: 'x' };
    gateway.handleRedisMessage('hub:realtime:circuit', JSON.stringify(msg));
    expect(emits).toEqual([{ room: 'tenant:tenant-a', event: 'circuit.changed', data: msg }]);
  });

  it('hub:realtime:circuit thiếu tenantId -> bị bỏ, không emit gì', () => {
    const { gateway, emits } = build();
    gateway.handleRedisMessage('hub:realtime:circuit', JSON.stringify({ destinationId: 'd1', to: 'OPEN' }));
    gateway.handleRedisMessage('hub:realtime:circuit', 'không phải json');
    expect(emits).toHaveLength(0);
  });

  it('hub:realtime:deliveries -> delivery.attempt (không còn delivery.updated)', () => {
    const { gateway, emits } = build();
    gateway.handleRedisMessage('hub:realtime:deliveries', JSON.stringify({ tenantId: 't', status: 'SUCCEEDED' }));
    expect(emits[0]).toMatchObject({ room: 'tenant:t', event: 'delivery.attempt' });
  });

  it('kênh lạ -> bỏ qua', () => {
    const { gateway, emits } = build();
    gateway.handleRedisMessage('hub:alerts', JSON.stringify({ tenantId: 't' }));
    expect(emits).toHaveLength(0);
  });

  it('traceIngested emit trace.ingested vào room tenant (in-process)', () => {
    const { gateway, emits } = build();
    gateway.traceIngested('tenant-b', { correlationId: 'c', provider: 'github', sourceKey: 's', httpStatus: 401, outcome: 'REJECTED', ms: 3 });
    expect(emits[0]).toMatchObject({ room: 'tenant:tenant-b', event: 'trace.ingested', data: { outcome: 'REJECTED' } });
  });

  it('[AF:#31] metrics.tick: successRate = null khi done = 0; có kết quả thì tính %', () => {
    expect(computeTick(undefined).successRate).toBeNull();
    expect(computeTick({ events: 3, success: 0, done: 0 })).toMatchObject({ eventsPerMin: 36, successRate: null });
    expect(computeTick({ events: 0, success: 1, done: 2 }).successRate).toBe(50);
  });
});
