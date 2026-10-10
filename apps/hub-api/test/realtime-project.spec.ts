import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { SocketTicketService } from '../src/modules/auth/socket-ticket.service';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { signSocketTicket } from '../src/modules/auth/tokens';
import { PrismaService } from '@hub/database';

/**
 * SPEC-auth §5.7 (thay R-5 cũ): socket vào room của project nhờ VÉ — vé chỉ phát khi người gọi qua CÙNG luật
 * phạm vi project của console (resolveProjectScope: tồn tại + là thành viên, hoặc operator). Gateway kiểm vé
 * (aud 'socket', exp 60s, khoá riêng) và session còn sống.
 */
const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });
const jwt = new JwtService({});
const CAFE = '391110c1-3a81-480a-93ab-e11de0be107a';
const BOOK = '5d0f9b3e-0000-4000-8000-000000000000';
const user = { kind: 'user' as const, id: 'u-1', sessionId: 'sid-1', email: 'a@b.vn', name: 'A', isOperator: false, emailVerified: true };

const liveSessions = new Set(['sid-1']);
const prisma: any = {
  findProjectById: async (id: string) => ([CAFE, BOOK].includes(id) ? { id } : null),
  identity: () => ({
    findMembershipRole: async (u: string, p: string) => (u === 'u-1' && p === CAFE ? 'viewer' : null),
    listMemberships: async () => [{ projectId: CAFE, role: 'viewer' }],
    findLiveSessionWithUser: async (sid: string) => (liveSessions.has(sid) ? { id: sid, userId: 'u-1' } : null),
  }),
};

const connect = (gw: RealtimeGateway, auth: Record<string, unknown>) =>
  new Promise<{ err?: Error; tenantId?: string }>((resolve) => {
    const socket: any = { handshake: { auth }, data: {} };
    gw.authenticate(socket, (err) => resolve({ err, tenantId: socket.data.tenantId }));
  });

describe('vé socket theo project (SPEC-auth §5.7)', () => {
  const tickets = new SocketTicketService(prisma, jwt, cfg);
  const gw = new RealtimeGateway(jwt, cfg, prisma);

  it('thành viên xin vé project của mình → socket vào room project đó', async () => {
    const { ticket, projectId } = await tickets.issue(user, CAFE);
    expect(projectId).toBe(CAFE);
    const r = await connect(gw, { ticket });
    expect(r.err).toBeUndefined();
    expect(r.tenantId).toBe(CAFE);
    const join = jest.fn();
    gw.handleConnection({ id: 'c1', data: { tenantId: r.tenantId }, join } as any);
    expect(join).toHaveBeenCalledWith(`project:${CAFE}`);
  });

  it('project tồn tại nhưng không là thành viên / không tồn tại / không phải UUID → 404 CÙNG body, không có vé', async () => {
    const bodies = [];
    for (const p of [BOOK, '11111111-2222-4333-8444-555555555555', "x' or 1=1"]) {
      const e = await tickets.issue(user, p).catch((x) => x);
      expect(e).toBeInstanceOf(HttpException);
      expect(e.getStatus()).toBe(404);
      bodies.push(JSON.stringify(e.getResponse()));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('[AU:UA29] vé sai aud / ký khoá khác / hết hạn / session đã thu hồi / thiếu vé → kết nối bị từ chối', async () => {
    const accessAsTicket = jwt.sign({ sub: 'u-1', sid: 'sid-1', tid: CAFE }, { secret: cfg.socketTicketSecret, algorithm: 'HS256', issuer: 'webhook-hub', audience: 'console', expiresIn: 60 });
    const otherKey = jwt.sign({ sub: 'u-1', sid: 'sid-1', tid: CAFE }, { secret: cfg.jwtSecret, algorithm: 'HS256', issuer: 'webhook-hub', audience: 'socket', expiresIn: 60 });
    const now = Math.floor(Date.now() / 1000);
    const expired = jwt.sign({ sub: 'u-1', sid: 'sid-1', tid: CAFE, iat: now - 120, exp: now - 60, iss: 'webhook-hub', aud: 'socket' }, { secret: cfg.socketTicketSecret, algorithm: 'HS256' });
    for (const ticket of [accessAsTicket, otherKey, expired, undefined]) {
      expect((await connect(gw, { ticket })).err?.message).toBe('UNAUTHORIZED');
    }
    const valid = signSocketTicket(jwt, cfg, { userId: 'u-1', sessionId: 'sid-1', projectId: CAFE });
    liveSessions.delete('sid-1');
    expect((await connect(gw, { ticket: valid })).err?.message).toBe('UNAUTHORIZED');
    liveSessions.add('sid-1');
    expect((await connect(new RealtimeGateway(jwt, cfg), { ticket: valid })).err?.message).toBe('UNAUTHORIZED'); // thiếu Prisma
  });

  it('DI: tham số prisma của gateway là LỚP PrismaService (Pick<> mất metadata -> Nest không inject -> mọi socket bị từ chối, bắt bởi TA8)', () => {
    const types = Reflect.getMetadata('design:paramtypes', RealtimeGateway) as unknown[];
    expect(types[2]).toBe(PrismaService);
  });

  it('token đăng nhập cũ (`auth.token`) không còn được chấp nhận', async () => {
    const legacy = jwt.sign({ sub: 'admin', tenantId: CAFE }, { secret: cfg.jwtSecret });
    expect((await connect(gw, { token: legacy })).err?.message).toBe('UNAUTHORIZED');
  });
});
