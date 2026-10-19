import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { CanonicalLogger, MAX_API_BODY_BYTES, MAX_INGEST_PAYLOAD_BYTES, ProviderType, newTraceId } from '@hub/common';
import { ProviderRegistry } from '@hub/providers';
import { IngestService } from './modules/ingest/ingest.service';
import { providerMetricLabel } from './modules/ingest/blocked-ack';
import { ingestRequests } from './modules/metrics/metrics';
import { hubError } from './modules/errors/hub-error';
import { ensureRequestId } from './modules/errors/request-id';
import { toErrorBody } from './modules/errors/service-exception.filter';
import { hooksPathOf, matchHookRoute, pathnameOfUrl } from './modules/ingest/hooks-path';

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
    ingestRequests.inc({ provider: label, outcome: 'TOO_LARGE', cause: 'wrong.payload_shape' });
  } catch {
    /* metric không bao giờ làm hỏng request */
  }
}

/**
 * LOGGING.md §1/§10: lỗi parser của `/hooks/*` (413 quá trần, 400 JSON hỏng, 415…) trước đây KHÔNG để lại dấu vết ở log. Một dòng
 * `ingest.done` `wrong.payload_shape` (dedupe theo cause — bão 413 không thành bão log). `canonical` do `configureBodyParsers`
 * lấy từ IngestService (cùng instance với ingest). KHÔNG ghi body — chỉ status, `bytes` (độ dài khai báo) và loại lỗi.
 */
let parserCanonical: CanonicalLogger | undefined;
function logParserReject(req: Request, err: any): void {
  try {
    const status = Number(err?.status ?? err?.statusCode);
    if (!parserCanonical || !(status >= 400 && status < 500)) return;
    const seg = (req.originalUrl ?? req.url ?? '').split('?')[0].split('/')[2] ?? '';
    const len = Number(req.headers['content-length']);
    parserCanonical.emit({
      svc: 'hub-api',
      msg: 'ingest.done',
      outcome: 'rejected',
      traceId: newTraceId(),
      provider: providerMetricLabel(seg),
      httpStatus: status,
      bytes: Number.isFinite(len) ? len : undefined,
      cause: 'wrong.payload_shape',
      totalMs: 0,
      extra: { policy: typeof err?.type === 'string' ? String(err.type).slice(0, 60) : `parser_${status}`, ...(req.headers['content-type'] ? { content_type: String(req.headers['content-type']) } : {}) },
    });
  } catch {
    /* log không bao giờ làm hỏng request */
  }
}

function countingOversize(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    parser(req, res, (err?: any) => {
      if (err && Number(err.status ?? err.statusCode) === 413) countTooLarge(req);
      if (err) logParserReject(req, err);
      next(err);
    });
}

/**
 * PK0 / E1 (ADR-201): JSON lỗi cú pháp ở RIÊNG `/hooks/generic/*` không trả 400 ở parser — JSON lines (Auth0), body gắn nhầm
 * `application/json`… vẫn vào ingest với bytes gốc (`keepRawBody` chạy TRƯỚC parse nên `req.rawBody` đã có), `body = null`
 * ("không parse được"). Provider native giữ 400 như cũ (hợp đồng đã test). Lỗi khác (413, charset…) đi tiếp như cũ.
 */
function tolerateGenericJsonError(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    parser(req, res, (err?: any) => {
      if (err && err.type === 'entity.parse.failed' && Buffer.isBuffer((req as Request & { rawBody?: Buffer }).rawBody)) {
        const hit = matchHookRoute(pathnameOfUrl(req.originalUrl), ['/hooks']);
        if (hit?.provider === 'generic') {
          req.body = null;
          return next();
        }
      }
      next(err);
    });
}

/** Cùng câu `fix` với 404 tĩnh của nginx (`docker/nginx/nginx.conf.template`, location `~* "^/hooks(/|$)"`) — test so khớp. */
export const HOOKS_NOT_FOUND_FIX = 'Check the webhook URL: /hooks/<provider>/<sourceKey> as shown in the console.';

