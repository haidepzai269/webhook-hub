/**
 * ADR-237 — trang tầng TÀI KHOẢN (Hub ⊃ Tài khoản ⊃ Dự án, ADR-234): không nằm dưới `/dashboard` nên không có sidebar dự án.
 * Cảnh báo (API `/api/v1/alerts*` xuyên dự án, ADR-190) và Cài đặt (email cảnh báo của operator, CB5) ở đây — lối vào là
 * menu tài khoản ở thanh trên. TS thuần (không React, không icon) để jest test thẳng.
 */
import type { MessageKey } from "../i18n/dictionary";

export const ACCOUNT_ROUTES = { projects: "/projects", alerts: "/alerts", settings: "/settings" } as const;

export type AccountMenuId = "alerts" | "settings";

export interface AccountMenuEntry {
  id: AccountMenuId;
  titleKey: MessageKey;
  url: string;
}

/** Đủ phần của `/auth/me` để quyết định vai trò (AuthMe khớp khuôn này). */
export interface AccountMeLike {
  user: { isOperator?: boolean };
  memberships?: ReadonlyArray<{ role: string }>;
}

/**
 * Mục tầng tài khoản theo vai trò — giữ đúng điều kiện cũ của sidebar:
 * - Cảnh báo: operator (mọi cảnh báo) HOẶC owner của ít nhất một dự án (chỉ cảnh báo dung lượng dự án mình — ADR-190).
 * - Cài đặt: chỉ operator (hiện chỉ có email cảnh báo — CB5).
 */
export function accountMenuItems(me: AccountMeLike | null | undefined): AccountMenuEntry[] {
  if (!me) return [];
  const operator = me.user.isOperator === true;
  const owner = (me.memberships ?? []).some((m) => m.role === "owner");
  const items: AccountMenuEntry[] = [];
  if (operator || owner) items.push({ id: "alerts", titleKey: "nav.item.alerts", url: ACCOUNT_ROUTES.alerts });
  if (operator) items.push({ id: "settings", titleKey: "nav.item.settings", url: ACCOUNT_ROUTES.settings });
  return items;
}

/**
 * Đường cũ `/dashboard/alerts`, `/dashboard/settings` (link trong email đã gửi, bookmark) -> đường mới, giữ nguyên query
 * (`?project=…&rule=…` lọc đúng cảnh báo).
 */
export function legacyAccountRedirect(
  target: AccountMenuId,
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
  }
  const s = p.toString();
  return s ? `${ACCOUNT_ROUTES[target]}?${s}` : ACCOUNT_ROUTES[target];
}
