import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { aesGcmEncrypt, generateWhsecSecret } from '@hub/crypto';
import { SAMPLE_TYPES, catalogCoversPattern } from '@hub/common';
import { SessionGuard } from '../auth/session.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { RedactSecretsInterceptor } from '../api/redact-secrets.interceptor';
import { ProjectScopeGuard } from './project-scope.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { EndpointVerifier } from '../service-api/endpoint-verifier';
import { EndpointService, endpointUrl, parseEndpointUrl, parseGivenSecret, publicEndpoint, withFix } from '../service-api/endpoint.service';
import { WindowLimiter, parseEventTypes422, publicSubscription } from '../service-api/service-resources.controller';
import { unprocessable } from '../service-api/service-api.controller';
import { hubError } from '../errors/hub-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Một câu cho "không tồn tại" lẫn "của project khác" (A2 cô lập) — body giống hệt từng byte. */
const notFound = (what: 'Endpoint' | 'Source') => hubError('not_found', {}, `${what} không tồn tại`);

/** KN1 §3.1: mẫu đúng ngữ pháp (422) VÀ khớp catalog ở `payment.*`/`repo.*` (`payment.recieved` gõ sai -> 422). */
export function parseConsoleEventTypes(v: unknown): string[] {
  const types = parseEventTypes422(v);
  const off = types.filter((t) => !catalogCoversPattern(t));
  if (off.length > 0) {
    unprocessable({ error: 'validation_failed', field: 'eventTypes', invalid: off.slice(0, 5), message: 'Kiểu không có trong catalog (docs/EVENT-CATALOG.md)' });
  }
  return types;
}

/**
 * `sourceIds` của console: id sai khuôn / không tồn tại / thuộc project khác -> 404 GIỐNG HỆT (KN:U3). Gọi BÊN TRONG
 * transaction tạo endpoint: lỗi ở đây rollback cả endpoint (KN:U2, không endpoint mồ côi).
 */
async function ownSourceIds(repo: TenantScopedRepository, v: unknown): Promise<string[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) {
    unprocessable({ error: 'validation_failed', field: 'sourceIds', message: 'sourceIds là mảng ≤ 50 id source' });
  }
  const ids = [...new Set(v as string[])];
  if (ids.some((id) => !UUID_RE.test(id))) throw notFound('Source');
  if ((await repo.findForeignSourceIds(ids)).length > 0) throw notFound('Source');
  return ids;
}

/**
 * KN1 (SPEC-ket-noi §3, ADR-138): console tạo endpoint như API service — hub sinh `whsec_` (trả MỘT lần), challenge,
 * và tạo subscription CÙNG transaction với endpoint. Lõi dùng chung `EndpointService` (không chép code). Console KHÔNG
 * adopt (ADR-098/101 chỉ cho service). Guard/interceptor y hệt `ApiController`; actor = `user:<id>`.
 * Tách controller riêng (như FlowModule) để không đụng `ApiController`.
 */
@Controller('api/v1')
@UseGuards(SessionGuard, ProjectScopeGuard)
@UseInterceptors(RedactSecretsInterceptor)
export class ConsoleEndpointsController {
  private readonly endpoints: EndpointService;
  /** MS-R1: cùng trần 5 lần /verify / phút / endpoint như API service (WindowLimiter, 0 lệnh Redis). */
  private readonly verifyLimiter = new WindowLimiter(5, 60_000);

  constructor(
    private readonly prisma: PrismaService,
    verifier: EndpointVerifier,
  ) {
    this.endpoints = new EndpointService(prisma, verifier);
  }

