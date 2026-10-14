import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import * as net from 'net';

/**
 * LH3 (SPEC-hub-sap §5 + ĐÍNH CHÍNH H3/H5, ADR-217): header của lưới hứng (Cloudflare Worker) khi chuyển tiếp / phát lại
 * vào `/hooks/*`. Worker KHÔNG giữ secret của provider và không verify; nó chỉ ký những gì NÓ biết (id, giờ nhận, IP client,
 * mode) bằng `CATCHNET_FORWARD_SECRET`. Hai chữ ký vì cổng phạt chạy TRƯỚC body parser (D3, ADR-177):
 *   - `x-catchnet-signature: v1=HMAC(secret, id.received_at.client_ip.mode.METHOD.path_and_query)` — không có body; cổng
 *     phạt kiểm để lấy IP client cho hộp phạt / chấm điểm.
 *   - `x-catchnet-body-signature: v1=HMAC(secret, id.hex(sha256(body)))` — kiểm SAU khi đọc body; CHỈ khi khớp thì
 *     `received_at` mới được dùng làm "bây giờ" khi verify (`AdapterContext.verifyAt`) và làm `raw_events.received_at`.
 * Sai / thiếu / quá hạn / không có secret -> null: bỏ qua CẢ bộ header, request đi như gọi thẳng (không 401).
 * So bằng `timingSafeEqual` (kiểm độ dài trước). 0 Redis, 0 DB — thuần CPU, chỉ chạy khi request có header lưới.
 *
 * Chuỗi ký không mơ hồ dù nối bằng `.`: id chỉ [0-9A-Za-z], received_at chỉ chữ số, IP phải là IP hợp lệ, mode thuộc tập
 * cố định, METHOD chỉ chữ hoa, path bắt đầu bằng `/` — không dời ranh giới trường được.
 */
export const CATCHNET_HEADERS = {
  id: 'x-catchnet-id',
  receivedAt: 'x-catchnet-received-at',
  clientIp: 'x-catchnet-client-ip',
  mode: 'x-catchnet-mode',
  signature: 'x-catchnet-signature',
  bodySignature: 'x-catchnet-body-signature',
} as const;

export type CatchnetMode = 'forward' | 'replay';
const MODES: ReadonlySet<string> = new Set(['forward', 'replay']);

/** Kết quả kiểm chữ ký ĐẦU (không body). */
export interface CatchnetIngress {
  id: string;
  receivedAtMs: number;
  clientIp: string;
  mode: CatchnetMode;
}

export type CatchnetHeaders = Record<string, string | string[] | undefined>;
type Env = Record<string, string | undefined>;

const ID_RE = /^[0-9A-Za-z]{1,64}$/;
const MS_RE = /^\d{1,15}$/;
const METHOD_RE = /^[A-Z]{1,16}$/;
const SIG_RE = /^v1=([0-9a-f]{64})$/;
const DAY_MS = 86_400_000;
export const DEFAULT_CATCHNET_RETENTION_DAYS = 7;

