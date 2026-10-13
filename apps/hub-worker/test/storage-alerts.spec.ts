import { HUB_PROJECT_STORAGE, validateCanonical } from '@hub/common';
import { StorageAlerts } from '../src/scheduler/storage-alerts';
import { alertEmailEligibility } from '../src/scheduler/alert-email.sender';

/**
 * QT6 (SPEC-han-muc-dung-luong §3, §6, §8 + E3/E5, ADR-190): StorageAlerts trên store GIẢ có trạng thái — một transaction
 * "báo" khoá project_usage, mở/đóng alert theo nấc, phát `hub.project.storage` qua outbox, tạo email theo nấc/ngày.
 */
const T = '11111111-1111-4111-8111-111111111111';
const MB = 1048576;
const NOW = Date.parse('2026-10-13T08:00:00Z');
const H = 3_600_000;

function world(o: { level?: string; signaled?: string | null; owners?: any[]; operators?: any[]; projects?: string[] } = {}) {
  const st = {
    usage: {
      level: o.level ?? 'OK',
      signaledLevel: o.signaled === undefined ? 'OK' : o.signaled,
      notifiedLevel: null as string | null,
      notifiedAt: null as Date | null,
      usedBytes: 36 * MB,
      bloatFactor: 2,
      suggestions: [
        {
          id: 'sug_' + 'a'.repeat(24),
          action: 'trim',
          importance: ['low'],
          olderThan: '3d',
          sourceId: null,
          estimatedBytes: 5 * MB,
          estimatedEvents: 40,
          reasonCode: 'delivered_old',
          reason: 'r',
          advisor: 'rules@1',
          expiresAt: '2026-10-14T00:00:00.000Z',
        },
      ],
      calibratedAt: null,
      measuredAt: null,
    },
    alerts: [] as any[],
    emails: [] as { alertId: string; userId: string; kind: string; tag: string }[],
    events: [] as any[],
    outbox: [] as any[],
    announced: [] as string[],
    txs: 0,
    /** Review QT-S3 L1: đọc người nhận lỗi (DB danh tính chập chờn). */
    failRecipients: false,
  };
  let seq = 0;
  const repo = (tenantId: string, inTx: boolean) => ({
    lockProjectUsageForSignal: async () => {
      if (!inTx) throw new Error('phải khoá trong transaction');
      return tenantId === T ? { ...st.usage } : null;
    },
    trafficBytesSince: async () => 2 * MB,
    findOpenAlertsByRules: async (rules: string[], subjectId: string) => st.alerts.filter((a) => a.tenantId === tenantId && a.state === 'OPEN' && rules.includes(a.rule) && a.subjectId === subjectId),
    resolveAlertById: async (id: string) => {
      const a = st.alerts.find((x) => x.id === id && x.state === 'OPEN');
      if (!a) return null;
      a.state = 'RESOLVED';
      return a;
    },
    upsertOpenAlert: async (i: any) => {
      const cur = st.alerts.find((a) => a.tenantId === tenantId && a.rule === i.rule && a.subjectId === i.subjectId && a.state === 'OPEN');
      if (cur) {
        cur.facts = i.facts;
        return { alert: cur, opened: false };
      }
      const a = { id: `al-${++seq}`, tenantId, rule: i.rule, severity: i.severity, subjectType: i.subjectType, subjectId: i.subjectId, state: 'OPEN', facts: i.facts };
      st.alerts.push(a);
      return { alert: a, opened: true };
    },
    enqueueAlertEmails: async (alertId: string, kind: string, users: string[], tag = '') => {
      if (!inTx) throw new Error('email phải cùng transaction');
      let n = 0;
      for (const userId of users) {
        if (st.emails.some((e) => e.alertId === alertId && e.userId === userId && e.kind === kind && e.tag === tag)) continue; // unique
        st.emails.push({ alertId, userId, kind, tag });
        n++;
      }
      return n;
    },
    markStorageSignaled: async (m: any) => {
      st.usage.signaledLevel = m.signaledLevel;
      st.usage.notifiedLevel = m.notifiedLevel;
      st.usage.notifiedAt = m.notifiedAt;
    },
    createEvent: async (e: any) => {
      if (!inTx) throw new Error('event phải trong transaction');
      st.events.push(e);
      return e;
    },
    findActiveSubscriptionsForEvent: async () => [{ id: 'sub-1', destinationId: 'd-1', destination: { id: 'd-1', name: 'ops', type: 'webhook', verification: 'VERIFIED' } }],
    createDelivery: async (d: any) => ({ id: 'del-1', ...d }),
  });
  const prisma: any = {
    findProjectById: async (id: string) => ({ id, storageQuotaMb: 50 }),
    identity: () => ({
      listProjectOwnersForStorageEmail: async () => {
        if (st.failRecipients) throw new Error('db danh tính lỗi');
        return o.owners ?? [{ userId: 'own-1', emailVerified: true, storageWarnEmail: true }];
      },
      listAlertEmailRecipients: async () => o.operators ?? [{ userId: 'op-1', emailRules: ['project.storage_locked', 'hub.storage_near_full'], mutedProjects: [] }],
      listProjectIds: async () => o.projects ?? [T],
    }),
    forTenant: (t: string, tx?: unknown) => repo(t, !!tx),
    tenantTx: async (_t: string, fn: (tx: any) => Promise<unknown>) => {
      st.txs++;
      return fn({ outbox: { create: async ({ data }: any) => st.outbox.push(data) } });
    },
  };
  const evaluator: any = { announce: (a: any, rule: string, to: string) => st.announced.push(`${rule}:${to}`) };
  const svc = new StorageAlerts(prisma, undefined, evaluator);
  svc.clock = () => NOW;
  return { svc, st };
}

