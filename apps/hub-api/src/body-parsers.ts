import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MAX_API_BODY_BYTES, MAX_INGEST_PAYLOAD_BYTES, ProviderType } from '@hub/common';
import { ProviderRegistry } from '@hub/providers';
import { ingestRequests } from './modules/metrics/metrics';

/**
 * Express CỦA Nest (platform-express ghim express 5) — không dùng bản express gốc của monorepo (khác major, không phải
 * dependency khai báo của hub-api). Parser tạo từ đây giống hệt parser mặc định Nest dựng.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nestExpress: typeof import('express') = require(require.resolve('express', { paths: [require.resolve('@nestjs/platform-express')] }));

/** Giống `rawBodyParser` của Nest (rawBody:true): giữ NGUYÊN bytes cho HMAC (CLAUDE.md cạm bẫy #1). */
function keepRawBody(req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer): void {
  if (Buffer.isBuffer(buf)) req.rawBody = buf;
}

/**
 * ADR-162: /hooks/* quá trần -> đếm vào CÙNG chỉ số `hub_ingest_requests_total{outcome="TOO_LARGE"}` của ingest
 * (bộ nhớ, 0 lệnh Redis). Nhãn provider chỉ nhận provider đã đăng ký — path do client gửi (chống nổ cardinality).
 */
function countTooLarge(req: Request): void {
  try {
    const seg = (req.originalUrl ?? req.url ?? '').split('?')[0].split('/')[2] ?? '';
    let label = 'unknown';
    try {
      label = ProviderRegistry.get(seg as ProviderType).provider;
    } catch {
      /* provider lạ -> 'unknown' */
    }
    ingestRequests.inc({ provider: label, outcome: 'TOO_LARGE' });
  } catch {
    /* metric không bao giờ làm hỏng request */
  }
}

function countingOversize(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    parser(req, res, (err?: any) => {
      if (err && Number(err.status ?? err.statusCode) === 413) countTooLarge(req);
      next(err);
    });
}

/**
 * ADR-162: body parser theo route.
 * - `/hooks/*`: trần `MAX_INGEST_PAYLOAD_BYTES` (1MB) — push GitHub lớn không bị 413 trước ingest (mặc định Express
 *   100KB thì không raw_event nào được ghi và GitHub không gửi lại). Quá trần -> 413 + đếm TOO_LARGE.
 * - Mọi route khác: `MAX_API_BODY_BYTES` (100KB, như mặc định cũ).
 * Gắn parser /hooks TRƯỚC: body-parser bỏ qua request đã parse (`req._body`), nên parser chung không đọc lại. Tên hàm
 * `jsonParser`/`urlencodedParser` có trong router -> Nest không chồng thêm parser mặc định lúc init.
 * urlencoded `extended:true` (mặc định cũ của Nest) ở mọi route: source generic gửi form lồng (`a[b]=1`) vẫn ra
 * đường trường `a.b`; form GitHub (`payload=<json>`) phẳng nên không ảnh hưởng.
 * Gọi SAU helmet / requestId / enableCors (ngay trước listen) để lỗi 400/413 của parser vẫn mang header CORS + helmet.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  const hooksJson = nestExpress.json({ limit: MAX_INGEST_PAYLOAD_BYTES, verify: keepRawBody });
  const hooksForm = nestExpress.urlencoded({ limit: MAX_INGEST_PAYLOAD_BYTES, extended: true, verify: keepRawBody });
  app.use('/hooks', countingOversize(hooksJson));
  app.use('/hooks', countingOversize(hooksForm));
  app.use(nestExpress.json({ limit: MAX_API_BODY_BYTES, verify: keepRawBody }));
  app.use(nestExpress.urlencoded({ limit: MAX_API_BODY_BYTES, extended: true, verify: keepRawBody }));
}
