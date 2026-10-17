/**
 * CB4 (§8.4): `facts` của cảnh báo thành BẢNG đọc được — nhãn đã dịch, giá trị đã định dạng (mốc giờ, thời lượng, %,
 * tên nhà cung cấp, lý do đóng). Không bao giờ đổ JSON thô: object lồng (byClass) tách thành từng dòng con; khoá lạ
 * (server mới hơn web) hiện tên khoá + giá trị phẳng. TS thuần để jest test thẳng.
 */
import type { MessageKey, TranslateFn } from "../i18n/dictionary";
import { formatStamp } from "../hub/format";
import { FAILURE_CLASSES, formatDuration, type MessageContext, providerDisplayName } from "./message";

export interface FactRow {
  key: string;
  label: string;
  value: string;
  /** Dòng con (byClass) — thụt lề khi hiển thị. */
  nested?: boolean;
}

type Kind = "count" | "time" | "duration" | "pct" | "text" | "provider" | "reason" | "classes";

/**
 * Khoá SỔ SÁCH nội bộ của luật (rules.ts: mốc đã xét / mốc lỗi cùng loại cuối / đếm lượt "êm" của hysteresis) — có ích
 * cho evaluator, vô nghĩa với người đọc. Giữ nguyên trong `facts` (API/email không đổi), chỉ không lên bảng số liệu.
 */
export const HIDDEN_FACT_KEYS: ReadonlySet<string> = new Set(["lastAttemptAt", "lastMatchAt", "calmStreak", "lastCalmAt"]);

/** Thứ tự hiển thị + cách định dạng của khoá đã biết (rules.ts). Khoá nội bộ của hysteresis để cuối (và bị ẩn). */
const KNOWN: [key: string, kind: Kind][] = [
  ["httpStatus", "text"],
  ["closedByStatus", "text"],
  ["count", "count"],
  ["failed", "count"],
  ["total", "count"],
  ["pct", "pct"],
  ["byClass", "classes"],
  ["dead", "count"],
  ["sinceAt", "time"],
  ["windowFrom", "time"],
  ["providerLabel", "provider"],
  ["status", "text"],
  ["lastError", "text"],
  ["lastFix", "text"],
  ["stuckSince", "time"],
  ["circuitState", "text"],
  ["halfOpenAt", "time"],
  ["lastEventAt", "time"],
  ["silentMs", "duration"],
  ["medianGapMs", "duration"],
  ["thresholdMs", "duration"],
  ["baseline", "count"],
  ["reason", "reason"],
  ["lastAttemptAt", "time"],
  ["lastMatchAt", "time"],
  ["calmStreak", "count"],
  ["lastCalmAt", "time"],
];

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Giá trị phẳng cho khoá lạ: chuỗi/số/bool như cũ, mảng nối bằng ", ", object -> "k: v; …" (một tầng). */
function flat(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(flat).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${typeof x === "object" && x !== null ? "…" : String(x)}`)
      .join("; ");
  }
  return String(v);
}

export function factRows(facts: Record<string, unknown> | null | undefined, t: TranslateFn, ctx: Pick<MessageContext, "locale" | "now">): FactRow[] {
  const f = facts ?? {};
  const rows: FactRow[] = [];
  const done = new Set<string>();
  for (const [key, kind] of KNOWN) {
    if (!(key in f)) continue;
    done.add(key);
    if (HIDDEN_FACT_KEYS.has(key)) continue;
    const v = f[key];
    if (v === null || v === undefined || v === "") continue;
    const label = t(`alerts.fact.${kebab(key)}` as MessageKey);
    if (kind === "classes") {
      if (!v || typeof v !== "object") continue;
      const b = v as Record<string, unknown>;
      const sub = FAILURE_CLASSES.filter((c) => typeof b[c] === "number" && (b[c] as number) > 0);
      if (!sub.length) continue;
      rows.push({ key, label, value: "" });
      for (const c of sub) {
        rows.push({ key: `${key}.${c}`, label: t(`alerts.fact.class.${c.replace(/_/g, "-")}` as MessageKey), value: String(b[c]), nested: true });
      }
      continue;
    }
    let value: string;
    switch (kind) {
      case "time": {
        const at = typeof v === "string" ? Date.parse(v) : Number.NaN;
        // Cùng khuôn "dd/MM HH:mm" với dòng thời gian của sheet ở mọi ngôn ngữ (formatStamp).
        value = Number.isNaN(at) ? flat(v) : formatStamp(at, { now: ctx.now });
        break;
      }
      case "duration":
        value = typeof v === "number" ? formatDuration(v, t) : flat(v);
        break;
      case "pct":
        value = typeof v === "number" ? `${v}%` : flat(v);
        break;
      case "provider":
        value = providerDisplayName(v);
        break;
      case "reason":
        value = v === "archived" || v === "inactive" || v === "disconnected" ? t(`alerts.reason.${v}`) : flat(v);
        break;
      default:
        value = flat(v);
    }
    rows.push({ key, label, value });
  }
  for (const [key, v] of Object.entries(f)) {
    if (done.has(key) || v === null || v === undefined || v === "") continue;
    rows.push({ key, label: key, value: flat(v) });
  }
  return rows;
}
