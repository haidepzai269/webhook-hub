import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { ALERT_REALTIME_CHANNEL, ALERT_RULE_CODES, DEFAULT_EMAIL_RULES } from '@hub/common';
import { AlertsController, MeLocaleController } from '../src/modules/alerts/alerts.controller';
import {
  ackAlert,
  ackAllAlerts,
  alertSummary,
  getAlertPreferences,
  listAlerts,
  parseAlertPreferences,
  putAlertPreferences,
  putUserLocale,
} from '../src/modules/alerts/alerts-api';
import { OperatorGuard } from '../src/modules/console/operator.guard';
import { SessionGuard } from '../src/modules/auth/session.guard';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';
import { encodeKeyset } from '../src/modules/api/list-params';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { loadAuthConfig } from '../src/modules/auth/auth-config';
import { signSocketTicket } from '../src/modules/auth/tokens';

/**
 * CB3 (SPEC-canh-bao-nhan-dinh §5.2/§5.3, ADR-169) — phần thuần: OperatorGuard + khuôn lỗi, kiểm đầu vào (400), ack
 * idempotent + audit, realtime `alert.changed` chỉ tới room của project trong tin. Phần Postgres: alerts-api-db.spec.ts.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ALERT = '33333333-3333-4333-8333-333333333333';

const bodyOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    const { status, body } = toErrorBody(e, 'req-1');
    return { status, body };
  }
  throw new Error('không ném lỗi');
};

const ctxOf = (principal: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ principal }) }) }) as any;
const user = (isOperator: boolean) => ({ kind: 'user', id: 'u-1', sessionId: 's', email: 'a@b.vn', name: 'A', isOperator, emailVerified: true });

describe('[CB:T10] (phần a) chỉ operator: /alerts* và /me/alert-preferences -> 403 operator_required theo khuôn lỗi', () => {
  it('OperatorGuard: không phải operator (kể cả owner) -> 403 {error, message, fix, docsUrl, requestId}; operator qua; chưa đăng nhập -> 401', async () => {
    const g = new OperatorGuard();
    const r = await bodyOf(() => g.canActivate(ctxOf(user(false))));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'operator_required', docsUrl: expect.stringContaining('#operator_required'), requestId: 'req-1' });
    expect(typeof r.body.message).toBe('string');
    expect(typeof r.body.fix).toBe('string');
    expect(g.canActivate(ctxOf(user(true)))).toBe(true);
    expect((await bodyOf(() => g.canActivate(ctxOf(undefined)))).status).toBe(401);
    expect((await bodyOf(() => g.canActivate(ctxOf({ kind: 'key', id: 'k', tenantId: A, scopes: [] })))).status).toBe(401);
  });

  it('mọi route của AlertsController (alerts, summary, ack, ack-all, me/alert-preferences GET/PUT) chạy SessionGuard rồi OperatorGuard; /me/locale chỉ SessionGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AlertsController)).toEqual([SessionGuard, OperatorGuard]);
    const routes = Object.getOwnPropertyNames(AlertsController.prototype)
      .filter((n) => n !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, (AlertsController.prototype as any)[n]) !== undefined)
      .map((n) => Reflect.getMetadata(PATH_METADATA, (AlertsController.prototype as any)[n]));
    expect(routes.sort()).toEqual(['alerts', 'alerts/:id/ack', 'alerts/ack-all', 'alerts/summary', 'me/alert-preferences', 'me/alert-preferences', 'me/alert-preferences/test-email'].sort());
    for (const n of Object.getOwnPropertyNames(AlertsController.prototype).filter((x) => x !== 'constructor')) {
      expect(Reflect.getMetadata(GUARDS_METADATA, (AlertsController.prototype as any)[n]) ?? []).toEqual([]); // không route nào tự thay guard
    }
    expect(Reflect.getMetadata(GUARDS_METADATA, MeLocaleController)).toEqual([SessionGuard]);
  });
});

/** Store giả: ghi lại lời gọi escape hatch + transaction. */
function fakeStore(
  opts: { rows?: any[]; tenantOf?: Record<string, string>; ackResults?: { found: boolean; changed: boolean }[]; projects?: string[]; stillOpen?: string[] } = {},
) {
  const calls: any[] = [];
  const audits: any[] = [];
  const authAudits: any[] = [];
  const ackResults = [...(opts.ackResults ?? [])];
  const repo = (tenantId: string) => ({
    ackAlert: async () => ackResults.shift() ?? { found: false, changed: false },
    // Chỉ id trong `stillOpen` còn OPEN + chưa xem (giả lập bộ lọc của repo).
    ackAlertsByIds: async (ids: string[]) => {
      calls.push({ ackIds: tenantId, ids });
      return ids.filter((id) => (opts.stillOpen ?? ids).includes(id));
    },
    findAlertById: async (id: string) => ({ id, state: 'OPEN', acknowledgedAt: new Date('2026-10-12T00:00:00Z'), acknowledgedBy: 'u-1' }),
    createAuditLog: async (x: any) => audits.push({ tenantId, ...x }),
  });
  let prefs: any = null;
  const idn = {
    findAlertPreferences: async () => prefs,
    upsertAlertPreferences: async (_u: string, d: any) => (prefs = { emailEnabled: false, emailRules: [...DEFAULT_EMAIL_RULES], emailOnResolve: false, mutedProjects: [], ...(prefs ?? {}), ...d, updatedAt: new Date() }),
    recordAuthAudit: async (x: any) => authAudits.push(x),
    findUserById: async () => ({ id: 'u-1', locale: 'vi' }),
    setUserLocale: async () => 1,
  };
  const store: any = {
    operatorAlertsAcrossTenants: async (f: any) => {
      calls.push(f);
      return opts.rows ?? [];
    },
    // tổng (totals) tính riêng, không cộng từ perProject (có trần) — review L1
    operatorAlertSummaryAcrossTenants: async () => ({
      totals: { critical: 7, warning: 9, info: 1, unacked: 12, unackedBySeverity: { critical: 3, warning: 8, info: 1 } },
      perProject: [
        { project: { id: A, slug: 'a', name: 'A' }, critical: 2, warning: 1, info: 0, unacked: 2 },
        { project: { id: B, slug: 'b', name: 'B' }, critical: 0, warning: 3, info: 1, unacked: 0 },
      ],
    }),
    operatorFindAlertTenants: async (ids: string[]) => {
      calls.push({ findTenants: ids });
      return ids.filter((id) => opts.tenantOf?.[id]).map((id) => ({ id, tenantId: opts.tenantOf![id] }));
    },
    operatorFindAlertTenant: async (id: string) => opts.tenantOf?.[id] ?? null,
    tenantTx: async (t: string, fn: any) => fn({ tx: t }),
    forTenant: (t: string) => repo(t),
    findProjectById: async (id: string) => ((opts.projects ?? [A, B]).includes(id) ? { id } : null),
    findExistingProjectIds: async (ids: string[]) => ids.filter((id) => (opts.projects ?? [A, B]).includes(id)),
    identity: () => idn,
    $transaction: async (fn: any) => fn({}),
  };
  return { store, calls, audits, authAudits };
}

