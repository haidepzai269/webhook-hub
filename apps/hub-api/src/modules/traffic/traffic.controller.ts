import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { SessionGuard } from '../auth/session.guard';
import { ProjectScopeGuard } from '../console/project-scope.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { IngestService } from '../ingest/ingest.service';
import { getSourceTraffic } from './traffic-api';

/**
 * EG5 (SPEC-chong-qua-tai §6, ADR-181): khối "Lưu lượng" của một source. Quyền = scope `traffic:read` (chỉ `owner` có trong
 * ROLE_SCOPES; người vận hành đi qua `viaOperator` = owner) — không có `if` theo vai trò trong controller.
 */
@Controller('api/v1/projects/:projectId')
@UseGuards(SessionGuard, ProjectScopeGuard)
export class TrafficController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: IngestService,
  ) {}

  @Get('sources/:sourceId/traffic')
  @RequireScope('traffic:read')
  get(@Param('projectId') projectId: string, @Param('sourceId') sourceId: string, @Query() q: { range?: string }) {
    return getSourceTraffic(this.prisma, projectId, sourceId, q, (id) => this.ingest.penalty.activeBansFor(id));
  }
}
