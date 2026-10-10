import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient, ProviderEnum, DestinationType } from '@prisma/client';
import { aesGcmEncrypt, aesGcmDecrypt, generateWhsecSecret } from '@hub/crypto';
import { randomUUID } from 'crypto';
import { API_KEY_RE, apiKeyPrefix, buildConnectionString, generateApiKey, hashApiKey } from '@hub/common';
import { DEFAULT_TENANT_ID, getMasterKey } from './constants';
import { TenantScopedRepository } from './tenant-scoped.repository';
import { ALLOW_DEFAULTS_FLAG, checkSyncDestinationsEnv, seedTelegramActive } from './seed-env';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const prisma = new PrismaClient();

/** Test L1 gọi seed trực tiếp — đóng kết nối của client seed khi xong. */
export function disconnectSeedClient(): Promise<void> {
  return prisma.$disconnect();
}

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

export async function ensureDefaultProject() {
  await prisma.project.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: {},
    create: { id: DEFAULT_TENANT_ID, slug: 'default', name: 'Default', environment: 'test' },
  });
}

/**
 * S2 (SPEC §4.3A, X6): key `shop` (manage:endpoints + read:events) của project default — Shop dùng nó để
 * TỰ đăng ký endpoint (S11). Compose truyền CÙNG giá trị `SEED_SHOP_API_KEY` cho seed (lưu sha256) và cho
 * Shop (trong `HUB_URL`), nên stack mới tự nối không cần thao tác tay. Không đặt -> sinh ngẫu nhiên và
 * in connection string ra log ĐÚNG MỘT LẦN (lúc tạo). Idempotent: đã có key `shop` thì bỏ qua.
 */
export async function ensureShopKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const repo = new TenantScopedRepository(prisma, DEFAULT_TENANT_ID);
  const existing = (await repo.findApiKeys()).find((k) => k.serviceName === 'shop' && !k.revokedAt);
  if (existing) return null;
  const given = env.SEED_SHOP_API_KEY?.trim();
  if (given && !API_KEY_RE.test(given)) {
    throw new Error('SEED_SHOP_API_KEY sai định dạng (hk_test_|hk_live_ + 43 ký tự base64url)');
  }
  const key = given || generateApiKey('test');
  const created = await repo.createApiKey({
    serviceName: 'shop',
    keyHash: hashApiKey(key),
    keyPrefix: apiKeyPrefix(key),
    scopes: ['manage:endpoints', 'read:events'],
    readTypes: [],
  });
  await repo.createAuditLog({ action: 'api_key.created', entityType: 'api_key', entityId: created.id, actor: 'seed', metadata: { serviceName: 'shop', keyPrefix: created.keyPrefix } });
  const publicUrl = (env.HUB_PUBLIC_URL && env.HUB_PUBLIC_URL.trim()) || 'http://localhost:4000';
  console.log(`Đã tạo API key "shop" (${created.keyPrefix}…). HUB_URL=${buildConnectionString(publicUrl, key, 'default')}`);
  return key;
}

/**
 * S12 (SPEC §5, X5): "thế giới" demo đa project cho màn bảo vệ (docs/DEMO-MULTI-PROJECT.md): `cafe` (test, SePay mock)
 * và `bookstore` (live, PayOS mock), mỗi project MỘT source, MỘT key (đủ 4 scope), MỘT endpoint mock + subscription
 * `payment.*`. Idempotent theo slug (đã có thì bỏ qua cả project). Key + signing secret in ra log ĐÚNG MỘT LẦN.
 * Secret source là giá trị demo CỐ ĐỊNH, chỉ cho local (seed không chạy ở production) — để bắn mock bằng curl.
 * Endpoint do seed (operator) tạo nên ghi thẳng VERIFIED: url là mock của chính stack (`/mock/echo` hoặc sink hubv).
 */
export const DEMO_PROJECTS = [
  { slug: 'cafe', name: 'Cafe', environment: 'test' as const, provider: ProviderEnum.sepay, sourceKey: 'src_sepay_cafe', sourceName: 'SePay (Cafe, mock)', secret: 'demo_sepay_cafe_key_local_only' },
  { slug: 'bookstore', name: 'Bookstore', environment: 'live' as const, provider: ProviderEnum.payos, sourceKey: 'src_payos_bookstore', sourceName: 'PayOS (Bookstore, mock)', secret: 'demo_payos_bookstore_checksum_local_only' },
];

