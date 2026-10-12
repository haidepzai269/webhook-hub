import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@hub/database';
import { CircuitBreakerService } from './circuit/circuit-breaker.service';
import { OutboxRelay } from './scheduler/outbox.relay';
import { DeliverySweeper } from './scheduler/delivery.sweeper';
import { CleanupJob } from './scheduler/cleanup.job';
import { AlertEvaluator } from './scheduler/alert.evaluator';
import { NormalizeConsumer } from './consumers/normalize.consumer';
import { DeliveryConsumer } from './consumers/delivery.consumer';

const PROVIDERS = [
  PrismaService,
  CircuitBreakerService,
  OutboxRelay,
  DeliverySweeper,
  CleanupJob,
  AlertEvaluator,
  NormalizeConsumer,
  DeliveryConsumer,
];

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class WorkerModule {}
