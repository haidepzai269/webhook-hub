import { SetMetadata } from '@nestjs/common';

export const REQUIRE_SCOPE_KEY = 'hub:requiredScope';

/**
 * S3: scope bắt buộc của một route `/v1/p/*` (`publish:events`, `read:events`, `manage:endpoints`, `manage:sources`).
 * `ApiKeyGuard` đọc metadata này; thiếu -> 403 `{error:"missing_scope", required}`. AU3 dùng lại cho principal `user`.
 */
export const RequireScope = (scope: string) => SetMetadata(REQUIRE_SCOPE_KEY, scope);
