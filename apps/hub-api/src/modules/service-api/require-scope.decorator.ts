import { SetMetadata } from '@nestjs/common';

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
