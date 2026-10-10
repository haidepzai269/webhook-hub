import { Request } from 'express';

/**
 * "Ai đang gọi" (SPEC-auth §2.1, DINH-CHINH X13). Đa service chỉ có nhánh `key`; AU3 thêm `user` và dùng
 * chung `@RequireScope` cho cả hai.
 */
export interface KeyPrincipal {
  kind: 'key';
  id: string;
  tenantId: string;
  scopes: string[];
  serviceName: string;
}

export type Principal = KeyPrincipal;

export interface ApiKeyContext {
  id: string;
  tenantId: string;
  serviceName: string;
  scopes: string[];
  readTypes: string[];
  sourceId: string | null;
  project: { id: string; slug: string; name: string; environment: 'test' | 'live' };
}

export type RequestWithPrincipal = Request & { principal?: Principal; tenantId?: string; apiKey?: ApiKeyContext };
