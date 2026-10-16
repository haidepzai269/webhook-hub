import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMailSender, MailSender } from '@hub/common';
import { IdentityRepository, PrismaService } from '@hub/database';
import { ALERT_EMAIL_MAX_ATTEMPTS, AlertEmailSender, AlertEmailSenderOptions } from '../src/scheduler/alert-email.sender';
import { AlertEvaluator } from '../src/scheduler/alert.evaluator';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * CB5 trên Postgres THẬT (RUN_DB_TESTS=1): vòng gửi email chạy bằng role `hub_app` (RLS, escape hatch có tên), fixture dựng
 * bằng owner. Driver `capture` ghi thư thành file JSON, test đọc file.
 * DB kiểm chứng dùng chung: mỗi test có project RIÊNG và vòng gửi được giới hạn `tenantIds` (tuỳ chọn CHỈ cho test — review
 * TB-1); worker hubv tắt vòng gửi (`ALERT_EMAIL_INTERVAL_MS=0` trong .env.verify). Mọi mốc là đồng hồ DB: "thời gian trôi"
 * được giả lập bằng cách lùi `next_attempt_at` / `sent_at` của chính dòng test.
 */
describeDb('CB5 vòng gửi email cảnh báo (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const projects: string[] = [];
  const users: string[] = [];
  const MIN = 60_000;
  const QS_SECRET = `QS-SECRET-${run}`;
  const PAYLOAD_SECRET = `PAYLOAD-SECRET-${run}`;
  const HEADER_SECRET = `HDR-SECRET-${run}`;
  const SIGNING_SECRET = `whsec_SIGN${run}`;
  let seq = 0;
  const dirs: string[] = [];
  const prevWeb = process.env.WEB_PUBLIC_URL;

  beforeAll(() => {
    process.env.WEB_PUBLIC_URL = 'https://console.example.test';
  });

  afterAll(async () => {
    process.env.WEB_PUBLIC_URL = prevWeb;
    await owner.alertEmail.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.alert.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.delivery.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.event.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.subscription.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.destination.deleteMany({ where: { tenantId: { in: projects } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: { in: projects } } });
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  async function project(): Promise<{ id: string; slug: string; destId: string }> {
    const id = randomUUID();
    const slug = `cb5-${run}-${++seq}`;
    projects.push(id);
    await owner.project.create({ data: { id, slug, name: `Dự án cb5 ${run}` } });
    // Cấu hình đích "mã hoá" giả có URL kèm query token + secret; payload/header thật trong DB: thư KHÔNG được chứa cái nào.
    const dest = await owner.destination.create({
      data: { tenantId: id, name: `bookstore-orders-${run}`, type: 'webhook', configEncrypted: `{"url":"https://recv.example.com/hook?token=${QS_SECRET}","secret":"${SIGNING_SECRET}"}` },
    });
    await owner.event.create({
      data: { id: `CB5${run}${seq}`.slice(0, 36), tenantId: id, idempotencyKey: `cb5:${run}:${seq}`, correlationId: randomUUID(), type: 't.cb5', source: 'test', data: { note: PAYLOAD_SECRET, headers: { authorization: HEADER_SECRET } } },
    });
    return { id, slug, destId: dest.id };
  }

  const sender = (tenantIds: string[], mail: MailSender, o: AlertEmailSenderOptions = {}) => new AlertEmailSender(svc, mail, { tenantIds, ...o });

  function captureDir(): { mail: MailSender; read: () => { to: string; subject: string; html: string; text: string }[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb5-mail-'));
    dirs.push(dir);
    return {
      mail: createMailSender({ MAIL_DRIVER: 'capture', MAIL_CAPTURE_DIR: dir }),
      read: () =>
        fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))),
    };
  }

  async function user(o: { operator?: boolean; verified?: boolean; enabled?: boolean; rules?: string[]; muted?: string[]; onResolve?: boolean; locale?: 'vi' | 'en' } = {}) {
    const idn = new IdentityRepository(owner);
    const u = await idn.createUser({ email: `cb5-${run}-${++seq}@t.vn`, name: 'Op', passwordHash: null, isOperator: o.operator ?? true, emailVerifiedAt: o.verified === false ? null : new Date() });
    users.push(u.id);
    if (o.locale) await idn.setUserLocale(u.id, o.locale);
    await idn.upsertAlertPreferences(u.id, { emailEnabled: o.enabled ?? true, emailOnResolve: o.onResolve ?? false, ...(o.rules ? { emailRules: o.rules } : {}), mutedProjects: o.muted ?? [] });
    return u;
  }

  async function alert(tenantId: string, o: { rule?: string; subjectId?: string; state?: 'OPEN' | 'RESOLVED' } = {}) {
    const opened = new Date(Date.now() - 20 * MIN);
    return owner.alert.create({
      data: {
        tenantId,
        rule: o.rule ?? 'destination.auth_rejected',
        severity: 'critical',
        subjectType: 'destination',
        subjectId: o.subjectId ?? randomUUID(),
        state: o.state ?? 'OPEN',
        openedAt: opened,
        resolvedAt: o.state === 'RESOLVED' ? new Date() : null,
        // facts lạ chèn thêm (server cũ/bug): thư chỉ dựng từ trường đã biết, KHÔNG đổ facts thô.
        facts: { count: 3, httpStatus: 401, sinceAt: opened.toISOString(), dead: 3, lastError: `HTTP 401 ${HEADER_SECRET}`, payload: PAYLOAD_SECRET },
      },
    });
  }

  let created = 0;
  async function email(a: { id: string; tenantId: string }, userId: string, kind: 'OPEN' | 'RESOLVED' = 'OPEN') {
    // created_at tăng dần theo thứ tự tạo (thứ tự gửi xác định trong một lượt)
    return owner.alertEmail.create({ data: { tenantId: a.tenantId, alertId: a.id, userId, kind, createdAt: new Date(Date.now() - 3_600_000 + ++created) } });
  }

  const stateOf = (id: string) => owner.alertEmail.findUniqueOrThrow({ where: { id } });
  /** "Đến hạn": lùi lease / mốc thử lại của dòng về quá khứ (đồng hồ DB). */
  const makeDue = (id: string) => owner.alertEmail.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - MIN) } });

  it('[CB:T8] (phần a) kiểm lại điều kiện LÚC GỬI: email_enabled, email_rules, muted_projects, email chưa xác minh, không còn operator, email_on_resolve -> SUPPRESSED; đủ điều kiện -> SENT, thư capture đúng người (vi/en)', async () => {
    const cap = captureDir();
    const P = await project();
    const M = await project();
    const a = await alert(P.id, { subjectId: P.destId });
    const aMuted = await alert(M.id);
    const ok = await user();
    const okEn = await user({ locale: 'en' });
    const disabled = await user({ enabled: false });
    const noRule = await user({ rules: ['source.silent'] });
    const muted = await user({ muted: [M.id] });
    const unverified = await user({ verified: false });
    const notOp = await user({ operator: false });
    const e = {
      ok: await email(a, ok.id),
      okEn: await email(a, okEn.id),
      disabled: await email(a, disabled.id),
      noRule: await email(a, noRule.id),
      muted: await email(aMuted, muted.id),
      unverified: await email(a, unverified.id),
      notOp: await email(a, notOp.id),
      resolveNotWanted: await email(a, ok.id, 'RESOLVED'),
    };
    const s = sender([P.id, M.id], cap.mail);
    const r = await s.sendOnce();
    expect(r).toMatchObject({ claimed: 8, sent: 2, suppressed: 6, failed: 0 });
    expect((await stateOf(e.ok.id)).state).toBe('SENT');
    expect((await stateOf(e.okEn.id)).state).toBe('SENT');
    const reasons = Object.fromEntries(await Promise.all(Object.entries(e).map(async ([k, row]) => [k, (await stateOf(row.id)).suppressedReason] as const)));
    expect(reasons).toMatchObject({
      disabled: 'ineligible:email_disabled',
      noRule: 'ineligible:rule_not_selected',
      muted: 'ineligible:project_muted',
      unverified: 'ineligible:email_unverified',
      notOp: 'ineligible:not_operator',
      resolveNotWanted: 'ineligible:resolve_not_wanted',
    });
    const mails = cap.read();
    expect(mails.map((m) => m.to).sort()).toEqual([ok.email, okEn.email].sort());
    const vi = mails.find((m) => m.to === ok.email)!;
    expect(vi.subject).toBe(`[Webhook Hub][CRITICAL][${P.slug}] Bên nhận từ chối xác thực (401)`);
    expect(vi.text).toContain(`bookstore-orders-${run}`);
    expect(vi.text).toContain('3 sự kiện đã ngừng thử (DEAD)'); // tác động
    expect(vi.text).toContain(`https://console.example.test/alerts?project=${P.id}&rule=destination.auth_rejected`);
    expect(vi.text).toContain('https://console.example.test/settings');
    expect(mails.find((m) => m.to === okEn.email)!.subject).toContain('Receiver rejected authentication (401)');
    expect(await s.sendOnce()).toMatchObject({ claimed: 0 }); // không còn gì đến hạn
  });

  it('[CB:T8] (phần b) trần 6 email/giờ/người: email thứ 7 -> SUPPRESSED cap; thư kế tiếp sau 1 giờ có dòng "…và k cảnh báo khác" (k = 2), dòng cap được gộp đúng một lần', async () => {
    const cap = captureDir();
    const P = await project();
    const u = await user();
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(await email(await alert(P.id), u.id));
    const s = sender([P.id], cap.mail);
    expect(await s.sendOnce()).toMatchObject({ sent: 6, suppressed: 1 });
    expect(await stateOf(rows[6].id)).toMatchObject({ state: 'SUPPRESSED', suppressedReason: 'cap', rolledInto: null });
    expect(cap.read().every((m) => !/cảnh báo khác/.test(m.text))).toBe(true);

    // Cùng giờ: thêm một email nữa -> vẫn bị trần
    const eighth = await email(await alert(P.id), u.id);
    expect(await s.sendOnce()).toMatchObject({ sent: 0, suppressed: 1 });
    expect(await stateOf(eighth.id)).toMatchObject({ state: 'SUPPRESSED', suppressedReason: 'cap' });

    // Hơn 1 giờ sau (lùi sent_at theo đồng hồ DB): thư kế tiếp gộp 2 email bị trần
    await owner.alertEmail.updateMany({ where: { userId: u.id, state: 'SENT' }, data: { sentAt: new Date(Date.now() - 61 * MIN) } });
    const later = await email(await alert(P.id), u.id);
    expect(await s.sendOnce()).toMatchObject({ sent: 1 });
    expect((await stateOf(later.id)).state).toBe('SENT');
    const last = cap.read().filter((m) => /cảnh báo khác/.test(m.text));
    expect(last).toHaveLength(1);
    expect(last[0].text).toContain('…và 2 cảnh báo khác, xem trong console.');
    expect(last[0].html).toContain('…và 2 cảnh báo khác, xem trong console.');
    expect((await stateOf(rows[6].id)).rolledInto).toBe(later.id);
    expect((await stateOf(eighth.id)).rolledInto).toBe(later.id);

    // Thư sau nữa không đếm lại
    const again = await email(await alert(P.id), u.id);
    await s.sendOnce();
    expect((await stateOf(again.id)).state).toBe('SENT');
    expect(cap.read().filter((m) => /cảnh báo khác/.test(m.text))).toHaveLength(1);
  });

  /**
   * T-6 (review CB5): quét NỘI DUNG THƯ thật (driver capture) — subject + text + html. Dữ liệu nhạy cảm được cài sẵn ở mọi
   * chỗ hub có: payload + header của sự kiện, secret ký + URL kèm `?token=` trong cấu hình đích, chuỗi lạ trong `facts`.
   * Thư được phép chứa đúng một loại URL: console (`WEB_PUBLIC_URL`) — không cả host của đích.
   */
  it('[CB:T9] (phần b) thư capture KHÔNG chứa payload, header, secret, URL / query string của endpoint (quét subject + text + html)', async () => {
    const cap = captureDir();
    const P = await project();
    const u = await user({ rules: ['destination.failing'] });
    await email(await alert(P.id, { subjectId: P.destId, rule: 'destination.failing' }), u.id);
    const u2 = await user({ onResolve: true });
    await email(await alert(P.id, { subjectId: P.destId, state: 'RESOLVED' }), u2.id, 'RESOLVED'); // không có thư OPEN -> được gửi
    await sender([P.id], cap.mail).sendOnce();
    const mails = cap.read();
    expect(mails).toHaveLength(2);
    for (const m of mails) {
      const all = `${m.subject}\n${m.text}\n${m.html}`;
      for (const bad of [QS_SECRET, PAYLOAD_SECRET, HEADER_SECRET, SIGNING_SECRET, 'recv.example.com', '?token=', 'whsec_', 'authorization']) {
        expect({ to: m.to, bad, found: all.includes(bad) }).toMatchObject({ found: false });
      }
      const urls = [...all.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((x) => new URL(x[0].replace(/&amp;/g, '&')).host);
      expect(new Set(urls)).toEqual(new Set(['console.example.test']));
    }
  });

  it('fencing (review TB-2): lease hết hạn -> worker thứ hai lấy lại; worker đầu KHÔNG gửi được (gia hạn thất bại) và không ghi đè kết quả', async () => {
    const P = await project();
    const u = await user();
    const row = await email(await alert(P.id), u.id);
    // A lấy dòng rồi "treo" trước khi gửi (giả lập: chỉ gọi claim); lease hết hạn; B lấy lại và gửi.
    const [a] = await svc.alertEmailOutboxClaim({ limit: 10, leaseMs: 120_000, maxAttempts: ALERT_EMAIL_MAX_ATTEMPTS, tenantIds: [P.id] });
    expect(a.id).toBe(row.id);
    await makeDue(row.id);
    const capB = captureDir();
    expect(await sender([P.id], capB.mail).sendOnce()).toMatchObject({ claimed: 1, sent: 1 });
    expect(capB.read()).toHaveLength(1);
    // A tỉnh lại: gia hạn bằng lease cũ -> null (không được gửi); mọi lần ghi bằng lease cũ -> không đổi gì.
    expect(await svc.alertEmailOutboxRenew(a.id, a.lease, 120_000)).toBeNull();
    expect(await svc.alertEmailOutboxMarkSent(a.id, a.lease)).toBe(false);
    expect(await svc.alertEmailOutboxMarkFailure(a.id, a.lease, { error: 'x', maxAttempts: 3, retryMs: 1000 })).toBeNull();
    expect(await stateOf(row.id)).toMatchObject({ state: 'SENT', attempts: 2 });

    // Cả lượt: A đang gửi (driver treo), lease bị lấy lại, B gửi xong -> khi A xong, A không ghi SENT/không tính "sent".
    const row2 = await email(await alert(P.id), u.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const slowA: MailSender = {
      send: async () => {
        entered = true;
        await gate;
      },
    };
    const lapA = sender([P.id], slowA).sendOnce();
    for (let i = 0; i < 100 && !entered; i++) await new Promise((r) => setTimeout(r, 20));
    expect(entered).toBe(true); // A đã gia hạn và đang ở trong driver
    await makeDue(row2.id);
    expect(await sender([P.id], captureDir().mail).sendOnce()).toMatchObject({ sent: 1 });
    release();
    expect(await lapA).toMatchObject({ sent: 0, released: 1 });
    expect(await stateOf(row2.id)).toMatchObject({ state: 'SENT', attempts: 2 });
  });

  it('T-2: dòng hết lease mà đã dùng hết số lần thử (worker chết giữa chừng) -> lần lấy kế tiếp đánh FAILED, không gửi lần 4', async () => {
    const P = await project();
    const u = await user();
    const row = await email(await alert(P.id), u.id);
    await owner.alertEmail.update({ where: { id: row.id }, data: { attempts: ALERT_EMAIL_MAX_ATTEMPTS, nextAttemptAt: new Date(Date.now() - MIN) } });
    const sent: string[] = [];
    expect(await sender([P.id], { send: async (m) => void sent.push(m.to) }).sendOnce()).toMatchObject({ claimed: 0 });
    expect(sent).toEqual([]);
    expect(await stateOf(row.id)).toMatchObject({ state: 'FAILED', attempts: ALERT_EMAIL_MAX_ATTEMPTS, lastError: 'lease hết hạn sau lần thử cuối' });
  });

  it('T-3: thư RESOLVED chờ thư OPEN của cùng người — OPEN còn PENDING (đang được giữ) -> hoãn, không tốn lần thử; OPEN SENT -> gửi; OPEN FAILED -> không gửi "đã ổn"', async () => {
    const cap = captureDir();
    const P = await project();
    const u = await user({ onResolve: true });
    const a = await alert(P.id, { state: 'RESOLVED' });
    const open = await email(a, u.id, 'OPEN');
    const resolved = await email(a, u.id, 'RESOLVED');
    // OPEN đang bị worker khác giữ (lease tương lai) -> lượt này chỉ thấy RESOLVED
    await owner.alertEmail.update({ where: { id: open.id }, data: { nextAttemptAt: new Date(Date.now() + 10 * MIN), attempts: 1 } });
    const s = sender([P.id], cap.mail);
    expect(await s.sendOnce()).toMatchObject({ claimed: 1, sent: 0, released: 1 });
    expect(await stateOf(resolved.id)).toMatchObject({ state: 'PENDING', attempts: 0 });
    expect(cap.read()).toHaveLength(0);
    // OPEN đã gửi -> RESOLVED đến hạn thì gửi
    await owner.alertEmail.update({ where: { id: open.id }, data: { state: 'SENT', sentAt: new Date(), nextAttemptAt: null } });
    await makeDue(resolved.id);
    expect(await s.sendOnce()).toMatchObject({ sent: 1 });
    expect(cap.read()[0].subject).toContain('[ĐÃ ỔN]');
    // OPEN FAILED -> RESOLVED không gửi
    const b = await alert(P.id, { state: 'RESOLVED' });
    await owner.alertEmail.create({ data: { tenantId: P.id, alertId: b.id, userId: u.id, kind: 'OPEN', state: 'FAILED', attempts: 3 } });
    const r2 = await email(b, u.id, 'RESOLVED');
    await s.sendOnce();
    expect(await stateOf(r2.id)).toMatchObject({ state: 'SUPPRESSED', suppressedReason: 'ineligible:open_not_sent' });
  });

  it('[CB:T13] driver ném lỗi -> thử lại sau 1 phút, 5 phút, lần 3 FAILED (attempts=3, last_error); driver treo -> hạn chót gửi; evaluator vẫn chạy và vẫn ghi outbox', async () => {
    const P = await project();
    const u = await user();
    const row = await email(await alert(P.id), u.id);
    const boom: MailSender = { send: async () => Promise.reject(new Error('SMTP 421 tạm thời')) };
    const s = sender([P.id], boom);
    const t0 = Date.now();
    expect(await s.sendOnce()).toMatchObject({ retried: 1 });
    let st = await stateOf(row.id);
    expect(st).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'SMTP 421 tạm thời' });
    expect(st.nextAttemptAt!.getTime() - t0).toBeGreaterThan(50_000); // ~1 phút (đồng hồ DB)
    expect(await s.sendOnce()).toMatchObject({ claimed: 0 }); // chưa đến hạn
    await makeDue(row.id);
    expect(await s.sendOnce()).toMatchObject({ retried: 1 });
    st = await stateOf(row.id);
    expect(st.attempts).toBe(2);
    expect(st.nextAttemptAt!.getTime() - t0).toBeGreaterThan(4 * MIN); // ~5 phút
    await makeDue(row.id);
    expect(await s.sendOnce()).toMatchObject({ failed: 1 });
    expect(await stateOf(row.id)).toMatchObject({ state: 'FAILED', attempts: 3, nextAttemptAt: null });
    expect(await s.sendOnce()).toMatchObject({ claimed: 0 }); // FAILED là trạng thái cuối

    // Driver TREO: hạn chót gửi (TB-3) biến nó thành lỗi -> thử lại; trong lúc đó evaluator chạy độc lập.
    const pending = await email(await alert(P.id), u.id);
    const hung = sender([P.id], { send: () => new Promise<void>(() => undefined) }, { sendTimeoutMs: 300 });
    const hungLap = hung.sendOnce();
    const sub = await owner.subscription.create({ data: { tenantId: P.id, destinationId: P.destId, name: `cb5-${run}`, eventTypes: ['t.cb5'] } });
    const now = new Date();
    for (const k of [3, 2, 1]) {
      const ev = await owner.event.create({
        data: { id: `CB5${run}x${++seq}`.slice(0, 36), tenantId: P.id, idempotencyKey: `cb5:${run}:x${seq}`, correlationId: randomUUID(), type: 't.cb5', source: 'test', data: {} },
      });
      const d = await owner.delivery.create({ data: { tenantId: P.id, eventId: ev.id, subscriptionId: sub.id, attemptGeneration: 1, status: 'DEAD', attemptCount: 1, lastError: 'http 401' } });
      await owner.deliveryAttempt.create({ data: { deliveryId: d.id, attemptNo: 1, responseStatus: 401, createdAt: new Date(now.getTime() - k * MIN) } });
    }
    const recipients = (await new IdentityRepository(owner).listAlertEmailRecipients()).filter((r) => r.userId === u.id);
    const ev = new AlertEvaluator(svc, { publish: jest.fn().mockResolvedValue(1), on: jest.fn() } as any);
    const res = await ev.evaluateProject(P.id, now, recipients);
    expect(res.errors).toBe(0);
    const opened = await owner.alert.findFirstOrThrow({ where: { tenantId: P.id, rule: 'destination.auth_rejected', subjectId: P.destId, state: 'OPEN' } });
    expect(await owner.alertEmail.findMany({ where: { alertId: opened.id }, select: { userId: true, state: true } })).toEqual([{ userId: u.id, state: 'PENDING' }]);
    expect(await hungLap).toMatchObject({ retried: 1 });
    expect(await stateOf(pending.id)).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'gửi email quá 300ms' });
  });
});