describe('[QT:T19] (phần a) webhook hub.project.storage: đúng MỘT event mỗi lần đổi nấc, qua outbox, vẫn phát khi LOCKED', () => {
  it('OK -> WARN_70: một event (source hub) + delivery + outbox; báo lần hai (đường khác cùng báo) -> không phát thêm; data khớp catalog', async () => {
    const { svc, st } = world({ level: 'WARN_70' });
    expect(await svc.signal(T, 50 * MB)).toBe(true);
    expect(await svc.signal(T, 50 * MB)).toBe(false); // signaled_level đã khớp -> không làm gì
    expect(st.events).toHaveLength(1);
    expect(st.events[0]).toMatchObject({ type: HUB_PROJECT_STORAGE, source: 'hub', sourceId: null });
    expect(validateCanonical(HUB_PROJECT_STORAGE, st.events[0].data)).toEqual({ ok: true });
    expect(st.events[0].data).toMatchObject({ level: 'WARN_70', previousLevel: 'OK', quotaBytes: 50 * MB, lockEnabled: false });
    expect(st.events[0].data.suggestion.estimatedBytes).toBe(5 * MB);
    expect(st.outbox).toHaveLength(1);
  });

  it('lên LOCKED rồi xuống CRITICAL_95: mỗi lần đổi một event (kể cả LOCKED và khi đi xuống); alert nấc cũ đóng, nấc mới mở; realtime sau COMMIT', async () => {
    const { svc, st } = world({ level: 'LOCKED', signaled: 'WARN_85' });
    st.alerts.push({ id: 'al-old', tenantId: T, rule: 'project.storage_warn', subjectId: T, state: 'OPEN', facts: {} });
    await svc.signal(T, 50 * MB);
    expect(st.events.map((e) => `${e.data.previousLevel}->${e.data.level}`)).toEqual(['WARN_85->LOCKED']);
    expect(st.alerts.find((a) => a.id === 'al-old').state).toBe('RESOLVED');
    expect(st.alerts.filter((a) => a.state === 'OPEN').map((a) => a.rule)).toEqual(['project.storage_locked']);
    expect(st.announced).toEqual(['project.storage_warn:RESOLVED', 'project.storage_locked:OPEN']);
    st.usage.level = 'CRITICAL_95';
    await svc.signal(T, 50 * MB);
    expect(st.events.map((e) => `${e.data.previousLevel}->${e.data.level}`)).toEqual(['WARN_85->LOCKED', 'LOCKED->CRITICAL_95']);
    expect(st.alerts.filter((a) => a.state === 'OPEN').map((a) => a.rule)).toEqual(['project.storage_critical']);
  });

  it('về OK: phát event + đóng mọi alert dung lượng, không mở gì', async () => {
    const { svc, st } = world({ level: 'OK', signaled: 'WARN_70' });
    st.alerts.push({ id: 'al-w', tenantId: T, rule: 'project.storage_warn', subjectId: T, state: 'OPEN', facts: {} });
    await svc.signal(T, 50 * MB);
    expect(st.events.map((e) => e.data.level)).toEqual(['OK']);
    expect(st.alerts.every((a) => a.state === 'RESOLVED')).toBe(true);
  });

  it('quét bù (lượt nấc 60s): signaled_level lệch (worker chết giữa đường) -> báo; khớp -> không mở transaction', async () => {
    const { svc, st } = world({ level: 'WARN_85', signaled: 'WARN_70' });
    const row = (lv: string, sig: string) => ({ tenantId: T, level: lv, finalLevel: lv, signaledLevel: sig, notifiedLevel: lv, notifiedAt: new Date(NOW), quotaMb: 50 }) as any;
    expect(await svc.sweep([row('WARN_85', 'WARN_70')])).toBe(1);
    const tx = st.txs;
    expect(await svc.sweep([row('WARN_85', 'WARN_85')])).toBe(0);
    expect(st.txs).toBe(tx);
  });
});

