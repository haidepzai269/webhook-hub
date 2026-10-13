import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { aesGcmEncrypt } from '@hub/crypto';
import { isValidEventPattern } from '@hub/common';
import { ProviderRegistry } from '@hub/providers';
import { ApiKeyGuard } from './api-key.guard';
import { RequireScope } from './require-scope.decorator';
import { RequestWithPrincipal } from './principal';
import { unprocessable } from './service-api.controller';
import { EndpointVerifier, VerificationOutcome } from './endpoint-verifier';
import {
  EndpointService,
  auditVerificationFailure,
  endpointUrl,
  parseEndpointUrl,
  parseGivenSecret,
  publicEndpoint,
  storedSecret,
  withFix,
} from './endpoint.service';
import { longPoll } from './polling';
import { hubError } from '../errors/hub-error';
import { assertSourceLimit } from '../console/source-limit';
import { parseSourceInput } from './source-input';
import { inspectSourceRows } from './source-inspect';
import { generateSourceKey } from '../console/source-key';

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
  // ADR-161: source đã lưu trữ = không còn (unknown_source).
  const found = keys.length ? await repo.findSources({ sourceKey: { in: keys }, archivedAt: null }) : [];
  const missing = keys.filter((k) => !found.some((s: any) => s.sourceKey === k));
  if (missing.length > 0) unprocessable({ error: 'unknown_source', keys: missing });
  return found.map((s: any) => s.id);
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

