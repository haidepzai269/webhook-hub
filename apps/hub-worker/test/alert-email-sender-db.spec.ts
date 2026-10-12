import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMailSender, MailSender } from '@hub/common';
import { IdentityRepository, PrismaService } from '@hub/database';
import { AlertEmailSender } from '../src/scheduler/alert-email.sender';
import { AlertEvaluator } from '../src/scheduler/alert.evaluator';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * CB5 trên Postgres THẬT (RUN_DB_TESTS=1): vòng gửi email chạy bằng role `hub_app` (RLS, escape hatch có tên), fixture dựng
 * bằng owner. Driver `capture` ghi thư thành file JSON, test đọc file.
 * Email của test có `created_at` ở năm 2020 và vòng gửi chạy với `now` 2020: vòng gửi chỉ lấy dòng `created_at <= now`, nên
 * KHÔNG đụng email PENDING của file test khác dùng chung DB (chúng mang giờ thật).
 */
describeDb('CB5 vòng gửi email cảnh báo (Postgres, hub_app)', () => {
  const owner = newTestPrisma('owner');
  const svc = new PrismaService();
  const run = randomUUID().slice(0, 8);
  const P = randomUUID();
  const MUTED = randomUUID();
  const users: string[] = [];
  const T0 = new Date('2020-03-01T07:00:00Z');
  const MIN = 60_000;
  const QS_SECRET = `QS-SECRET-${run}`;
  const PAYLOAD_SECRET = `PAYLOAD-SECRET-${run}`;
  const HEADER_SECRET = `HDR-SECRET-${run}`;
  const SIGNING_SECRET = `whsec_SIGN${run}`;
  let destId = '';
  let seq = 0;
  const dirs: string[] = [];
  const prevWeb = process.env.WEB_PUBLIC_URL;

  beforeAll(async () => {
    process.env.WEB_PUBLIC_URL = 'https://console.example.test';
    for (const id of [P, MUTED]) await owner.project.create({ data: { id, slug: `cb5-${run}-${id.slice(0, 6)}`, name: `Dự án cb5 ${run}` } });
    // Cấu hình đích "mã hoá" giả có URL kèm query token + payload/header/secret thật trong DB: thư KHÔNG được chứa cái nào.
    const dest = await owner.destination.create({
      data: { tenantId: P, name: `bookstore-orders-${run}`, type: 'webhook', configEncrypted: `{"url":"https://recv.example.com/hook?token=${QS_SECRET}","secret":"${SIGNING_SECRET}"}` },
    });
    destId = dest.id;
    await owner.event.create({
      data: { id: `CB5${run}ev`, tenantId: P, idempotencyKey: `cb5:${run}`, correlationId: randomUUID(), type: 't.cb5', source: 'test', data: { note: PAYLOAD_SECRET, headers: { authorization: HEADER_SECRET } } },
    });
  }, 60_000);

  afterAll(async () => {
    process.env.WEB_PUBLIC_URL = prevWeb;
    await owner.alertEmail.deleteMany({ where: { tenantId: { in: [P, MUTED] } } });
    await owner.alert.deleteMany({ where: { tenantId: { in: [P, MUTED] } } });
    await owner.delivery.deleteMany({ where: { tenantId: P } });
    await owner.event.deleteMany({ where: { tenantId: P } });
    await owner.subscription.deleteMany({ where: { tenantId: P } });
    await owner.destination.deleteMany({ where: { tenantId: P } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.project.deleteMany({ where: { id: { in: [P, MUTED] } } });
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    await Promise.all([owner.$disconnect(), svc.$disconnect()]);
  });

  function captureDir(): { dir: string; mail: MailSender; read: () => { to: string; subject: string; html: string; text: string }[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb5-mail-'));
    dirs.push(dir);
    return {
      dir,
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
    const u = await idn.createUser({
      email: `cb5-${run}-${++seq}@t.vn`,
      name: 'Op',
      passwordHash: null,
      isOperator: o.operator ?? true,
      emailVerifiedAt: o.verified === false ? null : new Date(),
    });
    users.push(u.id);
    if (o.locale) await idn.setUserLocale(u.id, o.locale);
    await idn.upsertAlertPreferences(u.id, {
      emailEnabled: o.enabled ?? true,
      emailOnResolve: o.onResolve ?? false,
      ...(o.rules ? { emailRules: o.rules } : {}),
      mutedProjects: o.muted ?? [],
    });
    return u;
  }

  async function alert(tenantId = P, o: { rule?: string; subjectId?: string; state?: 'OPEN' | 'RESOLVED' } = {}) {
    const rule = o.rule ?? 'destination.auth_rejected';
    return owner.alert.create({
      data: {
        tenantId,
        rule,
        severity: 'critical',
        subjectType: 'destination',
        subjectId: o.subjectId ?? randomUUID(),
        state: o.state ?? 'OPEN',
        openedAt: new Date(T0.getTime() - 20 * MIN),
        resolvedAt: o.state === 'RESOLVED' ? T0 : null,
        // facts lạ chèn thêm (server cũ/bug): thư chỉ dựng từ trường đã biết, KHÔNG đổ facts thô.
        facts: { count: 3, httpStatus: 401, sinceAt: new Date(T0.getTime() - 20 * MIN).toISOString(), dead: 3, lastError: `HTTP 401 ${HEADER_SECRET}`, payload: PAYLOAD_SECRET },
      },
    });
  }

  async function email(alertRow: { id: string; tenantId: string }, userId: string, kind: 'OPEN' | 'RESOLVED' = 'OPEN', createdAt = new Date(T0.getTime() - MIN)) {
    return owner.alertEmail.create({ data: { tenantId: alertRow.tenantId, alertId: alertRow.id, userId, kind, createdAt } });
  }

  const stateOf = async (id: string) => owner.alertEmail.findUniqueOrThrow({ where: { id } });

  it('[CB:T8] (phần a) kiểm lại điều kiện LÚC GỬI: email_enabled, email_rules, muted_projects, email chưa xác minh, không còn operator, email_on_resolve -> SUPPRESSED; đủ điều kiện -> SENT, thư capture đúng người (vi/en)', async () => {
    const cap = captureDir();
    const a = await alert(P, { subjectId: destId });
    const aMuted = await alert(MUTED);
    const ok = await user();
    const okEn = await user({ locale: 'en' });
    const disabled = await user({ enabled: false });
    const noRule = await user({ rules: ['source.silent'] });
    const muted = await user({ muted: [MUTED] });
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
    const sender = new AlertEmailSender(svc, cap.mail);
    const r = await sender.sendOnce(T0);
    expect(r).toMatchObject({ claimed: 8, sent: 2, suppressed: 6, failed: 0 });
    expect((await stateOf(e.ok.id)).state).toBe('SENT');
    expect((await stateOf(e.okEn.id)).state).toBe('SENT');
    const reasons = Object.fromEntries(
      await Promise.all(Object.entries(e).map(async ([k, row]) => [k, (await stateOf(row.id)).suppressedReason] as const)),
    );
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
    expect(vi.subject).toBe(`[Webhook Hub][CRITICAL][cb5-${run}-${P.slice(0, 6)}] Bên nhận từ chối xác thực (401)`);
    expect(vi.text).toContain(`bookstore-orders-${run}`);
    expect(vi.text).toContain('3 sự kiện đã ngừng thử (DEAD)'); // tác động
    expect(vi.text).toContain(`https://console.example.test/dashboard/alerts?project=${P}&rule=destination.auth_rejected`);
    expect(vi.text).toContain('https://console.example.test/dashboard/settings');
    const en = mails.find((m) => m.to === okEn.email)!;
    expect(en.subject).toContain('Receiver rejected authentication (401)');
    // lượt sau: không còn gì đến hạn
    expect(await sender.sendOnce(new Date(T0.getTime() + MIN))).toMatchObject({ claimed: 0 });
  });

  it('[CB:T8] (phần b) trần 6 email/giờ/người: email thứ 7 -> SUPPRESSED cap; thư kế tiếp sau 1 giờ có dòng "…và k cảnh báo khác" (k = 2), dòng cap được gộp đúng một lần', async () => {
    const cap = captureDir();
    const u = await user();
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(await email(await alert(), u.id, 'OPEN', new Date(T0.getTime() - (10 - i) * 1000)));
    const sender = new AlertEmailSender(svc, cap.mail);
    expect(await sender.sendOnce(T0)).toMatchObject({ sent: 6, suppressed: 1 });
    const seventh = await stateOf(rows[6].id);
    expect(seventh).toMatchObject({ state: 'SUPPRESSED', suppressedReason: 'cap', rolledInto: null });
    expect(cap.read().every((m) => !/cảnh báo khác/.test(m.text))).toBe(true);

    // Cùng giờ: thêm một email nữa -> vẫn bị trần
    const eighth = await email(await alert(), u.id, 'OPEN', new Date(T0.getTime() + MIN));
    expect(await sender.sendOnce(new Date(T0.getTime() + 2 * MIN))).toMatchObject({ sent: 0, suppressed: 1 });
    expect(await stateOf(eighth.id)).toMatchObject({ state: 'SUPPRESSED', suppressedReason: 'cap' });

    // Hơn 1 giờ sau: thư kế tiếp gộp 2 email bị trần
    const later = await email(await alert(), u.id, 'OPEN', new Date(T0.getTime() + 61 * MIN));
    expect(await sender.sendOnce(new Date(T0.getTime() + 62 * MIN))).toMatchObject({ sent: 1 });
    const sent = await stateOf(later.id);
    expect(sent.state).toBe('SENT');
    const last = cap.read().filter((m) => /cảnh báo khác/.test(m.text));
    expect(last).toHaveLength(1);
    expect(last[0].text).toContain('…và 2 cảnh báo khác, xem trong console.');
    expect(last[0].html).toContain('…và 2 cảnh báo khác, xem trong console.');
    expect((await stateOf(rows[6].id)).rolledInto).toBe(later.id);
    expect((await stateOf(eighth.id)).rolledInto).toBe(later.id);

    // Thư sau nữa không đếm lại
    const again = await email(await alert(), u.id, 'OPEN', new Date(T0.getTime() + 63 * MIN));
    await sender.sendOnce(new Date(T0.getTime() + 64 * MIN));
    expect((await stateOf(again.id)).state).toBe('SENT');
    expect(cap.read().filter((m) => /cảnh báo khác/.test(m.text))).toHaveLength(1);
  });

  it('[CB:T9] (phần b) thư capture KHÔNG chứa payload, header, secret, URL / query string của endpoint (quét subject + text + html)', async () => {
    const cap = captureDir();
    const u = await user({ rules: ['destination.failing'] });
    await email(await alert(P, { subjectId: destId, rule: 'destination.failing' }), u.id);
    const resolved = await alert(P, { subjectId: destId, state: 'RESOLVED' });
    const u2 = await user({ onResolve: true });
    await email(resolved, u2.id, 'RESOLVED');
    await new AlertEmailSender(svc, cap.mail).sendOnce(T0);
    const mails = cap.read();
    expect(mails).toHaveLength(2);
    for (const m of mails) {
      const all = `${m.subject}\n${m.text}\n${m.html}`;
      for (const bad of [QS_SECRET, PAYLOAD_SECRET, HEADER_SECRET, SIGNING_SECRET, 'recv.example.com', '?token=', 'whsec_', 'authorization']) {
        expect({ to: m.to, bad, found: all.includes(bad) }).toMatchObject({ found: false });
      }
      // Link duy nhất trỏ về console — không URL nào khác lọt vào thư.
      const urls = [...all.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((x) => new URL(x[0].replace(/&amp;/g, '&')).host);
      expect(new Set(urls)).toEqual(new Set(['console.example.test']));
    }
  });

  it('[CB:T13] driver ném lỗi -> thử lại sau 1 phút, 5 phút, lần 3 FAILED (attempts=3, last_error); driver treo thì evaluator vẫn chạy và vẫn ghi outbox', async () => {
    const u = await user();
    const row = await email(await alert(), u.id);
    const boom: MailSender = { send: async () => Promise.reject(new Error('SMTP 421 tạm thời')) };
    const sender = new AlertEmailSender(svc, boom);
    expect(await sender.sendOnce(T0)).toMatchObject({ retried: 1 });
    expect(await stateOf(row.id)).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'SMTP 421 tạm thời', nextAttemptAt: new Date(T0.getTime() + MIN) });
    expect(await sender.sendOnce(new Date(T0.getTime() + 30_000))).toMatchObject({ claimed: 0 }); // chưa đến hạn
    expect(await sender.sendOnce(new Date(T0.getTime() + MIN))).toMatchObject({ retried: 1 });
    expect(await stateOf(row.id)).toMatchObject({ state: 'PENDING', attempts: 2, nextAttemptAt: new Date(T0.getTime() + 6 * MIN) });
    expect(await sender.sendOnce(new Date(T0.getTime() + 6 * MIN))).toMatchObject({ failed: 1 });
    expect(await stateOf(row.id)).toMatchObject({ state: 'FAILED', attempts: 3, nextAttemptAt: null });
    expect(await sender.sendOnce(new Date(T0.getTime() + 60 * MIN))).toMatchObject({ claimed: 0 }); // FAILED là trạng thái cuối

    // Driver TREO (không bao giờ trả lời): evaluator chạy độc lập — mở cảnh báo + ghi email PENDING mới trong lúc vòng gửi kẹt.
    const hung = new AlertEmailSender(svc, { send: () => new Promise<void>(() => undefined) });
    const pending = await email(await alert(), u.id);
    void hung.sendOnce(new Date(T0.getTime() + 61 * MIN));
    const sub = await owner.subscription.create({ data: { tenantId: P, destinationId: destId, name: `cb5-${run}`, eventTypes: ['t.cb5'] } });
    // Cảnh báo OPEN dựng tay ở các test trên (cùng đích) -> đóng trước, để evaluator MỞ mới (đóng từ 2020: không dính chống flapping).
    await owner.alert.updateMany({ where: { tenantId: P, state: 'OPEN' }, data: { state: 'RESOLVED', resolvedAt: T0 } });
    const now = new Date();
    for (const k of [3, 2, 1]) {
      const ev = await owner.event.create({
        data: { id: `CB5${run}${++seq}`.slice(0, 36), tenantId: P, idempotencyKey: `cb5:${run}:${seq}`, correlationId: randomUUID(), type: 't.cb5', source: 'test', data: {} },
      });
      const d = await owner.delivery.create({ data: { tenantId: P, eventId: ev.id, subscriptionId: sub.id, attemptGeneration: 1, status: 'DEAD', attemptCount: 1, lastError: 'http 401' } });
      await owner.deliveryAttempt.create({ data: { deliveryId: d.id, attemptNo: 1, responseStatus: 401, createdAt: new Date(now.getTime() - k * MIN) } });
    }
    const recipients = (await new IdentityRepository(owner).listAlertEmailRecipients()).filter((r) => r.userId === u.id);
    const ev = new AlertEvaluator(svc, { publish: jest.fn().mockResolvedValue(1), on: jest.fn() } as any);
    const res = await ev.evaluateProject(P, now, recipients);
    expect(res.errors).toBe(0);
    const opened = await owner.alert.findFirstOrThrow({ where: { tenantId: P, rule: 'destination.auth_rejected', subjectId: destId, state: 'OPEN' } });
    expect(await owner.alertEmail.findMany({ where: { alertId: opened.id }, select: { userId: true, state: true } })).toEqual([{ userId: u.id, state: 'PENDING' }]);
    // vòng gửi treo đã lấy dòng của nó (lease) và vẫn kẹt — không ảnh hưởng gì tới evaluator ở trên
    for (let i = 0; i < 50 && (await stateOf(pending.id)).attempts === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await stateOf(pending.id)).toMatchObject({ state: 'PENDING', attempts: 1 });
  });
});
