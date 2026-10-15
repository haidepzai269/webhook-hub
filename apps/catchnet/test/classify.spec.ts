import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  forwardDecision,
  MAX_CLIENT_ERROR_ATTEMPTS,
  nextAttemptAt,
  outcomeOf,
  replayDecision,
  retryAfterMs,
  type HubReply,
  type Outcome,
} from '../src/classify';

const r = (status: number | null, outcome: Outcome | null = null): HubReply => ({ status, outcome });

describe('LH2 phân loại phản hồi hub (H1, H2, T-5, ADR-222)', () => {
  it('[LH:T18] chuyển tiếp: chỉ hứng khi hub VẮNG — 503 có outcome rejected (rejectStatus) trả nguyên, không hứng', () => {
    // Hub vắng: timeout/lỗi mạng, 5xx không outcome, outcome unavailable.
    for (const x of [r(null), r(502), r(503), r(504), r(500), r(503, 'unavailable'), r(200, 'unavailable')]) {
      expect(forwardDecision(x)).toBe('catch');
    }
    // Hub trả lời rõ ràng -> trả nguyên.
    for (const x of [r(200, 'accepted'), r(200), r(204), r(401, 'rejected'), r(404), r(429, 'refused'), r(503, 'rejected'), r(507, 'refused'), r(400), r(431), r(408)]) {
      expect(forwardDecision(x)).toBe('pass');
    }
  });

  it('[LH:T8] phát lại: bảng quyết định — 408/429/507 xét TRƯỚC outcome; 404 / rejected / refused -> dead; 4xx không outcome retry có hạn', () => {
    const table: Array<[HubReply, number, string]> = [
      [r(200, 'accepted'), 1, 'done'],
      [r(200, 'duplicate'), 1, 'done'],
      [r(204), 1, 'done'],
      [r(200, 'handshake'), 1, 'done'],
      [r(202), 1, 'done'],
      [r(429, 'refused'), 1, 'retry'], // H2: không phải dead dù outcome refused
      [r(429), 1, 'retry'],
      [r(408), 9, 'retry'],
      [r(507, 'refused'), 9, 'retry'], // ADR-222
      [r(null), 1, 'retry:absent'],
      [r(503), 1, 'retry:absent'],
      [r(502), 1, 'retry:absent'],
      [r(500, 'unavailable'), 1, 'retry:absent'],
      [r(401, 'rejected'), 1, 'dead:rejected'],
      [r(422, 'rejected'), 1, 'dead:rejected'],
      [r(503, 'rejected'), 1, 'dead:rejected'], // H1: rejectStatus 503 = hub TỪ CHỐI, không phải vắng
      [r(403, 'refused'), 1, 'dead:refused'],
      [r(404), 1, 'dead:not_found'],
      [r(404, 'rejected'), 1, 'dead:not_found'],
      [r(400), 1, 'retry'],
      [r(431), MAX_CLIENT_ERROR_ATTEMPTS - 1, 'retry'],
      [r(431), MAX_CLIENT_ERROR_ATTEMPTS, 'dead:client_error'],
      [r(302), MAX_CLIENT_ERROR_ATTEMPTS, 'dead:client_error'],
    ];
    for (const [reply, attempts, want] of table) {
      const a = replayDecision(reply, attempts);
      const got = a.kind === 'dead' ? `dead:${a.reason}` : a.kind === 'retry' ? (a.absent ? 'retry:absent' : 'retry') : a.kind;
      expect({ reply, attempts, got }).toEqual({ reply, attempts, got: want });
    }
  });

  it('[LH:T8] lùi dần 1m/2m/5m/10m/30m; Retry-After (giây hoặc HTTP-date) đẩy next_at xa hơn; outcome lạ = không có', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([60_000, 120_000, 300_000, 600_000, 1_800_000, 1_800_000]);
    const now = 1_760_000_000_000;
    expect(retryAfterMs(new Headers({ 'retry-after': '120' }), now)).toBe(120_000);
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(now + 300_000).toUTCString() }), now)).toBe(300_000);
    expect(retryAfterMs(new Headers({ 'retry-after': 'rác' }), now)).toBeNull();
    expect(retryAfterMs(new Headers({ 'retry-after': '999999999' }), now)).toBe(86_400_000);
    expect(nextAttemptAt(now, 1, 600_000)).toBe(now + 600_000);
    expect(nextAttemptAt(now, 1, 5_000)).toBe(now + 60_000);
    expect(outcomeOf(new Headers({ 'x-hub-outcome': 'Accepted' }))).toBe('accepted');
    expect(outcomeOf(new Headers({ 'x-hub-outcome': 'accepted, rejected' }))).toBeNull();
    expect(outcomeOf(new Headers())).toBeNull();
  });
});
