import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * S8 (SPEC §4.8): lõi ingest chuyển `verificationConfig` của source cho adapter (không `if provider`);
 * thiếu khoá chống trùng -> REJECTED (signature_valid=true) + 422; token static ở header tuỳ chọn bị che.
 */
describe('IngestService + GenericAdapter (S8)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'bank_secret_123';
  beforeAll(() => (process.env.MASTER_KEY = MASTER));

  function build(verificationConfig: unknown, secret = SECRET) {
    const source = { id: 'src-g', tenantId: 't', provider: 'generic', isActive: true, verificationConfig, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(secret, MASTER) }] };
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) }, outbox: { create: jest.fn() } };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      rawEvent: { create: jest.fn().mockResolvedValue({}) },
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const redis: any = { checkRateLimit: jest.fn().mockResolvedValue(true), getIdempotencyKey: jest.fn().mockResolvedValue(null), setIdempotencyKey: jest.fn() };
    return { svc: new IngestService(prisma, redis), prisma, tx };
  }
  const req = (body: string, headers: Record<string, string>) => ({
    provider: 'generic' as const, sourceKey: 'src_generic_x', headers, rawBody: Buffer.from(body), body: JSON.parse(body), contentType: 'application/json',
  });
  const HMAC = { scheme: 'hmac-sha256', header: 'x-signature', idempotency: { field: 'transactionId' }, eventType: 'bank.transaction.received' };
  const sig = (b: string) => createHmac('sha256', SECRET).update(b).digest('hex');

  it('[MS:T9] (phần c) ký đúng -> 200 {ok:true}, raw_event ACCEPTED khoá generic:TX1', async () => {
    const { svc, tx } = build(HMAC);
    const b = '{"transactionId":"TX1","soTien":50000}';
    expect(await svc.ingestWebhook(req(b, { 'x-signature': sig(b) }))).toEqual({ status: 200, body: { ok: true } });
    expect(tx.rawEvent.create.mock.calls[0][0].data).toMatchObject({ idempotencyKey: 'generic:TX1', status: 'ACCEPTED', signatureHeader: sig(b) });
  });

  it('[MS:T9] (phần d) ký đúng nhưng thiếu transactionId -> 422 missing_idempotency_key, lưu REJECTED signature_valid=true, KHÔNG outbox (không sinh sự kiện)', async () => {
    // AU6 (SPEC-auth §5.12): raw_events có RLS -> mẫu REJECTED ghi trong tenantTx của đúng project (trước đây ghi
    // ngoài transaction). Điều cần giữ: KHÔNG có outbox / sự kiện nào cho request bị từ chối.
    const { svc, prisma, tx } = build(HMAC);
    const b = '{"soTien":1}';
    expect(await svc.ingestWebhook(req(b, { 'x-signature': sig(b) }))).toEqual({ status: 422, body: { ok: false, error: 'missing_idempotency_key', fix: expect.any(String) } }); // ADR-139: ack qua GenericAdapter.buildAck
    expect(tx.rawEvent.create.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED', signatureValid: true });
    expect(tx.outbox.create).not.toHaveBeenCalled();
    expect(prisma.rawEvent.create).not.toHaveBeenCalled(); // không còn ghi raw_events ngoài transaction có project
  });

  it('S8: sai chữ ký -> 401, REJECTED signature_valid=false; source generic thiếu config -> 401 (không nhận bừa)', async () => {
    const { svc, tx } = build(HMAC);
    const b = '{"transactionId":"TX1"}';
    expect((await svc.ingestWebhook(req(b, { 'x-signature': sig('khác') }))).status).toBe(401);
    expect(tx.rawEvent.create.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED', signatureValid: false });
    expect(tx.outbox.create).not.toHaveBeenCalled();
    expect((await build(null).svc.ingestWebhook(req(b, { 'x-signature': sig(b) }))).status).toBe(401);
  });

  it('S8: static-token ở header x-token -> header và signature_header đã che trước khi lưu', async () => {
    const TOKEN = 'tok_SHOULD_NOT_LEAK_123';
    const { svc, tx } = build({ scheme: 'static-token', header: 'x-token', idempotency: { field: 'transactionId' }, eventType: 'bank.x' }, TOKEN);
    const b = '{"transactionId":"TX9"}';
    expect((await svc.ingestWebhook(req(b, { 'x-token': TOKEN }))).status).toBe(200);
    const data = tx.rawEvent.create.mock.calls[0][0].data;
    expect(JSON.stringify(data.headers) + data.signatureHeader).not.toContain(TOKEN);
    expect(data.headers['x-token']).toBe('***');
  });
});
