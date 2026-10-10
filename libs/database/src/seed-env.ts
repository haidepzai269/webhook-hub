/**
 * Kiểm env trước `seed --sync-destinations` (review SPEC-1, thấp).
 *
 * `destinationConfigsFromEnv()` rơi về giá trị mặc định (localhost, token mock, signing secret mẫu)
 * khi thiếu biến. Với seed lần đầu thì chấp nhận được (dev), nhưng `--sync-destinations` GHI ĐÈ đích
 * đang chạy — thiếu một biến là đích thật bị thay bằng mock / secret lệch shop mà không ai hay.
 * Trả danh sách biến thiếu (rỗng = đủ). Người gọi từ chối chạy nếu có, trừ khi `--allow-defaults`.
 */
export function checkSyncDestinationsEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  const has = (k: string) => !!(env[k] && env[k]!.trim());
  const missing: string[] = [];
  if (!has('HUB_SIGNING_SECRET')) missing.push('HUB_SIGNING_SECRET');
  if (!has('SHOP_WEBHOOK_URL')) missing.push('SHOP_WEBHOOK_URL');

  const telegramReal = has('TELEGRAM_BOT_TOKEN') && !env.TELEGRAM_BOT_TOKEN!.includes('mock');
  // MOCK_BASE_URL cần khi còn ít nhất một đích dùng mock (Discord không có URL thật, hoặc Telegram mock)
  const needsMock = !has('DISCORD_WEBHOOK_URL') || !telegramReal;
  if (needsMock && !has('MOCK_BASE_URL')) missing.push('MOCK_BASE_URL');
  if (telegramReal && !has('TELEGRAM_CHAT_ID')) missing.push('TELEGRAM_CHAT_ID');
  return missing;
}

export const ALLOW_DEFAULTS_FLAG = '--allow-defaults';

/**
 * Review SPEC-3 #7 (ADR-066): seed giờ tự chạy trên mọi stack compose mới, nên subscription Telegram
 * (`payment.*`) KHÔNG được tự bật gửi Telegram thật. Bật khi và chỉ khi:
 * - `SEED_TELEGRAM_ACTIVE` đặt rõ: 'true' -> bật, 'false' -> tắt (thắng mọi luật dưới);
 * - không đặt: có ĐỦ `TELEGRAM_BOT_TOKEN` (không phải token mock) và `TELEGRAM_CHAT_ID` -> bật (hành vi cũ);
 *   thiếu một trong hai -> tắt.
 * docker-compose đặt `SEED_TELEGRAM_ACTIVE=${SEED_TELEGRAM_ACTIVE:-false}` -> stack local mặc định TẮT.
 */
export function seedTelegramActive(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const flag = (env.SEED_TELEGRAM_ACTIVE ?? '').trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chat = (env.TELEGRAM_CHAT_ID ?? '').trim();
  return !!token && !token.includes('mock') && !!chat;
}
