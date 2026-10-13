import { Controller, Post, Param, Req, Res, Headers } from '@nestjs/common';
import { Request, Response } from 'express';
import { IngestService } from './ingest.service';
import { HttpMethod, ProviderType, RawWebhookRequest } from '@hub/common';
import { PublicRoute } from '../service-api/require-scope.decorator';

/** E6: chuỗi query thô sau `?` (chưa decode), '' nếu không có. */
function rawQueryOf(url: string | undefined): string {
  if (!url) return '';
  const i = url.indexOf('?');
  return i < 0 ? '' : url.slice(i + 1);
}

@Controller('hooks')
@PublicRoute('provider gọi vào; xác thực bằng chữ ký của provider trong ProviderAdapter (timingSafeEqual)')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post(':provider/:sourceKey')
  async handleWebhook(
    @Param('provider') provider: string,
    @Param('sourceKey') sourceKey: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers() headers: Record<string, string>,
  ) {
    // PK0 / E1 (ADR-201): body parser của /hooks giữ bytes gốc với MỌI content-type (`configureBodyParsers`). Không có
    // `rawBody` = request không có body -> Buffer rỗng. KHÔNG dựng lại bằng `JSON.stringify(req.body)`: bytes dựng lại
    // không phải bytes provider đã ký, và mọi body không phải JSON/form thành `"{}"`.
    const rawBodyBuffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    // Parser raw để body là Buffer -> adapter chỉ thấy `undefined` như trước (bytes nằm ở rawBody).
    const body = Buffer.isBuffer(req.body) ? undefined : req.body;

    const rawReq: RawWebhookRequest = {
      provider: provider as ProviderType,
      sourceKey,
      headers,
      rawBody: rawBodyBuffer,
      body,
      contentType: req.headers['content-type'],
      ip: req.ip,
      method: req.method.toUpperCase() as HttpMethod,
      query: rawQueryOf(req.originalUrl ?? req.url),
    };

    const result = await this.ingestService.ingestWebhook(rawReq);
    if (result.headers) res.set(result.headers); // EG2: Retry-After của hộp phạt
    return res.status(result.status).json(result.body);
  }
}
