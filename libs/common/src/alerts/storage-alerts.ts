/**
 * QT6 (SPEC-han-muc-dung-luong §3, §8 + ĐÍNH CHÍNH E3/E5, ADR-190): logic THUẦN của cảnh báo dung lượng — nấc -> luật,
 * kế hoạch email (mỗi nấc đi lên một lần, 95%/LOCKED nhắc mỗi ngày), lúc nào phải "báo" lại, ai nhận email.
 * Không I/O, `now` tiêm vào. StorageAlerts (hub-worker) gọi các hàm này bên trong transaction khoá `project_usage`.
 */
import { STORAGE_LEVELS, StorageLevel, parseStorageLevel } from '../storage/level';
import { AlertRuleCode } from './rules';

export const STORAGE_ALERT_RULES = ['project.storage_warn', 'project.storage_critical', 'project.storage_locked'] as const;
export type StorageAlertRule = (typeof STORAGE_ALERT_RULES)[number];

/** §3: nấc nhắc email MỖI NGÀY (95% và đã khoá). */
export const STORAGE_REMIND_LEVELS: readonly StorageLevel[] = ['CRITICAL_95', 'LOCKED', 'HARD_LOCKED'];
export const STORAGE_REMIND_EVERY_MS = 24 * 3_600_000;

/** Nấc -> luật cảnh báo đang mở (OK -> không có). */
export function storageRuleForLevel(level: StorageLevel): StorageAlertRule | null {
  switch (level) {
    case 'WARN_70':
    case 'WARN_85':
      return 'project.storage_warn';
    case 'CRITICAL_95':
      return 'project.storage_critical';
    case 'LOCKED':
    case 'HARD_LOCKED':
      return 'project.storage_locked';
    default:
      return null;
  }
}

export function isStorageAlertRule(rule: string): rule is StorageAlertRule {
  return (STORAGE_ALERT_RULES as readonly string[]).includes(rule);
}

const rank = (l: StorageLevel) => STORAGE_LEVELS.indexOf(l);

/** Ngày (UTC, `YYYY-MM-DD`) — phần của tag email để một nấc đi lên hai lần trong cùng ngày chỉ có MỘT thư. */
export function dayTag(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface StorageEmailState {
  level: StorageLevel;
  /** Nấc đã gửi email gần nhất (`project_usage.notified_level`); null = chưa từng. */
  notifiedLevel: string | null;
  notifiedAt: Date | null;
  now: Date;
}

export interface StorageEmailPlan {
  /** null = không gửi email lần này. */
  send: { reason: 'up' | 'remind'; tag: string } | null;
  /** Giá trị mới ghi vào `notified_level`/`notified_at` (không đổi = giữ). */
  notifiedLevel: StorageLevel | null;
  notifiedAt: Date | null;
}

/**
 * §3 "chống spam email": mỗi nấc gửi MỘT lần mỗi lần đi LÊN (so với nấc đã báo email). `CRITICAL_95`/`LOCKED`/`HARD_LOCKED`
 * nhắc mỗi ngày (≥ 24h kể từ thư trước). Đi XUỐNG: không thư, hạ `notified_level` về nấc hiện tại để lần lên sau gửi lại.
 * OK: xoá dấu (lần sau chạm 70% là "lần đầu").
 */
export function planStorageEmail(s: StorageEmailState): StorageEmailPlan {
  const notified = s.notifiedLevel === null ? 'OK' : parseStorageLevel(s.notifiedLevel);
  const keep = { notifiedLevel: s.notifiedLevel === null ? null : notified, notifiedAt: s.notifiedAt };
  if (s.level === 'OK') return { send: null, notifiedLevel: null, notifiedAt: s.notifiedAt };
  if (rank(s.level) > rank(notified)) {
    return { send: { reason: 'up', tag: `up:${s.level}:${dayTag(s.now)}` }, notifiedLevel: s.level, notifiedAt: s.now };
  }
  if (rank(s.level) < rank(notified)) {
    // Đi xuống: không email. Vẫn ở nấc nhắc thì đồng hồ nhắc chạy tiếp từ thư trước.
    return { send: null, notifiedLevel: s.level, notifiedAt: s.notifiedAt };
  }
  if (STORAGE_REMIND_LEVELS.includes(s.level) && (!s.notifiedAt || s.now.getTime() - s.notifiedAt.getTime() >= STORAGE_REMIND_EVERY_MS)) {
    return { send: { reason: 'remind', tag: `remind:${s.level}:${dayTag(s.now)}` }, notifiedLevel: s.level, notifiedAt: s.now };
  }
  return { send: null, ...keep };
}

/**
 * Có phải mở transaction "báo" cho project này không (lượt nấc 60s quét bù, +0 truy vấn khi không): nấc chưa báo
 * (`signaled_level` lệch — worker chết giữa đường / lần đầu), hoặc tới hạn nhắc email.
 */
export function storageSignalDue(s: StorageEmailState & { signaledLevel: string | null }): boolean {
  const signaled = s.signaledLevel === null ? 'OK' : parseStorageLevel(s.signaledLevel);
  if (signaled !== s.level) return true;
  return planStorageEmail(s).send !== null;
}

export interface StorageOwnerRecipient {
  userId: string;
  emailVerified: boolean;
  /** `project_members.storage_warn_email` — owner tắt email 70%/85%. */
  storageWarnEmail: boolean;
}

export interface StorageOperatorRecipient {
  userId: string;
  emailRules: string[];
  mutedProjects: string[];
}

/**
 * §8 + E3: người nhận email của một luật dung lượng = MỌI owner (email đã xác minh) + operator theo tuỳ chọn của họ.
 * Owner bỏ qua `alert_preferences`; owner chỉ tắt được `project.storage_warn` (70/85) — 95%/LOCKED luôn gửi.
 * Developer/viewer không bao giờ (họ không có trong danh sách owner).
 */
export function storageEmailRecipients(
  rule: StorageAlertRule | AlertRuleCode,
  tenantId: string,
  owners: StorageOwnerRecipient[],
  operators: StorageOperatorRecipient[],
): string[] {
  const out = new Set<string>();
  for (const o of owners) {
    if (!o.emailVerified) continue;
    if (rule === 'project.storage_warn' && !o.storageWarnEmail) continue;
    out.add(o.userId);
  }
  for (const op of operators) {
    if (!op.emailRules.includes(rule)) continue;
    if (op.mutedProjects.map((x) => x.toLowerCase()).includes(tenantId.toLowerCase())) continue;
    out.add(op.userId);
  }
  return [...out];
}
