import { ulid } from 'ulidx';

/**
 * Định dạng `sourceKey` — MỘT chỗ cho mọi đường tạo source (review EG1 #4, spec EG D13). `SOURCE_KEY_RE` TRÙNG ĐÚNG phần
 * sourceKey của regex location `/hooks/*` trong docker/nginx/nginx.conf.template ([EG:T3] so hai regex): chặt hơn nginx thì
 * client đang gửi key có chữ hoa / `-` bị gãy, lỏng hơn thì source tạo được mà webhook vào bị nginx trả 404 lặng lẽ.
 */
export const SOURCE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Thông báo lỗi chung (422 validation_failed, field sourceKey). */
export const SOURCE_KEY_RULE = 'sourceKey: 1–64 ký tự A-Z a-z 0-9 _ - (bỏ trống để hub tự sinh)';

/** Key hub tự sinh cho source provider: `src_<provider>_<ulid thường>`. */
export function generateSourceKey(provider: string): string {
  return `src_${provider}_${ulid().toLowerCase()}`;
}

/** Key của source `api` tạo kèm API key có `publish:events` (S4). */
export function apiSourceKey(keyId: string): string {
  return `api_${keyId}`;
}
