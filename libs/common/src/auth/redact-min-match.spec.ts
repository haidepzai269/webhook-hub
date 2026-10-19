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

  it('khoá Anthropic / Google và cookie session= bị che', () => {
    const k = 'AIzaFAKE' + 'B'.repeat(35);
    const out = scrubSecrets(`a sk-ant-api03-FAKEFAKEFAKE1234 b ${k} c session=FAKEVALUE123456; Path=/ d connect.sid=s%3AFAKEVALUE123`);
    expect(out).not.toMatch(/FAKEFAKEFAKE1234|BBBBBBBB|FAKEVALUE123456|FAKEVALUE123/);
    expect(out).toContain('session=***');
  });
});
