/**
 * EG5 (SPEC-chong-qua-tai §6.2, ADR-181): câu nhận định của khối "Lưu lượng" dựng từ `code + facts` (`I-traffic`), cùng khuôn
 * nhận định CB6: nhãn nói "chuyện gì" (một câu, các vế nối bằng " · "), dòng phụ nói "nên làm gì". TS thuần (không React,
 * không alias `@/`) để jest gốc test thẳng. Không nhánh theo provider.
 */
import type { MessageKey, TranslateFn } from "../i18n/dictionary";
import { INTL_LOCALE, type Locale } from "../i18n/locales";

export type TrafficRange = "1h" | "24h" | "7d";
export const TRAFFIC_OUTCOMES = ["ACCEPTED", "DUPLICATE", "REJECTED", "RATE_LIMITED", "BLOCKED"] as const;
export type TrafficOutcome = (typeof TRAFFIC_OUTCOMES)[number];

export interface TrafficInsightView {
  code: "I-traffic";
  level: "ok" | "info" | "warning";
  facts: {
    range?: unknown;
    state?: unknown;
    total?: unknown;
    rejectedPct?: unknown;
    rateLimited?: unknown;
    blocked?: unknown;
    dominantIp?: unknown;
  };
}

export interface TrafficView {
  range: TrafficRange;
  bucketSeconds: number;
  buckets: ({ t: string } & Record<TrafficOutcome, number>)[];
  topIps: { ip: string; count: number; rejected: number; lastSeen: string }[];
  insight: TrafficInsightView;
  blockedNow: { ip: string; remainingSec: number }[];
}

const n0 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const RANGES: TrafficRange[] = ["1h", "24h", "7d"];
const rangeOf = (v: unknown, fallback: TrafficRange): TrafficRange =>
  RANGES.includes(v as TrafficRange) ? (v as TrafficRange) : fallback;

export interface TrafficText {
  label: string;
  detail: string;
  level: "ok" | "info" | "warning";
  empty: boolean;
}

/** "1 giờ qua: 1.240 request · 31% sai chữ ký · phần lớn từ 1 IP (203.0.113.7)". Mã lạ -> null. */
export function trafficInsightText(
  i: TrafficInsightView | undefined,
  t: TranslateFn,
  locale: Locale,
  range: TrafficRange,
): TrafficText | null {
  if (!i || i.code !== "I-traffic") return null;
  const f = i.facts ?? {};
  const r = rangeOf(f.range, range);
  const nf = new Intl.NumberFormat(INTL_LOCALE[locale]);
  const total = n0(f.total);
  if (f.state === "empty" || total === 0) {
    return {
      label: t("traffic.insight.empty", { range: t(`traffic.range-in.${r}` as MessageKey) }),
      detail: t("traffic.insight.empty-detail"),
      level: "ok",
      empty: true,
    };
  }
  const parts = [
    t("traffic.insight.total", { range: t(`traffic.range-label.${r}` as MessageKey), n: nf.format(total) }),
  ];
  const pct = n0(f.rejectedPct);
  if (pct > 0) parts.push(t("traffic.insight.rejected", { pct }));
  if (n0(f.rateLimited) > 0) parts.push(t("traffic.insight.rate-limited", { n: nf.format(n0(f.rateLimited)) }));
  if (n0(f.blocked) > 0) parts.push(t("traffic.insight.blocked", { n: nf.format(n0(f.blocked)) }));
  if (typeof f.dominantIp === "string" && f.dominantIp) parts.push(t("traffic.insight.dominant", { ip: f.dominantIp }));
  const attention = f.state === "attention";
  return {
    label: parts.join(" · "),
    detail: t(attention ? "traffic.insight.attention-detail" : "traffic.insight.normal-detail"),
    level: attention ? "warning" : "ok",
    empty: false,
  };
}

/** Dòng "đang tạm chặn": số IP + phút còn lại lâu nhất (làm tròn lên). Không có -> null. */
export function blockedNowText(
  list: { ip: string; remainingSec: number }[] | undefined,
  t: TranslateFn,
): string | null {
  if (!list?.length) return null;
  const minutes = Math.max(1, Math.ceil(Math.max(...list.map((b) => b.remainingSec)) / 60));
  return t("traffic.blocked-now", { count: list.length, minutes });
}
