import type { ProjectSummary } from "../../lib/hub/flow-project";
import type { MessageKey, TranslateFn } from "../../lib/i18n/dictionary";

export interface ProjectPickerView {
  current: ProjectSummary | undefined;
  /** Chữ hiện trên nút (một dòng, CSS cắt bằng ellipsis). */
  label: string;
  /** Tên đầy đủ + ghi chú operator — dùng cho tooltip/title (tên dài bị cắt, rail thu gọn chỉ còn icon). */
  tooltip: string;
  /** true = operator đang xem project mình không là thành viên. */
  operator: boolean;
}

const ROLE_KEYS: Record<string, MessageKey> = {
  owner: "admin.project.role.owner",
  developer: "admin.project.role.developer",
  viewer: "admin.project.role.viewer",
};

/** Nhãn dịch của vai trò (owner/developer/viewer); vai trò lạ (server mới) giữ nguyên mã. */
export function roleLabel(role: string, t: TranslateFn): string {
  return Object.hasOwn(ROLE_KEYS, role) ? t(ROLE_KEYS[role]) : role;
}

/** Thuần (không React): project đang chọn, nhãn và tooltip cho bộ chọn project. Không khớp id -> project đầu. */
export function projectPickerView(
  projects: ProjectSummary[],
  projectId: string | null | undefined,
  t: TranslateFn,
): ProjectPickerView {
  const current = projects.find((p) => p.id === projectId) ?? projects[0];
  const label = current?.name?.trim() || t("admin.project.select");
  const operator = current?.member === false;
  return { current, label, operator, tooltip: operator ? `${label} — ${t("admin.project.operator-note")}` : label };
}

/** Tooltip cho một dòng trong danh sách: tên đầy đủ · vai trò · slug. */
export function projectItemTitle(p: ProjectSummary, t: TranslateFn): string {
  const role = p.member === false ? t("admin.project.operator") : p.role && roleLabel(p.role, t);
  return [p.name, role, p.slug].filter(Boolean).join(" · ");
}
