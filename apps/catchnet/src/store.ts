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

/**
 * Ghi một request vào hàng chờ, CÓ trần (§4.2): một câu INSERT … SELECT … WHERE đếm < trần (bộ đếm do trigger giữ,
 * không COUNT(*)). Trả `false` khi vượt trần (không ghi gì). Ném lỗi khi D1 lỗi (caller trả 503).
 */
export async function insertCaught(db: D1Database, r: CaughtRequest, caps: { maxRows: number; maxPerKey: number }): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO inbox (${COLS}, attempts, next_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, X''), ?8, ?9, 0, ?9 -- body rỗng (GET) không thành NULL
       WHERE COALESCE((SELECT n FROM inbox_count WHERE k = '*'), 0) < ?10
         AND COALESCE((SELECT n FROM inbox_count WHERE k = ?2), 0) < ?11`,
    )
    .bind(r.id, r.sourceKey, r.provider, r.method, r.target, JSON.stringify(r.headers), r.body, r.clientIp, r.receivedAt, caps.maxRows, caps.maxPerKey)
    .run();
  return res.meta.changes === 1;
}

/** Dòng tới hạn, theo `next_at` (index — đọc đúng `limit` dòng). */
export async function dueRows(db: D1Database, nowMs: number, limit: number): Promise<InboxRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS}, attempts, next_at, last_status, last_error FROM inbox WHERE next_at <= ?1 ORDER BY next_at LIMIT ?2`)
    .bind(nowMs, limit)
    .all<InboxRow>();
  return results.map((r) => ({ ...r, body: toBytes(r.body) }));
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
        `INSERT OR REPLACE INTO inbox_dead (${COLS}, attempts, last_status, last_error, reason, dead_at)
         SELECT ${COLS}, ?2, ?3, ?4, ?5, ?6 FROM inbox WHERE id = ?1`,
      )
      .bind(id, attempts, status, error, reason, nowMs),
    db.prepare('DELETE FROM inbox WHERE id = ?1').bind(id),
  ]);
}

/** Giữ 7 ngày (`CATCHNET_RETENTION_DAYS`) cho cả hàng chết. */
export async function purgeDead(db: D1Database, beforeMs: number): Promise<number> {
  const r = await db.prepare('DELETE FROM inbox_dead WHERE dead_at < ?1').bind(beforeMs).run();
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
 * trang đầu của lượt này (đồng hồ Worker): source vừa được PUT lẻ trong lúc resync chạy thì giữ.
 */
export async function finishResync(db: D1Database, syncId: string): Promise<number> {
  const r = await db
    .prepare(
      `DELETE FROM sources_sync WHERE (sync_id IS NULL OR sync_id <> ?1)
         AND updated_at < (SELECT MIN(updated_at) FROM sources_sync WHERE sync_id = ?1)`,
    )
    .bind(syncId)
    .run();
  return r.meta.changes;
}

export async function stats(db: D1Database): Promise<{ pending: number; dead: number; sources: number }> {
  const [p, d, s] = await db.batch([
    db.prepare("SELECT COALESCE((SELECT n FROM inbox_count WHERE k = '*'), 0) AS n"),
    db.prepare('SELECT COUNT(*) AS n FROM inbox_dead'),
    db.prepare('SELECT COUNT(*) AS n FROM sources_sync'),
  ]);
  const n = (x: { results: unknown[] }) => Number((x.results[0] as { n: number } | undefined)?.n ?? 0);
  return { pending: n(p), dead: n(d), sources: n(s) };
}
