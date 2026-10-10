import { checkSyncDestinationsEnv } from '../src/seed-env';

/**
 * Review SPEC-1 (thấp): `seed --sync-destinations` thiếu env thì ghi đè đích bằng mock/secret mặc
 * định mà không báo -> giờ từ chối, liệt kê biến thiếu, trừ khi có `--allow-defaults`.
 */
describe('checkSyncDestinationsEnv', () => {
  const full = {
    HUB_SIGNING_SECRET: 's',
    SHOP_WEBHOOK_URL: 'http://shop:4001/hub-webhook',
    MOCK_BASE_URL: 'http://hub-api:4000',
  };

  it('đủ env (dùng mock) -> không thiếu gì', () => {
    expect(checkSyncDestinationsEnv(full)).toEqual([]);
  });

  it('env rỗng -> liệt kê HUB_SIGNING_SECRET, SHOP_WEBHOOK_URL, MOCK_BASE_URL', () => {
    expect(checkSyncDestinationsEnv({})).toEqual(['HUB_SIGNING_SECRET', 'SHOP_WEBHOOK_URL', 'MOCK_BASE_URL']);
  });

  it('chuỗi chỉ có khoảng trắng coi như thiếu', () => {
    expect(checkSyncDestinationsEnv({ ...full, HUB_SIGNING_SECRET: '   ' })).toEqual(['HUB_SIGNING_SECRET']);
  });

  it('Discord + Telegram thật đủ -> không cần MOCK_BASE_URL', () => {
    const { MOCK_BASE_URL, ...rest } = full;
    expect(
      checkSyncDestinationsEnv({ ...rest, DISCORD_WEBHOOK_URL: 'https://discord/x', TELEGRAM_BOT_TOKEN: '123:real', TELEGRAM_CHAT_ID: '-1' }),
    ).toEqual([]);
  });

  it('Telegram token thật mà thiếu TELEGRAM_CHAT_ID -> báo thiếu', () => {
    expect(checkSyncDestinationsEnv({ ...full, TELEGRAM_BOT_TOKEN: '123:real' })).toEqual(['TELEGRAM_CHAT_ID']);
  });

  it('chỉ Discord thật, Telegram vẫn mock -> vẫn cần MOCK_BASE_URL', () => {
    const { MOCK_BASE_URL, ...rest } = full;
    expect(checkSyncDestinationsEnv({ ...rest, DISCORD_WEBHOOK_URL: 'https://discord/x' })).toEqual(['MOCK_BASE_URL']);
  });
});

describe('seedTelegramActive (review #7, ADR-066)', () => {
  const { seedTelegramActive } = require('../src/seed-env');
  it.each([
    [{}, false],
    [{ TELEGRAM_BOT_TOKEN: '123:abc' }, false],
    [{ TELEGRAM_CHAT_ID: '-1' }, false],
    [{ TELEGRAM_BOT_TOKEN: '123:mock-token', TELEGRAM_CHAT_ID: '-1' }, false],
    [{ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-1' }, true],
    [{ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-1', SEED_TELEGRAM_ACTIVE: 'false' }, false],
    [{ SEED_TELEGRAM_ACTIVE: 'true' }, true],
    [{ TELEGRAM_BOT_TOKEN: ' ', TELEGRAM_CHAT_ID: ' ' }, false],
  ])('%j -> %s', (env, expected) => {
    expect(seedTelegramActive(env)).toBe(expected);
  });

  it('compose mặc định tắt Telegram seed và bật RUN_SEED', () => {
    const yml: string = require('fs').readFileSync(require('path').join(__dirname, '../../../docker-compose.yml'), 'utf8');
    expect(yml).toContain('SEED_TELEGRAM_ACTIVE=${SEED_TELEGRAM_ACTIVE:-false}');
    expect(yml).toContain('RUN_SEED=${RUN_SEED:-true}');
  });
});
