import { HealthController } from '../src/modules/health/health.controller';

/**
 * ADR-248: tách liveness (/health/live) khỏi readiness (/health/ready, /health).
 * Dependency CỨNG = Postgres (BB-3: không COMMIT được thì không được nhận). Mềm = Redis (BB-2), RabbitMQ (outbox đỡ).
 */
function makeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res;
}

function make(opts: { pg?: 'up' | 'down'; redis?: 'up' | 'down' | 'throw' | 'hang'; rabbit?: 'up' | 'down' }) {
  const prisma: any = {
    $queryRaw: jest.fn(async () => {
      if (opts.pg === 'down') throw new Error('pg down');
      return [{ '?column?': 1 }];
    }),
  };
  const redis: any = {
    checkHealth: jest.fn(async () => {
      if (opts.redis === 'throw') throw new Error('redis boom');
      if (opts.redis === 'hang') return new Promise(() => {});
      return opts.redis !== 'down';
    }),
  };
  const ctl = new HealthController(prisma, redis);
  const rabbit = jest.spyOn(ctl as any, 'probeRabbit').mockImplementation(async () =>
    opts.rabbit === 'down' ? { status: 'down', message: 'amqp down' } : { status: 'up' },
  );
  return { ctl, prisma, redis, rabbit };
}

describe('health liveness/readiness (ADR-248)', () => {
  it('live: 200 và KHÔNG chạm Postgres/Redis/RabbitMQ dù tất cả đang chết', () => {
    const { ctl, prisma, redis, rabbit } = make({ pg: 'down', redis: 'down', rabbit: 'down' });
    const res = makeRes();
    ctl.live(res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(redis.checkHealth).not.toHaveBeenCalled();
    expect(rabbit).not.toHaveBeenCalled();
  });

  it('ready: ba phụ thuộc xanh -> 200 healthy', async () => {
    const res = makeRes();
    await make({}).ctl.ready(res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  it('ready: Postgres rớt -> 503 unhealthy (phụ thuộc cứng)', async () => {
    const res = makeRes();
    await make({ pg: 'down' }).ctl.ready(res);
    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.dependencies.postgres).toMatchObject({ status: 'down', required: true });
  });

  it('ready: chỉ Redis rớt -> 200 degraded, chi tiết nêu Redis (BB-2)', async () => {
    const res = makeRes();
    await make({ redis: 'down' }).ctl.ready(res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.redis).toMatchObject({ status: 'down', required: false });
    expect(res.body.dependencies.postgres.status).toBe('up');
  });

  it('ready: Redis ném lỗi hoặc treo -> vẫn 200 degraded, trả về nhanh (timeout)', async () => {
    for (const redis of ['throw', 'hang'] as const) {
      const res = makeRes();
      const t0 = Date.now();
      await make({ redis }).ctl.ready(res);
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  }, 15_000);

  it('ready: chỉ RabbitMQ rớt -> 200 degraded (outbox giữ sự kiện trong Postgres)', async () => {
    const res = makeRes();
    await make({ rabbit: 'down' }).ctl.ready(res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.rabbitmq).toMatchObject({ status: 'down', required: false });
  });

  it('ready: Postgres + Redis cùng rớt -> 503 (cứng thắng mềm)', async () => {
    const res = makeRes();
    await make({ pg: 'down', redis: 'down' }).ctl.ready(res);
    expect(res.statusCode).toBe(503);
  });

  it('/health đường cũ theo luật mới: Redis rớt -> 200 degraded; Postgres rớt -> 503', async () => {
    const a = makeRes();
    await make({ redis: 'down' }).ctl.check(a);
    expect([a.statusCode, a.body.status]).toEqual([200, 'degraded']);
    const b = makeRes();
    await make({ pg: 'down' }).ctl.check(b);
    expect([b.statusCode, b.body.status]).toEqual([503, 'unhealthy']);
    expect(b.body.dependencies).toHaveProperty('rabbitmq');
  });

  it('phụ thuộc mềm được cache: gọi ready liên tiếp chỉ ping Redis một lần (quota Upstash)', async () => {
    const { ctl, redis } = make({});
    await ctl.ready(makeRes());
    await ctl.ready(makeRes());
    expect(redis.checkHealth).toHaveBeenCalledTimes(1);
  });
});
