import type { MessageKey, TranslateFn } from "../i18n/dictionary";

/**
 * ADR-235: số đếm của một dự án từ `GET /api/v1/projects?include=stats` — chỉ con số, không dòng dữ liệu.
 * Hàm THUẦN (không React, không I/O) để test được và dùng chung cho thẻ ở trang "Tất cả dự án".
 */
export interface ProjectStats {
  createdAt: string;
  /** source chưa lưu trữ */
  sources: number;
  /** đích (endpoint) chưa lưu trữ */
  endpoints: number;
  members: number;
  events24h: number;
  /** attempt không 2xx (kể cả mất kết nối) trong 24h — chỉ để tham khảo, không làm thẻ đỏ */
  failedAttempts24h: number;
  /** DEAD chưa bị replay — khớp trang DLQ */
  dlq: number;
  /** đích đang dùng có circuit OPEN / HALF_OPEN */
  circuitOpen: number;
  storageLevel: string;
  openAlerts: { critical: number; warning: number; info: number };
}

export type ProjectHealthTone = "ok" | "danger" | "neutral";
export type HealthReasonKind = "circuit" | "dlq" | "storage" | "alerts";
export interface HealthReason {
  kind: HealthReasonKind;
  count: number;
}
export interface ProjectHealth {
  tone: ProjectHealthTone;
  reasons: HealthReason[];
  /** true = server không trả số liệu (`stats` null) — xám, nhãn "chưa có số liệu" thay vì "chưa có nguồn/đích". */
  noData?: true;
}

const LOCKED_LEVELS = new Set(["LOCKED", "HARD_LOCKED"]);

/**
 * Đỏ = có ít nhất một: đích circuit ≠ CLOSED · DLQ > 0 · dung lượng LOCKED/HARD_LOCKED · cảnh báo OPEN mức critical/warning.
 * Không đỏ mà chưa có nguồn lẫn đích nào (hoặc chưa có số liệu) -> xám. Còn lại -> xanh.
 */
export function projectHealth(stats: ProjectStats | null | undefined): ProjectHealth {
  if (!stats) return { tone: "neutral", reasons: [], noData: true };
  const reasons: HealthReason[] = [];
  if (stats.circuitOpen > 0) reasons.push({ kind: "circuit", count: stats.circuitOpen });
  if (stats.dlq > 0) reasons.push({ kind: "dlq", count: stats.dlq });
  if (LOCKED_LEVELS.has(stats.storageLevel)) reasons.push({ kind: "storage", count: 1 });
  const alerts = stats.openAlerts.critical + stats.openAlerts.warning;
  if (alerts > 0) reasons.push({ kind: "alerts", count: alerts });
  if (reasons.length > 0) return { tone: "danger", reasons };
  if (stats.sources === 0 && stats.endpoints === 0) return { tone: "neutral", reasons: [] };
  return { tone: "ok", reasons: [] };
}

const REASON_KEY: Record<HealthReasonKind, MessageKey> = {
  circuit: "page.projects.home.health.circuit",
  dlq: "page.projects.home.health.dlq",
  storage: "page.projects.home.health.storage",
  alerts: "page.projects.home.health.alerts",
};
const TONE_KEY: Record<Exclude<ProjectHealthTone, "danger">, MessageKey> = {
  ok: "page.projects.home.health.ok",
  neutral: "page.projects.home.health.idle",
};

const NO_DATA_KEY: MessageKey = "page.projects.home.health.unknown";

/** Mọi khoá dịch mà nhãn sức khoẻ có thể dùng (test i18n vi/en). */
export const HEALTH_REASON_KEYS: MessageKey[] = [...Object.values(REASON_KEY), ...Object.values(TONE_KEY), NO_DATA_KEY];

/** Nhãn nhỏ trên thẻ: đỏ -> các lý do nối ' · ' (vd "2 tin trong DLQ"); xanh/xám -> một câu ngắn. */
export function projectHealthLabel(h: ProjectHealth, t: TranslateFn): string {
  if (h.noData) return t(NO_DATA_KEY);
  if (h.tone !== "danger") return t(TONE_KEY[h.tone]);
  return h.reasons.map((r) => t(REASON_KEY[r.kind], { count: r.count })).join(" · ");
}
