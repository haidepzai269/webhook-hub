import { ProviderType } from '@hub/common';
import { aesGcmEncrypt } from '@hub/crypto';
import { getMasterKey } from '@hub/database';
import { GenericConfig, VERIFY_TOKEN_RE, secretProblem, validateGenericConfig } from '@hub/providers';
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
    const sealed = sealHandshakeToken(body?.verificationConfig);
    const r = validateGenericConfig(sealed.config);
    if (!r.ok) {
      const { field, message } = r as { field: string; message: string };
      unprocessable({ error: 'validation_failed', field: field === 'verificationConfig' ? field : `verificationConfig.${field}`, message });
    }
    verificationConfig = (r as { config: GenericConfig }).config;
    if (sealed.verifyTokenEnc && verificationConfig.handshake?.kind === 'query-echo') {
      verificationConfig.handshake.verifyTokenEnc = sealed.verifyTokenEnc;
    }
    // PK2 (ADR-203): secret phải dùng được với config (keyEncoding hex/base64, basic "user:pass") — 422 bây giờ thay vì 401 mãi.
    const problem = secretProblem(verificationConfig, body.secret);
    if (problem) unprocessable({ error: 'validation_failed', field: 'secret', message: problem });
  } else if (body?.verificationConfig !== undefined && body?.verificationConfig !== null) {
    unprocessable({ error: 'validation_failed', field: 'verificationConfig', message: 'chỉ provider generic có verificationConfig' });
  }
  return { provider, name, secret: body.secret, verificationConfig };
}

/**
 * PK4 (E13, ADR-205): token xác minh của `query-echo` (Meta `hub.verify_token`) gửi RÕ lúc tạo source ở
 * `verificationConfig.handshake.verifyToken`, được mã hoá AES-GCM (master key) thành `verifyTokenEnc` — KHÔNG phải
 * SourceSecret (ingest thử mọi SourceSecret làm khoá HMAC; token Meta mà là secret thì thành khoá ký hợp lệ). Client không
 * được tự gửi `verifyTokenEnc` (ciphertext tuỳ ý) -> 422. Có `verifyTokenParam` thì BẮT BUỘC có `verifyToken`.
 */
function sealHandshakeToken(vc: unknown): { config: unknown; verifyTokenEnc?: string } {
  const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(vc) || !isObj(vc.handshake)) return { config: vc };
  const h = vc.handshake;
  const field = (f: string) => `verificationConfig.handshake.${f}`;
  if (h.verifyTokenEnc !== undefined) {
    unprocessable({ error: 'validation_failed', field: field('verifyTokenEnc'), message: 'verifyTokenEnc do server ghi — gửi verifyToken (rõ), server mã hoá' });
  }
  if (h.verifyToken === undefined) {
    if (h.kind === 'query-echo' && h.verifyTokenParam !== undefined) {
      unprocessable({ error: 'validation_failed', field: field('verifyToken'), message: 'có verifyTokenParam thì bắt buộc verifyToken (chuỗi bạn khai ở provider)' });
    }
    return { config: vc };
  }
  if (h.kind !== 'query-echo' || h.verifyTokenParam === undefined) {
    unprocessable({ error: 'validation_failed', field: field('verifyToken'), message: 'verifyToken chỉ dùng với query-echo có verifyTokenParam' });
  }
  if (typeof h.verifyToken !== 'string' || !VERIFY_TOKEN_RE.test(h.verifyToken)) {
    unprocessable({ error: 'validation_failed', field: field('verifyToken'), message: 'verifyToken là chuỗi ASCII in được 8–256 ký tự' });
  }
  const { verifyToken, ...rest } = h;
  return { config: { ...vc, handshake: rest }, verifyTokenEnc: aesGcmEncrypt(verifyToken, getMasterKey()) };
}

/**
 * PK4 (E13): bản trả ra client của `verificationConfig` — bỏ `handshake.verifyTokenEnc` (ciphertext, như không trả ciphertext
 * secret), thay bằng `verifyTokenSet: true`. Mọi response có verificationConfig đi qua đây.
 */
export function publicVerificationConfig(vc: unknown): unknown {
  if (vc === null || typeof vc !== 'object' || Array.isArray(vc)) return vc ?? null;
  const c = vc as Record<string, any>;
  const h = c.handshake;
  if (h === null || typeof h !== 'object' || !('verifyTokenEnc' in h)) return vc;
  const { verifyTokenEnc: _enc, ...rest } = h;
  return { ...c, handshake: { ...rest, verifyTokenSet: true } };
}