describe('GET /api/v1/alerts — kiểm đầu vào (400 bad_request kèm field)', () => {
  it.each([
    [{ state: 'open' }, 'state'],
    [{ severity: 'fatal' }, 'severity'],
    [{ rule: 'order.created' }, 'rule'],
    [{ project: 'cafe' }, 'project'],
    [{ cursor: 'rác' }, 'before'],
    [{ cursor: encodeKeyset({ at: '2026-10-12T00:00:00.000000', id: A }), after: encodeKeyset({ at: '2026-10-12T00:00:00.000000', id: A }) }, 'cursor'],
    [{ limit: '-1' }, 'limit'],
    [{ state: ['OPEN', 'RESOLVED'] }, 'state'],
  ])('%j -> 400 field=%s', async (q, field) => {
    const r = await bodyOf(listAlerts(fakeStore().store, q as any));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_request', field });
  });

  it('bộ lọc hợp lệ đi thẳng vào escape hatch; `cursor` = before (trang cũ hơn); mỗi dòng có project + titleKey, không cursorAt/tenantId', async () => {
    const row = {
      id: ALERT, tenantId: A, rule: 'destination.auth_rejected', severity: 'critical', subjectType: 'destination', subjectId: B, state: 'OPEN',
      openedAt: new Date(), lastSeenAt: new Date(), resolvedAt: null, facts: { count: 3 }, acknowledgedAt: null, acknowledgedBy: null,
      cursorAt: '2026-10-12T00:00:00.000001', project: { id: A, slug: 'a', name: 'A' },
    };
    const { store, calls } = fakeStore({ rows: [row] });
    const cursor = encodeKeyset({ at: '2026-10-12T01:00:00.000000', id: B });
    const out = await listAlerts(store, { state: 'OPEN', severity: 'critical', rule: 'destination.auth_rejected', project: A.toUpperCase(), cursor, limit: '10' });
    expect(calls[0]).toEqual({ state: 'OPEN', severity: 'critical', rule: 'destination.auth_rejected', projectId: A, dir: 'older', cursor: { at: '2026-10-12T01:00:00.000000', id: B }, limit: 10 });
    expect(out.items).toEqual([expect.objectContaining({ id: ALERT, titleKey: 'alerts.rules.destination.auth_rejected.title', project: { id: A, slug: 'a', name: 'A' }, facts: { count: 3 } })]);
    expect(out.items[0]).not.toHaveProperty('cursorAt');
    expect(out.items[0]).not.toHaveProperty('tenantId');
    expect(out.next).toBeNull();
  });
});

