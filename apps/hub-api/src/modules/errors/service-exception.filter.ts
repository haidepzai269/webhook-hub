import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { ERROR_CATALOG, HubErrorCode, codeForStatus, docsUrlFor, isHubErrorCode, logger } from '@hub/common';
import { RequestWithId, ensureRequestId, isDevFacingPath } from './request-id';

/**
 * DX1 (SPEC-dev-experience §2.1, §2.4): MỌI lỗi 4xx/5xx của `/v1/p/:project/*` và `/api/v1/*` ra một khuôn:
 *   { error, message, fix, docsUrl, requestId, ...tham số của mã, detail? }
 * - `error`: mã của exception nếu thuộc catalog; không có mã -> suy từ status (BadRequestException('…') -> bad_request).
 * - `message`/`fix`: tiếng Anh, từ catalog. `detail`: câu gốc (tiếng Việt) do code hub viết — console hiển thị câu này
 *   (ADR-136). KHÔNG có `detail` cho `not_found` (UX2: body giống hệt trừ requestId) và lỗi máy chủ.
 * - Tham số: CHỈ các trường khai ở `params` của mã — trường khác của body gốc bị bỏ (luật 2.4: không lộ key/secret/body).
 * - Lỗi lạ / 5xx -> `internal_error` (503 -> `service_unavailable`), không lộ message/stack; log đầy đủ ở server kèm requestId.
 * Route khác (`/hooks`, `/auth`, `/health`, `/metrics`, `/mock`) giữ nguyên hành vi mặc định của Nest.
 */
@Catch()
export class ServiceExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return super.catch(exception, host);
    const req = host.switchToHttp().getRequest<RequestWithId>();
    const res = host.switchToHttp().getResponse<Response>();
    if (!isDevFacingPath(req.originalUrl ?? req.url)) return super.catch(exception, host);
    const requestId = ensureRequestId(req, res);
    const { status, body, original } = toErrorBody(exception, requestId);
    const where = { requestId, method: req.method, path: (req.originalUrl ?? req.url ?? '').split('?')[0], status, error: body.error };
    if (isKept5xx(body.error, status)) logger.warn(where, `Từ chối có chủ đích (${status} ${body.error})`);
    else if (status >= 500 && status !== 503) logger.error({ ...where, err: exception, original }, 'Lỗi máy chủ (trả internal_error, chi tiết chỉ ở log)');
    else if (status >= 500) logger.warn({ ...where, original }, 'Tạm thời không phục vụ được (503)');
    else logger.info(where, 'Trả lỗi cho client');
    if (res.headersSent) return;
    // 429/503 có retryAfter -> header chuẩn Retry-After cho client/proxy.
    if (typeof body.retryAfter === 'number' && Number.isFinite(body.retryAfter)) res.setHeader('Retry-After', String(body.retryAfter));
    res.status(status).json(body);
  }
}

export interface ErrorBody {
  error: HubErrorCode;
  message: string;
  fix: string;
  docsUrl: string;
  requestId: string;
  detail?: string;
  [param: string]: unknown;
}

/**
 * QT (ADR-182) + review QT-S1 M1: WHITELIST tường minh các mã 5xx giữ nguyên status + detail — đây là từ chối có chủ đích
 * (507 project hết dung lượng), không phải lỗi máy chủ. Mọi 5xx khác (kể cả `internal_error`/`service_unavailable` có
 * trong catalog) đi đường cũ: 500 `internal_error` / 503 `service_unavailable`, KHÔNG lộ message/detail, `original` chỉ ở log.
 */
const KEPT_5XX: ReadonlySet<HubErrorCode> = new Set<HubErrorCode>(['project_storage_full']);
function isKept5xx(code: unknown, status: number): boolean {
  return status >= 500 && isHubErrorCode(code) && KEPT_5XX.has(code) && ERROR_CATALOG[code].status === status;
}

/** Lỗi http-errors (body-parser: JSON hỏng, body quá lớn…) — có `status` 4xx và `expose`. */
function httpErrorsStatus(e: any): number | null {
  const st = Number(e?.status ?? e?.statusCode);
  return e && e.expose === true && Number.isInteger(st) && st >= 400 && st < 500 ? st : null;
}

/** Thuần (test được không cần Nest): exception -> status + body theo catalog. */
export function toErrorBody(exception: unknown, requestId: string): { status: number; body: ErrorBody; original?: unknown } {
  let status = 500;
  let raw: Record<string, unknown> = {};
  if (exception instanceof HttpException) {
    status = exception.getStatus();
    const r = exception.getResponse();
    raw = typeof r === 'string' ? { message: r } : r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
  } else {
    const st = httpErrorsStatus(exception);
    if (st) {
      status = st;
      raw = st === 413 ? { error: 'payload_too_large' } : {};
    }
  }

  let code: HubErrorCode;
  const catalog5xx = isKept5xx(raw.error, status);
  if (catalog5xx) {
    code = raw.error as HubErrorCode;
  } else if (status >= 500) {
    code = status === 503 ? 'service_unavailable' : 'internal_error';
    status = status === 503 ? 503 : 500;
  } else {
    code = isHubErrorCode(raw.error) ? raw.error : codeForStatus(status);
  }
  const def = ERROR_CATALOG[code] as { message: string; params?: readonly string[]; fix: (p: Record<string, unknown>) => string };
  const params: Record<string, unknown> = {};
  for (const k of def.params ?? []) if (raw[k] !== undefined) params[k] = raw[k];
  const msg = Array.isArray(raw.message) ? raw.message.join('; ') : raw.message;
  const detail = (status < 500 || catalog5xx) && code !== 'not_found' && typeof msg === 'string' && msg.length > 0 ? msg.slice(0, 500) : undefined;
  const body: ErrorBody = {
    error: code,
    message: def.message,
    fix: def.fix(params),
    docsUrl: docsUrlFor(code),
    requestId,
    ...params,
    ...(detail ? { detail } : {}),
  };
  return { status, body, ...(status >= 500 && !catalog5xx ? { original: raw } : {}) };
}
