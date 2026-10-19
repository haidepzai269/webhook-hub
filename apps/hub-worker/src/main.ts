import { startMetricsServer, setReadinessProbe, eventLoopLag, workerGrowth } from './metrics';
import { startExternalHeartbeatFromEnv, heartbeatAgeMs, isHeartbeatFresh } from './heartbeat';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { setupRabbitMQTopology, QUEUES } from '@hub/messaging';
import { assertAppRoleNotPrivileged, assertDatabaseLib, PrismaService } from '@hub/database';
import { OutboxRelay } from './scheduler/outbox.relay';
import { DeliverySweeper } from './scheduler/delivery.sweeper';
import { CleanupJob } from './scheduler/cleanup.job';
import { StorageJob } from './scheduler/storage.job';
import { StorageCleanRunner } from './scheduler/storage-clean.runner';
import { AlertEvaluator } from './scheduler/alert.evaluator';
import { AlertEmailSender } from './scheduler/alert-email.sender';
import { NormalizeConsumer } from './consumers/normalize.consumer';
import { DeliveryConsumer } from './consumers/delivery.consumer';
import { InFlightTracker } from './consumers/in-flight';
import { BACKPRESSURE_DB, FailureRateController } from './backpressure/failure-rate.controller';
import { runGated } from './backpressure/gate';
import { gracefulStop, shutdownWithinBudget } from './shutdown';
import { flushSentry, initSentry, installBigIntJson, logger, setServiceName, startEventLoopMonitor, startGrowthTicker, testOnlyConfigProblems } from '@hub/common';
import * as amqp from 'amqplib';

function assertMasterKeyConfigured(): void {
  const masterKey = process.env.MASTER_KEY;
  if (!masterKey || masterKey.length < 32) {
    logger.error(
      'FATAL: MASTER_KEY thiếu hoặc quá ngắn (yêu cầu tối thiểu 32 ký tự) — không thể khởi động. ' +
        'Không được dùng giá trị mẫu trong .env.example khi deploy thật.',
    );
    process.exit(1);
  }
}

const AMQP_CONNECT_ATTEMPTS = 10;
const AMQP_BACKOFF_MAX_MS = 30_000;

/** URL AMQP không bao giờ được in kèm mật khẩu. */
function redactAmqpUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}

/**
 * Kết nối AMQP CÓ THỬ LẠI lúc khởi động (S1-4, ADR-045): 10 lần, backoff 1s→2s→4s… tối đa 30s.
 * Hết lượt mới `process.exit(1)`. Broker lên chậm hơn worker (compose, Render cold start) là chuyện thường.
 */
async function connectAmqpWithRetry(url: string): Promise<amqp.ChannelModel> {
  let delay = 1000;
  for (let attempt = 1; attempt <= AMQP_CONNECT_ATTEMPTS; attempt++) {
    try {
      const conn = await amqp.connect(url);
      logger.info({ attempt }, 'Kết nối RabbitMQ thành công!');
      return conn;
    } catch (err: any) {
      if (attempt === AMQP_CONNECT_ATTEMPTS) throw err;
      logger.warn({ attempt, nextInMs: delay, err: err.message }, 'Chưa kết nối được RabbitMQ, thử lại…');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, AMQP_BACKOFF_MAX_MS);
    }
  }
  throw new Error('unreachable');
}

