import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { TOTAL_RETRY_WINDOW_MS } from '@hub/messaging';
import {
  POLICY_IMPORTANCES,
  fastFailRedisOptions,
  logger,
  parseStorageLevel,
  quotaBytesFor,
  resolveProjectStorageQuotaMb,
  resolveStorageAutoCleanEnabled,
} from '@hub/common';
import { StorageJob } from './storage.job';
import { DEFAULT_TRAFFIC_RETENTION_DAYS, resolveTrafficRetentionDays } from './traffic-retention';
import { runCleanBatch, toMb } from './storage-clean';
import { storageCleanBatches, storageCleanFreedBytes } from '../metrics';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { hostname } from 'os';
import { randomUUID } from 'crypto';

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
 * Tổng thời gian một message có thể còn "sống" trong hệ thống retry (5 tầng delivery + 5 lần normalize 30s).
 * processed_messages/outbox phải sống LÂU HƠN thế. QT4 (ADR-184): nguồn chuyển sang @hub/messaging (retry-window.ts) để
 * hub-api kiểm `olderThan` của lệnh dọn bằng CÙNG hằng số — re-export giữ API cũ.
 */
export { TOTAL_RETRY_WINDOW_MS };

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
  /** SPEC-auth §5.3 (AU2): phiên hết hạn quá 30 ngày, token mail hết hạn quá 7 ngày. */
  authSessions: number;
  emailTokens: number;
  /** CB6 (ADR-171, review): bộ đếm bản trùng theo giờ quá `INGEST_DUPLICATES_KEEP_DAYS`. */
  ingestDuplicates: number;
  /** EG4 (ADR-179): lưu lượng theo phút quá `TRAFFIC_RETENTION_DAYS`. */
  sourceTraffic: number;
  /** QT5 (§5.4, ADR-186): dọn tự động theo policy — `enabled=false` khi `STORAGE_AUTO_CLEAN_ENABLED=0` (E5). */
  autoClean: AutoCleanResult;
}

export interface AutoCleanResult {
  enabled: boolean;
  projects: number;
  events: number;
  rejectedSamples: number;
  freedBytes: number;
}

/** QT5: trần lô mỗi (project, policy) mỗi lượt cleanup — lượt sau làm tiếp; một project lớn không chiếm cả lượt. */
export const AUTO_CLEAN_MAX_BATCHES = 20;
const AUTO_CLEAN_OFF: AutoCleanResult = { enabled: false, projects: 0, events: 0, rejectedSamples: 0, freedBytes: 0 };

/** SPEC-auth §5.3: giữ phiên đã hết hạn thêm 30 ngày (điều tra reuse_detected), token mail thêm 7 ngày. */
export const AUTH_SESSION_KEEP_DAYS = 30;
export const EMAIL_TOKEN_KEEP_DAYS = 7;
/** CB6: nhận định `I-dup` chỉ đọc "hôm nay" — giữ 30 ngày bucket giờ để tra lại, hơn nữa là rác. */
export const INGEST_DUPLICATES_KEEP_DAYS = 30;
/** EG4 (ADR-179): nguồn ở traffic-retention.ts (QT5 — tránh vòng import với storage.job); re-export giữ API cũ. */
export { DEFAULT_TRAFFIC_RETENTION_DAYS, resolveTrafficRetentionDays };
const SKIPPED: CleanupResult = { skipped: true, outbox: 0, processedMessages: 0, rejectedRawEvents: 0, events: 0, authSessions: 0, emailTokens: 0, ingestDuplicates: 0, sourceTraffic: 0, autoClean: AUTO_CLEAN_OFF };


