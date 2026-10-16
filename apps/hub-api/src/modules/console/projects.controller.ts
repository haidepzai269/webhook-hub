import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Put,
  Body,
  HttpException,
  HttpStatus,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService, ProjectStatsRow, TenantScopedRepository } from '@hub/database';
import {
  API_SCOPES,
  OWNER_GRANTED_API_SCOPES,
  parseStorageLevel,
  quotaBytesFor,
  PROJECT_SLUG_RE,
  apiKeyPrefix,
  buildConnectionString,
  generateApiKey,
  hashApiKey,
  isApiScope,
  isScope,
  isValidEventPattern,
} from '@hub/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { createApiKeyWithSource } from './api-key-create';
import { ProjectScopeGuard } from './project-scope.guard';
import { OperatorGuard } from './operator.guard';
import { NoProjectScope, RequireScope } from '../service-api/require-scope.decorator';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';

const me = (req: RequestWithPrincipal) => req.principal as UserPrincipal;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** R-14 (ADR-118): trần project mỗi user — chống tạo hàng loạt bằng tài khoản chưa xác minh. */
export const PROJECT_LIMIT_UNVERIFIED = 3;
export const PROJECT_LIMIT_VERIFIED = 10;

/** 422 có tên trường (SPEC bảng lỗi): body `{error:'validation_failed', field, message}`. */
export function invalid(field: string, message: string): never {
  throw new UnprocessableEntityException({ error: 'validation_failed', field, message });
}

/** `HUB_PUBLIC_URL` (vd `http://localhost:4000`) — host trong connection string. */
export function hubPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HUB_PUBLIC_URL && env.HUB_PUBLIC_URL.trim()) || `http://localhost:${env.PORT || 4000}`;
}

export interface CreateKeyInput {
  serviceName: string;
  scopes: string[];
  readTypes: string[];
}

/** Kiểm body tạo key: serviceName 1–128, scopes ≥1 và đều hợp lệ, readTypes (tuỳ chọn) là mẫu kiểu hợp lệ. */
export function parseCreateKey(body: any): CreateKeyInput {
  const serviceName = typeof body?.serviceName === 'string' ? body.serviceName.trim() : '';
  if (!serviceName || serviceName.length > 128) invalid('serviceName', 'serviceName là chuỗi 1–128 ký tự');
  if (!Array.isArray(body?.scopes) || body.scopes.length === 0) {
    invalid('scopes', `Key phải có ít nhất một scope (${API_SCOPES.join(', ')})`);
  }
  // SPEC-auth §2.2 / UA19: scope của NGƯỜI (manage:keys, manage:members, manage:project, read:project,
  // replay:deliveries) không bao giờ cấp cho máy — máy không tự đúc key / tự thêm người (chặn leo thang đặc quyền).
  const notGrantable = body.scopes.filter((s: unknown) => isScope(s) && !isApiScope(s));
  if (notGrantable.length > 0) {
    throw new UnprocessableEntityException({
      error: 'scope_not_grantable',
      field: 'scopes',
      message: `Scope chỉ dành cho người, không cấp cho API key: ${notGrantable.join(', ')}`,
    });
  }
  const bad = body.scopes.filter((s: unknown) => !isApiScope(s));
  if (bad.length > 0) invalid('scopes', `Scope không hợp lệ: ${bad.slice(0, 5).map((s: unknown) => JSON.stringify(s)).join(', ')}`);
  let readTypes: string[] = [];
  if (body?.readTypes !== undefined && body.readTypes !== null) {
    if (!Array.isArray(body.readTypes) || body.readTypes.length > 50 || !body.readTypes.every(isValidEventPattern)) {
      invalid('readTypes', 'readTypes là mảng ≤ 50 mẫu kiểu (vd ["order.*"])');
    }
    readTypes = [...new Set(body.readTypes as string[])];
  }
  return { serviceName, scopes: [...new Set(body.scopes as string[])], readTypes };
}

/** SPEC-auth §5.6: chưa xác minh email -> không tạo project/key `live`, không mời người (giống Stripe test mode). */
export function emailNotVerified(): never {
  throw new HttpException(
    { error: 'email_not_verified', message: 'Xác minh email trước khi tạo project / key live hoặc mời thành viên (dùng test mode trong lúc chờ)' },
    HttpStatus.FORBIDDEN,
  );
}

