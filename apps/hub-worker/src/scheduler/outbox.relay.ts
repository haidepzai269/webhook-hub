import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { EXCHANGES, ROUTING_KEYS } from '@hub/messaging';
import { logger } from '@hub/common';
import * as amqp from 'amqplib';

// Transaction giữ khoá FOR UPDATE ... SKIP LOCKED trong lúc publish lên RabbitMQ
// (publisher confirms có thể mất vài trăm ms tới vài giây khi batch lớn / broker chậm).
// Timeout phải đủ rộng để không tự rollback giữa chừng, nhưng vẫn hữu hạn để tránh
// giữ connection/lock vô thời hạn nếu channel treo.
const RELAY_TX_TIMEOUT_MS = 15_000;
const RELAY_TX_MAX_WAIT_MS = 5_000;

/**
 * Định tuyến outbox theo topic (S1-2) — một bảng, không thêm `if`. Chặng ingest → normalize đi
 * x.hub.events; chặng normalize → delivery (và replay) đi x.hub.delivery. Topic lạ rơi về EVENTS
 * như hành vi cũ.
 */
export const TOPIC_ROUTES: Record<string, { exchange: string; routingKey: string }> = {
  'event.received': { exchange: EXCHANGES.EVENTS, routingKey: ROUTING_KEYS.EVENT_RECEIVED },
  'delivery.requested': { exchange: EXCHANGES.DELIVERY, routingKey: ROUTING_KEYS.DELIVER },
  'delivery.replayed': { exchange: EXCHANGES.DELIVERY, routingKey: ROUTING_KEYS.DELIVER },
};
const DEFAULT_ROUTE = TOPIC_ROUTES['event.received'];

export function routeForTopic(topic: string) {
  return TOPIC_ROUTES[topic] ?? DEFAULT_ROUTE;
}

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private channel: amqp.ConfirmChannel | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  public setChannel(channel: amqp.ConfirmChannel) {
    this.channel = channel;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Outbox Relay đã khởi động (SKIP LOCKED)');
    this.scheduleNext();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext() {
    if (!this.isRunning) return;
    // Jitter ±20% quanh 500ms
    const jitter = Math.floor(Math.random() * 200) - 100;
    const interval = Math.max(200, 500 + jitter);
    // Luôn giữ đúng MỘT timer: lỡ có ai gọi trùng thì timer cũ bị huỷ, không sinh vòng lặp song song.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pollAndPublish(), interval);
  }

  private async pollAndPublish() {
    if (!this.isRunning) return;

    try {
      // Chưa có channel (đang thử kết nối AMQP): chỉ return — `finally` bên dưới lên lịch vòng sau.
      // Trước đây nhánh này TỰ gọi scheduleNext() rồi finally gọi thêm lần nữa -> số timer nhân đôi
      // mỗi 500ms -> worker OOM khi chờ broker vài chục giây (phát hiện khi kiểm S1-4 trên docker).
      if (!this.channel) {
        return;
      }

      // BB-3/BB-4 an toàn nhiều instance: SELECT FOR UPDATE SKIP LOCKED, publish, và
      // UPDATE published_at PHẢI nằm trong CÙNG một interactive transaction. Khoá row
      // (FOR UPDATE) chỉ tồn tại tới khi transaction chứa nó COMMIT/ROLLBACK — nếu SELECT
      // chạy như một statement rời (transaction ngầm), khoá nhả ngay sau SELECT và một
      // instance hub-worker khác chạy song song có thể SELECT trúng cùng batch chưa
      // publish, dẫn tới publish trùng lặp thật trên RabbitMQ. Không tách 3 bước này ra.
      const publishedCount = await this.prisma.$transaction(
        async (tx) => {
          // Đọc outbox với FOR UPDATE SKIP LOCKED
          // Dùng raw query để đảm bảo chính xác ngữ nghĩa SKIP LOCKED của PostgreSQL
          const unpulished: Array<{ id: bigint; topic: string; payload: any }> =
            await tx.$queryRawUnsafe(`
              SELECT id, topic, payload
              FROM hub.outbox
              WHERE published_at IS NULL
              ORDER BY id ASC
              LIMIT 50
              FOR UPDATE SKIP LOCKED;
            `);

          if (unpulished.length === 0) {
            return 0;
          }

          logger.debug({ count: unpulished.length }, 'Outbox Relay tìm thấy messages cần publish');

          for (const item of unpulished) {
            const payloadBuffer = Buffer.from(JSON.stringify(item.payload));
            const { exchange: targetExchange, routingKey: targetRoutingKey } = routeForTopic(item.topic);

            // Nếu publish throw (nack/return từ publisher confirm, hoặc lỗi channel),
            // để lỗi propagate ra ngoài callback này — Prisma sẽ tự ROLLBACK, khoá nhả,
            // và row outbox đó được publish lại ở lần poll sau (at-least-once, chấp nhận
            // được). KHÔNG catch rồi vẫn UPDATE published_at — đó là ACK giả cho publish
            // đã thất bại.
            await new Promise<void>((resolve, reject) => {
              this.channel!.publish(
                targetExchange,
                targetRoutingKey,
                payloadBuffer,
                {
                  persistent: true,
                  headers: {
                    'x-correlation-id': item.payload.correlationId,
                  },
                },
                (err) => {
                  if (err) reject(err);
                  else resolve();
                },
              );
            });

            // Đánh dấu published_at = now() — vẫn trong transaction tx, khoá row còn giữ
            await tx.$executeRaw`
              UPDATE hub.outbox
              SET published_at = now()
              WHERE id = ${item.id};
            `;
          }

          return unpulished.length;
        },
        {
          timeout: RELAY_TX_TIMEOUT_MS,
          maxWait: RELAY_TX_MAX_WAIT_MS,
        },
      );

      if (publishedCount > 0) {
        logger.debug({ count: publishedCount }, 'Outbox Relay đã publish xong batch');
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lỗi trong chu kỳ Outbox Relay');
    } finally {
      this.scheduleNext();
    }
  }
}
