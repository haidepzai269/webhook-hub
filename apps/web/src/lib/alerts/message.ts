/**
 * CB4 (SPEC-canh-bao-nhan-dinh §2, §4, §7): dựng câu `{ title, message, fix }` của một cảnh báo từ `rule` + `facts`, phía
 * client, theo ngôn ngữ đang chọn. API chỉ trả mã + số liệu; câu chữ ở messages/alerts.ts (khoá theo luật).
 * - Không bao giờ chỉ một con số: title nói chuyện gì, message nói bao nhiêu/từ lúc nào, fix nói làm gì.
 * - D5: tên nhà cung cấp lấy từ `facts.providerLabel` (dữ liệu) — không có nhánh theo provider.
 * - `destination.failing` tách theo loại lỗi (`facts.byClass`): 429 -> "bên nhận bảo chậm lại", 3xx -> "kiểm tra URL".
 * TS thuần (không React, không alias `@/`) để jest gốc test thẳng.
 */
import type { MessageKey, TranslateFn } from "../i18n/dictionary";
import { INTL_LOCALE, type Locale } from "../i18n/locales";
import type { AlertSubjectType } from "./types";

export interface AlertLike {
  rule: string;
  facts: Record<string, unknown> | null | undefined;
  subjectType: AlertSubjectType;
  subjectId: string;
}

export interface MessageContext {
  locale: Locale;
  /** Mốc "bây giờ" (ms) — tiêm vào để test ổn định. */
  now: number;
  /** Tên đối tượng nếu biết (đích/nguồn của project); không biết -> nhãn loại + id ngắn. */
  subjectName?: string | null;
}

export interface AlertText {
  title: string;
  message: string;
  fix: string;
  /** "{đối tượng}: {title}" — dùng ở banner/toast (một dòng nói đủ "cái gì" và "ở đâu"). */
  headline: string;
  subjectLabel: string;
}

/** Mã luật -> đoạn khoá i18n: `destination.auth_rejected` -> `destination.auth-rejected` (khoá chỉ có chữ thường, '.', '-'). */
export function ruleSegment(rule: string): string {
  return rule.replace(/_/g, "-");
}

/** Khoá `alerts.rule.<luật>.<phần>` — ép kiểu một chỗ; `hasKey` kiểm thật trong từ điển trước khi dùng. */
export function ruleKey(rule: string, part: string): MessageKey {
  return `alerts.rule.${ruleSegment(rule)}.${part}` as MessageKey;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const time = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
};

/** Thời lượng gọn theo ngôn ngữ: 45 giây · 12 phút · 3 giờ · 2 ngày. */
export function formatDuration(ms: number, t: TranslateFn): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("alerts.unit.seconds", { n: s });
  const m = Math.round(s / 60);
  if (m < 90) return t("alerts.unit.minutes", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t("alerts.unit.hours", { n: h });
  return t("alerts.unit.days", { n: Math.round(h / 24) });
}

const timeFmt = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: Locale, withDay: boolean): Intl.DateTimeFormat {
  const k = `${locale}:${withDay}`;
  let f = timeFmt.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
      hour: "2-digit",
      minute: "2-digit",
      ...(withDay ? { day: "2-digit", month: "2-digit" } : {}),
    });
    timeFmt.set(k, f);
  }
  return f;
}

/** Mốc ngắn: "14:02" nếu trong 20 giờ qua/tới, không thì kèm ngày "12/10 14:02". */
export function formatClock(at: number, ctx: Pick<MessageContext, "locale" | "now">): string {
  return fmt(ctx.locale, Math.abs(ctx.now - at) > 20 * 3600_000).format(new Date(at));
}

