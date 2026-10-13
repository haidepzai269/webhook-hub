import { CleanBatchResult, PrismaService, TenantScopedRepository } from '@hub/database';
import { CLEAN_BATCH_SIZE, CleanAction, quotaBytesFor, resolveProjectStorageQuotaMb } from '@hub/common';
import { retryWindowFloor } from '@hub/messaging';

/**
 * QT4/QT5 (SPEC-han-muc-dung-luong §5.1–§5.5 + E2, ADR-184): MỘT lô dọn — dùng chung cho lệnh dọn tay / áp gợi ý
 * (`StorageCleanRunner`) và dọn tự động theo policy (`CleanupJob`). Mỗi lô là MỘT transaction ngắn có hạn rõ ràng
 * (`tenantTx` + `statement_timeout` cục bộ): không giữ connection Neon (`connection_limit=1`) cho một DELETE lớn.
 *
 * Sàn cửa sổ retry (`retryWindowFloor`, cùng hằng số với `assertRetentionSafe`) áp ở ĐÂY lần nữa, không chỉ ở API: dữ liệu
 * nhận sau `now − TOTAL_RETRY_WINDOW_MS` không bao giờ bị đụng dù `cutoff` người gọi đưa vào mới hơn.
 */
// Review QT-S2 L7: tx lô ≤ 20s < SHUTDOWN_TIMEOUT_MS 25s (Render SIGKILL ~30s) — lô đang chạy lúc tắt máy kịp COMMIT/rollback
// trước khi bị giết; statement_timeout cục bộ thấp hơn tx để Postgres tự huỷ câu chậm trước khi Prisma bỏ transaction.
export const CLEAN_TX_TIMEOUT_MS = 20_000;
export const CLEAN_TX_MAX_WAIT_MS = 10_000;
export const CLEAN_STATEMENT_TIMEOUT_MS = 18_000;

export interface CleanSpec {
  action: CleanAction;
  importance: readonly string[];
  cutoff: Date;
  sourceId?: string | null;
}

export async function runCleanBatch(
  prisma: PrismaService,
  tenantId: string,
  spec: CleanSpec,
  quotaBytes: number,
  after?: (repo: TenantScopedRepository, r: CleanBatchResult) => Promise<void>,
  opts: { limit?: number; now?: number } = {},
): Promise<CleanBatchResult> {
  return prisma.tenantTx(
    tenantId,
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(CLEAN_STATEMENT_TIMEOUT_MS)}, true)`;
      const repo = prisma.forTenant(tenantId, tx);
      const r = await repo.cleanStorageBatch({
        action: spec.action,
        importance: spec.importance,
        cutoff: spec.cutoff,
        floor: retryWindowFloor(opts.now ?? Date.now()),
        sourceId: spec.sourceId ?? null,
        limit: opts.limit ?? CLEAN_BATCH_SIZE,
        quotaBytes,
      });
      if (after) await after(repo, r);
      return r;
    },
    { timeout: CLEAN_TX_TIMEOUT_MS, maxWait: CLEAN_TX_MAX_WAIT_MS },
  );
}

/** Hạn mức (byte) của project — `projects.storage_quota_mb` ghi đè hoặc `PROJECT_STORAGE_QUOTA_MB`. */
export async function projectQuotaBytes(prisma: Pick<PrismaService, 'findProjectById'>, tenantId: string, defaultMb = resolveProjectStorageQuotaMb()): Promise<number> {
  const p = (await prisma.findProjectById(tenantId)) as { storageQuotaMb?: number | null } | null;
  return quotaBytesFor(p?.storageQuotaMb ?? null, defaultMb);
}

export const toMb = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100;
