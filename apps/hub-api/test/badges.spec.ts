import { isPgInvalidInput, isValidBadgeInstant, parseBadgeAt, parseBadgeSeq } from '../src/modules/api/api.controller';

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

  it('ISO: chặn ngày không tồn tại, năm <1970/0000, giờ phút giây ngoài dải, offset quá ±14:00', () => {
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2025-02-29T00:00:00Z',
      '0000-01-01T00:00:00Z',
      '1969-12-31T23:59:59Z',
      '2026-10-19T24:00:00Z',
      '2026-10-19T03:60:00Z',
      '2026-10-19T03:00:60Z',
      '2026-10-19T03:00:00+15:00',
      '2026-10-19T03:00:00+14:30',
      '2026-10-19T03:00:00+07:60',
    ]) {
      expect(isValidBadgeInstant(bad)).toBe(false);
      expect(() => parseBadgeAt('dlq', bad)).toThrow();
    }
  });
  it('ISO: chấp nhận ngày nhuận, offset hợp lệ, µs', () => {
    for (const ok of ['2024-02-29T00:00:00Z', '2026-10-19T03:00:00.123456Z', '2026-10-19T03:00:00+14:00', '2026-10-19T03:00:00-11:30', '1970-01-01T00:00:00Z']) {
      expect(isValidBadgeInstant(ok)).toBe(true);
    }
  });
  it('lỗi Postgres lớp 22xxx -> nhận diện là đầu vào sai (400); lỗi khác thì không', () => {
    expect(isPgInvalidInput({ code: 'P2010', meta: { code: '22008', message: 'x' } })).toBe(true);
    expect(isPgInvalidInput(new Error('Raw query failed. Code: `22008`. Message: `date/time field value out of range`'))).toBe(true);
    expect(isPgInvalidInput({ code: 'P2010', meta: { code: '57014' } })).toBe(false);
    expect(isPgInvalidInput(new Error('connection refused'))).toBe(false);
    expect(isPgInvalidInput(null)).toBe(false);
  });

  it('qs: mảng / object (?events[]=5, ?dlq[]=<iso>, ?dlq[a]=b) bị 400, không lọt xuống SQL', () => {
    expect(() => parseBadgeSeq(['5'])).toThrow();
    expect(() => parseBadgeSeq({ a: '5' })).toThrow();
    expect(() => parseBadgeAt('dlq', ['2026-10-19T03:00:00Z'])).toThrow();
    expect(() => parseBadgeAt('deliveries', ['head'])).toThrow();
    expect(() => parseBadgeAt('dlq', { a: 'b' })).toThrow();
    expect(() => parseBadgeAt('dlq', 123)).toThrow();
  });
});
