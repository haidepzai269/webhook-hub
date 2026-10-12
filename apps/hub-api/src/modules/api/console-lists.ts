import {
  AuditLogFilter,
  DeliveryHttpCode,
  DeliveryPageFilter,
  DLQ_ERROR_KINDS,
  TenantScopedRepository,
} from '@hub/database';
import {
  assertFlatQuery,
  badParam,
  isAuditId,
  Keyset,
  LIST_PAGE_SIZE,
  PageDir,
  parseEnumParam,
  parsePageCursor,
  parseTextParam,
  parseTimeRange,
  parseUuidParam,
  slicePage,
} from './list-params';

/**
 * ADR-163: danh sách console Lượt giao / DLQ / Nhật ký thao tác — phân trang Trước/Sau bằng KEYSET (list-params.ts).
 * Tách khỏi controller để test thuần (repo giả) phần quan trọng: kiểm đầu vào, chiều cursor, cắt trang.
 */

export const DELIVERY_STATUSES = ['PENDING', 'DELIVERING', 'RETRYING', 'SUCCEEDED', 'DEAD'] as const;

export interface DeliveryListQuery {
  status?: string;
  destination?: string;
  code?: string;
  errorKind?: string;
  from?: string;
  to?: string;
  before?: string;
  after?: string;
  limit?: string;
}

export interface AuditListQuery {
  actor?: string;
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
  before?: string;
  after?: string;
  limit?: string;
}

function parseLimit(v: string | undefined, max: number): number {
  if (v === undefined || v === '') return LIST_PAGE_SIZE;
  if (!/^\d{1,4}$/.test(v)) throw badParam('limit', `limit phải là số 1–${max}`);
  return Math.min(Math.max(parseInt(v, 10), 1), max);
}

/** `404` | `5xx` | `none` (chưa có phản hồi HTTP). */
export function parseHttpCode(v: string | undefined): DeliveryHttpCode | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'none') return 'none';
  if (/^[1-5]xx$/i.test(v)) return { klass: Number(v[0]) };
  if (/^[1-5]\d{2}$/.test(v)) return { exact: Number(v) };
  throw badParam('code', 'code phải là mã HTTP (vd 404), một lớp (4xx, 5xx) hoặc none');
}

type PageOf<R> = { items: R[]; next: string | null; prev: string | null };

/**
 * Chạy truy vấn theo cursor; trang "Trước" (newer) mà ít hơn `limit` dòng = đã chạm đầu danh sách -> trả lại
 * trang ĐẦU (mới nhất) đủ cỡ, `prev: null` — người xem không bao giờ thấy trang lửng ở đầu.
 */
async function runPage<R>(
  fetch: (dir: PageDir, cursor: Keyset | undefined) => Promise<R[]>,
  page: { dir: PageDir; cursor?: Keyset },
  limit: number,
  keyOf: (r: R) => Keyset,
): Promise<PageOf<R>> {
  const rows = await fetch(page.dir, page.cursor);
  if (page.dir === 'newer' && rows.length < limit) {
    return slicePage(await fetch('older', undefined), limit, 'older', false, keyOf);
  }
  return slicePage(rows, limit, page.dir, page.cursor !== undefined, keyOf);
}

export function parseDeliveryFilter(q: DeliveryListQuery, mode: 'deliveries' | 'dlq'): Omit<DeliveryPageFilter, 'dir' | 'cursor' | 'limit'> {
  const range = parseTimeRange(q.from, q.to);
  const base = {
    destinationId: parseUuidParam(q.destination, 'destination'),
    from: range.from,
    to: range.to,
  };
  if (mode === 'dlq') {
    if (q.status) throw badParam('status', 'DLQ luôn là DEAD chưa bị replay — không nhận status');
    return { ...base, dlq: true, errorKind: parseEnumParam(q.errorKind, 'errorKind', DLQ_ERROR_KINDS) };
  }
  if (q.errorKind) throw badParam('errorKind', 'errorKind chỉ dùng cho /dlq');
  return { ...base, status: parseEnumParam(q.status, 'status', DELIVERY_STATUSES), httpCode: parseHttpCode(q.code) };
}

export async function listDeliveryPage(repo: TenantScopedRepository, q: DeliveryListQuery, mode: 'deliveries' | 'dlq') {
  assertFlatQuery(q);
  const filter = parseDeliveryFilter(q, mode);
  const limit = parseLimit(q.limit, LIST_PAGE_SIZE);
  const page = parsePageCursor(q.before, q.after);
  const out = await runPage(
    async (dir, cursor) => (await repo.findDeliveryPage({ ...filter, dir, cursor, limit })).rows,
    page,
    limit,
    (r) => ({ at: r.cursorAt, id: r.id }),
  );
  return { ...out, items: out.items.map(({ cursorAt: _c, ...d }) => d) };
}

export function parseAuditFilter(q: AuditListQuery): Omit<AuditLogFilter, 'dir' | 'cursor' | 'limit'> {
  const action = parseTextParam(q.action, 'action', 64);
  if (action && !/^[a-z0-9_.]+$/.test(action)) throw badParam('action', 'action chỉ gồm a-z, 0-9, "_" và "." (vd delivery.replay, delivery.)');
  const entityType = parseTextParam(q.entityType, 'entityType', 64);
  if (entityType && !/^[a-z0-9_]+$/.test(entityType)) throw badParam('entityType', 'entityType chỉ gồm a-z, 0-9, "_" (vd delivery, source)');
  return { actor: parseTextParam(q.actor, 'actor', 128), action, entityType, ...parseTimeRange(q.from, q.to) };
}

export async function listAuditPage(repo: TenantScopedRepository, q: AuditListQuery) {
  assertFlatQuery(q);
  const filter = parseAuditFilter(q);
  const limit = parseLimit(q.limit, 200);
  const page = parsePageCursor(q.before, q.after, isAuditId);
  const out = await runPage(
    (dir, cursor) => repo.findAuditLogPage({ ...filter, dir, cursor, limit }),
    page,
    limit,
    (r) => ({ at: r.cursorAt, id: r.id.toString() }),
  );
  // id là BIGINT -> chuỗi (JSON không có bigint). `nextBefore` = tên cũ của `next` (client cũ).
  const items = out.items.map(({ cursorAt: _c, ...r }) => ({ ...r, id: r.id.toString() }));
  return { items, next: out.next, prev: out.prev, nextBefore: out.next };
}
