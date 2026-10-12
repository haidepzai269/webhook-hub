import type { ProjectSummary } from "../../lib/hub/flow-project";

export const OPERATOR_NOTE = "đang xem với quyền operator";

export interface ProjectPickerView {
  current: ProjectSummary | undefined;
  /** Chữ hiện trên nút (một dòng, CSS cắt bằng ellipsis). */
  label: string;
  /** Tên đầy đủ + ghi chú operator — dùng cho tooltip/title (tên dài bị cắt, rail thu gọn chỉ còn icon). */
  tooltip: string;
  /** true = operator đang xem project mình không là thành viên. */
  operator: boolean;
}

/** Thuần (không React): project đang chọn, nhãn và tooltip cho bộ chọn project. Không khớp id -> project đầu. */
export function projectPickerView(projects: ProjectSummary[], projectId: string | null | undefined): ProjectPickerView {
  const current = projects.find((p) => p.id === projectId) ?? projects[0];
  const label = current?.name?.trim() || "Chọn project";
  const operator = current?.member === false;
  return { current, label, operator, tooltip: operator ? `${label} — ${OPERATOR_NOTE}` : label };
}

/** Tooltip cho một dòng trong danh sách: tên đầy đủ · vai trò · slug. */
export function projectItemTitle(p: ProjectSummary): string {
  const role = p.member === false ? "operator" : p.role;
  return [p.name, role, p.slug].filter(Boolean).join(" · ");
}
