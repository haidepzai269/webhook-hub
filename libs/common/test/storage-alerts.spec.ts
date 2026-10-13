import {
  ALERT_RULE_CODES,
  EVALUATED_RULE_CODES,
  buildAlertText,
  createAlertTextT,
  ownerVisibleRules,
  parseAlertChangedNotice,
  planStorageEmail,
  renderAlertEmail,
  ruleAudience,
  storageEmailRecipients,
  storageRuleForLevel,
  storageSignalDue,
  toAlertChangedNotice,
} from '../src/alerts';

/**
 * QT6 (SPEC-han-muc-dung-luong §3, §8 + ĐÍNH CHÍNH E3/E5, ADR-190) — phần THUẦN của cảnh báo dung lượng.
 */
const T = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-13T08:00:00Z');
const H = 3_600_000;

describe('[QT:T34] (phần a) audience trên định nghĩa luật', () => {
  it('chỉ project.storage_* là owners+operator; luật CB cũ + hub.storage_near_full giữ operator-only; evaluator không đánh giá luật sự kiện', () => {
    expect(ownerVisibleRules().sort()).toEqual(['project.storage_critical', 'project.storage_locked', 'project.storage_warn']);
    for (const r of ALERT_RULE_CODES.filter((c) => !c.startsWith('project.storage_'))) expect(ruleAudience(r)).toBe('operator');
    expect(ruleAudience('luat.la')).toBe('operator');
    expect(EVALUATED_RULE_CODES).not.toContain('project.storage_warn');
    expect(EVALUATED_RULE_CODES).not.toContain('hub.storage_near_full');
    expect(EVALUATED_RULE_CODES).toContain('destination.auth_rejected');
  });

  it('realtime: notice mang audience tính từ rules.ts — tin tự xưng owners+operator cho luật CB bị sửa lại', () => {
    expect(toAlertChangedNotice({ id: 'a', tenantId: T, rule: 'project.storage_locked', state: 'OPEN' }).audience).toBe('owners+operator');
    const forged = parseAlertChangedNotice({ id: 'a', tenantId: T, rule: 'destination.auth_rejected', severity: 'critical', state: 'OPEN', titleKey: 'k', audience: 'owners+operator' });
    expect(forged?.audience).toBe('operator');
  });

  it('nấc -> luật: WARN_70/85 chung storage_warn, 95 critical, LOCKED + HARD_LOCKED chung storage_locked, OK không có', () => {
    expect(storageRuleForLevel('OK')).toBeNull();
    expect(storageRuleForLevel('WARN_70')).toBe('project.storage_warn');
    expect(storageRuleForLevel('WARN_85')).toBe('project.storage_warn');
    expect(storageRuleForLevel('CRITICAL_95')).toBe('project.storage_critical');
    expect(storageRuleForLevel('LOCKED')).toBe('project.storage_locked');
    expect(storageRuleForLevel('HARD_LOCKED')).toBe('project.storage_locked');
  });
});

describe('[QT:T11] (phần a) email theo nấc: mỗi nấc đi lên MỘT lần, 95%/LOCKED nhắc mỗi ngày, owner + operator', () => {
  it('đi lên -> thư `up:<nấc>:<ngày>`; cùng nấc chưa đủ 24h -> không; 95% sau 24h -> thư nhắc; đi xuống -> không thư, hạ dấu để lần lên sau gửi lại', () => {
    const up = planStorageEmail({ level: 'WARN_70', notifiedLevel: null, notifiedAt: null, now: NOW });
    expect(up.send).toEqual({ reason: 'up', tag: 'up:WARN_70:2026-10-13' });
    expect(planStorageEmail({ level: 'WARN_70', notifiedLevel: 'WARN_70', notifiedAt: NOW, now: new Date(NOW.getTime() + 30 * H) }).send).toBeNull(); // 70% không nhắc
    expect(planStorageEmail({ level: 'WARN_85', notifiedLevel: 'WARN_70', notifiedAt: NOW, now: NOW }).send?.reason).toBe('up');
    expect(planStorageEmail({ level: 'CRITICAL_95', notifiedLevel: 'CRITICAL_95', notifiedAt: NOW, now: new Date(NOW.getTime() + 23 * H) }).send).toBeNull();
    expect(planStorageEmail({ level: 'CRITICAL_95', notifiedLevel: 'CRITICAL_95', notifiedAt: NOW, now: new Date(NOW.getTime() + 24 * H) }).send).toEqual({
      reason: 'remind',
      tag: 'remind:CRITICAL_95:2026-10-14',
    });
    expect(planStorageEmail({ level: 'HARD_LOCKED', notifiedLevel: 'HARD_LOCKED', notifiedAt: NOW, now: new Date(NOW.getTime() + 25 * H) }).send?.reason).toBe('remind');
    const down = planStorageEmail({ level: 'WARN_85', notifiedLevel: 'LOCKED', notifiedAt: NOW, now: NOW });
    expect(down.send).toBeNull();
    expect(down.notifiedLevel).toBe('WARN_85');
    expect(planStorageEmail({ level: 'LOCKED', notifiedLevel: 'WARN_85', notifiedAt: NOW, now: NOW }).send?.reason).toBe('up'); // lên lại -> gửi lại
    expect(planStorageEmail({ level: 'OK', notifiedLevel: 'WARN_70', notifiedAt: NOW, now: NOW })).toMatchObject({ send: null, notifiedLevel: null });
  });

  it('cần báo lại khi signaled_level lệch hoặc tới hạn nhắc; khớp + chưa hạn -> không (lượt nấc +0 truy vấn)', () => {
    expect(storageSignalDue({ level: 'WARN_70', signaledLevel: 'OK', notifiedLevel: null, notifiedAt: null, now: NOW })).toBe(true);
    expect(storageSignalDue({ level: 'WARN_70', signaledLevel: 'WARN_70', notifiedLevel: 'WARN_70', notifiedAt: NOW, now: NOW })).toBe(false);
    expect(storageSignalDue({ level: 'OK', signaledLevel: null, notifiedLevel: null, notifiedAt: null, now: NOW })).toBe(false);
    expect(storageSignalDue({ level: 'LOCKED', signaledLevel: 'LOCKED', notifiedLevel: 'LOCKED', notifiedAt: new Date(NOW.getTime() - 25 * H), now: NOW })).toBe(true);
  });

  it('người nhận: mọi owner đã xác minh + operator theo tuỳ chọn; owner chỉ tắt được 70/85, KHÔNG tắt được 95%/LOCKED; developer/viewer không bao giờ', () => {
    const owners = [
      { userId: 'own-1', emailVerified: true, storageWarnEmail: false },
      { userId: 'own-2', emailVerified: true, storageWarnEmail: true },
      { userId: 'own-3', emailVerified: false, storageWarnEmail: true },
    ];
    const ops = [
      { userId: 'op-1', emailRules: ['project.storage_locked', 'project.storage_warn'], mutedProjects: [] },
      { userId: 'op-2', emailRules: ['project.storage_locked'], mutedProjects: [T.toUpperCase()] },
    ];
    expect(storageEmailRecipients('project.storage_warn', T, owners, ops).sort()).toEqual(['op-1', 'own-2']);
    expect(storageEmailRecipients('project.storage_locked', T, owners, ops).sort()).toEqual(['op-1', 'own-1', 'own-2']);
    expect(storageEmailRecipients('project.storage_critical', T, owners, ops).sort()).toEqual(['own-1', 'own-2']);
  });
});

