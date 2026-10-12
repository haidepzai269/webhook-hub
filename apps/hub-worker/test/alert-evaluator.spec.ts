import { randomUUID } from 'crypto';
import { ALERT_REALTIME_CHANNEL } from '@hub/common';
import { AlertEvaluator } from '../src/scheduler/alert.evaluator';
import { alertEvalErrors, alertTransitions, alertsOpen } from '../src/metrics';

/**
 * CB2 (SPEC-canh-bao-nhan-dinh §5.1): AlertEvaluator với PrismaService/repo GIẢ trong bộ nhớ — đi dây (luật → upsert/resolve
 * → email cùng tx → publish sau commit), không phải SQL (SQL ở alert-evaluator-db.spec.ts).
 */
const T = 'tenant-a';
const DEST = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-12T07:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

interface Row {
  id: string;
  tenantId: string;
  rule: string;
  severity: string;
  subjectType: string;
  subjectId: string;
  state: 'OPEN' | 'RESOLVED';
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  facts: Record<string, unknown>;
  acknowledgedAt: null;
  acknowledgedBy: null;
}

function world() {
  const alerts: Row[] = [];
  const emails: { alertId: string; userId: string; kind: string }[] = [];
  const data = {
    destinations: [{ id: DEST, isActive: true, archivedAt: null as Date | null, circuitState: 'CLOSED' }],
    attempts: [] as { destinationId: string; status: number | null; at: Date }[],
    dead: 0,
    fail: new Set<string>(),
    openTruncated: false,
    destinationsLimitHit: false,
  };
  const guard = (name: string) => {
    if (data.fail.has(name)) throw new Error(`boom:${name}`);
  };
  const repo = {
    async findOpenAlerts(limit = 500) {
      guard('findOpenAlerts');
      // giả lập chạm trần: `limit` dòng OPEN KHÁC (ngoài store), dòng thật bị cắt khỏi ảnh chụp
      if (data.openTruncated) return Array.from({ length: limit }, () => ({ id: randomUUID(), rule: 'normalize.backlog', subjectId: randomUUID(), severity: 'warning', openedAt: NOW, facts: {} }));
      return alerts.filter((a) => a.state === 'OPEN');
    },
    async upsertOpenAlert(i: any) {
      const cur = alerts.find((a) => a.rule === i.rule && a.subjectId === i.subjectId && a.state === 'OPEN');
      if (cur) {
        cur.facts = i.facts;
        cur.lastSeenAt = i.now;
        return { alert: cur, opened: false };
      }
      const row: Row = {
        id: randomUUID(), tenantId: T, rule: i.rule, severity: i.severity, subjectType: i.subjectType, subjectId: i.subjectId,
        state: 'OPEN', openedAt: i.now, lastSeenAt: i.now, resolvedAt: null, facts: i.facts, acknowledgedAt: null, acknowledgedBy: null,
      };
      alerts.push(row);
      return { alert: row, opened: true };
    },
    async resolveAlert(rule: string, subjectId: string, now: Date, patch: any) {
      const cur = alerts.find((a) => a.rule === rule && a.subjectId === subjectId && a.state === 'OPEN');
      if (!cur) return null;
      Object.assign(cur, { state: 'RESOLVED', resolvedAt: now, facts: { ...cur.facts, ...patch } });
      return cur;
    },
    async findOpenAlertsForSubjects(rule: string, ids: string[]) {
      return alerts.filter((a) => a.state === 'OPEN' && a.rule === rule && ids.includes(a.subjectId));
    },
    async resolveAlertById(id: string, now: Date, patch: any) {
      const cur = alerts.find((a) => a.id === id && a.state === 'OPEN');
      if (!cur) return null;
      Object.assign(cur, { state: 'RESOLVED', resolvedAt: now, facts: { ...cur.facts, ...patch } });
      return cur;
    },
    async enqueueAlertEmails(alertId: string, kind: string, users: string[]) {
      for (const userId of users) if (!emails.some((e) => e.alertId === alertId && e.userId === userId && e.kind === kind)) emails.push({ alertId, userId, kind });
      return users.length;
    },
    async hasAlertResolvedSince(rule: string, subjectId: string, since: Date) {
      return alerts.some((a) => a.rule === rule && a.subjectId === subjectId && a.state === 'RESOLVED' && a.resolvedAt! >= since);
    },
    async findAlertEmailUserIds(alertId: string, kind: string) {
      return emails.filter((e) => e.alertId === alertId && e.kind === kind).map((e) => e.userId);
    },
    async findAlertDestinations() {
      guard('findAlertDestinations');
      // giả lập chạm LIMIT: trả đủ 1000 dòng (đích khác), đích có cảnh báo bị cắt mất
      if (data.destinationsLimitHit) return Array.from({ length: 1000 }, () => ({ id: randomUUID(), isActive: true, archivedAt: null, circuitState: 'CLOSED' }));
      return data.destinations;
    },
    async findAlertSources() {
      return [];
    },
    async findRecentAttemptsByDestination() {
      guard('findRecentAttemptsByDestination');
      return [...data.attempts].sort((a, b) => b.at.getTime() - a.at.getTime());
    },
    async countAttemptStatusesByDestination() {
      return [];
    },
    async countDeadDeliveriesByDestination() {
      return data.dead ? [{ destinationId: DEST, n: data.dead }] : [];
    },
    async countDeadForSpike() {
      guard('countDeadForSpike');
      return 0;
    },
    async countSignatureBySource() {
      return [];
    },
    async findSourceActivity() {
      return [];
    },
    async findOrphanRawEvents() {
      return { items: [], total: 0 };
    },
  };
  const prisma: any = {
    forTenant: () => repo,
    tenantTx: (_t: string, fn: (tx: unknown) => unknown) => fn({}),
    identity: () => ({ listProjectIds: async () => [T], listAlertEmailRecipients: async () => recipients }),
  };
  const recipients = [
    { userId: 'op-1', email: 'a@x', locale: 'vi', emailRules: ['destination.auth_rejected'], emailOnResolve: true, mutedProjects: [] as string[] },
    { userId: 'op-2', email: 'b@x', locale: 'en', emailRules: ['destination.auth_rejected'], emailOnResolve: false, mutedProjects: [T] },
  ];
  return { alerts, emails, data, prisma, recipients };
}

