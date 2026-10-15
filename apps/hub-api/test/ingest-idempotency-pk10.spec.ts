import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { aesGcmEncrypt, bodyHashKey } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * PK10 (SPEC-provider-khac E31, ADR-230): lõi ingest với khoá chống trùng `{path}` / `{bodyHash: true}` của GenericAdapter —
 * lõi không biết dạng khoá (không `if`), chỉ nhận chuỗi khoá; trùng do PostgreSQL phân xử (P2002, BB-2). Body rỗng với
 * băm body -> REJECTED (signature_valid = true) + 422 `empty_body`, không outbox.
 */
describe('[PK:T40] (phần c) ingest: chống trùng theo path lồng / băm body', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'pk10_test_value';
  beforeAll(() => (process.env.MASTER_KEY = MASTER));

  function build(idempotency: unknown) {
    const verificationConfig = { scheme: 'hmac', header: 'x-acme-signature', algo: 'sha256', encoding: 'hex', idempotency, eventType: 'acme.event' };
    const source = { id: 'src-k', tenantId: 't', provider: 'generic', isActive: true, verificationConfig, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] };
    const seen = new Set<string>(); // UNIQUE (source_id, idempotency_key) của raw_events
    const tx = {
      rawEvent: {
        create: jest.fn(async ({ data }: any) => {
          if (data.status === 'ACCEPTED') {
            if (seen.has(data.idempotencyKey)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
            seen.add(data.idempotencyKey);
          }
          return { id: `raw-${seen.size}` };
        }),
      },
      outbox: { create: jest.fn(async () => ({})) },
    };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      tenantTx(_t: any, fn: any) {
        return fn(tx);
      },
      systemTx(_r: any, fn: any) {
        return fn(tx);
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const redis: any = { checkRateLimit: jest.fn().mockResolvedValue(true), getIdempotencyKey: jest.fn().mockResolvedValue(null), setIdempotencyKey: jest.fn() };
    return { svc: new IngestService(prisma, redis, { traceIngested: jest.fn() } as any), tx };
  }
  const sig = (b: string) => createHmac('sha256', SECRET).update(b).digest('hex');
  const req = (b: string) => ({
    provider: 'generic' as const,
    sourceKey: 'src_generic_k',
    headers: { 'x-acme-signature': sig(b) },
    rawBody: Buffer.from(b),
    body: b ? JSON.parse(b) : undefined,
    contentType: 'application/json',
    method: 'POST' as const,
    query: '',
  });
  const accepted = (tx: any) => tx.rawEvent.create.mock.calls.map((c: any) => c[0].data).filter((d: any) => d.status === 'ACCEPTED');

  it('path 3 cấp: khoá generic:<id lồng>; gửi lại cùng id -> DUPLICATE (200 duplicate), 1 outbox', async () => {
    const { svc, tx } = build({ path: 'webhook_metadata.event.id' });
    const b1 = '{"webhook_metadata":{"attempt":{"id":"a1"},"event":{"id":"EVT-1"}}}';
    const b2 = '{"webhook_metadata":{"attempt":{"id":"a2"},"event":{"id":"EVT-1"}}}'; // lần gửi lại: attempt đổi, event giữ
    expect(await svc.ingestWebhook(req(b1))).toEqual({ status: 200, body: { ok: true }, outcome: 'accepted' });
    expect(await svc.ingestWebhook(req(b2))).toEqual({ status: 200, body: { ok: true, duplicate: true }, outcome: 'duplicate' });
    expect(accepted(tx)[0].idempotencyKey).toBe('generic:EVT-1');
    expect(tx.outbox.create).toHaveBeenCalledTimes(1);
  });

  it('bodyHash: cùng từng byte -> DUPLICATE; khác 1 byte -> sự kiện mới; khoá = generic:body:bodyHashKey (tất định)', async () => {
    const { svc, tx } = build({ bodyHash: true });
    const b1 = '{"event":"order_created","total":1199}';
    const b2 = '{"event":"order_created","total":1198}';
    expect((await svc.ingestWebhook(req(b1))).body).toEqual({ ok: true });
    expect((await svc.ingestWebhook(req(b1))).body).toEqual({ ok: true, duplicate: true });
    expect((await svc.ingestWebhook(req(b2))).body).toEqual({ ok: true });
    const keys = accepted(tx).map((d: any) => d.idempotencyKey);
    expect(keys[0]).toBe(`generic:body:${bodyHashKey(Buffer.from(b1))}`);
    expect(keys[0]).toBe(keys[1]); // lần hai cũng sinh ĐÚNG khoá đó (rồi P2002)
    expect(keys[2]).toBe(`generic:body:${bodyHashKey(Buffer.from(b2))}`);
    expect(tx.outbox.create).toHaveBeenCalledTimes(2);
  });

  it('bodyHash + body rỗng (ký đúng) -> 422 empty_body kèm fix, REJECTED signature_valid=true, KHÔNG outbox', async () => {
    const { svc, tx } = build({ bodyHash: true });
    const r = await svc.ingestWebhook(req(''));
    expect(r).toEqual({ status: 422, body: { ok: false, error: 'empty_body', fix: expect.stringMatching(/Empty body/) }, outcome: 'rejected' });
    expect(tx.rawEvent.create.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED', signatureValid: true });
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });

  it('path thiếu giá trị -> băm body (không 422, không ngẫu nhiên); path + body rỗng -> 422 empty_body', async () => {
    const { svc, tx } = build({ path: 'data.id' });
    const b = '{"data":{}}';
    expect((await svc.ingestWebhook(req(b))).status).toBe(200);
    expect(accepted(tx)[0].idempotencyKey).toBe(`generic:body:${bodyHashKey(Buffer.from(b))}`);
    expect((await svc.ingestWebhook(req(''))).body).toMatchObject({ error: 'empty_body' });
  });

  it('tương thích ngược: source {field} cũ giữ khoá generic:<giá trị> và lỗi missing_idempotency_key', async () => {
    const { svc, tx } = build({ field: 'transId' });
    expect((await svc.ingestWebhook(req('{"transId":"TX1"}'))).status).toBe(200);
    expect(accepted(tx)[0].idempotencyKey).toBe('generic:TX1');
    expect((await svc.ingestWebhook(req('{"x":1}'))).body).toMatchObject({ error: 'missing_idempotency_key' });
  });
});
