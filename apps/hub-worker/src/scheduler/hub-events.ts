import { randomUUID } from 'crypto';
import { ulid } from 'ulidx';
import { Prisma } from '@prisma/client';
import { TenantScopedRepository } from '@hub/database';
import { EventReceivedNotice, logger, validateCanonical } from '@hub/common';
import { routeEventToSubscriptions } from '../consumers/route-event';

/**
 * QT4b (SPEC-han-muc-dung-luong §5.6, ADR-187): event do CHÍNH hub phát (`hub.*`) đi ĐÚNG đường của mọi event — ghi `events`
 * rồi `routeEventToSubscriptions` (delivery PENDING + outbox `delivery.requested`) trong transaction của người gọi. Không
 * có đường gửi riêng, không có `if` trong lõi; destination nào đăng ký kiểu này thì nhận, polling cũng thấy.
 * `data` PHẢI đúng khuôn catalog (`hub.*` là không gian dành riêng) — sai thì ném, không ghi gì.
 * `source = 'hub'`, `sourceId = null` (không thuộc source nào — subscription lọc theo `sourceIds` sẽ không nhận).
 */
export async function emitHubEvent(
  tx: Prisma.TransactionClient,
  repoTx: TenantScopedRepository,
  tenantId: string,
  e: { type: string; data: Record<string, unknown>; subject?: string | null; now?: Date },
): Promise<{ eventId: string; deliveries: EventReceivedNotice['deliveries'] }> {
  const v = validateCanonical(e.type, e.data);
  if (!v.ok) throw new Error(`hub event ${e.type} sai khuôn catalog ở trường '${v.field}'`);
  const id = `evt_${ulid()}`;
  const now = e.now ?? new Date();
  const correlationId = randomUUID();
  await repoTx.createEvent({
    id,
    idempotencyKey: `hub:${id}`,
    correlationId,
    sourceId: null,
    rawEventId: null,
    type: e.type,
    source: 'hub',
    subject: e.subject ?? `project:${tenantId}`,
    data: e.data as Prisma.InputJsonValue,
    normalized: true,
    origin: 'derived',
    occurredAt: now,
    receivedAt: now,
  });
  const deliveries = await routeEventToSubscriptions(tx, repoTx, tenantId, { id, type: e.type, sourceId: null, correlationId }, logger);
  return { eventId: id, deliveries };
}