export function publicSubscription(s: any) {
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
  /** KN1 (ADR-138): lõi tạo endpoint dùng chung với console. */
  private readonly endpoints: EndpointService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: EndpointVerifier,
  ) {
    this.endpoints = new EndpointService(prisma, verifier);
  }

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
    const given = parseGivenSecret(body?.signingSecret);
    // R2-2 (ADR-098): xoay key -> nhận lại endpoint CÙNG url của key cũ ĐÃ REVOKE CÙNG serviceName (không tạo bản thứ hai).
    const orphan = await this.findAdoptable(tenantId, url, req);
    if (orphan) return this.adoptEndpoint(tenantId, orphan, url, given, req);
    // KN1: tạo PENDING (tx + audit) -> challenge ngoài tx -> ghi kết quả — lõi chung với console.
    const r = await this.endpoints.create(tenantId, { name, url, signingSecret: given, createdByKeyId: req.apiKey!.id }, `key:${req.apiKey!.id}`);
    return { ...publicEndpoint(r.destination, url), ...(r.generatedSecret ? { signingSecret: r.generatedSecret } : {}) };
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
    // ADR-161 (C2): endpoint đã lưu trữ không bao giờ được nhận lại.
    const rows = await repo.findDestinations({ type: 'webhook', createdByKeyId: { in: [...retired] }, archivedAt: null });
    return rows.find((d) => endpointUrl(d.configEncrypted) === url) ?? null;
  }

  /**
   * R3-1 (ADR-101, sửa ADR-098): CHỨNG MINH TRƯỚC, chuyển chủ SAU. Challenge bằng secret mới (nếu có) hoặc secret đang
   * lưu; chỉ khi VERIFIED mới chuyển chủ + (xoay secret) + audit `endpoint.adopted`, trong MỘT transaction. Không
   * VERIFIED -> 409, chủ / secret / trạng thái cũ GIỮ NGUYÊN (key sai secret không làm hỏng endpoint đang nhận).
   */
  private async adoptEndpoint(tenantId: string, d: any, url: string, given: string | undefined, req: RequestWithPrincipal) {
    const actor = `key:${req.apiKey!.id}`;
    const secret: string | null = given ?? storedSecret(d);
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
      // ADR-161 (T1): vừa bị lưu trữ giữa lúc challenge -> 404, không báo adopted khi chẳng ghi gì.
      if (!u) throw new NotFoundException(NOT_FOUND);
      await repo.createAuditLog({ action: 'endpoint.adopted', entityType: 'destination', entityId: d.id, actor, metadata: { fromKeyId: d.createdByKeyId, secretRotated: !!given } });
      return u;
    });
    return { ...publicEndpoint(updated, url), adopted: true };
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
      await this.endpoints.recordVerification(tenantId, d.id, o, `key:${req.apiKey!.id}`, 'rotate', aesGcmEncrypt(next, getMasterKey()));
      return { ...withFix(o), secretRotated: true };
    }
    return withFix(await this.endpoints.reverify(tenantId, d, `key:${req.apiKey!.id}`));
  }

  @Get('endpoints')
  @RequireScope('manage:endpoints')
  async listEndpoints(@Req() req: RequestWithPrincipal) {
    const rows = await this.prisma.forTenant(req.tenantId!).findDestinations({ type: 'webhook', createdByKeyId: req.apiKey!.id, archivedAt: null });
    return rows.map((d) => publicEndpoint(d, endpointUrl(d.configEncrypted)));
  }

  @Post('subscriptions')
  @RequireScope('manage:endpoints')
  async createSubscription(@Req() req: RequestWithPrincipal, @Body() body: any) {
    const tenantId = req.tenantId!;
    const endpointId = body?.endpointId;
    if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) throw new NotFoundException(NOT_FOUND);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) unprocessable({ error: 'validation_failed', field: 'name', message: 'name là chuỗi 1–255 ký tự' });
    const eventTypes = parseEventTypes422(body?.eventTypes);
    // MS-R3: readTypes là ranh giới quyền ĐỌC của key — push không được rộng hơn polling.
    const readTypes = req.apiKey!.readTypes ?? [];
    if (readTypes.length > 0) {
      const invalid = eventTypes.filter((p) => !readTypes.some((r) => patternCovers(r, p)));
      if (invalid.length > 0) unprocessable({ error: 'outside_read_types', field: 'eventTypes', invalid, message: `Key chỉ đọc được: ${readTypes.join(', ')}` });
    }
    const created = await this.withAudit(tenantId, async (tx) => {
      // ADR-161 (T2, C1): khoá cấu hình luồng rồi kiểm endpoint + nguồn TRONG transaction (đích/source đã lưu trữ = không có).
      await tx.lockFlowConfig();
      // Endpoint phải thuộc project (404 giống hệt "không tồn tại"); khoá ngoại ghép là lưới cuối (S1).
      // MS-R3: chỉ ENDPOINT (webhook); R-1 (ADR-094): và chỉ endpoint do CHÍNH key này tạo — endpoint của service khác
      // (vd Shop) coi như không tồn tại, nên không gắn được subscription không ghim nguồn vào đó.
      const endpoint = await tx.findDestinationById(endpointId);
      if (!ownsEndpoint(endpoint, req)) throw new NotFoundException(NOT_FOUND);
      // MS-P2-1 (ADR-089): ghim nguồn theo sourceKey (service biết key từ URL webhook, không cần manage:sources).
      const sourceIds = [...new Set([...(await resolveSourceIds(tx, body?.sourceIds)), ...(await resolveSourceKeys(tx, body?.sourceKeys))])];
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
      // ADR-161/163: bật/tắt subscription đổi tập "còn replay được" — cùng khoá cấu hình luồng với replay hàng loạt.
      await tx.lockFlowConfig();
      const u = await tx.updateSubscription(id, { isActive: body.isActive });
      // ADR-161 (T1): vừa bị lưu trữ -> 404, không báo thành công khi chẳng ghi gì.
      if (!u) throw new NotFoundException(NOT_FOUND);
      await tx.createAuditLog({ action: 'subscription.update', entityType: 'subscription', entityId: id, actor: `key:${req.apiKey!.id}`, metadata: { fields: ['isActive'], isActive: body.isActive } });
      return u;
    });
    return (await this.withSourceKeys(tenantId, [updated]))[0];
  }

  @Get('subscriptions')
  @RequireScope('manage:endpoints')
  async listSubscriptions(@Req() req: RequestWithPrincipal) {
    // MS-R3: chỉ subscription tới endpoint (webhook) — không lộ đích Telegram/Discord của operator.
    const rows = await this.prisma.forTenant(req.tenantId!).findSubscriptions({ destination: { type: 'webhook', createdByKeyId: req.apiKey!.id }, archivedAt: null });
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
      const latest = await this.prisma.forTenant(req.tenantId!).latestPollCursor();
      // M-1: backlog cấp cursor vượt trần một request -> 503 có retryAfter; gọi lại sẽ tiến tiếp (không sai, chỉ chậm).
      if (latest === null) throw hubError('service_unavailable', { retryAfter: 1 }, 'Đang cấp cursor cho event tồn của project — thử lại sau 1 giây');
      return { events: [], nextCursor: latest.toString() };
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
    if (q.endpointId !== undefined && !(UUID_RE.test(q.endpointId) && ownsEndpoint(await repo.findDestinationById(q.endpointId, { includeArchived: true }), req))) {
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
    const sourceKey = generateSourceKey(input.provider);
    const masterKey = getMasterKey();
    const created = await this.withAudit(req.tenantId!, async (repo) => {
      // QT9 (Q11): trần source/project — API key không bao giờ là operator.
      await assertSourceLimit(repo, false);
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
    const rows = await this.prisma.forTenant(req.tenantId!).findSources({ archivedAt: null });
    return rows.map(publicSource);
  }

  /**
   * S9 (SPEC §4.8): chế độ lắng nghe — xem `inspectSourceRows` (PK1: dùng chung với console `/api/v1/sources/:id/inspect`).
   * KHÔNG BAO GIỜ trả giá trị chữ ký, token, secret hay body — chỉ tên header/trường. UI gọi lại mỗi 2s.
   */
  @Get('sources/:id/inspect')
  @RequireScope('manage:sources')
  async inspectSource(@Req() req: RequestWithPrincipal, @Param('id') id: string, @Query('since') since?: string) {
    return inspectSourceRows(this.prisma.forTenant(req.tenantId!), id, since);
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