/** ADR-235: một dòng số đếm -> hình dạng API (số nguyên, nấc dung lượng đã chuẩn hoá, ngày tạo ISO). */
export function projectStatsView(r: ProjectStatsRow) {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    createdAt: new Date(r.createdAt).toISOString(),
    sources: n(r.sources),
    endpoints: n(r.endpoints),
    members: n(r.members),
    events24h: n(r.events24h),
    failedAttempts24h: n(r.failedAttempts24h),
    dlq: n(r.dlq),
    circuitOpen: n(r.circuitOpen),
    storageLevel: parseStorageLevel(r.storageLevel),
    openAlerts: { critical: n(r.openAlerts?.critical), warning: n(r.openAlerts?.warning), info: n(r.openAlerts?.info) },
  };
}

/**
 * S2 (SPEC §4.3A) + AU3: console quản lý project và API key theo MEMBERSHIP (operator thấy mọi project). `projects` là bảng gốc -> escape hatch có tên trên PrismaService; `api_keys` mang tenant_id
 * -> đi qua `forTenant(projectId)` (BB-5). Key thô chỉ xuất hiện ĐÚNG MỘT LẦN ở response tạo.
 */
@Controller('api/v1/projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * AU1: chỉ project mình là thành viên (kèm role); operator thấy mọi project (ADR-056, role = owner).
   * ADR-235: `?include=stats` gắn `stats` (chỉ số đếm) cho từng project trong MỘT lượt đọc — escape hatch theo membership
   * (người thường) hoặc của operator (cùng phạm vi danh sách). 0 lệnh Redis. Project không có dòng số liệu -> `stats: null`.
   */
  @Get()
  @NoProjectScope('liệt kê project CỦA CHÍNH người gọi — lọc theo membership ngay trong handler')
  async list(@Req() req: RequestWithPrincipal, @Query('include') include?: string) {
    if (include !== undefined && include !== 'stats') invalid('include', "include chỉ nhận 'stats'");
    const p = me(req);
    const items = await this.listItems(p);
    if (include !== 'stats') return items;
    const rows = p.isOperator ? await this.prisma.operatorProjectStatsAcrossTenants() : await this.prisma.memberProjectStatsAcrossTenants(p.id);
    const byId = new Map(rows.map((r) => [r.tenantId, r] as const));
    return items.map((x) => {
      const r = byId.get(x.id);
      return { ...x, stats: r ? projectStatsView(r) : null };
    });
  }

  private async listItems(p: UserPrincipal) {
    const mine = await this.prisma.identity().listMemberships(p.id);
    if (!p.isOperator) return mine.map((m) => ({ id: m.projectId, slug: m.slug, name: m.name, environment: m.environment, role: m.role, member: true }));
    // `member` thật (sửa lỗi "stale project"): web mặc định project mình là thành viên, không tự rơi vào project người khác.
    const roles = new Map(mine.map((m) => [m.projectId, m.role]));
    // QT7 (§9): operator thấy cột mức sử dụng (ước tính) + hạn mức ghi đè. Lỗi đọc usage -> danh sách vẫn hiện (không có cột).
    const usageRows: { tenantId: string; usedBytes: number; level: string }[] = await this.prisma.operatorProjectUsage().catch(() => []);
    const usage = new Map(usageRows.map((u) => [u.tenantId, u] as const));
    return (await this.prisma.listProjects()).map((x) => {
      const u = usage.get(x.id);
      const quotaMb = (x as { storageQuotaMb?: number | null }).storageQuotaMb ?? null;
      const quotaBytes = quotaBytesFor(quotaMb);
      const usedBytes = u?.usedBytes ?? 0;
      return {
        ...x,
        role: roles.get(x.id) ?? 'owner',
        member: roles.has(x.id),
        usage: {
          estimated: true,
          usedBytes,
          quotaBytes,
          usedPct: quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 1000) / 10 : 0,
          level: parseStorageLevel(u?.level),
          quotaOverrideMb: quotaMb,
        },
      };
    });
  }

  /**
   * QT7 (§2, §9): OPERATOR ghi đè hạn mức dung lượng của một project (`storageQuotaMb` 1–102400, null = về mặc định
   * `PROJECT_STORAGE_QUOTA_MB`). Ghi + `audit_logs` cùng transaction. Nấc tính lại ở lượt 60s kế tiếp của worker.
   */
  @Put(':projectId/storage-quota')
  @UseGuards(OperatorGuard)
  @NoProjectScope('ghi đè hạn mức — CHỈ operator (OperatorGuard), project bất kỳ')
  async setStorageQuota(@CurrentUser() actor: string, @Param('projectId') projectId: string, @Body() body: any) {
    const project = await this.requireProject(projectId);
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    const v = body?.storageQuotaMb;
    if (!keys || keys.length !== 1 || keys[0] !== 'storageQuotaMb' || !(v === null || (Number.isInteger(v) && v >= 1 && v <= 102_400))) {
      invalid('storageQuotaMb', 'Body là {"storageQuotaMb": số nguyên 1–102400 | null (về mặc định)}');
    }
    const before = (project as { storageQuotaMb?: number | null }).storageQuotaMb ?? null;
    await this.prisma.tenantTx(projectId, async (tx) => {
      await this.prisma.setProjectStorageQuota(projectId, v, tx);
      await this.prisma.forTenant(projectId, tx).createAuditLog({
        action: 'project.storage_quota_changed',
        entityType: 'project',
        entityId: projectId,
        actor,
        metadata: { before, after: v },
      });
    });
    return { id: projectId, storageQuotaMb: v, quotaBytes: quotaBytesFor(v) };
  }

  /** PK5 khoá 1 (SPEC-provider-khac §7.1, E14): project có nhận nguồn `unverified` không — ai đọc project cũng xem được. */
  @Get(':projectId/unverified-sources')
  @UseGuards(ProjectScopeGuard)
  @RequireScope('read:project')
  async getUnverifiedSources(@Param('projectId') projectId: string) {
    const project = await this.requireProject(projectId);
    return { allowUnverifiedSources: (project as { allowUnverifiedSources?: boolean }).allowUnverifiedSources === true };
  }

  /**
   * PK5 khoá 1 (§7.1, E14, ADR-206): OWNER bật/tắt "Nhận nguồn chưa xác thực" (`manage:project`; người vận hành = owner qua
   * viaOperator). Ghi + `audit_logs` cùng transaction. Tắt -> mọi source `unverified` của project bị từ chối ngay request kế
   * tiếp (ingest đọc cờ cùng câu nạp source), không ghi, không phạt.
   */
  @Put(':projectId/unverified-sources')
  @UseGuards(ProjectScopeGuard)
  @RequireScope('manage:project')
  async setUnverifiedSources(@CurrentUser() actor: string, @Param('projectId') projectId: string, @Body() body: any) {
    const project = await this.requireProject(projectId);
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || keys.length !== 1 || keys[0] !== 'allowUnverifiedSources' || typeof body.allowUnverifiedSources !== 'boolean') {
      invalid('allowUnverifiedSources', 'Body là {"allowUnverifiedSources": true | false}');
    }
    const before = (project as { allowUnverifiedSources?: boolean }).allowUnverifiedSources === true;
    const after: boolean = body.allowUnverifiedSources;
    await this.prisma.tenantTx(projectId, async (tx) => {
      await this.prisma.setProjectAllowUnverified(projectId, after, tx);
      await this.prisma.forTenant(projectId, tx).createAuditLog({
        action: 'project.unverified_sources_changed',
        entityType: 'project',
        entityId: projectId,
        actor,
        metadata: { before, after },
      });
    });
    return { id: projectId, allowUnverifiedSources: after };
  }

  /** Người tạo thành owner (membership) trong CÙNG transaction. `live` cần email đã xác minh (§5.6). */
  @Post()
  @NoProjectScope('tạo project MỚI — người tạo thành owner; chưa thuộc project nào để kiểm scope')
  async create(@Req() req: RequestWithPrincipal, @CurrentUser() actor: string, @Body() body: any) {
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    if (!PROJECT_SLUG_RE.test(slug)) invalid('slug', 'slug khớp ^[a-z0-9][a-z0-9-]{2,62}$ (vd "cafe")');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) invalid('name', 'name là chuỗi 1–255 ký tự');
    const environment = body?.environment ?? 'test';
    if (environment !== 'test' && environment !== 'live') invalid('environment', "environment là 'test' hoặc 'live'");
    if (environment === 'live' && !me(req).emailVerified) emailNotVerified();
    const id = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // R-14 (ADR-118): trần số project mỗi user (chưa xác minh 3, đã xác minh 10, operator không giới hạn).
        const user = me(req);
        if (!user.isOperator) {
          const limit = user.emailVerified ? PROJECT_LIMIT_VERIFIED : PROJECT_LIMIT_UNVERIFIED;
          if ((await this.prisma.identity(tx).lockAndCountOwnedProjects(user.id)) >= limit) {
            throw new HttpException(
              { error: 'project_limit', message: `Đã đạt tối đa ${limit} project${user.emailVerified ? '' : ' (xác minh email để tạo thêm)'}`, limit },
              HttpStatus.FORBIDDEN,
            );
          }
        }
        const project = await this.prisma.identity(tx).createProject({ id, slug, name, environment });
        await this.prisma.identity(tx).ensureMembership(me(req).id, id, 'owner');
        // QT:T26 (Q10, ADR-186): policy dọn tự động mặc định + dòng project_usage — cùng transaction với project.
        await new TenantScopedRepository(tx, id).seedStorageDefaults('system:project-create');
        await new TenantScopedRepository(tx, id).createAuditLog({
          action: 'project.created',
          entityType: 'project',
          entityId: id,
          actor,
          metadata: { slug, name, environment },
        });
        return project;
      });
    } catch (e) {
      if ((e as { code?: unknown })?.code === 'P2002') throw new ConflictException({ error: 'slug_taken', message: `Slug "${slug}" đã có project` });
      throw e;
    }
  }

  /** §6.1: xem danh sách key (chỉ prefix, không bao giờ key/hash) là việc đọc -> read:project. */
  @Get(':projectId/keys')
  @UseGuards(ProjectScopeGuard)
  @RequireScope('read:project')
  async listKeys(@Param('projectId') projectId: string) {
    await this.requireProject(projectId);
    return this.prisma.forTenant(projectId).findApiKeys();
  }

  @Post(':projectId/keys')
  @UseGuards(ProjectScopeGuard)
  @RequireScope('manage:keys')
  async createKey(@Req() req: RequestWithPrincipal, @CurrentUser() actor: string, @Param('projectId') projectId: string, @Body() body: any) {
    const project = await this.requireProject(projectId);
    const input = parseCreateKey(body);
    // PK5 (E4, ADR-206): `read:unverified` (polling trả event chưa xác thực) chỉ người có scope đó (owner / người vận hành) cấp.
    const mine = (req.principal as { scopes?: string[] } | undefined)?.scopes ?? [];
    const ungrantable = input.scopes.filter((s) => (OWNER_GRANTED_API_SCOPES as readonly string[]).includes(s) && !mine.includes(s));
    if (ungrantable.length > 0) {
      throw new HttpException(
        { error: 'missing_scope', message: `Chỉ owner của project cấp được ${ungrantable.join(', ')} cho API key`, required: ungrantable[0] },
        HttpStatus.FORBIDDEN,
      );
    }
    // §5.6 / UA28: hk_live_ (project live) cần email đã xác minh; hk_test_ thì được ngay (Quickstart 60 giây).
    if (project.environment === 'live' && !me(req).emailVerified) emailNotVerified();
    const key = generateApiKey(project.environment);
    const created = await createApiKeyWithSource(this.prisma, project.id, {
      ...input,
      keyHash: hashApiKey(key),
      keyPrefix: apiKeyPrefix(key),
      actor,
      sourceLimitExempt: me(req).isOperator === true,
    });
    return {
      ...created,
      key, // ĐÚNG MỘT LẦN — không lưu, không log
      connectionString: buildConnectionString(hubPublicUrl(), key, project.slug),
    };
  }

  /** Revoke idempotent (lần hai vẫn 204). Key không thuộc project -> 404. Audit chỉ khi thật sự đổi. */
  @Delete(':projectId/keys/:keyId')
  @HttpCode(204)
  @UseGuards(ProjectScopeGuard)
  @RequireScope('manage:keys')
  async revokeKey(@CurrentUser() actor: string, @Param('projectId') projectId: string, @Param('keyId') keyId: string) {
    await this.requireProject(projectId);
    if (!UUID_RE.test(keyId)) throw new NotFoundException({ error: 'not_found', message: 'API key không tồn tại' });
    await this.prisma.$transaction(async (tx) => {
      const repo = new TenantScopedRepository(tx, projectId);
      const existing = await repo.findApiKeyById(keyId);
      if (!existing) throw new NotFoundException({ error: 'not_found', message: 'API key không tồn tại' });
      if ((await repo.revokeApiKey(keyId)) === 1) {
        await repo.createAuditLog({
          action: 'api_key.revoked',
          entityType: 'api_key',
          entityId: keyId,
          actor,
          metadata: { serviceName: existing.serviceName, keyPrefix: existing.keyPrefix },
        });
      }
    });
  }

  /** Đã qua ProjectScopeGuard (tồn tại + thành viên/operator + scope); đọc lại để có environment/slug. */
  private async requireProject(projectId: string) {
    if (!UUID_RE.test(projectId)) throw new NotFoundException({ error: 'not_found', message: 'Project không tồn tại' });
    const project = await this.prisma.findProjectById(projectId);
    if (!project) throw new NotFoundException({ error: 'not_found', message: 'Project không tồn tại' });
    return project;
  }
}
