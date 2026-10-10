import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { RequestWithTenant } from '../auth/jwt-auth.guard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S2 (SPEC §4.3A, DINH-CHINH X2): CHỖ DUY NHẤT console đọc `?projectId=`.
 *
 * Chạy SAU `JwtAuthGuard`. Admin env hiện tại là operator/root (ADR-056) nên được vào mọi project:
 * - không có `?projectId=` -> giữ tenant của JWT (= DEFAULT_TENANT_ID, project `default`) — dashboard cũ chạy nguyên;
 * - có `?projectId=` -> project phải tồn tại (404 nếu không), rồi `request.tenantId = projectId`.
 * `@CurrentTenant()` đọc `request.tenantId` như cũ, nên mọi route `/api/v1/*` có `?projectId=` mà không controller
 * nào tự đọc query. AU3 thay guard này bằng `ProjectAccessGuard` (membership) — chỉ đổi một chỗ.
 */
@Injectable()
export class ProjectScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithTenant>();
    const raw = (req.query as Record<string, unknown> | undefined)?.projectId;
    const scoped = await resolveProjectScope(this.prisma, raw);
    if (scoped) req.tenantId = scoped;
    return true;
  }
}

/**
 * LUẬT DUY NHẤT của phạm vi project (dùng chung HTTP guard ở trên và handshake Socket.IO — R-5):
 * trống -> `null` (giữ tenant của JWT); có -> phải là UUID của project tồn tại, không thì 404.
 * Admin env là operator (ADR-056) nên vào được mọi project; AU3 thay luật membership ở ĐÂY.
 */
export async function resolveProjectScope(prisma: Pick<PrismaService, 'findProjectById'>, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  const projectId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId) || !(await prisma.findProjectById(projectId))) {
    throw new NotFoundException({ error: 'not_found', message: 'Project không tồn tại' });
  }
  return projectId;
}
