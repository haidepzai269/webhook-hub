import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * CB6 (ADR-171, review Thấp 2): cả hai lớp chống trùng (Redis GET trúng · Postgres P2002) đều ĐẾM bản trùng
 * (`duplicates.record`, chỉ trong bộ nhớ) và vẫn ACK 200 ngay — bộ đếm không chạm đường ACK, không thêm lệnh Redis.
 */
describe('Ingest — đếm bản trùng ở cả hai lớp chống trùng (CB6)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'gh-secret';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' } });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  function build(opts: { redisHit: boolean; p2002: boolean }) {
    const source = { id: 'src-1', tenantId: 'tenant-a', isActive: true, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] };
    const tx = { rawEvent: { create: jest.fn(async () => ({ id: 'raw-1' })) }, outbox: { create: jest.fn(async () => ({})) } };
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      tenantTx: jest.fn(async (_t: any, fn: any) => {
        if (opts.p2002) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        return fn(tx);
      }),
      forTenant: jest.fn(),
    };
    const redis: any = {
      checkRateLimit: jest.fn().mockResolvedValue(true),
      getIdempotencyKey: jest.fn().mockResolvedValue(opts.redisHit ? 'raw-0' : null),
      setIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new IngestService(prisma, redis, { traceIngested: jest.fn() });
    return { svc, prisma, redis };
  }

  const req = () => ({
    provider: 'github' as const,
    sourceKey: 'src_github_main',
    headers: {
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex'),
      'x-github-delivery': 'd-1',
      'x-github-event': 'push',
    },
    rawBody: Buffer.from(body),
    body: JSON.parse(body),
    contentType: 'application/json',
  });

  it('lớp 1 — Redis GET trúng: ACK 200, record() một lần (pendingCount 1), không transaction, không ghi DB lúc ACK', async () => {
    const { svc, prisma } = build({ redisHit: true, p2002: false });
    const r = await svc.ingestWebhook(req() as any);
    expect(r.status).toBe(200);
    expect(svc.duplicates.pendingCount()).toBe(1);
    expect(prisma.tenantTx).not.toHaveBeenCalled();
    expect(prisma.forTenant).not.toHaveBeenCalled();
  });

  it('lớp 2 — Postgres P2002: ACK 200, record() một lần, không SET NX, không ghi bộ đếm lúc ACK', async () => {
    const { svc, prisma, redis } = build({ redisHit: false, p2002: true });
    const r = await svc.ingestWebhook(req() as any);
    expect(r.status).toBe(200);
    expect(svc.duplicates.pendingCount()).toBe(1);
    expect(redis.setIdempotencyKey).not.toHaveBeenCalled();
    expect(prisma.forTenant).not.toHaveBeenCalled();
  });

  it('bản nhận lần đầu (không trùng) không được đếm', async () => {
    const { svc } = build({ redisHit: false, p2002: false });
    const r = await svc.ingestWebhook(req() as any);
    expect(r.status).toBe(200);
    expect(svc.duplicates.pendingCount()).toBe(0);
  });
});
