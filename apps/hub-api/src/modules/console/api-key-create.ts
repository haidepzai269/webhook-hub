import { PrismaService, TenantScopedRepository } from '@hub/database';

export interface ApiKeyCreateData {
  serviceName: string;
  scopes: string[];
  readTypes: string[];
  keyHash: string;
  keyPrefix: string;
  actor: string;
}

/**
 * Tạo API key + audit `api_key.created` trong CÙNG transaction (ADR-050). Trả bản công khai (không hash).
 */
export async function createApiKeyWithSource(prisma: PrismaService, projectId: string, d: ApiKeyCreateData) {
  return prisma.$transaction(async (tx) => {
    const repo = new TenantScopedRepository(tx, projectId);
    const key = await repo.createApiKey({
      serviceName: d.serviceName,
      keyHash: d.keyHash,
      keyPrefix: d.keyPrefix,
      scopes: d.scopes,
      readTypes: d.readTypes,
    });
    await repo.createAuditLog({
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: key.id,
      actor: d.actor,
      metadata: { serviceName: d.serviceName, scopes: d.scopes, keyPrefix: d.keyPrefix },
    });
    return {
      id: key.id,
      serviceName: key.serviceName,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      readTypes: key.readTypes,
      sourceId: key.sourceId,
      createdAt: key.createdAt,
    };
  });
}
