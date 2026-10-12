import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@hub/database';
import { CircuitBreakerService } from './circuit/circuit-breaker.service';
import { OutboxRelay } from './scheduler/outbox.relay';
import { DeliverySweeper } from './scheduler/delivery.sweeper';
import { CleanupJob } from './scheduler/cleanup.job';
import { StorageJob } from './scheduler/storage.job';
import { AlertEvaluator } from './scheduler/alert.evaluator';
import { AlertEmailSender } from './scheduler/alert-email.sender';
import { NormalizeConsumer } from './consumers/normalize.consumer';
import { DeliveryConsumer } from './consumers/delivery.consumer';

const PROVIDERS = [
  PrismaService,
  CircuitBreakerService,
  OutboxRelay,
  DeliverySweeper,
  CleanupJob,
  StorageJob, // QT2 (ADR-183): đo dung lượng project — cập nhật nấc 60s + hiệu chỉnh 24h, khoá Redis như cleanup
  AlertEvaluator,
  AlertEmailSender, // CB5: vòng gửi email cảnh báo (outbox theo người) — tách khỏi evaluator
  NormalizeConsumer,
  DeliveryConsumer,
];

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class WorkerModule {}