describe('GET /api/v1/alerts/summary', () => {
  it('openBySeverity + unacked lấy từ tổng KHÔNG trần (không cộng perProject có trần 500); perProject giữ nguyên {project, critical, warning, …}', async () => {
    expect(await alertSummary(fakeStore().store)).toEqual({
      openBySeverity: { critical: 7, warning: 9, info: 1 },
      unacked: 12,
      unackedBySeverity: { critical: 3, warning: 8, info: 1 },
      perProject: [expect.objectContaining({ project: { id: A, slug: 'a', name: 'A' }, critical: 2, warning: 1 }), expect.objectContaining({ project: expect.objectContaining({ id: B }) })],
    });
  });
});

describe('POST /api/v1/alerts/:id/ack + ack-all', () => {
  it('id không phải UUID / không có cảnh báo -> 404 not_found (không lộ gì); lần đầu ghi + audit, lần hai changed:false không audit thêm', async () => {
    const { store, audits } = fakeStore({ tenantOf: { [ALERT]: A }, ackResults: [{ found: true, changed: true }, { found: true, changed: false }] });
    expect((await bodyOf(ackAlert(store, 'x', 'u-1'))).body).toMatchObject({ error: 'not_found' });
    expect((await bodyOf(ackAlert(store, B, 'u-1'))).status).toBe(404);
    expect(await ackAlert(store, ALERT.toUpperCase(), 'u-1')).toMatchObject({ id: ALERT, changed: true, acknowledgedBy: 'u-1' });
    expect(await ackAlert(store, ALERT, 'u-1')).toMatchObject({ id: ALERT, changed: false });
    expect(audits).toEqual([{ tenantId: A, action: 'alert.acknowledged', entityType: 'alert', entityId: ALERT, actor: 'u-1' }]);
  });

  it('ack-all theo id (re-review CB4): body {ids} 1..200 UUID, bỏ trùng; query cũ (?project/?asOf) -> 400; chỉ ghi id còn OPEN+chưa xem, gom theo tenant, audit kèm ids', async () => {
    const X1 = '11111111-1111-4111-8111-111111111111';
    const X2 = '22222222-2222-4222-8222-222222222222';
    const Y1 = '33333333-3333-4333-8333-333333333333';
    const GONE = '55555555-5555-4555-8555-555555555555';
    const { store, audits, calls } = fakeStore({ tenantOf: { [X1]: A, [X2]: A, [Y1]: B }, stillOpen: [X1, Y1] });
    for (const [body, field] of [
      [undefined, 'body'],
      [[X1], 'body'],
      [{}, 'ids'],
      [{ ids: [] }, 'ids'],
      [{ ids: 'x' }, 'ids'],
      [{ ids: ['cafe'] }, 'ids'],
      [{ ids: Array.from({ length: 201 }, () => X1) }, 'ids'],
      [{ ids: [X1], asOf: 'x' }, 'asOf'],
    ] as const) {
      expect({ body, err: (await bodyOf(ackAllAlerts(store, body, {}, 'u-1'))).body }).toMatchObject({ err: { error: 'bad_request', field } });
    }
    expect((await bodyOf(ackAllAlerts(store, { ids: [X1] }, { asOf: '2026-10-12T00:00:00Z' }, 'u-1'))).body).toMatchObject({ error: 'bad_request', field: 'asOf' });
    expect((await bodyOf(ackAllAlerts(store, { ids: [X1] }, { project: A }, 'u-1'))).body).toMatchObject({ error: 'bad_request', field: 'project' });
    expect(calls).toEqual([]);

    const r = await ackAllAlerts(store, { ids: [X1, X1.toUpperCase(), X2, Y1, GONE] }, {}, 'u-1');
    expect(calls[0]).toEqual({ findTenants: [X1, X2, Y1, GONE] });
    expect(calls.slice(1)).toEqual([
      { ackIds: A, ids: [X1, X2] },
      { ackIds: B, ids: [Y1] },
    ]);
    expect(r).toEqual({ acknowledged: 2, projects: [{ id: A, acknowledged: 1 }, { id: B, acknowledged: 1 }] });
    expect(audits).toEqual([
      { tenantId: A, action: 'alert.acknowledged_all', entityType: 'project', entityId: A, actor: 'u-1', metadata: { count: 1, ids: [X1] } },
      { tenantId: B, action: 'alert.acknowledged_all', entityType: 'project', entityId: B, actor: 'u-1', metadata: { count: 1, ids: [Y1] } },
    ]);
});
});

