import { Injectable } from '@nestjs/common';
import { PrismaService, DEV_MASTER_KEY } from '@hub/database';
import { ProviderRegistry } from '@hub/providers';
import { EXCHANGES, ROUTING_KEYS } from '@hub/messaging';
import { logger, OutboxPayload, NormalizedEvent, DeliveryMessage } from '@hub/common';
import { aesGcmDecrypt } from '@hub/crypto';
import * as amqp from 'amqplib';
import Redis from 'ioredis';

@Injectable()
export class NormalizeConsumer {
  private redisPub: Redis;

  constructor(private readonly prisma: PrismaService) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl, { lazyConnect: true });
    this.redisPub.connect().catch(() => {});
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
      // 1. Kiểm tra idempotency 5 chốt (§5.2): processed_messages
      const alreadyProcessed = await this.prisma.processedMessage.findUnique({
        where: {
          consumer_messageId: {
            consumer: 'normalize',
            messageId: rawEventId,
          },
        },
      });

      if (alreadyProcessed) {
        log.info('Message đã được normalize trước đó (processed_messages hit), bỏ qua');
        channel.ack(msg);
        return;
      }

      // 2. Nạp raw_event từ DB
      const rawEvent = await this.prisma.rawEvent.findUnique({
        where: { id: rawEventId },
      });

      if (!rawEvent) {
        log.warn('Không tìm thấy raw_event trong database');
        channel.ack(msg);
        return;
      }

      // 3. Adapter chuẩn hóa (Normalize)
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
        },
      );

      // 4. Nạp subscriptions và tạo deliveries trong Transaction
      const masterKey = process.env.MASTER_KEY || DEV_MASTER_KEY;
      const deliveriesToPublish: DeliveryMessage[] = [];

      await this.prisma.$transaction(async (tx) => {
        for (const evt of normalizedEvents) {
          // Lưu Event
          await tx.event.create({
            data: {
              id: evt.id,
              tenantId: evt.tenantId,
              rawEventId: evt.rawEventId,
              idempotencyKey: evt.id,
              correlationId: evt.correlationId,
              type: evt.type,
              source: evt.source,
              subject: evt.subject,
              data: evt.data,
              origin: evt.origin,
              occurredAt: new Date(evt.occurredAt),
              receivedAt: new Date(evt.receivedAt),
            },
          });

          // Tìm các subscriptions phù hợp với type này
          const subscriptions = await tx.subscription.findMany({
            where: {
              tenantId,
              isActive: true,
              eventTypes: { has: evt.type },
            },
            include: { destination: true },
          });

          log.info({ eventType: evt.type, subscriptionCount: subscriptions.length }, 'Tìm thấy subscriptions phù hợp');

          // Tạo Delivery cho từng subscription
          for (const sub of subscriptions) {
            const delivery = await tx.delivery.create({
              data: {
                tenantId,
                eventId: evt.id,
                subscriptionId: sub.id,
                attemptGeneration: 1,
                status: 'PENDING',
              },
            });

            // Giải mã cấu hình destination
            let destConfig = {};
            try {
              destConfig = JSON.parse(aesGcmDecrypt(sub.destination.configEncrypted, masterKey));
            } catch (err) {
              log.error({ err }, 'Không thể giải mã config của destination');
            }

            let signingSecret: string | undefined;
            if (sub.destination.signingSecretEncrypted) {
              try {
                signingSecret = aesGcmDecrypt(sub.destination.signingSecretEncrypted, masterKey);
              } catch {}
            }

            deliveriesToPublish.push({
              deliveryId: delivery.id,
              tenantId,
              eventId: evt.id,
              subscriptionId: sub.id,
              destinationId: sub.destination.id,
              destinationType: sub.destination.type as any,
              config: destConfig,
              signingSecret,
              event: evt,
              attemptCount: 0,
              attemptGeneration: 1,
              correlationId,
            });
          }
        }

        // Đánh dấu processed_messages
        await tx.processedMessage.create({
          data: {
            consumer: 'normalize',
            messageId: rawEventId,
          },
        });
      });

      // 5. Publish các delivery sang RabbitMQ x.hub.delivery
      for (const item of deliveriesToPublish) {
        channel.publish(
          EXCHANGES.DELIVERY,
          ROUTING_KEYS.DELIVER,
          Buffer.from(JSON.stringify(item)),
          {
            persistent: true,
            headers: { 'x-correlation-id': correlationId },
          },
        );
      }

      // 6. Phát sự kiện realtime sang Redis Pub/Sub
      for (const evt of normalizedEvents) {
        this.redisPub.publish('hub:realtime:events', JSON.stringify(evt)).catch(() => {});
      }

      // Xác nhận xử lý xong
      channel.ack(msg);
      log.info('Normalize & Route hoàn thành thành công');
    } catch (err: any) {
      log.error({ err: err.message }, 'Lỗi trong NormalizeConsumer');
      // Đẩy vào DLQ nếu lỗi không thể hồi phục
      channel.nack(msg, false, false);
    }
  }
}
