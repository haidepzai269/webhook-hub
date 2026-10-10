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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PrismaService, TenantScopedRepository, getMasterKey, DeadDeliveryFilter } from '@hub/database';
import { aesGcmEncrypt } from '@hub/crypto';
import { buildDeliveryMessage, generateCorrelationId, isValidEventPattern, OutboxPayload, ProviderType } from '@hub/common';
import { Prisma } from '@prisma/client';
import { ulid } from 'ulidx';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { RedactSecretsInterceptor } from './redact-secrets.interceptor';
import { ProjectScopeGuard } from '../console/project-scope.guard';
import { resolveSourceIds } from '../service-api/service-resources.controller';

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

/** Body JSON (replay hàng loạt): thời điểm phải là CHUỖI ISO 8601 có ngày — số/epoch/object -> 400. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function parseIsoDate(v: unknown, name: string): Date | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v.trim())) {
    throw new BadRequestException(`${name} phải là chuỗi thời điểm ISO 8601 (vd 2026-10-10T00:00:00Z)`);
  }
  const d = new Date(v.trim());
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} không phải thời điểm hợp lệ (ISO 8601)`);
  return d;
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

function assertUuid(id: string, what: string) {
  if (!UUID_RE.test(id)) throw new NotFoundException(`${what} không tồn tại`);
}

/**
 * Toàn bộ `/api/v1/*` (dashboard) BẮT BUỘC JWT (JwtAuthGuard) — tenantId LUÔN lấy
 * từ token đã verify (`@CurrentTenant()`), KHÔNG BAO GIỜ từ header client tự gửi
 * như `x-tenant-id` trước đây. Mọi truy vấn 5 bảng nghiệp vụ (source, destination,
 * subscription, event, delivery) đi qua `TenantScopedRepository` (BB-5) — không gọi
 * thẳng `this.prisma.<model>` vì `PrismaService` không còn expose các model đó.
 * Response đi qua `RedactSecretsInterceptor` — không bao giờ trả ciphertext `*Encrypted`.
 */
@Controller('api/v1')
// S2 (X2): `?projectId=` đọc ở MỘT chỗ — ProjectScopeGuard chạy sau JWT, đổi request.tenantId.
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
@UseInterceptors(RedactSecretsInterceptor)
export class ApiController {
  constructor(private readonly prisma: PrismaService) {}

