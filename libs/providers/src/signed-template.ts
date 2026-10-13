import { createHmac } from 'crypto';
import { RawWebhookRequest } from '@hub/common';
import { timingSafeCompare } from '@hub/crypto';
import { GenericConfig, TimestampFormat, decodeHmacKey, templateParts } from './generic-config';

/**
 * PK3 (SPEC-provider-khac §5, E16, E2, ADR-204): verify scheme `signed-template` — S4 (Stripe, Slack, Paddle, Box, Twitch…).
 * Cả nhóm chỉ khác nhau ở dấu phân cách, vị trí timestamp và chỗ đặt chữ ký; đây là THAM SỐ, không phải biểu thức.
 *
 *   expected = encode( HMAC(algo, key(secret, keyEncoding), concat(phần của template)) )
 *   `{body}` = bytes gốc (rawBody), `{timestamp}` / `{id}` = chuỗi header ĐÚNG như nhận (không chuẩn hoá lại).
 *
 * Mọi phép so qua `timingSafeCompare`; nhiều chữ ký (xoay khoá) × nhiều secret: khớp một là đủ, KHÔNG dừng sớm.
 */

type Headers = Record<string, unknown>;

function headerValue(headers: Headers, name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

const ISO8601_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Timestamp -> giây (có thể lẻ). Sai khuôn -> null (verify false). `iso8601` nhận RFC 3339 có tới 9 chữ số lẻ (Twitch gửi
 * nano giây) — cắt về mili giây trước khi parse.
 */
export function parseTimestamp(raw: string, format: TimestampFormat): number | null {
  // Review PK3 T-1: không nhận số 0 đứng đầu — `01700000000` và `1700000000` là hai chuỗi ký khác nhau mà cùng một
  // thời điểm: ranh giới `{id}{timestamp}` / `{body}{timestamp}` dời được một byte mà vẫn trong cửa sổ.
  if (format === 'unix') return /^(0|[1-9]\d{0,11})$/.test(raw) ? Number(raw) : null;
  if (format === 'unix-ms') return /^(0|[1-9]\d{0,14})$/.test(raw) ? Number(raw) / 1000 : null;
  const m = ISO8601_RE.exec(raw);
  if (!m) return null;
  const frac = m[2] ? m[2].slice(0, 4) : '';
  const ms = Date.parse(`${m[1]}${frac}${m[3]}`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Chữ ký + timestamp request trình ra, theo `signature` của config. */
interface Presented {
  sigs: string[];
  /** Chuỗi timestamp thô (null khi template không có `{timestamp}` hoặc thiếu). */
  timestamp: string | null;
}

/**
 * kv: tách header theo `sep`, mỗi phần `khoá=giá trị` (cắt ở dấu `=` ĐẦU — base64 có `=` ở cuối). Mọi giá trị của khoá
 * `sig` đều là ứng viên (Stripe gửi nhiều `v1` khi xoay khoá; `v0` bị bỏ qua vì khác tên). Khoá timestamp xuất hiện
 * khác đúng 1 lần -> không đoán (null).
 */
export function presentedSignatures(c: GenericConfig, headers: Headers): Presented {
  const s = c.signature!;
  if ('kv' in s) {
    const raw = headerValue(headers, s.header);
    if (raw === null) return { sigs: [], timestamp: null };
    const sigs: string[] = [];
    const stamps: string[] = [];
    for (const part of raw.split(s.kv.sep)) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (v.length === 0) continue;
      if (k === s.kv.sig) sigs.push(v);
      else if (s.kv.timestamp !== undefined && k === s.kv.timestamp) stamps.push(v);
    }
    return { sigs, timestamp: stamps.length === 1 ? stamps[0] : null };
  }
  const sigs: string[] = [];
  for (const h of s.headers) {
    const v = headerValue(headers, h);
    if (v === null) continue;
    if (s.prefix === undefined) sigs.push(v);
    else if (v.startsWith(s.prefix) && v.length > s.prefix.length) sigs.push(v.slice(s.prefix.length));
  }
  return { sigs, timestamp: c.timestampHeader ? headerValue(headers, c.timestampHeader) : null };
}

/**
 * Review PK3 T-6: dạng kv — header chữ ký có mang khoá `key` không (để `diagnose` nói "thiếu khoá `t` trong
 * `stripe-signature`" thay vì "lệch giờ"). Chỉ đếm TÊN khoá, không đọc giá trị.
 */
export function kvHasKey(c: GenericConfig, headers: Headers, key: string): boolean {
  const s = c.signature!;
  if (!('kv' in s)) return false;
  const raw = headerValue(headers, s.header);
  if (raw === null) return false;
  return raw.split(s.kv.sep).some((part) => {
    const i = part.indexOf('=');
    return i > 0 && part.slice(0, i).trim() === key;
  });
}

/** Timestamp nằm trong cửa sổ `toleranceSec` quanh `nowSec`. */
export function withinTolerance(c: GenericConfig, timestamp: string | null, nowSec: number): boolean {
  if (timestamp === null || !Number.isFinite(nowSec)) return false; // review PK3 T-2: "bây giờ" hỏng -> fail-closed
  const ts = parseTimestamp(timestamp, c.timestampFormat ?? 'unix');
  if (ts === null) return false;
  return Math.abs(nowSec - ts) <= c.toleranceSec!;
}

/**
 * E2: `nowMs` = "bây giờ" — ingest thường dùng `Date.now()`; verify bù (PK6) truyền `received_at` của dòng thu.
 */
export function verifySignedTemplate(c: GenericConfig, req: RawWebhookRequest, secrets: string[], nowMs: number): boolean {
  const parts = templateParts(c.template!);
  const needTs = parts.some((p) => 'token' in p && p.token === 'timestamp');
  const needId = parts.some((p) => 'token' in p && p.token === 'id');
  const { sigs, timestamp } = presentedSignatures(c, req.headers);
  if (sigs.length === 0) return false;
  if (needTs && !withinTolerance(c, timestamp, nowMs / 1000)) return false;
  const id = needId ? headerValue(req.headers, c.idHeader!) : null;
  if (needId && id === null) return false;

  const chunks: Buffer[] = parts.map((p) => {
    if ('text' in p) return Buffer.from(p.text, 'utf8');
    if (p.token === 'body') return req.rawBody;
    return Buffer.from(p.token === 'timestamp' ? timestamp! : id!, 'utf8');
  });
  const message = Buffer.concat(chunks);
  let ok = false;
  for (const secret of secrets) {
    const key = decodeHmacKey(secret, c.keyEncoding ?? 'utf8');
    if (!key) continue;
    const expected = createHmac(c.algo ?? 'sha256', key).update(message).digest(c.encoding ?? 'hex');
    // Không dừng sớm: thời gian không lộ secret / vị trí chữ ký nào khớp.
    for (const presented of sigs) if (timingSafeCompare(presented, expected)) ok = true;
  }
  return ok;
}

/** Header mà `signed-template` cần có mặt (để `diagnose` nói thiếu cái nào) — chữ ký trước, rồi timestamp, rồi id. */
export function templateRequiredHeaders(c: GenericConfig): { signature: string[]; timestamp: string | null; id: string | null } {
  const s = c.signature!;
  const parts = templateParts(c.template!);
  return {
    signature: 'kv' in s ? [s.header] : s.headers,
    timestamp: c.timestampHeader ?? null,
    id: parts.some((p) => 'token' in p && p.token === 'id') ? c.idHeader! : null,
  };
}
