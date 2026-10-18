/**
 * SPEC-auth §5.2 + UA22: không log nào chứa mật khẩu, token, cookie phiên, API key thô.
 * Hai lớp: (1) pino `redact` theo tên khoá; (2) `scrubSecrets` quét CHUỖI (thông điệp log, lỗi) vì
 * bí mật có thể nằm giữa câu chữ, nơi redact theo khoá không với tới.
 */
const SECRET_KEYS = ['password', 'currentPassword', 'newPassword', 'token', 'refreshToken', 'accessToken', 'ticket', 'code_verifier', 'codeVerifier',
  // KN2 (SPEC-ket-noi §4.3 điều 3): credentials của connector provider (PayOS, Stripe…) không bao giờ vào log.
  'credentials', 'apiKey', 'clientId', 'checksumKey', 'secretKey'];

export const LOG_REDACT_OPTIONS = {
  paths: [
    'headers.authorization',
    'headers.cookie',
    'headers["x-api-key"]',
    'headers["proxy-authorization"]',
    'headers["x-csrf-token"]',
    'headers["set-cookie"]',
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.headers["proxy-authorization"]',
    'req.headers["x-csrf-token"]',
    ...SECRET_KEYS,
    ...SECRET_KEYS.map((k) => `*.${k}`),
  ],
  censor: '***',
};

const PATTERNS: [RegExp, string][] = [
  [/\bhk_(live|test)_[A-Za-z0-9_-]{8,}/g, 'hk_$1_***'],
  // LOGGING.md §5: signing secret của endpoint (`whsec_…`) không bao giờ vào log.
  [/\bwhsec_[A-Za-z0-9+/=_-]{6,}/g, 'whsec_***'],
  [/(__Host-hub_(?:at|rt|oauth)=)[^;\s"]+/g, '$1***'],
  [/(hub_csrf=)[^;\s"]+/g, '$1***'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***'],
];

export function scrubSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
