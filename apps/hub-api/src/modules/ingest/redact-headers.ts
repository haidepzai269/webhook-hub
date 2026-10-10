/**
 * Che header nhạy cảm TRƯỚC khi lưu `raw_events` (review SPEC-1 #1, ADR-051).
 *
 * SePay xác thực bằng `Authorization: Apikey <key>` — key nằm thẳng trong header. Lưu nguyên thì
 * key lộ qua `GET /api/v1/events/:id` và trang chi tiết sự kiện. Che an toàn vì adapter đã `verify`
 * xong trước khi lưu, và không chặng sau nào (normalize, replay) verify lại từ header đã lưu.
 *
 * `bodyRaw` thì KHÔNG đụng: HMAC tính trên bytes gốc (CLAUDE.md), phải giữ nguyên để điều tra/replay.
 */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization']);

const MASK = '***';
/** auth-scheme theo RFC 9110 là một token — không chứa '=' / ';' (để cookie "sid=..." không bị coi là scheme). */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/;

/** "Apikey abc" -> "Apikey ***"; "abc" -> "***"; "" -> "". */
export function redactHeaderValue(value: string): string {
  if (!value) return value;
  const sp = value.indexOf(' ');
  if (sp > 0) {
    const scheme = value.slice(0, sp);
    if (SCHEME_RE.test(scheme)) return `${scheme} ${MASK}`;
  }
  return MASK;
}

/** Bản sao headers với các header nhạy cảm đã che. Không đột biến đầu vào. */
export function redactHeaders<T extends Record<string, unknown>>(headers: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => redactHeaderValue(String(x)));
    } else if (v === undefined || v === null) {
      out[k] = v;
    } else {
      out[k] = redactHeaderValue(String(v));
    }
  }
  return out as T;
}
