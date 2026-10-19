import { scrubSecrets } from "@hub/common/auth/redact";

/**
 * LOGGING.md §11.9 (ADR-264) — logic THUẦN che dữ liệu nhạy cảm trước khi event Sentry rời trình duyệt. Cùng triết lý
 * với `libs/common/src/sentry.ts` (backend, ADR-258): bộ luật `scrubSecrets` dùng CHUNG, tag theo allowlist, bỏ hẳn
 * request/user/extra, không có "bộ lọc thứ hai". Không import SDK, không DOM -> chạy được trong jest (node).
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>`)\]}]+/gi;
const USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]*@/gi;
/** Đường dẫn tương đối kèm query trong câu chữ/mô tả span: `GET /api/x?key=…`. */
const REL_URL_QUERY_RE = /(^|\s)(\/[A-Za-z0-9_\-./~%]+)\?[^\s"'<>]*/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const VENDOR_KEY_RE = /\b(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g;
/** `token=abc…`, `secret: abc…`, `"password":"abc…"` nằm giữa câu chữ (message lỗi tự do). */
const KV_SECRET_RE = /\b(token|secret|password|passwd|api[_-]?key|signature|authorization|checksum[_-]?key|access[_-]?token|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^\s&"',;]{4,}/gi;

/** Khoá object bị thay bằng `[Filtered]` bất kể giá trị. */
const SENSITIVE_KEY_RE =
  /^(?:password|passwd|authorization|proxy-authorization|cookie|set-cookie|cookies|api[-_]?key|x-api-key|x-csrf-token|csrf\w*|signature|credentials|ticket|query_string|headers|http\.query|http\.fragment|url\.query|url\.fragment|http\.request\.header\.\w+)$|token|secret|whsec|checksum/i;

/** Tag được phép rời trình duyệt (allowlist, không phải denylist). */
export const WEB_TAG_ALLOW: ReadonlySet<string> = new Set(["svc", "frontend_cause", "request_id", "cold", "stage", "environment", "release", "turbopack"]);
const CONTEXT_ALLOW = ["trace", "browser", "os", "culture"];
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_DEPTH = 10;
const MAX_STRING = 2000;

export function maskEmails(s: string): string {
  return s.replace(EMAIL_RE, "***@***");
}

/** Bỏ userinfo (`user:pass@`), query (`?…`) và fragment (`#…`) của MỘT url (tuyệt đối hoặc tương đối). */
export function scrubUrl(u: string): string {
  const noUser = u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i, "$1");
  const cut = noUser.search(/[?#]/);
  return cut === -1 ? noUser : noUser.slice(0, cut);
}

/** Chuỗi tự do -> che URL (query/userinfo), secret, JWT, khoá nhà cung cấp, email. */
export function scrubText(s: string): string {
  let out = s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  out = out.replace(USERINFO_RE, "$1***@");
  out = out.replace(URL_RE, (m) => scrubUrl(m)).replace(REL_URL_QUERY_RE, "$1$2");
  out = scrubSecrets(out);
  out = out.replace(JWT_RE, "[jwt]").replace(VENDOR_KEY_RE, "[key]").replace(KV_SECRET_RE, "$1$2***");
  return maskEmails(out);
}

/** Duyệt sâu mọi giá trị: chuỗi qua `scrubText`, khoá nhạy cảm bị thay. */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[Filtered]" : scrubDeep(v, depth + 1);
  }
  return out;
}

export type FrontendCause = "cold_start" | "slow_api" | "network_or_cors" | "chunk_load" | "js_exception";

interface ApiErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  requestId?: unknown;
  cold?: unknown;
}

/** Lỗi 4xx từ hub là hành vi có chủ đích (401/403/404/409/422…), không phải bug frontend -> không gửi. */
export function isExpectedApiError(err: unknown): boolean {
  const e = err as ApiErrorLike | null;
  return !!e && typeof e === "object" && typeof e.name === "string" && /^Hub\w*Error$/.test(e.name) && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}

/** Enum đóng (LOGGING.md §11.9d). Thứ tự ưu tiên: chunk_load > cold_start > slow_api > network_or_cors > js_exception. */
export function classifyFrontendCause(err: unknown): FrontendCause {
  const e = (err && typeof err === "object" ? err : {}) as ApiErrorLike;
  const name = typeof e.name === "string" ? e.name : "";
  const msg = typeof e.message === "string" ? e.message : typeof err === "string" ? err : "";
  if (name === "ChunkLoadError" || /Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(msg)) return "chunk_load";
  if (e.cold === true) return "cold_start";
  if (name === "HubTimeoutError") return "slow_api";
  if (name === "TypeError" && /^(Failed to fetch|Load failed|NetworkError|Network request failed)/i.test(msg)) return "network_or_cors";
  return "js_exception";
}

