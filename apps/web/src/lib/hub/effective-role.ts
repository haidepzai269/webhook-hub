import { ROLE_SCOPES, isMemberRole, type MemberRoleName, type Scope } from "@hub/common/auth/roles";

/**
 * MỘT chỗ duy nhất web quyết định "người này làm được gì trong project này" — khớp `resolveProjectScope`
 * (apps/hub-api/src/modules/console/project-scope.guard.ts): có membership thì dùng role THẬT (kể cả khi là operator);
 * operator chỉ được coi như owner khi KHÔNG là thành viên của project (`viaOperator`). Hàm thuần, không đọc store.
 * Server vẫn là trọng tài (403) — đây chỉ để không hiện nút bấm là hỏng.
 */
export interface RoleSubject {
  user: { isOperator?: boolean };
  memberships: { projectId: string; role: string }[];
}

export function effectiveRole(me: RoleSubject | null | undefined, projectId: string | null | undefined): MemberRoleName | null {
  if (!me || !projectId) return null;
  const membership = me.memberships.find((m) => m.projectId === projectId);
  if (membership) return isMemberRole(membership.role) ? membership.role : null;
  return me.user.isOperator === true ? "owner" : null;
}

export function canScope(me: RoleSubject | null | undefined, projectId: string | null | undefined, ...scopes: Scope[]): boolean {
  const role = effectiveRole(me, projectId);
  return role !== null && scopes.every((s) => (ROLE_SCOPES[role] as readonly Scope[]).includes(s));
}
