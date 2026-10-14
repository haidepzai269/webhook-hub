/**
 * VF1 (SPEC-verification §4.2, ADR-067): cấu hình CHỈ dành cho test không bao giờ được chạy ở production.
 * - Secret giả của `.env.verify` bắt đầu bằng `VERIFY_ONLY_` (file này được commit, ai cũng đọc được).
 * - `MAIL_DRIVER=capture` ghi thư ra đĩa cho runner e2e đọc (SPEC-auth AU2).
 * Trả danh sách vấn đề (rỗng = ổn). Không bao giờ in GIÁ TRỊ secret, chỉ tên biến.
 * Đây là chỗ DUY NHẤT trong `src` được nhắc tới `MAIL_DRIVER … capture` ngoài driver (grep gác cổng §7.3).
 */
export const VERIFY_ONLY_PREFIX = 'VERIFY_ONLY_';

export function testOnlyConfigProblems(env: Record<string, string | undefined>): string[] {
  if ((env.NODE_ENV ?? '').trim() !== 'production') return [];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && (value.trim().startsWith(VERIFY_ONLY_PREFIX) || value.trim().startsWith(`hk_test_${VERIFY_ONLY_PREFIX}`))) {
      problems.push(`${key} mang giá trị giả ${VERIFY_ONLY_PREFIX}… của .env.verify`);
    }
  }
  if ((env.MAIL_DRIVER ?? '').trim().toLowerCase() === 'capture') {
    problems.push('MAIL_DRIVER=capture chỉ dành cho stack kiểm chứng');
  }
  // SPEC-verification §4.2 / AU5: fake-github chỉ ở stack kiểm chứng; production phải là GitHub thật.
  const gh = (env.GITHUB_OAUTH_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (gh && gh !== 'https://github.com') {
    problems.push('GITHUB_OAUTH_BASE_URL phải là https://github.com ở production (fake-github chỉ dành cho kiểm chứng)');
  }
  // AU5b (ADR-127): fake-google chỉ ở stack kiểm chứng; production phải là Google thật (loadGoogleConfig cũng bỏ qua).
  if ((env.GOOGLE_OAUTH_FAKE_BASE_URL ?? '').trim()) {
    problems.push('GOOGLE_OAUTH_FAKE_BASE_URL chỉ dành cho kiểm chứng — production phải dùng Google thật');
  }
  // KN2 (SPEC-ket-noi §4.5): mọi fake provider của connector (PAYOS_/STRIPE_/GITHUB_FAKE_BASE_URL…) chỉ ở stack kiểm chứng.
  // Luật chung theo hậu tố — connector mới tự được che, không phải nhớ thêm tên vào đây.
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'GOOGLE_OAUTH_FAKE_BASE_URL' && /_FAKE_BASE_URL$/.test(key) && (value ?? '').trim()) {
      problems.push(`${key} chỉ dành cho kiểm chứng — production phải gọi provider thật`);
    }
  }
  if ((env.CONNECTOR_INGEST_BASE_URL ?? '').trim()) {
    problems.push('CONNECTOR_INGEST_BASE_URL chỉ dành cho kiểm chứng — production đăng ký URL ingest theo HUB_INGEST_PUBLIC_URL (thiếu thì HUB_PUBLIC_URL)');
  }
  return problems;
}
