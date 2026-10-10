/**
 * VF1 (SPEC-verification §4.2): `.env.verify` được commit vào repo PUBLIC.
 * Luật: mọi biến nhạy cảm có giá trị thì phải là giá trị giả `VERIFY_ONLY_…`; đích Telegram/Discord phải trống
 * (seed trỏ vào /mock/*, ADR-054). Stack hubv không bao giờ gửi tin thật.
 */
export const VERIFY_ONLY_PREFIX = 'VERIFY_ONLY_';
const SENSITIVE = /(SECRET|KEY|TOKEN|PASSWORD|CLIENT_ID)/;
/** Không phải secret: hash bcrypt của mật khẩu VERIFY_ONLY_ và tên đăng nhập. */
const NOT_SECRET = new Set(['ADMIN_PASSWORD_HASH', 'ADMIN_USERNAME']);
/** Phải trống: có giá trị là có thể nhắn tin thật. */
const MUST_BE_EMPTY = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL'];

export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function envVerifyProblems(env: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (MUST_BE_EMPTY.includes(key)) {
      if (value) problems.push(`${key} phải TRỐNG trong .env.verify (đích thật → nhắn tin thật)`);
      continue;
    }
    if (NOT_SECRET.has(key) || !SENSITIVE.test(key) || !value) continue;
    // API key của hub (S2) bắt buộc dạng `hk_<env>_…` -> phần giả nằm sau tiền tố: `hk_test_VERIFY_ONLY_…`
    if (!value.startsWith(VERIFY_ONLY_PREFIX) && !value.startsWith(`hk_test_${VERIFY_ONLY_PREFIX}`)) {
      problems.push(`${key} không mang tiền tố ${VERIFY_ONLY_PREFIX} — .env.verify chỉ chứa giá trị giả`);
    }
  }
  return problems;
}