const IGNORED_MESSAGE = /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)|\bNEXT_REDIRECT\b|\bNEXT_NOT_FOUND\b/;

/** Ghi thẻ `frontend_cause` / `request_id` / `cold` từ lỗi gốc (hint.originalException). request_id sai định dạng thì BỎ, không "làm sạch". */
function enrichTags(event: any, original: unknown): void {
  const tags: Record<string, unknown> = { ...(event.tags ?? {}) };
  const e = (original && typeof original === "object" ? original : {}) as ApiErrorLike;
  tags.svc = "web";
  tags.frontend_cause = classifyFrontendCause(original);
  if (typeof e.requestId === "string" && REQUEST_ID_RE.test(e.requestId)) tags.request_id = e.requestId;
  if (e.cold === true) tags.cold = "1";
  event.tags = tags;
}

const CAUSES: readonly string[] = ["cold_start", "slow_api", "network_or_cors", "chunk_load", "js_exception"];
function validTag(k: string, v: unknown): boolean {
  if (typeof v !== "string") return typeof v === "boolean" && k === "turbopack";
  if (k === "request_id") return REQUEST_ID_RE.test(v);
  if (k === "frontend_cause") return CAUSES.includes(v);
  if (k === "cold") return v === "1";
  if (k === "svc") return v === "web";
  return v.length <= 64;
}

/** Event (lỗi hoặc transaction) -> bản sạch. `null` = bỏ event. */
export function scrubWebEvent(event: any, original?: unknown): any {
  if (!event || typeof event !== "object") return null;
  if (original !== undefined && isExpectedApiError(original)) return null;
  const isTx = event.type === "transaction";
  const msgs = [event.message, ...(event.exception?.values ?? []).map((v: any) => `${v?.type ?? ""} ${v?.value ?? ""}`)].join(" ");
  if (!isTx && IGNORED_MESSAGE.test(msgs.trim())) return null;

  const { request, user: _u, extra: _e, server_name: _s, modules: _m, breadcrumbs, ...rest } = event;
  const out: any = rest;
  if (!isTx) enrichTags(out, original);
  else out.tags = { ...(out.tags ?? {}), svc: "web" };
  if (out.tags && typeof out.tags === "object") {
    // Allowlist khoá, rồi KIỂM định dạng giá trị của thẻ định danh: sai thì bỏ thẻ, không "làm sạch".
    out.tags = Object.fromEntries(Object.entries(out.tags).filter(([k, v]) => WEB_TAG_ALLOW.has(k) && validTag(k, v)));
  }
  if (out.contexts && typeof out.contexts === "object") {
    const keep: Record<string, unknown> = {};
    for (const k of CONTEXT_ALLOW) if (out.contexts[k]) keep[k] = out.contexts[k];
    out.contexts = keep;
  }
  // Request: CHỈ method + url đã bỏ query/userinfo. Không body, cookie, header, query_string.
  if (request && typeof request === "object") {
    out.request = { ...(typeof request.url === "string" ? { url: scrubUrl(request.url) } : {}), ...(typeof request.method === "string" ? { method: request.method } : {}) };
  }
  if (Array.isArray(breadcrumbs)) out.breadcrumbs = breadcrumbs.map((b) => scrubBreadcrumb(b)).filter(Boolean);
  if (typeof out.transaction === "string") out.transaction = scrubUrl(out.transaction);
  // Lớp cuối: toàn event qua scrubDeep (+ email ở mọi chuỗi kể cả khoá).
  return JSON.parse(maskEmails(JSON.stringify(scrubDeep(out))));
}

/** Chỉ giữ breadcrumb điều hướng (từ/đến đã bỏ query). Console, fetch, xhr, ui.* có thể mang payload -> bỏ. */
export function scrubBreadcrumb(b: any): any | null {
  if (!b || typeof b !== "object" || b.category !== "navigation") return null;
  const d = b.data && typeof b.data === "object" ? b.data : {};
  return {
    category: "navigation",
    timestamp: b.timestamp,
    data: { ...(typeof d.from === "string" ? { from: scrubUrl(d.from) } : {}), ...(typeof d.to === "string" ? { to: scrubUrl(d.to) } : {}) },
  };
}
