/**
 * CB6 (SPEC-canh-bao-nhan-dinh §7): dựng câu NHẬN ĐỊNH từ `code + facts` của `GET /api/v1/projects/:p/insights`, phía
 * client, theo ngôn ngữ đang chọn (câu chữ ở messages/insights.ts). Cùng khuôn với cảnh báo (lib/alerts/message.ts):
 * nhãn nói "chuyện gì", dòng phụ nói "bao nhiêu / so với gì", hành động nói "làm gì". Tên provider qua bảng tên hiển
 * thị (D5) — không có nhánh theo provider. TS thuần (không React, không alias `@/`) để jest gốc test thẳng.
 */
import type { AlertAction } from "../alerts/links";
import { formatClock, formatDuration, providerDisplayName } from "../alerts/message";
import type { MessageKey, TranslateFn } from "../i18n/dictionary";
import type { Locale } from "../i18n/locales";

export type InsightCode = "I-dest" | "I-dup" | "I-silent" | "I-dead";
export type InsightLevel = "ok" | "info" | "warning" | "critical";

/** Một nhận định như API trả (hợp đồng ở libs/common/src/alerts/insights.ts). */
export interface InsightView {
  code: InsightCode;
  level: InsightLevel;
  subjectType: "destination" | "source" | "project";
  subjectId: string;
  facts: Record<string, unknown>;
  actions?: { code: string; params?: Record<string, string> }[];
}

export interface InsightText {
  label: string;
  detail: string;
  /** Giải thích thêm (tooltip) — I-dup: provider gửi lại khi nào. */
  tooltip?: string;
  level: InsightLevel;
}

