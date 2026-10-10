import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { aesGcmDecrypt, aesGcmEncrypt, generateWhsecSecret } from '@hub/crypto';
import { isValidEventPattern } from '@hub/common';
import { ApiKeyGuard } from './api-key.guard';
import { RequireScope } from './require-scope.decorator';
import { RequestWithPrincipal } from './principal';
import { unprocessable } from './service-api.controller';
import { EndpointVerifier, VerificationOutcome } from './endpoint-verifier';
import { longPoll } from './polling';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { error: 'not_found' };

/** `eventTypes` của `/v1/p`: 1–50 mẫu theo `libs/common/src/event-pattern.ts` (`*` hợp lệ — X1), sai -> 422. */
export function parseEventTypes422(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 50) {
    unprocessable({ error: 'validation_failed', field: 'eventTypes', message: 'eventTypes là mảng 1–50 mẫu (vd ["order.*"])' });
  }
  const bad = (v as unknown[]).filter((t) => !isValidEventPattern(t));
  if (bad.length > 0) {
    unprocessable({ error: 'validation_failed', field: 'eventTypes', message: 'Mẫu sai ngữ pháp', invalid: bad.slice(0, 5) });
  }
  return [...new Set(v as string[])];
}

/**
 * `sourceIds` (SPEC §4.6): mảng UUID, mọi id phải là source của CHÍNH project -> ngược lại 422
 * `{error:"unknown_source", ids}`. Dùng chung cho console và `/v1/p`. Không truyền = `[]` (mọi source).
 */
export async function resolveSourceIds(repo: TenantScopedRepository, v: unknown): Promise<string[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) {
    unprocessable({ error: 'validation_failed', field: 'sourceIds', message: 'sourceIds là mảng ≤ 50 id source' });
  }
  const ids = [...new Set(v as string[])];
  const malformed = ids.filter((id) => !UUID_RE.test(id));
  const foreign = [...malformed, ...(await repo.findForeignSourceIds(ids.filter((id) => UUID_RE.test(id))))];
  if (foreign.length > 0) unprocessable({ error: 'unknown_source', ids: foreign });
  return ids;
}

function parseEndpointUrl(v: unknown): string {
  let u: URL | null = null;
  try {
    u = typeof v === 'string' && v.length <= 2048 ? new URL(v) : null;
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    unprocessable({ error: 'validation_failed', field: 'url', message: 'url là địa chỉ http(s) tuyệt đối, ≤ 2048 ký tự' });
  }
  return u!.toString();
}

/** Bản công khai của endpoint: KHÔNG bao giờ có config/secret mã hoá. */
function publicEndpoint(d: any, url: string | null) {
  return {
    id: d.id,
    name: d.name,
    url,
    verification: d.verification,
    verificationError: d.verificationError ?? null,
    verifiedAt: d.verifiedAt ?? null,
    createdAt: d.createdAt,
  };
}

