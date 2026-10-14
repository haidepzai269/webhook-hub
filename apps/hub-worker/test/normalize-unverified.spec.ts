jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
  }));
});
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('@hub/crypto', () => ({
  ...jest.requireActual('@hub/crypto'),
  createSsrfSafeAxiosConfig: jest.fn(async (url: string) => ({ url, httpAgent: undefined, httpsAgent: undefined })),
}));

import axios from 'axios';
import { toWebhookBody } from '@hub/common';
import { NormalizeConsumer } from '../src/consumers/normalize.consumer';
import { workerRegistry } from '../src/metrics';
import { TelegramSender } from '../src/senders/telegram.sender';
import { DiscordSender } from '../src/senders/discord.sender';
import { WebhookSender } from '../src/senders/webhook.sender';

/**
 * PK5 (SPEC-provider-khac §7.1 + E4/E5/E24, ADR-206): worker — `events.verified` CHÉP từ `raw_events.verified` (không suy
 * từ config), khoá 3 lần hai (chưa xác thực + kiểu chuẩn = lỗi vĩnh viễn), khoá 4 (router chỉ giao tới `acceptUnverified`),
 * nhãn ở phong bì / Telegram / Discord.
 */
const TENANT = '00000000-0000-0000-0000-000000000001';
const RAW = '11111111-1111-1111-1111-111111111111';

const UNVERIFIED = { scheme: 'unverified', eventType: 'momo.ipn', forwardHeaders: ['x-sig'] };
const HMAC_MAPPED = {
  scheme: 'hmac',
  header: 'x-sig',
  idempotency: { field: 'transId' },
  eventType: 'payment.received',
  mapping: { amount: 'amount', currency: { const: 'VND' }, method: { const: 'bank_transfer' }, providerTxnId: 'transId', paidAt: 'paidAt' },
};
const HMAC_PLAIN = { scheme: 'hmac', header: 'x-sig', idempotency: { field: 'transId' }, eventType: 'acme.paid' };

async function skipped(): Promise<number> {
  const m = await workerRegistry.getSingleMetric('hub_unverified_skipped_total')!.get();
  return m.values[0]?.value ?? 0;
}

/** Chạy NormalizeConsumer với MỘT raw event (cờ `verified` của raw + config HIỆN TẠI của source) và các subscription khớp. */
async function normalize(o: { verified: boolean | undefined; config: unknown; subs?: Array<{ id: string; acceptUnverified?: boolean }> }) {
  const body = { transId: 'T1', amount: 50000, paidAt: '2026-10-14 10:00:00' };
  const raw = Buffer.from(JSON.stringify(body));
  const tx = {
    event: { create: jest.fn(async ({ data }: any) => data) },
    subscription: {
      findMany: jest.fn().mockResolvedValue((o.subs ?? []).map((s) => ({ ...s, destinationId: `dst-${s.id}`, destination: { id: `dst-${s.id}`, name: s.id, type: 'webhook', verification: 'VERIFIED' } }))),
    },
    delivery: { create: jest.fn(async ({ data }: any) => ({ ...data, id: `del-${data.subscriptionId}` })) },
    outbox: { create: jest.fn() },
    processedMessage: { create: jest.fn() },
  };
  const rawRow: any = { id: RAW, headers: { 'x-sig': 'abc', __hub_meta: { method: 'POST' } }, body, bodyRaw: raw, contentType: 'application/json', receivedAt: new Date('2026-10-14T03:00:00Z'), source: { verificationConfig: o.config } };
  if (o.verified !== undefined) rawRow.verified = o.verified;
  const prisma: any = {
    forTenant: () => ({ findRawEventById: async () => rawRow }),
    processedMessage: { findUnique: jest.fn().mockResolvedValue(null) },
    tenantTx: (_t: string, fn: any) => fn(tx),
  };
  const channel: any = { ack: jest.fn(), nack: jest.fn(), sendToQueue: jest.fn() };
  const payload = { rawEventId: RAW, sourceId: 'src-g', tenantId: TENANT, provider: 'generic', correlationId: 'c' };
  await new NormalizeConsumer(prisma).handleMessage({ content: Buffer.from(JSON.stringify(payload)), properties: { headers: {} } } as any, channel);
  return { tx, channel };
}

