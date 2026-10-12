import {
  BadRequestException,
  ConflictException,
  Controller,
  NotFoundException,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  HttpException,
  HttpStatus,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PrismaService, TenantScopedRepository, getMasterKey, DeadDeliveryFilter, DLQ_ERROR_KINDS, DlqErrorKind } from '@hub/database';
import { aesGcmEncrypt } from '@hub/crypto';
import { buildDeliveryMessage, generateCorrelationId, isValidEventPattern, OutboxPayload, ProviderType } from '@hub/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { SessionGuard } from '../auth/session.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { RedactSecretsInterceptor } from './redact-secrets.interceptor';
import { RequestWithPrincipal } from '../service-api/principal';
import { hubError } from '../errors/hub-error';
import { assertSourceLimit, isOperatorRequest } from '../console/source-limit';
import { SOURCE_KEY_RE, SOURCE_KEY_RULE, generateSourceKey } from '../console/source-key';
import { ProjectScopeGuard } from '../console/project-scope.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { resolveSourceIds } from '../service-api/service-resources.controller';
import { parseSourceInput } from '../service-api/source-input';
import { consoleDestination } from './destination-view';
import { badParam, parseEnumParam, parseTextParam, parseTimeRange, parseUuidParam } from './list-params';
import { AuditListQuery, DeliveryListQuery, listAuditPage, listDeliveryPage } from './console-lists';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** S1-3: trần số raw event mồ côi mỗi lần xem / mỗi lần chuẩn hoá lại. */
const ORPHAN_LIST_LIMIT = 100;
const RENORMALIZE_LIMIT = 500;
/** S2-3: replay hàng loạt tối đa 500 delivery mỗi lần; lý do bắt buộc. */
export const REPLAY_BULK_LIMIT = 500;
const REPLAY_BULK_SAMPLE = 10;
const REASON_MIN = 5;

function optionalReason(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null;
}


/**
 * S3-3: `eventTypes` của subscription — mảng 1..50 mẫu, mỗi mẫu đúng ngữ pháp
 * `^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$` (libs/common/src/event-pattern.ts). Sai -> 400 kèm mẫu sai.
 */
export function parseEventTypes(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 50) {
    throw new BadRequestException('eventTypes phải là mảng 1–50 mẫu (vd ["payment.*", "repo.push"])');
  }
  const bad = v.filter((t) => !isValidEventPattern(t));
  if (bad.length > 0) {
    throw new BadRequestException({
      error: 'invalid_event_pattern',
      message: `Mẫu kiểu sự kiện không hợp lệ: ${bad.slice(0, 5).map((t) => JSON.stringify(t)).join(', ')}`,
      fix: 'Dùng chữ thường, số, "_", phân tách bằng "."; wildcard chỉ ở cuối (".*") hoặc "*" một mình. Vd: payment.*, repo.push, *',
    });
  }
  return [...new Set(v as string[])];
}

/**
 * ADR-161 (L1): route cần THÊM một scope ngoài `@RequireScope` (decorator chỉ nhận một). Đóng mặc định: không có
 * principal/scopes -> 403 (guard thật luôn gắn `principal.scopes`).
 */
function requireAlsoScope(req: RequestWithPrincipal | undefined, scope: string) {
  const scopes = (req?.principal as { scopes?: string[] } | undefined)?.scopes;
  if (!Array.isArray(scopes) || !scopes.includes(scope)) {
    throw new HttpException({ error: 'missing_scope', message: `Role hiện tại không có quyền ${scope}`, required: scope }, HttpStatus.FORBIDDEN);
  }
}

function assertUuid(id: string, what: string) {
  if (!UUID_RE.test(id)) throw new NotFoundException(`${what} không tồn tại`);
}

/**
 * Toàn bộ `/api/v1/*` (dashboard) BẮT BUỘC JWT (SessionGuard) — tenantId LUÔN lấy
 * từ token đã verify (`@CurrentTenant()`), KHÔNG BAO GIỜ từ header client tự gửi
 * như `x-tenant-id` trước đây. Mọi truy vấn 5 bảng nghiệp vụ (source, destination,
 * subscription, event, delivery) đi qua `TenantScopedRepository` (BB-5) — không gọi
 * thẳng `this.prisma.<model>` vì `PrismaService` không còn expose các model đó.
 * Response đi qua `RedactSecretsInterceptor` — không bao giờ trả ciphertext `*Encrypted`.
 */
@Controller('api/v1')
// S2 (X2): `?projectId=` đọc ở MỘT chỗ — ProjectScopeGuard chạy sau JWT, đổi request.tenantId.
@UseGuards(SessionGuard, ProjectScopeGuard)
@UseInterceptors(RedactSecretsInterceptor)
export class ApiController {
  constructor(private readonly prisma: PrismaService) {}

  // --- Overview ---
  @Get('overview')
  @RequireScope('read:project')
  async getOverview(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    const [totalSources, totalDestinations, totalEvents, totalDeliveries, deadDeliveries] = await Promise.all([
      // ADR-161: mục đã lưu trữ không còn là cấu hình (lịch sử event/delivery vẫn đếm).
      repo.countSources({ archivedAt: null }),
      repo.countDestinations({ archivedAt: null }),
      repo.countEvents(),
      repo.countDeliveries(),
      repo.countDeadDeliveries(),
    ]);

    return {
      totalSources,
      totalDestinations,
      totalEvents,
      totalDeliveries,
      deadDeliveries,
      // null khi chưa có delivery nào — UI hiện "—", không bịa 100% (S2-2).
      successRate: totalDeliveries > 0 ? ((totalDeliveries - deadDeliveries) / totalDeliveries) * 100 : null,
    };
  }

