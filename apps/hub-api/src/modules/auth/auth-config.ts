/**
 * SPEC-auth §7: cấu hình phiên đăng nhập. Đọc process.env trực tiếp (cùng lý do JwtModule ở auth.module.ts:
 * decorator tĩnh chạy trước @nestjs/config). Bí mật bị kiểm lúc bootstrap (`authSecretProblems`).
 */
export interface AuthConfig {
  jwtSecret: string;
  csrfSecret: string;
  socketTicketSecret: string;
  oauthCookieSecret: string;
  accessTtlS: number;
  refreshIdleDays: number;
  refreshAbsoluteDays: number;
  webPublicUrl: string;
  trustProxy: boolean;
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

const SECRET_VARS = ['JWT_SECRET', 'CSRF_SECRET', 'SOCKET_TICKET_SECRET', 'OAUTH_COOKIE_SECRET'] as const;

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  return {
    jwtSecret: env.JWT_SECRET ?? '',
    csrfSecret: env.CSRF_SECRET ?? '',
    socketTicketSecret: env.SOCKET_TICKET_SECRET ?? '',
    oauthCookieSecret: env.OAUTH_COOKIE_SECRET ?? '',
    accessTtlS: int(env.JWT_ACCESS_TTL_S, 900, 60, 3600),
    refreshIdleDays: int(env.REFRESH_IDLE_DAYS, 7, 1, 30),
    refreshAbsoluteDays: int(env.REFRESH_ABSOLUTE_DAYS, 30, 1, 365),
    webPublicUrl: (env.WEB_PUBLIC_URL ?? '').trim().replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === '1',
  };
}

/** Mỗi secret ≥ 32 ký tự và đôi một KHÁC nhau (lộ một cái không kéo theo cái khác). Không in giá trị. */
export function authSecretProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  for (const k of SECRET_VARS) {
    const v = env[k] ?? '';
    if (v.length < 32) problems.push(`${k} thiếu hoặc < 32 ký tự`);
  }
  const values = SECRET_VARS.map((k) => env[k] ?? '').filter((v) => v.length >= 32);
  if (new Set(values).size !== values.length) problems.push(`${SECRET_VARS.join(', ')} phải khác nhau`);
  return problems;
}