function endpointUrl(configEncrypted: string): string | null {
  try {
    const url = JSON.parse(aesGcmDecrypt(configEncrypted, getMasterKey()))?.url;
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

function publicSubscription(s: any) {
  return {
    id: s.id,
    name: s.name,
    endpointId: s.destinationId,
    eventTypes: s.eventTypes,
    sourceIds: s.sourceIds ?? [],
    isActive: s.isActive,
    createdAt: s.createdAt,
  };
}

/**
 * S5/S6 (SPEC §4.3B, §4.6, §4.7): service tự quản endpoint (= `destinations` type `webhook`) và subscription của
 * project mình. Tenant LUÔN là project của key (`req.tenantId` do `ApiKeyGuard` gắn), không bao giờ từ body.
 * Audit cùng transaction (ADR-050), actor = `key:<keyId>`.
 */
@Controller('v1/p/:project')
@UseGuards(ApiKeyGuard)
export class ServiceResourcesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: EndpointVerifier,
  ) {}

  /**
   * S6 (SPEC §4.7): không truyền `signingSecret` -> hub sinh `whsec_…` và trả ĐÚNG MỘT LẦN ở response này.
   * Tạo PENDING (cùng audit) -> challenge NGOÀI transaction (không giữ kết nối DB khi gọi mạng) -> ghi kết quả.
   * Luôn 201, kể cả khi challenge FAILED: endpoint tồn tại nhưng chưa nhận sự kiện (normalize bỏ qua).
   */
  @Post('endpoints')
  @RequireScope('manage:endpoints')
  async createEndpoint(@Req() req: RequestWithPrincipal, @Body() body: any) {
    const tenantId = req.tenantId!;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) unprocessable({ error: 'validation_failed', field: 'name', message: 'name là chuỗi 1–255 ký tự' });
    const url = parseEndpointUrl(body?.url);
    const given = body?.signingSecret;
    if (given !== undefined && (typeof given !== 'string' || given.length < 16 || given.length > 256)) {
      unprocessable({ error: 'validation_failed', field: 'signingSecret', message: 'signingSecret là chuỗi 16–256 ký tự' });
    }
    const signingSecret: string = given ?? generateWhsecSecret();
    const masterKey = getMasterKey();
    const created = await this.withAudit(tenantId, async (repo) => {
      const d = await repo.createDestination({
        name,
        type: 'webhook',
        configEncrypted: aesGcmEncrypt(JSON.stringify({ url }), masterKey),
        signingSecretEncrypted: aesGcmEncrypt(signingSecret, masterKey),
        rateLimitRps: 0,
        verification: 'PENDING',
      });
      await repo.createAuditLog({ action: 'endpoint.create', entityType: 'destination', entityId: d.id, actor: `key:${req.apiKey!.id}`, metadata: { name: d.name } });
      return d;
    });
    const outcome = await this.verifier.challenge(url, signingSecret);
    const updated = await this.recordVerification(tenantId, created.id, outcome, `key:${req.apiKey!.id}`);
    return { ...publicEndpoint(updated ?? created, url), ...(given === undefined ? { signingSecret } : {}) };
  }

  /** S6: chạy lại challenge (vd sau khi sửa endpoint). Endpoint không thuộc project -> 404 giống hệt. */
  @Post('endpoints/:id/verify')
  @HttpCode(200)
  @RequireScope('manage:endpoints')
  async verifyEndpoint(@Req() req: RequestWithPrincipal, @Param('id') id: string) {
    const tenantId = req.tenantId!;
    const d = UUID_RE.test(id) ? await this.prisma.forTenant(tenantId).findDestinationById(id) : null;
    if (!d || d.type !== 'webhook') throw new NotFoundException(NOT_FOUND);
    const url = endpointUrl(d.configEncrypted);
    let secret: string | null = null;
    try {
      secret = d.signingSecretEncrypted ? aesGcmDecrypt(d.signingSecretEncrypted, getMasterKey()) : null;
    } catch {
      secret = null;
    }
    const outcome: VerificationOutcome =
      url && secret ? await this.verifier.challenge(url, secret) : { verification: 'FAILED', verificationError: url ? 'no_signing_secret' : 'invalid_url' };
    await this.recordVerification(tenantId, d.id, outcome, `key:${req.apiKey!.id}`);
    return outcome;
  }

  /** Ghi kết quả challenge + audit `endpoint.verified` / `endpoint.verification_failed` cùng transaction. */
  private recordVerification(tenantId: string, id: string, o: VerificationOutcome, actor: string) {
    return this.withAudit(tenantId, async (repo) => {
      const u = await repo.updateDestination(id, {
        verification: o.verification,
        verificationError: o.verificationError,
        verifiedAt: o.verification === 'VERIFIED' ? new Date() : null,
      });
      await repo.createAuditLog({
        action: o.verification === 'VERIFIED' ? 'endpoint.verified' : 'endpoint.verification_failed',
        entityType: 'destination',
        entityId: id,
        actor,
        metadata: { verificationError: o.verificationError },
      });
      return u;
    });
  }

  @Get('endpoints')
  @RequireScope('manage:endpoints')
  async listEndpoints(@Req() req: RequestWithPrincipal) {
    const rows = await this.prisma.forTenant(req.tenantId!).findDestinations({ type: 'webhook' });
    return rows.map((d) => publicEndpoint(d, endpointUrl(d.configEncrypted)));
  }

  @Post('subscriptions')
  @RequireScope('manage:endpoints')
  async createSubscription(@Req() req: RequestWithPrincipal, @Body() body: any) {
    const tenantId = req.tenantId!;
    const repo = this.prisma.forTenant(tenantId);
    // Endpoint phải thuộc project (404 giống hệt "không tồn tại"); khoá ngoại ghép là lưới cuối (S1).
    const endpointId = body?.endpointId;
    const endpoint = typeof endpointId === 'string' && UUID_RE.test(endpointId) ? await repo.findDestinationById(endpointId) : null;
    if (!endpoint) throw new NotFoundException(NOT_FOUND);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) unprocessable({ error: 'validation_failed', field: 'name', message: 'name là chuỗi 1–255 ký tự' });
    const eventTypes = parseEventTypes422(body?.eventTypes);
    const sourceIds = await resolveSourceIds(repo, body?.sourceIds);
    const created = await this.withAudit(tenantId, async (tx) => {
      const s = await tx.createSubscription({ destinationId: endpoint.id, name, eventTypes, sourceIds, isActive: true });
      await tx.createAuditLog({
        action: 'subscription.create',
        entityType: 'subscription',
        entityId: s.id,
        actor: `key:${req.apiKey!.id}`,
        metadata: { name, destinationId: endpoint.id, eventTypes, sourceIds },
      });
      return s;
    });
    return publicSubscription(created);
  }

  @Get('subscriptions')
  @RequireScope('manage:endpoints')
  async listSubscriptions(@Req() req: RequestWithPrincipal) {
    const rows = await this.prisma.forTenant(req.tenantId!).findSubscriptions();
    return rows.map(publicSubscription);
  }

  /**
   * S7 (SPEC §4.5, ADR-077): polling (A) + long-poll. `?after=<seq>&limit=1..100&types=a.*,b&status=failed
   * &endpointId=&wait=0..20`. Kết quả `{events, nextCursor}` — seq là CHUỖI; rỗng thì nextCursor = after.
   * `types` giao với `readTypes` của key. 0 lệnh Redis.
   */
  @Get('events')
  @RequireScope('read:events')
  async pollEvents(@Req() req: RequestWithPrincipal, @Res({ passthrough: true }) res: Response, @Query() q: Record<string, string>) {
    const after = q.after ?? '0';
    if (!/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n) unprocessable({ error: 'validation_failed', field: 'after', message: 'after là seq (chuỗi số ≥ 0)' });
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) unprocessable({ error: 'validation_failed', field: 'limit', message: 'limit là số nguyên 1–100' });
    const wait = q.wait === undefined ? 0 : Number(q.wait);
    if (!Number.isInteger(wait) || wait < 0 || wait > 20) unprocessable({ error: 'validation_failed', field: 'wait', message: 'wait là số giây nguyên 0–20' });
    const types = q.types ? q.types.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    if (types?.some((t) => !isValidEventPattern(t))) unprocessable({ error: 'validation_failed', field: 'types', message: 'types là danh sách mẫu cách nhau dấu phẩy (vd order.*,payment.received)' });
    if (q.status !== undefined && q.status !== 'failed') unprocessable({ error: 'validation_failed', field: 'status', message: 'status chỉ nhận "failed"' });
    const repo = this.prisma.forTenant(req.tenantId!);
    if (q.endpointId !== undefined && !(UUID_RE.test(q.endpointId) && (await repo.findDestinationById(q.endpointId)))) {
      throw new NotFoundException(NOT_FOUND);
    }
    const readTypes = req.apiKey!.readTypes ?? [];
    let closed = false;
    res.on?.('close', () => (closed = true));
    const opts = {
      after: BigInt(after),
      limit,
      types,
      readTypes,
      ...(q.status === 'failed' ? { failedOnly: true, endpointId: q.endpointId } : {}),
    };
    const rows = await longPoll(() => repo.pollEvents(opts), wait, () => closed);
    const events = rows.map((r) => ({ ...r, seq: r.seq.toString() }));
    return { events, nextCursor: events.length ? events[events.length - 1].seq : after };
  }

  private withAudit<T>(tenantId: string, fn: (repo: TenantScopedRepository) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(this.prisma.forTenant(tenantId, tx)));
  }
}