  // --- Overview ---
  @Get('overview')
  async getOverview(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    const [totalSources, totalDestinations, totalEvents, totalDeliveries, deadDeliveries] = await Promise.all([
      repo.countSources(),
      repo.countDestinations(),
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
  async getTimeseries(@CurrentTenant() tenantId: string, @Query('range') range = '24h') {
    if (range !== '24h' && range !== '7d') {
      throw new BadRequestException("range phải là '24h' hoặc '7d'");
    }
    return this.prisma.forTenant(tenantId).getTimeseries(range);
  }

  // --- Sources ---
  // Không trả `secrets` (ciphertext) ra trình duyệt — dashboard chỉ cần biết có bao nhiêu version.
  @Get('sources')
  async listSources(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    const sources = await repo.findSources();
    return sources.map(({ secrets, ...s }) => ({
      ...s,
      secretVersions: secrets.length,
      webhookUrl: `/hooks/${s.provider}/${s.sourceKey}`,
    }));
  }

  @Post('sources')
  async createSource(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any) {
    const masterKey = getMasterKey();
    const sourceKey = body.sourceKey || `src_${body.provider}_${ulid().toLowerCase()}`;

    const source = await this.withAudit(tenantId, async (repo) => {
      const created = await repo.createSource({
        provider: body.provider,
        name: body.name,
        sourceKey,
        isActive: true,
        secrets: {
          create: {
            secretEncrypted: aesGcmEncrypt(body.secret, masterKey),
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
  async updateSource(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any) {
    assertUuid(id, 'Source');
    const data: { name?: string; isActive?: boolean } = {};
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (typeof body?.isActive === 'boolean') data.isActive = body.isActive;
    if (Object.keys(data).length === 0) throw new BadRequestException('Không có trường nào để sửa (name, isActive)');
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
  async listDestinations(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    return repo.findDestinations();
  }

  @Post('destinations')
  async createDestination(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any) {
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
      return created;
    });
  }

  /**
   * Sửa đích (S2-3; cũng là cách kiểm S2-1: trỏ đích /mock/fail sang /mock/discord). Config/secret
   * được mã hoá lại; audit chỉ ghi TÊN trường đã đổi, không ghi giá trị.
   */
  @Patch('destinations/:id')
  async updateDestination(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any) {
    assertUuid(id, 'Destination');
    const masterKey = getMasterKey();
    const data: Record<string, unknown> = {};
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim();
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
    if (changed.length === 0) throw new BadRequestException('Không có trường nào để sửa (name, config, signingSecret, rateLimitRps)');
    return this.withAudit(tenantId, async (repo) => {
      const u = await repo.updateDestination(id, data);
      if (!u) throw new NotFoundException('Destination không tồn tại');
      await repo.createAuditLog({
        action: 'destination.update',
        entityType: 'destination',
        entityId: id,
        actor,
        reason: optionalReason(body?.reason),
        metadata: { fields: changed },
      });
      return u;
    });
  }

  /**
   * Xoá đích (review SPEC-2 #1, ADR-054): CHỈ khi không còn subscription nào trỏ vào. Lịch sử gửi
   * (deliveries/attempts, kể cả DEAD) là bằng chứng — không bao giờ mất theo một cú xoá cấu hình.
   * DB cũng chặn (FK RESTRICT); 409 ở đây chỉ để nói rõ lý do + con số.
   */
  @Delete('destinations/:id')
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
  async listSubscriptions(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    return repo.findSubscriptions();
  }

  @Post('subscriptions')
  async createSubscription(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any) {
    const repo = this.prisma.forTenant(tenantId);
    // S1-5 (BB-5): đích phải thuộc CÙNG tenant. Trả 404 (không phải 403) để không lộ việc
    // destinationId đó có tồn tại ở tenant khác hay không.
    const destination =
      typeof body?.destinationId === 'string' && UUID_RE.test(body.destinationId)
        ? await repo.findDestinationById(body.destinationId)
        : null;
    if (!destination) throw new NotFoundException('Destination không tồn tại');
    const eventTypes = parseEventTypes(body?.eventTypes);
    // S5: lọc nguồn — id lạ / của project khác -> 422 unknown_source (cùng hàm với /v1/p)
    const sourceIds = await resolveSourceIds(repo, body?.sourceIds);
    return this.withAudit(tenantId, async (txRepo) => {
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
  async updateSubscription(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Param('id') id: string, @Body() body: any) {
    assertUuid(id, 'Subscription');
    const data: Record<string, unknown> = {};
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (typeof body?.isActive === 'boolean') data.isActive = body.isActive;
    if (body?.template !== undefined) data.template = body.template === null ? null : String(body.template);
    if (body?.eventTypes !== undefined) data.eventTypes = parseEventTypes(body.eventTypes);
    if (body?.sourceIds !== undefined) data.sourceIds = await resolveSourceIds(this.prisma.forTenant(tenantId), body.sourceIds);
    if (Object.keys(data).length === 0) throw new BadRequestException('Không có trường nào để sửa (name, isActive, template, eventTypes, sourceIds)');
    return this.withAudit(tenantId, async (repo) => {
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

  // --- Events (hỗ trợ Polling ADR-016 §8.1) ---
  @Get('events')
  async listEvents(@CurrentTenant() tenantId: string, @Query('after') after?: string, @Query('limit') limit = '50') {
    const repo = this.prisma.forTenant(tenantId);
    const take = Math.min(parseInt(limit, 10) || 50, 100);
    const events = await repo.findEvents({}, take, after);

    const nextCursor = events.length === take ? events[events.length - 1].id : null;
    return {
      events,
      nextCursor,
    };
  }

  @Get('events/:id')
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
  @Get('deliveries')
  async listDeliveries(@CurrentTenant() tenantId: string, @Query('status') status?: string) {
    const repo = this.prisma.forTenant(tenantId);
    const where = status ? { status: status as any } : {};
    return repo.findDeliveries(where, 50);
  }

  @Get('dlq')
  async listDlq(@CurrentTenant() tenantId: string) {
    const repo = this.prisma.forTenant(tenantId);
    return repo.findDeadDeliveries(50);
  }

  // --- Replay Delivery (§5.3 Replay: attempt_generation + 1) ---
  @Post('deliveries/:id/replay')
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
      await this.prisma.$transaction(async (tx) => {
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
  async replayBulk(@CurrentTenant() tenantId: string, @CurrentUser() actor: string, @Body() body: any) {
    // Review SPEC-2 #2 (ADR-054): `dryRun` BẮT BUỘC là boolean JSON. Chuỗi "true" từng bị coi là
    // "không phải true" -> chạy thật. Thiếu cũng 400: thao tác ghi hàng loạt phải nói rõ ý định.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Body phải là object JSON');
    if (typeof body.dryRun !== 'boolean') {
      throw new BadRequestException('dryRun bắt buộc và phải là boolean (true = chỉ xem trước, false = chạy thật)');
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < REASON_MIN) throw new BadRequestException(`Cần lý do (reason) ít nhất ${REASON_MIN} ký tự`);
    const filter: DeadDeliveryFilter = {};
    if (body?.destinationId !== undefined && body.destinationId !== '' && body.destinationId !== null) {
      if (typeof body.destinationId !== 'string' || !UUID_RE.test(body.destinationId)) {
        throw new BadRequestException('destinationId phải là UUID');
      }
      filter.destinationId = body.destinationId;
    }
    filter.from = parseIsoDate(body.from, 'from');
    filter.to = parseIsoDate(body.to, 'to');
    if (filter.from && filter.to && filter.from > filter.to) throw new BadRequestException('from phải ≤ to');
    if (body.errorContains !== undefined && body.errorContains !== null && typeof body.errorContains !== 'string') {
      throw new BadRequestException('errorContains phải là chuỗi');
    }
    if (typeof body.errorContains === 'string' && body.errorContains.trim()) {
      filter.errorContains = body.errorContains.trim().slice(0, 200);
    }
    const filterForAudit = {
      destinationId: filter.destinationId ?? null,
      from: filter.from?.toISOString() ?? null,
      to: filter.to?.toISOString() ?? null,
      errorContains: filter.errorContains ?? null,
    };

    const refs = await this.prisma.forTenant(tenantId).findDeadDeliveryRefs(filter, REPLAY_BULK_LIMIT);
    if (body.dryRun) {
      return {
        dryRun: true,
        count: refs.length,
        limit: REPLAY_BULK_LIMIT,
        truncated: refs.length >= REPLAY_BULK_LIMIT,
        sample: refs.slice(0, REPLAY_BULK_SAMPLE),
      };
    }
    if (refs.length === 0) return { dryRun: false, count: 0, items: [] };

    const items = refs.map((r) => ({ deliveryId: r.id, newDeliveryId: randomUUID(), generation: r.attemptGeneration + 1 }));
    // Review SPEC-2 #9: entityId là id THẬT của lô (UUID, trả về cho client); danh sách id ở metadata.
    const batchId = randomUUID();
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const repo = this.prisma.forTenant(tenantId, tx);
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
          await repo.createAuditLog({
            action: 'delivery.replay_bulk',
            entityType: 'delivery_batch',
            entityId: batchId,
            actor,
            reason,
            metadata: {
              filter: filterForAudit,
              count: refs.length,
              deliveryIds: refs.map((r) => r.id),
              newDeliveryIds: items.map((i) => i.newDeliveryId),
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
    return { dryRun: false, count: refs.length, batchId, items };
  }

  // --- Audit log (S2-3) ---
  @Get('audit-logs')
  async listAuditLogs(@CurrentTenant() tenantId: string, @Query('limit') limit = '50', @Query('before') before?: string) {
    const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    let beforeId: bigint | undefined;
    if (before) {
      if (!/^\d{1,19}$/.test(before)) throw new BadRequestException('before phải là id số');
      beforeId = BigInt(before);
    }
    const rows = await this.prisma.forTenant(tenantId).findAuditLogs({ limit: take, before: beforeId });
    // id là BIGINT -> chuỗi (JSON không có bigint).
    const items = rows.map((r) => ({ ...r, id: r.id.toString() }));
    return { items, nextBefore: rows.length === take ? items[items.length - 1].id : null };
  }

  /** Mọi hành động có audit: hành động + audit_logs trong CÙNG một transaction. */
  private withAudit<T>(tenantId: string, fn: (repo: TenantScopedRepository) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(this.prisma.forTenant(tenantId, tx)));
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
  async listOrphanRawEvents(@CurrentTenant() tenantId: string) {
    return this.prisma.forTenant(tenantId).findOrphanRawEvents({ limit: ORPHAN_LIST_LIMIT });
  }

  @Post('raw-events/renormalize')
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

    await this.prisma.$transaction(async (tx) => {
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
