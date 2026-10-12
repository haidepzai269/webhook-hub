import { sendTestAlertEmail, TEST_EMAIL_AUDIT_ACTION, TEST_EMAIL_PER_HOUR } from '../src/modules/alerts/alerts-api';
import { toErrorBody } from '../src/modules/errors/service-exception.filter';

/**
 * CB5 (§5.2, §8.5): POST /api/v1/me/alert-preferences/test-email — thư mẫu tới email ĐÃ XÁC MINH của chính người gọi,
 * 3 lần/giờ đếm ở Postgres (`auth_audit`, không Redis). Phần khoá đồng thời thật: alert-test-email-db.spec.ts.
 */
const HOUR = 3_600_000;
const NOW = new Date('2026-10-12T08:00:00Z');

const bodyOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return toErrorBody(e, 'req-1');
  }
  throw new Error('không ném lỗi');
};

function world(o: { verified?: boolean; locale?: 'vi' | 'en'; audits?: Date[] } = {}) {
  const audits: { action: string; at: Date }[] = (o.audits ?? []).map((at) => ({ action: TEST_EMAIL_AUDIT_ACTION, at }));
  const sent: any[] = [];
  const idn = {
    findUserById: async () => ({ id: 'u-1', email: 'op@hub.vn', locale: o.locale ?? 'vi', emailVerifiedAt: o.verified === false ? null : new Date() }),
    listMemberships: async () => [{ projectId: '11111111-1111-4111-8111-111111111111', slug: 'bookstore', name: 'Nhà sách' }],
    // cùng hợp đồng IdentityRepository.reserveAuditSlot (đếm trong cửa sổ, còn suất thì ghi)
    reserveAuditSlot: async (p: { action: string; since: Date; max: number }) => {
      const recent = audits.filter((a) => a.action === p.action && a.at > p.since).sort((x, y) => +x.at - +y.at);
      if (recent.length >= p.max) return { ok: false, used: recent.length, oldestAt: recent[0].at };
      audits.push({ action: p.action, at: NOW });
      return { ok: true, used: recent.length + 1, oldestAt: recent[0]?.at ?? null };
    },
  };
  const store: any = { identity: () => idn, $transaction: async (fn: any) => fn({}) };
  const mail = { send: async (m: any) => void sent.push(m) };
  return { store, mail, sent, audits };
}

describe('CB5 gửi email thử', () => {
  it(`gửi tới email của chính người gọi theo users.locale; tối đa ${TEST_EMAIL_PER_HOUR}/giờ, lần thứ 4 -> 429 rate_limited + retryAfter; suất cũ hơn 1 giờ không tính`, async () => {
    const w = world({ audits: [new Date(NOW.getTime() - 2 * HOUR)] });
    for (let i = 1; i <= 3; i++) {
      expect(await sendTestAlertEmail(w.store, w.mail, 'u-1', '1.2.3.4', 'https://hub.vn', NOW)).toEqual({ sent: true, to: 'op@hub.vn', remaining: 3 - i });
    }
    expect(w.sent).toHaveLength(3);
    expect(w.sent[0]).toMatchObject({ to: 'op@hub.vn', subject: '[Webhook Hub][THỬ][CRITICAL][bookstore] Bên nhận từ chối xác thực (401)' });
    const r = await bodyOf(sendTestAlertEmail(w.store, w.mail, 'u-1', null, 'https://hub.vn', NOW));
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited', retryAfter: 3600 });
    expect(w.sent).toHaveLength(3);
    const en = world({ locale: 'en' });
    await sendTestAlertEmail(en.store, en.mail, 'u-1', null, 'https://hub.vn', NOW);
    expect(en.sent[0].subject).toContain('[TEST]');
  });

  it('email chưa xác minh -> 403 email_not_verified, không tốn suất, không gửi; driver lỗi -> 503 nhưng suất vẫn bị tính (không thành vòi bắn thư)', async () => {
    const w = world({ verified: false });
    const r = await bodyOf(sendTestAlertEmail(w.store, w.mail, 'u-1', null, 'https://hub.vn', NOW));
    expect(r).toMatchObject({ status: 403, body: { error: 'email_not_verified' } });
    expect(w.audits).toHaveLength(0);
    const f = world();
    f.mail.send = async () => Promise.reject(new Error('gmail 500'));
    expect(await bodyOf(sendTestAlertEmail(f.store, f.mail, 'u-1', null, 'https://hub.vn', NOW))).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    expect(f.audits).toHaveLength(1);
  });
});