  /**
   * Body `{ name, url, eventTypes[], sourceIds[]?, signingSecret? }`. Luôn 201 kể cả challenge FAILED (endpoint tồn tại,
   * chưa nhận sự kiện). `signingSecret` CHỈ có khi hub sinh — lần duy nhất secret rời khỏi hub.
   */
  @Post('endpoints')
  @RequireScope('manage:endpoints')
  async create(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Body() body: any) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) unprocessable({ error: 'validation_failed', field: 'name', message: 'name là chuỗi 1–255 ký tự' });
    const url = parseEndpointUrl(body?.url);
    const eventTypes = parseConsoleEventTypes(body?.eventTypes);
    const given = parseGivenSecret(body?.signingSecret);
    const actor = `user:${userId}`;
    const r = await this.endpoints.create(tenantId, { name, url, signingSecret: given, createdByKeyId: null }, actor, async (repo, d) => {
      const sourceIds = await ownSourceIds(repo, body?.sourceIds);
      const s = await repo.createSubscription({ destinationId: d.id, name, eventTypes, sourceIds, isActive: true });
      await repo.createAuditLog({ action: 'subscription.create', entityType: 'subscription', entityId: s.id, actor, metadata: { name, destinationId: d.id, eventTypes, sourceIds } });
      return s;
    });
    return {
      endpoint: publicEndpoint(r.destination, url),
      subscription: publicSubscription(r.extra),
      ...withFix(r.outcome),
      ...(r.generatedSecret ? { signingSecret: r.generatedSecret } : {}),
    };
  }

  /** UI tick event type từ catalog (một nguồn: libs/common/src/canonical) — wildcard trước, rồi kiểu cụ thể. */
  @Get('catalog/event-types')
  @RequireScope('read:project')
  eventTypes() {
    return { wildcards: ['payment.*', 'repo.*'], types: [...SAMPLE_TYPES] };
  }

  /** Trang chi tiết: endpoint (không secret) + subscription + delivery gần đây. */
  @Get('endpoints/:id')
  @RequireScope('read:project')
  async detail(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    const repo = this.prisma.forTenant(tenantId);
    const d = await this.findWebhook(repo, id);
    const [subscriptions, deliveries] = await Promise.all([
      repo.findSubscriptions({ destinationId: d.id }),
      repo.findDeliveries({ subscription: { destinationId: d.id } }, 20),
    ]);
    return {
      endpoint: { ...publicEndpoint(d, endpointUrl(d.configEncrypted)), managedBy: d.createdByKeyId ? 'service' : 'console' },
      subscriptions: subscriptions.map(publicSubscription),
      deliveries: deliveries.map((x: any) => ({
        id: x.id,
        status: x.status,
        attemptCount: x.attemptCount,
        eventId: x.eventId,
        eventType: x.event?.type ?? null,
        lastError: x.lastError ?? null,
        createdAt: x.createdAt,
      })),
    };
  }

  /** Chạy lại challenge bằng secret đang lưu. Endpoint của project khác / không phải webhook -> 404 giống hệt. */
  @Post('endpoints/:id/verify')
  @HttpCode(200)
  @RequireScope('manage:endpoints')
  async verify(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Param('id') id: string) {
    const d = await this.findWebhook(this.prisma.forTenant(tenantId), id);
    if (!this.verifyLimiter.tryAcquire(d.id)) {
      throw new HttpException({ error: 'rate_limited', message: 'Tối đa 5 lần /verify mỗi phút cho một endpoint' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return withFix(await this.endpoints.reverify(tenantId, d, `user:${userId}`));
  }

  /**
   * Sinh `whsec_` mới, trả MỘT lần. Không challenge lại (service chưa biết secret mới — challenge chắc chắn FAILED và
   * normalize sẽ bỏ qua endpoint); trạng thái verification giữ nguyên. Không có thời gian chồng (KN1b, tuỳ chọn):
   * delivery giữa lúc xoay và lúc service cập nhật env sẽ bị service từ chối -> retry/DLQ, replay được.
   * Endpoint do service (API key) quản -> 409 `endpoint_owned_by_service` (service xoay qua /v1/p, SDK ensure()).
   */
  @Post('endpoints/:id/rotate-secret')
  @HttpCode(200)
  @RequireScope('manage:endpoints')
  async rotateSecret(@CurrentTenant() tenantId: string, @CurrentUser() userId: string, @Param('id') id: string) {
    const d = await this.findWebhook(this.prisma.forTenant(tenantId), id);
    if (d.createdByKeyId) throw hubError('endpoint_owned_by_service', {}, 'Endpoint này do service (API key) quản — xoay secret từ phía service');
    const signingSecret = generateWhsecSecret();
    const updated = await this.endpoints.withAudit(tenantId, async (repo) => {
      const u = await repo.updateDestination(d.id, { signingSecretEncrypted: aesGcmEncrypt(signingSecret, getMasterKey()) });
      await repo.createAuditLog({ action: 'endpoint.secret_rotated', entityType: 'destination', entityId: d.id, actor: `user:${userId}`, metadata: { fields: ['signingSecret'] } });
      return u;
    });
    return { endpoint: publicEndpoint(updated ?? d, endpointUrl(d.configEncrypted)), signingSecret };
  }

  private async findWebhook(repo: TenantScopedRepository, id: string): Promise<any> {
    const d: any = UUID_RE.test(id) ? await repo.findDestinationById(id) : null;
    if (!d || d.type !== 'webhook') throw notFound('Endpoint');
    return d;
  }
}