describe('[QT:T11] (phần b) email dung lượng qua outbox alert_emails: owner + operator, mỗi nấc đi lên một lần, 95%/LOCKED nhắc mỗi ngày', () => {
  it('review QT-S3 L1: lỗi đọc người nhận -> alert + event vẫn đúng, KHÔNG ghi dấu email; lượt sau (đọc được) gửi bù thư lên 70%', async () => {
    const { svc, st } = world({ level: 'WARN_70', signaled: 'OK', operators: [] });
    st.failRecipients = true;
    expect(await svc.signal(T, 50 * MB)).toBe(true);
    expect(st.events).toHaveLength(1);
    expect(st.emails).toEqual([]);
    expect(st.usage).toMatchObject({ signaledLevel: 'WARN_70', notifiedLevel: null, notifiedAt: null }); // dấu email giữ nguyên
    // Lượt nấc 60s thấy còn nợ thư -> báo lại; lần này đọc được -> đúng một thư, không event thứ hai.
    st.failRecipients = false;
    const row = { tenantId: T, level: 'WARN_70', finalLevel: 'WARN_70', signaledLevel: 'WARN_70', notifiedLevel: st.usage.notifiedLevel, notifiedAt: st.usage.notifiedAt, quotaMb: 50 } as any;
    expect(await svc.sweep([row])).toBe(1);
    expect(st.emails.map((e) => `${e.userId}:${e.tag}`)).toEqual(['own-1:up:WARN_70:2026-10-13']);
    expect(st.events).toHaveLength(1);
    expect(st.usage).toMatchObject({ notifiedLevel: 'WARN_70' });
  });

  it('lên LOCKED: thư `up:LOCKED:<ngày>` cho owner + operator chọn luật; developer/viewer không (không có trong danh sách owner)', async () => {
    const { svc, st } = world({ level: 'LOCKED', signaled: 'CRITICAL_95' });
    await svc.signal(T, 50 * MB);
    expect(st.emails.map((e) => `${e.userId}:${e.tag}`).sort()).toEqual(['op-1:up:LOCKED:2026-10-13', 'own-1:up:LOCKED:2026-10-13']);
  });

  it('cùng nấc: không thư mới trước 24h; sau 24h -> thư nhắc (alert giữ nguyên, không event mới)', async () => {
    const w = world({ level: 'CRITICAL_95', signaled: 'WARN_85' });
    await w.svc.signal(T, 50 * MB);
    expect(w.st.emails.map((e) => e.tag)).toEqual(['up:CRITICAL_95:2026-10-13']); // op-1 không chọn storage_critical
    w.svc.clock = () => NOW + 23 * H;
    expect(await w.svc.signal(T, 50 * MB)).toBe(false);
    w.svc.clock = () => NOW + 24 * H;
    expect(await w.svc.signal(T, 50 * MB)).toBe(true);
    expect(w.st.emails.map((e) => e.tag)).toEqual(['up:CRITICAL_95:2026-10-13', 'remind:CRITICAL_95:2026-10-14']);
    expect(w.st.events).toHaveLength(1);
    expect(w.st.alerts.filter((a) => a.state === 'OPEN')).toHaveLength(1);
  });

  it('owner đã tắt email 70/85 -> không thư warn; vẫn nhận LOCKED (không tắt được)', async () => {
    const owners = [{ userId: 'own-1', emailVerified: true, storageWarnEmail: false }];
    const w = world({ level: 'WARN_85', signaled: 'OK', owners, operators: [] });
    await w.svc.signal(T, 50 * MB);
    expect(w.st.emails).toEqual([]);
    w.st.usage.level = 'LOCKED';
    await w.svc.signal(T, 50 * MB);
    expect(w.st.emails.map((e) => e.userId)).toEqual(['own-1']);
  });

  it('vòng gửi kiểm lại lúc gửi: owner bỏ qua tuỳ chọn operator; warn tắt -> SUPPRESSED; mất vai trò owner -> về điều kiện operator', () => {
    const base = { isOperator: false, emailVerified: true, emailEnabled: false, emailRules: [], mutedProjects: [], emailOnResolve: false, tenantId: T, kind: 'OPEN' as const };
    expect(alertEmailEligibility({ ...base, rule: 'project.storage_locked', isOwner: true, storageWarnEmail: false })).toBeNull();
    expect(alertEmailEligibility({ ...base, rule: 'project.storage_warn', isOwner: true, storageWarnEmail: false })).toBe('storage_warn_off');
    expect(alertEmailEligibility({ ...base, rule: 'project.storage_warn', isOwner: true, storageWarnEmail: true })).toBeNull();
    expect(alertEmailEligibility({ ...base, rule: 'project.storage_locked', isOwner: false })).toBe('not_operator');
    expect(alertEmailEligibility({ ...base, rule: 'destination.auth_rejected', isOwner: true })).toBe('not_operator'); // luật CB: owner không nhận
    expect(alertEmailEligibility({ ...base, rule: 'project.storage_locked', isOwner: true, emailVerified: false })).toBe('email_unverified');
  });
});

