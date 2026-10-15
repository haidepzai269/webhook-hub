/**
 * LH2 — truy cập D1 (schema `migrations/0001_init.sql`). Mọi thay đổi nhiều câu đi qua `batch` (một transaction).
 */
import type { D1Database } from './d1';

export interface SourceSync {
  source_key: string;
  provider: string;
  ack_status: number;
  ack_type: string | null;
  ack_body: string | null;
  catch_methods: string;
}

export interface InboxRow {
  id: string;
  source_key: string;
  provider: string;
  method: string;
  target: string;
  headers_json: string;
  body: Uint8Array;
  client_ip: string;
  received_at: number;
  attempts: number;
  next_at: number;
  last_status: number | null;
  last_error: string | null;
}

export type DeadReason = 'rejected' | 'refused' | 'not_found' | 'client_error' | 'expired';

/** D1 trả BLOB dạng mảng số (Workers) hoặc Uint8Array/ArrayBuffer (node:sqlite, Miniflare) -> chuẩn hoá. */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v == null) return new Uint8Array(0);
  throw new Error('body BLOB sai kiểu');
}

const COLS = 'id, source_key, provider, method, target, headers_json, body, client_ip, received_at';

export async function getSource(db: D1Database, key: string): Promise<SourceSync | null> {
  return db
    .prepare('SELECT source_key, provider, ack_status, ack_type, ack_body, catch_methods FROM sources_sync WHERE source_key = ?1')
    .bind(key)
    .first<SourceSync>();
}

export interface CaughtRequest {
  id: string;
  sourceKey: string;
  provider: string;
  method: string;
  target: string;
  headers: Record<string, string>;
  body: Uint8Array;
  clientIp: string;
  receivedAt: number;
}

const utf8 = new TextEncoder();

/**
 * Byte của một dòng, CÙNG công thức trigger: body + headers_json + target theo UTF-8 (REVIEW-LH2 TB-2a). Header tới 128 KB
 * và URL tới 16 KB của Workers không được "miễn phí" trong trần dung lượng.
 */
export function rowBytes(r: { body: Uint8Array; headers: Record<string, string>; target: string }): number {
  return r.body.byteLength + utf8.encode(JSON.stringify(r.headers)).byteLength + utf8.encode(r.target).byteLength;
}

export interface CatchCaps {
  /** Tổng dòng hàng chờ + inbox_dead. */
  maxRows: number;
  /** Dòng chờ + chết của MỘT key (dòng chết giữ trần của key tới khi bị dọn). */
  maxPerKey: number;
  /** Tổng byte (body + header + target) hàng chờ + inbox_dead (dung lượng D1 dùng chung). */
  maxBytes: number;
  maxKeyBytes: number;
  /** Số lần hứng / ngày UTC (quota rows written của D1 free). */
  maxPerDay: number;
}

/**
 * Ghi một request vào hàng chờ, CÓ trần (§4.2 + REVIEW-LH2 TB-2): một câu INSERT … SELECT … WHERE mọi bộ đếm dưới trần
 * (bộ đếm do trigger giữ — không COUNT/SUM). Trả `false` khi vượt trần (không ghi gì). Ném lỗi khi D1 lỗi (caller 503).
 * `changes > 0` (không `=== 1`): D1 có thể đếm cả dòng trigger (REVIEW-LH2 L1).
 */
export async function insertCaught(db: D1Database, r: CaughtRequest, caps: CatchCaps): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO inbox (${COLS}, attempts, next_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, X''), ?8, ?9, 0, ?9
       WHERE COALESCE((SELECT n FROM inbox_count WHERE k = '*'), 0)
           + COALESCE((SELECT n FROM inbox_count WHERE k = '#dead'), 0) < ?10
         AND COALESCE((SELECT n FROM inbox_count WHERE k = ?2), 0) < ?11
         AND COALESCE((SELECT bytes FROM inbox_count WHERE k = '*'), 0)
           + COALESCE((SELECT bytes FROM inbox_count WHERE k = '#dead'), 0) + ?12 <= ?13
         AND COALESCE((SELECT bytes FROM inbox_count WHERE k = ?2), 0) + ?12 <= ?14
         AND COALESCE((SELECT n FROM inbox_count WHERE k = 'day:' || CAST(?9 / 86400000 AS INTEGER)), 0) < ?15`,
    )
    .bind(
      r.id, r.sourceKey, r.provider, r.method, r.target, JSON.stringify(r.headers), r.body, r.clientIp, r.receivedAt,
      caps.maxRows, caps.maxPerKey, rowBytes(r), caps.maxBytes, caps.maxKeyBytes, caps.maxPerDay,
    )
    .run();
  return res.meta.changes > 0;
}

/** Bước 1 của lượt phát lại: id + độ dài body của dòng tới hạn, theo index `next_at` (KHÔNG nạp body). */
export async function dueIds(
  db: D1Database,
  nowMs: number,
  limit: number,
): Promise<Array<{ id: string; len: number; receivedAt: number; attempts: number }>> {
  const { results } = await db
    .prepare('SELECT id, length(body) AS len, received_at, attempts FROM inbox WHERE next_at <= ?1 ORDER BY next_at LIMIT ?2')
    .bind(nowMs, limit)
    .all<{ id: string; len: number; received_at: number; attempts: number }>();
  return results.map((x) => ({ id: x.id, len: Number(x.len), receivedAt: Number(x.received_at), attempts: Number(x.attempts) }));
}

/**
 * Bước 2: giữ chỗ cả lô (lease) TRƯỚC khi gửi — lượt bị giết giữa chừng (CPU/bộ nhớ/trần truy vấn) thì dòng tự lùi
 * `until`, không đứng đầu hàng mãi (REVIEW-LH2 TB-3). Một câu, ≤ 10 tham số id.
 */
export async function leaseRows(db: D1Database, ids: string[], until: number): Promise<void> {
  if (ids.length === 0) return;
  const ph = ids.map((_, i) => `?${i + 2}`).join(', ');
  await db.prepare(`UPDATE inbox SET next_at = ?1 WHERE id IN (${ph})`).bind(until, ...ids).run();
}

/** Bước 3: nạp MỘT dòng (cả body) ngay trước khi gửi. null = dòng đã rời hàng. */
export async function loadRow(db: D1Database, id: string): Promise<InboxRow | null> {
  const r = await db
    .prepare(`SELECT ${COLS}, attempts, next_at, last_status, last_error FROM inbox WHERE id = ?1`)
    .bind(id)
    .first<InboxRow>();
  return r ? { ...r, body: toBytes(r.body) } : null;
}

export async function deleteRow(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM inbox WHERE id = ?1').bind(id).run();
}

export async function markRetry(
  db: D1Database,
  id: string,
  attempts: number,
  nextAt: number,
  status: number | null,
  error: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE inbox SET attempts = ?2, next_at = ?3, last_status = ?4, last_error = ?5 WHERE id = ?1')
    .bind(id, attempts, nextAt, status, error)
    .run();
}

/** Chuyển sang `inbox_dead` (một transaction: chép rồi xoá). */
export async function moveDead(
  db: D1Database,
  id: string,
  attempts: number,
  reason: DeadReason,
  nowMs: number,
  status: number | null,
  error: string | null,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO inbox_dead (${COLS}, attempts, last_status, last_error, reason, dead_at)
         SELECT ${COLS}, ?2, COALESCE(?3, last_status), COALESCE(?4, last_error), ?5, ?6 FROM inbox WHERE id = ?1`,
      )
      .bind(id, attempts, status, error, reason, nowMs),
    db.prepare('DELETE FROM inbox WHERE id = ?1').bind(id),
  ]);
}

