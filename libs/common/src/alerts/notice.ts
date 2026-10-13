/**
 * CB2 (SPEC-canh-bao-nhan-dinh §5.3): hợp đồng realtime của cảnh báo giữa worker (publish) và hub-api (emit `alert.changed`).
 * Chỉ publish khi trạng thái ĐỔI (OPEN mới / RESOLVED), không mỗi lượt. KHÔNG có `facts` thô — câu chữ dựng ở web (i18n)
 * từ `titleKey`; ai cần số liệu thì đọc API.
 */
import { ALERT_RULES, AlertAudience, AlertRuleCode, AlertSeverity, ruleAudience } from './rules';

export const ALERT_REALTIME_CHANNEL = 'hub:realtime:alerts';

export interface AlertChangedNotice {
  id: string;
  tenantId: string;
  rule: AlertRuleCode;
  severity: AlertSeverity;
  state: 'OPEN' | 'RESOLVED';
  /** Khoá i18n của tiêu đề (`alerts.rules.<rule>.title`) — web dịch vi/en. */
  titleKey: string;
  /** QT6 (E3): `owners+operator` -> gateway emit thêm vào room `project:<id>:owners`. Lấy từ `rules.ts`, không tin tin nhắn. */
  audience: AlertAudience;
}

export function alertTitleKey(rule: AlertRuleCode): string {
  return `alerts.rules.${rule}.title`;
}

export function toAlertChangedNotice(a: { id: string; tenantId: string; rule: AlertRuleCode; state: 'OPEN' | 'RESOLVED' }): AlertChangedNotice {
  return { id: a.id, tenantId: a.tenantId, rule: a.rule, severity: ALERT_RULES[a.rule].severity, state: a.state, titleKey: alertTitleKey(a.rule), audience: ruleAudience(a.rule) };
}

/**
 * CB3 (§5.3): hub-api đọc tin từ Redis rồi chuyển NGUYÊN hợp đồng ra socket — chỉ 7 trường (QT6 thêm `audience`), không gì khác (tin lạ có kèm
 * `facts` hay trường thêm thì bị bỏ). Sai hình (thiếu tenantId, luật lạ, …) -> null: thà mất một cập nhật realtime
 * (web còn poll `/alerts/summary` mỗi 30s) còn hơn đẩy dữ liệu không rõ nguồn gốc.
 */
export function parseAlertChangedNotice(raw: unknown): AlertChangedNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200;
  if (!str(r.id) || !str(r.tenantId) || !str(r.titleKey)) return null;
  if (typeof r.rule !== 'string' || !Object.prototype.hasOwnProperty.call(ALERT_RULES, r.rule)) return null;
  if (r.severity !== 'critical' && r.severity !== 'warning' && r.severity !== 'info') return null;
  if (r.state !== 'OPEN' && r.state !== 'RESOLVED') return null;
  return {
    id: r.id as string,
    tenantId: r.tenantId as string,
    rule: r.rule as AlertRuleCode,
    severity: r.severity,
    state: r.state,
    titleKey: r.titleKey as string,
    // QT6: audience tính lại từ luật (rules.ts) — tin nhắn tự xưng `owners+operator` cho luật CB không mở được room owner.
    audience: ruleAudience(r.rule),
  };
}
