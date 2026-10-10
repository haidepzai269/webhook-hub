import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@hub/database';
import { RedisService } from './modules/redis/redis.service';
import { IngestController } from './modules/ingest/ingest.controller';
import { IngestService, TRACE_NOTIFIER } from './modules/ingest/ingest.service';
import { HealthController } from './modules/health/health.controller';
import { RealtimeGateway } from './modules/realtime/realtime.gateway';
import { ApiController } from './modules/api/api.controller';
import { MockController } from './modules/mock/mock.controller';
import { AuthModule } from './modules/auth/auth.module';
import { MetricsController } from './modules/metrics/metrics.controller';
import { ProjectsController } from './modules/console/projects.controller';
import { ProjectScopeGuard } from './modules/console/project-scope.guard';

/**
 * Review SPEC-2 #7 (ADR-054): `/mock/*` (đích giả Telegram/Discord, `/mock/fail`) chỉ tồn tại ngoài
 * production — trên Render nó là một endpoint công khai không xác thực, ai cũng gọi được.
 */
export function hubApiControllers(nodeEnv: string | undefined = process.env.NODE_ENV) {
  const base = [IngestController, HealthController, ApiController, ProjectsController, MetricsController];
  return nodeEnv === 'production' ? base : [...base, MockController];
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Cấp JwtModule/JwtAuthGuard cho ApiController bên dưới. `/hooks/*` (ingest) và
    // `/health` KHÔNG được bảo vệ — provider webhook thật và health-check phải public.
    AuthModule,
  ],
  controllers: hubApiControllers(),
  providers: [
    PrismaService,
    RedisService,
    IngestService,
    RealtimeGateway,
    ProjectScopeGuard,
    // trace.ingested đi in-process: IngestService chỉ thấy interface TraceNotifier (ADR-021, ADR-049)
    { provide: TRACE_NOTIFIER, useExisting: RealtimeGateway },
  ],
})
export class AppModule {}