/** Giữ 7 ngày (`CATCHNET_RETENTION_DAYS`) cho cả hàng chết. */
export async function purgeDead(db: D1Database, beforeMs: number, nowMs: number): Promise<number> {
  const [r] = await db.batch([
    db.prepare('DELETE FROM inbox_dead WHERE dead_at < ?1').bind(beforeMs),
    // Bộ đếm ngày cũ (giữ hôm nay + hôm qua).
    db.prepare("DELETE FROM inbox_count WHERE k LIKE 'day:%' AND CAST(substr(k, 5) AS INTEGER) < ?1").bind(Math.floor(nowMs / 86_400_000) - 1),
  ]);
  return r.meta.changes;
}

export interface SourceInput {
  key: string;
  provider: string;
  ackStatus: number;
  ackType: string | null;
  ackBody: string | null;
  catchMethods: string;
}

export function upsertSourceStmt(db: D1Database, s: SourceInput, nowMs: number, syncId: string | null) {
  return db
    .prepare(
      `INSERT INTO sources_sync (source_key, provider, ack_status, ack_type, ack_body, catch_methods, sync_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(source_key) DO UPDATE SET provider = ?2, ack_status = ?3, ack_type = ?4, ack_body = ?5,
         catch_methods = ?6, sync_id = COALESCE(?7, sync_id), updated_at = ?8`,
    )
    .bind(s.key, s.provider, s.ackStatus, s.ackType, s.ackBody, s.catchMethods, syncId, nowMs);
}

export async function deleteSource(db: D1Database, key: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM sources_sync WHERE source_key = ?1').bind(key).run();
  return r.meta.changes > 0;
}

/**
 * Kết thúc resync toàn bộ: key không có trong lượt `syncId` = source đã lưu trữ/xoá ở hub -> bỏ. Chỉ bỏ dòng CŨ HƠN
 * trang đầu của lượt này (đồng hồ Worker): source vừa được PUT lẻ trong lúc resync chạy thì giữ. Lượt RỖNG (hub không
 * còn source nào) -> mốc = `startedAt` của lời gọi cuối (REVIEW-LH2 L6).
 */
export async function finishResync(db: D1Database, syncId: string, startedAt: number): Promise<number> {
  const r = await db
    .prepare(
      `DELETE FROM sources_sync WHERE (sync_id IS NULL OR sync_id <> ?1)
         AND updated_at < COALESCE((SELECT MIN(updated_at) FROM sources_sync WHERE sync_id = ?1), ?2)`,
    )
    .bind(syncId, startedAt)
    .run();
  return r.meta.changes;
}

export interface Stats {
  pending: number;
  pendingBytes: number;
  dead: number;
  deadBytes: number;
  sources: number;
  caughtToday: number;
}

/** Đọc bộ đếm (không quét bảng inbox/inbox_dead). */
export async function stats(db: D1Database, nowMs: number): Promise<Stats> {
  const { results } = await db
    .prepare("SELECT k, n, bytes FROM inbox_count WHERE k IN ('*', '#dead', ?1)")
    .bind(`day:${Math.floor(nowMs / 86_400_000)}`)
    .all<{ k: string; n: number; bytes: number }>();
  const get = (k: string) => results.find((r) => r.k === k) ?? { n: 0, bytes: 0 };
  const src = await db.prepare('SELECT COUNT(*) AS n FROM sources_sync').first<{ n: number }>();
  return {
    pending: Number(get('*').n),
    pendingBytes: Number(get('*').bytes),
    dead: Number(get('#dead').n),
    deadBytes: Number(get('#dead').bytes),
    sources: Number(src?.n ?? 0),
    caughtToday: Number(get(`day:${Math.floor(nowMs / 86_400_000)}`).n),
  };
}
