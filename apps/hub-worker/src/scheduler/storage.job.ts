import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import {
  StorageLevel,
  bloatFactorFrom,
  calibrationDueBefore,
  computeUsedBytes,
  fastFailRedisOptions,
  isDiskNearFull,
  levelFor,
  logger,
  parseStorageLevel,
  quotaBytesFor,
  resolveDbDiskBudgetMb,
  resolveProjectStorageQuotaMb,
  resolveStorageLevelIntervalMs,
  resolveStorageRecalibrateIntervalMs,
  shouldCheckGlobalDisk,
} from '@hub/common';
import Redis from 'ioredis';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { resolveTrafficRetentionDays } from './cleanup.job';
import {
  dbSizeBytes,
  projectStorageBytes,
  projectStorageLocked,
  storageCalibrations,
  storageLevelTransitions,
  storageNearFull,
} from '../metrics';

/**
 * QT2 (SPEC-han-muc-dung-luong ĐÍNH CHÍNH E2 + §6, ADR-183/185): đo dung lượng project trong hub-worker (ADR-020, không
 * tiến trình mới). Hai nhịp, mỗi nhịp một khoá Redis như cleanup (giữ ~90% chu kỳ, KHÔNG nhả -> N worker = MỘT lượt):
 *
 *  - **Cập nhật nấc** (`STORAGE_LEVEL_INTERVAL_MS`, 60s): MỘT truy vấn gộp xuyên project (`storageLevelTickAcrossTenants`,
 *    systemTx có tên) -> `used = mốc + bloat × Σ bytes sau mốc − đã giải phóng` -> `levelFor` (vùng đệm) -> chỉ project có
 *    số đổi mới bị ghi lại qua `forTenant` (RLS). Chốt toàn cục `pg_database_size` tối đa 10 phút một lần (đếm trong bộ nhớ).
 *  - **Hiệu chỉnh** (`STORAGE_RECALIBRATE_INTERVAL_MS`, 24h): quét THẬT từng project một (`measureStorage`, một truy vấn
 *    gộp theo source, qua `forTenant`), đặt lại mốc. Mốc cũ hơn `TRAFFIC_RETENTION_DAYS − 1` ngày -> bắt buộc ở lượt kế.
 *
 * Đường nóng ingest KHÔNG đổi: +0 truy vấn, +0 lệnh Redis (số byte đi qua bộ gộp EG4). Lệnh Redis của job: 1 `SET NX` mỗi
 * nhịp mỗi instance. Đổi nấc hôm nay chỉ log + metric; email/webhook/cảnh báo owner là QT6 (`onLevelChange`).
 */
export const STORAGE_LEVEL_LOCK_KEY = 'storage:level:lock';
export const STORAGE_CALIBRATE_LOCK_KEY = 'storage:calibrate:lock';
/** Số project tối đa hiệu chỉnh mỗi lượt (mỗi project một truy vấn) — phần còn lại sang lượt sau (cũ nhất trước). */
export const STORAGE_CALIBRATE_BATCH = 50;
/**
 * Review QT-S1 M2: quét thật của project lớn (Neon vừa thức dậy) có thể quá 5s — mặc định transaction tương tác của Prisma.
 * Chạy trong `tenantTx` có hạn rõ ràng + `statement_timeout` cục bộ NGẮN HƠN hạn đó (Postgres huỷ câu sạch sẽ trước).
 */
export const STORAGE_MEASURE_TX_TIMEOUT_MS = 60_000;
export const STORAGE_MEASURE_TX_MAX_WAIT_MS = 10_000;
export const STORAGE_MEASURE_STATEMENT_TIMEOUT_MS = 55_000;
const HOUR_MS = 3_600_000;

/** Lỗi hết thời gian khi quét: Postgres huỷ câu (57014) hoặc transaction tương tác Prisma hết hạn (P2028). */
export function isStorageMeasureTimeout(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (!e) return false;
  if (e.code === 'P2028' || e.code === '57014' || e.meta?.code === '57014') return true;
  return typeof e.message === 'string' && /statement timeout|canceling statement|transaction already closed|expired transaction|timeout for this transaction/i.test(e.message);
}
const LOCKED_LEVELS = new Set<StorageLevel>(['LOCKED', 'HARD_LOCKED']);

export interface LevelChange {
  tenantId: string;
  from: StorageLevel;
  to: StorageLevel;
  usedBytes: number;
  quotaBytes: number;
}

