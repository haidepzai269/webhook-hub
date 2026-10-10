import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { logger } from '@hub/common';
import { Prisma } from '@prisma/client';

/** Delivery phải "nguội" bao lâu mới bị coi là kẹt (mặc định 10 phút). */
export const DEFAULT_DELIVERY_SWEEP_AFTER_MS = 10 * 60_000;
/** RETRYING quá `next_attempt_at` bao lâu thì coi là mất message retry (mặc định 5 phút, S2). */
export const DEFAULT_RETRY_SWEEP_GRACE_MS = 5 * 60_000;
/**
 * RETRYING có từ TRƯỚC khi cột `next_attempt_at` được ghi (NULL) -> không có mốc hạn để so. Coi là kẹt
 * khi `updated_at` cũ hơn 3 giờ: lớn hơn tầng retry dài nhất (2h) + biên, nên một delivery còn đang
 * nằm trong queue retry hợp lệ không bao giờ bị quét nhầm (review SPEC-2).
 */
export const LEGACY_RETRY_SWEEP_AFTER_MS = 3 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 100;

/**
 * Câu SQL của sweeper (S1-2, ADR-043) — tách ra để test DB dùng lại đúng câu đang chạy thật.
 *
 * Tìm delivery bị kẹt và ghi lại MỘT dòng outbox `delivery.requested` cho mỗi cái:
 *  - PENDING quá `sweepAfter` mà chưa có attempt nào (message gốc bị mất ở đâu đó), hoặc
 *  - DELIVERING treo quá `sweepAfter` (worker chết giữa lúc gửi; message bị redeliver sớm đã
 *    bị lease từ chối nên không còn ai nhận), hoặc
 *  - RETRYING có `next_attempt_at` quá hạn hơn `retryGrace` (S2, ADR-048): worker COMMIT RETRYING
 *    + processed_messages rồi chết trước `sendToQueue` (kênh không confirm) -> message gốc redeliver,
 *    gặp processed hit, bị ack -> không ai gửi tiếp. `attemptCount` lấy từ DB (`attempt_count`), hoặc
 *  - RETRYING có `next_attempt_at` NULL (dữ liệu từ trước khi có cột) và `updated_at` cũ hơn
 *    LEGACY_RETRY_SWEEP_AFTER_MS (3h > tầng retry dài nhất).
 * PENDING bị circuit hoãn có `next_attempt_at` mới ghi -> không bị quét (tránh nhân bản bản sao
 * mỗi 10 phút trong lúc OPEN rồi dội cùng lúc khi CLOSED).
 * Bỏ qua delivery đang có dòng outbox CHƯA publish, hoặc vừa được ghi outbox trong cửa sổ
 * `sweepAfter` (tránh mỗi phút lại nhân bản message khi hàng đợi chỉ đang chậm).
 * Ghi trùng vẫn an toàn: lease `claimForSend` + processed_messages chỉ cho một lần gửi đi.
 *
 * Chạy XUYÊN TENANT có chủ đích, giống outbox relay: đây là hạ tầng, không phải truy vấn nghiệp vụ.
 * Câu lệnh chỉ đọc khoá (id, tenant_id, generation, attempt_count, correlation_id) để GHI vào
 * outbox ngay trong cùng câu lệnh — không trả dữ liệu nghiệp vụ nào ra ngoài (BB-5 giữ nguyên).
 */
export function buildSweepSql(sweepAfterMs: number, batch = SWEEP_BATCH, retryGraceMs = DEFAULT_RETRY_SWEEP_GRACE_MS): Prisma.Sql {
  const secs = Math.max(1, Math.floor(sweepAfterMs / 1000));
  const graceSecs = Math.max(1, Math.floor(retryGraceMs / 1000));
  const legacySecs = Math.floor(LEGACY_RETRY_SWEEP_AFTER_MS / 1000);
  return Prisma.sql`
    WITH stuck AS (
      SELECT d.id, d.tenant_id, d.attempt_generation, d.attempt_count, e.correlation_id
      FROM hub.deliveries d
      JOIN hub.events e ON e.id = d.event_id
      WHERE (
          (d.status = 'PENDING' AND d.created_at < now() - make_interval(secs => ${secs}::double precision)
             AND (d.next_attempt_at IS NULL OR d.next_attempt_at < now() - make_interval(secs => ${secs}::double precision))
             AND NOT EXISTS (SELECT 1 FROM hub.delivery_attempts a WHERE a.delivery_id = d.id))
          OR (d.status = 'DELIVERING' AND d.updated_at < now() - make_interval(secs => ${secs}::double precision))
          OR (d.status = 'RETRYING' AND d.next_attempt_at < now() - make_interval(secs => ${graceSecs}::double precision))
          OR (d.status = 'RETRYING' AND d.next_attempt_at IS NULL
             AND d.updated_at < now() - make_interval(secs => ${legacySecs}::double precision))
        )
        AND NOT EXISTS (
          SELECT 1 FROM hub.outbox o
          WHERE o.topic IN ('delivery.requested', 'delivery.replayed')
            AND o.payload->>'deliveryId' = d.id::text
            AND (o.published_at IS NULL OR o.created_at > now() - make_interval(secs => ${secs}::double precision))
        )
      ORDER BY d.created_at
      LIMIT ${batch}
      FOR UPDATE OF d SKIP LOCKED
    )
    INSERT INTO hub.outbox (topic, payload)
    SELECT 'delivery.requested',
           jsonb_build_object(
             'deliveryId', s.id::text,
             'tenantId', s.tenant_id::text,
             'attemptGeneration', s.attempt_generation,
             'attemptCount', s.attempt_count,
             'correlationId', s.correlation_id::text)
    FROM stuck s`;
}

@Injectable()
export class DeliverySweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly sweepAfterMs: number;
  private readonly retryGraceMs: number;

  constructor(private readonly prisma: PrismaService) {
    const env = parseInt(process.env.DELIVERY_SWEEP_AFTER_MS || '', 10);
    this.sweepAfterMs = Number.isFinite(env) && env > 0 ? env : DEFAULT_DELIVERY_SWEEP_AFTER_MS;
    const grace = parseInt(process.env.DELIVERY_RETRY_SWEEP_GRACE_MS || '', 10);
    this.retryGraceMs = Number.isFinite(grace) && grace > 0 ? grace : DEFAULT_RETRY_SWEEP_GRACE_MS;
  }

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    if (this.running) return;
    this.running = true;
    logger.info({ sweepAfterMs: this.sweepAfterMs }, 'Delivery sweeper đã khởi động');
    this.scheduleNext();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Một lượt quét. Trả số delivery đã được ghi lại outbox. */
  async sweepOnce(): Promise<number> {
    // AU6: quét delivery kẹt XUYÊN project -> đường hệ thống có tên (RLS).
    const count = await this.prisma.systemTx('sweeper: delivery kẹt', (tx) => tx.$executeRaw(buildSweepSql(this.sweepAfterMs, SWEEP_BATCH, this.retryGraceMs)));
    if (count > 0) {
      logger.warn({ count, sweepAfterMs: this.sweepAfterMs, retryGraceMs: this.retryGraceMs }, 'Sweeper: ghi lại outbox delivery.requested cho delivery bị kẹt');
    }
    return count;
  }

  private scheduleNext() {
    if (!this.running) return;
    const jitter = Math.floor(Math.random() * 20_000) - 10_000; // ±10s
    this.timer = setTimeout(async () => {
      try {
        await this.sweepOnce();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Lỗi trong lượt quét delivery sweeper');
      } finally {
        this.scheduleNext();
      }
    }, SWEEP_INTERVAL_MS + jitter);
  }
}