/** `CATCHNET_FORWARD_SECRET`: một hoặc hai giá trị phân tách `,` (xoay khoá). Thiếu/rỗng -> [] = tắt hẳn. */
export function catchnetSecrets(env: Env = process.env): string[] {
  return (env.CATCHNET_FORWARD_SECRET ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
}

/** `CATCHNET_RETENTION_DAYS` (mặc định 7, nguyên 1..30; sai khuôn -> 7) -> ms. Cùng giá trị với Worker (§13). */
export function catchnetRetentionMs(env: Env = process.env): number {
  const n = Number(env.CATCHNET_RETENTION_DAYS);
  const days = Number.isInteger(n) && n >= 1 && n <= 30 ? n : DEFAULT_CATCHNET_RETENTION_DAYS;
  return days * DAY_MS;
}

export function catchnetVia(mode: CatchnetMode): 'catchnet-forward' | 'catchnet-replay' {
  return mode === 'replay' ? 'catchnet-replay' : 'catchnet-forward';
}

function one(headers: CatchnetHeaders, name: string): string | null {
  const v = headers[name];
  return typeof v === 'string' ? v : null; // mảng (header lặp) -> không nhận
}

/** So hex chữ ký với từng secret bằng timingSafeEqual; KHÔNG dừng sớm (thời gian không lộ secret nào khớp). */
function matchesAny(given: string, secrets: string[], data: string): boolean {
  const g = Buffer.from(given, 'utf8');
  let ok = false;
  for (const secret of secrets) {
    const expected = Buffer.from(createHmac('sha256', secret).update(data).digest('hex'), 'utf8');
    if (g.length === expected.length && timingSafeEqual(g, expected)) ok = true;
  }
  return ok;
}

/**
 * Kiểm chữ ký ĐẦU. `target` = request-target thô (path + `?query`) đúng như Worker gửi — ở gốc app là `req.url`
 * (= `originalUrl`). Trả null nếu thiếu secret, thiếu/sai khuôn header, chữ ký sai, hoặc |now − received_at| quá hạn.
 */
export function verifyCatchnetHeaders(
  input: { method?: string; target?: string; headers: CatchnetHeaders },
  env: Env = process.env,
  nowMs: number = Date.now(),
): CatchnetIngress | null {
  const sigRaw = one(input.headers, CATCHNET_HEADERS.signature);
  if (sigRaw === null) return null;
  const secrets = catchnetSecrets(env);
  if (secrets.length === 0) return null;
  const id = one(input.headers, CATCHNET_HEADERS.id);
  const at = one(input.headers, CATCHNET_HEADERS.receivedAt);
  const ip = one(input.headers, CATCHNET_HEADERS.clientIp);
  const mode = one(input.headers, CATCHNET_HEADERS.mode);
  const method = (input.method ?? '').toUpperCase();
  const target = input.target ?? '';
  const sig = SIG_RE.exec(sigRaw.trim());
  if (!sig || id === null || !ID_RE.test(id) || at === null || !MS_RE.test(at) || ip === null || net.isIP(ip) === 0) return null;
  if (mode === null || !MODES.has(mode) || !METHOD_RE.test(method) || !target.startsWith('/')) return null;
  const receivedAtMs = Number(at);
  if (!Number.isFinite(nowMs) || Math.abs(nowMs - receivedAtMs) > catchnetRetentionMs(env)) return null;
  if (!matchesAny(sig[1], secrets, `${id}.${at}.${ip}.${mode}.${method}.${target}`)) return null;
  return { id, receivedAtMs, clientIp: ip, mode: mode as CatchnetMode };
}

/** Chữ ký BODY (sau body parser): `HMAC(secret, id.hex(sha256(rawBody)))`. Chỉ có nghĩa khi chữ ký đầu đã qua. */
export function verifyCatchnetBody(ing: CatchnetIngress, headers: CatchnetHeaders, rawBody: Buffer, env: Env = process.env): boolean {
  const raw = one(headers, CATCHNET_HEADERS.bodySignature);
  const sig = raw === null ? null : SIG_RE.exec(raw.trim());
  if (!sig) return false;
  const secrets = catchnetSecrets(env);
  if (secrets.length === 0) return false;
  return matchesAny(sig[1], secrets, `${ing.id}.${createHash('sha256').update(rawBody).digest('hex')}`);
}

const MEMO = Symbol('catchnetIngress');
type MemoReq = IncomingMessage & { originalUrl?: string; [MEMO]?: CatchnetIngress | null };

/**
 * Kết quả kiểm chữ ký đầu cho MỘT request, nhớ trên chính request: cổng phạt (trước body parser) và controller dùng
 * chung, HMAC chạy một lần. Không có header `x-catchnet-signature` -> null ngay (request thường: 0 HMAC).
 */
export function catchnetOf(req: IncomingMessage & { originalUrl?: string }): CatchnetIngress | null {
  const r = req as MemoReq;
  if (r[MEMO] !== undefined) return r[MEMO]!;
  let v: CatchnetIngress | null = null;
  try {
    v = verifyCatchnetHeaders({ method: r.method, target: r.originalUrl ?? r.url, headers: r.headers as CatchnetHeaders });
  } catch {
    v = null; // lỗi bất ngờ -> coi như request thường (an toàn: không tin header nào)
  }
  r[MEMO] = v;
  return v;
}