describe('[QT:T14] (phần c) chốt toàn cục -> cảnh báo operator hub.storage_near_full (neo project lâu đời nhất)', () => {
  it('vượt 80% -> mở MỘT alert critical operator-only + email operator chọn luật; lượt sau còn vượt -> không mở thêm; xuống dưới -> đóng', async () => {
    const { svc, st } = world({ projects: [T, '22222222-2222-4222-8222-222222222222'] });
    const d = { sizeBytes: 450 * MB, nearFull: true, budgetMb: 512, top: [{ tenantId: T, usedBytes: 40 * MB }] };
    await svc.diskCheck(d);
    await svc.diskCheck(d);
    const open = st.alerts.filter((a) => a.rule === 'hub.storage_near_full' && a.state === 'OPEN');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ tenantId: T, severity: 'critical', facts: { pct: 87.9, top: [{ tenantId: T }] } });
    expect(st.emails.map((e) => e.userId)).toEqual(['op-1']);
    await svc.diskCheck({ ...d, nearFull: false, sizeBytes: 100 * MB });
    expect(st.alerts.filter((a) => a.rule === 'hub.storage_near_full' && a.state === 'OPEN')).toHaveLength(0);
    expect(st.announced).toEqual(['hub.storage_near_full:OPEN', 'hub.storage_near_full:RESOLVED']);
  });
});
