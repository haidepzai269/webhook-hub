import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * DX1 (SPEC-dev-experience §2.1): `x-request-id` trên MỌI response của `/v1/p/*` và `/api/v1/*` (kể cả 2xx) — dev báo
 * lỗi chỉ cần gửi một chuỗi, admin tra log ra ngay. Nhận id client gửi nếu đúng khuôn (không ký tự lạ -> không chèn
 * được vào log), không thì sinh UUID. `/hooks/*` không đụng tới (bên gọi là provider).
 */
export const REQUEST_ID_HEADER = 'x-request-id';
const ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function isDevFacingPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return path.startsWith('/v1/p/') || path.startsWith('/api/v1/') || path === '/api/v1';
}

export type RequestWithId = Request & { requestId?: string };

/** Lấy (hoặc gán) requestId của request — dùng chung cho middleware và exception filter. */
export function ensureRequestId(req: RequestWithId, res?: Response): string {
  if (!req.requestId) {
    const given = req.headers?.[REQUEST_ID_HEADER];
    const v = Array.isArray(given) ? given[0] : given;
    req.requestId = typeof v === 'string' && ID_RE.test(v) ? v : randomUUID();
  }
  if (res && !res.headersSent) res.setHeader(REQUEST_ID_HEADER, req.requestId);
  return req.requestId;
}

export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  if (isDevFacingPath(req.originalUrl ?? req.url)) ensureRequestId(req, res);
  next();
}
