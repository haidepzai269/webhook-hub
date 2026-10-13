import { JwtService } from '@nestjs/jwt';
import { ALERT_REALTIME_CHANNEL, ownerVisibleRules } from '@hub/common';
import { alertSummaryFor, listAlertsFor } from '../src/modules/alerts/alerts-api';
import { getStorageEmail, putStorageEmail } from '../src/modules/storage/storage-api';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { signSocketTicket } from '../src/modules/auth/tokens';

/**
 * QT6 (SPEC-han-muc-dung-luong ĐÍNH CHÍNH E3, ADR-190): owner thấy cảnh báo DUNG LƯỢNG của project mình — API lọc theo
 * quyền (escape hatch có tên `ownerAlerts…`), room `project:<id>:owners`, R-3 rời room khi mất vai trò owner.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ALERT = '33333333-3333-4333-8333-333333333333';

const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return toErrorBody(e, 'req-1');
  }
  throw new Error('không ném lỗi');
};

function store(memberships: { projectId: string; role: string }[]) {
  const calls: any[] = [];
  const s: any = {
    operatorAlertsAcrossTenants: async (f: any) => {
      calls.push({ operator: f });
      return [];
    },
    operatorAlertSummaryAcrossTenants: async () => {
      calls.push({ operatorSummary: true });
      return { totals: { critical: 9, warning: 9, info: 0, unacked: 9, unackedBySeverity: { critical: 9, warning: 9, info: 0 } }, perProject: [] };
    },
    ownerAlertsAcrossTenants: async (userId: string, rules: string[], f: any) => {
      calls.push({ owner: userId, rules, f });
      return [];
    },
    ownerAlertSummaryAcrossTenants: async (userId: string, rules: string[]) => {
      calls.push({ ownerSummary: userId, rules });
      return { totals: { critical: 1, warning: 0, info: 0, unacked: 1, unackedBySeverity: { critical: 1, warning: 0, info: 0 } }, perProject: [] };
    },
    identity: () => ({ listMemberships: async () => memberships.map((m) => ({ ...m, slug: 's', name: 'n', environment: 'dev' })) }),
  };
  return { s, calls };
}

describe('[QT:T34] (phần b) API cảnh báo lọc theo quyền', () => {
  it('owner: chỉ luật owners+operator (project.storage_*) qua escape hatch owner — không gọi đường operator; lọc luật CB -> trang rỗng (rules = [])', async () => {
    const { s, calls } = store([{ projectId: A, role: 'owner' }, { projectId: B, role: 'developer' }]);
    const r = await listAlertsFor(s, { userId: 'u-own', isOperator: false }, {});
    expect(r).toMatchObject({ items: [], scope: 'owner' });
    expect(calls).toEqual([{ owner: 'u-own', rules: ownerVisibleRules(), f: expect.objectContaining({ rule: undefined }) }]);
    await listAlertsFor(s, { userId: 'u-own', isOperator: false }, { rule: 'destination.auth_rejected' });
    expect(calls[1].rules).toEqual([]);
    await listAlertsFor(s, { userId: 'u-own', isOperator: false }, { rule: 'project.storage_locked' });
    expect(calls[2].rules).toEqual(['project.storage_locked']);
    const sum = await alertSummaryFor(s, { userId: 'u-own', isOperator: false });
    expect(sum).toMatchObject({ openBySeverity: { critical: 1 }, scope: 'owner' });
    expect(calls[3]).toEqual({ ownerSummary: 'u-own', rules: ownerVisibleRules() });
  });

  it('developer/viewer (không owner project nào) -> 403 operator_required như cũ; operator -> đường operator như cũ (mọi luật, mọi project)', async () => {
    const dev = store([{ projectId: A, role: 'developer' }, { projectId: B, role: 'viewer' }]);
    const e = await errOf(listAlertsFor(dev.s, { userId: 'u-dev', isOperator: false }, {}));
    expect(e.status).toBe(403);
    expect(e.body).toMatchObject({ error: 'operator_required' });
    expect((await errOf(alertSummaryFor(dev.s, { userId: 'u-dev', isOperator: false }))).status).toBe(403);
    expect(dev.calls).toEqual([]);
    const op = store([]);
    await listAlertsFor(op.s, { userId: 'u-op', isOperator: true }, {});
    await alertSummaryFor(op.s, { userId: 'u-op', isOperator: true });
    expect(op.calls.map((c) => Object.keys(c)[0])).toEqual(['operator', 'operatorSummary']);
  });

  it('công tắc email 70/85 của chính owner: chỉ nhận {warnEmail: bool}, ghi audit; người không phải thành viên -> 400; 95%/LOCKED luôn bật', async () => {
    let on: boolean | null = true;
    const audits: any[] = [];
    const st: any = {
      identity: () => ({ findStorageWarnEmail: async () => on, setStorageWarnEmail: async (_p: string, _u: string, v: boolean) => (on === null ? 0 : ((on = v), 1)) }),
      tenantTx: async (_t: string, fn: any) => fn({}),
      forTenant: () => ({ createAuditLog: async (x: any) => audits.push(x) }),
    };
    expect(await putStorageEmail(st, A, 'u-own', { warnEmail: false })).toEqual({ member: true, warnEmail: false, criticalEmail: true, lockedEmail: true });
    expect(audits).toEqual([expect.objectContaining({ action: 'storage.email_changed', metadata: { warnEmail: false } })]);
    expect(await getStorageEmail(st, A, 'u-own')).toMatchObject({ member: true, warnEmail: false, lockedEmail: true });
    expect((await errOf(putStorageEmail(st, A, 'u-own', { warnEmail: 'no' }))).status).toBe(400);
    expect((await errOf(putStorageEmail(st, A, 'u-own', { warnEmail: true, lockedEmail: false }))).status).toBe(400);
    on = null;
    expect((await errOf(putStorageEmail(st, A, 'u-op', { warnEmail: true }))).status).toBe(400);
  });
});

describe('[QT:T34] (phần c) realtime: room project:<id>:owners cho cảnh báo dung lượng; R-3 rời room khi mất vai trò owner', () => {
  const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });
  const jwt = new JwtService({});
  const sessions: Record<string, { userId: string; isOperator: boolean }> = {
    's-own': { userId: 'u-own', isOperator: false },
    's-dev': { userId: 'u-dev', isOperator: false },
    's-op': { userId: 'u-op', isOperator: true },
    's-ownB': { userId: 'u-ownB', isOperator: false },
  };
  const roles: Record<string, string> = { [`u-own:${A}`]: 'owner', [`u-dev:${A}`]: 'developer', [`u-op:${A}`]: 'owner', [`u-ownB:${B}`]: 'owner' };
  const prisma: any = {
    identity: () => ({
      findLiveSessionWithUser: async (sid: string) => (sessions[sid] ? { id: sid, userId: sessions[sid].userId, user: { isOperator: sessions[sid].isOperator } } : null),
      findMembershipRole: async (u: string, p: string) => roles[`${u}:${p}`] ?? null,
      socketAccess: async (sids: string[]) => ({
        live: new Map(sids.filter((x) => sessions[x]).map((x) => [x, sessions[x]])),
        members: new Set(Object.keys(roles)),
        owners: new Set(Object.keys(roles).filter((k) => roles[k] === 'owner')),
      }),
    }),
  };

  function world() {
    const gw = new RealtimeGateway(jwt, cfg, prisma);
    const rooms = new Map<string, Set<any>>();
    const sockets = new Map<string, any>();
    gw.server = {
      to: (room: string | string[]) => ({
        emit: (event: string, data: any) => {
          const hit = new Set<any>();
          for (const r of ([] as string[]).concat(room)) rooms.get(r)?.forEach((s) => hit.add(s));
          hit.forEach((s) => s.got.push({ event, data }));
        },
      }),
      sockets: { sockets, adapter: { rooms } },
    } as any;
    const connect = async (sid: string, projectId: string) => {
      const userId = sessions[sid].userId;
      const s: any = {
        id: sid,
        handshake: { auth: { ticket: signSocketTicket(jwt, cfg, { userId, sessionId: sid, projectId }) } },
        data: {},
        got: [] as any[],
        join: (r: string) => (rooms.get(r) ?? rooms.set(r, new Set()).get(r))!.add(s),
        leave: (r: string) => rooms.get(r)?.delete(s),
        disconnect: () => {
          s.disconnected = true;
        },
      };
      const err = await new Promise<Error | undefined>((res) => gw.authenticate(s, res));
      expect(err).toBeUndefined();
      gw.handleConnection(s);
      sockets.set(sid, s);
      return s;
    };
    return { gw, connect };
  }
  const storage = { id: ALERT, tenantId: A, rule: 'project.storage_locked', severity: 'critical', state: 'OPEN', titleKey: 'alerts.rules.project.storage_locked.title' };
  const cb = { ...storage, rule: 'destination.auth_rejected', titleKey: 'alerts.rules.destination.auth_rejected.title' };

  it('owner A nhận cảnh báo dung lượng của A (một lần dù operator kiêm owner), KHÔNG nhận luật CB; developer A và owner B không nhận', async () => {
    const { gw, connect } = world();
    const own = await connect('s-own', A);
    const dev = await connect('s-dev', A);
    const op = await connect('s-op', A);
    const ownB = await connect('s-ownB', B);
    gw.handleRedisMessage(ALERT_REALTIME_CHANNEL, JSON.stringify(storage));
    gw.handleRedisMessage(ALERT_REALTIME_CHANNEL, JSON.stringify(cb));
    expect(own.got).toEqual([{ event: 'alert.changed', data: { ...storage, audience: 'owners+operator' } }]);
    expect(op.got.map((g: any) => g.data.rule)).toEqual(['project.storage_locked', 'destination.auth_rejected']);
    expect(dev.got).toEqual([]);
    expect(ownB.got).toEqual([]);
  });

  it('mất vai trò owner (vẫn là thành viên) -> R-3 giữ kết nối, rời room owners -> không nhận nữa', async () => {
    const { gw, connect } = world();
    const own = await connect('s-own', A);
    roles[`u-own:${A}`] = 'viewer';
    try {
      expect(await gw.recheckSockets()).toBe(0);
      expect(own.disconnected).toBeUndefined();
      expect(own.data.isOwner).toBe(false);
      gw.handleRedisMessage(ALERT_REALTIME_CHANNEL, JSON.stringify(storage));
      expect(own.got).toEqual([]);
    } finally {
      roles[`u-own:${A}`] = 'owner';
    }
  });
});