export interface LevelTickResult {
  skipped: boolean;
  projects: number;
  updated: number;
  changes: LevelChange[];
  disk?: { sizeBytes: number; nearFull: boolean };
}

export interface CalibrateTickResult {
  skipped: boolean;
  calibrated: string[];
  failed: string[];
}

@Injectable()
export class StorageJob implements OnModuleInit, OnModuleDestroy {
  private levelTimer: NodeJS.Timeout | null = null;
  private calibrateTimer: NodeJS.Timeout | null = null;
  private running = false;
  private redis: Redis | null;
  private readonly ownsRedis: boolean;
  private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  readonly levelIntervalMs = resolveStorageLevelIntervalMs();
  readonly recalibrateIntervalMs = resolveStorageRecalibrateIntervalMs();
  /** Nhịp KIỂM hiệu chỉnh (≤ 1 giờ) — để mốc quá cũ được hiệu chỉnh bắt buộc ở "lượt kế" mà không chờ 24h. */
  readonly calibrateCheckMs = Math.min(this.recalibrateIntervalMs, HOUR_MS);
  private readonly defaultQuotaMb = resolveProjectStorageQuotaMb();
  private readonly diskBudgetMb = resolveDbDiskBudgetMb();
  private lastDiskCheckAt: number | null = null;
  private nearFull = false;
  /** QT6 cắm luồng cảnh báo (email/webhook/alert owner) vào đây. Lỗi trong hook không làm hỏng lượt đo. */
  readonly onLevelChange: ((c: LevelChange) => Promise<void> | void)[] = [];

