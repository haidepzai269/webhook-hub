import { ulid } from 'ulidx';

/**
 * Định dạng `sourceKey` — MỘT chỗ cho mọi đường tạo source (review EG1 #4). Key tự đặt phải khớp `SOURCE_KEY_RE`; key do hub
 * sinh (`generateSourceKey`, `apiSourceKey`) luôn khớp regex location `/hooks/*` của nginx (docker/nginx/nginx.conf.template,
 * test [EG:T3]) — không thì source được tạo nhưng webhook vào bị nginx trả 404.
 */
export const SOURCE_KEY_RE = /^[a-z0-9_]{3,64}$/;

/** Key hub tự sinh cho source provider: `src_<provider>_<ulid thường>`. */
export function generateSourceKey(provider: string): string {
  return `src_${provider}_${ulid().toLowerCase()}`;
}

/** Key của source `api` tạo kèm API key có `publish:events` (S4). */
export function apiSourceKey(keyId: string): string {
  return `api_${keyId}`;
}