const fakeRedis = () => ({ publish: jest.fn().mockResolvedValue(1), on: jest.fn(), connect: jest.fn().mockResolvedValue(undefined) });
const auth = (w: ReturnType<typeof world>) => w.alerts.filter((a) => a.rule === 'destination.auth_rejected');
const metricValue = async (m: { get(): Promise<{ values: { labels: Record<string, unknown>; value: number }[] }> }, labels: Record<string, string>) =>
  (await m.get()).values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0;

describe('CB2 AlertEvaluator (đi dây, repo giả)', () => {
  it('[CB:T11] chỉ PUBLISH khi trạng thái đổi: 401×3 mở (1 publish, email OPEN cho người đủ điều kiện), lượt sau còn mở không publish, 2xx đóng (1 publish)', async () => {
    const w = world();
    const redis = fakeRedis();
    const ev = new AlertEvaluator(w.prisma, redis as any);
    w.data.attempts = [401, 401, 401].map((status, i) => ({ destinationId: DEST, status, at: at(-(i + 1) * MIN) }));
    w.data.dead = 3;
    const before = await metricValue(alertTransitions as any, { rule: 'destination.auth_rejected', to: 'OPEN' });

    const r1 = await ev.evaluateOnce(NOW);
    expect(r1).toMatchObject({ projects: 1, transitions: 1, errors: 0, aborted: false });
    expect(auth(w)).toHaveLength(1);
    expect(auth(w)[0]).toMatchObject({ state: 'OPEN', severity: 'critical', subjectType: 'destination', facts: { count: 3, dead: 3, httpStatus: 401 } });
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, body] = redis.publish.mock.calls[0];
    expect(channel).toBe(ALERT_REALTIME_CHANNEL);
    // không facts thô
    expect(JSON.parse(body)).toEqual({ id: auth(w)[0].id, tenantId: T, rule: 'destination.auth_rejected', severity: 'critical', state: 'OPEN', titleKey: 'alerts.rules.destination.auth_rejected.title' });
    // op-2 mute project -> không email; op-1 có
    expect(w.emails).toEqual([{ alertId: auth(w)[0].id, userId: 'op-1', kind: 'OPEN' }]);
    expect(await metricValue(alertTransitions as any, { rule: 'destination.auth_rejected', to: 'OPEN' })).toBe(before + 1);
    expect(await metricValue(alertsOpen as any, { severity: 'critical' })).toBe(1);

    await ev.evaluateOnce(at(MIN));
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(auth(w)[0].lastSeenAt).toEqual(at(MIN));

    w.data.attempts.unshift({ destinationId: DEST, status: 200, at: at(90_000) });
    const r3 = await ev.evaluateOnce(at(2 * MIN));
    expect(r3.transitions).toBe(1);
    expect(auth(w)[0]).toMatchObject({ state: 'RESOLVED', resolvedAt: at(2 * MIN) });
    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(redis.publish.mock.calls[1][1])).toMatchObject({ state: 'RESOLVED' });
    // email_on_resolve: chỉ op-1 (op-2 mute)
    expect(w.emails.filter((e) => e.kind === 'RESOLVED')).toEqual([{ alertId: auth(w)[0].id, userId: 'op-1', kind: 'RESOLVED' }]);
    expect(await metricValue(alertsOpen as any, { severity: 'critical' })).toBe(0);
  });

  it('[CB:T3] (phần a) Redis chết (publish ném đồng bộ lẫn reject) -> cảnh báo vẫn mở/đóng đúng trong DB, không lỗi lượt', async () => {
    for (const mode of ['reject', 'throw'] as const) {
      const w = world();
      const redis = {
        on: jest.fn(),
        publish: jest.fn(() => {
          if (mode === 'throw') throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
          return Promise.reject(new Error('ECONNREFUSED'));
        }),
      };
      const ev = new AlertEvaluator(w.prisma, redis as any);
      w.data.attempts = [401, 403, 401].map((status, i) => ({ destinationId: DEST, status, at: at(-(i + 1) * MIN) }));
      expect(await ev.evaluateOnce(NOW)).toMatchObject({ transitions: 1, errors: 0 });
      expect(auth(w)[0].state).toBe('OPEN');
      w.data.attempts.unshift({ destinationId: DEST, status: 204, at: at(30_000) });
      expect(await ev.evaluateOnce(at(MIN))).toMatchObject({ transitions: 1, errors: 0 });
      expect(auth(w)[0].state).toBe('RESOLVED');
      expect(redis.publish).toHaveBeenCalledTimes(2);
    }
  });

  it('[CB:T6] đích Ngắt -> cảnh báo đang mở RESOLVED reason=inactive, không mở mới dù 401×3; lưu trữ -> archived; đích đã xoá hẳn -> archived', async () => {
    const w = world();
    const ev = new AlertEvaluator(w.prisma, fakeRedis() as any);
    w.data.attempts = [401, 401, 401].map((status, i) => ({ destinationId: DEST, status, at: at(-(i + 1) * MIN) }));
    await ev.evaluateOnce(NOW);
    expect(auth(w)[0].state).toBe('OPEN');

    w.data.destinations[0].isActive = false;
    await ev.evaluateOnce(at(MIN));
    expect(auth(w)[0]).toMatchObject({ state: 'RESOLVED', facts: { reason: 'inactive' } });
    await ev.evaluateOnce(at(2 * MIN)); // vẫn 401×3 trong cửa sổ, nhưng đích Ngắt -> không mở lại
    expect(auth(w)).toHaveLength(1);

    w.data.destinations[0].isActive = true;
    await ev.evaluateOnce(at(3 * MIN));
    expect(auth(w).filter((a) => a.state === 'OPEN')).toHaveLength(1);
    w.data.destinations[0].archivedAt = at(3 * MIN);
    await ev.evaluateOnce(at(4 * MIN));
    expect(auth(w)[1]).toMatchObject({ state: 'RESOLVED', facts: { reason: 'archived' } });

    w.data.destinations[0].archivedAt = null;
    await ev.evaluateOnce(at(5 * MIN));
    expect(auth(w).filter((a) => a.state === 'OPEN')).toHaveLength(1);
    w.data.destinations = []; // xoá cứng
    await ev.evaluateOnce(at(6 * MIN));
    expect(auth(w)[2]).toMatchObject({ state: 'RESOLVED', facts: { reason: 'archived' } });
  });

  it('[CB:T7] (phần b) mở lại trong 30 phút sau RESOLVED -> không email OPEN thứ hai; sau 30 phút -> có', async () => {
    const w = world();
    const ev = new AlertEvaluator(w.prisma, fakeRedis() as any);
    const streak = (base: number) => [401, 401, 401].map((status, i) => ({ destinationId: DEST, status, at: at(base - (i + 1) * 1000) }));
    w.data.attempts = streak(0);
    await ev.evaluateOnce(NOW);
    w.data.attempts = [{ destinationId: DEST, status: 200, at: at(10_000) }, ...streak(0)];
    await ev.evaluateOnce(at(MIN));
    w.data.attempts = [...streak(20 * MIN), { destinationId: DEST, status: 200, at: at(10_000) }];
    await ev.evaluateOnce(at(20 * MIN));
    expect(auth(w).map((a) => a.state)).toEqual(['RESOLVED', 'OPEN']);
    expect(w.emails.filter((e) => e.kind === 'OPEN')).toHaveLength(1);

    w.data.attempts = [{ destinationId: DEST, status: 200, at: at(20 * MIN + 10_000) }, ...streak(20 * MIN)];
    await ev.evaluateOnce(at(21 * MIN));
    w.data.attempts = streak(60 * MIN);
    await ev.evaluateOnce(at(60 * MIN)); // 39 phút sau lần đóng gần nhất
    expect(auth(w).map((a) => a.state)).toEqual(['RESOLVED', 'RESOLVED', 'OPEN']);
    expect(w.emails.filter((e) => e.kind === 'OPEN').map((e) => e.alertId)).toEqual([auth(w)[0].id, auth(w)[2].id]);
  });

  it('một luật ném lỗi -> log + hub_alert_eval_errors_total{rule}, luật khác vẫn chạy; luật dùng chung truy vấn lỗi cùng nhau', async () => {
    const w = world();
    const ev = new AlertEvaluator(w.prisma, fakeRedis() as any);
    w.data.fail.add('countDeadForSpike');
    w.data.attempts = [401, 401, 401].map((status, i) => ({ destinationId: DEST, status, at: at(-(i + 1) * MIN) }));
    const before = await metricValue(alertEvalErrors as any, { rule: 'delivery.dead_spike' });
    const r = await ev.evaluateOnce(NOW);
    expect(r).toMatchObject({ errors: 1, transitions: 1 });
    expect(auth(w)[0].state).toBe('OPEN');
    expect(await metricValue(alertEvalErrors as any, { rule: 'delivery.dead_spike' })).toBe(before + 1);

    w.data.fail.add('findRecentAttemptsByDestination');
    const r2 = await ev.evaluateOnce(at(MIN));
    expect(r2.errors).toBe(3); // auth_rejected + client_error (chung truy vấn) + dead_spike
    expect(auth(w)[0].state).toBe('OPEN'); // lỗi đọc không bao giờ ĐÓNG cảnh báo
  });

  it('shutdown: stop() giữa lượt -> dừng ở ranh giới luật, không bắt đầu lượt mới', async () => {
    const w = world();
    const ev = new AlertEvaluator(w.prisma, fakeRedis() as any);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = w.prisma.forTenant().findAlertDestinations;
    let calls = 0;
    w.prisma.forTenant().findAlertDestinations = async () => {
      calls++;
      await gate;
      return orig();
    };
    const lap = ev.evaluateOnce(NOW);
    await new Promise((r) => setImmediate(r));
    const stopped = ev.stop();
    release();
    const res = await lap;
    await stopped;
    expect(res.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(await ev.evaluateOnce(at(MIN))).toMatchObject({ aborted: true, projects: 0 });
  });

  it('đọc thiếu không bao giờ đóng cảnh báo: danh sách đích chạm LIMIT -> đích vắng mặt KHÔNG bị đóng "như đã xoá"', async () => {
    const w = world();
    const ev = new AlertEvaluator(w.prisma, fakeRedis() as any);
    w.data.attempts = [401, 401, 401].map((status, i) => ({ destinationId: DEST, status, at: at(-(i + 1) * MIN) }));
    await ev.evaluateOnce(NOW);
    w.data.destinationsLimitHit = true;
    await ev.evaluateOnce(at(MIN));
    expect(auth(w)[0].state).toBe('OPEN');
  });

  it('ảnh chụp OPEN chạm trần -> cảnh báo ngoài ảnh chụp vẫn đóng được theo (rule, subject); trong ảnh chụp đóng theo id (không đóng nhầm dòng OPEN mới)', async () => {
    const w = world();
    const ev = new AlertEvaluator(w.prisma, fakeRedis() as any);
    w.data.attempts = [401, 401, 401].map((status, i) => ({ destinationId: DEST, status, at: at(-(i + 1) * MIN) }));
    await ev.evaluateOnce(NOW);
    w.data.openTruncated = true;
    w.data.destinations[0].isActive = false;
    const r = await ev.evaluateOnce(at(MIN));
    expect(auth(w)[0]).toMatchObject({ state: 'RESOLVED', facts: { reason: 'inactive' } });
    expect(r.transitions).toBe(1);

    // theo id: dòng trong ảnh chụp đã bị evaluator khác đóng, rồi một dòng OPEN mới xuất hiện -> lượt này không đóng dòng mới
    const w2 = world();
    const ev2 = new AlertEvaluator(w2.prisma, fakeRedis() as any);
    w2.data.attempts = [401, 401, 401].map((status, i) => ({ destinationId: DEST, status, at: at(-(i + 1) * MIN) }));
    await ev2.evaluateOnce(NOW);
    const repo = w2.prisma.forTenant();
    const origFind = repo.findOpenAlerts;
    repo.findOpenAlerts = async () => {
      const snap = (await origFind()).map((a: any) => ({ ...a }));
      await repo.resolveAlert('destination.auth_rejected', DEST, at(MIN), {}); // evaluator khác đóng
      await repo.upsertOpenAlert({ rule: 'destination.auth_rejected', severity: 'critical', subjectType: 'destination', subjectId: DEST, facts: {}, now: at(MIN) }); // rồi mở lại
      return snap;
    };
    w2.data.destinations[0].isActive = false;
    await ev2.evaluateOnce(at(2 * MIN));
    expect(auth(w2).map((a) => a.state)).toEqual(['RESOLVED', 'OPEN']);
  });

  it('ảnh chụp OPEN bị cắt + circuit HALF_OPEN -> đọc bù dòng OPEN thật, cảnh báo circuit_open GIỮ MỞ (không đóng nhầm, không email/publish)', async () => {
    const w = world();
    const redis = fakeRedis();
    const ev = new AlertEvaluator(w.prisma, redis as any);
    w.data.destinations[0].circuitState = 'OPEN';
    await ev.evaluateOnce(NOW);
    const circuit = () => w.alerts.filter((a) => a.rule === 'destination.circuit_open');
    expect(circuit().map((a) => a.state)).toEqual(['OPEN']);
    w.data.openTruncated = true;
    w.data.destinations[0].circuitState = 'HALF_OPEN';
    const r = await ev.evaluateOnce(at(MIN));
    expect(r.transitions).toBe(0);
    expect(circuit().map((a) => a.state)).toEqual(['OPEN']);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    w.data.destinations[0].circuitState = 'CLOSED';
    await ev.evaluateOnce(at(2 * MIN));
    expect(circuit().map((a) => a.state)).toEqual(['RESOLVED']);
  });
});
