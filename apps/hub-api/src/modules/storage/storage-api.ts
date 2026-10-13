import { randomUUID } from 'crypto';
import {
  CleanRequest,
  CleanupSuggestion,
  DEFAULT_STORAGE_POLICIES,
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
  resolveSourceLimitPerProject,
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
  /** QT7 (§10, Q11): "N/20 source" — source chưa lưu trữ / trần `SOURCE_LIMIT_PER_PROJECT` (operator được miễn khi tạo). */
  sources: { count: number; limit: number };
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
    sources: {
      count: (sources as { archivedAt?: Date | null }[]).filter((s) => !s.archivedAt).length,
      limit: resolveSourceLimitPerProject(),
    },
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
  // Review QT-S2 M2: idempotent theo id TRƯỚC khi tính lại — hệ thống của user retry cùng id sau khi lượt hiệu chỉnh 24h đổi
  // `by_bucket` (gợi ý biến mất / bản lưu hết hạn) vẫn nhận CÙNG lệnh dọn, không phải 409 `suggestion_stale` (§5.6).
  const since = new Date(now - APPLY_IDEMPOTENT_MS);
  const prior = await store.tenantTx(projectId, (tx) => store.forTenant(projectId, tx).lockAndFindCleanJobForSuggestion(suggestionId, since));
  if (prior) return cleanJobView(prior);
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
    const existing = await r.lockAndFindCleanJobForSuggestion(found.id, since); // hai lần gọi song song: lần sau thấy lệnh lần đầu
    if (existing) return existing;
    return insertCleanJob(r, req, actor, { origin: 'suggestion', suggestionId: found.id, advisor: found.advisor });
  });
  return cleanJobView(job);
}

// ---------------------------------------------------------------- QT5: policy dọn tự động (§5.4, ADR-186)

export interface StoragePolicyView {
  importance: 'junk' | 'low' | 'medium';
  action: 'trim' | 'delete' | 'off';
  afterDays: number;
  trigger: 'always' | 'above_85';
  updatedBy: string;
  updatedAt: string | null;
}

export interface StoragePoliciesResponse {
  policies: StoragePolicyView[];
  /** E5: false = "Đã cài, chưa chạy (người vận hành chưa bật)" — console phải nói câu này, không giả vờ đang dọn. */
  autoCleanEnabled: boolean;
  status: 'running' | 'installed_not_running';
  message: string;
  /** Lần dọn tự động gần nhất có giải phóng gì ("Lần chạy gần nhất: … đã giải phóng X MB"). */
  lastRun: { at: string; importance: string; events: number; freedBytes: number } | null;
}

const POLICY_ORDER = ['junk', 'low', 'medium'] as const;
const MAX_AFTER_DAYS = 365;

/** `GET …/storage/policies` (scope `storage:read`): ba mức có thể đặt (thiếu dòng -> mặc định Q10, đánh dấu `system`). */
export async function getStoragePolicies(store: StorageStore, projectId: string, flags: StorageFlags): Promise<StoragePoliciesResponse> {
  const repo = store.forTenant(projectId);
  const [rows, last] = await Promise.all([repo.findStoragePolicies(), repo.findLatestAuditLog('storage.auto_clean')]);
  const by = new Map((rows as { importance: string }[]).map((r) => [r.importance, r as Record<string, unknown>]));
  const policies = POLICY_ORDER.map((imp) => {
    const r = by.get(imp);
    const d = DEFAULT_STORAGE_POLICIES.find((x) => x.importance === imp)!;
    return {
      importance: imp,
      action: ((r?.action as string) ?? d.action) as StoragePolicyView['action'],
      afterDays: Number(r?.afterDays ?? d.afterDays),
      trigger: ((r?.trigger as string) ?? d.trigger) as StoragePolicyView['trigger'],
      updatedBy: (r?.updatedBy as string) ?? 'system',
      updatedAt: r?.updatedAt instanceof Date ? r.updatedAt.toISOString() : null,
    };
  });
  const meta = (last?.metadata ?? {}) as { importance?: string; events?: number; freedBytes?: number };
  return {
    policies,
    autoCleanEnabled: flags.autoCleanEnabled,
    status: flags.autoCleanEnabled ? 'running' : 'installed_not_running',
    message: flags.autoCleanEnabled
      ? 'Đang bật dọn tự động: hub chạy các policy dưới đây mỗi lượt dọn dẹp (mức Cao và "Giữ lâu" không bao giờ bị dọn tự động).'
      : 'Đã cài, chưa chạy (người vận hành chưa bật STORAGE_AUTO_CLEAN_ENABLED). Dọn tay vẫn dùng được.',
    lastRun: last
      ? { at: last.createdAt.toISOString(), importance: String(meta.importance ?? ''), events: Number(meta.events ?? 0), freedBytes: Number(meta.freedBytes ?? 0) }
      : null,
  };
}

/**
 * `PUT …/storage/policies` (scope `storage:write`): `{ policies: [{ importance, action, afterDays, trigger }] }` — chỉ
 * junk/low/medium (Cao/Giữ KHÔNG đặt được: 400), Rác chỉ `delete`/`off`, `afterDays` nguyên 1–365 (≥ 1 ngày > sàn retry
 * window ≈ 7h16m10s sau BP5 — TOTAL_RETRY_WINDOW_MS), `trigger` `always`|`above_85`. Ghi + `audit_logs` `storage.policies.update` (trước/sau) CÙNG transaction.
 */