describe('GET/PUT /api/v1/me/alert-preferences + PUT /api/v1/me/locale', () => {
  it.each([
    [null, 'body'],
    [[], 'body'],
    [{}, 'body'],
    [{ emailEnabled: 'yes' }, 'emailEnabled'],
    [{ emailOnResolve: 1 }, 'emailOnResolve'],
    [{ emailRules: 'destination.failing' }, 'emailRules'],
    [{ emailRules: ['destination.failing', 'order.paid'] }, 'emailRules'],
    [{ mutedProjects: ['cafe'] }, 'mutedProjects'],
    [{ mutedProjects: A }, 'mutedProjects'],
    [{ emailEnabled: true, isOperator: true }, 'isOperator'],
  ])('%j -> 400 field=%s', async (b, field) => {
    const r = await bodyOf(() => parseAlertPreferences(b));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_request', field });
  });

  it('emailRules ⊆ ALERT_RULE_CODES (khử trùng); mutedProjects phải là project ĐANG tồn tại; GET chưa lưu = mặc định (tắt email, luật critical); PUT ghi auth_audit', async () => {
    const { store, authAudits } = fakeStore({ projects: [A] });
    const def = await getAlertPreferences(store, 'u-1');
    expect(def).toMatchObject({ emailEnabled: false, emailRules: DEFAULT_EMAIL_RULES, emailOnResolve: false, mutedProjects: [], updatedAt: null });
    expect(def.rules.map((r) => r.code)).toEqual(ALERT_RULE_CODES);

    const unknown = await bodyOf(putAlertPreferences(store, 'u-1', { mutedProjects: [A, B] }, null));
    expect(unknown).toMatchObject({ status: 400, body: { error: 'bad_request', field: 'mutedProjects' } });
    expect(authAudits).toEqual([]);

    const saved = await putAlertPreferences(store, 'u-1', { emailEnabled: true, emailRules: ['destination.failing', 'destination.failing'], mutedProjects: [A.toUpperCase()] }, '1.2.3.4');
    expect(saved).toMatchObject({ emailEnabled: true, emailRules: ['destination.failing'], mutedProjects: [A] });
    expect(authAudits).toEqual([{ userId: 'u-1', action: 'alert_preferences.updated', ip: '1.2.3.4', meta: { changes: { emailEnabled: true, emailRules: ['destination.failing'], mutedProjects: [A] } } }]);
  });

  it('locale: chỉ {"locale":"vi"|"en"} (khác -> 400); trùng giá trị hiện tại -> không ghi, không audit; đổi -> audit', async () => {
    const { store, authAudits } = fakeStore();
    for (const b of [null, {}, { locale: 'fr' }, { locale: 'en', x: 1 }, { locale: ['en'] }]) {
      expect(await bodyOf(putUserLocale(store, 'u-1', b, null))).toMatchObject({ status: 400, body: { error: 'bad_request', field: 'locale' } });
    }
    expect(await putUserLocale(store, 'u-1', { locale: 'vi' }, null)).toEqual({ locale: 'vi', changed: false });
    expect(authAudits).toEqual([]);
    expect(await putUserLocale(store, 'u-1', { locale: 'en' }, null)).toEqual({ locale: 'en', changed: true });
    expect(authAudits).toEqual([{ userId: 'u-1', action: 'user.locale_changed', ip: null, meta: { from: 'vi', to: 'en' } }]);
  });
});

