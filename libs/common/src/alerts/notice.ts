/**
 * CB2 (SPEC-canh-bao-nhan-dinh §5.3): hợp đồng realtime của cảnh báo giữa worker (publish) và hub-api (emit `alert.changed`).
 * Chỉ publish khi trạng thái ĐỔI (OPEN mới / RESOLVED), không mỗi lượt. KHÔNG có `facts` thô — câu chữ dựng ở web (i18n)
 * từ `titleKey`; ai cần số liệu thì đọc API.
 */
import { ALERT_RULES, AlertRuleCode, AlertSeverity } from './rules';

export const ALERT_REALTIME_CHANNEL = 'hub:realtime:alerts';

export interface AlertChangedNotice {
  id: string;
  tenantId: string;
  rule: AlertRuleCode;
  severity: AlertSeverity;
  state: 'OPEN' | 'RESOLVED';
  /** Khoá i18n của tiêu đề (`alerts.rules.<rule>.title`) — web dịch vi/en. */
  titleKey: string;
}

export function alertTitleKey(rule: AlertRuleCode): string {
  return `alerts.rules.${rule}.title`;
}

export function toAlertChangedNotice(a: { id: string; tenantId: string; rule: AlertRuleCode; state: 'OPEN' | 'RESOLVED' }): AlertChangedNotice {
  return { id: a.id, tenantId: a.tenantId, rule: a.rule, severity: ALERT_RULES[a.rule].severity, state: a.state, titleKey: alertTitleKey(a.rule) };
}
