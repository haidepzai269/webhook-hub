import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { logger } from '@hub/common';
import { GenericAdapter } from '@hub/providers';
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
    expect(await svc.ingestWebhook(req(b, { 'x-signature': sig(b) }))).toEqual({ status: 200, body: { ok: true }, outcome: 'accepted' });
    expect(tx.rawEvent.create.mock.calls[0][0].data).toMatchObject({ idempotencyKey: 'generic:TX1', status: 'ACCEPTED', signatureHeader: sig(b) });
  });

  it('[MS:T9] (phần d) ký đúng nhưng thiếu transactionId -> 422 missing_idempotency_key, lưu REJECTED signature_valid=true, KHÔNG outbox (không sinh sự kiện)', async () => {
    // AU6 (SPEC-auth §5.12): raw_events có RLS -> mẫu REJECTED ghi trong tenantTx của đúng project (trước đây ghi
    // ngoài transaction). Điều cần giữ: KHÔNG có outbox / sự kiện nào cho request bị từ chối.
    const { svc, prisma, tx } = build(HMAC);
    const b = '{"soTien":1}';
    expect(await svc.ingestWebhook(req(b, { 'x-signature': sig(b) }))).toEqual({ status: 422, body: { ok: false, error: 'missing_idempotency_key', fix: expect.any(String) }, outcome: 'rejected' }); // ADR-139: ack qua GenericAdapter.buildAck
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

  /** Ghi lại MỌI dòng log (kể cả bindings của child) trong lúc chạy `fn`. */
  async function captureLogs<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string }> {
    const seen: string[] = [];
    const record = (...a: unknown[]) => void seen.push(JSON.stringify(a));
    const fake: any = { info: record, warn: record, error: record, debug: record, child: (b: unknown) => (record(b), fake) };
    const spies = [
      jest.spyOn(logger, 'child').mockImplementation(((b: unknown) => (record(b), fake)) as any),
      ...(['info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(logger, m).mockImplementation(record as any)),
    ];
    try {
      return { out: await fn(), logs: seen.join(' | ') };
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
  }

  it('[PK:T7] token ở query (static-token location query) không xuất hiện trong raw_events.headers, signature_header, log, diagnose — cả khi đúng lẫn khi sai', async () => {
    const TOKEN = `qtok_${'leak'.repeat(5)}`;
    const WRONG = `qtok_${'miss'.repeat(5)}`;
    const CFG = { scheme: 'static-token', location: 'query', param: 'token', idempotency: { field: 'transactionId' }, eventType: 'bank.x' };
    const b = '{"transactionId":"TXQ"}';
    const withQuery = (q: string) => ({ ...req(b, { 'content-type': 'application/json' }), query: q, method: 'POST' as const });

    const ok = build(CFG, TOKEN);
    const r1 = await captureLogs(() => ok.svc.ingestWebhook(withQuery(`x=1&token=${encodeURIComponent(TOKEN)}`)));
    expect(r1.out.status).toBe(200);
    const accepted = ok.tx.rawEvent.create.mock.calls[0][0].data;
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.signatureHeader).toBe('***');

    const ko = build(CFG, TOKEN);
    const r2 = await captureLogs(() => ko.svc.ingestWebhook(withQuery(`token=${WRONG}`)));
    expect(r2.out.status).toBe(401);
    const rejected = ko.tx.rawEvent.create.mock.calls[0][0].data;
    expect(rejected).toMatchObject({ status: 'REJECTED', signatureValid: false });

    // Token xuất hiện 2 lần trong query -> không đoán bản nào thật -> 401.
    const dup = build(CFG, TOKEN);
    expect((await dup.svc.ingestWebhook(withQuery(`token=${TOKEN}&token=${TOKEN}`))).status).toBe(401);

    const diag = new GenericAdapter().diagnose({ ...rejected, bodyRaw: undefined, receivedAt: new Date() }, { verificationConfig: CFG });
    expect(diag).toEqual({ ok: false, reason: 'token_mismatch', expectedQueryParam: 'token' });

    const everything = [JSON.stringify(accepted), JSON.stringify(rejected), r1.logs, r2.logs, JSON.stringify(diag)].join(' | ');
    expect(r1.logs.length + r2.logs.length).toBeGreaterThan(0); // có log thật để soi
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(WRONG);
    expect(everything).not.toMatch(/qtok_/);
  });
});
