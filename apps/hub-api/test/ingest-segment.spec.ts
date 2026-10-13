import { createHmac } from 'crypto';
import { aesGcmEncrypt } from '@hub/crypto';
import { ProviderRegistry } from '@hub/providers';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { ingestRequests } from '../src/modules/metrics/metrics';

/**
 * PK0 (SPEC-provider-khac §2, ADR-201): lõi chọn adapter theo segment URL nhưng chọn source theo `sourceKey`. Hai giá trị
 * phải khớp — `/hooks/github/<key của source sepay>` là URL sai, trả 404 CÙNG body với source không tồn tại (ADR-161),
 * kiểm NGAY sau khi nạp source và TRƯỚC khi biết tenant: không verify, không ghi raw_events, không cộng điểm phạt EG2,
 * không lưu lượng / trace của tenant. Prisma/Redis giả (L0).
 */
describe('[PK:T1] ingest — segment provider phải khớp provider của source', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'sepay-secret';
  const body = JSON.stringify({ id: 1, transferAmount: 1000 });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });
  afterEach(() => jest.restoreAllMocks());

  function build(source: Record<string, unknown> | null) {
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      rawEvent: { create: jest.fn() },
      tenantTx: jest.fn(),
      forTenant: jest.fn(() => ({ addIngestDuplicates: async () => undefined, addSourceTraffic: async () => undefined })),
    };
    const redis: any = { checkRateLimit: jest.fn(async () => true), getIdempotencyKey: jest.fn(async () => null), setIdempotencyKey: jest.fn() };
    const notifier = { traceIngested: jest.fn() };
    const svc = new IngestService(prisma, redis, notifier);
    return { svc, prisma, redis, notifier };
  }

  const sepaySource = () => ({
    id: 'src-sepay',
    tenantId: 'tenant-a',
    provider: 'sepay',
    isActive: true,
    archivedAt: null,
    secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }],
  });

  const githubReq = () => ({
    provider: 'github' as const,
    sourceKey: 'src_sepay_key',
    headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'), 'x-github-event': 'push', 'x-github-delivery': 'd-1' },
    rawBody: Buffer.from(body),
    body: JSON.parse(body),
    contentType: 'application/json',
    ip: '203.0.113.7',
    method: 'POST' as const,
    query: '',
  });

  const notFound = async (provider: string) =>
    (await ingestRequests.get()).values.find((v) => v.labels.provider === provider && v.labels.outcome === 'NOT_FOUND')?.value ?? 0;

  it('URL sai segment -> 404 cùng body như source không tồn tại; không verify, không ghi raw, không phạt, metric NOT_FOUND', async () => {
    const missing = build(null);
    const ref = await missing.svc.ingestWebhook(githubReq() as any);

    const { svc, prisma, redis, notifier } = build(sepaySource());
    const verify = jest.spyOn(ProviderRegistry.get('github'), 'verify');
    const unknown = jest.spyOn(svc.penalty, 'recordUnknownSource');
    const badSig = jest.spyOn(svc.penalty, 'recordBadSignature');
    const before = await notFound('github');

    const r = await svc.ingestWebhook(githubReq() as any);

    expect(r.status).toBe(404);
    expect(r).toEqual(ref); // cùng status + body (ADR-161): không lộ source có tồn tại hay không
    expect(prisma.findSourceBySourceKeyForIngest).toHaveBeenCalledWith('src_sepay_key');
    expect(verify).not.toHaveBeenCalled();
    expect(prisma.tenantTx).not.toHaveBeenCalled();
    expect(prisma.rawEvent.create).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled(); // URL sai của provider thật không được khoá IP dùng chung
    expect(badSig).not.toHaveBeenCalled();
    expect(redis.checkRateLimit).not.toHaveBeenCalled();
    expect(redis.getIdempotencyKey).not.toHaveBeenCalled();
    expect(notifier.traceIngested).not.toHaveBeenCalled(); // trước `trace.tenantId = …`: không mang tenant
    expect(prisma.forTenant).not.toHaveBeenCalled(); // không lưu lượng của tenant
    expect(await notFound('github')).toBe(before + 1);
  });

  it('đối chứng: segment khớp (sepay) thì đi tiếp tới verify như cũ', async () => {
    const { svc } = build(sepaySource());
    const verify = jest.spyOn(ProviderRegistry.get('sepay'), 'verify').mockResolvedValue(false);
    jest.spyOn(svc as any, 'storeRejected').mockResolvedValue(0);
    const r = await svc.ingestWebhook({ ...githubReq(), provider: 'sepay' } as any);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(401);
  });
});