describe('[PK5] normalize + định tuyến sự kiện chưa xác thực', () => {
  it('[PK:T16] (phần a) subscription KHÔNG acceptUnverified -> 0 delivery, metric hub_unverified_skipped_total tăng; có cờ -> giao', async () => {
    const before = await skipped();
    const { tx, channel } = await normalize({ verified: false, config: UNVERIFIED, subs: [{ id: 'plain' }, { id: 'opted', acceptUnverified: true }, { id: 'off', acceptUnverified: false }] });
    expect(channel.ack).toHaveBeenCalled();
    expect(tx.event.create.mock.calls[0][0].data.verified).toBe(false);
    expect(tx.delivery.create.mock.calls.map((c: any) => c[0].data.subscriptionId)).toEqual(['opted']);
    expect(tx.outbox.create).toHaveBeenCalledTimes(1);
    expect((await skipped()) - before).toBe(2);
  });

  it('[PK:T16] (phần b) sự kiện ĐÃ xác thực đi mọi subscription khớp như cũ (cờ acceptUnverified không đổi gì), metric không tăng', async () => {
    const before = await skipped();
    const { tx } = await normalize({ verified: true, config: HMAC_PLAIN, subs: [{ id: 'plain' }, { id: 'opted', acceptUnverified: true }] });
    expect(tx.event.create.mock.calls[0][0].data.verified).toBe(true);
    expect(tx.delivery.create).toHaveBeenCalledTimes(2);
    expect(await skipped()).toBe(before);
    // Raw cũ trước migration (không có cột) = đã xác thực.
    const legacy = await normalize({ verified: undefined, config: HMAC_PLAIN, subs: [{ id: 'plain' }] });
    expect(legacy.tx.event.create.mock.calls[0][0].data.verified).toBe(true);
    expect(legacy.tx.delivery.create).toHaveBeenCalledTimes(1);
  });

  it('[PK:T37] (phần a) đổi config sang hmac rồi renormalize raw CŨ chưa xác thực -> event vẫn verified=false (chép từ raw, không suy từ config)', async () => {
    const { tx, channel } = await normalize({ verified: false, config: HMAC_PLAIN, subs: [{ id: 'plain' }] });
    expect(channel.ack).toHaveBeenCalled();
    const evt = tx.event.create.mock.calls[0][0].data;
    expect(evt).toMatchObject({ type: 'acme.paid', verified: false });
    expect(tx.delivery.create).not.toHaveBeenCalled(); // khoá 4 vẫn giữ sau khi đổi config
  });

  it('[PK:T15] (phần b) raw chưa xác thực mà ra kiểu chuẩn (config đổi sang hmac + mapping payment.received, hoặc config unverified ép qua DB) -> lỗi VĨNH VIỄN: nack DLQ, 0 event, 0 delivery', async () => {
    for (const config of [HMAC_MAPPED, { ...UNVERIFIED, eventType: 'payment.received' }]) {
      const { tx, channel } = await normalize({ verified: false, config, subs: [{ id: 'opted', acceptUnverified: true }] });
      expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
      expect(channel.sendToQueue).not.toHaveBeenCalled(); // không retry: lỗi dữ liệu
      expect(tx.event.create).not.toHaveBeenCalled();
      expect(tx.delivery.create).not.toHaveBeenCalled();
    }
    // Cùng config ánh xạ, raw ĐÃ xác thực -> payment.received hợp lệ đi bình thường (khoá chỉ chặn bản chưa xác thực).
    const ok = await normalize({ verified: true, config: HMAC_MAPPED, subs: [{ id: 'plain' }] });
    expect(ok.channel.ack).toHaveBeenCalled();
    expect(ok.tx.event.create.mock.calls[0][0].data).toMatchObject({ type: 'payment.received', verified: true });
  });

  it('data của event chưa xác thực có khuôn cố định {raw, contentType, headers, method} — đích tự verify', async () => {
    const { tx } = await normalize({ verified: false, config: UNVERIFIED, subs: [] });
    const data = tx.event.create.mock.calls[0][0].data.data;
    expect(Object.keys(data).sort()).toEqual(['contentType', 'headers', 'method', 'raw']);
    expect(data.headers).toEqual({ 'x-sig': 'abc' });
    expect(Buffer.from(data.raw, 'base64').toString('utf8')).toBe('{"transId":"T1","amount":50000,"paidAt":"2026-10-14 10:00:00"}');
  });
});

describe('[PK5] nhãn "chưa xác thực" ở mọi đường giao (E4)', () => {
  const evt = (verified?: boolean) =>
    ({ id: 'evt_1', tenantId: TENANT, type: 'momo.ipn', source: 'generic', sourceId: 's', data: { raw: 'e30=' }, occurredAt: '2026-10-14T00:00:00.000Z', receivedAt: '2026-10-14T00:00:00.000Z', correlationId: 'c', origin: 'webhook', normalized: false, ...(verified === undefined ? {} : { verified }) }) as any;

  it('[PK:T16] (phần c) phong bì webhook mang "verified": false (toWebhookBody — nguồn duy nhất, hub listen dùng chung); đã xác thực / vắng -> true', async () => {
    expect(JSON.parse(toWebhookBody(evt(false))).verified).toBe(false);
    expect(JSON.parse(toWebhookBody(evt(true))).verified).toBe(true);
    expect(JSON.parse(toWebhookBody(evt())).verified).toBe(true);
    (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: 'ok', headers: {} });
    await new WebhookSender().send({ url: 'https://shop.example.com/hook' }, '', evt(false), `whsec_${Buffer.from('k'.repeat(24)).toString('base64')}`);
    const sent = (axios.post as jest.Mock).mock.calls.at(-1);
    expect(JSON.parse(String(sent[1]))).toMatchObject({ verified: false, data: { raw: 'e30=' } });
  });

  it('Telegram / Discord: tiền tố "[Chưa xác thực]" khi verified=false (kể cả nội dung từ template); đã xác thực không đổi', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
    await new TelegramSender().send({ botToken: '1:t', chatId: '-1', apiUrl: 'http://mock/telegram' }, 'Nhận 50000', evt(false));
    expect((axios.post as jest.Mock).mock.calls.at(-1)[1].text).toBe('[Chưa xác thực] Nhận 50000');
    await new TelegramSender().send({ botToken: '1:t', chatId: '-1', apiUrl: 'http://mock/telegram' }, 'Nhận 50000', evt(true));
    expect((axios.post as jest.Mock).mock.calls.at(-1)[1].text).toBe('Nhận 50000');
    await new DiscordSender().send({ webhookUrl: 'https://discord.example.com/api/webhooks/1/x' }, '', evt(false));
    expect((axios.post as jest.Mock).mock.calls.at(-1)[1].content).toMatch(/^\[Chưa xác thực\] \[Webhook Hub\] Nhận sự kiện momo\.ipn/);
  });
});
