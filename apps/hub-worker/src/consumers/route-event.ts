import { Prisma } from '@prisma/client';
import { TenantScopedRepository } from '@hub/database';
import { EventReceivedNotice, buildDeliveryMessage, logger } from '@hub/common';
import { unverifiedSkipped } from '../metrics';

/** Topic outbox cho chặng normalize → delivery (S1-2). Relay định tuyến theo TOPIC_ROUTES. */
export const DELIVERY_REQUESTED_TOPIC = 'delivery.requested';

/**
 * Định tuyến MỘT event đã ghi tới các subscription khớp: delivery PENDING + outbox `delivery.requested` trong CÙNG transaction
 * của người gọi (S1-2, outbox pattern). ĐƯỜNG DUY NHẤT — dùng chung cho event chuẩn hoá từ provider (`NormalizeConsumer`) và
 * event do chính hub phát (`hub.*`, QT4b `emitHubEvent`): không có đường gửi riêng, không có `if` trong lõi.
 * S6 (ADR-040): đích webhook chưa VERIFIED không nhận sự kiện.
 */
export async function routeEventToSubscriptions(
  tx: Prisma.TransactionClient,
  repoTx: TenantScopedRepository,
  tenantId: string,
  /** PK5 khoá 4: `verified: false` -> chỉ subscription `acceptUnverified`. Vắng = true (event của hub, dữ liệu cũ). */
  evt: { id: string; type: string; sourceId: string | null; correlationId: string; verified?: boolean; traceparent?: string },
  log: Pick<typeof logger, 'info'> = logger,
): Promise<EventReceivedNotice['deliveries']> {
  const routed: EventReceivedNotice['deliveries'] = [];
  const subscriptions = await repoTx.findActiveSubscriptionsForEvent(evt.type, evt.sourceId ?? null);
  log.info({ eventType: evt.type, subscriptionCount: subscriptions.length }, 'Tìm thấy subscriptions phù hợp');
  for (const sub of subscriptions) {
    // PK5 khoá 4 (§7.1, ADR-206): sự kiện CHƯA xác thực chỉ tới đích đã tự đồng ý — không tạo delivery, đếm metric.
    if (evt.verified === false && (sub as { acceptUnverified?: boolean }).acceptUnverified !== true) {
      unverifiedSkipped.inc();
      log.info({ subscriptionId: sub.id }, 'Bỏ qua subscription không nhận sự kiện chưa xác thực (acceptUnverified=false)');
      continue;
    }
    const dest = sub.destination as { type?: string; verification?: string } | undefined;
    if (dest?.type === 'webhook' && dest.verification && dest.verification !== 'VERIFIED') {
      log.info({ subscriptionId: sub.id, destinationId: sub.destinationId, verification: dest.verification }, 'Bỏ qua đích webhook chưa VERIFIED');
      continue;
    }
    const delivery = await repoTx.createDelivery({ eventId: evt.id, subscriptionId: sub.id, attemptGeneration: 1, status: 'PENDING' });
    // Outbox không mang tenant_id (hạ tầng xuyên tenant) — payload chỉ là tham chiếu (S1-1) + gợi ý gate BP2 (ADR-196).
    // MỘT chỗ điền cho cả event chuẩn hoá lẫn event `hub.*` (emitHubEvent) — SPEC-BP C1.
    const rps = (sub.destination as { rateLimitRps?: number } | undefined)?.rateLimitRps;
    await tx.outbox.create({
      data: {
        topic: DELIVERY_REQUESTED_TOPIC,
        payload: {
          ...buildDeliveryMessage({
            deliveryId: delivery.id,
            tenantId,
            attemptGeneration: 1,
            attemptCount: 0,
            correlationId: String(evt.correlationId),
            destinationId: sub.destinationId ?? sub.destination?.id,
            rateLimitRps: rps ?? undefined,
          }),
          // LOGGING.md §4: ngữ cảnh trace của chặng normalize nằm trong JSON của outbox; relay đưa nó vào HEADER AMQP và BỎ khỏi
          // body — message delivery trên dây vẫn đúng 7 khoá (S1-1). Event `hub.*` (emitHubEvent) không có -> không thêm.
          ...(evt.traceparent ? { traceparent: evt.traceparent } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    routed.push({
      deliveryId: delivery.id,
      eventId: evt.id,
      destinationId: sub.destination?.id ?? sub.destinationId,
      destinationName: sub.destination?.name ?? '',
      destinationType: sub.destination?.type ?? '',
    });
  }
  return routed;
}