  // --- Stats: chuỗi thời gian cho biểu đồ dashboard (Postgres only, không Redis) ---
  @Get('stats/timeseries')
  @RequireScope('read:project')
  async getTimeseries(@CurrentTenant() tenantId: string, @Query('range') range = '24h') {
    if (range !== '24h' && range !== '7d') {
      throw new BadRequestException("range phải là '24h' hoặc '7d'");
    }
    return this.prisma.forTenant(tenantId).getTimeseries(range);
  }

  // --- Sources ---
  // Không trả `secrets` (ciphertext) ra trình duyệt — dashboard chỉ cần biết có bao nhiêu version.
  @Get('sources')
  @RequireScope('read:project')
  async listSources(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    // ADR-161: mặc định ẩn source đã lưu trữ.
    const sources = await repo.findSources({ archivedAt: null });
    return sources.map(({ secrets, ...s }) => ({
      ...s,
      secretVersions: secrets.length,
      webhookUrl: `/hooks/${s.provider}/${s.sourceKey}`,
    }));
  }

  @Post('sources')
  @RequireScope('manage:sources')
  async createSource(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any, @Req() req?: RequestWithPrincipal) {
    const masterKey = getMasterKey();
    // S8: cùng bộ kiểm với /v1/p (provider hợp lệ, generic bắt buộc verificationConfig) -> 422 có tên trường.
    const input = parseSourceInput(body);
    // Review EG1 #4: key tự đặt phải đúng khuôn (cùng luật với "Kết nối provider") — key lạ (`my.key`, > 64 ký tự) sẽ bị
    // nginx trả 404 ở /hooks/* mà source vẫn được tạo.
    const custom = body?.sourceKey;
    if (custom !== undefined && custom !== null && custom !== '' && (typeof custom !== 'string' || !SOURCE_KEY_RE.test(custom))) {
      throw hubError('validation_failed', { field: 'sourceKey' }, SOURCE_KEY_RULE);
    }
    const sourceKey: string = custom || generateSourceKey(input.provider);

    const source = await this.withAudit(tenantId, async (repo) => {
      // QT9 (Q11): trần source/project, khoá đếm trong CÙNG transaction; operator miễn.
      await assertSourceLimit(repo, isOperatorRequest(req));
      const created = await repo.createSource({
        provider: input.provider,
        name: input.name,
        sourceKey,
        isActive: true,
        ...(input.verificationConfig ? { verificationConfig: input.verificationConfig as any } : {}),
        secrets: {
          create: {
            secretEncrypted: aesGcmEncrypt(input.secret, masterKey),
            version: 1,
          },
        },
      } as any);
      await repo.createAuditLog({
        action: 'source.create',
        entityType: 'source',
        entityId: created.id,
        actor,
        metadata: { provider: created.provider, name: created.name, sourceKey },
      });
      return created;
    });
    // Không trả ciphertext secret ra trình duyệt.
    const { secrets, ...rest } = source as any;
    return { ...rest, secretVersions: Array.isArray(secrets) ? secrets.length : 0 };
  }

