import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { logger } from '@hub/common';

@Injectable()
export class RedisService implements OnModuleDestroy {
  public readonly client: Redis;
  private isConnected = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      enableReadyCheck: true,
      lazyConnect: true,
    });

    this.client.on('connect', () => {
      this.isConnected = true;
      logger.info('Redis đã kết nối thành công');
    });

    this.client.on('error', (err) => {
      this.isConnected = false;
      logger.warn({ err: err.message }, 'Lỗi kết nối Redis (hệ thống sẽ fail-open hoặc chuyển sang Postgres)');
    });

    this.client.connect().catch(() => {});
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  async checkHealth(): Promise<boolean> {
    try {
      const ping = await this.client.ping();
      return ping === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Rate limit bằng Redis token bucket / sliding window
   * Fail-open nếu Redis chết (theo ARCHITECTURE.md §3.1)
   */
  async checkRateLimit(key: string, limit: number, windowSeconds = 60): Promise<boolean> {
    try {
      const current = await this.client.incr(key);
      if (current === 1) {
        await this.client.expire(key, windowSeconds);
      }
      return current <= limit;
    } catch (error) {
      logger.warn({ err: error }, 'Redis rate-limit fail-open: Cho phép request qua do Redis không phản hồi');
      return true;
    }
  }

  async getIdempotencyKey(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async setIdempotencyKey(key: string, value: string, ttlSeconds = 86400): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    } catch (err) {
      logger.warn({ err }, 'Không thể ghi Idempotency key vào Redis (mặc kệ theo BB-2)');
    }
  }
}
