import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { EXCHANGES, ROUTING_KEYS } from '@hub/messaging';
import { logger } from '@hub/common';
import * as amqp from 'amqplib';

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
    this.timer = setTimeout(() => this.pollAndPublish(), interval);
  }

  private async pollAndPublish() {
    if (!this.isRunning) return;

    try {
      if (!this.channel) {
        this.scheduleNext();
        return;
      }

      // Đọc outbox với FOR UPDATE SKIP LOCKED
      // Dùng raw query để đảm bảo chính xác ngữ nghĩa SKIP LOCKED của PostgreSQL
      const unpulished: Array<{ id: bigint; topic: string; payload: any }> = await this.prisma.$queryRaw`
        SELECT id, topic, payload
        FROM hub.outbox
        WHERE published_at IS NULL
        ORDER BY id ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED;
      `;

      if (unpulished.length > 0) {
        logger.debug({ count: unpulished.length }, 'Outbox Relay tìm thấy messages cần publish');

        for (const item of unpulished) {
          const payloadBuffer = Buffer.from(JSON.stringify(item.payload));
          const isReplay = item.topic === 'delivery.replayed';
          const targetExchange = isReplay ? EXCHANGES.DELIVERY : EXCHANGES.EVENTS;
          const targetRoutingKey = isReplay ? ROUTING_KEYS.DELIVER : ROUTING_KEYS.EVENT_RECEIVED;

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

          // Đánh dấu published_at = now()
          await this.prisma.$executeRaw`
            UPDATE hub.outbox
            SET published_at = now()
            WHERE id = ${item.id};
          `;
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lỗi trong chu kỳ Outbox Relay');
    } finally {
      this.scheduleNext();
    }
  }
}
