import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { MemberRole, PrismaService } from '@hub/database';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** MỘT body cho "project không tồn tại" và "không phải thành viên" (SPEC-auth §5.6, UA16) — không lộ project nào có thật. */
export const PROJECT_NOT_FOUND = { error: 'not_found', message: 'Project không tồn tại' } as const;

export interface ProjectScope {
  projectId: string;
  /** Role thật trong project; operator không là thành viên -> `null` (được coi như owner). */
  role: MemberRole | null;
  viaOperator: boolean;
}

type ScopeStore = Pick<PrismaService, 'findProjectById' | 'identity'>;

/**
 * LUẬT DUY NHẤT của phạm vi project (DINH-CHINH X2, R-5): dùng chung cho HTTP (`ProjectScopeGuard`), vé socket
 * (`/auth/socket-ticket`) và mọi chỗ khác — HTTP và socket không bao giờ lệch nhau.
 *   - `?projectId=` có: phải là UUID của project TỒN TẠI và người gọi là THÀNH VIÊN (hoặc operator) — sai -> 404,
 *     cùng một body cho mọi trường hợp;
 *   - `?projectId=` trống (AU1, tạm): project đầu tiên người đó là thành viên; không có -> 400 `project_required`.
 *     AU3 bỏ nhánh mặc định này (`?projectId=` bắt buộc) và gắn scope theo role.
 */
export async function resolveProjectScope(prisma: ScopeStore, raw: unknown, principal: UserPrincipal): Promise<ProjectScope> {
  const idn = prisma.identity();
  if (raw === undefined || raw === null || raw === '') {
    const first = (await idn.listMemberships(principal.id))[0];
    if (!first) throw new HttpException({ error: 'project_required', message: 'Thiếu ?projectId= (chưa là thành viên project nào)' }, HttpStatus.BAD_REQUEST);
    return { projectId: first.projectId, role: first.role, viaOperator: false };
  }
  const projectId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) throw new HttpException(PROJECT_NOT_FOUND, HttpStatus.NOT_FOUND);
  const [project, role] = await Promise.all([prisma.findProjectById(projectId), idn.findMembershipRole(principal.id, projectId)]);
  if (!project || (!role && !principal.isOperator)) throw new HttpException(PROJECT_NOT_FOUND, HttpStatus.NOT_FOUND);
  return { projectId, role, viaOperator: !role };
}

/**
 * S2 (SPEC §4.3A): CHỖ DUY NHẤT console đọc `?projectId=`. Chạy SAU `SessionGuard`. Đặt `request.tenantId`
 * (đọc bởi `@CurrentTenant()`) + `principal.tenantId`.
 */
@Injectable()
export class ProjectScopeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = req.principal;
    if (!principal || principal.kind !== 'user') throw new HttpException({ error: 'unauthenticated', message: 'Chưa đăng nhập' }, HttpStatus.UNAUTHORIZED);
    const scope = await resolveProjectScope(this.prisma, (req.query as Record<string, unknown> | undefined)?.projectId, principal);
    req.tenantId = scope.projectId;
    principal.tenantId = scope.projectId;
    return true;
  }
}
