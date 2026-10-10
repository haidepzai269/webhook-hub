import { HttpException, HttpStatus, SetMetadata } from '@nestjs/common';

export const REQUIRE_SCOPE_KEY = 'hub:requiredScope';
export const NO_PROJECT_SCOPE_KEY = 'hub:noProjectScope';

/**
 * SPEC-auth §2.2 / §5.6: scope bắt buộc của một route — MỘT decorator cho cả hai loại principal:
 * - service (`/v1/p/*`): `ApiKeyGuard` đọc metadata này;
 * - người (`/api/v1/*`): `ProjectScopeGuard` đọc, scope = ROLE_SCOPES[role].
 * Thiếu -> 403 `{error:"missing_scope", required}`.
 */
export const RequireScope = (scope: string) => SetMetadata(REQUIRE_SCOPE_KEY, scope);

/**
 * Route `/api/v1/*` KHÔNG thuộc project nào (liệt kê / tạo project của chính mình). Phải ghi lý do — UA20 chấp nhận
 * route có `@RequireScope` HOẶC `@NoProjectScope`, không route nào được im lặng.
 */
export const NoProjectScope = (reason: string) => SetMetadata(NO_PROJECT_SCOPE_KEY, reason);

export const PUBLIC_ROUTE_KEY = 'hub:publicRoute';

/**
 * R-8 (review AU, ADR-113): route KHÔNG theo scope của project/key — tự xác thực bằng cơ chế riêng (chữ ký provider
 * ở /hooks, token ở /metrics, phiên của CHÍNH người gọi ở /auth) hoặc công khai thật (/health). Phải ghi lý do.
 * Đóng mặc định: MỌI route (quét mọi controller, UA20) phải có `@RequireScope` | `@NoProjectScope` | `@PublicRoute`;
 * `ProjectScopeGuard` / `ApiKeyGuard` gặp route không khai scope -> 500 `scope_not_declared` (không mở cho mọi role).
 */
export const PublicRoute = (reason: string) => SetMetadata(PUBLIC_ROUTE_KEY, reason);

/** Guard gặp route thiếu khai báo scope: lỗi CẤU HÌNH của dev -> 500, không bao giờ cho qua. */
export function scopeNotDeclared(where: string): never {
  throw new HttpException({ error: 'scope_not_declared', message: `Route chưa khai @RequireScope (${where})` }, HttpStatus.INTERNAL_SERVER_ERROR);
}
