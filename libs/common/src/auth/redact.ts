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

// Cơ sở của tối ưu khoá object < MIN_SECRET_MATCH_LEN ký tự bỏ qua scrubSecrets (logger.ts, ADR-256): mọi mẫu dưới đây khớp tối thiểu >= 8 ký tự.
// Thêm mẫu NGẮN (vd `sk_`) thì thêm mẫu vào PATTERN_MIN_SAMPLES; test `redact-min-match` đỏ nếu mẫu < 8 hoặc quên thêm mẫu.
export const MIN_SECRET_MATCH_LEN = 8;
export const PATTERN_MIN_SAMPLES: string[] = ['hk_live_AAAAAAAA', 'whsec_AAAAAA', '__Host-hub_at=A', 'hub_csrf=A', 'Bearer AAAAAAAA', 'sk-ant-AAAAAAAA', 'AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'session=AAAAAA'];
export const SECRET_PATTERN_COUNT = (): number => PATTERNS.length;
const PATTERNS: [RegExp, string][] = [
  [/\bhk_(live|test)_[A-Za-z0-9_-]{8,}/g, 'hk_$1_***'],
  // LOGGING.md §5: signing secret của endpoint (`whsec_…`) không bao giờ vào log.
  [/\bwhsec_[A-Za-z0-9+/=_-]{6,}/g, 'whsec_***'],
  [/(__Host-hub_(?:at|rt|oauth)=)[^;\s"]+/g, '$1***'],
  [/(hub_csrf=)[^;\s"]+/g, '$1***'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***'],
  // Khoá Anthropic, khoá Google API, cookie phiên dạng `session=<giá trị>` (Sentry web dùng chung bộ luật này).
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 'AIza***'],
  [/\b((?:session|sessionid|jsessionid|sid|connect\.sid)=)[^;\s"&]{6,}/gi, '$1***'],
];

export function scrubSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
