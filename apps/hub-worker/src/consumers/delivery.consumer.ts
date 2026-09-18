import { Injectable } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { CircuitBreakerService } from '../circuit/circuit-breaker.service';
import { SenderRegistry } from '../senders/sender.registry';
import { EXCHANGES, ROUTING_KEYS, getNextRetryQueue } from '@hub/messaging';
import { logger, DeliveryMessage, renderTemplate } from '@hub/common';
import * as amqp from 'amqplib';
import Redis from 'ioredis';

@Injectable()
export class DeliveryConsumer {
  private redisPub: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisPub = new Redis(redisUrl, { lazyConnect: true });
    this.redisPub.connect().catch(() => {});
  }

  async handleMessage(msg: amqp.ConsumeMessage, channel: amqp.Channel): Promise<void> {
    const correlationId = msg.properties.headers?.['x-correlation-id'] || 'unknown';
    let deliveryMsg: DeliveryMessage;

    try {
      deliveryMsg = JSON.parse(msg.content.toString());
    } catch (e: any) {
      logger.error({ err: e.message }, 'Lỗi parse DeliveryMessage -> chuyển DLQ');
      channel.nack(msg, false, false);
      return;
    }

    const { deliveryId, destinationId, destinationType, config, signingSecret, event, attemptCount } = deliveryMsg;
    const log = logger.child({ correlationId, deliveryId, destinationType, attemptCount });

    try {
      // 1. Kiểm tra Circuit Breaker (§5.4)
      const circuitState = await this.circuitBreaker.getState(destinationId);
      if (circuitState === 'OPEN') {
        log.warn('Circuit Breaker đang OPEN -> đẩy sang tầng retry ngắn nhất');
        channel.sendToQueue('q.delivery.retry.10s', msg.content, {
          persistent: true,
          headers: msg.properties.headers,
        });
        channel.ack(msg);
        return;
      }

      // 2. Nạp Subscription để lấy template
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: deliveryMsg.subscriptionId },
      });

      const template = subscription?.template || '';
      const rendered = renderTemplate(template, event);

      // Cập nhật trạng thái DELIVERING
      await this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'DELIVERING' },
      });

      // 3. Thực hiện gửi đi
      const sender = SenderRegistry.get(destinationType);
      const result = await sender.send(config, rendered, event, signingSecret);

      const currentAttemptNo = attemptCount + 1;

      // 4. Ghi nhận attempt vào DB
      await this.prisma.deliveryAttempt.create({
        data: {
          deliveryId,
          attemptNo: currentAttemptNo,
          requestBody: { content: rendered, event } as any,
          responseStatus: result.status,
          responseBody: (result.body || '').substring(0, 2048),
          durationMs: result.durationMs,
          error: result.error,
        },
      });

      const isSuccess = result.status >= 200 && result.status < 300;

      if (isSuccess) {
        // --- THÀNH CÔNG ---
        await this.circuitBreaker.recordSuccess(destinationId);
        await this.prisma.delivery.update({
          where: { id: deliveryId },
          data: {
            status: 'SUCCEEDED',
            attemptCount: currentAttemptNo,
            lastError: null,
          },
        });

        // Đẩy Socket.IO qua Redis Pub/Sub
        this.redisPub.publish(
          'hub:realtime:deliveries',
          JSON.stringify({ deliveryId, status: 'SUCCEEDED', eventId: event.id }),
        ).catch(() => {});

        log.info({ durationMs: result.durationMs }, 'Chuyển phát webhook thành công');
        channel.ack(msg);
      } else {
        // --- THẤT BẠI ---
        await this.circuitBreaker.recordFailure(destinationId);

        // Phân loại lỗi: Non-retryable vs Retryable (§7.3)
        // 4xx (trừ 408, 429) -> Lỗi cấu hình/client -> DEAD ngay!
        const isNonRetryable = result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429;

        if (isNonRetryable) {
          log.warn({ status: result.status }, 'Lỗi non-retryable (4xx) -> chuyển DEAD và đưa vào DLQ ngay');
          await this.prisma.delivery.update({
            where: { id: deliveryId },
            data: {
              status: 'DEAD',
              attemptCount: currentAttemptNo,
              lastError: `Non-retryable HTTP ${result.status}: ${result.error || result.body}`,
            },
          });

          // Đưa vào DLQ
          channel.publish(
            EXCHANGES.DELIVERY_DLX,
            ROUTING_KEYS.DEAD,
            msg.content,
            { persistent: true },
          );
          channel.ack(msg);
          return;
        }

        // Lỗi Retryable: Kiểm tra tầng retry kế tiếp
        const nextQueue = getNextRetryQueue(currentAttemptNo);

        if (nextQueue) {
          log.info({ nextQueue, nextAttempt: currentAttemptNo + 1 }, 'Lỗi retryable -> đẩy vào queue retry tiếp theo');
          await this.prisma.delivery.update({
            where: { id: deliveryId },
            data: {
              status: 'RETRYING',
              attemptCount: currentAttemptNo,
              lastError: `Lần ${currentAttemptNo} thất bại (${result.status}): ${result.error || result.body}`,
            },
          });

          // Cập nhật attemptCount trong message
          deliveryMsg.attemptCount = currentAttemptNo;
          channel.sendToQueue(nextQueue, Buffer.from(JSON.stringify(deliveryMsg)), {
            persistent: true,
            headers: { ...msg.properties.headers, 'x-attempt': currentAttemptNo },
          });

          channel.ack(msg);
        } else {
          // Vượt quá 5 tầng retry -> DEAD -> vào DLQ
          log.warn('Vượt quá 5 tầng retry -> chuyển DEAD và đưa vào DLQ');
          await this.prisma.delivery.update({
            where: { id: deliveryId },
            data: {
              status: 'DEAD',
              attemptCount: currentAttemptNo,
              lastError: `Hết 5 lần retry: ${result.error || result.body}`,
            },
          });

          channel.publish(
            EXCHANGES.DELIVERY_DLX,
            ROUTING_KEYS.DEAD,
            msg.content,
            { persistent: true },
          );
          channel.ack(msg);
        }
      }
    } catch (err: any) {
      log.error({ err: err.message }, 'Ngoại lệ khi thực thi DeliveryConsumer');
      channel.nack(msg, false, true); // requeue nếu gặp lỗi unhandled bất thường
    }
  }
}
