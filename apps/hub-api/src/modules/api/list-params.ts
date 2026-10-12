import { HttpException } from '@nestjs/common';
import { hubError } from '../errors/hub-error';

/**
 * Tham số danh sách console (ADR-163): KEYSET cursor, không bao giờ OFFSET — danh sách lớn dần ở ĐẦU (dòng mới
 * chèn trên cùng), OFFSET làm trang trôi -> trùng/sót dòng. Thứ tự toàn phần = bộ `(created_at, id)` giảm dần:
 * `created_at` có thể trùng (cùng µs, cùng lô INSERT), `id` phá thế hoà nên mỗi dòng có đúng một vị trí.
 *
 * Phân trang Trước/Sau: `before=<cursor>` = trang CŨ HƠN (dòng xếp sau cursor), `after=<cursor>` = trang MỚI HƠN
 * (dòng xếp trước cursor). Response trả `next` (cursor dòng cuối, nếu còn cũ hơn) và `prev` (cursor dòng đầu, nếu
 * còn mới hơn). Cursor là base64url của `["YYYY-MM-DDTHH:MM:SS.ffffff", "<id>"]` — giờ UTC đủ µs (timestamptz(6)),
 * vì `Date` của JS chỉ giữ ms: cắt về ms là hai dòng cùng ms khác µs bị nhảy cóc.
 * Lỗi đầu vào -> 400 `bad_request` kèm `field` (docs/ERRORS.md).
 */

export const LIST_PAGE_SIZE = 50;

export function badParam(field: string, message: string): HttpException {
  return hubError('bad_request', { field }, message);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mốc µs UTC đúng dạng `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US')` sinh ra. */
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
/** Truy vấn chuỗi: thời điểm ISO 8601 có ngày (giờ + múi tuỳ chọn). Epoch số / chuỗi lạ -> 400. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface Keyset {
  /** UTC, µs: `YYYY-MM-DDTHH:MM:SS.ffffff`. */
  at: string;
  id: string;
}

export type PageDir = 'older' | 'newer';

/**
 * Query string của Express có thể là MẢNG (`?a=1&a=2`) hoặc object (`?a[b]=1`) — mọi khoá danh sách phải là MỘT chuỗi,
 * khác đi là 400 (không bao giờ để `.trim()` trên mảng thành 500).
 */
export function assertFlatQuery(q: object | undefined | null): void {
  if (!q) return;
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && typeof v !== 'string') throw badParam(k, `${k} chỉ nhận một giá trị chuỗi`);
  }
}

function asString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badParam(field, `${field} chỉ nhận một giá trị chuỗi`);
  return v;
}

