import { PrismaClient } from '@prisma/client';
import { TenantScopedRepository } from './tenant-scoped.repository';

export class PrismaService extends PrismaClient {
  private static instance: PrismaService;

  constructor() {
    super({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }

  public static getInstance(): PrismaService {
    if (!PrismaService.instance) {
      PrismaService.instance = new PrismaService();
    }
    return PrismaService.instance;
  }

  /**
   * Tạo repository được bảo vệ theo Tenant (BB-5)
   */
  public forTenant(tenantId: string): TenantScopedRepository {
    return new TenantScopedRepository(this, tenantId);
  }
}

export const prisma = PrismaService.getInstance();