/**
 * Review EG1 lượt 3 (TB-2), lớp thứ hai sau nginx: router express KHÔNG phân biệt hoa thường, nên `/HOOKS/github/<key>`
 * vẫn tới ingest — đi vòng location `/hooks/*` (cầu chì, lọc thô) của nginx nếu nginx thiếu `~*`. Ở đây mọi path khớp
 * `/hooks` không phân biệt hoa thường mà KHÔNG viết đúng chữ thường -> 404 `not_found` (khuôn ERRORS.md, `fix` giống nginx),
 * không đọc body. Không bật `case sensitive routing` toàn app: phạm vi rộng hơn mức cần (mọi route /api/*).
 *
 * Gộp với D3 (review EG1 lượt 4 Thấp-A/B, EG lượt 6 S1/S2/S4): path lấy bằng `hooksPathOf` (parseurl — đúng như router và
 * gate hộp phạt), nên absolute-form `http://h/hooks/...` và `#frag` không bị 404 oan. Gắn ở GỐC (không mount `/hooks`) và
 * TRƯỚC gate hộp phạt (`installHooksPathGuard`, main.ts): `/HOOKS/...` nhận 404 như nhau dù IP sạch hay đang bị ban.
 */
export function rejectNonCanonicalHooksPath(req: Request, res: Response, next: NextFunction): void {
  // Gắn ở gốc thì req.url === originalUrl (dùng cache `_parsedUrl` chung với gate + router); bị mount lồng thì parse originalUrl.
  const p = req.originalUrl && req.originalUrl !== req.url ? pathnameOfUrl(req.originalUrl) : hooksPathOf(req);
  if (p === undefined) return next();
  const lower = p.toLowerCase();
  if (!(lower === '/hooks' || lower.startsWith('/hooks/')) || p.startsWith('/hooks')) return next();
  const { status, body } = toErrorBody(hubError('not_found'), ensureRequestId(req, res));
  res.status(status).json({ ...body, fix: HOOKS_NOT_FOUND_FIX });
}

/** Gắn `rejectNonCanonicalHooksPath` ở gốc — main.ts gọi NGAY TRƯỚC `installPenaltyGate` (sau CORS để 404 có header CORS). */
export function installHooksPathGuard(app: INestApplication): void {
  app.use(rejectNonCanonicalHooksPath);
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
 *
 * PK0 / E1 (ADR-201): `/hooks/*` thêm parser raw `type: () => true` SAU json/urlencoded — mọi content-type khác (SNS
 * text/plain, XML, JWT, nhị phân, không có content-type) vẫn có `req.rawBody` đúng từng byte, cùng trần 1MB + đếm
 * TOO_LARGE. Request đã được json/urlencoded đọc thì raw bỏ qua (body-parser: stream đã xong). Body rỗng: không parser
 * nào chạy, controller dùng Buffer rỗng.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  try {
    parserCanonical = app.get(IngestService).canonical; // không có IngestService (test dựng app tối giản) -> không log
  } catch {
    parserCanonical = undefined;
  }
  const hooksJson = nestExpress.json({ limit: MAX_INGEST_PAYLOAD_BYTES, verify: keepRawBody });
  const hooksForm = nestExpress.urlencoded({ limit: MAX_INGEST_PAYLOAD_BYTES, extended: true, verify: keepRawBody });
  const hooksRaw = nestExpress.raw({ type: () => true, limit: MAX_INGEST_PAYLOAD_BYTES, verify: keepRawBody });
  app.use('/hooks', countingOversize(tolerateGenericJsonError(hooksJson)));
  app.use('/hooks', countingOversize(hooksForm));
  app.use('/hooks', countingOversize(hooksRaw));
  app.use(nestExpress.json({ limit: MAX_API_BODY_BYTES, verify: keepRawBody }));
  app.use(nestExpress.urlencoded({ limit: MAX_API_BODY_BYTES, extended: true, verify: keepRawBody }));
}