  /** Chỉ đổi tên / bật-tắt. Không xoá source: raw_events (bằng chứng đã nhận) sẽ mất theo. */
  @Patch('sources/:id')
  @RequireScope('manage:sources')
  async updateSource(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any, @Req() req?: RequestWithPrincipal) {
    assertUuid(id, 'Source');
    const data: { name?: string; isActive?: boolean; keepLonger?: boolean } = {};
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (typeof body?.isActive === 'boolean') data.isActive = body.isActive;
    // QT5 (§5.5, E1/ADR-189): cờ "Giữ lâu" do user TỰ gắn — đổi cách hub giữ dữ liệu (nhận tới 110%, không gợi ý, không dọn
    // tự động) nên cần thêm `storage:write` (owner + người vận hành), không chỉ `manage:sources`.
    if (body?.keepLonger !== undefined) {
      if (typeof body.keepLonger !== 'boolean') throw hubError('bad_request', { field: 'keepLonger' }, 'keepLonger là boolean');
      requireAlsoScope(req, 'storage:write');
      data.keepLonger = body.keepLonger;
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('Không có trường nào để sửa (name, isActive, keepLonger)');
    const updated = await this.withAudit(tenantId, async (repo) => {
      const u = await repo.updateSource(id, data);
      if (!u) throw new NotFoundException('Source không tồn tại');
      await repo.createAuditLog({ action: 'source.update', entityType: 'source', entityId: id, actor, reason: optionalReason(body?.reason), metadata: data });
      return u;
    });
    const { secrets, ...rest } = updated as any;
    return { ...rest, secretVersions: Array.isArray(secrets) ? secrets.length : 0 };
  }

  // --- Destinations ---
  @Get('destinations')
  @RequireScope('read:project')
  async listDestinations(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    // P2 (ADR-140): bản công khai — không trả config/secret mã hoá; có trạng thái xác minh.
    // ADR-161: mặc định ẩn đích đã lưu trữ.
    return (await repo.findDestinations({ archivedAt: null })).map(consoleDestination);
  }

  @Post('destinations')
  @RequireScope('manage:endpoints')
  async createDestination(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any) {
    // KN1 (SPEC-ket-noi §3.1, ADR-138): endpoint webhook đi route riêng — hub sinh whsec_, challenge, subscription cùng tx.
    if (body?.type === 'webhook') throw hubError('use_endpoints_route', {}, 'Endpoint webhook tạo bằng POST /api/v1/endpoints (hub sinh secret + challenge)');
    const masterKey = getMasterKey();
    return this.withAudit(tenantId, async (repo) => {
      const created = await repo.createDestination({
        name: body.name,
        type: body.type,
        configEncrypted: aesGcmEncrypt(JSON.stringify(body.config || {}), masterKey),
        signingSecretEncrypted: body.signingSecret ? aesGcmEncrypt(body.signingSecret, masterKey) : undefined,
        rateLimitRps: Number(body.rateLimitRps || 0),
      });
      // metadata KHÔNG chứa config/secret — chỉ tên trường.
      await repo.createAuditLog({
        action: 'destination.create',
        entityType: 'destination',
        entityId: created.id,
        actor,
        metadata: { name: created.name, type: created.type },
      });
      return consoleDestination(created);
    });
  }

  /**
   * Sửa đích (S2-3; cũng là cách kiểm S2-1: trỏ đích /mock/fail sang /mock/discord). Config/secret
   * được mã hoá lại; audit chỉ ghi TÊN trường đã đổi, không ghi giá trị.
   */
  @Patch('destinations/:id')
  @RequireScope('manage:endpoints')
  async updateDestination(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any) {
    assertUuid(id, 'Destination');
    const masterKey = getMasterKey();
    const data: Record<string, unknown> = {};
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim();
    // ADR-161: "Ngắt" / "Kết nối lại" đích trên bản đồ luồng.
    if (typeof body?.isActive === 'boolean') data.isActive = body.isActive;
    if (body?.config !== undefined) {
      if (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
        throw new BadRequestException('config phải là object');
      }
      data.configEncrypted = aesGcmEncrypt(JSON.stringify(body.config), masterKey);
    }
    if (body?.signingSecret !== undefined) {
      data.signingSecretEncrypted = body.signingSecret ? aesGcmEncrypt(String(body.signingSecret), masterKey) : null;
    }
    if (body?.rateLimitRps !== undefined) {
      const rps = Number(body.rateLimitRps);
      if (!Number.isInteger(rps) || rps < 0) throw new BadRequestException('rateLimitRps phải là số nguyên ≥ 0');
      data.rateLimitRps = rps;
    }
    const changed = Object.keys(data).map((k) => k.replace(/Encrypted$/, ''));
    if (changed.length === 0) throw new BadRequestException('Không có trường nào để sửa (name, isActive, config, signingSecret, rateLimitRps)');
    return this.withAudit(tenantId, async (repo) => {
      // ADR-161/163: bật/tắt đích đổi tập "còn replay được" — cùng khoá cấu hình luồng với replay hàng loạt / lưu trữ.
      if (typeof data.isActive === 'boolean') await repo.lockFlowConfig();
      const u = await repo.updateDestination(id, data);
      if (!u) throw new NotFoundException('Destination không tồn tại');
      await repo.createAuditLog({
        action: 'destination.update',
        entityType: 'destination',
        entityId: id,
        actor,
        reason: optionalReason(body?.reason),
        metadata: { fields: changed, ...(typeof data.isActive === 'boolean' ? { isActive: data.isActive } : {}) },
      });
      return consoleDestination(u);
    });
  }

  /**
   * Xoá đích (review SPEC-2 #1, ADR-054): CHỈ khi không còn subscription nào trỏ vào. Lịch sử gửi
   * (deliveries/attempts, kể cả DEAD) là bằng chứng — không bao giờ mất theo một cú xoá cấu hình.
   * DB cũng chặn (FK RESTRICT); 409 ở đây chỉ để nói rõ lý do + con số.
   */
  @Delete('destinations/:id')
  @RequireScope('manage:endpoints')
  async deleteDestination(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Query('reason') reason?: string) {
    assertUuid(id, 'Destination');
    return this.withFkGuard(() =>
      this.withAudit(tenantId, async (repo) => {
        const existing = await repo.findDestinationById(id);
        if (!existing) throw new NotFoundException('Destination không tồn tại');
        const subscriptionCount = await repo.countSubscriptions({ destinationId: id });
        if (subscriptionCount > 0) {
          const deliveryCount = await repo.countDeliveries({ subscription: { destinationId: id } });
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'DESTINATION_IN_USE',
            subscriptionCount,
            deliveryCount,
            message:
              `Không xoá được đích: còn ${subscriptionCount} subscription trỏ vào (${deliveryCount} delivery lịch sử). ` +
              'Đích chỉ xoá được khi không còn subscription nào — hãy tắt (isActive=false) các subscription đó; lịch sử gửi được giữ lại.',
          });
        }
        await repo.deleteDestination(id);
        await repo.createAuditLog({
          action: 'destination.delete',
          entityType: 'destination',
          entityId: id,
          actor,
          reason: optionalReason(reason),
          metadata: { name: existing.name, type: existing.type },
        });
        return { deleted: true, id };
      }),
    );
  }

  // --- Subscriptions ---
  @Get('subscriptions')
  @RequireScope('read:project')
  async listSubscriptions(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    // ADR-161: mặc định ẩn subscription đã lưu trữ.
    return repo.findSubscriptions({ archivedAt: null });
  }

  @Post('subscriptions')
  @RequireScope('manage:endpoints')
  async createSubscription(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any) {
    if (typeof body?.destinationId !== 'string' || !UUID_RE.test(body.destinationId)) throw new NotFoundException('Destination không tồn tại');
    const eventTypes = parseEventTypes(body?.eventTypes);
    return this.withAudit(tenantId, async (txRepo) => {
      // ADR-161 (T2): khoá cấu hình luồng rồi mới kiểm đích + nguồn TRONG transaction — không gắn được subscription vào
      // đích/source vừa bị lưu trữ song song.
      await txRepo.lockFlowConfig();
      // S1-5 (BB-5): đích phải thuộc CÙNG tenant. Trả 404 (không phải 403) để không lộ việc destinationId đó có tồn tại
      // ở tenant khác hay không. ADR-161 (C1): đích đã lưu trữ = không tồn tại.
      const destination = await txRepo.findDestinationById(body.destinationId);
      if (!destination) throw new NotFoundException('Destination không tồn tại');
      // S5: lọc nguồn — id lạ / của project khác / đã lưu trữ -> 422 unknown_source (cùng hàm với /v1/p)
      const sourceIds = await resolveSourceIds(txRepo, body?.sourceIds);
      const created = await txRepo.createSubscription({
        destinationId: body.destinationId,
        name: body.name,
        eventTypes,
        sourceIds,
        template: body.template,
        isActive: true,
      });
      await txRepo.createAuditLog({
        action: 'subscription.create',
        entityType: 'subscription',
        entityId: created.id,
        actor,
        metadata: { name: created.name, destinationId: created.destinationId, eventTypes: created.eventTypes, sourceIds: created.sourceIds },
      });
      return created;
    });
  }

  @Patch('subscriptions/:id')
  @RequireScope('manage:endpoints')
  async updateSubscription(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any) {
    assertUuid(id, 'Subscription');
    const data: Record<string, unknown> = {};
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (typeof body?.isActive === 'boolean') data.isActive = body.isActive;
    if (body?.template !== undefined) data.template = body.template === null ? null : String(body.template);
    if (body?.eventTypes !== undefined) data.eventTypes = parseEventTypes(body.eventTypes);
    const wantsSourceIds = body?.sourceIds !== undefined;
    if (Object.keys(data).length === 0 && !wantsSourceIds) throw new BadRequestException('Không có trường nào để sửa (name, isActive, template, eventTypes, sourceIds)');
    return this.withAudit(tenantId, async (repo) => {
      // ADR-161 (T2): kiểm nguồn TRONG transaction, sau khoá cấu hình luồng.
      await repo.lockFlowConfig();
      if (wantsSourceIds) data.sourceIds = await resolveSourceIds(repo, body.sourceIds);
      const u = await repo.updateSubscription(id, data);
      if (!u) throw new NotFoundException('Subscription không tồn tại');
      await repo.createAuditLog({
        action: 'subscription.update',
        entityType: 'subscription',
        entityId: id,
        actor,
        reason: optionalReason(body?.reason),
        metadata: { fields: Object.keys(data) },
      });
      return u;
    });
  }

  /**
   * Xoá subscription (review SPEC-2 #1, ADR-054): 409 nếu còn BẤT KỲ delivery nào tham chiếu — xoá sẽ
   * kéo theo toàn bộ delivery/attempt (kể cả DEAD) và audit trỏ vào hư không. Muốn ngừng gửi: tắt.
   */
  @Delete('subscriptions/:id')
  @RequireScope('manage:endpoints')
  async deleteSubscription(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Query('reason') reason?: string) {
    assertUuid(id, 'Subscription');
    return this.withFkGuard(() =>
      this.withAudit(tenantId, async (repo) => {
        const existing = await repo.findSubscriptionById(id);
        if (!existing) throw new NotFoundException('Subscription không tồn tại');
        const deliveryCount = await repo.countDeliveries({ subscriptionId: id });
        if (deliveryCount > 0) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'SUBSCRIPTION_HAS_DELIVERIES',
            deliveryCount,
            message:
              `Không xoá được subscription: còn ${deliveryCount} delivery tham chiếu (lịch sử gửi, kể cả DEAD, phải được giữ). ` +
              'Hãy tắt subscription (isActive=false) thay vì xoá.',
          });
        }
        await repo.deleteSubscription(id);
        await repo.createAuditLog({
          action: 'subscription.delete',
          entityType: 'subscription',
          entityId: id,
          actor,
          reason: optionalReason(reason),
          metadata: { name: existing.name, destinationId: existing.destinationId },
        });
        return { deleted: true, id };
      }),
    );
  }

  // --- Lưu trữ ("Xoá" trên bản đồ luồng, ADR-161) ---
  /**
   * Lưu trữ source: `archived_at` + `is_active=false` → ingest từ chối y như source tắt (404 `/hooks`, 409
   * `source_inactive` ở `/v1/p`); biến khỏi bản đồ luồng + danh sách console. KHÔNG xoá raw_events/events. Subscription
   * chỉ còn lọc theo source này (không còn nguồn sống nào) được lưu trữ theo — bản đồ không còn cạnh treo.
   * Source đã lưu trữ / không thuộc project → 404. Không hoàn tác qua API (ADR-161).
   */
  @Post('sources/:id/archive')
  @RequireScope('manage:sources')
  async archiveSource(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: string,
    @Param('id') id: string,
    @Body() body: any,
    @Req() req?: RequestWithPrincipal,
  ) {
    assertUuid(id, 'Source');
    // ADR-161 (L1): lưu trữ source có thể lưu trữ/sửa subscription theo -> cần CẢ manage:endpoints (luôn đòi, không tuỳ
    // có cascade hay không: quyền không được phụ thuộc dữ liệu).
    requireAlsoScope(req, 'manage:endpoints');
    return this.withAudit(tenantId, async (repo) => {
      await repo.lockFlowConfig();
      const existing = await repo.findSourceById(id);
      if (!existing || existing.archivedAt) throw new NotFoundException('Source không tồn tại');
      const at = new Date();
      if ((await repo.archiveSource(id, at)) !== 1) throw new NotFoundException('Source không tồn tại');
      const subscriptionIds = await repo.findSubscriptionIdsOrphanedBy({ sourceId: id });
      await repo.archiveSubscriptions(subscriptionIds, at);
      // T4: sub còn sống không giữ id source đã lưu trữ trong bộ lọc nguồn.
      await repo.removeSourceFromSubscriptions(id);
      // ADR-161 (1): source lưu trữ không giữ credentials provider mãi mãi — xoá bản mã hoá + DISCONNECTED cùng tx.
      // (URL đã đăng ký ở provider KHÔNG tự gỡ; hộp thoại gợi ý "Ngắt kết nối provider" trước khi Xoá.)
      const providerConnectionWiped = !!(await repo.updateSourceConnection(id, {
        credentialsEncrypted: null,
        status: 'DISCONNECTED',
        lastError: 'source_archived',
        lastFix: 'Source đã bị xoá khỏi luồng — gỡ URL webhook ở dashboard provider nếu còn.',
      }));
      await repo.createAuditLog({
        action: 'source.archive',
        entityType: 'source',
        entityId: id,
        actor,
        reason: optionalReason(body?.reason),
        metadata: { name: existing.name, provider: existing.provider, archivedSubscriptionIds: subscriptionIds, providerConnectionWiped },
      });
      return { archived: true, id, archivedAt: at, archivedSubscriptionIds: subscriptionIds };
    });
  }

  /**
   * Lưu trữ đích: `archived_at` + `is_active=false`, mọi subscription của đích lưu trữ theo → normalize không tạo
   * delivery mới. Delivery đang PENDING/RETRYING chạy nốt (như khi tắt subscription); deliveries/attempts giữ nguyên
   * (FK RESTRICT, ADR-054) — vì thế đây là lưu trữ, không phải DELETE.
   */
  @Post('destinations/:id/archive')
  @RequireScope('manage:endpoints')
  async archiveDestination(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any) {
    assertUuid(id, 'Destination');
    return this.withAudit(tenantId, async (repo) => {
      await repo.lockFlowConfig();
      const existing = await repo.findDestinationById(id);
      if (!existing || existing.archivedAt) throw new NotFoundException('Destination không tồn tại');
      const at = new Date();
      if ((await repo.archiveDestination(id, at)) !== 1) throw new NotFoundException('Destination không tồn tại');
      const subscriptionIds = await repo.findSubscriptionIdsOrphanedBy({ destinationId: id });
      await repo.archiveSubscriptions(subscriptionIds, at);
      await repo.createAuditLog({
        action: 'destination.archive',
        entityType: 'destination',
        entityId: id,
        actor,
        reason: optionalReason(body?.reason),
        metadata: { name: existing.name, type: existing.type, archivedSubscriptionIds: subscriptionIds },
      });
      return { archived: true, id, archivedAt: at, archivedSubscriptionIds: subscriptionIds };
    });
  }

  /** Lưu trữ subscription: không bao giờ khớp sự kiện mới; deliveries lịch sử giữ nguyên. */
  @Post('subscriptions/:id/archive')
  @RequireScope('manage:endpoints')
  async archiveSubscription(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any) {
    assertUuid(id, 'Subscription');
    return this.withAudit(tenantId, async (repo) => {
      await repo.lockFlowConfig();
      const existing = await repo.findSubscriptionById(id);
      if (!existing || existing.archivedAt) throw new NotFoundException('Subscription không tồn tại');
      const at = new Date();
      if ((await repo.archiveSubscriptions([id], at)) !== 1) throw new NotFoundException('Subscription không tồn tại');
      await repo.createAuditLog({
        action: 'subscription.archive',
        entityType: 'subscription',
        entityId: id,
        actor,
        reason: optionalReason(body?.reason),
        metadata: { name: existing.name, destinationId: existing.destinationId },
      });
      return { archived: true, id, archivedAt: at, archivedSubscriptionIds: [id] };
    });
  }

  // --- Events (hỗ trợ Polling ADR-016 §8.1) ---
  /**
   * S7 (ADR-077, X11): `before=<eventId>` = trang CŨ HƠN (giảm dần theo thời điểm nhận — hành vi dashboard cũ);
   * `after=<seq>` = MỚI HƠN, tăng dần theo events.seq (thứ tự INSERT — KHÁC `cursor` của polling `/v1/p`, ADR-099). `after` không phải số (client
   * cũ gửi id) được hiểu như `before` để không vỡ.
   */
  @Get('events')
  @RequireScope('read:project')
  async listEvents(
    @CurrentTenant() tenantId: string,
    @Query('after') after?: string,
    @Query('limit') limit = '50',
    @Query('before') before?: string,
  ) {
    const repo = this.prisma.forTenant(tenantId);
    const take = Math.min(parseInt(limit, 10) || 50, 100);
    if (after && /^\d{1,18}$/.test(after)) {
      const events = await repo.findEventsAfterSeq(BigInt(after), take);
      return { events, nextCursor: events.length ? events[events.length - 1].seq.toString() : after };
    }
    const events = await repo.findEvents({}, take, before ?? after);
    return { events, nextCursor: events.length === take ? events[events.length - 1].id : null };
  }

  @Get('events/:id')
  @RequireScope('read:project')
  async getEventDetail(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    const repo = this.prisma.forTenant(tenantId);
    const event = await repo.findEventById(id);
    if (!event) throw new NotFoundException('Sự kiện không tồn tại');
    // `bodyRaw` (bytes) serialize thành object một-khoá-mỗi-byte — vừa nặng vừa vô ích cho UI;
    // `body` đã parse nằm ngay cạnh. Bản gốc vẫn ở DB cho việc kiểm chữ ký.
    if (event.rawEvent) {
      const { bodyRaw: _omit, ...rawEvent } = event.rawEvent;
      return { ...event, rawEvent };
    }
    return event;
  }

  // --- Deliveries & DLQ ---
  /**
   * ADR-163: trang Lượt giao — keyset `(created_at, id)`, Trước/Sau bằng `before`/`after` (list-params.ts).
   * Lọc: `status`, `destination` (uuid), `code` (404 | 5xx | none — HTTP lần thử cuối), `from`/`to` (ISO).
   */
  @Get('deliveries')
  @RequireScope('read:project')
  async listDeliveries(@CurrentTenant() tenantId: string, @Query() q: DeliveryListQuery) {
    return listDeliveryPage(this.prisma.forTenant(tenantId), q ?? {}, 'deliveries');
  }

  /** DLQ (DEAD chưa bị replay, ADR-031) — như trên; lọc `destination`, `errorKind`, `from`/`to` (tuổi). */
  @Get('dlq')
  @RequireScope('read:project')
  async listDlq(@CurrentTenant() tenantId: string, @Query() q: DeliveryListQuery) {
    return listDeliveryPage(this.prisma.forTenant(tenantId), q ?? {}, 'dlq');
  }

  // --- Replay Delivery (§5.3 Replay: attempt_generation + 1) ---
  @Post('deliveries/:id/replay')
  @RequireScope('replay:deliveries')
  async replayDelivery(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: string,
    @Param('id') id: string,
    @Body() body: { reason?: unknown } = {},
  ) {
    const repo = this.prisma.forTenant(tenantId);

    // Lookup CÓ SCOPE TENANT (BB-5) — chặn tenant A đọc/replay delivery của tenant B
    // chỉ bằng cách biết UUID (lỗ hổng cross-tenant đã được review phát hiện).
    const delivery = UUID_RE.test(id) ? await repo.findDeliveryById(id) : null;
    if (!delivery) {
      throw new NotFoundException('Delivery không tồn tại');
    }

    // Chỉ replay bản đã DEAD: replay một delivery còn RETRYING/DELIVERING sẽ chạy song song với
    // lượt retry đang xếp hàng → đích nhận hai lần. SUCCEEDED thì không có gì để "cứu".
    if (delivery.status !== 'DEAD') {
      throw new ConflictException(`Chỉ replay được delivery DEAD (hiện tại: ${delivery.status})`);
    }
    // QT:T20 (ADR-184): event đã "Dọn" chỉ còn dòng gầy (data = null) — replay sẽ gửi rỗng. Nói thật thay vì gửi.
    if ((delivery.event as { trimmedAt?: Date | null } | undefined)?.trimmedAt) {
      throw hubError('event_trimmed', {}, 'Nội dung event đã được dọn — không replay được');
    }
    // ADR-161 (T3): đích / subscription đã lưu trữ hoặc đích đang "Ngắt" -> replay không có nơi nhận.
    const dst = delivery.subscription?.destination as { id: string; isActive?: boolean; archivedAt?: Date | null } | undefined;
    if (delivery.subscription?.archivedAt || dst?.archivedAt) {
      throw hubError('destination_archived', { field: 'destinationId' }, 'Đích (hoặc subscription) của delivery này đã bị xoá khỏi luồng — không replay được');
    }
    if (dst && dst.isActive === false) {
      throw hubError('destination_inactive', { field: 'destinationId' }, 'Đích đang Ngắt — kết nối lại đích rồi replay');
    }
    // ADR-163: subscription đang tắt cũng không nhận — cùng điều kiện `replayableOnly` của replay hàng loạt.
    if ((delivery.subscription as { isActive?: boolean } | undefined)?.isActive === false) {
      throw hubError('subscription_inactive', { field: 'subscriptionId' }, 'Subscription đang tắt — bật lại subscription rồi replay');
    }

    // Chỉ replay bản MỚI NHẤT: bản đã bị replay rồi (có generation cao hơn) mà replay tiếp
    // sẽ tạo trùng generation → vi phạm unique. Trả 409 rõ ràng thay vì 500.
    if (await repo.hasNewerGeneration(delivery)) {
      throw new ConflictException('Delivery này đã được replay — hãy replay bản generation mới nhất');
    }
    const newGen = delivery.attemptGeneration + 1;
    const replayedId = randomUUID();

    // S1-1: message chỉ mang tham chiếu — KHÔNG giải mã cấu hình đích ở đây, KHÔNG ghi secret vào
    // hub.outbox. Worker nạp + giải mã cấu hình lúc gửi.
    const deliveryMsg = buildDeliveryMessage({
      deliveryId: replayedId,
      tenantId,
      attemptGeneration: newGen,
      attemptCount: 0,
      correlationId: delivery.event.correlationId,
    });

    // Delivery mới + outbox trong CÙNG một transaction (outbox pattern): hoặc cả hai cùng
    // COMMIT, hoặc không có gì — không bao giờ có delivery PENDING mà worker không biết tới.
    // Outbox không mang tenant_id (hạ tầng xuyên-tenant) nên dùng `tx.outbox` trực tiếp là đúng thiết kế.
    try {
      await this.prisma.tenantTx(tenantId, async (tx) => {
        await this.prisma.forTenant(tenantId, tx).createDelivery({
          id: replayedId,
          eventId: delivery.eventId,
          subscriptionId: delivery.subscriptionId,
          attemptGeneration: newGen,
          status: 'PENDING',
          attemptCount: 0,
        });
        await tx.outbox.create({
          data: { topic: 'delivery.replayed', payload: deliveryMsg as unknown as Prisma.InputJsonValue },
        });
        // S2-3: audit CÙNG transaction — có replay thì chắc chắn có dấu vết, và ngược lại.
        await this.prisma.forTenant(tenantId, tx).createAuditLog({
          action: 'delivery.replay',
          entityType: 'delivery',
          entityId: delivery.id,
          actor,
          reason: optionalReason(body?.reason),
          metadata: { newDeliveryId: replayedId, generation: newGen },
        });
      });
    } catch (e) {
      // Hai admin bấm Replay cùng lúc: request thứ hai đụng unique (event, subscription, generation).
      if ((e as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException('Delivery này vừa được replay bởi một yêu cầu khác');
      }
      throw e;
    }

    return { success: true, newDeliveryId: replayedId, generation: newGen };
  }

  /**
   * Replay hàng loạt (S2-3, ADR-050). Tập chọn = ĐÚNG điều kiện DLQ (ADR-031: DEAD, generation mới
   * nhất, chưa bị replay) + bộ lọc, tối đa 500. `dryRun` chỉ đọc. Chạy thật: N delivery + N outbox
   * `delivery.replayed` (message gọn S1-1) + MỘT audit trong MỘT transaction.
   */
  @Post('deliveries/replay-bulk')
  @RequireScope('replay:deliveries')
  async replayBulk(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any) {
    // Review SPEC-2 #2 (ADR-054): `dryRun` BẮT BUỘC là boolean JSON. Chuỗi "true" từng bị coi là
    // "không phải true" -> chạy thật. Thiếu cũng 400: thao tác ghi hàng loạt phải nói rõ ý định.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Body phải là object JSON');
    if (typeof body.dryRun !== 'boolean') {
      throw new BadRequestException('dryRun bắt buộc và phải là boolean (true = chỉ xem trước, false = chạy thật)');
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < REASON_MIN) throw new BadRequestException(`Cần lý do (reason) ít nhất ${REASON_MIN} ký tự`);
    const FILTER_FIELDS = ['destinationId', 'from', 'to', 'errorContains', 'errorKind'] as const;
    const given = (k: string) => body[k] !== undefined && body[k] !== null && body[k] !== '';
    // ADR-163 (TB2): chạy thật = đúng `ids` đã xem trước; bộ lọc gửi kèm sẽ bị bỏ qua -> 400 thay vì nhận rồi lờ đi.
    if (!body.dryRun) {
      const extra = FILTER_FIELDS.find(given);
      if (extra) throw badParam(extra, 'Chạy thật (dryRun: false) chỉ nhận ids của bản xem trước — bộ lọc chỉ dùng khi xem trước');
    }
    // Cùng bộ kiểm với các trang danh sách (list-params.ts): 400 bad_request + field.
    const range = parseTimeRange(body.from, body.to);
    const filter: DeadDeliveryFilter = {
      destinationId: parseUuidParam(body.destinationId ?? undefined, 'destinationId'),
      from: range.from,
      to: range.to,
      errorContains: parseTextParam(body.errorContains ?? undefined, 'errorContains', 200),
      // ADR-163: CÙNG bộ lọc "loại lỗi" với bảng DLQ — trang DLQ gửi đúng bộ lọc đang xem, xem trước đếm đúng tập đó.
      errorKind: parseEnumParam(body.errorKind ?? undefined, 'errorKind', DLQ_ERROR_KINDS) as DlqErrorKind | undefined,
    };
    // ADR-163 (M1): chạy thật BẮT BUỘC gửi `ids` = đúng tập đã xem trước (≤ 500) — không chọn lại theo bộ lọc lúc
    // bấm (DLQ có thể đã đổi giữa xem trước và xác nhận). Xem trước thì không nhận `ids`.
    let ids: string[] | undefined;
    if (!body.dryRun) {
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > REPLAY_BULK_LIMIT) {
        throw hubError('bad_request', { field: 'ids' }, `ids bắt buộc khi chạy thật: mảng 1–${REPLAY_BULK_LIMIT} id lấy từ bản xem trước`);
      }
      if (!body.ids.every((i: unknown) => typeof i === 'string' && UUID_RE.test(i))) {
        throw hubError('bad_request', { field: 'ids' }, 'ids phải là mảng UUID');
      }
      ids = [...new Set((body.ids as string[]).map((i) => i.toLowerCase()))];
    } else if (body.ids !== undefined) {
      throw hubError('bad_request', { field: 'ids' }, 'Xem trước (dryRun: true) chọn theo bộ lọc — không nhận ids');
    }
    // ADR-161 (T3): chỉ delivery còn nơi nhận — cùng điều kiện cho xem trước và chạy thật.
    filter.replayableOnly = true;
    if (body.dryRun) {
      // Lấy 501 để biết CHẮC có bị cắt không (đúng 500 dòng thì không "chạm trần").
      const found = await this.prisma.forTenant(tenantId).findDeadDeliveryRefs(filter, REPLAY_BULK_LIMIT + 1);
      const refs = found.slice(0, REPLAY_BULK_LIMIT);
      return {
        dryRun: true,
        count: refs.length,
        limit: REPLAY_BULK_LIMIT,
        truncated: found.length > REPLAY_BULK_LIMIT,
        sample: refs.slice(0, REPLAY_BULK_SAMPLE),
        // ADR-163 (M1): client gửi lại đúng danh sách này khi xác nhận.
        ids: refs.map((r) => r.id),
      };
    }

    // Review SPEC-2 #9: entityId là id THẬT của lô (UUID, trả về cho client); danh sách id ở metadata.
    const batchId = randomUUID();
    let refs: Awaited<ReturnType<TenantScopedRepository['findDeadDeliveryRefs']>> = [];
    let items: { deliveryId: string; newDeliveryId: string; generation: number }[] = [];
    let skipped: { id: string; reason: string }[] = [];
    try {
      await this.prisma.tenantTx(
        tenantId,
        async (tx) => {
          const repo = this.prisma.forTenant(tenantId, tx);
          // Khoá cấu hình luồng (ADR-161) rồi KIỂM LẠI từng id trong CÙNG transaction: còn DEAD, chưa bị replay, đúng
          // tenant, subscription/đích chưa lưu trữ và đích đang bật (replayableOnly — dùng chung với xem trước).
          await repo.lockFlowConfig();
          refs = await repo.findDeadDeliveryRefs({ ids, replayableOnly: true }, REPLAY_BULK_LIMIT);
          const kept = new Set(refs.map((r) => r.id));
          skipped = await repo.findReplaySkipReasons((ids ?? []).filter((i) => !kept.has(i)));
          items = refs.map((r) => ({ deliveryId: r.id, newDeliveryId: randomUUID(), generation: r.attemptGeneration + 1 }));
          // Thấp 3: mọi id đều bị bỏ qua -> không ghi delivery/outbox nhưng VẪN ghi audit (requested, skipped, count 0).
          if (refs.length > 0) {
            await repo.createDeliveries(
              refs.map((r, i) => ({
                id: items[i].newDeliveryId,
                eventId: r.eventId,
                subscriptionId: r.subscriptionId,
                attemptGeneration: items[i].generation,
                status: 'PENDING' as const,
                attemptCount: 0,
              })),
            );
            await tx.outbox.createMany({
              data: refs.map((r, i) => ({
                topic: 'delivery.replayed',
                payload: buildDeliveryMessage({
                  deliveryId: items[i].newDeliveryId,
                  tenantId,
                  attemptGeneration: items[i].generation,
                  attemptCount: 0,
                  correlationId: r.correlationId,
                }) as unknown as Prisma.InputJsonValue,
              })),
            });
          }
          await repo.createAuditLog({
            action: 'delivery.replay_bulk',
            entityType: 'delivery_batch',
            entityId: batchId,
            actor,
            reason,
            // TB2: chạy thật không có bộ lọc (chỉ ids) — audit ghi đúng những gì đã yêu cầu/làm/bỏ qua.
            metadata: {
              count: refs.length,
              deliveryIds: refs.map((r) => r.id),
              newDeliveryIds: items.map((i) => i.newDeliveryId),
              requested: ids?.length ?? 0,
              skipped,
            },
          });
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      // Hai lượt bulk (hoặc bulk + replay đơn) chồng nhau: unique (event, subscription, generation) -> rollback cả lô.
      if ((e as { code?: unknown })?.code === 'P2002') {
        throw new ConflictException('Một số delivery vừa được replay bởi yêu cầu khác — không có gì được ghi, hãy thử lại');
      }
      throw e;
    }
    const skippedByReason: Record<string, number> = {};
    for (const k of skipped) skippedByReason[k.reason] = (skippedByReason[k.reason] ?? 0) + 1;
    return {
      dryRun: false,
      count: refs.length,
      batchId,
      items,
      // ADR-163 (M1): id đã xem trước nhưng KHÔNG replay — vì sao (not_found | not_dead | already_replayed | destination_unavailable).
      skipped: { count: skipped.length, byReason: skippedByReason, items: skipped },
    };
  }

  // --- Audit log (S2-3) ---
  /** ADR-163: keyset `(created_at, id)`, Trước/Sau `before`/`after`; lọc `actor`, `action` (tiền tố), `entityType`, `from`/`to`. */
  @Get('audit-logs')
  @RequireScope('read:project')
  async listAuditLogs(@CurrentTenant() tenantId: string, @Query() q: AuditListQuery) {
    return listAuditPage(this.prisma.forTenant(tenantId), q ?? {});
  }

  /** Giá trị gợi ý cho bộ lọc Nhật ký thao tác (hành động / loại đối tượng / người làm đã có). */
  @Get('audit-logs/facets')
  @RequireScope('read:project')
  async auditFacets(@CurrentTenant() tenantId: string) {
    return this.prisma.forTenant(tenantId).findAuditFacets();
  }

  /** Mọi hành động có audit: hành động + audit_logs trong CÙNG một transaction. */
  private withAudit<T>(tenantId: string, fn: (repo: TenantScopedRepository) => Promise<T>): Promise<T> {
    return this.prisma.tenantTx(tenantId, (tx) => fn(this.prisma.forTenant(tenantId, tx)));
  }

  /**
   * Race: delivery/subscription mới chen vào giữa bước đếm và DELETE -> FK RESTRICT (ADR-054) chặn ở DB
   * (Prisma P2003). Trả 409 thay vì 500 — dữ liệu vẫn nguyên vì transaction đã rollback.
   */
  private async withFkGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: unknown })?.code === 'P2003') {
        throw new ConflictException('Không xoá được: vẫn còn dữ liệu tham chiếu (vừa phát sinh). Hãy tắt (isActive=false) thay vì xoá.');
      }
      throw e;
    }
  }

  // --- Raw event mồ côi (S1-3): phát lại từ Postgres, KHÔNG đọc DLQ của RabbitMQ ---
  // Postgres là trọng tài (BB-2): raw_event ACCEPTED mà không sinh event nào = sự kiện chưa được
  // chuẩn hoá, bất kể bản sao trong q.normalize.dlq còn hay đã mất.
  @Get('raw-events/orphans')
  @RequireScope('read:project')
  async listOrphanRawEvents(@CurrentTenant() tenantId: string) {
    return this.prisma.forTenant(tenantId).findOrphanRawEvents({ limit: ORPHAN_LIST_LIMIT });
  }

  @Post('raw-events/renormalize')
  @RequireScope('replay:deliveries')
  async renormalizeRawEvents(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: string,
    @Body() body: { ids?: unknown; reason?: unknown },
  ) {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason) throw new BadRequestException('Cần nhập lý do (reason)');
    let ids: string[] | undefined;
    if (body?.ids !== undefined) {
      if (!Array.isArray(body.ids) || !body.ids.every((i) => typeof i === 'string' && UUID_RE.test(i))) {
        throw new BadRequestException('ids phải là mảng UUID');
      }
      ids = body.ids as string[];
    }

    // Lọc lại Ở SERVER (scope tenant): id gửi lên mà không còn mồ côi / thuộc tenant khác thì bỏ qua.
    const { items } = await this.prisma.forTenant(tenantId).findOrphanRawEvents({ limit: RENORMALIZE_LIMIT, ids });
    if (items.length === 0) return { queued: 0, rawEventIds: [] };

    await this.prisma.tenantTx(tenantId, async (tx) => {
      // Payload giống hệt chặng ingest -> normalize xử lý như lần đầu. processed_messages không chặn
      // vì lần lỗi trước đã rollback cả transaction (nên mới mồ côi).
      for (const r of items) {
        const payload: OutboxPayload = {
          rawEventId: r.id,
          sourceId: r.sourceId,
          tenantId,
          provider: r.provider as ProviderType,
          correlationId: generateCorrelationId(),
        };
        await tx.outbox.create({ data: { topic: 'event.received', payload: payload as unknown as Prisma.InputJsonValue } });
      }
      // Audit cùng transaction (S2-3) — cùng helper `createAuditLog` với replay/replay hàng loạt.
      await this.prisma.forTenant(tenantId, tx).createAuditLog({
        action: 'raw_event.renormalize',
        entityType: items.length === 1 ? 'raw_event' : 'raw_event_batch',
        entityId: items.length === 1 ? items[0].id : randomUUID(),
        actor,
        reason,
        metadata: { count: items.length, rawEventIds: items.map((r) => r.id) },
      });
    });

    return { queued: items.length, rawEventIds: items.map((r) => r.id) };
  }
}
