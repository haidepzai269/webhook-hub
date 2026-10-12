/**
 * ADR-163: bộ lọc + cursor của các trang nhật ký nằm TRÊN URL (F5 / gửi link giữ nguyên). TS thuần — không React,
 * không alias `@/` — để jest gốc test thẳng. URL là nguồn sự thật duy nhất: trang đọc bằng `readParams`, ghi bằng
 * `withFilter` (đổi lọc -> bỏ cursor, về trang mới nhất) hoặc `withCursor` (Trước/Sau).
 *
 * Giá trị lạ trên URL (link cũ, gõ tay) bị BỎ QUA thay vì gửi lên server để nhận 400 — trang vẫn mở được.
 */

import { ALERT_RULE_CODES, ALERT_SEVERITIES, ALERT_STATES } from "../alerts/types";
import type { MessageKey } from "../i18n/dictionary";

export interface ParamSpec {
  /** Danh sách giá trị hợp lệ (enum). */
  allowed?: readonly string[];
  /** Hoặc mẫu hợp lệ. */
  pattern?: RegExp;
  /** Tên cũ -> tên mới (link đã chia sẻ trước khi đổi tên giá trị vẫn mở đúng). */
  aliases?: Record<string, string>;
}

export type ParamSpecs = Record<string, ParamSpec>;
export type ParamValues<S extends ParamSpecs> = Partial<Record<keyof S & string, string>>;

interface ReadableParams {
  get(key: string): string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Thời điểm ISO có ngày (server kiểm lại chặt hơn). */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
/** Cursor = base64url do server phát; ở client chỉ chặn rác thô. */
const CURSOR = /^[A-Za-z0-9_-]{8,300}$/;

export const CURSOR_KEYS = ["before", "after"] as const;

const cursorSpecs = { before: { pattern: CURSOR }, after: { pattern: CURSOR } } satisfies ParamSpecs;

export const DELIVERY_STATUS_VALUES = ["PENDING", "DELIVERING", "RETRYING", "SUCCEEDED", "DEAD"] as const;
export const DLQ_ERROR_KIND_VALUES = ["http_4xx", "http_other", "no_response"] as const;
export const DLQ_AGE_VALUES = ["1h", "24h", "7d", "gt1d", "gt7d"] as const;
export const EXECUTION_STATUS_VALUES = ["in_progress", "failed", "rejected", "succeeded"] as const;

/** Lượt giao: trạng thái, đích, HTTP code (lần thử cuối), khoảng thời gian. */
export const DELIVERY_PARAMS = {
  status: { allowed: DELIVERY_STATUS_VALUES },
  destination: { pattern: UUID },
  code: { pattern: /^([1-5]\d{2}|[1-5]xx|none)$/ },
  from: { pattern: ISO },
  to: { pattern: ISO },
  ...cursorSpecs,
} satisfies ParamSpecs;

/** DLQ: đích, loại lỗi, tuổi (preset tương đối — đổi ra from/to lúc truy vấn). */
export const DLQ_PARAMS = {
  destination: { pattern: UUID },
  // ADR-163: `http_5xx` đổi tên thành `http_other` (gồm cả lỗi mạng) — link cũ vẫn chạy.
  errorKind: { allowed: DLQ_ERROR_KIND_VALUES, aliases: { http_5xx: "http_other" } },
  age: { allowed: DLQ_AGE_VALUES },
  ...cursorSpecs,
} satisfies ParamSpecs;

/** Nhật ký thao tác: người làm, hành động, loại đối tượng, khoảng thời gian. */
export const AUDIT_PARAMS = {
  actor: { pattern: /^.{1,128}$/ },
  action: { pattern: /^[a-z0-9_.]{1,64}$/ },
  entityType: { pattern: /^[a-z0-9_]{1,64}$/ },
  from: { pattern: ISO },
  to: { pattern: ISO },
  ...cursorSpecs,
} satisfies ParamSpecs;

/** CB4: Cảnh báo (xuyên project, chỉ operator) — dự án, mức, trạng thái, luật. */
export const ALERT_PARAMS = {
  project: { pattern: UUID },
  severity: { allowed: ALERT_SEVERITIES },
  state: { allowed: ALERT_STATES },
  rule: { allowed: ALERT_RULE_CODES },
  ...cursorSpecs,
} satisfies ParamSpecs;

/** Hành trình sự kiện (cuộn vô hạn — không cursor trên URL). */
export const EXECUTION_PARAMS = {
  status: { allowed: EXECUTION_STATUS_VALUES },
  source: { pattern: UUID },
  destination: { pattern: UUID },
  type: { pattern: /^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/ },
  from: { pattern: ISO },
  to: { pattern: ISO },
  q: { pattern: /^[0-9A-Za-z_-]{4,36}$/ },
} satisfies ParamSpecs;

/** Ngăn "Nhật ký sự kiện" trên /dashboard/flow — tiền tố `log` để không đụng tham số khác của trang bản đồ. */
export const EVENT_LOG_PARAMS = {
  logProvider: { pattern: /^[a-z0-9_-]{1,32}$/ },
  logStatus: { allowed: EXECUTION_STATUS_VALUES },
  logProbes: { allowed: ["hide"] },
} satisfies ParamSpecs;

export function readParams<S extends ParamSpecs>(sp: ReadableParams, specs: S): ParamValues<S> {
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const raw = sp.get(key)?.trim();
    if (!raw) continue;
    const v = spec.aliases?.[raw] ?? raw;
    if (spec.allowed && !spec.allowed.includes(v)) continue;
    if (spec.pattern && !spec.pattern.test(v)) continue;
    out[key] = v;
  }
  return out as ParamValues<S>;
}

