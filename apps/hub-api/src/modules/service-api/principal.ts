import { Request } from 'express';

/**
 * "Ai đang gọi" (SPEC-auth §2.1, DINH-CHINH X13). Người và máy dùng MỘT ngôn ngữ quyền (`@RequireScope`).
 * - `key`: service cầm `hk_*` (ApiKeyGuard, `/v1/p/*`);
 * - `user`: người đăng nhập console bằng cookie (SessionGuard, `/api/v1/*`, `/auth/*`). `tenantId`/`scopes`
 *   chỉ có sau khi guard phạm vi project chạy (AU3: scopes = ROLE_SCOPES[role]).
 */
export interface KeyPrincipal {
  kind: 'key';
  id: string;
  tenantId: string;
  scopes: string[];
  serviceName: string;
}

export interface UserPrincipal {
  kind: 'user';
  id: string;
  sessionId: string;
  email: string;
  name: string;
  isOperator: boolean;
  emailVerified: boolean;
  tenantId?: string;
  scopes?: string[];
}

export type Principal = KeyPrincipal | UserPrincipal;

export interface ApiKeyContext {
  id: string;
  tenantId: string;
  serviceName: string;
  scopes: string[];
  readTypes: string[];
  sourceId: string | null;
  project: { id: string; slug: string; name: string; environment: 'test' | 'live' };
}

export type RequestWithPrincipal = Request & {
  principal?: Principal;
  tenantId?: string;
  apiKey?: ApiKeyContext;
  cookies?: Record<string, string | undefined>;
};
