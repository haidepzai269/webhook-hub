import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { CircuitState, logger } from '@hub/common';

@Injectable()
export class CircuitBreakerService {
  private redis: Redis;

  constructor(redisClient?: Redis) {
    if (redisClient) {
      this.redis = redisClient;
    } else {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      this.redis.connect().catch(() => {});
    }
  }

  private getKey(destinationId: string) {
    return `circuit:${destinationId}`;
  }

  async getState(destinationId: string): Promise<CircuitState> {
    try {
      const state = await this.redis.get(`${this.getKey(destinationId)}:state`);
      if (!state) return 'CLOSED';
      return state as CircuitState;
    } catch {
      // Redis chết -> fail-open (CLOSED) theo ARCHITECTURE.md §5.4
      return 'CLOSED';
    }
  }

  async recordSuccess(destinationId: string): Promise<void> {
    try {
      const key = this.getKey(destinationId);
      await this.redis.del(`${key}:failures`);
      await this.redis.set(`${key}:state`, 'CLOSED');
    } catch {}
  }

  async recordFailure(destinationId: string): Promise<void> {
    try {
      const key = this.getKey(destinationId);
      const failures = await this.redis.incr(`${key}:failures`);
      if (failures >= 5) {
        logger.warn({ destinationId, failures }, '🚨 Circuit Breaker chuyển sang OPEN (ngừng gửi 60s)');
        await this.redis.set(`${key}:state`, 'OPEN', 'EX', 60);

        // Tự cảnh báo (§16 & ADR-016): Bắn alert qua Redis pub/sub
        const alertMessage = {
          type: 'CIRCUIT_BREAKER_OPEN',
          destinationId,
          failures,
          message: `[CẢNH BÁO] Đích ${destinationId} đã thất bại liên tiếp ${failures} lần. Circuit Breaker chuyển OPEN (ngừng 60s).`,
          timestamp: new Date().toISOString(),
        };
        await this.redis.publish('hub:alerts', JSON.stringify(alertMessage)).catch(() => {});
      }
    } catch {}
  }

  /**
   * Kiểm tra outbound throttle token bucket per destination (§5.4b)
   */
  async checkThrottle(destinationId: string, rateLimitRps: number): Promise<boolean> {
    if (!rateLimitRps || rateLimitRps <= 0) return true;
    try {
      const key = `throttle:destination:${destinationId}:${Math.floor(Date.now() / 1000)}`;
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, 2);
      }
      return count <= rateLimitRps;
    } catch {
      return true; // fail-open
    }
  }
}
