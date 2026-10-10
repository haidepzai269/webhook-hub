import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';
import { apiRegistry } from '../src/modules/metrics/metrics';
import { MetricsController, metricsAuthorized } from '../src/modules/metrics/metrics.controller';

/** S3-4: hub-api `/metrics` — đếm ingest theo provider/outcome, không cần JWT, chặn bằng METRICS_TOKEN nếu đặt. */
describe('hub-api metrics (S3-4)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  async function count(provider: string, outcome: string) {
    const m = await apiRegistry.getSingleMetric('hub_ingest_requests_total')!.get();
    return m.values.find((v) => v.labels.provider === provider && v.labels.outcome === outcome)?.value ?? 0;
  }

  function svc(sourceFound = true) {
    const source = { id: 'src', tenantId: 't', isActive: true, secrets: [{ id: 's', secretEncrypted: aesGcmEncrypt('k', MASTER) }] };
    const tx = { rawEvent: { create: jest.fn().mockResolvedValue({ id: 'raw-1' }) }, outbox: { create: jest.fn() } };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(sourceFound ? source : null),
      rawEvent: { create: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const redis: any = { checkRateLimit: jest.fn().mockResolvedValue(true), getIdempotencyKey: jest.fn().mockResolvedValue(null), setIdempotencyKey: jest.fn() };
    return new IngestService(prisma, redis);
  }
  const req = (provider: string, auth: string) => ({
    provider: provider as any,
    sourceKey: 's',
    headers: { authorization: auth },
    rawBody: Buffer.from('{"id":1}'),
    body: { id: 1 },
  });

  it('ACCEPTED / REJECTED / NOT_FOUND đếm đúng nhãn; provider lạ -> "unknown" (chống nổ cardinality)', async () => {
    const a = await count('sepay', 'ACCEPTED');
    const r = await count('sepay', 'REJECTED');
    const n = await count('sepay', 'NOT_FOUND');
    const u = await count('unknown', 'INVALID');
    await svc().ingestWebhook(req('sepay', 'Apikey k'));
    await svc().ingestWebhook(req('sepay', 'Apikey sai'));
    await svc(false).ingestWebhook(req('sepay', 'Apikey k'));
    await svc().ingestWebhook(req('evil-random-123', 'x'));
    expect(await count('sepay', 'ACCEPTED')).toBe(a + 1);
    expect(await count('sepay', 'REJECTED')).toBe(r + 1);
    expect(await count('sepay', 'NOT_FOUND')).toBe(n + 1);
    expect(await count('unknown', 'INVALID')).toBe(u + 1);
    const text = await apiRegistry.metrics();
    expect(text).toContain('hub_ingest_duration_seconds_bucket{le="0.005",provider="sepay"}');
    expect(text).not.toContain('evil-random-123');
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('METRICS_TOKEN: không đặt -> mở; đặt -> bắt buộc Bearer đúng', () => {
    expect(metricsAuthorized(undefined, undefined)).toBe(true);
    expect(metricsAuthorized(undefined, 'tok')).toBe(false);
    expect(metricsAuthorized('Bearer sai', 'tok')).toBe(false);
    expect(metricsAuthorized('Bearer tok', 'tok')).toBe(true);
  });

  it('controller trả text Prometheus; 401 khi sai token', async () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn(), send: jest.fn() };
    process.env.METRICS_TOKEN = 'tok';
    await new MetricsController().metrics('Bearer sai', res);
    expect(res.status).toHaveBeenCalledWith(401);
    await new MetricsController().metrics('Bearer tok', res);
    expect(res.send.mock.calls[0][0]).toContain('hub_ingest_requests_total');
    delete process.env.METRICS_TOKEN;
  });
});
