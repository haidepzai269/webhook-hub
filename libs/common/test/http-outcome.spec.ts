import { classifyHttpOutcome, countsTowardCircuit, isNonRetryableHttpStatus, isRetryableFailure } from '../src/http-outcome';

/**
 * CB1: bảng phân loại HTTP tách từ delivery.consumer.ts — KHÔNG đổi hành vi. So với công thức inline cũ trên mọi status
 * 0..999 (đổi một chỗ thì test này đỏ; luật cảnh báo dùng cùng hàm — CB:T16).
 */
const legacyNonRetryable = (s: number) => s >= 400 && s < 500 && s !== 408 && s !== 429;
const legacyCircuit = (s: number) => s >= 500 || s === 408 || s === 429 || s < 100;

describe('http-outcome (tách từ delivery.consumer, CB1)', () => {
  it('isNonRetryableHttpStatus / countsTowardCircuit trùng khớp công thức cũ trên 0..999', () => {
    for (let s = 0; s < 1000; s++) {
      expect([s, isNonRetryableHttpStatus(s)]).toEqual([s, legacyNonRetryable(s)]);
      expect([s, countsTowardCircuit(s)]).toEqual([s, legacyCircuit(s)]);
    }
  });

  it('classifyHttpOutcome — bảng quyết định', () => {
    const table: [number | null, string][] = [
      [null, 'no_response'],
      [0, 'no_response'],
      [99, 'no_response'],
      [100, 'unexpected'],
      [200, 'success'],
      [204, 'success'],
      [299, 'success'],
      [301, 'unexpected'],
      [400, 'client_error'],
      [401, 'auth_rejected'],
      [403, 'auth_rejected'],
      [404, 'client_error'],
      [408, 'throttled'],
      [410, 'client_error'],
      [422, 'client_error'],
      [429, 'throttled'],
      [500, 'server_error'],
      [503, 'server_error'],
    ];
    for (const [s, o] of table) expect([s, classifyHttpOutcome(s)]).toEqual([s, o]);
  });

  it('isRetryableFailure = mọi thất bại KHÔNG non-retryable (hub sẽ retry giúp)', () => {
    for (const s of [0, 500, 502, 408, 429, 302, null]) expect(isRetryableFailure(s)).toBe(true);
    for (const s of [200, 201, 400, 401, 403, 404, 422]) expect(isRetryableFailure(s)).toBe(false);
    for (let s = 100; s < 600; s++) {
      if (classifyHttpOutcome(s) === 'success') continue;
      expect(isRetryableFailure(s)).toBe(!isNonRetryableHttpStatus(s));
    }
  });
});
