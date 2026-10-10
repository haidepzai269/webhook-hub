import { Injectable } from '@nestjs/common';
import { PrismaService, TenantScopedRepository } from '@hub/database';
import { ProviderRegistry } from '@hub/providers';
import { QUEUES } from '@hub/messaging';
import {
  logger,
  OutboxPayload,
  NormalizedEvent,
  buildDeliveryMessage,
  EventReceivedNotice,
  isReservedType,
  validateCanonical,
  fastFailRedisOptions,
} from '@hub/common';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import {
  NORMALIZE_MAX_RETRIES,
  NORMALIZE_RETRY_HEADER,
  classifyNormalizeError,
  readNormalizeRetryCount,
} from './normalize-errors';
import { normalizeRetries, normalizeSchemaErrors } from '../metrics';

/**
 * S3-2 (ADR-053): adapter phát kiểu thuộc không gian dành riêng (`payment.*`, `repo.*`) mà `data`
 * không qua validator catalog. Lỗi VĨNH VIỄN (ADR-044): không đẩy dữ liệu sai khuôn ra ngoài, không
 * âm thầm hạ xuống `normalized:false`. raw_event còn nguyên -> sửa adapter rồi renormalize.
 * `field` chỉ là TÊN trường, không bao giờ kèm giá trị.
 */
export class CanonicalSchemaError extends Error {
  constructor(readonly eventType: string, readonly field: string) {
    super(`Event kiểu '${eventType}' sai khuôn catalog ở trường '${field}'`);
    this.name = 'CanonicalSchemaError';
  }
}

/**
 * Chỗ DUY NHẤT lõi biết về catalog: kiểu dành riêng thì phải đúng khuôn. Không hỏi provider nào.
 * Ném `CanonicalSchemaError` ở event sai đầu tiên.
 */
export function assertCanonical(events: NormalizedEvent[], source: string): void {
  for (const evt of events) {
    if (!isReservedType(evt.type)) continue;
    const r = validateCanonical(evt.type, evt.data);
    if (!r.ok) {
      normalizeSchemaErrors.inc({ source });
      throw new CanonicalSchemaError(evt.type, r.field);
    }
  }
}

/** Topic outbox cho chặng normalize → delivery (S1-2). Relay định tuyến theo TOPIC_ROUTES. */
export const DELIVERY_REQUESTED_TOPIC = 'delivery.requested';

@Injectable()
export class NormalizeConsumer {
  private redisPub: Redis;
  /**
   * Tiêm lỗi để kiểm S1-3 trên docker: N lần xử lý đầu ném P1001 giả. CHỈ khi NODE_ENV !== 'production'
   * — trên môi trường thật biến này bị bỏ qua hoàn toàn.
   */
  private faultsLeft: number;

