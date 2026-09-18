import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '@hub/database';
import { RedisService } from '../redis/redis.service';
import * as amqp from 'amqplib';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

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

    // 3. Kiểm tra RabbitMQ
    try {
      const amqpUrl = process.env.RABBITMQ_URL || 'amqp://hub_admin:hub_secret@localhost:5672';
      const conn = await amqp.connect(amqpUrl);
      await conn.close();
      checks.rabbitmq = { status: 'up' };
    } catch (e: any) {
      checks.rabbitmq = { status: 'down', message: e.message };
    }

    const allUp = Object.values(checks).every((c) => c.status === 'up');
    return res.status(allUp ? 200 : 503).json({
      status: allUp ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies: checks,
    });
  }
}
