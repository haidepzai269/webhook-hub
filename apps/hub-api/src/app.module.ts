import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@hub/database';
import { RedisService } from './modules/redis/redis.service';
import { IngestController } from './modules/ingest/ingest.controller';
import { IngestService } from './modules/ingest/ingest.service';
import { HealthController } from './modules/health/health.controller';
import { RealtimeGateway } from './modules/realtime/realtime.gateway';
import { ApiController } from './modules/api/api.controller';
import { MockController } from './modules/mock/mock.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
  ],
  controllers: [
    IngestController,
    HealthController,
    ApiController,
    MockController,
  ],
  providers: [
    PrismaService,
    RedisService,
    IngestService,
    RealtimeGateway,
  ],
})
export class AppModule {}
