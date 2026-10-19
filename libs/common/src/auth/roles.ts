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
  'traffic:read', // EG5 (ADR-181): lưu lượng theo source (IP, tỷ lệ sai chữ ký) — chỉ owner + người vận hành (viaOperator)
  'storage:read', // QT4 (SPEC-han-muc-dung-luong §5.5, ADR-184): xem dung lượng + gợi ý dọn — owner, developer, người vận hành
  'storage:write', // QT4/QT5: dọn / xoá hẳn, áp dụng gợi ý, policy dọn tự động, cờ "Giữ lâu" — owner + người vận hành
  'read:unverified', // PK5 (E4, ADR-206): polling trả event CHƯA xác thực (`?includeUnverified=true`) — chỉ owner cấp cho key
] as const;
export type Scope = (typeof ALL_SCOPES)[number];
export type MemberRoleName = 'owner' | 'developer' | 'viewer';

const VIEWER: Scope[] = ['read:project', 'read:events'];
const DEVELOPER: Scope[] = [...VIEWER, 'publish:events', 'manage:endpoints', 'manage:sources', 'replay:deliveries', 'manage:keys', 'storage:read'];
const OWNER: Scope[] = [...DEVELOPER, 'manage:members', 'manage:project', 'traffic:read', 'storage:write', 'read:unverified'];

export const ROLE_SCOPES: Readonly<Record<MemberRoleName, readonly Scope[]>> = { viewer: VIEWER, developer: DEVELOPER, owner: OWNER };

/**
 * Scope một API key ĐƯỢC cấp: KHÔNG định nghĩa ở đây — nguồn duy nhất là `API_SCOPES` (+ `OWNER_GRANTED_API_SCOPES`) ở
 * `api-key.ts`. `manage:keys` / `manage:members` / `manage:project` / `read:project` / `replay:deliveries` /
 * `storage:*` / `traffic:read` KHÔNG BAO GIỜ cấp cho key (máy không được tự đúc key hay tự thêm người).
 */

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