export async function putStoragePolicies(store: StorageStore, projectId: string, body: unknown, actor: string, flags: StorageFlags, floorMs = TOTAL_RETRY_WINDOW_MS): Promise<StoragePoliciesResponse> {
  const list = (body as { policies?: unknown } | null)?.policies;
  if (!Array.isArray(list) || list.length === 0 || list.length > POLICY_ORDER.length) {
    throw hubError('bad_request', { field: 'policies' }, 'policies là mảng 1–3 phần tử { importance, action, afterDays, trigger }');
  }
  const seen = new Set<string>();
  const rows: { importance: string; action: string; afterDays: number; trigger: string }[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const imp = raw?.importance;
    if (imp === 'high' || imp === 'keep') throw hubError('bad_request', { field: 'importance' }, 'Mức Cao và "Giữ lâu" không đặt dọn tự động được');
    if (!(POLICY_ORDER as readonly unknown[]).includes(imp)) throw hubError('bad_request', { field: 'importance' }, 'importance chỉ nhận junk, low, medium');
    if (seen.has(imp as string)) throw hubError('bad_request', { field: 'importance' }, `importance "${imp}" lặp lại`);
    seen.add(imp as string);
    const action = raw.action;
    if (action !== 'trim' && action !== 'delete' && action !== 'off') throw hubError('bad_request', { field: 'action' }, 'action là trim (Dọn), delete (Xoá hẳn) hoặc off');
    if (imp === 'junk' && action === 'trim') throw hubError('bad_request', { field: 'action' }, 'Mẫu request bị từ chối (junk) chỉ Xoá hẳn hoặc tắt');
    const afterDays = raw.afterDays;
    if (typeof afterDays !== 'number' || !Number.isInteger(afterDays) || afterDays < 1 || afterDays > MAX_AFTER_DAYS || afterDays * DAY_MS <= floorMs) {
      throw hubError('bad_request', { field: 'afterDays' }, `afterDays là số ngày nguyên 1–${MAX_AFTER_DAYS} (lớn hơn cửa sổ retry)`);
    }
    const trigger = raw.trigger ?? 'always';
    if (trigger !== 'always' && trigger !== 'above_85') throw hubError('bad_request', { field: 'trigger' }, 'trigger là always hoặc above_85');
    rows.push({ importance: imp as string, action, afterDays, trigger });
  }
  await store.tenantTx(projectId, async (tx) => {
    const r = store.forTenant(projectId, tx);
    const before = await r.findStoragePolicies();
    await r.upsertStoragePolicies(rows, actor);
    await r.createAuditLog({
      action: 'storage.policies.update',
      entityType: 'project',
      entityId: projectId,
      actor,
      metadata: {
        before: (before as { importance: string; action: string; afterDays: number; trigger: string }[]).map(({ importance, action, afterDays, trigger }) => ({ importance, action, afterDays, trigger })),
        after: rows,
        autoCleanEnabled: flags.autoCleanEnabled,
      },
    });
  });
  return getStoragePolicies(store, projectId, flags);
}

/** `GET …/storage/clean/:jobId` (scope `storage:read`) — lệnh của project khác / id rác -> 404 như không tồn tại. */
export async function getCleanJob(store: StorageStore, projectId: string, jobId: string): Promise<CleanJobView> {
  if (!UUID_RE.test(jobId)) throw hubError('not_found');
  const job = await store.forTenant(projectId).findStorageCleanJob(jobId);
  if (!job) throw hubError('not_found');
  return cleanJobView(job);
}

// ------------------------------------------------------------------ QT6 (§8): email dung lượng của CHÍNH người gọi

export type StorageEmailStore = Pick<PrismaService, 'tenantTx' | 'forTenant' | 'identity'>;

/**
 * §8 + E3: owner tắt được email 70%/85% (`project.storage_warn`) cho project này; email 95% và LOCKED KHÔNG tắt được (câu trả
 * về nói rõ). Cờ gắn THÀNH VIÊN (`project_members.storage_warn_email`, IdentityRepository); người không phải thành viên
 * (operator đi qua đường operator) -> `member: false`, email của họ theo trang Cài đặt cảnh báo.
 */
export async function getStorageEmail(store: StorageEmailStore, projectId: string, userId: string) {
  const on = await store.identity().findStorageWarnEmail(projectId, userId);
  return { member: on !== null, warnEmail: on ?? true, criticalEmail: true, lockedEmail: true };
}

export async function putStorageEmail(store: StorageEmailStore, projectId: string, userId: string, body: unknown) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || Object.keys(b).some((k) => k !== 'warnEmail') || typeof b.warnEmail !== 'boolean') {
    throw hubError('bad_request', { field: 'warnEmail' }, 'Body là {"warnEmail": true|false} — chỉ email 70%/85% tắt được');
  }
  const on = b.warnEmail;
  return store.tenantTx(projectId, async (tx) => {
    const n = await store.identity(tx).setStorageWarnEmail(projectId, userId, on);
    if (n === 0) throw hubError('bad_request', { field: 'warnEmail' }, 'Chỉ thành viên của project đổi được email dung lượng của mình — operator dùng trang Cài đặt cảnh báo');
    await store.forTenant(projectId, tx).createAuditLog({
      action: 'storage.email_changed',
      entityType: 'project',
      entityId: projectId,
      actor: userId,
      metadata: { warnEmail: on },
    });
    return { member: true, warnEmail: on, criticalEmail: true, lockedEmail: true };
  });
}
