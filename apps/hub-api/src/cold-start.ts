import type { NextFunction, Request, Response } from 'express';
import { takeColdStart } from '@hub/common';

/**
 * LOGGING.md §3.2/§11.9d (ADR-250, Admin chốt 2026-10-18): đánh dấu PHẢN HỒI ĐẦU TIÊN của một tiến trình hub-api vừa khởi động
 * (`process.uptime() < COLD_START_WINDOW_S`) bằng header `x-hub-cold: 1` — frontend (đợt 2B) đọc nó để phân biệt "Render vừa
 * thức dậy" với "code chậm" một cách XÁC ĐỊNH. CÙNG cờ với cause `slow.cold_start`: middleware đặt `req.hubCold`, controller
 * chép sang `RawWebhookRequest.cold`. Chỉ trong bộ nhớ — không Redis, không DB.
 *
 * Request đầu "thật": bỏ qua preflight (OPTIONS), health/metrics (Render và monitoring gọi trước người dùng — nếu tính, cờ
 * bị tiêu tốn ở một request không ai thấy).
 */
export const COLD_HEADER = 'x-hub-cold';
const SKIP_PREFIX = ['/health', '/metrics', '/live', '/ready'];

export type ColdRequest = Request & { hubCold?: boolean };

export function coldStartMiddleware(req: ColdRequest, res: Response, next: NextFunction): void {
  try {
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0].toLowerCase();
    if (req.method !== 'OPTIONS' && !SKIP_PREFIX.some((p) => path === p || path.startsWith(`${p}/`)) && takeColdStart()) {
      req.hubCold = true;
      res.setHeader(COLD_HEADER, '1');
    }
  } catch {
    /* quan sát không bao giờ chặn request */
  }
  next();
}
