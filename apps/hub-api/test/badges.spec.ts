import { parseBadgeAt, parseBadgeSeq } from '../src/modules/api/api.controller';

/** ADR-269: tham số mốc của GET /api/v1/badges — chặn chuỗi lạ trước khi vào SQL (đã bind, đây là lớp 400 rõ ràng). */
describe('badges: parse mốc last-seen', () => {
  it('seq: số nguyên hợp lệ / rỗng -> null / lạ -> 400', () => {
    expect(parseBadgeSeq('123')).toBe('123');
    expect(parseBadgeSeq('head')).toBe('head');
    expect(parseBadgeSeq(undefined)).toBeNull();
    expect(parseBadgeSeq('')).toBeNull();
    expect(() => parseBadgeSeq('1; drop')).toThrow();
    expect(() => parseBadgeSeq('-1')).toThrow();
  });
  it('ISO: bắt buộc có múi giờ', () => {
    expect(parseBadgeAt('dlq', '2026-10-19T03:00:00.123456Z')).toBe('2026-10-19T03:00:00.123456Z');
    expect(parseBadgeAt('dlq', '2026-10-19T03:00:00+07:00')).toBe('2026-10-19T03:00:00+07:00');
    expect(parseBadgeAt('dlq', undefined)).toBeNull();
    expect(parseBadgeAt('dlq', 'head')).toBe('head');
    expect(() => parseBadgeAt('dlq', '2026-10-19T03:00:00')).toThrow();
    expect(() => parseBadgeAt('dlq', 'now()')).toThrow();
    expect(() => parseBadgeAt('dlq', '1760000000000')).toThrow();
  });
});
