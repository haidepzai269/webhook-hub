import { Controller, Get, HttpException, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { RawWebhookRequest, isHubOnlyType, isReservedType, validateCanonical } from '@hub/common';
import { IngestService } from '../ingest/ingest.service';
import { ApiKeyGuard } from './api-key.guard';
import { RequireScope } from './require-scope.decorator';
import { RequestWithPrincipal } from './principal';
import { NoProjectScope } from './require-scope.decorator';

/** Kiểu sự kiện service tự phát: ít nhất 2 đoạn, chữ thường (SPEC §4.4). */
export const PUBLISH_TYPE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** 422 có tên trường — cùng khuôn với console (`validation_failed`). */
export function unprocessable(body: Record<string, unknown>): never {
  throw new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY);
}

/** Kiểm body `POST /events` (SPEC §4.4) + catalog cho kiểu dành riêng (§4.14.1 luật 4) — ĐỒNG BỘ, trước khi ghi. */
export function validatePublishBody(body: any): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    unprocessable({ error: 'validation_failed', field: 'body', message: 'Body phải là object JSON' });
  }
  if (typeof body.type !== 'string' || body.type.length > 128 || !PUBLISH_TYPE_RE.test(body.type)) {
    unprocessable({ error: 'validation_failed', field: 'type', message: 'type khớp ^[a-z0-9_]+(\\.[a-z0-9_]+)+$ (vd order.created)' });
  }
  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 1 || body.idempotencyKey.length > 255) {
    unprocessable({ error: 'validation_failed', field: 'idempotencyKey', message: 'idempotencyKey là chuỗi 1–255 ký tự' });
  }
  if (body.data === null || typeof body.data !== 'object' || Array.isArray(body.data)) {
    unprocessable({ error: 'validation_failed', field: 'data', message: 'data phải là object' });
  }
  if (body.subject !== undefined && body.subject !== null && (typeof body.subject !== 'string' || body.subject.length > 255)) {
    unprocessable({ error: 'validation_failed', field: 'subject', message: 'subject là chuỗi ≤ 255 ký tự' });
  }
  // Review QT-S2 M1: `hub.*` chỉ hub nội bộ phát — từ chối cả namespace dù `data` đúng khuôn (không giả mạo được).
  if (isHubOnlyType(body.type)) unprocessable({ error: 'reserved_type', type: body.type, field: 'type' });
  if (isReservedType(body.type)) {
    const r = validateCanonical(body.type, body.data);
    if (!r.ok) unprocessable({ error: 'schema_mismatch', type: body.type, field: r.field });
  }
}

/**
 * API cho service (SPEC §4.3B): `Authorization: Bearer hk_…`, path mang slug project. Mọi route qua
 * `ApiKeyGuard` (401 → 404 → 403); tenant lấy từ key, KHÔNG BAO GIỜ từ path hay body.
 */
@Controller('v1/p/:project')
@UseGuards(ApiKeyGuard)
export class ServiceApiController {
  constructor(private readonly ingest: IngestService) {}

  /** SDK dùng để kiểm kết nối (`hub.me()`). Scope bất kỳ. */
  @Get('me')
  @NoProjectScope('key nào hợp lệ cũng xem được thông tin của CHÍNH nó (SDK hub.me())')
  me(@Req() req: RequestWithPrincipal) {
    const k = req.apiKey!;
    return {
      project: { slug: k.project.slug, name: k.project.name, environment: k.project.environment },
      serviceName: k.serviceName,
      scopes: k.scopes,
    };
  }

  /**
   * S4: service tự phát sự kiện. 202 `{eventId:null, rawEventId, duplicate:false}` = đã COMMIT (BB-3), chưa
   * normalize; trùng `idempotencyKey` -> 200 `{duplicate:true}`. Source `api` tạo kèm key lúc cấp scope.
   */
  @Post('events')
  @RequireScope('publish:events')
  async publish(@Req() req: RequestWithPrincipal & { rawBody?: Buffer }, @Res() res: Response) {
    validatePublishBody(req.body);
    const key = req.apiKey!;
    if (!key.sourceId) {
      unprocessable({ error: 'no_publish_source', message: 'Key không có source api (tạo lại key có scope publish:events)' });
    }
    const rawReq: RawWebhookRequest = {
      provider: 'api',
      sourceKey: `api_${key.id}`,
      headers: req.headers as RawWebhookRequest['headers'],
      rawBody: req.rawBody ?? Buffer.from(JSON.stringify(req.body)),
      body: req.body,
      contentType: req.headers['content-type'],
      ip: req.ip,
    };
    const result = await this.ingest.publishFromService(key.tenantId, key.sourceId!, rawReq);
    // DX1: lỗi từ lõi ingest (source tắt, rate limit, lỗi lưu) đi qua exception filter như mọi lỗi khác của /v1/p
    // (khuôn {error, message, fix, docsUrl, requestId}); 2xx giữ nguyên ack của ApiAdapter.
    if (result.status >= 400) {
      const b = (result.body ?? {}) as { error?: unknown };
      const code = typeof b.error === 'string' && /^[a-z][a-z0-9_]*$/.test(b.error) ? b.error : undefined;
      throw new HttpException({ ...(code ? { error: code } : {}), ...(!code && typeof b.error === 'string' ? { message: b.error } : {}) }, result.status);
    }
    return res.status(result.status).json(result.body);
  }
}
