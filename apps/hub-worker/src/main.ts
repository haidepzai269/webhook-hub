import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { setupRabbitMQTopology, QUEUES } from '@hub/messaging';
import { OutboxRelay } from './scheduler/outbox.relay';
import { NormalizeConsumer } from './consumers/normalize.consumer';
import { DeliveryConsumer } from './consumers/delivery.consumer';
import { logger } from '@hub/common';
import * as amqp from 'amqplib';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  const amqpUrl = process.env.RABBITMQ_URL || 'amqp://hub_admin:hub_secret@localhost:5672';
  logger.info({ amqpUrl }, 'Đang kết nối tới RabbitMQ broker...');

  let connection: any;
  try {
    connection = await amqp.connect(amqpUrl);
    logger.info('Kết nối RabbitMQ thành công!');
  } catch (err: any) {
    logger.error({ err: err.message }, 'Không thể kết nối tới RabbitMQ broker');
    process.exit(1);
  }

  // 1. Khởi tạo Topology (Exchange, Queues, DLX, Retry tiers) tại 1 chỗ duy nhất
  const setupChannel = await connection.createChannel();
  await setupRabbitMQTopology(setupChannel);
  await setupChannel.close();
  logger.info('Đã xác lập và đảm bảo RabbitMQ Topology hoàn chỉnh!');

  // 2. Thiết lập Outbox Relay Confirm Channel
  const outboxRelay = app.get(OutboxRelay);
  const confirmChannel = await connection.createConfirmChannel();
  outboxRelay.setChannel(confirmChannel);

  // 3. Khởi chạy Normalize Consumer (prefetch = 20)
  const normalizeConsumer = app.get(NormalizeConsumer);
  const normalizeChannel = await connection.createChannel();
  await normalizeChannel.prefetch(20);
  await normalizeChannel.consume(
    QUEUES.NORMALIZE,
    (msg) => {
      if (msg) {
        normalizeConsumer.handleMessage(msg, normalizeChannel);
      }
    },
    { noAck: false }, // Manual ACK bắt buộc
  );
  logger.info(`Đang lắng nghe consumer queue: ${QUEUES.NORMALIZE} (prefetch: 20, manual ack)`);

  // 4. Khởi chạy Delivery Consumer (prefetch = 20)
  const deliveryConsumer = app.get(DeliveryConsumer);
  const deliveryChannel = await connection.createChannel();
  await deliveryChannel.prefetch(20);
  await deliveryChannel.consume(
    QUEUES.DELIVERY_MAIN,
    (msg) => {
      if (msg) {
        deliveryConsumer.handleMessage(msg, deliveryChannel);
      }
    },
    { noAck: false }, // Manual ACK bắt buộc
  );
  logger.info(`Đang lắng nghe consumer queue: ${QUEUES.DELIVERY_MAIN} (prefetch: 20, manual ack)`);

  // 5. Graceful Shutdown theo ARCHITECTURE.md §5.6 (Render SIGTERM 25s timeout)
  const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10);

  const handleShutdown = async (signal: string) => {
    logger.info(`Nhận tín hiệu ${signal}. Bắt đầu graceful shutdown (timeout: ${shutdownTimeoutMs}ms)...`);
    outboxRelay.stop();

    try {
      await Promise.race([
        (async () => {
          await normalizeChannel.close();
          await deliveryChannel.close();
          await confirmChannel.close();
          await connection.close();
          await app.close();
          logger.info('Graceful shutdown hoàn tất thành công!');
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Shutdown timeout vượt quá giới hạn')), shutdownTimeoutMs),
        ),
      ]);
      process.exit(0);
    } catch (e: any) {
      logger.error({ err: e.message }, 'Lỗi trong quá trình shutdown, buộc dừng tiến trình');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  logger.info('🚀 Hub Worker đã sẵn sàng xử lý các message!');
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Lỗi khởi động Hub Worker');
  process.exit(1);
});
