import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway, computeTick } from '../src/modules/realtime/realtime.gateway';

import { loadAuthConfig } from '../src/modules/auth/auth-config';

// Xác thực handshake bằng vé socket: xem realtime-project.spec.ts (SPEC-auth §5.7, UA29).
const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });

describe('RealtimeGateway — phát theo room tenant (S2-2)', () => {
  function build() {
    const gateway = new RealtimeGateway(new JwtService({}), cfg);
    const emits: { room: string; event: string; data: any }[] = [];
    gateway.server = { to: (room: string) => ({ emit: (event: string, data: any) => emits.push({ room, event, data }) }) } as any;
    return { gateway, emits };
  }

  it('hub:realtime:circuit có tenantId -> chỉ tới room của tenant đó, tên circuit.changed', () => {
    const { gateway, emits } = build();
    const msg = { tenantId: 'tenant-a', destinationId: 'd1', from: 'CLOSED', to: 'OPEN', failures: 5, at: 'x' };
    gateway.handleRedisMessage('hub:realtime:circuit', JSON.stringify(msg));
    expect(emits).toEqual([{ room: 'project:tenant-a', event: 'circuit.changed', data: msg }]);
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
    expect(emits[0]).toMatchObject({ room: 'project:t', event: 'delivery.attempt' });
  });

  it('kênh lạ -> bỏ qua', () => {
    const { gateway, emits } = build();
    gateway.handleRedisMessage('hub:alerts', JSON.stringify({ tenantId: 't' }));
    expect(emits).toHaveLength(0);
  });

  it('traceIngested emit trace.ingested vào room tenant (in-process)', () => {
    const { gateway, emits } = build();
    gateway.traceIngested('tenant-b', { correlationId: 'c', provider: 'github', sourceKey: 's', httpStatus: 401, outcome: 'REJECTED', ms: 3 });
    expect(emits[0]).toMatchObject({ room: 'project:tenant-b', event: 'trace.ingested', data: { outcome: 'REJECTED' } });
  });

  it('[AF:#31] metrics.tick: successRate = null khi done = 0; có kết quả thì tính %', () => {
    expect(computeTick(undefined).successRate).toBeNull();
    expect(computeTick({ events: 3, success: 0, done: 0 })).toMatchObject({ eventsPerMin: 36, successRate: null });
    expect(computeTick({ events: 0, success: 1, done: 2 }).successRate).toBe(50);
  });
});
