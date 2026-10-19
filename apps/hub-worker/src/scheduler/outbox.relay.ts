import { outboxLag } from '../metrics';
import { beat } from '../heartbeat';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { EXCHANGES, ROUTING_KEYS } from '@hub/messaging';
import { CAUSES, LogThrottle, REPLAY_OF_HEADER, TRACEPARENT_HEADER, errInfo, logger, reportUnexpected } from '@hub/common';
import * as amqp from 'amqplib';
import { classifyInfraError } from '../consumers/infra-errors';

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

/** Lỗi sinh ra ở phía broker (confirm nack / channel đóng) — để phân biệt với PG khi ghi log (`fail.hub_broker`). */
function markBroker(err: unknown): unknown {
  if (err && typeof err === 'object') (err as { hubBroker?: boolean }).hubBroker = true;
  return err;
}

export function relayFailureCause(err: unknown): 'fail.hub_broker' | 'fail.hub_db' | 'fail.hub_unknown' {
  if ((err as { hubBroker?: boolean } | null)?.hubBroker) return 'fail.hub_broker';
  return classifyInfraError(err) === 'transient' ? 'fail.hub_db' : 'fail.hub_unknown';
}

/**
 * Message trên dây = payload outbox, nhưng `traceparent`/`replayOf`/`ingestedAt` của message DELIVERY đi bằng HEADER (không vào
 * body): body delivery giữ đúng các khoá của DeliveryMessage (S1-1). Message `event.received` giữ nguyên payload (normalize đọc
 * OutboxPayload). `x-outbox-age-ms` = tuổi dòng outbox lúc SELECT (đồng hồ PG, miễn nhiễm lệch giờ) — LOGGING.md §3.2.
 */
export function wireOf(topic: string, payload: any, ageSeconds: number): { body: unknown; headers: Record<string, unknown> } {
  const p = payload ?? {};
  const headers: Record<string, unknown> = { 'x-correlation-id': p.correlationId };
  if (typeof p.traceparent === 'string') headers[TRACEPARENT_HEADER] = p.traceparent;
  if (typeof p.replayOf === 'string') headers[REPLAY_OF_HEADER] = p.replayOf;
  const age = Number(ageSeconds);
  headers['x-outbox-age-ms'] = Number.isFinite(age) && age > 0 ? Math.round(age * 1000) : 0;
  if (!topic.startsWith('delivery.')) return { body: p, headers };
  const { traceparent: _t, replayOf: _r, ingestedAt: _i, ...body } = p;
  return { body, headers };
}

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  /** Broker/PG rớt thì mỗi nhịp ~500ms đều lỗi -> tối đa 1 dòng / 30s (kèm số đã gộp), như normalize/delivery. */
  private readonly errorLogThrottle = new LogThrottle();

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
    // Độ lệch ngẫu nhiên ±100ms quanh nhịp poll 500ms (N worker không cùng đập vào bảng outbox một nhịp — KHÔNG phải tầng retry); lô vừa rồi đầy -> chạy ngay (vẫn qua setTimeout 0 để không đệ quy sâu).
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
      beat(); // ADR-248: lượt làm việc THẬT thành công (Postgres + broker) — chỉ trong bộ nhớ
      if (publishedCount > 0) {
        logger.debug({ count: publishedCount, full }, 'Outbox Relay đã publish xong batch');
      }
    } catch (err: any) {
      // LOGGING.md §2.2: phân biệt PG rớt (fail.hub_db) / broker nack-đóng (fail.hub_broker) / lạ (fail.hub_unknown) — trước đây chỉ err.message.
      const suppressed = this.errorLogThrottle.take();
      if (suppressed !== null) {
        const cause = relayFailureCause(err);
        logger.error({ cause, blame: CAUSES[cause].blame, err: errInfo(err), suppressedSinceLastLog: suppressed }, 'Lỗi trong chu kỳ Outbox Relay (log gộp tối đa 1 dòng/30s)');
        if (cause === 'fail.hub_unknown') reportUnexpected(err, { cause, stage: 'relay' }); // LOGGING.md §11: chỉ lỗi lạ; fail.hub_db/broker đã có metric + cảnh báo
      }
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

        // LOGGING.md §3.2/§4: đóng dấu thời điểm publish (queue_wait = now − max(published_ts, due_ts) ở consumer), tuổi dòng outbox
        // (age_s đã SELECT sẵn — 0 truy vấn thêm) và ngữ cảnh trace. Header, không phải body.
        const publishedAt = Date.now();
        const confirms = rows.map((item) => {
          const { exchange, routingKey } = routeForTopic(item.topic);
          const { body, headers } = wireOf(item.topic, item.payload, item.age_s);
          return new Promise<void>((resolve, reject) => {
            try {
              channel.publish(
                exchange,
                routingKey,
                Buffer.from(JSON.stringify(body)),
                { persistent: true, timestamp: publishedAt, headers },
                (err) => (err ? reject(markBroker(err)) : resolve()),
              );
            } catch (err) {
              reject(markBroker(err)); // channel đóng giữa chừng: amqplib ném đồng bộ
            }
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