export async function seedDemoProjects(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (env.SEED_DEMO_PROJECTS === 'false') return [];
  const masterKey = getMasterKey();
  const publicUrl = (env.HUB_PUBLIC_URL && env.HUB_PUBLIC_URL.trim()) || 'http://localhost:4000';
  const mockBase = ((env.MOCK_BASE_URL && env.MOCK_BASE_URL.trim()) || 'http://localhost:4000').replace(/\/$/, '');
  const endpointBase = ((env.DEMO_ENDPOINT_BASE_URL && env.DEMO_ENDPOINT_BASE_URL.trim()) || `${mockBase}/mock/echo`).replace(/\/$/, '');
  const created: string[] = [];
  for (const p of DEMO_PROJECTS) {
    if (await prisma.project.findUnique({ where: { slug: p.slug } })) continue;
    const projectId = randomUUID();
    const key = generateApiKey(p.environment);
    const signingSecret = generateWhsecSecret();
    await prisma.$transaction(async (tx) => {
      await tx.project.create({ data: { id: projectId, slug: p.slug, name: p.name, environment: p.environment } });
      const repo = new TenantScopedRepository(tx as any, projectId);
      await repo.createSource({
        provider: p.provider,
        name: p.sourceName,
        sourceKey: p.sourceKey,
        isActive: true,
        secrets: { create: { secretEncrypted: aesGcmEncrypt(p.secret, masterKey), version: 1 } },
      } as any);
      // S4 (ADR-074): key có publish:events đi kèm source `api` (`api_<keyId>`) — như console tạo key.
      const keyId = randomUUID();
      const apiSource = await repo.createSource({ provider: ProviderEnum.api, name: `${p.slug}-be`, sourceKey: `api_${keyId}`, isActive: true });
      const k = await repo.createApiKey({
        id: keyId,
        sourceId: apiSource.id,
        serviceName: `${p.slug}-be`,
        keyHash: hashApiKey(key),
        keyPrefix: apiKeyPrefix(key),
        scopes: ['publish:events', 'read:events', 'manage:endpoints', 'manage:sources'],
        readTypes: [],
      });
      const dest = await repo.createDestination({
        name: `${p.slug}-endpoint`,
        type: DestinationType.webhook,
        configEncrypted: aesGcmEncrypt(JSON.stringify({ url: `${endpointBase}/${p.slug}` }), masterKey),
        signingSecretEncrypted: aesGcmEncrypt(signingSecret, masterKey),
        verification: 'VERIFIED',
        verifiedAt: new Date(),
      });
      await repo.createSubscription({ destinationId: dest.id, name: `${p.slug}: mọi thanh toán`, eventTypes: ['payment.*'], isActive: true });
      await repo.createAuditLog({ action: 'project.created', entityType: 'project', entityId: projectId, actor: 'seed', metadata: { slug: p.slug } });
      await repo.createAuditLog({ action: 'api_key.created', entityType: 'api_key', entityId: k.id, actor: 'seed', metadata: { serviceName: k.serviceName, keyPrefix: k.keyPrefix } });
    });
    created.push(p.slug);
    console.log(
      `Demo project "${p.slug}": source ${p.provider} /hooks/${p.provider}/${p.sourceKey} · endpoint ${endpointBase}/${p.slug}
` +
        `  HUB_URL=${buildConnectionString(publicUrl, key, p.slug)}
  signingSecret=${signingSecret}`,
    );
  }
  return created;
}

async function seed() {
  console.log('--- Bắt đầu gieo dữ liệu ban đầu (Seed Database) ---');

  // S1 (ADR-038): project mặc định (= DEFAULT_TENANT_ID) TRƯỚC mọi bảng khác. Upsert: chạy lại vô hại
  // (migration 20261011000000 cũng chèn dòng này cho DB cũ).
  await ensureDefaultProject();
  await ensureShopKey();
  await seedDemoProjects();

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
  const telegramActive = seedTelegramActive(process.env);
  console.log(`Subscription Telegram seed: ${telegramActive ? 'BẬT' : 'TẮT'} (SEED_TELEGRAM_ACTIVE / TELEGRAM_* — ADR-066)`);

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

  // S11 (X6, §4.12): Shop là SERVICE thật — tự đăng ký endpoint + subscription `payment.received` bằng SDK lúc khởi
  // động (key `shop` ở ensureShopKey). Seed KHÔNG tạo đích Shop nữa (kể cả verify:seed).
  console.log(`Đã tạo 2 destinations: Discord (${discordDest.id}), Telegram (${telegramDest.id}); Shop tự đăng ký qua SDK`);

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
      // S3-3: wildcard `payment.*` = mọi sự kiện thanh toán (received/sent/failed/refunded).
      // Văn bản thuần (ADR-042): không Markdown; placeholder đúng cho MỌI provider.
      // Lưu ý: `--sync-destinations` KHÔNG sửa subscription — DB đang chạy thì đổi qua dashboard/API.
      eventTypes: ['payment.*'],
      template:
        'Giao dịch mới\nNguồn: {{source}}\nSố tiền: {{data.amount}} {{data.currency}}\nNội dung: {{data.memo}}\nMã tham chiếu: {{data.reference}}',
      // Review #7 (ADR-066): seed tự chạy trên stack mới -> KHÔNG tự bật Telegram thật (xem seedTelegramActive)
      isActive: telegramActive,
    },
  });

  console.log('Đã tạo 2 subscriptions.');
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
