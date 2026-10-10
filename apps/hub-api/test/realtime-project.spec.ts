import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';

/**
 * R-5 (review MS-UI): socket của màn Event Flow vào room của project đang xem, kiểm bằng CÙNG luật
 * ProjectScopeGuard (resolveProjectScope): project phải tồn tại; sai thì từ chối, không rơi về tenant JWT.
 */
describe('RealtimeGateway — handshake theo project (R-5)', () => {
  const jwt = new JwtService({ secret: 'test-secret-at-least-32-characters-long!!' });
  const token = jwt.sign({ sub: 'admin', tenantId: '00000000-0000-0000-0000-000000000001' });
  const CAFE = '391110c1-3a81-480a-93ab-e11de0be107a';
  const prisma = { findProjectById: jest.fn(async (id: string) => (id === CAFE ? { id } : null)) } as any;

  const run = (gw: RealtimeGateway, auth: Record<string, unknown>) =>
    new Promise<{ err?: Error; tenantId?: string }>((resolve) => {
      const socket: any = { handshake: { auth }, data: {} };
      gw.authenticate(socket, (err) => resolve({ err, tenantId: socket.data.tenantId }));
    });

  it('[UI:R5-01] không gửi projectId → room tenant của JWT như cũ', async () => {
    const r = await run(new RealtimeGateway(jwt, prisma), { token });
    expect(r.err).toBeUndefined();
    expect(r.tenantId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('[UI:R5-02] projectId của project tồn tại → room của project đó', async () => {
    const r = await run(new RealtimeGateway(jwt, prisma), { token, projectId: CAFE });
    expect(r.err).toBeUndefined();
    expect(r.tenantId).toBe(CAFE);
  });

  it('[UI:R5-03] projectId lạ / không phải UUID / thiếu Prisma → từ chối (không rơi về tenant JWT)', async () => {
    for (const projectId of ['5d0f9b3e-0000-4000-8000-000000000000', "x' or 1=1"]) {
      const r = await run(new RealtimeGateway(jwt, prisma), { token, projectId });
      expect(r.err?.message).toBe('PROJECT_NOT_FOUND');
    }
    expect((await run(new RealtimeGateway(jwt), { token, projectId: CAFE })).err?.message).toBe('PROJECT_NOT_FOUND');
    expect((await run(new RealtimeGateway(jwt, prisma), { projectId: CAFE })).err?.message).toBe('UNAUTHORIZED');
  });
});