/** Tên hiển thị của nhà cung cấp từ mã dữ liệu (`facts.providerLabel`) — bảng tên, không phải nhánh logic. */
const PROVIDER_NAMES: Record<string, string> = { payos: "PayOS", github: "GitHub", generic: "Generic" };
export function providerDisplayName(code: unknown): string {
  const c = str(code);
  if (!c) return "?";
  return PROVIDER_NAMES[c.toLowerCase()] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

/** Nhãn đối tượng: tên nếu biết; cấp dự án -> "Toàn dự án"; không thì "Đích 3fa2c1d0". */
export function subjectLabel(a: Pick<AlertLike, "subjectType" | "subjectId">, t: TranslateFn, name?: string | null): string {
  if (name) return name;
  if (a.subjectType === "project") return t("alerts.subject.project");
  return t("alerts.subject.fallback", { type: t(`alerts.subject.${a.subjectType}`), id: a.subjectId.slice(0, 8) });
}

/** Loại lỗi của `destination.failing` (khớp `byClass` của rules.ts) — thứ tự cố định để câu ổn định khi bằng nhau. */
export const FAILURE_CLASSES = ["server_error", "no_response", "throttled", "unexpected"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
const CLASS_SEGMENT: Record<FailureClass, "server-error" | "no-response" | "throttled" | "unexpected"> = {
  server_error: "server-error",
  no_response: "no-response",
  throttled: "throttled",
  unexpected: "unexpected",
};

/** byClass -> các loại có số > 0, nhiều nhất trước (bằng nhau giữ thứ tự FAILURE_CLASSES). */
export function failureBreakdown(byClass: unknown): { cls: FailureClass; n: number }[] {
  if (!byClass || typeof byClass !== "object") return [];
  const b = byClass as Record<string, unknown>;
  return FAILURE_CLASSES.map((cls) => ({ cls, n: num(b[cls]) ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n);
}

/** Câu "cách sửa" của destination.failing theo loại lỗi TRỘI (429 -> chậm lại, 3xx -> URL, không phản hồi -> mạng). */
export function failingFixKey(byClass: unknown): MessageKey {
  const top = failureBreakdown(byClass)[0]?.cls ?? "server_error";
  return `alerts.rule.destination.failing.fix.${CLASS_SEGMENT[top]}` as MessageKey;
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" ");

/**
 * Dựng câu cho một cảnh báo. Thiếu số liệu thì câu gọn hơn chứ không in "undefined"; luật lạ (server mới hơn web)
 * -> tiêu đề chung có mã luật, không vỡ trang.
 */
export function buildAlertText(a: AlertLike, t: TranslateFn, ctx: MessageContext): AlertText {
  const f = a.facts ?? {};
  const subject = subjectLabel(a, t, ctx.subjectName);
  const clock = (v: unknown) => {
    const at = time(v);
    return at === null ? null : formatClock(at, ctx);
  };
  let title: string;
  let message = "";
  let fix = "";

  switch (a.rule) {
    case "destination.auth_rejected":
    case "destination.client_error": {
      const status = num(f.httpStatus) ?? (a.rule === "destination.auth_rejected" ? "401/403" : "4xx");
      title = t(ruleKey(a.rule, "title"), { status });
      const count = num(f.count);
      const since = clock(f.sinceAt);
      const dead = num(f.dead);
      message = join(
        count !== null && since ? t(ruleKey(a.rule, "message"), { count, since, status }) : null,
        a.rule === "destination.auth_rejected" && dead ? t("alerts.rule.destination.auth-rejected.impact", { dead }) : null,
      );
      fix = t(ruleKey(a.rule, "fix"));
      break;
    }
    case "destination.failing": {
      const pct = num(f.pct);
      title = t("alerts.rule.destination.failing.title", { pct: pct ?? "?" });
      const parts = failureBreakdown(f.byClass).map(({ cls, n }) => t(`alerts.class.${CLASS_SEGMENT[cls]}`, { n }));
      const failed = num(f.failed);
      const total = num(f.total);
      message = join(
        failed !== null && total !== null && parts.length
          ? t("alerts.rule.destination.failing.message", { failed, total, breakdown: parts.join(", ") })
          : null,
        t("alerts.rule.destination.failing.reassure"),
      );
      fix = t(failingFixKey(f.byClass));
      break;
    }
    case "destination.circuit_open": {
      title = t("alerts.rule.destination.circuit-open.title");
      const at = clock(f.halfOpenAt);
      message = join(t("alerts.rule.destination.circuit-open.message"), at ? t("alerts.rule.destination.circuit-open.retry-at", { at }) : null);
      fix = t("alerts.rule.destination.circuit-open.fix");
      break;
    }
    case "delivery.dead_spike": {
      title = t("alerts.rule.delivery.dead-spike.title", { count: num(f.count) ?? "≥10" });
      message = t("alerts.rule.delivery.dead-spike.message");
      fix = t("alerts.rule.delivery.dead-spike.fix");
      break;
    }
    case "source.signature_failing": {
      title = t("alerts.rule.source.signature-failing.title", { failed: num(f.failed) ?? "?", total: num(f.total) ?? "?" });
      const pct = num(f.pct);
      message = pct !== null ? t("alerts.rule.source.signature-failing.message", { pct }) : "";
      fix = t("alerts.rule.source.signature-failing.fix");
      break;
    }
    case "source.connection_broken": {
      const provider = providerDisplayName(f.providerLabel);
      const VARIANT: Record<string, "drifted" | "pending"> = { DRIFTED: "drifted", PENDING: "pending" };
      const variant = (typeof f.status === "string" && VARIANT[f.status]) || "failed";
      title = t(ruleKey(a.rule, `title.${variant}`), { provider });
      const since = clock(f.stuckSince);
      message = t(ruleKey(a.rule, `message.${variant}`), { provider });
      if (variant === "pending") message = since ? t("alerts.rule.source.connection-broken.message.pending", { since }) : "";
      // Review L8: `lastError`/`lastFix` của server là chữ một ngôn ngữ (không dịch được) -> KHÔNG ghép vào câu; chỉ hiện
      // nguyên văn ở bảng số liệu (facts.ts). Câu "cách sửa" luôn từ từ điển, đúng ngôn ngữ đang chọn.
      fix = t("alerts.rule.source.connection-broken.fix");
      break;
    }
    case "source.silent": {
      const last = time(f.lastEventAt);
      const silentMs = last !== null ? ctx.now - last : num(f.silentMs);
      title = t("alerts.rule.source.silent.title", { duration: silentMs !== null ? formatDuration(silentMs, t) : "?" });
      const gap = num(f.medianGapMs);
      message = gap !== null && last !== null ? t("alerts.rule.source.silent.message", { gap: formatDuration(gap, t), last: formatClock(last, ctx) }) : "";
      fix = t("alerts.rule.source.silent.fix");
      break;
    }
    case "normalize.backlog": {
      title = t("alerts.rule.normalize.backlog.title", { count: num(f.count) ?? "?" });
      message = t("alerts.rule.normalize.backlog.message");
      fix = t("alerts.rule.normalize.backlog.fix");
      break;
    }
    default:
      title = t("alerts.rule.unknown.title", { rule: a.rule });
  }

  const reason = str(f.reason);
  if (reason === "archived" || reason === "inactive" || reason === "disconnected") {
    message = join(message, t(`alerts.reason.${reason}`));
  }
  return { title, message, fix, headline: t("alerts.headline", { subject, title }), subjectLabel: subject };
}

/** Tên ngắn của luật (bộ lọc, Cài đặt) — luật lạ -> chính mã luật. */
export function ruleName(rule: string, t: TranslateFn): string {
  const key = ruleKey(rule, "name");
  const out = t(key);
  return out === key ? rule : out;
}