async function bootstrap() {
  setServiceName('hub-worker'); // LOGGING.md §3.1: `svc` ở mọi dòng log
  initSentry('hub-worker'); // LOGGING.md §11 (ADR-258): chỉ bật khi có SENTRY_DSN
  installBigIntJson(); // S1: events.seq / audit_logs.id là BIGINT -> JSON là chuỗi
  // S1-6: bản build lệch (dist cũ) phải chết NGAY lúc khởi động, không đợi message đầu tiên vào DLQ.
  assertDatabaseLib();
  assertMasterKeyConfigured();
  // VF1 (SPEC-verification §4.2): secret giả `VERIFY_ONLY_…` / MAIL_DRIVER=capture ở production → thoát.
  const testOnly = testOnlyConfigProblems(process.env);
  if (testOnly.length > 0) {
    logger.error({ problems: testOnly }, 'FATAL: cấu hình chỉ dành cho kiểm chứng đang chạy ở production — không khởi động.');
    process.exit(1);
  }

  // AU6 (SPEC-auth §5.12.2): runtime KHÔNG được là superuser / BYPASSRLS (RLS sẽ bị bỏ qua) -> thoát.
  await assertAppRoleNotPrivileged(PrismaService.getInstance());

  const app = await NestFactory.createApplicationContext(WorkerModule);
  // S3-4: /metrics trên WORKER_METRICS_PORT (mặc định 9101, 0 = tắt) — chỉ mạng nội bộ.
  const metricsServer = startMetricsServer();
  if (metricsServer) logger.info({ port: process.env.WORKER_METRICS_PORT ?? 9101 }, 'Worker /metrics đang lắng nghe');
  const outboxRelay = app.get(OutboxRelay);
  const sweeper = app.get(DeliverySweeper);
  const cleanup = app.get(CleanupJob);
  const storage = app.get(StorageJob);
  const storageClean = app.get(StorageCleanRunner);
  const alertEvaluator = app.get(AlertEvaluator);
  const alertEmails = app.get(AlertEmailSender);

  const amqpUrl = process.env.RABBITMQ_URL || 'amqp://hub_admin:hub_secret@localhost:5672';
  logger.info({ amqpUrl: redactAmqpUrl(amqpUrl) }, 'Đang kết nối tới RabbitMQ broker...');

  let connection: amqp.ChannelModel;
  try {
    connection = await connectAmqpWithRetry(amqpUrl);
  } catch (err: any) {
    logger.error({ err: err.message, attempts: AMQP_CONNECT_ATTEMPTS }, 'Không thể kết nối tới RabbitMQ broker sau nhiều lần thử -> thoát');
    process.exit(1);
  }

  // S1-4: mất AMQP giữa chừng -> chết sạch để orchestrator dựng lại (compose `restart: unless-stopped`,
  // Render tự restart). CỐ Ý không tự dựng lại channel/consumer/confirm channel trong cùng tiến trình:
  // dựng lại giữa chừng dễ sinh bug hơn (consumer đôi, relay giữ channel chết). Message chưa ack
  // tự quay lại hàng đợi; outbox chưa publish vẫn nằm trong Postgres — không mất gì.
  let shuttingDown = false;
  connection.on('error', (err: Error) => logger.error({ err: err.message }, 'AMQP connection error'));
  connection.on('close', (err?: Error) => {
    if (shuttingDown) return;
    logger.error({ err: err?.message }, 'AMQP close: mất kết nối RabbitMQ -> dừng relay/sweeper và thoát để orchestrator khởi động lại');
    outboxRelay.stop();
    sweeper.stop();
    cleanup.stop();
    storage.stop();
    storageClean.stop();
    void alertEvaluator.stop();
    void alertEmails.stop();
    process.exit(1);
  });

  // 1. Topology (Exchange, Queues, DLX, Retry tiers) tại 1 chỗ duy nhất
  const setupChannel = await connection.createChannel();
  await setupRabbitMQTopology(setupChannel);
  await setupChannel.close();
  logger.info('Đã xác lập và đảm bảo RabbitMQ Topology hoàn chỉnh!');

  // 2. Outbox Relay Confirm Channel
  const confirmChannel = await connection.createConfirmChannel();
  outboxRelay.setChannel(confirmChannel);

  // Đếm handler đang chạy để graceful shutdown chờ chúng xong (review SPEC-1 #3). BP5 C5: CHỈ message đã có permit.
  const inFlight = new InFlightTracker();
  // BP5 (ADR-200): áp lực ngược cho DB — permit trong tiến trình thay vì đổi prefetch (giữ 20).
  const backpressure = app.get<FailureRateController>(BACKPRESSURE_DB);
  backpressure.start();

  // BP5 (đóng nợ BP1 "channel zombie"): channel consumer đóng riêng (lỗi mức channel) mà connection còn sống thì worker không
  // consume nữa -> thoát như khi mất connection để orchestrator dựng lại; message unacked được RabbitMQ giao lại.
  // Review BP5 TH-2: ghi mã/lý do lỗi channel gần nhất (amqplib phát 'error' trước 'close') để phân biệt crash loop lặp lại.
  const lastChannelError = new Map<string, { code?: unknown; message: string }>();
  const onChannelError = (name: string) => (err: Error & { code?: unknown }) => {
    lastChannelError.set(name, { code: err.code, message: err.message });
    logger.error({ channel: name, code: err.code, err: err.message }, 'AMQP channel error');
  };
  const exitOnChannelClose = (name: string) => () => {
    if (shuttingDown) return;
    const last = lastChannelError.get(name);
    logger.error(
      { channel: name, code: last?.code ?? null, reason: last?.message ?? 'đóng không kèm lỗi' },
      'AMQP channel consumer đóng bất thường -> thoát để orchestrator khởi động lại',
    );
    process.exit(1);
  };

  // 3. Normalize Consumer (prefetch = 20)
  const normalizeConsumer = app.get(NormalizeConsumer);
  const normalizeChannel = await connection.createChannel();
  normalizeChannel.on('close', exitOnChannelClose('normalize'));
  normalizeChannel.on('error', onChannelError('normalize'));
  await normalizeChannel.prefetch(20);
  const normalizeTag = await normalizeChannel.consume(
    QUEUES.NORMALIZE,
    (msg) => {
      if (msg) void runGated(backpressure, 'normalize', normalizeConsumer, msg, normalizeChannel, inFlight);
    },
    { noAck: false },
  );
  logger.info(`Đang lắng nghe consumer queue: ${QUEUES.NORMALIZE} (prefetch: 20, manual ack)`);

  // 4. Delivery Consumer (prefetch = 20)
  const deliveryConsumer = app.get(DeliveryConsumer);
  // LOGGING.md §3.2/§2.3: p99 event loop (cờ slow.hub_cpu) mỗi nhịp 5s + tổng hợp growth.window mỗi 60s — cả hai trong bộ nhớ, timer unref, 0 Redis/DB.
  startEventLoopMonitor((ms) => eventLoopLag.set(ms / 1000));
  startGrowthTicker(workerGrowth, deliveryConsumer.canonical);
  const deliveryChannel = await connection.createChannel();
  deliveryChannel.on('close', exitOnChannelClose('delivery'));
  deliveryChannel.on('error', onChannelError('delivery'));
  await deliveryChannel.prefetch(20);
  const deliveryTag = await deliveryChannel.consume(
    QUEUES.DELIVERY_MAIN,
    (msg) => {
      if (msg) void runGated(backpressure, 'delivery', deliveryConsumer, msg, deliveryChannel, inFlight);
    },
    { noAck: false },
  );
  logger.info(`Đang lắng nghe consumer queue: ${QUEUES.DELIVERY_MAIN} (prefetch: 20, manual ack)`);

  // ADR-248: readiness = đã qua bước subscribe cả hai consumer (không đang tắt) + Postgres trả lời + heartbeat KHÔNG cũ
  // (chưa có beat nào = đang khởi động, chấp nhận; đã beat mà >45s không beat nữa = vòng relay kẹt -> not ready).
  // Consumer đóng bất thường thì tiến trình đã tự thoát nên không cần dò thêm. Liveness (`/health/live`) không chạm gì.
  const prismaForReady = PrismaService.getInstance();
  setReadinessProbe(async () => {
    const consumers = !shuttingDown;
    let postgres = 'up';
    let t: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        prismaForReady.$queryRaw`SELECT 1`,
        new Promise((_, rej) => {
          t = setTimeout(() => rej(new Error('timeout')), 3000);
        }),
      ]);
    } catch {
      postgres = 'down';
    } finally {
      if (t) clearTimeout(t);
    }
    const age = heartbeatAgeMs();
    const heartbeat = age === null ? 'none' : isHeartbeatFresh() ? 'fresh' : 'stale';
    return {
      ok: consumers && postgres === 'up' && heartbeat !== 'stale',
      checks: { consumers: consumers ? 'up' : 'down', postgres, heartbeat, heartbeatAgeSeconds: age === null ? 'none' : String(Math.round(age / 1000)) },
    };
  });
  // ADR-248: dead-man's switch ngoài, tắt mặc định (không HEARTBEAT_URL = no-op).
  const externalHeartbeat = startExternalHeartbeatFromEnv();
  if (externalHeartbeat) logger.info('HEARTBEAT_URL đã bật: ping dịch vụ ngoài khi vòng outbox relay còn khoẻ');

  // 5. Graceful Shutdown theo ARCHITECTURE.md §5.6 (Render SIGTERM 25s timeout)
  const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10);

  const handleShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    externalHeartbeat?.stop();
    logger.info(`Nhận tín hiệu ${signal}. Bắt đầu graceful shutdown (timeout: ${shutdownTimeoutMs}ms)...`);
    outboxRelay.stop();
    sweeper.stop();
    cleanup.stop();
    storage.stop();
    storageClean.stop();
    // CB2: không hẹn lượt cảnh báo mới; lượt đang chạy dừng ở ranh giới luật (chờ nó trong ngân sách bên dưới).
    const alertsStopped = alertEvaluator.stop();
    // CB5: vòng gửi email dừng trước dòng kế tiếp, dòng chưa gửi được trả lại outbox.
    const emailsStopped = alertEmails.stop();

    try {
      await shutdownWithinBudget(
        async () => {
          // Thứ tự (src/shutdown.ts, có test): cancel consumer -> backpressure.shutdown() (C5) -> chờ handler có permit (+ việc
          // nền, cùng ngân sách) -> đóng channel. Chừa ~5s cuối cho việc đóng kết nối (25s < SIGKILL 30s của Render).
          const { idle, stillRunning } = await gracefulStop({
            cancelConsumers: async () => {
              await normalizeChannel.cancel(normalizeTag.consumerTag).catch(() => {});
              await deliveryChannel.cancel(deliveryTag.consumerTag).catch(() => {});
            },
            backpressure,
            inFlight,
            background: [alertsStopped, emailsStopped],
            waitBudgetMs: shutdownTimeoutMs - 5_000,
            closeAll: async () => {
              await normalizeChannel.close();
              await deliveryChannel.close();
              await confirmChannel.close();
              await connection.close();
              metricsServer?.close();
              await app.close();
            },
          });
          logger.info({ idle, stillRunning }, 'Graceful shutdown hoàn tất thành công!');
        },
        shutdownTimeoutMs,
        flushSentry, // ADR-258: flush ≤2s nằm TRONG SHUTDOWN_TIMEOUT_MS; không DSN = trả ngay
      );
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
  logger.error({ err: err?.message ?? err }, 'Lỗi khởi động Hub Worker');
  process.exit(1);
});
