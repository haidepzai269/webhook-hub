import { eventTypeCandidates } from '@hub/common';
import { TenantScopedRepository } from '@hub/database';
import { Prisma, PrismaClient } from '@prisma/client';

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

/**
 * Truy vấn CHỈ ĐỌC của Event Flow (SPEC-event-flow-ui §3).
 *
 * Là MỘT `TenantScopedRepository` (kế thừa: constructor đòi tenantId, BB-5) — viết ở module `flow`
 * thay vì sửa `libs/database/src/tenant-scoped.repository.ts` vì agent đa service đang sửa file đó
 * (ADR nháp EF-2). Mọi câu ở đây lọc `tenant_id = this.tenantId` (hoặc `sources.tenant_id` với
 * raw_events, bảng không có cột tenant). Lúc merge có thể chuyển nguyên các hàm này vào repo gốc.
 */
export class FlowScopedRepository extends TenantScopedRepository {
  constructor(
    private readonly db: PrismaClientOrTx,
    tenantId: string,
  ) {
    super(db, tenantId);
  }

  /** Raw event theo id, scope qua source.tenantId. KHÔNG nạp `body_raw` (chỉ độ dài). */
  async findRawEventForFlow(id: string): Promise<FlowRawRow | null> {
    const rows = await this.db.$queryRaw<FlowRawRow[]>(Prisma.sql`
      SELECT r.id, r.status::text AS status, r.signature_valid AS "signatureValid", r.received_at AS "receivedAt",
             r.content_type AS "contentType", r.idempotency_key AS "idempotencyKey", r.headers, r.body,
             octet_length(r.body_raw) AS "bodyBytes",
             s.id AS "sourceId", s.name AS "sourceName", s.provider::text AS provider,
             EXISTS (SELECT 1 FROM hub.processed_messages p
                     WHERE p.consumer = 'normalize' AND p.message_id = r.id::text) AS "normalizeProcessed"
      FROM hub.raw_events r JOIN hub.sources s ON s.id = r.source_id
      WHERE r.id = ${id}::uuid AND s.tenant_id = ${this.tenantId}::uuid
    `);
    return rows[0] ?? null;
  }

  /** Event + mọi delivery (mọi generation) + attempt + subscription + đích (chỉ trường an toàn). */
  async findEventForFlow(where: { id: string } | { rawEventId: string }) {
    return this.db.event.findFirst({
      where: { ...where, tenantId: this.tenantId },
      include: {
        deliveries: {
          where: { tenantId: this.tenantId },
          include: {
            attempts: { orderBy: { attemptNo: 'asc' } },
            subscription: {
              select: {
                id: true,
                name: true,
                eventTypes: true,
                // KHÔNG đọc configEncrypted / signingSecretEncrypted (SPEC §3: secret không bao giờ ra UI).
                destination: { select: { id: true, name: true, type: true, circuitState: true, rateLimitRps: true } },
              },
            },
          },
        },
      },
    });
  }

  /** Subscription KHỚP kiểu nhưng đang tắt — để chặng "Định tuyến" nói rõ vì sao bị bỏ qua. */
  async findInactiveSubscriptionsMatching(eventType: string) {
    return this.db.subscription.findMany({
      where: { tenantId: this.tenantId, isActive: false, eventTypes: { hasSome: eventTypeCandidates(eventType) } },
      select: { id: true, name: true, eventTypes: true },
    });
  }
}

/**
 * Dựng repo flow từ `PrismaService`. `PrismaService.client` là private (BB-5: không ai gọi model trần),
 * nên lấy client mà `forTenant()` đã bọc — đúng client đó, không mở kết nối mới. Hết cần khi các hàm
 * trên được chuyển vào `TenantScopedRepository` lúc merge (ADR nháp EF-2).
 */
export function flowRepoFor(svc: { forTenant(tenantId: string): TenantScopedRepository }, tenantId: string): FlowScopedRepository {
  const base = svc.forTenant(tenantId) as unknown as { prisma: PrismaClientOrTx };
  return new FlowScopedRepository(base.prisma, tenantId);
}

export interface FlowRawRow {
  id: string;
  status: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
  signatureValid: boolean;
  receivedAt: Date;
  contentType: string | null;
  idempotencyKey: string;
  headers: Record<string, unknown> | null;
  body: unknown;
  bodyBytes: number | null;
  sourceId: string;
  sourceName: string;
  provider: string;
  normalizeProcessed: boolean;
}
