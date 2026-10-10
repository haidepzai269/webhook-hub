import {
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Body,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService, TenantScopedRepository } from '@hub/database';
import {
  API_SCOPES,
  PROJECT_SLUG_RE,
  apiKeyPrefix,
  buildConnectionString,
  generateApiKey,
  hashApiKey,
  isApiScope,
  isValidEventPattern,
} from '@hub/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { createApiKeyWithSource } from './api-key-create';
import { resolveProjectScope } from './project-scope.guard';
import { RequestWithPrincipal, UserPrincipal } from '../service-api/principal';

const me = (req: RequestWithPrincipal) => req.principal as UserPrincipal;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * S2 (SPEC §4.3A): console admin quản lý project và API key. Admin env = operator/root (ADR-056) nên thấy
 * mọi project. `projects` là bảng gốc -> escape hatch có tên trên PrismaService; `api_keys` mang tenant_id
 * -> đi qua `forTenant(projectId)` (BB-5). Key thô chỉ xuất hiện ĐÚNG MỘT LẦN ở response tạo.
 */
@Controller('api/v1/projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(private readonly prisma: PrismaService) {}

  /** AU1: chỉ project mình là thành viên (kèm role); operator thấy mọi project (ADR-056, role = owner). */
  @Get()
  async list(@Req() req: RequestWithPrincipal) {
    const p = me(req);
    const mine = await this.prisma.identity().listMemberships(p.id);
    if (!p.isOperator) return mine.map((m) => ({ id: m.projectId, slug: m.slug, name: m.name, environment: m.environment, role: m.role }));
    const roles = new Map(mine.map((m) => [m.projectId, m.role]));
    return (await this.prisma.listProjects()).map((x) => ({ ...x, role: roles.get(x.id) ?? 'owner' }));
  }

  /** Người tạo thành owner (membership) trong CÙNG transaction. */
  @Post()
  async create(@Req() req: RequestWithPrincipal, @CurrentUser() actor: string, @Body() body: any) {
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    if (!PROJECT_SLUG_RE.test(slug)) invalid('slug', 'slug khớp ^[a-z0-9][a-z0-9-]{2,62}$ (vd "cafe")');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) invalid('name', 'name là chuỗi 1–255 ký tự');
    const environment = body?.environment ?? 'test';
    if (environment !== 'test' && environment !== 'live') invalid('environment', "environment là 'test' hoặc 'live'");
    const id = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const project = await this.prisma.identity(tx).createProject({ id, slug, name, environment });
        await this.prisma.identity(tx).ensureMembership(me(req).id, id, 'owner');
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

  @Get(':projectId/keys')
  async listKeys(@Req() req: RequestWithPrincipal, @Param('projectId') projectId: string) {
    await this.requireProject(req, projectId);
    return this.prisma.forTenant(projectId).findApiKeys();
  }

  @Post(':projectId/keys')
  async createKey(@Req() req: RequestWithPrincipal, @CurrentUser() actor: string, @Param('projectId') projectId: string, @Body() body: any) {
    const project = await this.requireProject(req, projectId);
    const input = parseCreateKey(body);
    const key = generateApiKey(project.environment);
    const created = await createApiKeyWithSource(this.prisma, project.id, {
      ...input,
      keyHash: hashApiKey(key),
      keyPrefix: apiKeyPrefix(key),
      actor,
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
  async revokeKey(@Req() req: RequestWithPrincipal, @CurrentUser() actor: string, @Param('projectId') projectId: string, @Param('keyId') keyId: string) {
    await this.requireProject(req, projectId);
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

  /** CÙNG luật với `?projectId=` (resolveProjectScope): không tồn tại / không phải thành viên -> cùng 404. */
  private async requireProject(req: RequestWithPrincipal, projectId: string) {
    if (!UUID_RE.test(projectId)) throw new NotFoundException({ error: 'not_found', message: 'Project không tồn tại' });
    await resolveProjectScope(this.prisma, projectId, me(req));
    const project = await this.prisma.findProjectById(projectId);
    if (!project) throw new NotFoundException({ error: 'not_found', message: 'Project không tồn tại' });
    return project;
  }
}
