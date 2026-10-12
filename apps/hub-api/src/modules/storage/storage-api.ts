import { randomUUID } from 'crypto';
import {
  CleanRequest,
  CleanupSuggestion,
  Importance,
  RuleAdvisor,
  StorageLevel,
  bytesByImportance,
  guardSuggestions,
  logger,
  clampBloatFactor,
  forecastHours,
  isCleanRequestError,
  parseBuckets,
  parseCleanRequest,
  parseStorageLevel,
  quotaBytesFor,
} from '@hub/common';
import { PrismaService, TenantScopedRepository } from '@hub/database';
import { TOTAL_RETRY_WINDOW_MS } from '@hub/messaging';
import { hubError } from '../errors/hub-error';
import { cleanupSuggestionsRejectedApi } from '../metrics/metrics';

/**
 * QT4 (SPEC-han-muc-dung-luong §5.5 + E2/E5, ADR-184): logic của `GET …/storage`, `POST …/storage/clean`,
 * `GET …/storage/clean/:jobId` — tách khỏi controller để console (`/api/v1/projects/:projectId/*`) và API key
 * (`/v1/p/:project/*`) dùng CHUNG một đường, test bằng store giả. Mọi truy vấn qua `forTenant(projectId)` (BB-5, RLS);
 * `findProjectById` là bảng gốc `projects` (không mang tenant_id). 0 lệnh Redis.
 */
export type StorageStore = Pick<PrismaService, 'forTenant' | 'findProjectById' | 'tenantTx'>;

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cờ an toàn E5 — đọc MỘT lần lúc dựng controller; console phải nói thật khi cờ tắt. */
export interface StorageFlags {
  lockEnabled: boolean;
  autoCleanEnabled: boolean;
}

