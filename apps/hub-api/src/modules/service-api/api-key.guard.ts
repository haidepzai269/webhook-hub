import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@hub/database';
import { hashApiKey, logger } from '@hub/common';
import { REQUIRE_SCOPE_KEY } from './require-scope.decorator';
import { KeyPrincipal, RequestWithPrincipal } from './principal';

/** `lastUsedAt` ghi tối đa 1 lần / phút / key (so trong bộ nhớ) — không ghi DB mỗi request, không Redis. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const INVALID_KEY = { error: 'invalid_api_key' } as const;
const NOT_FOUND = { error: 'not_found' } as const;

/**
 * S3 (SPEC §4.3B, ADR-038): xác thực service bằng API key cho `/v1/p/:project/*`. Thứ tự kiểm CỐ ĐỊNH:
 *   1. thiếu/sai định dạng header, hash không có, key đã revoke      -> 401 {error:"invalid_api_key"}
 *   2. `:project` không phải project của key (tồn tại hay không)    -> 404 {error:"not_found"} — CÙNG một body
 *   3. thiếu scope (`@RequireScope`)                                -> 403 {error:"missing_scope", required}
 * Bước 2 so slug của project GẮN VỚI KEY với slug trên path — không bao giờ tra project theo slug của path,
 * nên không có đường nào phân biệt "project kia có tồn tại" (U22).
 *
 * Gắn `request.principal = {kind:'key', id, tenantId, scopes, serviceName}` (SPEC-auth §2.1, X13) +
 * `request.tenantId` (để `@CurrentTenant()`-kiểu đọc được) + `request.apiKey`. Không lệnh Redis nào (X9).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly lastWrite = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const header = req.headers?.authorization;
    const m = typeof header === 'string' ? /^Bearer\s+(hk_(?:test|live)_[A-Za-z0-9_-]{1,128})\s*$/.exec(header) : null;
    if (!m) throw new HttpException(INVALID_KEY, HttpStatus.UNAUTHORIZED);

    const key = await this.prisma.findApiKeyByHash(hashApiKey(m[1]));
    if (!key || key.revokedAt) throw new HttpException(INVALID_KEY, HttpStatus.UNAUTHORIZED);

    if (key.project.slug !== req.params?.project) throw new HttpException(NOT_FOUND, HttpStatus.NOT_FOUND);

    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_SCOPE_KEY, [context.getHandler(), context.getClass()]);
    if (required && !key.scopes.includes(required)) {
      throw new HttpException({ error: 'missing_scope', required }, HttpStatus.FORBIDDEN);
    }

    const principal: KeyPrincipal = { kind: 'key', id: key.id, tenantId: key.tenantId, scopes: key.scopes, serviceName: key.serviceName };
    req.principal = principal;
    req.tenantId = key.tenantId;
    req.apiKey = key;
    this.touchLastUsed(key.id, key.tenantId);
    return true;
  }

  private touchLastUsed(keyId: string, tenantId: string) {
    const now = Date.now();
    const last = this.lastWrite.get(keyId);
    if (last !== undefined && now - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastWrite.set(keyId, now);
    this.prisma
      .forTenant(tenantId)
      .touchApiKeyLastUsed(keyId, new Date(now))
      .catch((err: Error) => logger.warn({ err: err.message, keyId }, 'Không ghi được lastUsedAt (bỏ qua)'));
  }
}
