import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { NORMALIZE_RETRY_TTL_MS, RETRY_TIERS } from '@hub/messaging';
import { fastFailRedisOptions, logger } from '@hub/common';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { NORMALIZE_MAX_RETRIES } from '../consumers/normalize-errors';

/**
 * Job dọn dẹp (S1-4, ADR-045). Redis lock CHỈ dùng ở đây (ARCHITECTURE: "Redis lock chỉ dùng cho
 * job cleanup") — nhiều instance worker cùng chạy thì chỉ một instance dọn mỗi lượt.
 *
 * Xoá theo lô 5000 dòng tới khi hết:
 *  - hub.outbox đã publish quá N ngày;
 *  - hub.processed_messages quá N ngày;
 *  - hub.raw_events REJECTED quá N ngày (request ký sai — rác, không phải bằng chứng);
 *  - hub.events quá N ngày (S7, ADR-077) — cascade deliveries + delivery_attempts, qua escape hatch có tên.
 * KHÔNG BAO GIỜ đụng raw_events ACCEPTED: đó là bằng chứng gốc để verify và phát lại (renormalize khi event đã bị xoá).
 * Hệ quả: polling (A) chỉ lấy lại được trong N ngày.
 */
export const CLEANUP_LOCK_KEY = 'cleanup:lock';
export const CLEANUP_LOCK_TTL_SECONDS = 300;
export const CLEANUP_BATCH = 5000;
export const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 3_600_000;

/**
 * Tổng thời gian một message có thể còn "sống" trong hệ thống retry: 5 tầng delivery
 * (10s+1m+5m+30m+2h) + 5 lần normalize 30s. processed_messages/outbox phải sống LÂU HƠN thế,
 * nếu không một message retry muộn có thể bị xử lý lại vì chốt idempotency đã bị xoá.
 */
export const TOTAL_RETRY_WINDOW_MS =
  RETRY_TIERS.reduce((sum, t) => sum + t.ttlMs, 0) + NORMALIZE_RETRY_TTL_MS * NORMALIZE_MAX_RETRIES;

export function assertRetentionSafe(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays * DAY_MS <= TOTAL_RETRY_WINDOW_MS) {
    throw new Error(
      `EVENT_RETENTION_DAYS=${retentionDays} không an toàn: phải lớn hơn tổng thời gian retry ` +
        `(${Math.ceil(TOTAL_RETRY_WINDOW_MS / 60_000)} phút), nếu không chốt idempotency bị xoá trước khi retry xong.`,
    );
  }
}

// Assert lúc load: hằng số mặc định phải luôn an toàn, kể cả khi ai đó thêm tầng retry dài hơn.
assertRetentionSafe(DEFAULT_RETENTION_DAYS);

/** S7: `EVENT_RETENTION_DAYS` là tên chính; `CLEANUP_RETENTION_DAYS` vẫn đọc làm alias (đừng làm vỡ `.env` cũ). */
export function resolveRetentionDays(env = process.env.EVENT_RETENTION_DAYS || process.env.CLEANUP_RETENTION_DAYS): number {
  const days = env === undefined || env === '' ? DEFAULT_RETENTION_DAYS : Number(env);
  assertRetentionSafe(days);
  return days;
}

export interface CleanupResult {
  skipped: boolean;
  outbox: number;
  processedMessages: number;
  rejectedRawEvents: number;
  events: number;
}

/** Chỉ xoá lock nếu vẫn là của mình (lượt chạy quá 300s thì lock có thể đã thuộc instance khác). */
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

@Injectable()
export class CleanupJob implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly redis: Redis;
  private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly retentionDays: number;
  private readonly intervalMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() redisClient?: Redis,
  ) {
    this.retentionDays = resolveRetentionDays();
    const interval = parseInt(process.env.CLEANUP_INTERVAL_MS || '', 10);
    this.intervalMs = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS;
    if (redisClient) {
      this.redis = redisClient;
    } else {
      this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', fastFailRedisOptions()); // MS-P2-3
      this.redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis (cleanup) lỗi'));
      this.redis.connect().catch(() => {});
    }
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
    // Lượt đầu sau 30–90s (không phải 1h) để một lần restart là đủ kiểm job trên docker.
    this.schedule(30_000 + Math.floor(Math.random() * 60_000));
    logger.info({ retentionDays: this.retentionDays, intervalMs: this.intervalMs }, 'Cleanup job đã khởi động');
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<CleanupResult> {
    let acquired: string | null = null;
    try {
      acquired = await this.redis.set(CLEANUP_LOCK_KEY, this.instanceId, 'EX', CLEANUP_LOCK_TTL_SECONDS, 'NX');
    } catch (err: any) {
      // Không có Redis thì không có lock -> bỏ lượt (dọn dẹp chậm một giờ không làm hệ thống sai).
      logger.warn({ err: err.message }, 'Cleanup: không giành được lock (Redis lỗi) -> bỏ qua lượt');
      return { skipped: true, outbox: 0, processedMessages: 0, rejectedRawEvents: 0, events: 0 };
    }
    if (acquired !== 'OK') {
      logger.debug('Cleanup: instance khác đang giữ lock -> bỏ qua lượt');
      return { skipped: true, outbox: 0, processedMessages: 0, rejectedRawEvents: 0, events: 0 };
    }

    try {
      const secs = Math.floor((this.retentionDays * DAY_MS) / 1000);
      const result: CleanupResult = {
        skipped: false,
        outbox: await this.deleteInBatches(Prisma.sql`
          DELETE FROM hub.outbox WHERE id IN (
            SELECT id FROM hub.outbox
            WHERE published_at IS NOT NULL AND published_at < now() - make_interval(secs => ${secs}::double precision)
            LIMIT ${CLEANUP_BATCH})`),
        processedMessages: await this.deleteInBatches(Prisma.sql`
          DELETE FROM hub.processed_messages WHERE (consumer, message_id) IN (
            SELECT consumer, message_id FROM hub.processed_messages
            WHERE created_at < now() - make_interval(secs => ${secs}::double precision)
            LIMIT ${CLEANUP_BATCH})`),
        rejectedRawEvents: await this.deleteInBatches(Prisma.sql`
          DELETE FROM hub.raw_events WHERE id IN (
            SELECT id FROM hub.raw_events
            WHERE status = 'REJECTED' AND received_at < now() - make_interval(secs => ${secs}::double precision)
            LIMIT ${CLEANUP_BATCH})`),
        events: await this.loopBatches(() => this.prisma.deleteExpiredEventsBatch(secs, CLEANUP_BATCH)),
      };
      logger.info({ ...result, retentionDays: this.retentionDays }, 'Cleanup: hoàn tất một lượt');
      return result;
    } finally {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, CLEANUP_LOCK_KEY, this.instanceId).catch(() => {});
    }
  }

  private deleteInBatches(sql: Prisma.Sql): Promise<number> {
    return this.loopBatches(() => this.prisma.$executeRaw(sql));
  }

  private async loopBatches(once: () => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await once();
      total += n;
      if (n < CLEANUP_BATCH) return total;
    }
  }

  private schedule(delayMs: number) {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Cleanup: lỗi trong lượt dọn');
      } finally {
        const jitter = Math.floor(Math.random() * 0.2 * this.intervalMs) - 0.1 * this.intervalMs; // ±10%
        this.schedule(this.intervalMs + jitter);
      }
    }, delayMs);
  }
}