/** Mốc `YYYY-MM-DDTHH:MM:SS.ffffff` có thật trên lịch (tháng 13, giờ 25… -> false), năm ≥ 1970, không chỉ đúng dạng. */
export function isRealUtcInstant(at: string): boolean {
  const d = new Date(`${at.slice(0, 23)}Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 1970 && d.toISOString().slice(0, 19) === at.slice(0, 19);
}

/** id audit: BIGINT có dấu — tối đa 9223372036854775807. */
export const AUDIT_ID_MAX = BigInt('9223372036854775807');
export function isAuditId(id: string): boolean {
  return /^\d{1,19}$/.test(id) && BigInt(id) <= AUDIT_ID_MAX;
}
export function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

export function encodeKeyset(k: Keyset): string {
  return Buffer.from(JSON.stringify([k.at, k.id])).toString('base64url');
}

/** `idOk`: dạng id hợp lệ của bảng (uuid cho deliveries; bigint cho audit). */
export function decodeKeyset(raw: string, field: string, idOk: (id: string) => boolean = isUuid): Keyset {
  try {
    if (typeof raw !== 'string' || raw.length > 200) throw new Error();
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2) throw new Error();
    const [at, id] = v;
    if (typeof at !== 'string' || typeof id !== 'string' || !CURSOR_AT_RE.test(at) || !isRealUtcInstant(at) || !idOk(id)) throw new Error();
    return { at, id };
  } catch {
    throw badParam(field, `${field} không phải cursor hợp lệ — dùng đúng giá trị next/prev của trang trước`);
  }
}

/** `before` (cũ hơn) XOR `after` (mới hơn); không có = trang đầu (mới nhất). */
export function parsePageCursor(
  beforeRaw: unknown,
  afterRaw: unknown,
  idOk?: (id: string) => boolean,
): { dir: PageDir; cursor?: Keyset } {
  const before = asString(beforeRaw, 'before');
  const after = asString(afterRaw, 'after');
  if (before && after) throw badParam('before', 'Chỉ truyền một trong before / after');
  if (after) return { dir: 'newer', cursor: decodeKeyset(after, 'after', idOk) };
  if (before) return { dir: 'older', cursor: decodeKeyset(before, 'before', idOk) };
  return { dir: 'older' };
}

export function parseUuidParam(raw: unknown, field: string): string | undefined {
  const v = asString(raw, field);
  if (v === undefined || v === '') return undefined;
  if (!UUID_RE.test(v)) throw badParam(field, `${field} phải là UUID`);
  return v.toLowerCase();
}

export function parseTimeParam(raw: unknown, field: string): Date | undefined {
  const v = asString(raw, field);
  if (v === undefined || v === '') return undefined;
  const s = v.trim();
  if (!ISO_RE.test(s)) throw badParam(field, `${field} phải là thời điểm ISO 8601 (vd 2026-10-10T00:00:00Z)`);
  const d = new Date(s);
  // `new Date` của JS tràn ngày (31/02 -> 03/03) — so lại tháng/ngày để 400 thay vì lọc nhầm.
  const [y, m, day] = s.slice(0, 10).split('-').map(Number);
  const sane = m >= 1 && m <= 12 && day >= 1 && day <= daysIn(y, m);
  if (Number.isNaN(d.getTime()) || !sane || d.getUTCFullYear() < 1970 || d.getUTCFullYear() > 9999) {
    throw badParam(field, `${field} không phải thời điểm hợp lệ`);
  }
  return d;
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function parseTimeRange(from: unknown, to: unknown): { from?: Date; to?: Date } {
  const r = { from: parseTimeParam(from, 'from'), to: parseTimeParam(to, 'to') };
  if (r.from && r.to && r.from > r.to) throw badParam('from', 'from phải ≤ to');
  return r;
}

/** Chuỗi lọc tự do (actor, action…): cắt khoảng trắng, tối đa `max` ký tự; rỗng = không lọc. */
export function parseTextParam(raw: unknown, field: string, max = 128): string | undefined {
  const v = asString(raw, field);
  if (v === undefined) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > max) throw badParam(field, `${field} dài tối đa ${max} ký tự`);
  return s;
}

export function parseEnumParam<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T | undefined {
  const v = asString(raw, field);
  if (v === undefined || v === '') return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw badParam(field, `${field} phải là một trong: ${allowed.join(', ')}`);
  return v as T;
}

/**
 * Cắt trang từ `limit + 1` dòng đã truy vấn theo hướng `dir` (older: giảm dần; newer: TĂNG dần sát cursor) —
 * luôn trả `items` giảm dần (mới nhất trên cùng) cùng cursor hai đầu.
 * - older: còn dòng thứ limit+1 -> có `next`; có cursor (đã đi lùi ít nhất một trang) -> có `prev`.
 * - newer: còn dòng thứ limit+1 -> còn mới hơn nữa -> có `prev`; luôn có `next` (cursor mình vừa rời).
 */
export function slicePage<R>(
  rows: R[],
  limit: number,
  dir: PageDir,
  hadCursor: boolean,
  keyOf: (r: R) => Keyset,
): { items: R[]; next: string | null; prev: string | null } {
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (dir === 'newer') page.reverse();
  const first = page[0];
  const last = page[page.length - 1];
  const hasOlder = dir === 'older' ? more : hadCursor;
  const hasNewer = dir === 'older' ? hadCursor : more;
  return {
    items: page,
    next: hasOlder && last ? encodeKeyset(keyOf(last)) : null,
    prev: hasNewer && first ? encodeKeyset(keyOf(first)) : null,
  };
}