describe('[CB:T10] (phần c) realtime alert.changed: chỉ socket OPERATOR của đúng project trong tin, chỉ 6 trường của hợp đồng', () => {
  const cfg = loadAuthConfig({ JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40), SOCKET_TICKET_SECRET: 's'.repeat(40), OAUTH_COOKIE_SECRET: 'o'.repeat(40) });
  const jwt = new JwtService({});
  const sessions: Record<string, { userId: string; isOperator: boolean }> = {
    's-dev': { userId: 'u-dev', isOperator: false },
    's-op': { userId: 'u-op', isOperator: true },
    's-opB': { userId: 'u-opB', isOperator: true },
  };
  const prisma: any = {
    identity: () => ({
      findLiveSessionWithUser: async (sid: string) => (sessions[sid] ? { id: sid, userId: sessions[sid].userId, user: { isOperator: sessions[sid].isOperator } } : null),
      socketAccess: async (sids: string[]) => ({
        live: new Map(sids.filter((x) => sessions[x]).map((x) => [x, sessions[x]])),
        members: new Set([`u-dev:${A}`, `u-op:${A}`]),
      }),
    }),
  };

  /** Server Socket.IO giả có room thật: `to(room).emit` chỉ tới socket đã join room đó. */
  function world() {
    const gw = new RealtimeGateway(jwt, cfg, prisma);
    const rooms = new Map<string, Set<any>>();
    const sockets = new Map<string, any>();
    gw.server = {
      to: (room: string) => ({ emit: (event: string, data: any) => rooms.get(room)?.forEach((s) => s.got.push({ event, data })) }),
      sockets: { sockets, adapter: { rooms } },
    } as any;
    const connect = async (sid: string, userId: string, projectId: string) => {
      const s: any = {
        id: sid, handshake: { auth: { ticket: signSocketTicket(jwt, cfg, { userId, sessionId: sid, projectId }) } }, data: {}, got: [] as any[],
        join: (r: string) => (rooms.get(r) ?? rooms.set(r, new Set()).get(r))!.add(s),
        leave: (r: string) => rooms.get(r)?.delete(s),
        disconnect: () => { s.disconnected = true; for (const set of rooms.values()) set.delete(s); },
      };
      const err = await new Promise<Error | undefined>((res) => gw.authenticate(s, res));
      expect(err).toBeUndefined();
      gw.handleConnection(s);
      sockets.set(sid, s);
      return s;
    };
    return { gw, connect, rooms };
  }
  const notice = { id: ALERT, tenantId: A, rule: 'destination.auth_rejected', severity: 'critical', state: 'OPEN', titleKey: 'alerts.rules.destination.auth_rejected.title' };

  it('M1: thành viên THƯỜNG cùng room project không nhận; operator của project A nhận (facts/trường lạ bị bỏ); operator đang mở project B không nhận; sự kiện cũ vẫn tới mọi socket', async () => {
    const { gw, connect } = world();
    const dev = await connect('s-dev', 'u-dev', A);
    const op = await connect('s-op', 'u-op', A);
    const opB = await connect('s-opB', 'u-opB', B);
    expect(dev.data.isOperator).toBe(false);
    expect(op.data.isOperator).toBe(true);
    gw.handleRedisMessage(ALERT_REALTIME_CHANNEL, JSON.stringify({ ...notice, facts: { sample: { url: 'https://x?token=1' } }, email: 'op@x.vn' }));
    expect(dev.got).toEqual([]);
    expect(opB.got).toEqual([]);
    expect(op.got).toEqual([{ event: 'alert.changed', data: notice }]);
    expect((gw as any).counters.size).toBe(0); // không đụng bộ đếm metrics.tick
    gw.handleRedisMessage('hub:realtime:circuit', JSON.stringify({ tenantId: A, state: 'OPEN' }));
    expect(dev.got.map((g: any) => g.event)).toEqual(['circuit.changed']);
    expect(op.got.map((g: any) => g.event)).toEqual(['alert.changed', 'circuit.changed']);
  });

  it('operator bị hạ quyền (vẫn là thành viên): kiểm lại R-3 giữ kết nối nhưng rời room cảnh báo -> không nhận alert.changed nữa', async () => {
    const { gw, connect } = world();
    const op = await connect('s-op', 'u-op', A);
    sessions['s-op'] = { userId: 'u-op', isOperator: false };
    try {
      expect(await gw.recheckSockets()).toBe(0);
      expect(op.disconnected).toBeUndefined();
      expect(op.data.isOperator).toBe(false);
      gw.handleRedisMessage(ALERT_REALTIME_CHANNEL, JSON.stringify(notice));
      expect(op.got).toEqual([]);
    } finally {
      sessions['s-op'] = { userId: 'u-op', isOperator: true };
    }
  });

  it('sai hình (thiếu tenantId, luật lạ, mức lạ, JSON hỏng) -> không emit gì', async () => {
    const { gw, connect } = world();
    const op = await connect('s-op', 'u-op', A);
    for (const m of [
      { ...notice, tenantId: undefined },
      { ...notice, rule: 'order.paid' },
      { ...notice, severity: 'fatal' },
      { ...notice, state: 'ACK' },
      { ...notice, titleKey: '' },
    ]) {
      gw.handleRedisMessage(ALERT_REALTIME_CHANNEL, JSON.stringify(m));
    }
    gw.handleRedisMessage(ALERT_REALTIME_CHANNEL, '{không phải json');
    expect(op.got).toEqual([]);
  });

  it('API cảnh báo không phụ thuộc Redis (BB-2): controller chỉ nhận PrismaService — Redis chết chỉ mất realtime, chuông vẫn poll được', () => {
    const { PrismaService } = require('@hub/database');
    // CB5: + MAIL_SENDER, AUTH_CONFIG (token tiêm, paramtype Object) cho "Gửi email thử" — vẫn KHÔNG có Redis.
    const { RedisService } = require('../src/modules/redis/redis.service');
    const types = Reflect.getMetadata('design:paramtypes', AlertsController);
    expect(types[0]).toBe(PrismaService);
    expect(types).not.toContain(RedisService);
    expect(Reflect.getMetadata('design:paramtypes', MeLocaleController)).toEqual([PrismaService]);
  });
});
