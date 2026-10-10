import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService, TraceNotifier } from '../src/modules/ingest/ingest.service';

/**
 * S2-2: `trace.ingested` phát IN-PROCESS (0 lệnh Redis), đúng MỘT lần mỗi request, chỉ khi đã biết
 * tenant (source tồn tại). Outcome: ACCEPTED / REJECTED / DUPLICATE / RATE_LIMITED.
 */
describe('IngestService — trace.ingested (S2-2)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'gh-secret';
  const TENANT = 'tenant-a';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' } });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  function build(opts: { source?: boolean; rateOk?: boolean; dup?: 'redis' | 'pg' } = {}) {
    const source = {
      id: 'src-1',
      tenantId: TENANT,
      isActive: true,
      secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }],
    };
    const tx = {
      rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) },
      outbox: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(opts.source === false ? null : source),
      rawEvent: { create: jest.fn().mockResolvedValue({}) },
      // AU6: tenantTx/systemTx đi qua CÙNG mock $transaction (đếm số transaction giữ nguyên nghĩa)
      tenantTx(_t: any, fn: any, o?: any) { return this.$transaction(fn, o); },
      systemTx(_r: any, fn: any) { return this.$transaction(fn); },
      $transaction: jest.fn(async (fn: any) => {
        if (opts.dup === 'pg') {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        }
        return fn(tx);
      }),
    };
    const redis: any = {
      checkRateLimit: jest.fn().mockResolvedValue(opts.rateOk ?? true),
      getIdempotencyKey: jest.fn().mockResolvedValue(opts.dup === 'redis' ? 'raw-0' : null),
      setIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    };
    const notifier: TraceNotifier = { traceIngested: jest.fn() };
    return { svc: new IngestService(prisma, redis, notifier), notifier: notifier.traceIngested as jest.Mock };
  }

  const req = (signature: string) => ({
    provider: 'github' as const,
    sourceKey: 'src_github_main',
    headers: { 'x-hub-signature-256': signature, 'x-github-delivery': 'd-1', 'x-github-event': 'push' },
    rawBody: Buffer.from(body),
    body: JSON.parse(body),
    contentType: 'application/json',
  });
  const good = () => req('sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'));

  it('[AF:#30] ACCEPTED: gọi notifier đúng 1 lần với tenant, httpStatus 200, rawEventId', async () => {
    const { svc, notifier } = build();
    const res = await svc.ingestWebhook(good());
    expect(res.status).toBe(200);
    expect(notifier).toHaveBeenCalledTimes(1);
    const [tenantId, payload] = notifier.mock.calls[0];
    expect(tenantId).toBe(TENANT);
    expect(payload).toMatchObject({ provider: 'github', sourceKey: 'src_github_main', httpStatus: 200, outcome: 'ACCEPTED', rawEventId: 'raw-1' });
    expect(typeof payload.correlationId).toBe('string');
    expect(payload.ms).toBeGreaterThanOrEqual(0);
  });

  it('REJECTED: chữ ký sai -> 1 lần, outcome REJECTED, httpStatus 401', async () => {
    const { svc, notifier } = build();
    const res = await svc.ingestWebhook(req('sha256=' + '0'.repeat(64)));
    expect(res.status).toBe(401);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][1]).toMatchObject({ outcome: 'REJECTED', httpStatus: 401 });
  });

  it.each(['redis', 'pg'] as const)('DUPLICATE (%s) -> 1 lần, outcome DUPLICATE', async (dup) => {
    const { svc, notifier } = build({ dup });
    const res = await svc.ingestWebhook(good());
    expect(res.status).toBe(200);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][1]).toMatchObject({ outcome: 'DUPLICATE', httpStatus: 200 });
  });

  it('RATE_LIMITED -> 1 lần, httpStatus 429', async () => {
    const { svc, notifier } = build({ rateOk: false });
    await svc.ingestWebhook(good());
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier.mock.calls[0][1]).toMatchObject({ outcome: 'RATE_LIMITED', httpStatus: 429 });
  });

  it('source không tồn tại (404) -> KHÔNG phát gì (không biết tenant)', async () => {
    const { svc, notifier } = build({ source: false });
    const res = await svc.ingestWebhook(good());
    expect(res.status).toBe(404);
    expect(notifier).not.toHaveBeenCalled();
  });

  it('notifier ném lỗi không làm hỏng ACK', async () => {
    const { svc, notifier } = build();
    notifier.mockImplementation(() => {
      throw new Error('socket chết');
    });
    expect((await svc.ingestWebhook(good())).status).toBe(200);
  });
});
