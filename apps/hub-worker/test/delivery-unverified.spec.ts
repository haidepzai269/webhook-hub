jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({ connect: jest.fn().mockResolvedValue(undefined), publish: jest.fn().mockResolvedValue(1), on: jest.fn() })),
);
// HTTP đi ra bị chặn ở axios (không mạng); SSRF guard có test riêng — ở đây giữ nguyên mọi thứ khác của @hub/crypto (giải mã config THẬT).
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { __esModule: true, ...actual, default: Object.assign(Object.create(actual.default), { post: jest.fn() }) };
});
jest.mock('@hub/crypto', () => ({
  ...jest.requireActual('@hub/crypto'),
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
}));

import axios from 'axios';
import { aesGcmEncrypt } from '@hub/crypto';
import { DeliveryConsumer } from '../src/consumers/delivery.consumer';
import { DELIVERY_ID, TENANT_ID, TEST_MASTER_KEY, buildChannel, buildDeliveryRow, buildFakeCircuitBreaker, buildSlimMsg, toAmqpMsg } from './delivery-fixtures';

/**
 * REVIEW-PK5 TB-2 (khoá 2 chạm tới ĐÍCH, E4, ADR-206): đường giao THẬT — DeliveryConsumer đọc dòng `events` qua
 * `findDeliveryForSend` -> `toNormalizedEvent` -> sender thật (WebhookSender / TelegramSender / DiscordSender) -> HTTP (axios
 * giả). Body gửi đi phải nói "chưa xác thực": webhook `"verified":false`, Telegram/Discord tiền tố "[Chưa xác thực]".
 * Event thường: `"verified":true`, không tiền tố. Đột biến `verified: true` cố định ở `toNormalizedEvent` -> đỏ.
 */
type DestType = 'webhook' | 'telegram' | 'discord';

function rowFor(type: DestType, verified: boolean | undefined) {
  const row: any = buildDeliveryRow();
  row.event = { ...row.event, type: 'momo.ipn', source: 'generic', data: { raw: 'e30=' }, ...(verified === undefined ? {} : { verified }) };
  const d = row.subscription.destination;
  d.type = type;
  if (type === 'telegram') d.configEncrypted = aesGcmEncrypt(JSON.stringify({ botToken: '1:t', chatId: '-1', apiUrl: 'https://tg.example.com' }), TEST_MASTER_KEY);
  if (type === 'discord') d.configEncrypted = aesGcmEncrypt(JSON.stringify({ webhookUrl: 'https://discord.example.com/api/webhooks/1/x' }), TEST_MASTER_KEY);
  return row;
}

function buildPrisma(row: any) {
  const tx = {
    deliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
    delivery: { findFirst: jest.fn().mockResolvedValue({ id: DELIVERY_ID, tenantId: TENANT_ID }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    processedMessage: { create: jest.fn(async ({ data }: any) => data) },
  };
  const repo = {
    findDeliveryForSend: jest.fn().mockResolvedValue(row),
    claimForSend: jest.fn().mockResolvedValue(1),
    updateDeliveryStatus: jest.fn().mockResolvedValue({}),
    deferDelivery: jest.fn().mockResolvedValue(1),
    getDeliveryLeaseState: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', attemptGeneration: 1, attemptCount: 1 }),
  };
  const prisma: any = {
    forTenant: jest.fn().mockReturnValue(repo),
    processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
    tenantTx(_t: any, fn: any, o?: any) {
      return this.$transaction(fn, o);
    },
    systemTx(_r: any, fn: any) {
      return this.$transaction(fn);
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return prisma;
}

/** Chạy một message qua DeliveryConsumer THẬT; trả payload axios đã POST tới đích. */
async function deliver(type: DestType, verified: boolean | undefined): Promise<unknown> {
  const post = axios.post as jest.Mock;
  post.mockReset();
  post.mockResolvedValue({ status: 200, data: 'ok' });
  const consumer = new DeliveryConsumer(buildPrisma(rowFor(type, verified)), buildFakeCircuitBreaker('CLOSED'));
  const channel = buildChannel();
  await consumer.handleMessage(toAmqpMsg(buildSlimMsg()), channel);
  expect(channel.ack).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledTimes(1);
  return post.mock.calls[0][1];
}

describe('DeliveryConsumer — cờ verified tới đích (REVIEW-PK5 TB-2)', () => {
  it('[PK:T16] (phần k) webhook: event verified=false -> body gửi đi có "verified":false; event thường / cột vắng -> "verified":true', async () => {
    const body = await deliver('webhook', false);
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toMatchObject({ type: 'momo.ipn', verified: false, data: { raw: 'e30=' } });
    expect(JSON.parse((await deliver('webhook', true)) as string).verified).toBe(true);
    expect(JSON.parse((await deliver('webhook', undefined)) as string).verified).toBe(true);
  });

  it('[PK:T16] (phần l) Telegram / Discord: event verified=false -> tin bắt đầu bằng "[Chưa xác thực]"; event thường -> không tiền tố', async () => {
    expect((await deliver('telegram', false)) as any).toMatchObject({ text: expect.stringMatching(/^\[Chưa xác thực\]/) });
    expect(((await deliver('telegram', true)) as any).text).not.toContain('Chưa xác thực');
    expect((await deliver('discord', false)) as any).toMatchObject({ content: expect.stringMatching(/^\[Chưa xác thực\]/) });
    expect(((await deliver('discord', true)) as any).content).not.toContain('Chưa xác thực');
  });
});