describe('[QT:T30] (phần f) câu cảnh báo/email nói thật khi STORAGE_LOCK_ENABLED=0; nội dung có mức dùng ước tính, dự báo, gợi ý MB', () => {
  const base = { subjectType: 'project' as const, subjectId: T };
  const facts = {
    level: 'LOCKED',
    usedBytes: 52 * 1048576,
    quotaBytes: 50 * 1048576,
    pct: 104,
    forecastHours: null,
    suggestion: { action: 'trim', importance: ['low'], olderThan: '3d', estimatedBytes: 8 * 1048576, estimatedEvents: 10 },
  };
  it('LOCKED + lockEnabled=false -> "Khoá chưa bật…, event vẫn được nhận"; lockEnabled=true -> "trừ các source Giữ lâu"; HARD_LOCKED -> "mọi event"', () => {
    const t = createAlertTextT('vi');
    const off = buildAlertText({ ...base, rule: 'project.storage_locked', facts: { ...facts, lockEnabled: false } }, t, { locale: 'vi', now: NOW.getTime() });
    expect(off.message).toContain('Khoá chưa bật trên hệ thống này, sự kiện vẫn được nhận');
    expect(off.message).toContain('(ước tính)');
    expect(off.message).toContain('8.0 MB');
    const on = buildAlertText({ ...base, rule: 'project.storage_locked', facts: { ...facts, lockEnabled: true } }, t, { locale: 'vi', now: NOW.getTime() });
    expect(on.message).toContain('trừ các nguồn Giữ lâu');
    const hard = buildAlertText({ ...base, rule: 'project.storage_locked', facts: { ...facts, level: 'HARD_LOCKED', lockEnabled: true } }, t, { locale: 'vi', now: NOW.getTime() });
    expect(hard.title).toContain('110%');
    expect(hard.message).toContain('ngừng nhận mọi sự kiện');
    const warn = buildAlertText({ ...base, rule: 'project.storage_warn', facts: { ...facts, level: 'WARN_70', pct: 71, forecastHours: 30, autoCleanEnabled: false } }, t, { locale: 'vi', now: NOW.getTime() });
    expect(warn.message).toContain('Còn ~30 giờ');
    expect(warn.message).toContain('chưa chạy (người vận hành chưa bật)');
  });

  it('email owner: link trang Dung lượng đúng project, ở 70% có link "Bật dọn tự động", thư nhắc có [NHẮC], chân thư nói vì là owner', () => {
    const mail = renderAlertEmail({
      kind: 'OPEN',
      locale: 'vi',
      audience: 'owner',
      reminder: true,
      alert: { ...base, rule: 'project.storage_warn', severity: 'warning', facts: { ...facts, level: 'WARN_70', pct: 71 }, openedAt: NOW },
      project: { id: T, slug: 'shop', name: 'Shop' },
      webUrl: 'https://hub.example',
      now: NOW,
    });
    expect(mail.subject).toContain('[NHẮC]');
    expect(mail.text).toContain(`https://hub.example/dashboard/storage?project=${T}`);
    expect(mail.text).toContain('#auto-clean');
    expect(mail.text).toContain('chủ (owner)');
    expect(mail.text).not.toContain('/dashboard/settings');
  });
});
