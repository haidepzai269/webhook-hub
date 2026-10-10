import { testOnlyConfigProblems } from '@hub/common';

/**
 * VF1 (SPEC-verification §4.2): `.env.verify` được commit, chứa secret giả `VERIFY_ONLY_…`.
 * Lỡ đem nó (hoặc driver mail chỉ dành cho test) lên production thì app phải TỪ CHỐI khởi động.
 */
describe('testOnlyConfigProblems — chặn cấu hình chỉ-dành-cho-test ở production', () => {
  it('[VF:VT13] NODE_ENV=production + secret VERIFY_ONLY_ hoặc MAIL_DRIVER=capture → báo lỗi (app thoát)', () => {
    const problems = testOnlyConfigProblems({
      NODE_ENV: 'production',
      MASTER_KEY: 'VERIFY_ONLY_master_key_0123456789abcdef',
      JWT_SECRET: 'a-real-looking-secret-that-is-long-enough',
      MAIL_DRIVER: 'capture',
    });
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('MASTER_KEY'), expect.stringContaining('MAIL_DRIVER')]),
    );
    expect(problems.join(' ')).not.toContain('JWT_SECRET');
    // Không in giá trị secret ra log
    expect(problems.join(' ')).not.toContain('0123456789abcdef');
  });

  it('ngoài production thì secret giả là hợp lệ (stack hubv, test)', () => {
    expect(
      testOnlyConfigProblems({ NODE_ENV: 'development', MASTER_KEY: 'VERIFY_ONLY_x', MAIL_DRIVER: 'capture' }),
    ).toEqual([]);
    expect(testOnlyConfigProblems({ MASTER_KEY: 'VERIFY_ONLY_x' })).toEqual([]);
  });

  it('production sạch → không có lỗi', () => {
    expect(testOnlyConfigProblems({ NODE_ENV: 'production', MASTER_KEY: 'real', MAIL_DRIVER: 'resend' })).toEqual([]);
  });
});

describe('testOnlyConfigProblems — API key giả của hubv (S2)', () => {
  it('production + key `hk_test_VERIFY_ONLY_…` (SEED_SHOP_API_KEY / HUB_URL) → báo lỗi', () => {
    const problems = testOnlyConfigProblems({ NODE_ENV: 'production', SEED_SHOP_API_KEY: 'hk_test_VERIFY_ONLY_shop_key_0000000000000000000000' });
    expect(problems.join(' ')).toContain('SEED_SHOP_API_KEY');
  });
});
