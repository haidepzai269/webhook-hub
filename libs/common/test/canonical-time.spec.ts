import { parseProviderTime } from '../src/canonical';

/** U43 — parseProviderTime: chuỗi không múi giờ = giờ Việt Nam (+07:00). */
describe('U43 parseProviderTime', () => {
  it('"2026-10-10 14:02:37" -> 07:02:37Z', () => {
    expect(parseProviderTime('2026-10-10 14:02:37')).toBe('2026-10-10T07:02:37.000Z');
  });
  it('chuỗi ISO có Z -> giữ nguyên thời điểm', () => {
    expect(parseProviderTime('2026-10-10T07:02:37Z')).toBe('2026-10-10T07:02:37.000Z');
    expect(parseProviderTime('2026-10-10T14:02:37+07:00')).toBe('2026-10-10T07:02:37.000Z');
  });
  it('"abc" -> ném lỗi', () => {
    expect(() => parseProviderTime('abc')).toThrow();
    expect(() => parseProviderTime('')).toThrow();
  });
  it('unix giây (Stripe created) -> ISO', () => {
    expect(parseProviderTime(1760104957)).toBe(new Date(1760104957 * 1000).toISOString());
  });
  it('offset tuỳ chọn', () => {
    expect(parseProviderTime('2026-10-10 09:00:00', '+00:00')).toBe('2026-10-10T09:00:00.000Z');
  });
});
