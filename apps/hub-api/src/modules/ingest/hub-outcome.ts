import type { INestApplication } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'http';
import { pathnameOfUrl } from './hooks-path';

/**
 * LH3 (SPEC-hub-sap ĐÍNH CHÍNH H1, ADR-221): mọi phản hồi CỐ Ý của `/hooks/*` mang `x-hub-outcome`, để lưới hứng (Worker,
 * LH2) phân biệt "hub từ chối" với "hub vắng". Không có header này thì 503 do source đặt `ack.rejectStatus: 503` (PK4,
 * ADR-205) trông y như hub chết -> Worker ghi D1 + trả 2xx cho request chữ ký rác (vòng qua EG2, làm đầy D1).
 *
 * | giá trị       | khi nào                                                                                  |
 * |---------------|------------------------------------------------------------------------------------------|
 * | `accepted`    | 2xx sau COMMIT raw_event mới                                                               |
 * | `duplicate`   | 2xx bản trùng (Redis hoặc UNIQUE Postgres)                                                 |
 * | `handshake`   | trả lời bắt tay (GET query-echo, body/header-echo, hmac-echo, manual-url, HEAD head-ok)    |
 * | `rejected`    | request SAI: chữ ký (kể cả 503 `rejectStatus`), source lạ/404, 400, 405, 413, 414, 422     |
 * | `refused`     | hub CỐ Ý không nhận LÚC NÀY theo chính sách: 429 (cổng phạt, rate limit), 507, cờ unverified tắt |
 * | `unavailable` | lỗi tạm thời (transaction lỗi, exception) — BB-3, Worker coi là "hub vắng"                 |
 *
 * Worker (H2): 408/429 -> luôn retry dù outcome là gì (429 mang `refused` + `Retry-After`).
 *
 * Hai lớp để không lọt nhánh nào:
 *  1. Nhánh biết rõ kết quả đặt header tường minh: controller (`IngestResponse.outcome`), cổng phạt (429 `refused`).
 *  2. Lưới đỡ ở GỐC app, cài TRƯỚC guard `/hooks`, cổng phạt, body parser: ngay lúc ghi header (`writeHead`), phản hồi
 *     `/hooks/*` chưa có header thì gắn theo status — ≥ 500 -> `unavailable`, 4xx -> `rejected`, 2xx/3xx -> không gắn
 *     (mọi 2xx của ingest đều đi qua lớp 1). Lỗi parser (400/413), guard `/HOOKS` (404), exception filter (500) đi lớp này.
 */
export const HUB_OUTCOME_HEADER = 'x-hub-outcome';
export type HubOutcome = 'accepted' | 'duplicate' | 'rejected' | 'handshake' | 'refused' | 'unavailable';

/** Lớp 2: outcome suy từ status khi nhánh trả lời không tự đặt. null = không gắn. */
export function fallbackOutcome(status: number): HubOutcome | null {
  if (status >= 500) return 'unavailable';
  if (status >= 400) return 'rejected';
  return null;
}

/** Đường `/hooks` không phân biệt hoa thường (guard `/HOOKS` cũng là phản hồi của cửa ingest). */
function isHooksPath(url: string | undefined): boolean {
  const p = (pathnameOfUrl(url) ?? '').toLowerCase();
  return p === '/hooks' || p.startsWith('/hooks/');
}

export function hubOutcomeMiddleware(req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: (err?: unknown) => void): void {
  try {
    if (!isHooksPath(req.originalUrl ?? req.url)) return next();
    const original = res.writeHead;
    res.writeHead = function patchedWriteHead(this: ServerResponse, statusCode: number, ...rest: unknown[]) {
      try {
        if (!this.hasHeader(HUB_OUTCOME_HEADER)) {
          const o = fallbackOutcome(statusCode);
          if (o) this.setHeader(HUB_OUTCOME_HEADER, o);
        }
      } catch {
        /* header đã gửi / lỗi lạ: không làm hỏng phản hồi */
      }
      return (original as (...a: unknown[]) => ServerResponse).apply(this, [statusCode, ...rest]);
    } as ServerResponse['writeHead'];
  } catch {
    /* không bao giờ chặn request */
  }
  next();
}

/** main.ts + test: cài ở GỐC, TRƯỚC `installHooksPathGuard` / `installPenaltyGate` / `configureBodyParsers`. */
export function installHubOutcome(app: INestApplication): void {
  app.use(hubOutcomeMiddleware);
}
