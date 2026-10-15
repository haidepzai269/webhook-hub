/**
 * LH2 — phân loại phản hồi của hub (ĐÍNH CHÍNH H1/H2 + §16 T-5, ADR-221/222).
 *
 * `x-hub-outcome` = accepted | duplicate | handshake | rejected | refused | unavailable (hub cố ý trả lời).
 * Thiếu header = phản hồi không do Express của hub sinh (Node `clientError`, proxy Render, Render đang thức dậy…).
 */
export type Outcome = 'accepted' | 'duplicate' | 'handshake' | 'rejected' | 'refused' | 'unavailable';
const OUTCOMES: ReadonlySet<string> = new Set(['accepted', 'duplicate', 'handshake', 'rejected', 'refused', 'unavailable']);

export function outcomeOf(h: Headers): Outcome | null {
  const v = (h.get('x-hub-outcome') ?? '').trim().toLowerCase();
  return OUTCOMES.has(v) ? (v as Outcome) : null; // giá trị lạ / lặp ("a, b") = coi như không có
}

/** Kết quả một lần gọi hub: có phản hồi, hoặc lỗi mạng/timeout (`status: null`). */
export interface HubReply {
  status: number | null;
  outcome: Outcome | null;
}

/** "Hub vắng" (H1): timeout, lỗi mạng, 5xx KHÔNG có outcome, hoặc outcome `unavailable`. */
export function hubAbsent(r: HubReply): boolean {
  if (r.status === null) return true;
  if (r.outcome === 'unavailable') return true;
  return r.status >= 500 && r.outcome === null;
}

/** Chuyển tiếp: hub vắng -> hứng (ghi D1); còn lại -> trả NGUYÊN phản hồi hub cho provider, không ghi D1. */
export function forwardDecision(r: HubReply): 'catch' | 'pass' {
  return hubAbsent(r) ? 'catch' : 'pass';
}

export type ReplayAction =
  | { kind: 'done' }
  | { kind: 'retry'; absent: boolean }
  | { kind: 'dead'; reason: 'rejected' | 'refused' | 'not_found' | 'client_error' };

/** 4xx không outcome (khác 404/408/429) được thử lại tối đa chừng này lần rồi mới `inbox_dead` (T-5: "retry có hạn"). */
export const MAX_CLIENT_ERROR_ATTEMPTS = 3;

/**
 * Phát lại (H2 + T-5). Thứ tự xét CỐ ĐỊNH:
 *  1. 408 / 429 / 507 -> retry, xét TRƯỚC outcome (429 mang `refused` nhưng là "chậm lại", không phải "vứt"; 507 = ADR-222).
 *  2. hub vắng (H1) -> retry (và dừng lô).
 *  3. 2xx, hoặc outcome accepted/duplicate/handshake -> xong, xoá dòng.
 *  4. 404 -> `inbox_dead` (source không còn).
 *  5. outcome rejected/refused (4xx, hoặc 5xx như 503 `rejectStatus` chữ ký sai) -> `inbox_dead`.
 *  6. còn lại (4xx/3xx không outcome: 431/400 của Node, redirect lạ) -> retry, tới lần thứ MAX_CLIENT_ERROR_ATTEMPTS thì dead.
 * `attempts` = số lần ĐÃ phát lại tính cả lần này.
 */
export function replayDecision(r: HubReply, attempts: number): ReplayAction {
  const s = r.status;
  if (s === 408 || s === 429 || s === 507) return { kind: 'retry', absent: false };
  if (hubAbsent(r)) return { kind: 'retry', absent: true };
  if (s === null) return { kind: 'retry', absent: true }; // (đã phủ ở trên; giữ cho kiểu)
  if ((s >= 200 && s < 300) || r.outcome === 'accepted' || r.outcome === 'duplicate' || r.outcome === 'handshake') {
    return { kind: 'done' };
  }
  if (s === 404) return { kind: 'dead', reason: 'not_found' };
  if (r.outcome === 'rejected') return { kind: 'dead', reason: 'rejected' };
  if (r.outcome === 'refused') return { kind: 'dead', reason: 'refused' };
  return attempts >= MAX_CLIENT_ERROR_ATTEMPTS ? { kind: 'dead', reason: 'client_error' } : { kind: 'retry', absent: false };
}

/** Lùi dần (§4.4): 1m, 2m, 5m, 10m, rồi 30m. `attempts` = số lần đã phát lại (≥ 1). */
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000];
export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

/** `Retry-After`: giây (số nguyên ≥ 0) hoặc HTTP-date. Sai khuôn -> null. Kẹp ≤ 1 ngày (header rác không đẩy dòng đi mãi). */
export function retryAfterMs(h: Headers, nowMs: number): number | null {
  const v = h.get('retry-after');
  if (!v) return null;
  const t = v.trim();
  let ms: number | null = null;
  if (/^\d{1,9}$/.test(t)) ms = Number(t) * 1000;
  else {
    const at = Date.parse(t);
    if (Number.isFinite(at)) ms = Math.max(0, at - nowMs);
  }
  return ms === null ? null : Math.min(ms, 86_400_000);
}

/** `next_at` sau một lần thử hỏng: ≥ backoff, và ≥ Retry-After của hub nếu có (H2). */
export function nextAttemptAt(nowMs: number, attempts: number, retryAfter: number | null): number {
  return nowMs + Math.max(backoffMs(attempts), retryAfter ?? 0);
}