export interface InsightContext {
  locale: Locale;
  now: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const time = (v: unknown): number | null => {
  if (typeof v !== "string" || v === "") return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};
const n0 = (v: unknown) => num(v) ?? 0;
const LEVELS: InsightLevel[] = ["ok", "info", "warning", "critical"];
const levelOf = (v: unknown): InsightLevel => (LEVELS.includes(v as InsightLevel) ? (v as InsightLevel) : "info");

const DEST_SEGMENT: Record<string, string> = {
  healthy: "healthy",
  auth_rejected: "auth-rejected",
  client_error: "client-error",
  receiver_failing: "receiver-failing",
  circuit_open: "circuit-open",
  no_deliveries: "no-deliveries",
};

/** "12 phút trước" / "12 min ago" — mốc tương lai (lệch đồng hồ) coi như vừa xong. */
export function relativeAgo(at: number, t: TranslateFn, now: number): string {
  return t("insights.ago", { d: formatDuration(Math.max(0, now - at), t) });
}

function destText(f: Record<string, unknown>, t: TranslateFn, ctx: InsightContext): Omit<InsightText, "level"> {
  const seg = DEST_SEGMENT[String(f.health)] ?? "no-deliveries";
  const last = time(f.lastAt);
  const status = num(f.lastStatus);
  const vars = {
    success: n0(f.success),
    total: n0(f.total),
    failed: n0(f.retrying),
    status: status && status >= 100 ? String(status) : "—",
    at: last !== null ? formatClock(last, ctx) : "—",
  };
  return {
    label: t(`insights.dest.${seg}.label` as MessageKey),
    detail: t(`insights.dest.${seg}.detail` as MessageKey, vars),
  };
}

function silentText(f: Record<string, unknown>, t: TranslateFn, ctx: InsightContext): Omit<InsightText, "level"> {
  const last = time(f.lastEventAt);
  if (f.state === "no_events" || last === null)
    return { label: t("insights.silent.none"), detail: t("insights.silent.none-detail") };
  const label = t("insights.silent.last", { ago: relativeAgo(last, t, ctx.now) });
  const gap = num(f.medianGapMs);
  if (f.state === "learning")
    return { label, detail: t("insights.silent.learning", { min: n0(f.minBaseline) || 20, n: n0(f.baseline) }) };
  if (f.state === "quiet")
    return { label, detail: t("insights.silent.quiet", { gap: gap !== null ? formatDuration(gap, t) : "—" }) };
  return {
    label,
    detail:
      gap !== null ? t("insights.silent.normal", { gap: formatDuration(gap, t) }) : t("insights.silent.normal-nogap"),
  };
}

function dupText(f: Record<string, unknown>, t: TranslateFn): Omit<InsightText, "level"> {
  const total = n0(f.total);
  const rows = Array.isArray(f.byProvider) ? (f.byProvider as { provider?: unknown; n?: unknown }[]) : [];
  const list = rows
    .filter((r) => n0(r.n) > 0)
    .map((r) => `${providerDisplayName(r.provider)} ${n0(r.n)}`)
    .join(" · ");
  return {
    label: total > 0 ? t("insights.dup.title", { n: total }) : t("insights.dup.none"),
    detail: list ? t("insights.dup.breakdown", { list }) : "",
    tooltip: t("insights.dup.tooltip"),
  };
}

function deadText(f: Record<string, unknown>, t: TranslateFn): Omit<InsightText, "level"> {
  const total = n0(f.total);
  // Review CB6 TB1: phần thuộc đích đã lưu trữ (D9) vẫn nằm trong bảng DLQ / KPI — nói rõ để hai con số khớp nhau.
  const archived = n0(f.excludedArchived);
  const suffix = archived > 0 ? ` ${t("insights.dead.archived", { m: archived })}` : "";
  if (total === 0) return { label: `${t("insights.dead.none")}${suffix}`, detail: t("insights.dead.none-detail") };
  const vars = { n: total, k: Math.min(n0(f.recent), total) };
  return {
    label: `${t(f.capped === true ? "insights.dead.title-capped" : "insights.dead.title", vars)}${suffix}`,
    detail: t("insights.dead.detail"),
  };
}

/** Câu của một nhận định; mã lạ (server mới hơn web) -> null, nơi gọi bỏ qua. */
export function insightText(i: InsightView, t: TranslateFn, ctx: InsightContext): InsightText | null {
  const f = i.facts && typeof i.facts === "object" ? i.facts : {};
  const level = levelOf(i.level);
  switch (i.code) {
    case "I-dest":
      return { ...destText(f, t, ctx), level };
    case "I-silent":
      return { ...silentText(f, t, ctx), level };
    case "I-dup":
      return { ...dupText(f, t), level };
    case "I-dead":
      return { ...deadText(f, t), level };
    default:
      return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function q(path: string, params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  p.sort();
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** Hành động (mã từ API) -> nút + link trong console, bộ lọc theo list-url (ADR-163). Mã lạ bị bỏ. */
export function insightActions(i: InsightView): AlertAction[] {
  const out: AlertAction[] = [];
  for (const a of i.actions ?? []) {
    const dest = a.params?.destinationId && UUID.test(a.params.destinationId) ? a.params.destinationId : null;
    const src = a.params?.sourceId && UUID.test(a.params.sourceId) ? a.params.sourceId : null;
    if (a.code === "open_dlq")
      out.push({ labelKey: "alerts.action.open-dlq", href: q("/dashboard/dlq", { destination: dest }) });
    else if (a.code === "view_deliveries")
      out.push({ labelKey: "alerts.action.view-deliveries", href: q("/dashboard/deliveries", { destination: dest }) });
    else if (a.code === "view_events")
      out.push({ labelKey: "alerts.action.view-source-events", href: q("/dashboard/events", { source: src }) });
  }
  return out;
}

/** Màu theo mức — dùng chung ba trang. */
export const INSIGHT_TONE: Record<InsightLevel, string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  info: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-300",
  critical: "text-rose-700 dark:text-rose-300",
};
export const INSIGHT_DOT: Record<InsightLevel, string> = {
  ok: "bg-emerald-500",
  info: "bg-muted-foreground/60",
  warning: "bg-amber-500",
  critical: "bg-rose-500",
};

/** Nhận định theo đối tượng (từng dòng của bảng Đích / Nguồn). */
export function insightsBySubject(list: InsightView[] | undefined, code: InsightCode): Map<string, InsightView> {
  const m = new Map<string, InsightView>();
  for (const i of list ?? []) if (i.code === code) m.set(i.subjectId, i);
  return m;
}
