import { MIN_SECRET_MATCH_LEN, PATTERN_MIN_SAMPLES, SECRET_PATTERN_COUNT, scrubSecrets } from './redact';

/** Tối ưu của scrubDeep (khoá object < 8 ký tự bỏ qua scrubSecrets) chỉ đúng khi mọi mẫu khớp tối thiểu >= 8 ký tự (ADR-256). */
describe('redact — độ dài khớp tối thiểu của PATTERNS', () => {
  it('mỗi mẫu có một mẫu tối thiểu, khớp thật và dài >= 8', () => {
    expect(PATTERN_MIN_SAMPLES).toHaveLength(SECRET_PATTERN_COUNT());
    for (const sample of PATTERN_MIN_SAMPLES) {
      expect(sample.length).toBeGreaterThanOrEqual(MIN_SECRET_MATCH_LEN);
      expect(scrubSecrets(sample)).not.toBe(sample);
    }
  });
});
