import { createHash, randomBytes } from 'crypto';

/**
 * API key của service (S1/S2, ADR-038/039). Dùng chung cho hub-api (tạo, ApiKeyGuard) và seed.
 *
 * Định dạng `hk_<env>_<43 ký tự base64url>` (32 byte ngẫu nhiên = 256 bit). DB chỉ giữ sha256 (hex) —
 * key có entropy 256 bit nên không cần bcrypt/argon2 (không đoán ngược được bằng từ điển), và tra theo
 * hash là một truy vấn index thay vì so từng dòng.
 */
export const API_SCOPES = ['publish:events', 'read:events', 'manage:endpoints', 'manage:sources'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export type ProjectEnvironment = 'test' | 'live';

export const API_KEY_RE = /^hk_(test|live)_[A-Za-z0-9_-]{43}$/;
export const API_KEY_PREFIX_LENGTH = 12;

export function isApiScope(s: unknown): s is ApiScope {
  return typeof s === 'string' && (API_SCOPES as readonly string[]).includes(s);
}

export function generateApiKey(env: ProjectEnvironment): string {
  return `hk_${env}_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** 12 ký tự đầu (`hk_test_AbCd`) — đủ để người nhận ra key nào, không đủ để dùng. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

/**
 * `hubs://<key>@<host>/<slug>` (https) hoặc `hub://…` (http, local). `publicUrl` = HUB_PUBLIC_URL.
 * Host giữ cả cổng (`localhost:4000`).
 */
export function buildConnectionString(publicUrl: string, key: string, projectSlug: string): string {
  const u = new URL(publicUrl);
  const scheme = u.protocol === 'https:' ? 'hubs' : 'hub';
  return `${scheme}://${key}@${u.host}/${projectSlug}`;
}

/** Slug project: chữ thường/số/gạch, 3–63 ký tự, không bắt đầu bằng gạch. */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
