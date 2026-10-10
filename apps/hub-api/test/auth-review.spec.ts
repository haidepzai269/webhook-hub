import { reqCtx } from '../src/modules/auth/auth.controller';
import { clientIp, proxySecretValid } from '../src/modules/auth/client-ip';

/** Sửa theo REVIEW-AUTH-2026-10-11 (mã AR:R-n). */
describe('R-2 — IP client qua proxy web (ADR-110)', () => {
  const SECRET = 'VERIFY_ONLY_web_proxy_secret_32_chars_min_xx';
  const WEB_IP = '172.18.0.9'; // IP socket = container web
  const viaWeb = (client: string, secret = SECRET) =>
    ({ ip: WEB_IP, headers: { 'x-hub-client-ip': client, 'x-hub-proxy-secret': secret } }) as any;

  const prev = process.env.WEB_PROXY_SECRET;
  beforeEach(() => (process.env.WEB_PROXY_SECRET = SECRET));
  afterAll(() => (prev === undefined ? delete process.env.WEB_PROXY_SECRET : (process.env.WEB_PROXY_SECRET = prev)));

  it('[AR:R-2] (phần a) hai client đi qua proxy web (secret đúng) -> reqCtx ra HAI IP khác nhau, không phải IP của web', () => {
    const a = reqCtx(viaWeb('203.0.113.7'));
    const b = reqCtx(viaWeb('198.51.100.20'));
    expect(a.ip).toBe('203.0.113.7');
    expect(b.ip).toBe('198.51.100.20');
  });

  it('[AR:R-2] (phần b) secret sai / thiếu / server chưa đặt secret / IP rác -> bỏ qua header, dùng IP socket', () => {
    expect(reqCtx(viaWeb('203.0.113.7', 'sai-secret')).ip).toBe(WEB_IP);
    expect(reqCtx({ ip: WEB_IP, headers: { 'x-hub-client-ip': '203.0.113.7' } } as any).ip).toBe(WEB_IP);
    delete process.env.WEB_PROXY_SECRET;
    expect(reqCtx(viaWeb('203.0.113.7')).ip).toBe(WEB_IP);
    process.env.WEB_PROXY_SECRET = SECRET;
    expect(clientIp(viaWeb('203.0.113.7'), '')).toBe(WEB_IP);
    expect(reqCtx(viaWeb('not-an-ip, 1.2.3.4')).ip).toBe(WEB_IP);
    expect(proxySecretValid(['a', 'b'], SECRET)).toBe(false);
    expect(proxySecretValid(SECRET + 'x', SECRET)).toBe(false);
  });
});

describe('R-3 — socket đang mở bị ngắt khi mất phiên / mất quyền (ADR-112)', () => {
  const { RealtimeGateway } = require('../src/modules/realtime/realtime.gateway');
  const { JwtService } = require('@nestjs/jwt');
  const { loadAuthConfig } = require('../src/modules/auth/auth-config');
  const { onAccessRevoked } = require('../src/modules/realtime/access-revocation');
  const { AuthService } = require('../src/modules/auth/auth.service');
  const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });

  function sock(id: string, data: Record<string, string>) {
    return { id, data, disconnected: false, disconnect(this: any) { this.disconnected = true; } };
  }

  it('[AR:R-3] (phần a) recheckSockets: session đã thu hồi -> ngắt; bị xoá khỏi project -> ngắt; operator không là thành viên vẫn giữ; lọc theo userId', async () => {
    const sockets = [
      sock('dead', { sid: 's-dead', userId: 'u1', tenantId: 'p1' }),
      sock('removed', { sid: 's-e', userId: 'uE', tenantId: 'pA' }),
      sock('ok', { sid: 's-ok', userId: 'u2', tenantId: 'p2' }),
      sock('op', { sid: 's-op', userId: 'uOp', tenantId: 'pX' }),
    ];
    const calls: any[] = [];
    const prisma = {
      identity: () => ({
        socketAccess: async (sids: string[], pairs: any[]) => {
          calls.push({ sids, pairs });
          return {
            live: new Map([
              ['s-e', { userId: 'uE', isOperator: false }],
              ['s-ok', { userId: 'u2', isOperator: false }],
              ['s-op', { userId: 'uOp', isOperator: true }],
            ]),
            members: new Set(['u2:p2']),
          };
        },
      }),
    };
    const gw = new RealtimeGateway(new JwtService({}), cfg, prisma);
    gw.server = { sockets: { sockets: new Map(sockets.map((s) => [s.id, s])) } };
    expect(await gw.recheckSockets()).toBe(2);
    expect(sockets.filter((s) => s.disconnected).map((s) => s.id)).toEqual(['dead', 'removed']);
    expect(calls[0].sids).toHaveLength(4); // MỘT lô, không truy vấn từng socket
    calls.length = 0;
    await gw.recheckSockets('u2');
    expect(calls[0].sids).toEqual(['s-ok']);
  });

  it('[AR:R-3] (phần b) recheck lỗi DB -> không ngắt oan (lượt sau kiểm lại)', async () => {
    const s = sock('x', { sid: 's', userId: 'u', tenantId: 'p' });
    const gw = new RealtimeGateway(new JwtService({}), cfg, { identity: () => ({ socketAccess: async () => { throw new Error('db down'); } }) });
    gw.server = { sockets: { sockets: new Map([['x', s]]) } };
    expect(await gw.recheckSockets()).toBe(0);
    expect(s.disconnected).toBe(false);
  });

  it('[AR:R-3] (phần c) logout / logout-all / thu hồi thiết bị phát access.revoked cho đúng user', async () => {
    const got: string[] = [];
    const off = onAccessRevoked((u: string) => got.push(u));
    const idn = { revokeOwnFamily: async () => 1, revokeUserSessions: async () => 2, recordAuthAudit: async () => undefined };
    const svc = new AuthService({ identity: () => idn } as any, new JwtService({}), cfg, null as any);
    const p = { id: 'u9', sessionId: '00000000-0000-0000-0000-000000000001' } as any;
    const ctx = { ip: null, userAgent: null };
    await svc.logout(p, ctx);
    await svc.logoutAll(p, ctx);
    await svc.revokeSession(p, '00000000-0000-0000-0000-000000000002', ctx);
    off();
    expect(got).toEqual(['u9', 'u9', 'u9']);
  });
});

describe('R-10 — login CSRF qua form urlencoded (ADR-114)', () => {
  const { requireJsonBody } = require('../src/modules/auth/auth.controller');
  const st = (ct?: string) => {
    try {
      requireJsonBody({ headers: ct === undefined ? {} : { 'content-type': ct } });
      return 200;
    } catch (e: any) {
      return e.getStatus();
    }
  };
  it('[AR:R-10] login/register: urlencoded / text/plain / multipart / thiếu -> 415; application/json (kèm charset) -> qua', () => {
    expect(st('application/x-www-form-urlencoded')).toBe(415);
    expect(st('text/plain')).toBe(415);
    expect(st('multipart/form-data; boundary=x')).toBe(415);
    expect(st(undefined)).toBe(415);
    expect(st('application/json')).toBe(200);
    expect(st('Application/JSON; charset=utf-8')).toBe(200);
  });
});