export interface CleanJobView {
  id: string;
  status: string;
  action: string;
  importance: string[];
  olderThan: string;
  cutoff: string;
  sourceId: string | null;
  origin: string;
  suggestionId: string | null;
  advisor: string | null;
  events: number;
  rejectedSamples: number;
  freedBytes: number;
  batches: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function cleanJobView(j: {
  id: string;
  status: string;
  action: string;
  importance: string[];
  olderThan: string;
  cutoff: Date;
  sourceId: string | null;
  origin: string;
  suggestionId: string | null;
  advisor: string | null;
  eventsAffected: number;
  rejectedAffected: number;
  freedBytes: bigint | number;
  batches: number;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): CleanJobView {
  return {
    id: j.id,
    status: j.status,
    action: j.action,
    importance: j.importance,
    olderThan: j.olderThan,
    cutoff: j.cutoff.toISOString(),
    sourceId: j.sourceId,
    origin: j.origin,
    suggestionId: j.suggestionId,
    advisor: j.advisor,
    events: j.eventsAffected,
    rejectedSamples: j.rejectedAffected,
    freedBytes: Number(j.freedBytes),
    batches: j.batches,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

export interface StorageOverview {
  /** Luôn `true`: mọi con số là ƯỚC TÍNH (§2, E2) — console ghi "ước tính". */
  estimated: true;
  usedBytes: number;
  quotaBytes: number;
  usedPct: number;
  level: StorageLevel;
  measuredAt: string | null;
  /** Lần quét thật gần nhất ("hiệu chỉnh lần cuối lúc …"); `byImportance`/gợi ý tính lúc này (có thể cũ tới 24h). */
  calibratedAt: string | null;
  bloatFactor: number;
  bySource: { sourceId: string; name: string | null; keepLonger: boolean; bytes: number }[];
  byImportance: Record<Importance, { events: number; bytes: number }>;
  /** Byte/ngày ước tính = bloat × Σ byte nhận 24h gần nhất. */
  growthPerDay: number;
  /** "Còn ~X giờ trước khi đầy" — null khi không tăng. */
  forecastHours: number | null;
  suggestions: unknown[];
  suggestionsAt: string | null;
  /** E5: `STORAGE_LOCK_ENABLED` — false = vượt hạn mức vẫn nhận (console nói thật). */
  lockEnabled: boolean;
  /** E5: `STORAGE_AUTO_CLEAN_ENABLED` — false = policy đã cài nhưng chưa chạy (người vận hành chưa bật). */
  autoCleanEnabled: boolean;
  recentCleanJobs: CleanJobView[];
}

/** `GET …/storage` (scope `storage:read`). */
export async function getStorageOverview(store: StorageStore, projectId: string, flags: StorageFlags, now = Date.now()): Promise<StorageOverview> {
  const repo = store.forTenant(projectId);
  const [project, usage, sources, traffic24h, jobs] = await Promise.all([
    store.findProjectById(projectId),
    repo.findProjectUsage(),
    repo.findSources({}),
    repo.trafficBytesSince(new Date(now - DAY_MS)),
    repo.listStorageCleanJobs(5),
  ]);
  if (!project) throw hubError('not_found');
  const quotaBytes = quotaBytesFor((project as { storageQuotaMb?: number | null }).storageQuotaMb ?? null);
  const usedBytes = Number(usage?.usedBytes ?? 0);
  const bloat = clampBloatFactor(Number(usage?.bloatFactor ?? 2));
  const names = new Map((sources as { id: string; name: string; keepLonger?: boolean }[]).map((s) => [s.id, s]));
  const bySourceRaw = (usage?.bySource ?? {}) as Record<string, unknown>;
  const bySource = Object.entries(bySourceRaw)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([sourceId, v]) => ({ sourceId, name: names.get(sourceId)?.name ?? null, keepLonger: names.get(sourceId)?.keepLonger === true, bytes: Number(v) }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    estimated: true,
    usedBytes,
    quotaBytes,
    usedPct: quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 1000) / 10 : 0,
    level: parseStorageLevel(usage?.level),
    measuredAt: usage?.measuredAt?.toISOString() ?? null,
    calibratedAt: usage?.calibratedAt?.toISOString() ?? null,
    bloatFactor: bloat,
    bySource,
    byImportance: bytesByImportance(parseBuckets(usage?.byBucket)),
    growthPerDay: Math.round(bloat * traffic24h),
    forecastHours: forecastHours(usedBytes, quotaBytes, bloat, traffic24h),
    suggestions: Array.isArray(usage?.suggestions) ? (usage!.suggestions as unknown[]) : [],
    suggestionsAt: usage?.calibratedAt?.toISOString() ?? null,
    lockEnabled: flags.lockEnabled,
    autoCleanEnabled: flags.autoCleanEnabled,
    recentCleanJobs: jobs.map(cleanJobView),
  };
}

/**
 * `POST …/storage/clean` (scope `storage:write`): kiểm request (400 `bad_request` + `field` — `olderThan` mới hơn sàn retry
 * window, `high` thiếu `confirmHigh`, `keep`, `junk` + `trim`…), rồi ghi lệnh PENDING + `audit_logs`
 * `storage.clean.requested` trong CÙNG transaction. Worker chạy theo lô. Trả view của lệnh (controller trả 202).
 */
export async function createCleanJob(
  store: StorageStore,
  projectId: string,
  body: unknown,
  actor: string,
  opts: { origin?: 'manual' | 'suggestion'; suggestionId?: string; advisor?: string; floorMs?: number; now?: number } = {},
): Promise<CleanJobView> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw hubError('bad_request', {}, 'Body phải là object JSON');
  const now = opts.now ?? Date.now();
  const req = parseCleanRequest(body as Record<string, unknown>, opts.floorMs ?? TOTAL_RETRY_WINDOW_MS, now);
  if (isCleanRequestError(req)) throw hubError('bad_request', { field: req.field }, req.message);
  const repo = store.forTenant(projectId);
  if (req.sourceId) {
    const src = (await repo.findSourceById(req.sourceId, { includeArchived: true })) as { keepLonger?: boolean } | null;
    if (!src) throw hubError('bad_request', { field: 'sourceId' }, 'sourceId không phải source của project này');
    if (src.keepLonger) throw hubError('bad_request', { field: 'sourceId' }, 'Source đang "Giữ lâu" — bỏ cờ "Giữ lâu" trước khi dọn source này');
  }
  const job = await store.tenantTx(projectId, (tx) => insertCleanJob(store.forTenant(projectId, tx), req, actor, opts));
  return cleanJobView(job);
}

/** Ghi lệnh PENDING + `audit_logs` `storage.clean.requested` trên repo ĐÃ dựng trong transaction của người gọi. */
async function insertCleanJob(
  r: TenantScopedRepository,
  req: CleanRequest,
  actor: string,
  opts: { origin?: 'manual' | 'suggestion'; suggestionId?: string; advisor?: string },
) {
  const id = randomUUID();
  const created = await r.createStorageCleanJob({
    id,
    action: req.action,
    importance: req.importance,
    olderThan: req.olderThan.label,
    cutoff: req.olderThan.cutoff,
    sourceId: req.sourceId,
    origin: opts.origin ?? 'manual',
    suggestionId: opts.suggestionId ?? null,
    advisor: opts.advisor ?? null,
    requestedBy: actor,
  });
  await r.createAuditLog({
    action: 'storage.clean.requested',
    entityType: 'storage_clean_job',
    entityId: id,
    actor,
    metadata: {
      action: req.action,
      importance: req.importance,
      olderThan: req.olderThan.label,
      cutoff: req.olderThan.cutoff.toISOString(),
      sourceId: req.sourceId,
      origin: opts.origin ?? 'manual',
      // §5.6: áp dụng gợi ý -> audit ghi rõ AI (advisor nào) đã gợi ý
      ...(opts.suggestionId ? { suggestionId: opts.suggestionId, advisor: opts.advisor ?? null } : {}),
    },
  });
  return created;
}

const SUGGESTION_ID_RE = /^sug_[0-9a-f]{24}$/;
const APPLY_IDEMPOTENT_MS = 86_400_000;

/**
 * `POST …/storage/suggestions/:id/apply` (scope `storage:write`, console hoặc API key — §5.6). Hub TÍNH LẠI gợi ý tại thời
 * điểm gọi (advisor `rules@1` trên `by_bucket` hiện có) và cho qua hàng rào lần nữa:
 *  - id không còn trong bộ hiện tại, hoặc bản đã lưu (đã gửi cho user) hết hạn -> 409 `suggestion_stale` + `suggestions`
 *    (bộ mới — cũng được lưu thay bộ cũ để lần gọi sau với id còn hợp lệ đi qua);
 *  - idempotent theo id: gọi lại trong 24h -> trả CÙNG lệnh dọn (khoá advisory theo (project, id) trong transaction);
 *  - tạo lệnh dọn như `POST …/storage/clean` (202 + id), audit ghi `suggestionId` + `advisor`.
 * Advisor chỉ gợi ý — thực thi chỉ qua lệnh dọn này (user/hệ thống của user quyết).
 */
export async function applySuggestion(
  store: StorageStore,
  projectId: string,
  suggestionId: string,
  actor: string,
  opts: { floorMs?: number; now?: number } = {},
): Promise<CleanJobView> {
  if (!SUGGESTION_ID_RE.test(suggestionId)) throw hubError('not_found');
  const now = opts.now ?? Date.now();
  const floorMs = opts.floorMs ?? TOTAL_RETRY_WINDOW_MS;
  const repo = store.forTenant(projectId);
  const [project, usage, policies, keepLongerSourceIds, traffic24h] = await Promise.all([
    store.findProjectById(projectId),
    repo.findProjectUsage(),
    repo.findStoragePolicies(),
    repo.findKeepLongerSourceIds(),
    repo.trafficBytesSince(new Date(now - DAY_MS)),
  ]);
  if (!project) throw hubError('not_found');
  const buckets = parseBuckets(usage?.byBucket);
  const quotaBytes = quotaBytesFor((project as { storageQuotaMb?: number | null }).storageQuotaMb ?? null);
  const advisor = new RuleAdvisor(() => now);
  const raw = await advisor.suggest({
    usedBytes: Number(usage?.usedBytes ?? 0),
    quotaBytes,
    level: parseStorageLevel(usage?.level),
    growthPerDay: Math.round(clampBloatFactor(Number(usage?.bloatFactor ?? 2)) * traffic24h),
    buckets,
    policies: (policies as { importance: string; action: string; afterDays: number; trigger: string }[]).map((p) => ({
      importance: p.importance as 'junk' | 'low' | 'medium',
      action: p.action as 'trim' | 'delete' | 'off',
      afterDays: p.afterDays,
      trigger: p.trigger as 'always' | 'above_85',
    })),
    keepLongerSourceIds,
  });
  const g = guardSuggestions(raw, { buckets, keepLongerSourceIds, floorMs, now });
  for (const x of g.rejected) {
    cleanupSuggestionsRejectedApi.inc({ advisor: x.advisor });
    logger.warn({ projectId, advisor: x.advisor, reason: x.reason }, 'Storage apply: gợi ý bị hàng rào an toàn loại');
  }
  const fresh = g.accepted;
  const stored = (Array.isArray(usage?.suggestions) ? (usage!.suggestions as Partial<CleanupSuggestion>[]) : []).find((x) => x?.id === suggestionId);
  const found = fresh.find((x) => x.id === suggestionId);
  const expired = !!stored && !(Date.parse(String(stored.expiresAt)) > now);
  if (!found || expired) {
    await repo.saveStorageSuggestions(fresh);
    throw hubError(
      'suggestion_stale',
      { suggestions: fresh },
      expired ? 'Gợi ý đã hết hạn — đây là bộ gợi ý vừa tính lại' : 'Gợi ý không còn trong bộ hiện tại (dữ liệu đã đổi) — đây là bộ gợi ý vừa tính lại',
    );
  }
  const req = parseCleanRequest({ action: found.action, importance: found.importance, olderThan: found.olderThan, sourceId: found.sourceId }, floorMs, now);
  if (isCleanRequestError(req)) throw hubError('suggestion_stale', { suggestions: fresh }, req.message);
  const job = await store.tenantTx(projectId, async (tx) => {
    const r = store.forTenant(projectId, tx);
    const existing = await r.lockAndFindCleanJobForSuggestion(found.id, new Date(now - APPLY_IDEMPOTENT_MS));
    if (existing) return existing;
    return insertCleanJob(r, req, actor, { origin: 'suggestion', suggestionId: found.id, advisor: found.advisor });
  });
  return cleanJobView(job);
}

/** `GET …/storage/clean/:jobId` (scope `storage:read`) — lệnh của project khác / id rác -> 404 như không tồn tại. */
export async function getCleanJob(store: StorageStore, projectId: string, jobId: string): Promise<CleanJobView> {
  if (!UUID_RE.test(jobId)) throw hubError('not_found');
  const job = await store.forTenant(projectId).findStorageCleanJob(jobId);
  if (!job) throw hubError('not_found');
  return cleanJobView(job);
}
