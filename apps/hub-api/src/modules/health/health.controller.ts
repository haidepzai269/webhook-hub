import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '@hub/database';
import { RedisService } from '../redis/redis.service';
import * as amqp from 'amqplib';
import { PublicRoute } from '../service-api/require-scope.decorator';

type DepState = { status: 'up' | 'down'; message?: string };
type Dep = DepState & { required: boolean };

/**
 * ADR-248 — tách LIVENESS khỏi READINESS.
 *  - `/health/live`: process còn trả lời được. KHÔNG chạm phụ thuộc nào (Redis chớp không được làm orchestrator restart).
 *  - `/health/ready` (và `/health` đường cũ): kiểm phụ thuộc. CỨNG = Postgres (BB-3: không COMMIT được thì không được
 *    ACK provider) -> rớt thì 503. MỀM = Redis (BB-2: được phép sai/mất) và RabbitMQ (ingest chỉ ghi `raw_events` + outbox
 *    vào Postgres, relay ở hub-worker mới publish) -> rớt thì 200 + `degraded`.
 */
@Controller('health')
@PublicRoute('health check công khai cho Render/compose, không trả dữ liệu tenant')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Phụ thuộc mềm đắt (handshake TLS AMQP / quota lệnh Upstash) -> cache ngắn trong bộ nhớ, dashboard poll cũng không đốt. */
  private static readonly SOFT_CACHE_MS = 30_000;
  /** Mỗi phép kiểm có trần thời gian: dependency treo không được làm health check treo theo. */
  private static readonly PROBE_TIMEOUT_MS = 3_000;

  private softCache = new Map<string, { at: number; result: DepState }>();

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    let t: NodeJS.Timeout;
    const timeout = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timeout ${HealthController.PROBE_TIMEOUT_MS}ms`)), HealthController.PROBE_TIMEOUT_MS);
      t.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  }

  private async cached(key: string, probe: () => Promise<DepState>): Promise<DepState> {
    const hit = this.softCache.get(key);
    if (hit && Date.now() - hit.at < HealthController.SOFT_CACHE_MS) return hit.result;
    let result: DepState;
    try {
      result = await probe();
    } catch (e: any) {
      result = { status: 'down', message: e?.message ?? String(e) };
    }
    this.softCache.set(key, { at: Date.now(), result });
    return result;
  }

  /** Mở connection mới mỗi lần là đắt — luôn gọi qua `cached`. Tách method để test thay thế. */
  protected async probeRabbit(): Promise<DepState> {
    const amqpUrl = process.env.RABBITMQ_URL || 'amqp://hub_admin:hub_secret@localhost:5672';
    const conn = await this.withTimeout(amqp.connect(amqpUrl), 'rabbitmq');
    await conn.close();
    return { status: 'up' };
  }

  private async probeRedis(): Promise<DepState> {
    const ok = await this.withTimeout(this.redis.checkHealth(), 'redis');
    return ok ? { status: 'up' } : { status: 'down' };
  }

  private async probePostgres(): Promise<DepState> {
    try {
      await this.withTimeout(this.prisma.$queryRaw`SELECT 1`, 'postgres');
      return { status: 'up' };
    } catch (e: any) {
      return { status: 'down', message: e?.message ?? String(e) };
    }
  }

  private async evaluate() {
    const [pg, redis, rabbit] = await Promise.all([
      this.probePostgres(),
      this.cached('redis', () => this.probeRedis()),
      this.cached('rabbitmq', () => this.probeRabbit()),
    ]);
    const dependencies: Record<string, Dep> = {
      postgres: { ...pg, required: true },
      redis: { ...redis, required: false },
      rabbitmq: { ...rabbit, required: false },
    };
    const hardDown = Object.values(dependencies).some((d) => d.required && d.status === 'down');
    const softDown = Object.values(dependencies).some((d) => !d.required && d.status === 'down');
    const status = hardDown ? 'unhealthy' : softDown ? 'degraded' : 'healthy';
    return { httpStatus: hardDown ? 503 : 200, body: { status, timestamp: new Date().toISOString(), dependencies } };
  }

  /** Liveness: đồng bộ, không I/O. */
  @Get('live')
  live(@Res() res: Response) {
    return res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
  }

  @Get('ready')
  async ready(@Res() res: Response) {
    const { httpStatus, body } = await this.evaluate();
    return res.status(httpStatus).json(body);
  }

  /** Đường cũ giữ nguyên JSON chi tiết; status code theo luật mới (như `/health/ready`). */
  @Get()
  async check(@Res() res: Response) {
    const { httpStatus, body } = await this.evaluate();
    return res.status(httpStatus).json(body);
  }
}