  /** Đồng hồ (test thay được). */
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() redisClient?: Redis,
  ) {
    this.redis = redisClient ?? null;
    this.ownsRedis = !redisClient;
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
    this.scheduleLevel(5_000 + Math.floor(Math.random() * 10_000));
    this.scheduleCalibrate(30_000 + Math.floor(Math.random() * 60_000));
    logger.info({ levelIntervalMs: this.levelIntervalMs, recalibrateIntervalMs: this.recalibrateIntervalMs, defaultQuotaMb: this.defaultQuotaMb }, 'Storage job đã khởi động');
  }

  stop() {
    this.running = false;
    if (this.levelTimer) clearTimeout(this.levelTimer);
    if (this.calibrateTimer) clearTimeout(this.calibrateTimer);
    this.levelTimer = this.calibrateTimer = null;
    if (this.ownsRedis && this.redis) {
      const r = this.redis;
      this.redis = null;
      r.quit().catch(() => r.disconnect());
    }
  }

  private lockClient(): Redis {
    if (!this.redis) {
      const r = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', fastFailRedisOptions());
      r.on('error', (err) => logger.warn({ err: err.message }, 'Redis (storage job) lỗi'));
      this.redis = r;
    }
    return this.redis;
  }

  /** Như cleanup (MS-P2-6): giữ khoá ~90% chu kỳ, không nhả. Redis lỗi -> bỏ lượt (đo chậm một nhịp không làm sai). */
  private async acquire(key: string, intervalMs: number): Promise<boolean> {
    const ttl = Math.max(5, Math.floor((intervalMs * 0.9) / 1000));
    try {
      return (await this.lockClient().set(key, this.instanceId, 'EX', ttl, 'NX')) === 'OK';
    } catch (err: any) {
      logger.warn({ err: err?.message, key }, 'Storage job: không giành được khoá (Redis lỗi) -> bỏ lượt');
      return false;
    }
  }

  /** Một lượt cập nhật nấc có khoá. `tenantIds`: CHỈ test. */
  async runLevelOnce(tenantIds?: string[]): Promise<LevelTickResult> {
    if (!(await this.acquire(STORAGE_LEVEL_LOCK_KEY, this.levelIntervalMs))) return { skipped: true, projects: 0, updated: 0, changes: [] };
    return this.levelTick(tenantIds);
  }

  /** Lõi của lượt cập nhật nấc (không khoá). */
  async levelTick(tenantIds?: string[]): Promise<LevelTickResult> {
    const rows = await this.prisma.storageLevelTickAcrossTenants(tenantIds);
    const changes: LevelChange[] = [];
    let updated = 0;
    let locked = 0;
    for (const r of rows) {
      const prev = parseStorageLevel(r.level);
      const usedBytes = computeUsedBytes(r);
      const quotaBytes = quotaBytesFor(r.quotaMb, this.defaultQuotaMb);
      const level = levelFor(usedBytes, quotaBytes, prev);
      if (LOCKED_LEVELS.has(level)) locked++;
      try {
        projectStorageBytes.set({ tenant: r.tenantId }, usedBytes);
      } catch {
        /* metric không làm hỏng lượt */
      }
      if (usedBytes === r.usedBytes && level === r.level) continue;
      try {
        // L1: compare-and-set theo mốc đã đọc — hiệu chỉnh vừa ghi mốc mới thì số quét thật thắng, lượt sau tính lại.
        const n = await this.prisma.forTenant(r.tenantId).updateStorageUsage({ usedBytes, level, calibratedAtToken: r.calibratedAtToken ?? null });
        if (n === 0) {
          logger.debug({ tenantId: r.tenantId }, 'Storage: mốc hiệu chỉnh vừa đổi giữa lúc đọc và ghi -> bỏ ghi nấc lượt này');
          continue;
        }
        updated++;
      } catch (err: any) {
        logger.warn({ err: err?.message, tenantId: r.tenantId }, 'Storage: không ghi được nấc của project (bỏ qua, lượt sau thử lại)');
        continue;
      }
      if (level !== prev) {
        const c: LevelChange = { tenantId: r.tenantId, from: prev, to: level, usedBytes, quotaBytes };
        changes.push(c);
        await this.notifyChange(c);
      }
    }
    try {
      projectStorageLocked.set(locked);
    } catch {
      /* bỏ qua */
    }
    const disk = await this.checkGlobalDisk();
    return { skipped: false, projects: rows.length, updated, changes, ...(disk ? { disk } : {}) };
  }

  private async notifyChange(c: LevelChange): Promise<void> {
    try {
      storageLevelTransitions.inc({ from: c.from, to: c.to });
    } catch {
      /* bỏ qua */
    }
    const log = LOCKED_LEVELS.has(c.to) ? logger.warn.bind(logger) : logger.info.bind(logger);
    log({ tenantId: c.tenantId, from: c.from, to: c.to, usedBytes: c.usedBytes, quotaBytes: c.quotaBytes }, 'Storage: project đổi nấc dung lượng (ước tính)');
    for (const h of this.onLevelChange) {
      try {
        await h(c);
      } catch (err: any) {
        logger.warn({ err: err?.message, tenantId: c.tenantId }, 'Storage: hook đổi nấc lỗi (bỏ qua)');
      }
    }
  }

  /**
   * §6 (ADR-185): chốt toàn cục — tổng hạn mức được CẤP VƯỢT (10 project × 50MB = cả ổ Neon free), nên đây là lưới an toàn
   * thật. Tối đa 10 phút một lần. Hôm nay: metric `hub_storage_near_full` + log error khi vượt; mở cảnh báo operator
   * `hub.storage_near_full` qua luồng CB là việc của QT6.
   */
  private async checkGlobalDisk(): Promise<{ sizeBytes: number; nearFull: boolean } | undefined> {
    const now = this.clock();
    if (!shouldCheckGlobalDisk(this.lastDiskCheckAt, now)) return undefined;
    this.lastDiskCheckAt = now;
    try {
      const sizeBytes = await this.prisma.databaseSizeBytes();
      const nearFull = isDiskNearFull(sizeBytes, this.diskBudgetMb);
      dbSizeBytes.set(sizeBytes);
      storageNearFull.set(nearFull ? 1 : 0);
      if (nearFull && !this.nearFull) logger.error({ sizeBytes, budgetMb: this.diskBudgetMb }, 'hub.storage_near_full: database vượt 80% DB_DISK_BUDGET_MB');
      if (!nearFull && this.nearFull) logger.info({ sizeBytes, budgetMb: this.diskBudgetMb }, 'hub.storage_near_full: database đã xuống dưới 80%');
      this.nearFull = nearFull;
      return { sizeBytes, nearFull };
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Storage: không đọc được pg_database_size (bỏ qua lượt chốt toàn cục)');
      return undefined;
    }
  }

  /** Một lượt hiệu chỉnh có khoá. `tenantIds`: CHỈ test. */
  async runCalibrateOnce(tenantIds?: string[]): Promise<CalibrateTickResult> {
    if (!(await this.acquire(STORAGE_CALIBRATE_LOCK_KEY, this.calibrateCheckMs))) return { skipped: true, calibrated: [], failed: [] };
    return this.calibrateTick(tenantIds);
  }

  /** Lõi hiệu chỉnh: project đến hạn (cũ nhất trước), từng project một, không giữ transaction dài. */
  async calibrateTick(tenantIds?: string[]): Promise<CalibrateTickResult> {
    const due = calibrationDueBefore(this.clock(), this.recalibrateIntervalMs, resolveTrafficRetentionDays());
    const ids = await this.prisma.storageProjectsDueForCalibrationAcrossTenants(due, STORAGE_CALIBRATE_BATCH, tenantIds);
    const calibrated: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      if (!this.running && !tenantIds) break; // đang tắt: phần còn lại để lượt sau
      try {
        await this.calibrateProject(id);
        calibrated.push(id);
        storageCalibrations.inc({ result: 'ok' });
      } catch (err: any) {
        failed.push(id);
        const timeout = isStorageMeasureTimeout(err);
        storageCalibrations.inc({ result: timeout ? 'timeout' : 'error' });
        logger.warn(
          { err: err?.message, tenantId: id, timeout, ...(timeout ? { txTimeoutMs: STORAGE_MEASURE_TX_TIMEOUT_MS, statementTimeoutMs: STORAGE_MEASURE_STATEMENT_TIMEOUT_MS } : {}) },
          timeout ? 'Storage: quét thật project quá hạn thời gian (bỏ qua, lượt sau thử lại)' : 'Storage: hiệu chỉnh project lỗi (bỏ qua, lượt sau thử lại)',
        );
      }
    }
    if (ids.length > 0) logger.info({ calibrated: calibrated.length, failed: failed.length }, 'Storage: xong một lượt hiệu chỉnh');
    return { skipped: false, calibrated, failed };
  }

  /** Quét thật MỘT project rồi đặt lại mốc. Log chênh lệch cộng dồn ↔ quét thật (E5 checklist bước 2: > 20% thì chưa bật khoá). */
  async calibrateProject(tenantId: string): Promise<void> {
    const project = await this.prisma.findProjectById(tenantId);
    if (!project) return;
    const repo = this.prisma.forTenant(tenantId);
    const prev = await repo.findProjectUsage();
    // M2: quét trong transaction có hạn rõ ràng (không phải 5s mặc định của proxy) + statement_timeout cục bộ.
    const m = await this.prisma.tenantTx(
      tenantId,
      (tx) => this.prisma.forTenant(tenantId, tx).measureStorage({ statementTimeoutMs: STORAGE_MEASURE_STATEMENT_TIMEOUT_MS }),
      { timeout: STORAGE_MEASURE_TX_TIMEOUT_MS, maxWait: STORAGE_MEASURE_TX_MAX_WAIT_MS },
    );
    const bloatFactor = bloatFactorFrom(m.totalBytes, m.bodyRawBytes);
    const prevLevel = parseStorageLevel(prev?.level);
    const quotaBytes = quotaBytesFor((project as { storageQuotaMb?: number | null }).storageQuotaMb, this.defaultQuotaMb);
    const level = levelFor(m.totalBytes, quotaBytes, prevLevel);
    await repo.saveStorageCalibration({ calibratedBytes: m.totalBytes, bloatFactor, bySource: m.bySource, level });
    const accumulated = prev ? Number(prev.usedBytes) : null;
    logger.info(
      {
        tenantId,
        measuredBytes: m.totalBytes,
        accumulatedBytes: accumulated,
        driftPct: accumulated !== null && m.totalBytes > 0 ? Math.round(((accumulated - m.totalBytes) / m.totalBytes) * 1000) / 10 : null,
        bloatFactor,
      },
      'Storage: hiệu chỉnh (quét thật) — so số cộng dồn với số quét',
    );
    if (level !== prevLevel) await this.notifyChange({ tenantId, from: prevLevel, to: level, usedBytes: m.totalBytes, quotaBytes });
  }

  private scheduleLevel(delayMs: number) {
    if (!this.running) return;
    this.levelTimer = setTimeout(async () => {
      try {
        await this.runLevelOnce();
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Storage: lỗi trong lượt cập nhật nấc');
      } finally {
        this.scheduleLevel(this.levelIntervalMs);
      }
    }, delayMs);
    this.levelTimer.unref?.();
  }

  private scheduleCalibrate(delayMs: number) {
    if (!this.running) return;
    this.calibrateTimer = setTimeout(async () => {
      try {
        await this.runCalibrateOnce();
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Storage: lỗi trong lượt hiệu chỉnh');
      } finally {
        const jitter = Math.floor(Math.random() * 0.2 * this.calibrateCheckMs) - 0.1 * this.calibrateCheckMs; // ±10%
        this.scheduleCalibrate(this.calibrateCheckMs + jitter);
      }
    }, delayMs);
    this.calibrateTimer.unref?.();
  }
}
