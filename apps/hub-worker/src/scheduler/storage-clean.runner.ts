import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { CleanAction, logger, parseStorageLevel } from '@hub/common';
import { StorageJob } from './storage.job';
import { projectQuotaBytes, runCleanBatch, toMb } from './storage-clean';
import { storageCleanBatches, storageCleanFreedBytes } from '../metrics';

/**
 * QT4 (SPEC-han-muc-dung-luong §5.5, ADR-184): chạy LỆNH DỌN do `POST …/storage/clean` (hoặc `apply` gợi ý) ghi PENDING.
 *
 *  - Nhận lệnh bằng escape hatch có tên `storageClaimCleanJobAcrossTenants` (`FOR UPDATE SKIP LOCKED` + lease) — N worker
 *    không nhận trùng, KHÔNG cần khoá Redis (0 lệnh Redis — ngân sách R1 không đổi).
 *  - Chạy THEO LÔ (`CLEAN_BATCH_SIZE`), mỗi lô MỘT transaction ngắn gồm: dọn + đo byte giải phóng + trừ `used_bytes` + tính
 *    lại nấc (E2: mở khoá ngay) + cộng tiến độ của lệnh. Worker chết giữa chừng -> lô dở rollback, lease hết, worker khác
 *    chạy tiếp từ chỗ còn lại (điều kiện chọn tự loại phần đã dọn).
 *  - Xong -> `audit_logs` `storage.clean.completed` (cùng transaction lô cuối) với actor = người yêu cầu.
 *  - Đổi nấc -> báo `StorageJob.reportLevelChange` (cùng đường hook với lượt nấc 60s — QT6 cắm cảnh báo vào đó).
 */
export const STORAGE_CLEAN_POLL_MS_DEFAULT = 5_000;
export const STORAGE_CLEAN_LEASE_MS = 120_000;
export const STORAGE_CLEAN_MAX_ATTEMPTS = 5;

export function resolveStorageCleanPollMs(v: string | undefined = process.env.STORAGE_CLEAN_POLL_MS): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(60_000, Math.max(1_000, Math.round(n))) : STORAGE_CLEAN_POLL_MS_DEFAULT;
}

export interface CleanJobRunResult {
  id: string;
  tenantId: string;
  status: 'DONE' | 'RUNNING' | 'MISSING';
  batches: number;
  events: number;
  rejected: number;
  freedBytes: number;
}

@Injectable()
export class StorageCleanRunner implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Đặt bởi `stop()` (tắt máy): lệnh đang chạy dừng ở ranh giới lô, lease hết thì worker khác chạy tiếp. */
  private stopped = false;
  readonly pollMs = resolveStorageCleanPollMs();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: StorageJob,
  ) {}

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(3_000 + Math.floor(Math.random() * 3_000));
  }

  stop() {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Nhận và chạy tối đa `maxJobs` lệnh (mỗi lệnh tới khi xong hoặc khi đang tắt). */
  async tick(maxJobs = 5): Promise<CleanJobRunResult[]> {
    const out: CleanJobRunResult[] = [];
    for (let i = 0; i < maxJobs; i++) {
      const claim = await this.prisma.storageClaimCleanJobAcrossTenants(STORAGE_CLEAN_LEASE_MS, STORAGE_CLEAN_MAX_ATTEMPTS);
      if (!claim) break;
      out.push(await this.runJob(claim.id, claim.tenantId));
      if (this.stopped) break;
    }
    return out;
  }

  /** Chạy MỘT lệnh đã nhận. Lỗi giữa chừng: để RUNNING — lease hết thì lượt sau nhận lại (tối đa `STORAGE_CLEAN_MAX_ATTEMPTS`). */
  async runJob(id: string, tenantId: string): Promise<CleanJobRunResult> {
    const res: CleanJobRunResult = { id, tenantId, status: 'RUNNING', batches: 0, events: 0, rejected: 0, freedBytes: 0 };
    const job = await this.prisma.forTenant(tenantId).findStorageCleanJob(id);
    if (!job) return { ...res, status: 'MISSING' };
    const quotaBytes = await projectQuotaBytes(this.prisma, tenantId);
    const spec = { action: job.action as CleanAction, importance: job.importance, cutoff: job.cutoff, sourceId: job.sourceId };
    const total = { events: job.eventsAffected, rejected: job.rejectedAffected, freed: Number(job.freedBytes) };
    for (;;) {
      let r;
      try {
        r = await runCleanBatch(this.prisma, tenantId, spec, quotaBytes, async (repo, b) => {
          await repo.recordCleanJobBatch(id, { events: b.events, rejected: b.rejected, freedBytes: b.freedBytes, done: b.done, leaseMs: STORAGE_CLEAN_LEASE_MS });
          if (b.done) {
            await repo.createAuditLog({
              action: 'storage.clean.completed',
              entityType: 'storage_clean_job',
              entityId: id,
              actor: job.requestedBy,
              metadata: {
                action: job.action,
                importance: job.importance,
                olderThan: job.olderThan,
                sourceId: job.sourceId,
                origin: job.origin,
                ...(job.suggestionId ? { suggestionId: job.suggestionId, advisor: job.advisor } : {}),
                events: total.events + b.events,
                rejectedSamples: total.rejected + b.rejected,
                freedBytes: total.freed + b.freedBytes,
                freedMb: toMb(total.freed + b.freedBytes),
              },
            });
          }
        });
      } catch (err: any) {
        storageCleanBatches.inc({ trigger: 'manual', result: 'error' });
        logger.warn({ err: err?.message, jobId: id, tenantId }, 'Storage: lô dọn lỗi — lệnh giữ RUNNING, lease hết thì chạy lại');
        return res;
      }
      storageCleanBatches.inc({ trigger: 'manual', result: 'ok' });
      if (r.freedBytes > 0) storageCleanFreedBytes.inc({ trigger: 'manual' }, r.freedBytes);
      res.batches++;
      res.events += r.events;
      res.rejected += r.rejected;
      res.freedBytes += r.freedBytes;
      total.events += r.events;
      total.rejected += r.rejected;
      total.freed += r.freedBytes;
      if (r.level && r.level.from !== r.level.to) {
        await this.storage?.reportLevelChange({
          tenantId,
          from: parseStorageLevel(r.level.from),
          to: parseStorageLevel(r.level.to),
          usedBytes: r.level.usedBytes,
          quotaBytes,
        });
      }
      if (r.done) {
        logger.info({ jobId: id, tenantId, events: total.events, rejected: total.rejected, freedMb: toMb(total.freed) }, 'Storage: lệnh dọn xong');
        return { ...res, status: 'DONE' };
      }
      if (this.stopped) return res; // đang tắt: lease hết, worker khác chạy tiếp
    }
  }

  private schedule(delayMs: number) {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Storage: lỗi khi nhận lệnh dọn (bỏ qua, lượt sau thử lại)');
      } finally {
        this.schedule(this.pollMs);
      }
    }, delayMs);
    this.timer.unref?.();
  }
}
