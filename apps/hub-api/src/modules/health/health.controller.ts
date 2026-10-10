import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '@hub/database';
import { RedisService } from '../redis/redis.service';
import * as amqp from 'amqplib';
import { PublicRoute } from '../service-api/require-scope.decorator';

@Controller('health')
@PublicRoute('health check công khai cho Render/compose, không trả dữ liệu tenant')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private rabbitCache: { at: number; result: { status: 'up' | 'down'; message?: string } } | null = null;
  private static readonly RABBIT_CACHE_MS = 30_000;

  private async checkRabbit(): Promise<{ status: 'up' | 'down'; message?: string }> {
    if (this.rabbitCache && Date.now() - this.rabbitCache.at < HealthController.RABBIT_CACHE_MS) {
      return this.rabbitCache.result;
    }
    let result: { status: 'up' | 'down'; message?: string };
    try {
      const amqpUrl = process.env.RABBITMQ_URL || 'amqp://hub_admin:hub_secret@localhost:5672';
      const conn = await amqp.connect(amqpUrl);
      await conn.close();
      result = { status: 'up' };
    } catch (e: any) {
      result = { status: 'down', message: e.message };
    }
    this.rabbitCache = { at: Date.now(), result };
    return result;
  }

  @Get()
  async check(@Res() res: Response) {
    const checks: Record<string, { status: 'up' | 'down'; message?: string }> = {
      postgres: { status: 'down' },
      redis: { status: 'down' },
      rabbitmq: { status: 'down' },
    };

    // 1. Kiểm tra Postgres
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = { status: 'up' };
    } catch (e: any) {
      checks.postgres = { status: 'down', message: e.message };
    }

    // 2. Kiểm tra Redis
    try {
      const redisOk = await this.redis.checkHealth();
      checks.redis = { status: redisOk ? 'up' : 'down' };
    } catch (e: any) {
      checks.redis = { status: 'down', message: e.message };
    }

    // 3. Kiểm tra RabbitMQ — mở connection mới mỗi lần là đắt (handshake TLS) và đốt giới hạn
    // connection của CloudAMQP khi dashboard poll /health. Cache kết quả ngắn hạn trong bộ nhớ.
    checks.rabbitmq = await this.checkRabbit();

    const allUp = Object.values(checks).every((c) => c.status === 'up');
    return res.status(allUp ? 200 : 503).json({
      status: allUp ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: checks,
    });
  }
}
