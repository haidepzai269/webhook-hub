import { ProviderType } from '@hub/common';
import { GenericConfig, validateGenericConfig } from '@hub/providers';
import { unprocessable } from './service-api.controller';

/** Provider mà người dùng được TẠO source. `api` do hub tạo kèm key (S4) — không tạo tay. */
export const CREATABLE_PROVIDERS: readonly ProviderType[] = ['github', 'payos', 'sepay', 'stripe', 'generic'];

export interface SourceInput {
  provider: ProviderType;
  name: string;
  secret: string;
  verificationConfig: GenericConfig | undefined;
}

/**
 * S8 (SPEC §4.3B, §4.8): kiểm body tạo source — dùng chung console `/api/v1/sources` và `/v1/p/:project/sources`.
 * Sai -> 422 `{error:"validation_failed", field, message}`. `generic` BẮT BUỘC `verificationConfig` hợp lệ
 * (lỗi trong config -> field `verificationConfig.<đường dẫn>`); provider khác mà có config -> 422.
 */
export function parseSourceInput(body: any): SourceInput {
  const provider = body?.provider;
  if (!CREATABLE_PROVIDERS.includes(provider)) {
    unprocessable({ error: 'validation_failed', field: 'provider', message: `provider là một trong ${CREATABLE_PROVIDERS.join(', ')} (api do hub tạo kèm key)` });
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 255) unprocessable({ error: 'validation_failed', field: 'name', message: 'name là chuỗi 1–255 ký tự' });
  if (typeof body?.secret !== 'string' || body.secret.length < 8 || body.secret.length > 512) {
    unprocessable({ error: 'validation_failed', field: 'secret', message: 'secret là chuỗi 8–512 ký tự' });
  }
  let verificationConfig: GenericConfig | undefined;
  if (provider === 'generic') {
    const r = validateGenericConfig(body?.verificationConfig);
    if (!r.ok) {
      const { field, message } = r as { field: string; message: string };
      unprocessable({ error: 'validation_failed', field: field === 'verificationConfig' ? field : `verificationConfig.${field}`, message });
    }
    verificationConfig = (r as { config: GenericConfig }).config;
  } else if (body?.verificationConfig !== undefined && body?.verificationConfig !== null) {
    unprocessable({ error: 'validation_failed', field: 'verificationConfig', message: 'chỉ provider generic có verificationConfig' });
  }
  return { provider, name, secret: body.secret, verificationConfig };
}
