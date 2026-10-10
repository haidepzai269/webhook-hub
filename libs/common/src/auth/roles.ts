/**
 * SPEC-auth §2.2: ROLE = BÓ SCOPE có tên. Người và máy dùng MỘT ngôn ngữ quyền: `@RequireScope('manage:endpoints')`
 * không cần biết người gọi là user đăng nhập hay service cầm `hk_*`. Bảng này là HẰNG SỐ DUY NHẤT — guard, web, docs
 * đều đọc từ đây.
 */
export const ALL_SCOPES = [
  'read:project', // xem event, delivery, source, endpoint, số liệu (không lộ secret)
  'read:events',
  'publish:events',
  'manage:endpoints',
  'manage:sources',
  'replay:deliveries',
  'manage:keys',
  'manage:members',
  'manage:project', // đổi tên, xoá project
] as const;
export type Scope = (typeof ALL_SCOPES)[number];
export type MemberRoleName = 'owner' | 'developer' | 'viewer';

const VIEWER: Scope[] = ['read:project', 'read:events'];
const DEVELOPER: Scope[] = [...VIEWER, 'publish:events', 'manage:endpoints', 'manage:sources', 'replay:deliveries', 'manage:keys'];
const OWNER: Scope[] = [...DEVELOPER, 'manage:members', 'manage:project'];

export const ROLE_SCOPES: Readonly<Record<MemberRoleName, readonly Scope[]>> = { viewer: VIEWER, developer: DEVELOPER, owner: OWNER };

/**
 * Scope một API key ĐƯỢC cấp. `manage:keys` / `manage:members` / `manage:project` / `read:project` /
 * `replay:deliveries` KHÔNG BAO GIỜ: máy không được tự đúc key hay tự thêm người (chặn leo thang đặc quyền).
 */
export const KEY_GRANTABLE_SCOPES: readonly Scope[] = ['publish:events', 'read:events', 'manage:endpoints', 'manage:sources'];

export function isScope(s: unknown): s is Scope {
  return typeof s === 'string' && (ALL_SCOPES as readonly string[]).includes(s);
}

export function roleHasScope(role: MemberRoleName, scope: string): boolean {
  return (ROLE_SCOPES[role] as readonly string[]).includes(scope);
}

/** Chỉ owner gán được role owner (SPEC-auth §5.6). */
export function isMemberRole(r: unknown): r is MemberRoleName {
  return r === 'owner' || r === 'developer' || r === 'viewer';
}
