import { outboxLag } from '../metrics';
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
 * Review SPEC-3 #3: số dòng mỗi lượt. Lượt lấy ĐẦY lô thì chạy lượt kế ngay (không ngủ 500ms) —
 * backlog xả theo tốc độ broker/DB, không theo nhịp poll. Lô rỗng/lẻ thì quay về nhịp ~500ms.
 */
export const RELAY_BATCH = 200;

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

  private scheduleNext(immediate = false) {
    if (!this.isRunning) return;
    // Jitter ±20% quanh 500ms; lô vừa rồi đầy -> chạy ngay (vẫn qua setTimeout 0 để không đệ quy sâu).
    const jitter = Math.floor(Math.random() * 200) - 100;
    const interval = immediate ? 0 : Math.max(200, 500 + jitter);
    // Luôn giữ đúng MỘT timer: lỡ có ai gọi trùng thì timer cũ bị huỷ, không sinh vòng lặp song song.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pollAndPublish(), interval);
  }

  private async pollAndPublish() {
    if (!this.isRunning) return;
    let full = false;

    try {
      // Chưa có channel (đang thử kết nối AMQP): chỉ return — `finally` bên dưới lên lịch vòng sau.
      // Trước đây nhánh này TỰ gọi scheduleNext() rồi finally gọi thêm lần nữa -> số timer nhân đôi
      // mỗi 500ms -> worker OOM khi chờ broker vài chục giây (phát hiện khi kiểm S1-4 trên docker).
      if (!this.channel) {
        return;
      }
      const publishedCount = await this.relayBatch(this.channel);
      full = publishedCount >= RELAY_BATCH;
      if (publishedCount > 0) {
        logger.debug({ count: publishedCount, full }, 'Outbox Relay đã publish xong batch');
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Lỗi trong chu kỳ Outbox Relay');
    } finally {
      this.scheduleNext(full);
    }
  }

  /**
   * MỘT lượt relay (review SPEC-3 #3). BB-3/BB-4 an toàn nhiều instance: SELECT FOR UPDATE SKIP LOCKED,
   * publish và UPDATE published_at nằm trong CÙNG một interactive transaction — khoá dòng giữ tới khi
   * COMMIT, instance khác bỏ qua các dòng này. Khác bản cũ:
   * - publish cả lô KHÔNG chờ từng confirm, rồi chờ confirm THEO LÔ (Promise.all các callback);
   * - một câu UPDATE `id = ANY($1)` thay cho N câu.
   * Bất kỳ publish nào bị nack/lỗi -> ném -> ROLLBACK cả lô -> lượt sau publish lại (at-least-once như cũ,
   * consumer chống trùng bằng processed_messages). KHÔNG đánh dấu published_at cho lô chưa confirm đủ.
   * Trả số dòng đã publish.
   */
  async relayBatch(channel: amqp.ConfirmChannel): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows: Array<{ id: bigint; topic: string; payload: any; age_s: number }> = await tx.$queryRawUnsafe(`
          SELECT id, topic, payload, EXTRACT(EPOCH FROM (now() - created_at))::float8 AS age_s
          FROM hub.outbox
          WHERE published_at IS NULL
          ORDER BY id ASC
          LIMIT ${RELAY_BATCH}
          FOR UPDATE SKIP LOCKED;
        `);

        // S3-4: lag = tuổi dòng chưa publish cũ nhất trong lượt này (ORDER BY id ~ thứ tự tạo). 0 khi rỗng.
        outboxLag.set(rows.length === 0 ? 0 : Math.max(0, Number(rows[0].age_s) || 0));
        if (rows.length === 0) return 0;

        const confirms = rows.map((item) => {
          const { exchange, routingKey } = routeForTopic(item.topic);
          return new Promise<void>((resolve, reject) => {
            channel.publish(
              exchange,
              routingKey,
              Buffer.from(JSON.stringify(item.payload)),
              { persistent: true, headers: { 'x-correlation-id': item.payload?.correlationId } },
              (err) => (err ? reject(err) : resolve()),
            );
          });
        });
        // Chờ broker xác nhận CẢ LÔ trước khi đánh dấu — lỗi một message là rollback cả lô.
        await Promise.all(confirms);

        const ids = rows.map((r) => r.id.toString());
        await tx.$executeRaw`UPDATE hub.outbox SET published_at = now() WHERE id = ANY(${ids}::bigint[])`;
        return rows.length;
      },
      {
        timeout: RELAY_TX_TIMEOUT_MS,
        maxWait: RELAY_TX_MAX_WAIT_MS,
      },
    );
  }
}
