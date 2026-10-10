import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient, ProviderEnum, DestinationType } from '@prisma/client';
import { aesGcmEncrypt, aesGcmDecrypt } from '@hub/crypto';
import { DEFAULT_TENANT_ID, getMasterKey } from './constants';
import { TenantScopedRepository } from './tenant-scoped.repository';
import { ALLOW_DEFAULTS_FLAG, checkSyncDestinationsEnv } from './seed-env';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const prisma = new PrismaClient();

/** Tên các đích do seed tạo — `--sync-destinations` chỉ đụng đúng những đích này. */
export const SEED_DESTINATION_NAMES = {
  discord: 'Discord Dev Channel',
  telegram: 'Telegram Ops Group',
  shop: 'Demo Shop Outbound Webhook',
} as const;

/**
 * Cấu hình đích tính từ env hiện tại (MOCK_BASE_URL, SHOP_WEBHOOK_URL, TELEGRAM_*, DISCORD_WEBHOOK_URL,
 * HUB_SIGNING_SECRET). Dùng chung cho seed lần đầu và `--sync-destinations` (S1-7) để hai đường không lệch nhau.
 */
export function destinationConfigsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const val = (k: string) => (env[k] && env[k]!.trim()) || undefined;
  // Gốc URL của mock (Discord/Telegram). Chạy seed TRONG docker thì `localhost` là chính container ->
  // compose đặt MOCK_BASE_URL=http://hub-api:4000, SHOP_WEBHOOK_URL=http://shop:4001/... (ADR-036)
  const mockBaseUrl = (val('MOCK_BASE_URL') || 'http://localhost:4000').replace(/\/$/, '');
  const telegramBotToken = val('TELEGRAM_BOT_TOKEN') || '123456:mock-token';
  return {
    discord: { webhookUrl: val('DISCORD_WEBHOOK_URL') || `${mockBaseUrl}/mock/discord` },
    telegram: {
      botToken: telegramBotToken,
      chatId: val('TELEGRAM_CHAT_ID') || '-100123456789',
      // Token mock -> gửi vào mock của hub-api; token thật -> sender dùng api.telegram.org
      ...(telegramBotToken.includes('mock') ? { apiUrl: `${mockBaseUrl}/mock/telegram` } : {}),
    },
    shop: { url: val('SHOP_WEBHOOK_URL') || 'http://localhost:4001/hub-webhook' },
    // PHẢI trùng HUB_SIGNING_SECRET mà shop dùng để verify — lệch là shop trả 401
    shopSigningSecret: val('HUB_SIGNING_SECRET') || 'hub_outbound_signing_secret_999',
  };
}

/**
 * `seed --sync-destinations` (S1-7): mã hoá lại config các đích seed từ env hiện tại và UPDATE.
 * Dùng khi đổi URL/token sau khi đã seed (vd từ chạy ngoài docker sang trong docker). Không đụng
 * bảng nào khác. Đi qua TenantScopedRepository (BB-5). Nhờ S1-1, thay đổi có hiệu lực ngay cả với
 * message đang chờ retry.
 */
