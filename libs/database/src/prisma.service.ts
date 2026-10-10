import { PrismaClient, Prisma } from '@prisma/client';
import { TenantScopedRepository } from './tenant-scoped.repository';

/**
 * PrismaService — COMPOSITION, không `extends PrismaClient` (BB-5).
 *
 * Lý do đổi từ kế thừa sang bọc (wrap): `extends PrismaClient` khiến
 * `this.prisma.source/destination/subscription/event/delivery` public và gọi
 * thẳng được ở bất cứ đâu, bỏ qua `TenantScopedRepository` — 5 bảng nghiệp vụ
 * mang `tenant_id` (Source, Destination, Subscription, Event, Delivery) BẮT BUỘC
 * phải đi qua `forTenant(tenantId)`.
 *
 * Các bảng KHÔNG mang `tenant_id` (hạ tầng xuyên-tenant hoặc tenant CHƯA XÁC ĐỊNH)
 * vẫn được expose trực tiếp qua getter riêng để code ingest/relay/normalize hiện
 * tại không phải đổi tên gọi:
 *   - rawEvent          : bước ingest CHƯA biết tenant (đang đi tìm source).
 *   - outbox            : outbox relay đọc xuyên tenant (SKIP LOCKED).
 *   - processedMessage  : idempotency theo consumer, không có cột tenant_id.
 *   - deliveryAttempt   : log con của delivery (FK deliveryId), không tự mang tenant_id.
 */
export class PrismaService {
  private static instance: PrismaService;

  private readonly client: PrismaClient;

  constructor() {
    this.client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }

  public static getInstance(): PrismaService {
    if (!PrismaService.instance) {
      PrismaService.instance = new PrismaService();
    }
    return PrismaService.instance;
  }

  // ================== Hạ tầng Prisma (uỷ quyền sang client gốc) ==================

  public $transaction<P extends Prisma.PrismaPromise<any>[]>(
    arg: [...P],
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<any>;
  public $transaction<R>(
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<R>;
  public $transaction(arg: any, options?: any): Promise<any> {
    return this.client.$transaction(arg, options);
  }

  public $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Promise<T> {
    return (this.client.$queryRaw as any)(query, ...values);
  }

  public $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T> {
    return this.client.$queryRawUnsafe<T>(query, ...values);
  }

  public $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Promise<number> {
    return (this.client.$executeRaw as any)(query, ...values);
  }

  public $executeRawUnsafe(query: string, ...values: any[]): Promise<number> {
    return this.client.$executeRawUnsafe(query, ...values);
  }

  public $connect(): Promise<void> {
    return this.client.$connect();
  }

  public $disconnect(): Promise<void> {
    return this.client.$disconnect();
  }

  // ================== Models KHÔNG cần scope tenant ==================

  public get rawEvent() {
    return this.client.rawEvent;
  }

  public get outbox() {
    return this.client.outbox;
  }

  public get processedMessage() {
    return this.client.processedMessage;
  }

  public get deliveryAttempt() {
    return this.client.deliveryAttempt;
  }

  /**
   * Escape hatch DUY NHẤT cho bước ingest xác định tenant: tra `source` theo
   * `sourceKey` TRƯỚC khi biết tenant là ai — chính bước này tìm ra tenant, nên
   * không thể đi qua `TenantScopedRepository`. KHÔNG dùng hàm này ở nơi khác.
   */
  public findSourceBySourceKeyForIngest(sourceKey: string) {
    return this.client.source.findUnique({
      where: { sourceKey },
      include: {
        secrets: {
          where: {
            OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
          },
        },
      },
    });
  }

  /**
   * Tạo repository được bảo vệ theo Tenant (BB-5). `client` mặc định là
   * PrismaClient gốc, nhưng có thể truyền `tx` (Prisma.TransactionClient) khi
   * cần dùng repo BÊN TRONG một `$transaction` interactive đã biết tenant.
   */
  public forTenant(
    tenantId: string,
    client: PrismaClient | Prisma.TransactionClient = this.client,
  ): TenantScopedRepository {
    return new TenantScopedRepository(client, tenantId);
  }
}

export const prisma = PrismaService.getInstance();