  constructor(private readonly prisma: PrismaService) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl, fastFailRedisOptions()); // MS-P2-3
    this.redisPub.on?.('error', (err) => logger.warn({ err: err.message }, 'Redis pub (normalize) lỗi'));
    this.redisPub.connect().catch(() => {});
    this.faultsLeft =
      process.env.NODE_ENV === 'production' ? 0 : Math.max(0, parseInt(process.env.NORMALIZE_FAULT_FIRST_N || '0', 10) || 0);
    if (this.faultsLeft > 0) {
      logger.warn({ faults: this.faultsLeft }, 'NORMALIZE_FAULT_FIRST_N bật: sẽ tiêm lỗi P1001 giả (chỉ để kiểm, không dùng production)');
    }
  }

  async handleMessage(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void> {
    const correlationId = msg.properties.headers?.['x-correlation-id'] || 'unknown';
    let payload: OutboxPayload;

    try {
      payload = JSON.parse(msg.content.toString());
    } catch (e: any) {
      logger.error({ err: e.message }, 'Lỗi parse JSON payload trong NormalizeConsumer -> chuyển DLQ');
      channel.nack(msg, false, false);
      return;
    }

    const { rawEventId, tenantId, sourceId, provider } = payload;
    const log = logger.child({ correlationId, rawEventId, provider });

    try {
      this.maybeInjectFault();

      // 1. Idempotency (§5.2): processed_messages
      const alreadyProcessed = await this.prisma.processedMessage.findUnique({
        where: { consumer_messageId: { consumer: 'normalize', messageId: rawEventId } },
      });
      if (alreadyProcessed) {
        log.info('Message đã được normalize trước đó (processed_messages hit), bỏ qua');
        channel.ack(msg);
        return;
      }

      // 2. Nạp raw_event QUA REPO đã scope tenant (S1-5, BB-5): raw event của tenant khác không đọc được.
      const repo = this.prisma.forTenant(tenantId);
      const rawEvent = await repo.findRawEventById(rawEventId);
      if (!rawEvent) {
        log.warn('Không tìm thấy raw_event (hoặc không thuộc tenant trong message)');
        channel.ack(msg);
        return;
      }

      // 3. Adapter chuẩn hoá
      const adapter = ProviderRegistry.get(provider);
      const normalizedEvents: NormalizedEvent[] = adapter.normalize(
        {
          provider,
          sourceKey: '',
          headers: rawEvent.headers as any,
          rawBody: Buffer.from(rawEvent.bodyRaw),
          body: rawEvent.body,
          contentType: rawEvent.contentType || undefined,
        },
        {
          tenantId,
          sourceId,
          correlationId,
          rawEventId,
          // Review SPEC-3 #4: thời gian dự phòng = lúc hub NHẬN, không phải lúc normalize -> renormalize ổn định.
          receivedAt: rawEvent.receivedAt ? new Date(rawEvent.receivedAt).toISOString() : undefined,
          // S8: cấu hình riêng của source (GenericAdapter) — lõi chỉ chuyển qua.
          verificationConfig: (rawEvent as { source?: { verificationConfig?: unknown } }).source?.verificationConfig ?? undefined,
        },
      );
      // 3b. Kiểu dành riêng phải đúng khuôn — kiểm TRƯỚC transaction: sai thì không có dòng nào.
      assertCanonical(normalizedEvents, provider);

      // 4. Event + delivery + outbox `delivery.requested` + processed_messages trong MỘT transaction (S1-2).
      // Không còn publish thẳng sau COMMIT: hoặc tất cả cùng COMMIT, hoặc không có gì — relay lo phần gửi.
      const routed: EventReceivedNotice['deliveries'] = [];
      await this.prisma.$transaction(async (tx) => {
        routed.length = 0; // phòng khi callback bị gọi lại
        const repoTx = new TenantScopedRepository(tx, tenantId);

        for (const evt of normalizedEvents) {
          await repoTx.createEvent({
            id: evt.id,
            rawEventId: evt.rawEventId,
            idempotencyKey: evt.id,
            correlationId: evt.correlationId,
            sourceId, // S5: lọc subscription theo sourceIds + polling biết nguồn
            type: evt.type,
            source: evt.source,
            subject: evt.subject,
            data: evt.data,
            normalized: evt.normalized !== false,
            origin: evt.origin,
            occurredAt: new Date(evt.occurredAt),
            receivedAt: new Date(evt.receivedAt),
          });

          const subscriptions = await repoTx.findActiveSubscriptionsForEvent(evt.type, sourceId ?? null);
          log.info({ eventType: evt.type, subscriptionCount: subscriptions.length }, 'Tìm thấy subscriptions phù hợp');

          for (const sub of subscriptions) {
            // S6 (SPEC §4.6, ADR-040): endpoint chưa chứng minh sở hữu (challenge) thì KHÔNG nhận sự kiện —
            // không ghi delivery nào. Telegram/Discord/đích cũ mặc định VERIFIED.
            const dest = sub.destination as { type?: string; verification?: string } | undefined;
            if (dest?.type === 'webhook' && dest.verification && dest.verification !== 'VERIFIED') {
              log.info({ subscriptionId: sub.id, destinationId: sub.destinationId, verification: dest.verification }, 'Bỏ qua đích webhook chưa VERIFIED');
              continue;
            }
            const delivery = await repoTx.createDelivery({
              eventId: evt.id,
              subscriptionId: sub.id,
              attemptGeneration: 1,
              status: 'PENDING',
            });
            // Outbox không mang tenant_id (hạ tầng xuyên tenant) — payload chỉ là tham chiếu (S1-1).
            await tx.outbox.create({
              data: {
                topic: DELIVERY_REQUESTED_TOPIC,
                payload: buildDeliveryMessage({
                  deliveryId: delivery.id,
                  tenantId,
                  attemptGeneration: 1,
                  attemptCount: 0,
                  correlationId: String(correlationId),
                }) as unknown as Prisma.InputJsonValue,
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
        }

        await tx.processedMessage.create({ data: { consumer: 'normalize', messageId: rawEventId } });
      });

      // 5. Realtime (best-effort, Redis được phép sai). S2-2: MỘT publish cho mỗi raw event (gộp mảng)
      // để giữ ngân sách Redis; mang đủ N nhánh (đích) để dashboard vẽ "toả ra" ngay.
      const routedCount = routed.length;
      if (normalizedEvents.length > 0) {
        const notice: EventReceivedNotice = {
          tenantId,
          correlationId: String(correlationId),
          rawEventId,
          events: normalizedEvents.map((e) => ({ id: e.id, type: e.type, source: e.source })),
          deliveries: routed,
        };
        this.redisPub.publish('hub:realtime:events', JSON.stringify(notice)).catch(() => {});
      }

      channel.ack(msg);
      log.info({ deliveryCount: routedCount }, 'Normalize & Route hoàn thành (delivery đi qua outbox)');
    } catch (err: any) {
      this.handleFailure(err, msg, channel, log);
    }
  }

  /** S1-3: lỗi tạm -> hàng đợi 30s (tối đa 5 lần); lỗi dữ liệu hoặc hết lượt -> DLQ. */
  private handleFailure(err: any, msg: amqp.ConsumeMessage, channel: amqp.Channel, log: typeof logger) {
    const kind = classifyNormalizeError(err);
    const retries = readNormalizeRetryCount(msg.properties.headers);

    if (kind === 'transient' && retries < NORMALIZE_MAX_RETRIES) {
      log.warn(
        { err: err?.message, code: err?.code, [NORMALIZE_RETRY_HEADER]: retries + 1 },
        'Lỗi tạm ở normalize -> q.normalize.retry.30s',
      );
      normalizeRetries.inc();
      channel.sendToQueue(QUEUES.NORMALIZE_RETRY, msg.content, {
        persistent: true,
        headers: { ...(msg.properties.headers || {}), [NORMALIZE_RETRY_HEADER]: retries + 1 },
      });
      channel.ack(msg);
      return;
    }

    log.error(
      { err: err?.message, code: err?.code, kind, retries, ...(err instanceof CanonicalSchemaError ? { eventType: err.eventType, field: err.field } : {}) },
      kind === 'transient' ? 'Lỗi tạm ở normalize đã hết lượt thử lại -> DLQ' : 'Lỗi dữ liệu ở normalize -> DLQ',
    );
    channel.nack(msg, false, false);
  }

  private maybeInjectFault() {
    if (this.faultsLeft <= 0) return;
    this.faultsLeft--;
    throw new Prisma.PrismaClientKnownRequestError('NORMALIZE_FAULT_FIRST_N: lỗi P1001 giả (tiêm để kiểm)', {
      code: 'P1001',
      clientVersion: Prisma.prismaVersion?.client ?? 'fault-injection',
    });
  }
}
