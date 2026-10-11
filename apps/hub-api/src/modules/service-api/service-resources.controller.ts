import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { aesGcmDecrypt, aesGcmEncrypt, generateWhsecSecret } from '@hub/crypto';
import { isValidEventPattern, verificationFix } from '@hub/common';
import { ProviderRegistry } from '@hub/providers';
import { ApiKeyGuard } from './api-key.guard';
import { RequireScope } from './require-scope.decorator';
import { RequestWithPrincipal } from './principal';
import { unprocessable } from './service-api.controller';
import { EndpointVerifier, VerificationOutcome } from './endpoint-verifier';
import { longPoll } from './polling';
import { parseSourceInput } from './source-input';
import { ulid } from 'ulidx';

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

/** MS-P2-1: `sourceKeys` -> id source CỦA project; key lạ/khác project -> 422 `{error:"unknown_source", keys}`. */
export async function resolveSourceKeys(repo: TenantScopedRepository, v: unknown): Promise<string[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) {
    unprocessable({ error: 'validation_failed', field: 'sourceKeys', message: 'sourceKeys là mảng ≤ 50 sourceKey' });
  }
  const keys = [...new Set(v as string[])];
  const found = keys.length ? await repo.findSources({ sourceKey: { in: keys } }) : [];
  const missing = keys.filter((k) => !found.some((s: any) => s.sourceKey === k));
  if (missing.length > 0) unprocessable({ error: 'unknown_source', keys: missing });
  return found.map((s: any) => s.id);
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
/** DX1 §2.3: kết quả challenge kèm `verificationFix`. */
function withFix<T extends { verificationError: string | null }>(o: T): T & { verificationFix: string | null } {
  return { ...o, verificationFix: verificationFix(o.verificationError) };
}

