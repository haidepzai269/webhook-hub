import type { Importance } from './importance';

/**
 * QT4 (SPEC-han-muc-dung-luong §5.1–§5.2, §5.5, ADR-184): hợp đồng của LỆNH DỌN — hàm THUẦN dùng chung cho hub-api
 * (kiểm request `POST …/storage/clean`, `apply`), hub-worker (chạy lô, dọn tự động) và bộ gợi ý (QT4b).
 * Thuật ngữ cho người đọc: "Dọn" (`trim` — bỏ nội dung, giữ dòng gầy, BB-2 còn) và "Xoá hẳn" (`delete` — mất chống trùng).
 */
export const CLEAN_ACTIONS = ['trim', 'delete'] as const;
export type CleanAction = (typeof CLEAN_ACTIONS)[number];

/**
 * Mức được nêu trong lệnh dọn tay. "Giữ" (`keep`) KHÔNG có: source "Giữ lâu" là cờ user tự gắn — muốn dọn thì bỏ cờ trước
 * (không có lối tắt vòng qua cờ). "Cao" (`high`) có nhưng phải kèm `confirmHigh: true` (hộp xác nhận riêng, §5.3).
 */
export const CLEAN_IMPORTANCES = ['junk', 'low', 'medium', 'high'] as const;
export type CleanImportance = (typeof CLEAN_IMPORTANCES)[number];

/** Số dòng mỗi lô (§5.5: "ví dụ 1000 dòng/lô") — mỗi lô một transaction ngắn, không giữ connection Neon. */
export const CLEAN_BATCH_SIZE = 1000;

/** "Dọn" giải phóng ~90% (§5.1): body/payload/phản hồi đi, dòng gầy + khoá chống trùng ở lại. Dùng để ƯỚC TÍNH trước. */
export const TRIM_FREE_RATIO = 0.9;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DURATION_RE = /^([1-9]\d{0,3})([dh])$/;

export interface ParsedOlderThan {
  /** Dọn dữ liệu nhận TRƯỚC mốc này. */
  cutoff: Date;
  /** Chuỗi đã chuẩn hoá (`3d`, `12h`, hoặc ISO) — lưu vào lệnh dọn, tính id gợi ý. */
  label: string;
  /** Tuổi tối thiểu (ngày, làm tròn xuống) — để cộng `by_bucket` theo ngày. Mốc tuyệt đối -> tính theo `now`. */
  minAgeDays: number;
}

/**
 * `olderThan`: khoảng tương đối `<n>d` / `<n>h` (gợi ý dùng dạng này -> id ổn định giữa hai lần chạy) hoặc mốc ISO 8601 có
 * múi giờ. Sai dạng -> null (người gọi trả 400). KHÔNG kiểm sàn retry window ở đây (xem `isCutoffOutsideRetryWindow`).
 */
export function parseOlderThan(v: unknown, now: number = Date.now()): ParsedOlderThan | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return null;
  const m = DURATION_RE.exec(v);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === 'd' ? n * DAY_MS : n * HOUR_MS;
    return { cutoff: new Date(now - ms), label: `${n}${m[2]}`, minAgeDays: Math.floor(ms / DAY_MS) };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > now) return null;
  return { cutoff: new Date(t), label: new Date(t).toISOString(), minAgeDays: Math.floor((now - t) / DAY_MS) };
}

export interface CleanRequestInput {
  action?: unknown;
  importance?: unknown;
  olderThan?: unknown;
  sourceId?: unknown;
  confirmHigh?: unknown;
}

export interface CleanRequest {
  action: CleanAction;
  importance: CleanImportance[];
  olderThan: ParsedOlderThan;
  sourceId: string | null;
}

