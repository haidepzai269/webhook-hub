/**
 * Mẫu kiểu sự kiện cho subscription (S3-3): khớp chính xác, wildcard đuôi `.*`, hoặc `*` một mình.
 *
 * Ngữ pháp: `^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$`
 * - hợp lệ: `payment.received`, `payment.*`, `repo.pull_request.*`, `*`
 * - không hợp lệ: `*.paid` (wildcard đầu), `payment.*.x` (wildcard giữa), `Payment.*` (chữ hoa), `payment.` …
 *
 * `payment.*` khớp NHIỀU cấp (`payment.link.succeeded` cũng khớp). Định tuyến không quét mọi
 * subscription mà sinh danh sách ỨNG VIÊN từ kiểu của event rồi hỏi DB `eventTypes && candidates`
 * (dùng được chỉ mục GIN của mảng) — một truy vấn, không đổi theo số subscription.
 */
export const EVENT_PATTERN_RE = /^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/;

/** Độ dài tối đa của một mẫu (khớp cột `events.type` VARCHAR(128)). */
export const EVENT_PATTERN_MAX_LENGTH = 128;

export function isValidEventPattern(p: unknown): p is string {
  return typeof p === 'string' && p.length <= EVENT_PATTERN_MAX_LENGTH && EVENT_PATTERN_RE.test(p);
}

/**
 * Mọi mẫu có thể khớp `type`:
 * `'a.b.c'` -> `['a.b.c', 'a.b.*', 'a.*', '*']`; `'payment.received'` -> `['payment.received', 'payment.*', '*']`.
 */
export function eventTypeCandidates(type: string): string[] {
  const parts = type.split('.');
  const out = [type];
  for (let i = parts.length - 1; i >= 1; i--) out.push(`${parts.slice(0, i).join('.')}.*`);
  out.push('*');
  return out;
}

/** Hàm khớp thuần (dùng cho test/UI) — cùng ngữ nghĩa với truy vấn ứng viên. */
export function matchesEventPattern(pattern: string, type: string): boolean {
  return eventTypeCandidates(type).includes(pattern);
}