export async function syncDestinations(): Promise<string[]> {
  const masterKey = getMasterKey();
  const repo = new TenantScopedRepository(prisma, DEFAULT_TENANT_ID);
  const cfg = destinationConfigsFromEnv();
  const targets: { name: string; config: object; signingSecret?: string }[] = [
    { name: SEED_DESTINATION_NAMES.discord, config: cfg.discord },
    { name: SEED_DESTINATION_NAMES.telegram, config: cfg.telegram },
    { name: SEED_DESTINATION_NAMES.shop, config: cfg.shop, signingSecret: cfg.shopSigningSecret },
  ];
  const changed: string[] = [];
  for (const t of targets) {
    const found = await repo.findDestinations({ name: t.name });
    if (found.length === 0) {
      console.log(`  - ${t.name}: không có trong DB, bỏ qua`);
      continue;
    }
    for (const dest of found) {
      let oldConfig = '';
      let oldSecret: string | undefined;
      try { oldConfig = aesGcmDecrypt(dest.configEncrypted, masterKey); } catch { /* key cũ / hỏng -> coi như đổi */ }
      try { oldSecret = dest.signingSecretEncrypted ? aesGcmDecrypt(dest.signingSecretEncrypted, masterKey) : undefined; } catch { /* idem */ }
      const newConfig = JSON.stringify(t.config);
      const secretChanged = t.signingSecret !== undefined && t.signingSecret !== oldSecret;
      if (oldConfig === newConfig && !secretChanged) {
        console.log(`  = ${t.name} (${dest.id}): giữ nguyên`);
        continue;
      }
      await repo.updateDestination(dest.id, {
        configEncrypted: aesGcmEncrypt(newConfig, masterKey),
        ...(t.signingSecret !== undefined ? { signingSecretEncrypted: aesGcmEncrypt(t.signingSecret, masterKey) } : {}),
      });
      changed.push(t.name);
      console.log(`  * ${t.name} (${dest.id}): ĐÃ ĐỔI${oldConfig === newConfig ? '' : ' config'}${secretChanged ? ' signing secret' : ''}`);
    }
  }
  return changed;
}

