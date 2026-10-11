import { ConnectorSpec } from './provider.interface';

/**
 * KN2 (SPEC-ket-noi §4.5): base URL mà connector gọi — LUÔN truyền tường minh, không để SDK tự đọc env (SDK PayOS đọc
 * `PAYOS_BASE_URL`: production lỡ có biến đó là credentials thật bay tới host lạ).
 * - production: luôn `spec.defaultBaseUrl` (cứng trong connector), mọi biến env bị bỏ qua;
 * - ngoài production: `spec.fakeBaseUrlEnv` (vd `PAYOS_FAKE_BASE_URL` -> fake provider trong sink) nếu có.
 * Production mà đặt biến `*_FAKE_BASE_URL` thì app không khởi động (`testOnlyConfigProblems`).
 * Mẫu của `loadGoogleConfig` (google-oauth.service.ts:32).
 */
export function connectorBaseUrl(spec: Pick<ConnectorSpec, 'defaultBaseUrl' | 'fakeBaseUrlEnv'>, env: Record<string, string | undefined> = process.env): string {
  const fake = env.NODE_ENV === 'production' ? '' : (env[spec.fakeBaseUrlEnv] ?? '').trim().replace(/\/$/, '');
  return fake || spec.defaultBaseUrl;
}