/** `?a=1&b=2` (khoá sắp xếp ổn định) hoặc "" khi không còn gì. */
function toSearch(p: URLSearchParams): string {
  p.sort();
  const s = p.toString();
  return s ? `?${s}` : "";
}

function patchParams(current: string | URLSearchParams, patch: Record<string, string | null | undefined>): URLSearchParams {
  const p = new URLSearchParams(typeof current === "string" ? current : current.toString());
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "") p.delete(k);
    else p.set(k, v);
  }
  return p;
}

/** Đổi bộ lọc: ghi patch, BỎ cursor — trang mới nhất của bộ lọc mới (cursor cũ thuộc tập dòng khác). */
export function withFilter(current: string | URLSearchParams, patch: Record<string, string | null | undefined>): string {
  const p = patchParams(current, patch);
  for (const k of CURSOR_KEYS) p.delete(k);
  return toSearch(p);
}

/** Trước/Sau: `before` (cũ hơn) XOR `after` (mới hơn); `null` cả hai = về trang mới nhất. Bộ lọc giữ nguyên. */
export function withCursor(current: string | URLSearchParams, cursor: { before?: string | null; after?: string | null }): string {
  return toSearch(patchParams(current, { before: cursor.before ?? null, after: cursor.after ?? null }));
}

/** Bỏ mọi khoá của `specs` (nút "Bỏ lọc"), giữ tham số khác của trang. */
export function clearParams(current: string | URLSearchParams, specs: ParamSpecs): string {
  const patch: Record<string, null> = {};
  for (const k of Object.keys(specs)) patch[k] = null;
  return withFilter(current, patch);
}

/** Tham số gửi lên API: bỏ giá trị rỗng; `rename` đổi tên khoá URL -> khoá API (vd logProvider -> provider). */
export function toApiQuery(values: Record<string, string | undefined>, rename: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v) p.set(rename[k] ?? k, v);
  p.sort();
  return p.toString();
}

const HOUR = 3_600_000;
const AGE_MS: Record<(typeof DLQ_AGE_VALUES)[number], { from?: number; to?: number }> = {
  "1h": { from: HOUR },
  "24h": { from: 24 * HOUR },
  "7d": { from: 7 * 24 * HOUR },
  gt1d: { to: 24 * HOUR },
  gt7d: { to: 7 * 24 * HOUR },
};

/** Tuổi DLQ (preset) -> `from`/`to` ISO tính từ `now` — cùng cặp gửi cho bảng DLQ và cho xem trước replay hàng loạt. */
export function ageRange(age: string | undefined, now: number): { from?: string; to?: string } {
  const a = age ? AGE_MS[age as keyof typeof AGE_MS] : undefined;
  if (!a) return {};
  return {
    ...(a.from !== undefined ? { from: new Date(now - a.from).toISOString() } : {}),
    ...(a.to !== undefined ? { to: new Date(now - a.to).toISOString() } : {}),
  };
}

/** ISO (UTC) -> giá trị `<input type="datetime-local">` theo giờ máy người xem; rỗng/sai -> "". */
export function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` (giờ máy) -> ISO UTC; rỗng/sai -> undefined. */
export function localInputToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Mốc "Đến" của ô `datetime-local` (độ chính xác phút) -> ISO của GIÂY CUỐI phút đó (…:59.999): chọn 10:30 nghĩa
 * là gồm cả các dòng lúc 10:30:xx. `isoToLocalInput` hiển thị lại đúng 10:30.
 */
export function localInputToIsoEnd(local: string): string | undefined {
  const iso = localInputToIso(local);
  return iso === undefined ? undefined : new Date(Date.parse(iso) + 59_999).toISOString();
}

/** Lỗi khoảng thời gian phía client — trả KHOÁ i18n (null = hợp lệ / chưa đủ hai đầu); component dịch bằng t(). */
export function timeRangeError(from: string | undefined, to: string | undefined): MessageKey | null {
  if (!from || !to) return null;
  return Date.parse(from) > Date.parse(to) ? "admin.time-range.order-error" : null;
}
