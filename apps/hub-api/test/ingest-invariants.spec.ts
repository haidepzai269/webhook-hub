import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * VF6 (SPEC-verification §6.3, §8.2): test ĐÍCH của probe BB-2/BB-3 ở tầng L0 — thứ tự ingest ARCHITECTURE §3.1:
 * Redis GET -> transaction (raw_events + outbox) -> COMMIT -> SET NX -> ACK. Probe P-BB3-01 (2xx trước COMMIT) và
 * P-BB2-01 (bắt P2002 rồi tạo bản ghi mới) phải làm các test này ĐỎ. Bản L3 (kill thật) ở verify/scenarios/chaos-l3.ts.
 */
describe('Ingest — bất biến BB-2/BB-3 (thứ tự §3.1)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const SECRET = 'gh-secret';
  const body = JSON.stringify({ ref: 'refs/heads/main', after: 'abc', repository: { name: 'r' } });

  beforeAll(() => {
    process.env.MASTER_KEY = MASTER;
  });

  function build(txImpl: (fn: any, calls: number) => Promise<any>) {
    const order: string[] = [];
    const source = { id: 'src-1', tenantId: 'tenant-a', provider: 'github', isActive: true, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(SECRET, MASTER) }] };
    const tx = {
      rawEvent: { create: jest.fn(async () => ({ id: `raw-${order.length}` })) },
      outbox: { create: jest.fn(async () => ({})) },
    };
    let calls = 0;
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      rawEvent: { create: jest.fn().mockResolvedValue({}) },
      tenantTx(_t: any, fn: any) {
        calls += 1;
        order.push('tx:start');
        return txImpl(async (t: any) => fn(t ?? tx), calls).then((r) => {
          order.push('tx:commit');
          return r;
        });
      },
    };
    const redis: any = {
      checkRateLimit: jest.fn().mockResolvedValue(true),
      getIdempotencyKey: jest.fn().mockResolvedValue(null), // Redis TRỐNG: chỉ còn Postgres làm trọng tài
      setIdempotencyKey: jest.fn(async () => {
        order.push('redis:setnx');
      }),
    };
    return { svc: new IngestService(prisma, redis, { traceIngested: jest.fn() }), redis, order, txCalls: () => calls, tx };
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

  it('[BB:3] (phần a) COMMIT thất bại (Postgres lỗi) -> KHÔNG trả 2xx cho provider (5xx để provider gửi lại), KHÔNG SET NX Redis', async () => {
    const { svc, redis } = build(async () => {
      throw new Error('connection terminated during COMMIT');
    });
    const r = await svc.ingestWebhook(req() as any);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(redis.setIdempotencyKey).not.toHaveBeenCalled();
  });

  it('[BB:3] (phần b) thứ tự §3.1: transaction COMMIT xong -> SET NX Redis -> mới ACK 200', async () => {
    const { svc, order } = build(async (fn) => fn(undefined));
    const r = await svc.ingestWebhook(req() as any);
    order.push('ack');
    expect(r.status).toBe(200);
    expect(order).toEqual(['tx:start', 'tx:commit', 'redis:setnx', 'ack']);
  });

  it('[BB:2] (phần a) Redis trống + Postgres báo trùng (unique source_id+idempotency_key) -> ACK trùng 200, KHÔNG tạo bản ghi thứ hai', async () => {
    const { svc, txCalls, redis } = build(async (fn, n) => {
      if (n === 1) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
      return fn(undefined);
    });
    const r = await svc.ingestWebhook(req() as any);
    expect(r.status).toBe(200);
    expect(txCalls()).toBe(1);
    expect(redis.setIdempotencyKey).not.toHaveBeenCalled();
  });
});
