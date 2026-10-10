import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MemberRole, PrismaService } from '@hub/database';
import { logger, ROLE_SCOPES } from '@hub/common';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';
import { REQUIRE_SCOPE_KEY, scopeNotDeclared } from '../service-api/require-scope.decorator';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** MỘT body cho "project không tồn tại" và "không phải thành viên" (SPEC-auth §5.6, UA16) — không lộ project nào có thật. */
export const PROJECT_NOT_FOUND = { error: 'not_found', message: 'Project không tồn tại' } as const;

export interface ProjectScope {
  projectId: string;
  /** Role thật trong project; operator không là thành viên -> `null` (được coi như owner). */
  role: MemberRole | null;
  scopes: string[];
  viaOperator: boolean;
}

type ScopeStore = Pick<PrismaService, 'findProjectById' | 'identity'>;

/**
 * LUẬT DUY NHẤT của phạm vi project (DINH-CHINH X2, R-5) — dùng chung HTTP (`ProjectScopeGuard`), vé socket
 * (`/auth/socket-ticket`): HTTP và socket không bao giờ lệch nhau.
 *   - thiếu `projectId` -> 400 `project_required` (AU3: KHÔNG còn project mặc định);
 *   - không phải UUID / project không tồn tại / không là thành viên (và không phải operator) -> 404, CÙNG một body;
 *   - scope = ROLE_SCOPES[role]; operator không là thành viên = owner (`viaOperator`).
 */
export async function resolveProjectScope(prisma: ScopeStore, raw: unknown, principal: UserPrincipal): Promise<ProjectScope> {
  const projectId = Array.isArray(raw) ? raw[0] : raw;
  if (projectId === undefined || projectId === null || projectId === '') {
    throw new HttpException({ error: 'project_required', message: 'Thiếu ?projectId= — mọi route console đều theo một project' }, HttpStatus.BAD_REQUEST);
  }
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) throw new HttpException(PROJECT_NOT_FOUND, HttpStatus.NOT_FOUND);
  const [project, role] = await Promise.all([prisma.findProjectById(projectId), prisma.identity().findMembershipRole(principal.id, projectId)]);
  if (!project || (!role && !principal.isOperator)) throw new HttpException(PROJECT_NOT_FOUND, HttpStatus.NOT_FOUND);
  return { projectId, role, scopes: [...ROLE_SCOPES[role ?? 'owner']], viaOperator: !role };
}

/**
 * SPEC-auth §5.6 (ProjectAccessGuard của spec — giữ tên cũ vì cả repo đã dùng). Chạy SAU `SessionGuard`.
 * Thứ tự lỗi khớp ApiKeyGuard: 401 (SessionGuard) -> 404 (không thuộc project) -> 403 `missing_scope`.
 * `projectId` lấy từ path (`/api/v1/projects/:projectId/*`) hoặc query (`?projectId=`) — CHỖ DUY NHẤT console đọc nó.
 * Đặt `request.tenantId` (đọc bởi `@CurrentTenant()`) + `principal.tenantId/scopes`.
 * Operator vào project mình không là thành viên -> MỖI request ghi `audit_logs` `operator.access` (tenant = project đó).
 */
@Injectable()
export class ProjectScopeGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = req.principal;
    if (!principal || principal.kind !== 'user') throw new HttpException({ error: 'unauthenticated', message: 'Chưa đăng nhập' }, HttpStatus.UNAUTHORIZED);
    const raw = (req.params as Record<string, unknown> | undefined)?.projectId ?? (req.query as Record<string, unknown> | undefined)?.projectId;
    const scope = await resolveProjectScope(this.prisma, raw, principal);
    req.tenantId = scope.projectId;
    principal.tenantId = scope.projectId;
    principal.scopes = scope.scopes;

    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_SCOPE_KEY, [context.getHandler(), context.getClass()]);
    // R-8: đóng mặc định — route quên @RequireScope là lỗi cấu hình (500), không phải "mọi role đều qua".
    if (!required) {
      logger.error({ path: req.path, method: req.method }, 'ProjectScopeGuard: route không khai @RequireScope -> 500 (R-8)');
      scopeNotDeclared(`${req.method ?? ''} ${req.path ?? ''}`.trim());
    }
    if (!scope.scopes.includes(required)) {
      throw new HttpException({ error: 'missing_scope', message: `Role hiện tại không có quyền ${required}`, required }, HttpStatus.FORBIDDEN);
    }

    if (scope.viaOperator) {
      // Ghi TRƯỚC khi handler chạy: operator xem dữ liệu project người khác luôn để lại dấu vết.
      await this.prisma.forTenant(scope.projectId).createAuditLog({
        action: 'operator.access',
        entityType: 'project',
        entityId: scope.projectId,
        actor: principal.id,
        metadata: { method: req.method, path: (req.path ?? '').slice(0, 200) },
      });
      logger.info({ operator: principal.id, projectId: scope.projectId }, 'operator.access');
    }
    return true;
  }
}
