import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@hub/database';
import { CircuitBreakerService } from './circuit/circuit-breaker.service';
import { OutboxRelay } from './scheduler/outbox.relay';
import { NormalizeConsumer } from './consumers/normalize.consumer';
import { DeliveryConsumer } from './consumers/delivery.consumer';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [
    PrismaService,
    CircuitBreakerService,
    OutboxRelay,
    NormalizeConsumer,
    DeliveryConsumer,
  ],
  exports: [
    PrismaService,
    CircuitBreakerService,
    OutboxRelay,
    NormalizeConsumer,
    DeliveryConsumer,
  ],
})
export class WorkerModule {}
