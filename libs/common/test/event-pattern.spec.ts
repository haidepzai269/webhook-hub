import { eventTypeCandidates, isValidEventPattern, matchesEventPattern } from '../src/event-pattern';

/** S3-3 — mẫu kiểu sự kiện (U17/U19 theo DINH-CHINH §4: `*` đứng một mình hợp lệ). */
describe('event-pattern (S3-3)', () => {
  it('ứng viên của a.b.c và payment.received', () => {
    expect(eventTypeCandidates('a.b.c')).toEqual(['a.b.c', 'a.b.*', 'a.*', '*']);
    expect(eventTypeCandidates('payment.received')).toEqual(['payment.received', 'payment.*', '*']);
    expect(eventTypeCandidates('x')).toEqual(['x', '*']);
  });

  it('[MS:U17] U17: payment.link.succeeded khớp payment.*, payment.link.*, chính nó; không khớp pay.*, payment', () => {
    const t = 'payment.link.succeeded';
    expect(['payment.*', 'payment.link.*', 'payment.link.succeeded', 'pay.*', 'payment'].map((p) => matchesEventPattern(p, t))).toEqual([
      true, true, true, false, false,
    ]);
  });

  it('payment.* khớp payment.failed, không khớp paymentx.y; * khớp mọi thứ', () => {
    expect(matchesEventPattern('payment.*', 'payment.failed')).toBe(true);
    expect(matchesEventPattern('payment.*', 'paymentx.y')).toBe(false);
    expect(matchesEventPattern('*', 'github.ping')).toBe(true);
  });

  it('[MS:U19] (phần a) U19: hợp lệ / không hợp lệ', () => {
    for (const ok of ['*', 'payment.*', 'payment.received', 'repo.pull_request.*', 'a1_b.c2']) expect(isValidEventPattern(ok)).toBe(true);
    for (const bad of ['*.paid', 'payment.*.x', 'Payment.*', 'payment.', '.x', 'a..b', '', ' payment.*', '**', 'a.**', 'x'.repeat(129), 1 as any]) {
      expect(isValidEventPattern(bad)).toBe(false);
    }
  });
});
