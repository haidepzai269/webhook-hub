import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from './modules/core/core.module';
import { IngestController } from './modules/ingest/ingest.controller';
import { IngestService, TRACE_NOTIFIER } from './modules/ingest/ingest.service';
import { PENALTY_BOX_PROVIDER } from './modules/ingest/penalty-provider';
import { HealthController } from './modules/health/health.controller';
import { RealtimeGateway } from './modules/realtime/realtime.gateway';
import { ApiController } from './modules/api/api.controller';
import { MockController } from './modules/mock/mock.controller';
import { AuthModule } from './modules/auth/auth.module';
import { MetricsController } from './modules/metrics/metrics.controller';
import { ProjectsController } from './modules/console/projects.controller';
import { MembersController } from './modules/console/members.controller';
import { ProjectScopeGuard } from './modules/console/project-scope.guard';
import { ServiceApiController } from './modules/service-api/service-api.controller';
import { ServiceResourcesController } from './modules/service-api/service-resources.controller';
import { ApiKeyGuard } from './modules/service-api/api-key.guard';
import { EndpointVerifier } from './modules/service-api/endpoint-verifier';
import { FlowModule } from './modules/flow/flow.module';
import { ConsoleEndpointsController } from './modules/console/endpoints.controller';
import { SourceConnectionsController } from './modules/console/source-connections.controller';
import { AlertsController, MeLocaleController } from './modules/alerts/alerts.controller';
import { OperatorGuard } from './modules/console/operator.guard';
import { InsightsController } from './modules/insights/insights.controller';
import { TrafficController } from './modules/traffic/traffic.controller';
import { StorageController } from './modules/storage/storage.controller';

/**
 * Review SPEC-2 #7 (ADR-054): `/mock/*` (đích giả Telegram/Discord, `/mock/fail`) chỉ tồn tại ngoài
 * production — trên Render nó là một endpoint công khai không xác thực, ai cũng gọi được.
 */
export function hubApiControllers(nodeEnv: string | undefined = process.env.NODE_ENV) {
  const base = [IngestController, HealthController, ApiController, ProjectsController, MembersController, ServiceApiController, ServiceResourcesController, MetricsController,
    ConsoleEndpointsController, // KN1 (ADR-138): console tạo endpoint — controller riêng, không sửa ApiController
    SourceConnectionsController, // KN2 (ADR-138): hub tự đăng ký URL ingest tại provider
    AlertsController, // CB3 (ADR-169): cảnh báo xuyên project — chỉ operator
    MeLocaleController, // CB3 / DINH-CHINH D3: PUT /api/v1/me/locale
    InsightsController, // CB6: nhận định theo project (thành viên đọc được project)
    TrafficController, // EG5 (ADR-181): lưu lượng theo source — scope traffic:read (owner + operator)
    StorageController, // QT4 (ADR-184): dung lượng + lệnh dọn — scope storage:read / storage:write
  ];
  return nodeEnv === 'production' ? base : [...base, MockController];
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CoreModule, // AU1: PrismaService + RedisService dùng chung mọi module (global)
    // SessionGuard (cookie) cho /api/v1/* và /auth/*. `/hooks/*` (ingest) và `/health` KHÔNG bảo vệ —
    // provider webhook thật và health-check phải public. `/v1/p/*` dùng ApiKeyGuard (Bearer hk_).
    AuthModule,
    FlowModule, // SPEC-event-flow-ui: /api/v1/flow/* chỉ đọc (module riêng, không sửa ApiController)
  ],
  controllers: hubApiControllers(),
  providers: [
    IngestService,
    // D3: hộp phạt dùng chung một instance cho gate trước body parser (main.ts) và IngestService
    PENALTY_BOX_PROVIDER,
    RealtimeGateway,
    ProjectScopeGuard,
    OperatorGuard,
    ApiKeyGuard,
    EndpointVerifier,
    // trace.ingested đi in-process: IngestService chỉ thấy interface TraceNotifier (ADR-021, ADR-049)
    { provide: TRACE_NOTIFIER, useExisting: RealtimeGateway },
  ],
})
export class AppModule {}