function publicEndpoint(d: any, url: string | null) {
  return {
    id: d.id,
    name: d.name,
    url,
    verification: d.verification,
    verificationError: d.verificationError ?? null,
    // DX1 §2.3: gợi ý sửa ngay cạnh lý do (null khi VERIFIED).
    verificationFix: verificationFix(d.verificationError),
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

/** Cửa sổ cố định trong bộ nhớ theo khoá. Nhiều instance hub-api thì trần nhân theo số instance (chấp nhận). */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  tryAcquire(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      if (this.hits.size > 10_000) this.hits.clear(); // chặn phình bộ nhớ
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    if (h.n >= this.max) return false;
    h.n += 1;
    return true;
  }
}

/** C-1 (ADR-131): đường nào gây ra challenge — để audit nói rõ lần thất bại đến từ đâu (vòng ensure của service = rotate). */
type VerifyAttempt = 'create' | 'verify' | 'rotate' | 'adopt';
const VERIFY_AUDIT_ACTIONS = ['endpoint.verified', 'endpoint.verification_failed', 'endpoint.adopted'];
/** Cửa sổ chống spam audit verify thất bại: lỗi y hệt lặp lại trong 1 giờ chỉ ghi một lần. */
export const VERIFY_FAILURE_AUDIT_DEDUPE_MS = 60 * 60_000;

/**
 * C-1 (ADR-131): MỌI lần verify thất bại phải để lại dấu vết (trước đây xoay secret / adopt FAILED trả về im lặng ->
 * Shop retry `ensure` vào URL bị chặn mà console trống trơn). Chống spam từ vòng retry: nếu audit verify MỚI NHẤT của
 * endpoint trong 1 giờ là `verification_failed` cùng mã lỗi + cùng attempt -> bỏ qua. Bền (đọc Postgres, đúng với
 * nhiều instance, 0 lệnh Redis). Metadata CHỈ có mã lỗi + attempt — không url, không secret.
 */
async function auditVerificationFailure(
  repo: TenantScopedRepository,
  id: string,
  code: string | null,
  attempt: VerifyAttempt,
  actor: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const last: any = await repo.findLatestAuditForEntity('destination', id, VERIFY_AUDIT_ACTIONS, new Date(Date.now() - VERIFY_FAILURE_AUDIT_DEDUPE_MS));
  if (last?.action === 'endpoint.verification_failed' && last.metadata?.verificationError === code && last.metadata?.attempt === attempt) return false;
  await repo.createAuditLog({ action: 'endpoint.verification_failed', entityType: 'destination', entityId: id, actor, metadata: { verificationError: code, attempt, ...extra } });
  return true;
}

/** R-1/R-2 (ADR-094): endpoint là webhook VÀ do chính key đang gọi tạo (NULL = đích operator, /v1/p không quản). */
function ownsEndpoint(d: any, req: RequestWithPrincipal): boolean {
  return !!d && d.type === 'webhook' && !!d.createdByKeyId && d.createdByKeyId === req.apiKey?.id;
}

/** Mẫu `r` phủ mẫu `p`? `*` phủ mọi thứ; `a.*` phủ `a.x`, `a.x.*`; còn lại phải bằng nhau. */
export function patternCovers(r: string, p: string): boolean {
  if (r === '*' || r === p) return true;
  return r.endsWith('.*') && p !== '*' && p.startsWith(r.slice(0, -1));
}

/** Bản công khai của source: không bao giờ có `secrets` (ciphertext). */
function publicSource(s: any) {
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    sourceKey: s.sourceKey,
    webhookUrl: `/hooks/${s.provider}/${s.sourceKey}`,
    isActive: s.isActive,
    verificationConfig: s.verificationConfig ?? null,
    createdAt: s.createdAt,
  };
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

  /** MS-R1: 5 lần /verify / phút / endpoint, trong bộ nhớ từng instance (0 lệnh Redis, X9). */
  private readonly verifyLimiter = new WindowLimiter(5, 60_000);

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
    // R2-2 (ADR-098): xoay key -> nhận lại endpoint CÙNG url của key cũ ĐÃ REVOKE CÙNG serviceName (không tạo bản thứ hai).
    const orphan = await this.findAdoptable(tenantId, url, req);
    if (orphan) return this.adoptEndpoint(tenantId, orphan, url, given, req);
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
        createdByKeyId: req.apiKey!.id, // R-1 (ADR-094): endpoint có chủ
      });
      await repo.createAuditLog({ action: 'endpoint.create', entityType: 'destination', entityId: d.id, actor: `key:${req.apiKey!.id}`, metadata: { name: d.name } });
      return d;
    });
    const outcome = await this.verifier.challenge(url, signingSecret);
    const updated = await this.recordVerification(tenantId, created.id, outcome, `key:${req.apiKey!.id}`, 'create');
    return { ...publicEndpoint(updated ?? created, url), ...(given === undefined ? { signingSecret } : {}) };
  }

  /**
   * R2-2 (ADR-098): endpoint "mồ côi" mà key này được NHẬN LẠI: webhook cùng project, cùng url, chủ là một key ĐÃ REVOKE
   * có CÙNG serviceName với key đang gọi (serviceName do operator đặt = danh tính service). Không bao giờ nhận endpoint
   * của key còn sống, của service khác, hay của operator (chủ NULL).
   */
  private async findAdoptable(tenantId: string, url: string, req: RequestWithPrincipal) {
    const repo = this.prisma.forTenant(tenantId);
    const keys = await repo.findApiKeys();
    const retired = new Set(keys.filter((k: any) => k.revokedAt && k.serviceName === req.apiKey!.serviceName && k.id !== req.apiKey!.id).map((k: any) => k.id));
    if (retired.size === 0) return null;
    const rows = await repo.findDestinations({ type: 'webhook', createdByKeyId: { in: [...retired] } });
    return rows.find((d) => endpointUrl(d.configEncrypted) === url) ?? null;
  }

  /**
   * R3-1 (ADR-101, sửa ADR-098): CHỨNG MINH TRƯỚC, chuyển chủ SAU. Challenge bằng secret mới (nếu có) hoặc secret đang
   * lưu; chỉ khi VERIFIED mới chuyển chủ + (xoay secret) + audit `endpoint.adopted`, trong MỘT transaction. Không
   * VERIFIED -> 409, chủ / secret / trạng thái cũ GIỮ NGUYÊN (key sai secret không làm hỏng endpoint đang nhận).
   */
  private async adoptEndpoint(tenantId: string, d: any, url: string, given: string | undefined, req: RequestWithPrincipal) {
    const actor = `key:${req.apiKey!.id}`;
    let secret: string | null = given ?? null;
    if (!secret) {
      try {
        secret = d.signingSecretEncrypted ? aesGcmDecrypt(d.signingSecretEncrypted, getMasterKey()) : null;
      } catch {
        secret = null;
      }
    }
    const outcome: VerificationOutcome = secret ? await this.verifier.challenge(url, secret) : { verification: 'FAILED', verificationError: 'no_signing_secret' };
    if (outcome.verification !== 'VERIFIED') {
      // C-1 (ADR-131): 409 vẫn để lại audit trên endpoint cũ (chủ/secret/trạng thái KHÔNG đổi).
      await this.withAudit(tenantId, (repo) => auditVerificationFailure(repo, d.id, outcome.verificationError, 'adopt', actor));
      throw new HttpException(
        { error: 'adoption_not_verified', verificationError: outcome.verificationError, message: 'Endpoint không chứng minh được secret — không chuyển chủ' },
        HttpStatus.CONFLICT,
      );
    }
    const updated = await this.withAudit(tenantId, async (repo) => {
      const u = await repo.updateDestination(d.id, {
        createdByKeyId: req.apiKey!.id,
        ...(given ? { signingSecretEncrypted: aesGcmEncrypt(given, getMasterKey()) } : {}),
        verification: 'VERIFIED',
        verificationError: null,
        verifiedAt: new Date(),
      });
      await repo.createAuditLog({ action: 'endpoint.adopted', entityType: 'destination', entityId: d.id, actor, metadata: { fromKeyId: d.createdByKeyId, secretRotated: !!given } });
      return u;
    });
    return { ...publicEndpoint(updated ?? d, url), adopted: true };
  }

  /** S6: chạy lại challenge (vd sau khi sửa endpoint). Endpoint không thuộc project -> 404 giống hệt. */
  @Post('endpoints/:id/verify')
  @HttpCode(200)
  @RequireScope('manage:endpoints')
  async verifyEndpoint(@Req() req: RequestWithPrincipal, @Param('id') id: string, @Body() body?: any) {
    const tenantId = req.tenantId!;
    const d = UUID_RE.test(id) ? await this.prisma.forTenant(tenantId).findDestinationById(id) : null;
    if (!ownsEndpoint(d, req)) throw new NotFoundException(NOT_FOUND);
    // MS-R1 (ADR-083): /verify là một POST ra ngoài theo URL do service khai — giới hạn để không thành máy dò cổng.
    if (!this.verifyLimiter.tryAcquire(d.id)) {
      throw new HttpException({ error: 'rate_limited', message: 'Tối đa 5 lần /verify mỗi phút cho một endpoint' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const url = endpointUrl(d.configEncrypted);
    // MS-R4 (ADR-086): có `signingSecret` -> XOAY secret có chứng minh: challenge ký bằng secret MỚI; endpoint trả đúng
    // (tức đang verify bằng secret mới) thì mới lưu. Sai thì giữ nguyên secret + trạng thái cũ (không để key nào
    // làm hỏng endpoint đang chạy bằng một secret bậy).
    const next = body?.signingSecret;
    if (next !== undefined) {
      if (typeof next !== 'string' || next.length < 16 || next.length > 256) {
        unprocessable({ error: 'validation_failed', field: 'signingSecret', message: 'signingSecret là chuỗi 16–256 ký tự' });
      }
      const o: VerificationOutcome = url ? await this.verifier.challenge(url, next) : { verification: 'FAILED', verificationError: 'invalid_url' };
      if (o.verification !== 'VERIFIED') {
        // C-1 (ADR-131): trạng thái + secret cũ GIỮ NGUYÊN (MS-R4), nhưng lần thất bại phải thấy được trong audit.
        await this.withAudit(tenantId, (repo) => auditVerificationFailure(repo, d.id, o.verificationError, 'rotate', `key:${req.apiKey!.id}`, { secretRotated: false }));
        return { ...withFix(o), secretRotated: false };
      }
      await this.recordVerification(tenantId, d.id, o, `key:${req.apiKey!.id}`, 'rotate', aesGcmEncrypt(next, getMasterKey()));
      return { ...withFix(o), secretRotated: true };
    }
    let secret: string | null = null;
    try {
      secret = d.signingSecretEncrypted ? aesGcmDecrypt(d.signingSecretEncrypted, getMasterKey()) : null;
    } catch {
      secret = null;
    }
    const outcome: VerificationOutcome =
      url && secret ? await this.verifier.challenge(url, secret) : { verification: 'FAILED', verificationError: url ? 'no_signing_secret' : 'invalid_url' };
    await this.recordVerification(tenantId, d.id, outcome, `key:${req.apiKey!.id}`, 'verify');
    return withFix(outcome);
  }

  /**
   * Ghi kết quả challenge + audit cùng transaction. Trạng thái endpoint cập nhật MỌI lần; audit thất bại đi qua
   * `auditVerificationFailure` (C-1, ADR-131: không spam khi retry).
   */
  private recordVerification(tenantId: string, id: string, o: VerificationOutcome, actor: string, attempt: VerifyAttempt, newSecretEncrypted?: string) {
    return this.withAudit(tenantId, async (repo) => {
      const u = await repo.updateDestination(id, {
        ...(newSecretEncrypted ? { signingSecretEncrypted: newSecretEncrypted } : {}),
        verification: o.verification,
        verificationError: o.verificationError,
        verifiedAt: o.verification === 'VERIFIED' ? new Date() : null,
      });
      if (o.verification === 'VERIFIED') {
        await repo.createAuditLog({
          action: 'endpoint.verified',
          entityType: 'destination',
          entityId: id,
          actor,
          metadata: { verificationError: null, attempt, ...(newSecretEncrypted ? { secretRotated: true } : {}) },
        });
      } else {
        await auditVerificationFailure(repo, id, o.verificationError, attempt, actor);
      }
      return u;
    });
  }

  @Get('endpoints')
  @RequireScope('manage:endpoints')
  async listEndpoints(@Req() req: RequestWithPrincipal) {
    const rows = await this.prisma.forTenant(req.tenantId!).findDestinations({ type: 'webhook', createdByKeyId: req.apiKey!.id });
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
    // MS-R3: chỉ ENDPOINT (webhook); R-1 (ADR-094): và chỉ endpoint do CHÍNH key này tạo — endpoint của service khác
    // (vd Shop) coi như không tồn tại, nên không gắn được subscription không ghim nguồn vào đó.
    if (!ownsEndpoint(endpoint, req)) throw new NotFoundException(NOT_FOUND);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) unprocessable({ error: 'validation_failed', field: 'name', message: 'name là chuỗi 1–255 ký tự' });
    const eventTypes = parseEventTypes422(body?.eventTypes);
    // MS-R3: readTypes là ranh giới quyền ĐỌC của key — push không được rộng hơn polling.
    const readTypes = req.apiKey!.readTypes ?? [];
    if (readTypes.length > 0) {
      const invalid = eventTypes.filter((p) => !readTypes.some((r) => patternCovers(r, p)));
      if (invalid.length > 0) unprocessable({ error: 'outside_read_types', field: 'eventTypes', invalid, message: `Key chỉ đọc được: ${readTypes.join(', ')}` });
    }
    // MS-P2-1 (ADR-089): ghim nguồn theo sourceKey (service biết key từ URL webhook, không cần manage:sources).
    const sourceIds = [...new Set([...(await resolveSourceIds(repo, body?.sourceIds)), ...(await resolveSourceKeys(repo, body?.sourceKeys))])];
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
    return (await this.withSourceKeys(tenantId, [created]))[0];
  }

  /** MS-P2-1: bật/tắt subscription của endpoint (vd tắt subscription cũ chưa ghim nguồn). Chỉ `isActive`. */
  @Patch('subscriptions/:id')
  @RequireScope('manage:endpoints')
  async updateSubscription(@Req() req: RequestWithPrincipal, @Param('id') id: string, @Body() body: any) {
    const tenantId = req.tenantId!;
    if (typeof body?.isActive !== 'boolean') unprocessable({ error: 'validation_failed', field: 'isActive', message: 'isActive là boolean' });
    const repo = this.prisma.forTenant(tenantId);
    const sub = UUID_RE.test(id) ? await repo.findSubscriptionById(id) : null;
    // R-2 (ADR-094): chỉ subscription tới endpoint của CHÍNH key này — key khác không tắt được sub đã ghim của Shop.
    if (!sub || !ownsEndpoint((sub as any).destination, req)) throw new NotFoundException(NOT_FOUND);
    const updated = await this.withAudit(tenantId, async (tx) => {
      const u = await tx.updateSubscription(id, { isActive: body.isActive });
      await tx.createAuditLog({ action: 'subscription.update', entityType: 'subscription', entityId: id, actor: `key:${req.apiKey!.id}`, metadata: { fields: ['isActive'], isActive: body.isActive } });
      return u;
    });
    return (await this.withSourceKeys(tenantId, [updated ?? { ...sub, isActive: body.isActive }]))[0];
  }

  @Get('subscriptions')
  @RequireScope('manage:endpoints')
  async listSubscriptions(@Req() req: RequestWithPrincipal) {
    // MS-R3: chỉ subscription tới endpoint (webhook) — không lộ đích Telegram/Discord của operator.
    const rows = await this.prisma.forTenant(req.tenantId!).findSubscriptions({ destination: { type: 'webhook', createdByKeyId: req.apiKey!.id } });
    return this.withSourceKeys(req.tenantId!, rows);
  }

  /**
   * S7 (SPEC §4.5, ADR-077/095/099): polling (A) + long-poll. `?after=<cursor>&limit=1..100&types=a.*,b&status=failed
   * &endpointId=&wait=0..20`. Kết quả `{events, nextCursor}` — cursor (poll_seq, thứ tự COMMIT) là CHUỖI; rỗng thì
   * nextCursor = after. `after=latest` (DX3) -> rỗng + cursor cuối; cursor rác -> 400 `invalid_cursor`.
   * `types` giao với `readTypes` của key. 0 lệnh Redis.
   */
  @Get('events')
  @RequireScope('read:events')
  async pollEvents(@Req() req: RequestWithPrincipal, @Res({ passthrough: true }) res: Response, @Query() q: Record<string, string>) {
    const after = q.after ?? '0';
    // DX3 (SPEC-dev-experience §4.5): `after=latest` -> `{events: [], nextCursor: <cursor lớn nhất đã cấp>}` — `hub listen`
    // bắt đầu từ "bây giờ" mà không phải tải lại lịch sử. Event commit sau đó luôn có cursor lớn hơn (poll_seq, ADR-095).
    if (after === 'latest') {
      return { events: [], nextCursor: (await this.prisma.forTenant(req.tenantId!).latestPollCursor()).toString() };
    }
    // DX3/UX11: cursor rác là lỗi của cursor (400 `invalid_cursor`), không phải 422 trường dữ liệu.
    if (!/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n) {
      throw new HttpException(
        { error: 'invalid_cursor', field: 'after', message: 'after là cursor polling (chuỗi số ≥ 0, lấy từ nextCursor) hoặc "latest"' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) unprocessable({ error: 'validation_failed', field: 'limit', message: 'limit là số nguyên 1–100' });
    const wait = q.wait === undefined ? 0 : Number(q.wait);
    if (!Number.isInteger(wait) || wait < 0 || wait > 20) unprocessable({ error: 'validation_failed', field: 'wait', message: 'wait là số giây nguyên 0–20' });
    const types = q.types ? q.types.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    if (types?.some((t) => !isValidEventPattern(t))) unprocessable({ error: 'validation_failed', field: 'types', message: 'types là danh sách mẫu cách nhau dấu phẩy (vd order.*,payment.received)' });
    if (q.status !== undefined && q.status !== 'failed') unprocessable({ error: 'validation_failed', field: 'status', message: 'status chỉ nhận "failed"' });
    const repo = this.prisma.forTenant(req.tenantId!);
    if (q.endpointId !== undefined && !(UUID_RE.test(q.endpointId) && ownsEndpoint(await repo.findDestinationById(q.endpointId), req))) {
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
    // R2-3 (ADR-099): `cursor` (poll_seq, thứ tự COMMIT) — cố ý KHÔNG gọi là `seq` để không lẫn với events.seq.
    const events = rows.map((r) => ({ ...r, cursor: r.cursor.toString() }));
    return { events, nextCursor: events.length ? events[events.length - 1].cursor : after };
  }

  /**
   * S8 (SPEC §4.3B, §4.8): service tự thêm nguồn bên thứ ba (GenericAdapter hoặc provider có sẵn). Secret mã hoá
   * như console; response CHỈ `{id, webhookUrl}` (+ thông tin công khai) — không bao giờ trả secret.
   */
  @Post('sources')
  @RequireScope('manage:sources')
  async createSource(@Req() req: RequestWithPrincipal, @Body() body: any) {
    const input = parseSourceInput(body);
    const sourceKey = `src_${input.provider}_${ulid().toLowerCase()}`;
    const masterKey = getMasterKey();
    const created = await this.withAudit(req.tenantId!, async (repo) => {
      const s = await repo.createSource({
        provider: input.provider,
        name: input.name,
        sourceKey,
        isActive: true,
        ...(input.verificationConfig ? { verificationConfig: input.verificationConfig as any } : {}),
        secrets: { create: { secretEncrypted: aesGcmEncrypt(input.secret, masterKey), version: 1 } },
      } as any);
      await repo.createAuditLog({
        action: 'source.create',
        entityType: 'source',
        entityId: s.id,
        actor: `key:${req.apiKey!.id}`,
        metadata: { provider: s.provider, name: s.name, sourceKey },
      });
      return s;
    });
    return publicSource(created);
  }

  @Get('sources')
  @RequireScope('manage:sources')
  async listSources(@Req() req: RequestWithPrincipal) {
    const rows = await this.prisma.forTenant(req.tenantId!).findSources();
    return rows.map(publicSource);
  }

  /**
   * S9 (SPEC §4.8): chế độ lắng nghe — 10 raw_events mới nhất của source (`received_at >= since`), mỗi dòng kèm
   * chẩn đoán của adapter (không cài `diagnose` -> `{ok: signatureValid}`). KHÔNG BAO GIỜ trả giá trị chữ ký,
   * token, secret hay body — chỉ tên header/trường. UI gọi lại mỗi 2s.
   */
  @Get('sources/:id/inspect')
  @RequireScope('manage:sources')
  async inspectSource(@Req() req: RequestWithPrincipal, @Param('id') id: string, @Query('since') since?: string) {
    const repo = this.prisma.forTenant(req.tenantId!);
    const source = UUID_RE.test(id) ? await repo.findSourceById(id) : null;
    if (!source) throw new NotFoundException(NOT_FOUND);
    let from = new Date(0);
    if (since !== undefined) {
      from = new Date(since);
      if (!/^\d{4}-\d{2}-\d{2}/.test(since) || Number.isNaN(from.getTime())) {
        unprocessable({ error: 'validation_failed', field: 'since', message: 'since là thời điểm ISO 8601 (vd 2026-10-10T00:00:00Z)' });
      }
    }
    const adapter = ProviderRegistry.get(source.provider as any);
    const ctx = { verificationConfig: (source as { verificationConfig?: unknown }).verificationConfig ?? undefined };
    const rows = await repo.findRecentRawEventsForSource(source.id, from, 10);
    return rows.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt,
      status: r.status,
      diagnosis: adapter.diagnose ? adapter.diagnose(r as any, ctx) : { ok: r.signatureValid },
    }));
  }

  /** Bản công khai kèm `sourceKeys` (map id -> sourceKey trong project, một truy vấn). */
  private async withSourceKeys(tenantId: string, rows: any[]) {
    const ids = [...new Set(rows.flatMap((r) => r.sourceIds ?? []))];
    const found = ids.length ? await this.prisma.forTenant(tenantId).findSources({ id: { in: ids } }) : [];
    const keyOf = new Map(found.map((x: any) => [x.id, x.sourceKey]));
    return rows.map((r) => ({ ...publicSubscription(r), sourceKeys: (r.sourceIds ?? []).map((i: string) => keyOf.get(i)).filter(Boolean) }));
  }

  private withAudit<T>(tenantId: string, fn: (repo: TenantScopedRepository) => Promise<T>): Promise<T> {
    return this.prisma.tenantTx(tenantId, (tx) => fn(this.prisma.forTenant(tenantId, tx)));
  }
}

