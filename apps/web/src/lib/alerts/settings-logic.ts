/**
 * CB5 (SPEC-canh-bao-nhan-dinh §3.2, §8.5): logic thuần của mục "Cảnh báo" ở trang Cài đặt — bảng phân loại luật, nút
 * "Chỉ nghiêm trọng" / "Tất cả", khoá công tắc khi email chưa xác minh, tắt tiếng theo project, body PUT chỉ phần đổi.
 * TS thuần (không React, không alias `@/`) để jest gốc test thẳng.
 */
import type { MessageKey } from "../i18n/dictionary";
import type { AlertSeverity } from "./types";

export interface RuleCatalogEntry {
  code: string;
  severity: AlertSeverity;
}

/** GET /api/v1/me/alert-preferences (CB3 + CB5). */
export interface AlertPreferencesView {
  email: string | null;
  emailVerified: boolean;
  emailEnabled: boolean;
  emailRules: string[];
  emailOnResolve: boolean;
  mutedProjects: string[];
  updatedAt: string | null;
  hourlyCap: number;
  testEmail: { perHour: number };
  rules: RuleCatalogEntry[];
}

export type AlertPreferencesPatch = Partial<
  Pick<AlertPreferencesView, "emailEnabled" | "emailRules" | "emailOnResolve" | "mutedProjects">
>;

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Bảng phân loại: nghiêm trọng trước, giữ thứ tự danh mục trong cùng mức. */
export function ruleRows(catalog: readonly RuleCatalogEntry[], selected: readonly string[]) {
  return catalog
    .map((r, i) => ({ ...r, i, checked: selected.includes(r.code) }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.i - b.i)
    .map(({ i: _i, ...r }) => r);
}

/** "Chỉ nghiêm trọng" = mặc định của server (DEFAULT_EMAIL_RULES); "Tất cả" = mọi luật. Thứ tự theo danh mục. */
export function presetRules(catalog: readonly RuleCatalogEntry[], preset: "critical" | "all"): string[] {
  return catalog.filter((r) => preset === "all" || r.severity === "critical").map((r) => r.code);
}

/** Bật/tắt một luật, giữ thứ tự danh mục (body PUT ổn định). */
export function toggleRule(
  catalog: readonly RuleCatalogEntry[],
  selected: readonly string[],
  code: string,
  on: boolean,
): string[] {
  const set = new Set(selected);
  if (on) set.add(code);
  else set.delete(code);
  return catalog.map((r) => r.code).filter((c) => set.has(c));
}

export function toggleMuted(muted: readonly string[], projectId: string, mute: boolean): string[] {
  const rest = muted.filter((id) => id !== projectId);
  return mute ? [...rest, projectId] : rest;
}

/**
 * Công tắc email: khoá khi chưa có email / email chưa xác minh (server cũng chỉ gửi tới email đã xác minh, §6). Đang bật
 * mà email mất xác minh vẫn cho TẮT (không bao giờ khoá người dùng ở trạng thái bật).
 */
export function emailSwitchState(p: Pick<AlertPreferencesView, "email" | "emailVerified" | "emailEnabled">): {
  disabled: boolean;
  reasonKey: MessageKey | null;
} {
  if (p.email && p.emailVerified) return { disabled: false, reasonKey: null };
  const reasonKey: MessageKey = p.email
    ? "page.settings.alerts.locked.unverified"
    : "page.settings.alerts.locked.no-email";
  return { disabled: !p.emailEnabled, reasonKey };
}

/** Preset đang khớp (để tô nút): "critical" | "all" | null (tuỳ chọn riêng). */
export function activePreset(
  catalog: readonly RuleCatalogEntry[],
  selected: readonly string[],
): "critical" | "all" | null {
  const same = (a: string[]) => a.length === selected.length && a.every((c) => selected.includes(c));
  if (same(presetRules(catalog, "all"))) return "all";
  if (same(presetRules(catalog, "critical"))) return "critical";
  return null;
}

/** Khoá i18n của mô tả một câu cho luật: `destination.auth_rejected` -> `page.settings.rule.destination-auth-rejected`. */
export function ruleDescriptionKey(code: string): MessageKey {
  return `page.settings.rule.${code.replace(/[._]/g, "-")}` as MessageKey;
}
