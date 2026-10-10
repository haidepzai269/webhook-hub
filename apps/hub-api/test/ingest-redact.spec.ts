import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * Review SPEC-1 #1 (ADR-051): IngestService lưu raw_events với header ĐÃ che — cả ACCEPTED lẫn
 * REJECTED — còn bodyRaw giữ nguyên bytes.
 */
describe('IngestService — che header nhạy cảm trước khi lưu', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const KEY = 'sepay_real_key_SHOULD_NOT_LEAK';
  const body = JSON.stringify({ id: 777, transferAmount: 1000, content: 'DH1' });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  function build() {
    const source = {
      id: 'src-sepay',
      tenantId: 't',
      isActive: true,
      secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(KEY, MASTER) }],
    };
    const tx = {
      rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) },
      outbox: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      rawEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const redis: any = {
      checkRateLimit: jest.fn().mockResolvedValue(true),
      getIdempotencyKey: jest.fn().mockResolvedValue(null),
      setIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    };
    return { svc: new IngestService(prisma, redis), prisma, tx };
  }

  const req = (auth: string) => ({
    provider: 'sepay' as const,
    sourceKey: 'src_sepay_main',
    headers: { authorization: auth, cookie: 'sid=COOKIE_SECRET', 'content-type': 'application/json' } as Record<string, string>,
    rawBody: Buffer.from(body),
    body: JSON.parse(body),
    contentType: 'application/json',
  });

  it('ACCEPTED: headers.authorization = "Apikey ***", signature_header không chứa key, bodyRaw nguyên vẹn', async () => {
    const { svc, tx } = build();
    const r = req(`Apikey ${KEY}`);
    const res = await svc.ingestWebhook(r);
    expect(res.status).toBe(200);
    const data = tx.rawEvent.create.mock.calls[0][0].data;
    expect(data.headers.authorization).toBe('Apikey ***');
    expect(data.headers.cookie).toBe('***');
    expect(data.headers['content-type']).toBe('application/json');
    expect(data.signatureHeader).toBe('"Apikey ***"');
    expect(JSON.stringify(data.headers) + data.signatureHeader).not.toContain(KEY);
    expect(Buffer.from(data.bodyRaw).equals(Buffer.from(body))).toBe(true);
    // Request gốc không bị đột biến
    expect(r.headers.authorization).toBe(`Apikey ${KEY}`);
  });

  it('REJECTED: key sai cũng bị che trong headers và signature_header', async () => {
    const { svc, prisma } = build();
    const res = await svc.ingestWebhook(req('Apikey WRONG_KEY_ALSO_SECRETISH'));
    expect(res.status).toBe(401);
    const data = prisma.rawEvent.create.mock.calls[0][0].data;
    expect(data.status).toBe('REJECTED');
    expect(data.headers.authorization).toBe('Apikey ***');
    expect(JSON.stringify(data)).not.toContain('WRONG_KEY_ALSO_SECRETISH');
    expect(JSON.stringify(data)).not.toContain('COOKIE_SECRET');
  });
});
