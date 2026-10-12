/**
 * CB4 (SPEC-canh-bao-nhan-dinh §8): kiểu dữ liệu cảnh báo phía console — khớp CB3 (`apps/hub-api/src/modules/alerts/alerts-api.ts`).
 * TS thuần (không React, không alias `@/`) để jest gốc test thẳng.
 */

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertState = "OPEN" | "RESOLVED";
export type AlertSubjectType = "destination" | "source" | "project";

/** Mã luật (§4) — cùng danh mục với `libs/common/src/alerts/rules.ts` (ALERT_RULE_CODES). */
export const ALERT_RULE_CODES = [
  "destination.auth_rejected",
  "destination.client_error",
  "destination.failing",
  "destination.circuit_open",
  "delivery.dead_spike",
  "source.signature_failing",
  "source.connection_broken",
  "source.silent",
  "normalize.backlog",
] as const;
export type AlertRuleCode = (typeof ALERT_RULE_CODES)[number];

export const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
export const ALERT_STATES = ["OPEN", "RESOLVED"] as const;

export function isAlertRule(v: unknown): v is AlertRuleCode {
  return typeof v === "string" && (ALERT_RULE_CODES as readonly string[]).includes(v);
}

export interface AlertProject {
  id: string;
  slug: string;
  name: string;
}

/** Một dòng của `GET /api/v1/alerts` (alertView). Thời điểm là ISO (JSON). */
export interface AlertView {
  id: string;
  rule: string;
  severity: AlertSeverity;
  titleKey: string;
  subjectType: AlertSubjectType;
  subjectId: string;
  state: AlertState;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  facts: Record<string, unknown>;
  project: AlertProject;
}

export interface AlertPage {
  items: AlertView[];
  next: string | null;
  prev: string | null;
}

/** `GET /api/v1/alerts/summary`. */
export interface AlertSummary {
  openBySeverity: { critical: number; warning: number; info: number };
  unacked: number;
  /** CB4 review L1: chưa xem theo mức (màu badge). Vắng ở server cũ -> rơi về openBySeverity. */
  unackedBySeverity?: { critical: number; warning: number; info: number };
  perProject: { project: AlertProject; critical: number; warning: number; info: number; unacked: number }[];
}

/** Socket `alert.changed` (chỉ operator, room `project:<id>:ops`) — không có facts. */
export interface AlertChangedNotice {
  id: string;
  tenantId: string;
  rule: string;
  severity: AlertSeverity;
  state: AlertState;
  titleKey: string;
}