async function seed() {
  console.log('--- Bắt đầu gieo dữ liệu ban đầu (Seed Database) ---');

  // An toàn / idempotent (BB-2: Postgres là trọng tài duy nhất, không được tự xoá dữ liệu).
  // Chỉ seed khi CHƯA có dữ liệu — không bao giờ xoá dữ liệu đang có.
  const existingSourceCount = await prisma.source.count();
  if (existingSourceCount > 0) {
    console.log(
      `--- Đã có ${existingSourceCount} source(s) trong DB, bỏ qua seed (idempotent, không xoá dữ liệu). ---`,
    );
    return;
  }

  const masterKey = getMasterKey();

  // Đọc cấu hình từ .env (nếu người dùng đã điền, nếu chưa thì dùng mock test key)
  const githubSecret = (process.env.GITHUB_WEBHOOK_SECRET && process.env.GITHUB_WEBHOOK_SECRET.trim()) || 'gh_webhook_secret_test_123';
  const payosChecksum = (process.env.PAYOS_CHECKSUM_KEY && process.env.PAYOS_CHECKSUM_KEY.trim()) || 'checksum_payos_secret_key_456';
  const sepayApiKey = (process.env.SEPAY_API_KEY && process.env.SEPAY_API_KEY.trim()) || 'sepay_apikey_token_secret_789';
  const demoSepayApiKey = process.env.DEMO_SEPAY_APIKEY?.trim() || undefined;
  const destCfg = destinationConfigsFromEnv();

  // 1. Tạo Sources
  const githubSource = await prisma.source.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      provider: ProviderEnum.github,
      name: 'GitHub Repository Main',
      sourceKey: 'src_github_main',
      isActive: true,
      secrets: {
        create: {
          secretEncrypted: aesGcmEncrypt(githubSecret, masterKey),
          version: 1,
        },
      },
    },
  });

  const payosSource = await prisma.source.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      provider: ProviderEnum.payos,
      name: 'PayOS Payment Gateway',
      sourceKey: 'src_payos_main',
      isActive: true,
      secrets: {
        create: {
          secretEncrypted: aesGcmEncrypt(payosChecksum, masterKey),
          version: 1,
        },
      },
    },
  });

  const sepaySource = await prisma.source.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      provider: ProviderEnum.sepay,
      name: 'SePay Bank Monitoring',
      sourceKey: 'src_sepay_main',
      isActive: true,
      secrets: {
        // Khoá thật (v1) + khoá DEMO (v2, nếu có) cho nút "Giả lập chuyển khoản" ở LOCAL.
        // Khoá demo nằm trong bundle trình duyệt nên KHÔNG BAO GIỜ được là khoá SePay thật (ADR-027).
        create: [sepayApiKey, demoSepayApiKey]
          .filter((k, i, all): k is string => !!k && all.indexOf(k) === i)
          .map((k, i) => ({ secretEncrypted: aesGcmEncrypt(k, masterKey), version: i + 1 })),
      },
    },
  });

  console.log(`Đã tạo 3 sources: GitHub (${githubSource.id}), PayOS (${payosSource.id}), SePay (${sepaySource.id})`);

  // 2. Tạo Destinations
  const discordDest = await prisma.destination.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      name: SEED_DESTINATION_NAMES.discord,
      type: DestinationType.discord,
      configEncrypted: aesGcmEncrypt(JSON.stringify(destCfg.discord), masterKey),
      rateLimitRps: 10,
    },
  });

  const telegramDest = await prisma.destination.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      name: SEED_DESTINATION_NAMES.telegram,
      type: DestinationType.telegram,
      configEncrypted: aesGcmEncrypt(JSON.stringify(destCfg.telegram), masterKey),
      rateLimitRps: 10,
    },
  });

  const shopDest = await prisma.destination.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      name: SEED_DESTINATION_NAMES.shop,
      type: DestinationType.webhook,
      configEncrypted: aesGcmEncrypt(JSON.stringify(destCfg.shop), masterKey),
      signingSecretEncrypted: aesGcmEncrypt(destCfg.shopSigningSecret, masterKey),
      rateLimitRps: 20,
    },
  });

  console.log(`Đã tạo 3 destinations: Discord (${discordDest.id}), Telegram (${telegramDest.id}), Shop (${shopDest.id})`);

  // 3. Tạo Subscriptions
  await prisma.subscription.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      destinationId: discordDest.id,
      name: 'Báo Git commits lên Discord',
      eventTypes: ['repo.push', 'repo.pull_request.opened'],
      // S3-2: data theo catalog repo.* (docs/EVENT-CATALOG.md) — repo.fullName, actor.login
      template: '📢 **GitHub Update**:\nRepo: {{data.repo.fullName}}\nAction: {{type}}\nSender: {{data.actor.login}}',
      isActive: true,
    },
  });

  await prisma.subscription.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      destinationId: telegramDest.id,
      name: 'Báo biến động thanh toán lên Telegram',
      // S3-2: một đầu ra duy nhất — mọi nguồn thanh toán ra kiểu chuẩn payment.* (ADR-053).
      // Văn bản thuần (ADR-042): không Markdown; placeholder đúng cho MỌI provider.
      eventTypes: ['payment.received'],
      template:
        'Giao dịch mới\nNguồn: {{source}}\nSố tiền: {{data.amount}} {{data.currency}}\nNội dung: {{data.memo}}\nMã tham chiếu: {{data.reference}}',
      isActive: true,
    },
  });

  await prisma.subscription.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      destinationId: shopDest.id,
      name: 'Chuyển webhook thanh toán về Demo Shop',
      eventTypes: ['payment.received'],
      isActive: true,
    },
  });

  console.log('Đã tạo 3 subscriptions.');
  console.log('--- Hoàn tất Seed Database thành công! ---');
}

export { seed };

if (require.main === module) {
  if (process.argv.includes('--sync-destinations') && !process.argv.includes(ALLOW_DEFAULTS_FLAG)) {
    // Thiếu env -> destinationConfigsFromEnv() rơi về mock/secret mặc định và GHI ĐÈ đích đang chạy.
    const missing = checkSyncDestinationsEnv(process.env);
    if (missing.length > 0) {
      console.error(
        `--sync-destinations TỪ CHỐI chạy: thiếu biến môi trường ${missing.join(', ')}.
` +
          `Đặt các biến này (giá trị thật), hoặc thêm ${ALLOW_DEFAULTS_FLAG} nếu CHỦ Ý dùng giá trị mặc định/mock.`,
      );
      process.exit(2);
    }
  }
  const run = process.argv.includes('--sync-destinations')
    ? () => {
        console.log('--- Đồng bộ cấu hình đích seed từ env hiện tại (--sync-destinations) ---');
        return syncDestinations().then((changed) => console.log(`--- Xong: ${changed.length} đích đã đổi ---`));
      }
    : seed;
  run()
    .catch((e) => {
      console.error('Lỗi khi seed:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
