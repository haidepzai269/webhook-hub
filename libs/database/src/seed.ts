import { PrismaClient, ProviderEnum, DestinationType } from '@prisma/client';
import { aesGcmEncrypt } from '@hub/crypto';

export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const DEV_MASTER_KEY = process.env.MASTER_KEY || 'dev-master-secret-key-at-least-32-chars!';

const prisma = new PrismaClient();

async function seed() {
  console.log('--- Bắt đầu gieo dữ liệu ban đầu (Seed Database) ---');

  // Xóa dữ liệu cũ nếu có
  await prisma.deliveryAttempt.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.destination.deleteMany();
  await prisma.event.deleteMany();
  await prisma.outbox.deleteMany();
  await prisma.rawEvent.deleteMany();
  await prisma.sourceSecret.deleteMany();
  await prisma.source.deleteMany();

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
          secretEncrypted: aesGcmEncrypt('gh_webhook_secret_test_123', DEV_MASTER_KEY),
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
          secretEncrypted: aesGcmEncrypt('checksum_payos_secret_key_456', DEV_MASTER_KEY),
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
        create: {
          secretEncrypted: aesGcmEncrypt('sepay_apikey_token_secret_789', DEV_MASTER_KEY),
          version: 1,
        },
      },
    },
  });

  console.log(`Đã tạo 3 sources: GitHub (${githubSource.id}), PayOS (${payosSource.id}), SePay (${sepaySource.id})`);

  // 2. Tạo Destinations
  const discordDest = await prisma.destination.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      name: 'Discord Dev Channel',
      type: DestinationType.discord,
      configEncrypted: aesGcmEncrypt(
        JSON.stringify({ webhookUrl: 'http://localhost:4000/mock/discord' }),
        DEV_MASTER_KEY,
      ),
      rateLimitRps: 10,
    },
  });

  const telegramDest = await prisma.destination.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      name: 'Telegram Ops Group',
      type: DestinationType.telegram,
      configEncrypted: aesGcmEncrypt(
        JSON.stringify({ botToken: '123456:mock-token', chatId: '-100123456789' }),
        DEV_MASTER_KEY,
      ),
      rateLimitRps: 10,
    },
  });

  const shopDest = await prisma.destination.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      name: 'Demo Shop Outbound Webhook',
      type: DestinationType.webhook,
      configEncrypted: aesGcmEncrypt(
        JSON.stringify({ url: 'http://localhost:4001/hub-webhook' }),
        DEV_MASTER_KEY,
      ),
      signingSecretEncrypted: aesGcmEncrypt('hub_outbound_signing_secret_999', DEV_MASTER_KEY),
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
      template: '📢 **GitHub Update**:\nRepo: {{data.repository.name}}\nAction: {{type}}\nSender: {{data.sender.login}}',
      isActive: true,
    },
  });

  await prisma.subscription.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      destinationId: telegramDest.id,
      name: 'Báo biến động thanh toán lên Telegram',
      eventTypes: ['payment.succeeded', 'bank.transfer.received', 'order.paid'],
      template: '💰 **Giao dịch mới**:\nNguồn: {{source}}\nMã đơn: {{data.orderCode}}\nSố tiền: {{data.amount}} VND',
      isActive: true,
    },
  });

  await prisma.subscription.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      destinationId: shopDest.id,
      name: 'Chuyển webhook thanh toán về Demo Shop',
      eventTypes: ['payment.succeeded', 'bank.transfer.received'],
      isActive: true,
    },
  });

  console.log('Đã tạo 3 subscriptions.');
  console.log('--- Hoàn tất Seed Database thành công! ---');
}

seed()
  .catch((e) => {
    console.error('Lỗi khi seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
