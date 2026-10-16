import { ALERT_RULE_CODES, ALERT_RULES, ALERT_TEXT, renderAlertEmail, sampleAlertEmail } from '@hub/common';

/**
 * CB5 (SPEC §6): mẫu thư cảnh báo vi/en — tiêu đề `[Webhook Hub][CRITICAL][<slug>] <title>`, HTML + text, project, đối tượng,
 * từ lúc nào, số liệu, tác động, cách xử lý, deep link, link Cài đặt; dòng "…và k khác"; không bao giờ lọt facts thô.
 */
const NOW = new Date('2026-10-12T07:30:00Z');
const PROJECT = { id: '11111111-1111-4111-8111-111111111111', slug: 'bookstore', name: 'Nhà sách <b>' };
const base = {
  rule: 'destination.auth_rejected',
  severity: 'critical' as const,
  subjectType: 'destination' as const,
  subjectId: '3fa2c1d0-0000-4000-8000-000000000001',
  facts: { count: 12, httpStatus: 401, sinceAt: '2026-10-12T07:02:00Z', dead: 12 },
  openedAt: new Date('2026-10-12T07:02:00Z'),
};
const mk = (o: Partial<Parameters<typeof renderAlertEmail>[0]> = {}) =>
  renderAlertEmail({ kind: 'OPEN', locale: 'vi', alert: base, project: PROJECT, subjectName: 'bookstore-orders', webUrl: 'https://hub.example.vn/', now: NOW, ...o });

describe('CB5 mẫu thư cảnh báo', () => {
  it('subject theo §6, thân có project, đối tượng, từ lúc (giờ VN), tác động DEAD, cách xử lý, deep link lọc project + luật, link Cài đặt', () => {
    const m = mk();
    expect(m.subject).toBe('[Webhook Hub][CRITICAL][bookstore] Bên nhận từ chối xác thực (401)');
    expect(m.text).toContain('Dự án: Nhà sách <b> (bookstore)');
    expect(m.text).toContain('Đối tượng: bookstore-orders · Đích từ chối xác thực');
    expect(m.text).toMatch(/Từ lúc: (14:02,? 12\/10\/2026|12\/10\/2026,? 14:02) \(giờ Việt Nam\)/);
    expect(m.text).toContain('12 lần thử liên tiếp bị từ chối kể từ 14:02.');
    expect(m.text).toContain('Tác động: 12 sự kiện đã ngừng thử (DEAD)');
    expect(m.text).toContain('Cách xử lý: Thường do secret phía nhận đã đổi.');
    expect(m.text).toContain('https://hub.example.vn/alerts?project=11111111-1111-4111-8111-111111111111&rule=destination.auth_rejected');
    expect(m.text).toContain('https://hub.example.vn/settings');
    expect(m.html).toContain('Nhà sách &lt;b&gt;'); // mọi chuỗi động escape HTML
    expect(m.html).not.toContain('Nhà sách <b>');
    expect(m.text).not.toMatch(/cảnh báo khác/);
  });

  it('en theo users.locale; RESOLVED: [RESOLVED], có "Đã ổn lúc", không tác động/cách xử lý; dòng gộp "…và k khác" khi rollup > 0', () => {
    const en = mk({ locale: 'en', rollup: 3 });
    expect(en.subject).toBe('[Webhook Hub][CRITICAL][bookstore] Receiver rejected authentication (401)');
    expect(en.text).toContain('…and 3 more alerts, see the console.');
    expect(en.text).toContain('Project: Nhà sách <b> (bookstore)');
    expect(en.text).not.toContain('Dự án');
    const vi = mk({ rollup: 2 });
    expect(vi.text).toContain('…và 2 cảnh báo khác, xem trong console.');
    expect(vi.html).toContain('…và 2 cảnh báo khác, xem trong console.');
    const r = mk({ kind: 'RESOLVED', alert: { ...base, resolvedAt: new Date('2026-10-12T07:20:00Z') } });
    expect(r.subject).toBe('[Webhook Hub][ĐÃ ỔN][bookstore] Bên nhận từ chối xác thực (401)');
    expect(r.text).toMatch(/Đã ổn lúc: (14:20,? 12\/10\/2026|12\/10\/2026,? 14:20)/);
    expect(r.text).not.toContain('Tác động');
    expect(r.text).not.toContain('Cách xử lý');
  });

  it('mọi luật × vi/en: không lọt khoá thô / undefined / NaN / {biến}', () => {
    for (const locale of ['vi', 'en'] as const) {
      for (const rule of ALERT_RULE_CODES) {
        const m = mk({ locale, alert: { ...base, rule, severity: ALERT_RULES[rule].severity, subjectType: ALERT_RULES[rule].subjectType, facts: {} } });
        for (const s of [m.subject, m.text]) expect({ rule, locale, bad: /\balerts\.[a-z]|\bemail\.[a-z]|undefined|NaN|\{\w+\}/.test(s) }).toMatchObject({ bad: false });
      }
    }
  });

  it('[CB:T9] (phần a) facts lạ (payload, header, secret, URL có query) KHÔNG vào thư — chỉ trường đã biết được dùng; lastError/lastFix của kết nối cũng không', () => {
    const facts = {
      ...base.facts,
      payload: { amount: 'PAYLOAD-123' },
      headers: { authorization: 'Bearer HDR-456' },
      secret: 'whsec_SECRET789',
      url: 'https://recv.example.com/hook?token=QS-000',
      lastError: 'HTTP 401 at https://recv.example.com/hook?token=QS-000',
      lastFix: 'đổi secret whsec_SECRET789',
    };
    for (const rule of ['destination.auth_rejected', 'source.connection_broken']) {
      const m = mk({ alert: { ...base, rule, subjectType: rule.startsWith('source') ? 'source' : 'destination', facts: { ...facts, status: 'FAILED', providerLabel: 'payos' } } });
      const all = `${m.subject}\n${m.text}\n${m.html}`;
      for (const bad of ['PAYLOAD-123', 'HDR-456', 'whsec_', 'SECRET789', 'recv.example.com', '?token=', 'QS-000']) expect({ rule, bad, found: all.includes(bad) }).toMatchObject({ found: false });
    }
  });

  it('URL console xấu (javascript:, rỗng) -> localhost, không chèn được vào href; thư thử có nhãn [THỬ]/[TEST]', () => {
    expect(mk({ webUrl: 'javascript:alert(1)' }).html).not.toContain('javascript:');
    expect(mk({ webUrl: '' }).text).toContain('http://localhost:3000/settings');
    const t = sampleAlertEmail({ locale: 'vi', webUrl: 'https://hub.example.vn', project: PROJECT, now: NOW });
    expect(t.subject).toBe('[Webhook Hub][THỬ][CRITICAL][bookstore] Bên nhận từ chối xác thực (401)');
    expect(t.text).toContain('Đây là email THỬ');
    expect(sampleAlertEmail({ locale: 'en', webUrl: 'https://hub.example.vn', project: PROJECT, now: NOW }).subject).toContain('[TEST]');
  });

  it('ALERT_TEXT: en có đúng bộ khoá của vi, không rỗng (nguồn câu dùng chung web + email)', () => {
    expect(Object.keys(ALERT_TEXT.en).sort()).toEqual(Object.keys(ALERT_TEXT.vi).sort());
    for (const v of [...Object.values(ALERT_TEXT.vi), ...Object.values(ALERT_TEXT.en)]) expect(v.trim()).not.toBe('');
  });
});