@Injectable()
export class CleanupJob implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly redis: Redis;
  private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private readonly lockTtlSeconds: number;
  /** E5: `STORAGE_AUTO_CLEAN_ENABLED` — đọc MỘT lần lúc khởi động; 0 = policy đã cài nhưng KHÔNG chạy (dọn tay vẫn chạy). */
  readonly autoCleanEnabled = resolveStorageAutoCleanEnabled();
  private readonly defaultQuotaMb = resolveProjectStorageQuotaMb();
  /** Byte giải phóng bởi retention trong lượt hiện tại, theo tenant — tính lại nấc cuối lượt (E2: hạ nấc ngay). */
  private retentionFreed = new Map<string, number>();
  /** Đặt bởi `stop()` — vòng dọn tự động dừng ở ranh giới project. */
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() redisClient?: Redis,
    @Optional() private readonly storage?: StorageJob,
  ) {
    this.retentionDays = resolveRetentionDays();
    const interval = parseInt(process.env.CLEANUP_INTERVAL_MS || '', 10);
    this.intervalMs = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS;
    this.lockTtlSeconds = Math.max(CLEANUP_LOCK_TTL_SECONDS, Math.floor((this.intervalMs * 0.9) / 1000));
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
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<CleanupResult> {
    let acquired: string | null = null;
    try {
      // MS-P2-6 (ADR-093): lock giữ ~90% chu kỳ và KHÔNG nhả khi xong -> N worker = MỘT lượt mỗi chu kỳ (trước: lock
      // chỉ chặn chạy chồng, N worker = N lượt/giờ). 90% < khoảng cách tối thiểu giữa 2 lượt của cùng instance (jitter ±10%).
      acquired = await this.redis.set(CLEANUP_LOCK_KEY, this.instanceId, 'EX', this.lockTtlSeconds, 'NX');
    } catch (err: any) {
      // Không có Redis thì không có lock -> bỏ lượt (dọn dẹp chậm một giờ không làm hệ thống sai).
      logger.warn({ err: err.message }, 'Cleanup: không giành được lock (Redis lỗi) -> bỏ qua lượt');
      return { ...SKIPPED };
    }
    if (acquired !== 'OK') {
      logger.debug('Cleanup: instance khác đang giữ lock -> bỏ qua lượt');
      return { ...SKIPPED };
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
        // QT5 (E2): retention trừ byte giải phóng vào project_usage của từng tenant trong CÙNG câu lệnh.
        rejectedRawEvents: await this.loopBatches(() => this.accounted(this.prisma.deleteExpiredRejectedBatchAccounted(secs, CLEANUP_BATCH))),
        events: await this.loopBatches(() => this.accounted(this.prisma.deleteExpiredEventsBatchAccounted(secs, CLEANUP_BATCH))),
        // Bảng danh tính chỉ qua IdentityRepository (SPEC-auth §5.1) — mở rộng job sẵn có, không job mới.
        authSessions: await this.loopBatches(() => this.prisma.identity().deleteExpiredSessionsBatch(AUTH_SESSION_KEEP_DAYS, CLEANUP_BATCH)),
        emailTokens: await this.loopBatches(() => this.prisma.identity().deleteExpiredEmailTokensBatch(EMAIL_TOKEN_KEEP_DAYS, CLEANUP_BATCH)),
        // CB6 (ADR-171): bảng mang tenant_id + RLS -> xoá xuyên project qua systemTx như các bảng trên; khoá Redis ở đầu lượt.
        ingestDuplicates: await this.deleteInBatches(Prisma.sql`
          DELETE FROM hub.ingest_duplicates WHERE (tenant_id, source_id, bucket) IN (
            SELECT tenant_id, source_id, bucket FROM hub.ingest_duplicates
            WHERE bucket < now() - make_interval(days => ${INGEST_DUPLICATES_KEEP_DAYS}::int)
            LIMIT ${CLEANUP_BATCH})`),
        // EG4 (ADR-179): như trên — xuyên project qua systemTx, theo lô, index (minute).
        sourceTraffic: await this.deleteInBatches(Prisma.sql`
          DELETE FROM hub.source_traffic_minutely WHERE (tenant_id, source_id, minute, outcome) IN (
            SELECT tenant_id, source_id, minute, outcome FROM hub.source_traffic_minutely
            WHERE minute < now() - make_interval(days => ${resolveTrafficRetentionDays()}::int)
            LIMIT ${CLEANUP_BATCH})`),
        autoClean: AUTO_CLEAN_OFF, // điền sau retention (QT5)
      };
      await this.recomputeLevelsAfterRetention();
      // QT5 (§5.4): dọn tự động theo policy — CÙNG khoá Redis của lượt cleanup này.
      result.autoClean = this.autoCleanEnabled ? await this.runAutoClean() : AUTO_CLEAN_OFF;
      if (!this.autoCleanEnabled) logger.debug('Cleanup: STORAGE_AUTO_CLEAN_ENABLED=0 — policy dọn tự động đã cài nhưng không chạy');
      logger.info({ ...result, retentionDays: this.retentionDays }, 'Cleanup: hoàn tất một lượt');
      return result;
    } finally {
      // Không nhả lock: TTL tự hết sau ~0,9 chu kỳ (kể cả khi lượt lỗi — không thành bão thử lại).
    }
  }

  /** QT5: cộng byte retention đã trừ vào bảng tạm theo tenant (để tính lại nấc cuối lượt); trả số dòng xoá cho loopBatches. */
  private async accounted(p: Promise<{ deleted: number; freed: { tenantId: string; bytes: number }[] }>): Promise<number> {
    const r = await p;
    for (const f of r.freed) {
      this.retentionFreed.set(f.tenantId, (this.retentionFreed.get(f.tenantId) ?? 0) + f.bytes);
      storageCleanFreedBytes.inc({ trigger: 'retention' }, f.bytes);
    }
    return r.deleted;
  }

  /** E2: retention đã trừ `used_bytes` trong cùng câu xoá -> tính lại nấc NGAY cho các project bị đụng (không chờ lượt 60s). */
  private async recomputeLevelsAfterRetention(): Promise<void> {
    const freed = this.retentionFreed;
    this.retentionFreed = new Map();
    for (const tenantId of freed.keys()) {
      try {
        const quotaBytes = quotaBytesFor(((await this.prisma.findProjectById(tenantId)) as { storageQuotaMb?: number | null } | null)?.storageQuotaMb ?? null, this.defaultQuotaMb);
        const c = await this.prisma.forTenant(tenantId).recomputeStorageLevel(quotaBytes);
        if (c && c.from !== c.to) {
          await this.storage?.reportLevelChange({ tenantId, from: parseStorageLevel(c.from), to: parseStorageLevel(c.to), usedBytes: c.usedBytes, quotaBytes });
        }
      } catch (err: any) {
        logger.warn({ err: err?.message, tenantId }, 'Cleanup: không tính lại được nấc sau retention (lượt nấc 60s sẽ sửa)');
      }
    }
  }

  /**
   * QT5 (§5.4, ADR-186, QT:T18): dọn tự động theo policy user đặt. Chỉ mức CÓ policy `action <> 'off'` (junk/low/medium —
   * Cao/Giữ không có trong bảng, lọc thêm ở đây); `trigger=above_85` chỉ chạy khi project ≥ 85% hạn mức; Rác chỉ Xoá hẳn.
   * Mỗi lô là MỘT transaction ngắn (`runCleanBatch` — cùng bất biến với lệnh dọn tay: không đụng delivery đang chạy, sàn
   * retry, source "Giữ lâu", audit_logs). Có dọn được gì thì ghi MỘT dòng audit `storage.auto_clean` actor
   * `system:auto-clean` (số dòng + MB) — không ghi khi 0 dòng (audit_logs không bao giờ dọn được, đừng làm nó phình).
   */
  async runAutoClean(tenantIds?: string[]): Promise<AutoCleanResult> {
    const out: AutoCleanResult = { enabled: true, projects: 0, events: 0, rejectedSamples: 0, freedBytes: 0 };
    const targets = await this.prisma.storageAutoCleanTargetsAcrossTenants(tenantIds);
    for (const t of targets) {
      if (this.stopped) break; // đang tắt: phần còn lại để lượt sau
      const quotaBytes = quotaBytesFor(t.quotaMb, this.defaultQuotaMb);
      const above85 = quotaBytes > 0 && t.usedBytes >= 0.85 * quotaBytes;
      let touched = false;
      for (const p of t.policies) {
        if (!(POLICY_IMPORTANCES as readonly string[]).includes(p.importance)) continue; // Cao/Giữ không bao giờ
        if (p.action !== 'trim' && p.action !== 'delete') continue;
        if (p.importance === 'junk' && p.action !== 'delete') continue;
        if (p.trigger === 'above_85' && !above85) continue;
        if (!Number.isInteger(p.afterDays) || p.afterDays < 1) continue;
        const spec = { action: p.action as 'trim' | 'delete', importance: [p.importance], cutoff: new Date(Date.now() - p.afterDays * DAY_MS), sourceId: null };
        const sum = { events: 0, rejected: 0, freed: 0 };
        try {
          for (let i = 0; i < AUTO_CLEAN_MAX_BATCHES; i++) {
            const r = await runCleanBatch(this.prisma, t.tenantId, spec, quotaBytes);
            storageCleanBatches.inc({ trigger: 'auto', result: 'ok' });
            sum.events += r.events;
            sum.rejected += r.rejected;
            sum.freed += r.freedBytes;
            if (r.level && r.level.from !== r.level.to) {
              await this.storage?.reportLevelChange({ tenantId: t.tenantId, from: parseStorageLevel(r.level.from), to: parseStorageLevel(r.level.to), usedBytes: r.level.usedBytes, quotaBytes });
            }
            if (r.done) break;
          }
        } catch (err: any) {
          storageCleanBatches.inc({ trigger: 'auto', result: 'error' });
          logger.warn({ err: err?.message, tenantId: t.tenantId, importance: p.importance }, 'Cleanup: dọn tự động lỗi (bỏ qua policy này, lượt sau thử lại)');
        }
        if (sum.events + sum.rejected === 0) continue;
        touched = true;
        out.events += sum.events;
        out.rejectedSamples += sum.rejected;
        out.freedBytes += sum.freed;
        if (sum.freed > 0) storageCleanFreedBytes.inc({ trigger: 'auto' }, sum.freed);
        try {
          await this.prisma.forTenant(t.tenantId).createAuditLog({
            action: 'storage.auto_clean',
            entityType: 'storage_policy',
            entityId: p.importance,
            actor: 'system:auto-clean',
            metadata: { importance: p.importance, action: p.action, afterDays: p.afterDays, trigger: p.trigger, events: sum.events, rejectedSamples: sum.rejected, freedBytes: sum.freed, freedMb: toMb(sum.freed) },
          });
        } catch (err: any) {
          logger.warn({ err: err?.message, tenantId: t.tenantId }, 'Cleanup: không ghi được audit dọn tự động');
        }
      }
      if (touched) out.projects++;
    }
    return out;
  }

  /** AU6: dọn xuyên project có chủ đích -> đường hệ thống có tên (RLS). */
  private deleteInBatches(sql: Prisma.Sql): Promise<number> {
    return this.loopBatches(() => this.prisma.systemTx('cleanup: dọn theo lô', (tx) => tx.$executeRaw(sql)));
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