export type CleanRequestError = { field: 'action' | 'importance' | 'olderThan' | 'sourceId' | 'confirmHigh'; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kiểm body của lệnh dọn (§5.5). `floorMs` = cửa sổ retry (`TOTAL_RETRY_WINDOW_MS`, @hub/messaging) do người gọi truyền —
 * libs/common không phụ thuộc messaging. Trả lỗi đầu tiên theo trường (câu tiếng Việt cho console).
 */
export function parseCleanRequest(body: CleanRequestInput | null | undefined, floorMs: number, now: number = Date.now()): CleanRequest | CleanRequestError {
  const b = body ?? {};
  if (!(CLEAN_ACTIONS as readonly unknown[]).includes(b.action)) return { field: 'action', message: 'action là "trim" (Dọn) hoặc "delete" (Xoá hẳn)' };
  const action = b.action as CleanAction;
  if (!Array.isArray(b.importance) || b.importance.length === 0 || b.importance.length > CLEAN_IMPORTANCES.length) {
    return { field: 'importance', message: 'importance là mảng 1–4 mức trong junk, low, medium, high' };
  }
  if ((b.importance as unknown[]).includes('keep')) {
    return { field: 'importance', message: 'Event của source "Giữ lâu" không dọn được qua lệnh này — bỏ cờ "Giữ lâu" của source trước' };
  }
  if (!(b.importance as unknown[]).every((i) => (CLEAN_IMPORTANCES as readonly unknown[]).includes(i))) {
    return { field: 'importance', message: 'importance chỉ nhận junk, low, medium, high' };
  }
  const importance = [...new Set(b.importance as CleanImportance[])].sort((x, y) => CLEAN_IMPORTANCES.indexOf(x) - CLEAN_IMPORTANCES.indexOf(y));
  if (action === 'trim' && importance.includes('junk')) {
    return { field: 'importance', message: 'Mẫu request bị từ chối (junk) chỉ "Xoá hẳn" được, không "Dọn"' };
  }
  if (importance.includes('high') && b.confirmHigh !== true) {
    return { field: 'confirmHigh', message: 'Mức Cao (event giao lỗi chưa xử lý / vừa replay) cần confirmHigh: true' };
  }
  const olderThan = parseOlderThan(b.olderThan, now);
  if (!olderThan) return { field: 'olderThan', message: 'olderThan là "<n>d" / "<n>h" (vd "3d") hoặc mốc ISO 8601 có múi giờ, không ở tương lai' };
  if (olderThan.cutoff.getTime() > now - floorMs) {
    return { field: 'olderThan', message: `olderThan quá mới: dữ liệu trong ${Math.ceil(floorMs / 60_000)} phút gần nhất có thể còn đang retry — chọn mốc cũ hơn` };
  }
  let sourceId: string | null = null;
  if (b.sourceId !== undefined && b.sourceId !== null) {
    if (typeof b.sourceId !== 'string' || !UUID_RE.test(b.sourceId)) return { field: 'sourceId', message: 'sourceId là UUID của một source trong project' };
    sourceId = b.sourceId.toLowerCase();
  }
  return { action, importance, olderThan, sourceId };
}

export function isCleanRequestError(x: CleanRequest | CleanRequestError): x is CleanRequestError {
  return (x as CleanRequestError).field !== undefined && (x as CleanRequest).action === undefined;
}

// ---------------------------------------------------------------- by_bucket (§7 + E2: tính trong lượt hiệu chỉnh)

/** Một ô của `project_usage.by_bucket`: byte + số event CHƯA dọn theo (source, mức quan trọng, tuổi tính bằng ngày). */
export interface StorageBucket {
  sourceId: string | null;
  importance: Importance;
  /** Tuổi (ngày, làm tròn xuống) lúc hiệu chỉnh; ô cuối gộp mọi tuổi ≥ `BUCKET_MAX_AGE_DAYS`. */
  ageDays: number;
  events: number;
  bytes: number;
}

export const BUCKET_MAX_AGE_DAYS = 30;

/** Đọc `by_bucket` (jsonb) an toàn — dòng hỏng bị bỏ. */
export function parseBuckets(v: unknown): StorageBucket[] {
  if (!Array.isArray(v)) return [];
  const out: StorageBucket[] = [];
  for (const x of v) {
    const r = x as Partial<StorageBucket> | null;
    if (!r || typeof r !== 'object') continue;
    if (typeof r.importance !== 'string' || !Number.isFinite(r.ageDays) || !Number.isFinite(r.events) || !Number.isFinite(r.bytes)) continue;
    out.push({ sourceId: typeof r.sourceId === 'string' ? r.sourceId : null, importance: r.importance as Importance, ageDays: Number(r.ageDays), events: Number(r.events), bytes: Number(r.bytes) });
  }
  return out;
}

/**
 * Ước tính (event, byte) một lệnh dọn sẽ đụng, tính từ `by_bucket` — dùng cho số MB của gợi ý và hàng rào QT4b (tính lại,
 * không tin số advisor đưa). "Dọn" chỉ giải phóng ~90%.
 */
export function estimateClean(buckets: readonly StorageBucket[], q: { action: CleanAction; importance: readonly string[]; minAgeDays: number; sourceId?: string | null }): { events: number; bytes: number } {
  let events = 0;
  let bytes = 0;
  for (const b of buckets) {
    if (!q.importance.includes(b.importance)) continue;
    if (b.ageDays < q.minAgeDays) continue;
    if (q.sourceId && b.sourceId !== q.sourceId) continue;
    events += b.events;
    bytes += b.bytes;
  }
  return { events, bytes: Math.round(q.action === 'trim' ? bytes * TRIM_FREE_RATIO : bytes) };
}

/** Byte + event theo mức quan trọng (khối "theo mức quan trọng" của console). */
export function bytesByImportance(buckets: readonly StorageBucket[]): Record<Importance, { events: number; bytes: number }> {
  const out = { junk: { events: 0, bytes: 0 }, low: { events: 0, bytes: 0 }, medium: { events: 0, bytes: 0 }, high: { events: 0, bytes: 0 }, keep: { events: 0, bytes: 0 } } as Record<Importance, { events: number; bytes: number }>;
  for (const b of buckets) {
    const o = out[b.importance];
    if (!o) continue;
    o.events += b.events;
    o.bytes += b.bytes;
  }
  return out;
}

/** E5: `STORAGE_AUTO_CLEAN_ENABLED` — mặc định 0 (production chưa tự dọn tới khi Admin bật). Chỉ "1"/"true" là bật. */
export function resolveStorageAutoCleanEnabled(v: string | undefined = process.env.STORAGE_AUTO_CLEAN_ENABLED): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}
