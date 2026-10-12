import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { ProviderRegistry } from '@hub/providers';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * ADR-139 (Q1 = a, CAN-ADMIN-QUYET-DX): 401 (chữ ký) / 422 (thiếu khoá chống trùng) ở `/hooks` đi qua
 * `adapter.buildAck` — định dạng ack của TỪNG provider, STATUS GIỮ NGUYÊN, GenericAdapter kèm `fix` cho dev.
 * Ack không bao giờ chứa secret hay phản chiếu body request.
 */
describe('[DX:UX6] (phần a) ingest — ack từ chối đi qua adapter.buildAck (ADR-139)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'bank_secret_SUPERSECRET_123';
  const MARKER = 'BODY_MARKER_ZXQ';
  beforeAll(() => (process.env.MASTER_KEY = MASTER));

  function build(provider: string, verificationConfig: unknown = null) {
    const source = { id: 'src-1', tenantId: 't', provider, isActive: true, verificationConfig, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] };
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) }, outbox: { create: jest.fn() } };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      rawEvent: { create: jest.fn().mockResolvedValue({}) },
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const redis: any = { checkRateLimit: jest.fn().mockResolvedValue(true), getIdempotencyKey: jest.fn().mockResolvedValue(null), setIdempotencyKey: jest.fn() };
    return { svc: new IngestService(prisma, redis), redis, tx };
  }
  const req = (provider: string, body: string, headers: Record<string, string> = {}) => ({
    provider: provider as any, sourceKey: `src_${provider}_x`, headers: { 'content-type': 'application/json', ...headers }, rawBody: Buffer.from(body), body: JSON.parse(body), contentType: 'application/json',
  });

  it.each(['sepay', 'payos', 'github', 'stripe', 'generic'])('%s: chữ ký sai -> VẪN 401, body = buildAck của provider, không lộ secret/body', async (p) => {
    const cfg = p === 'generic' ? { scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'transactionId' }, eventType: 'bank.tx' } : null;
    const { svc, redis, tx } = build(p, cfg);
    const b = JSON.stringify({ transactionId: 'TX1', id: 1, data: { orderCode: 1 }, note: MARKER });
    const r = await svc.ingestWebhook(req(p, b, { 'x-signature': 'sai', authorization: 'Apikey sai', 'stripe-signature': 't=1,v1=sai', 'x-hub-signature-256': 'sha256=sai' }));
    expect(r.status).toBe(401);
    const expected = ProviderRegistry.get(p as any).buildAck({ accepted: false, status: 401, message: 'Chữ ký webhook không hợp lệ (Unauthorized)' });
    expect(r.body).toEqual(expected.body);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('SUPERSECRET');
    expect(text).not.toContain(MARKER);
    expect(tx.outbox.create).not.toHaveBeenCalled();
    expect(redis.setIdempotencyKey).not.toHaveBeenCalled(); // không chạm Redis chống trùng
  });

  it('generic 401 có `fix` (nói tới verificationConfig / raw body bytes)', async () => {
    const { svc } = build('generic', { scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'transactionId' }, eventType: 'bank.tx' });
    const r: any = await svc.ingestWebhook(req('generic', '{"transactionId":"TX1"}', { 'x-signature': 'sai' }));
    expect(r).toMatchObject({ status: 401, body: { ok: false, fix: expect.stringMatching(/verificationConfig/) } });
  });

  it('generic 422 thiếu khoá chống trùng -> VẪN 422, body {ok:false, error:"missing_idempotency_key", fix}', async () => {
    const { svc } = build('generic', { scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'transactionId' }, eventType: 'bank.tx' });
    const b = '{"soTien":1}';
    const r: any = await svc.ingestWebhook(req('generic', b, { 'x-signature': createHmac('sha256', SECRET).update(b).digest('hex') }));
    expect(r).toEqual({ status: 422, body: { ok: false, error: 'missing_idempotency_key', fix: expect.stringMatching(/idempotency/) } });
  });

  it('buildAck ném lỗi -> vẫn trả status gốc với body cũ (không 500)', async () => {
    const a = ProviderRegistry.get('sepay' as any);
    const spy = jest.spyOn(a, 'buildAck').mockImplementation(() => {
      throw new Error('boom');
    });
    const { svc } = build('sepay');
    const r = await svc.ingestWebhook(req('sepay', '{"id":1}', { authorization: 'Apikey sai' }));
    spy.mockRestore();
    expect(r).toEqual({ status: 401, body: { error: 'Chữ ký webhook không hợp lệ (Unauthorized)' } });
  });
});
