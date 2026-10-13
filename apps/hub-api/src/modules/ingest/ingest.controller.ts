import { Controller, Get, Post, Param, Req, Res, Headers } from '@nestjs/common';
import { Request, Response } from 'express';
import { IngestService } from './ingest.service';
import { HttpMethod, ProviderType, RawWebhookRequest } from '@hub/common';
import { PublicRoute } from '../service-api/require-scope.decorator';
import { hooksQueryOf } from './hooks-path';

@Controller('hooks')
@PublicRoute('provider gọi vào; xác thực bằng chữ ký của provider trong ProviderAdapter (timingSafeEqual)')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  /**
   * PK4 (§6.2, ADR-205): GET đi CÙNG handler — chỉ để bắt tay `query-echo` (Meta, Dropbox, WebSub). Lõi hỏi
   * `adapter.acceptsMethod`; ngoài trường hợp đó -> 405, không ghi DB, không phạt. Express cho route GET nhận cả HEAD -> lõi
   * trả 405 (E27). Hộp phạt (D3) đã chặn mọi method trừ OPTIONS trước body parser (PK0, F11). Hàm riêng: hai decorator
   * route trên CÙNG một method thì cái sau ghi đè metadata method của cái trước.
   */
  @Get(':provider/:sourceKey')
  async handleHandshakeGet(
    @Param('provider') provider: string,
    @Param('sourceKey') sourceKey: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
    @Headers() headers: Record<string, string>,
  ) {
    return this.handleWebhook(provider, sourceKey, req, res, headers);
  }

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
      query: hooksQueryOf({ url: req.originalUrl ?? req.url }), // E6: tách như router (parseurl), `#frag` không lọt
    };

    const result = await this.ingestService.ingestWebhook(rawReq);
    if (result.headers) res.set(result.headers); // EG2: Retry-After của hộp phạt; PK4: header-echo, nosniff
    // PK4 §6.3: 204 không có body; echo bắt tay là `text/plain; charset=utf-8` nguyên văn (E27); body null -> rỗng.
    if (result.status === 204) return res.status(204).end();
    if (result.contentType && typeof result.body === 'string') return res.status(result.status).type(result.contentType).send(result.body);
    if (result.body === null || result.body === undefined) return res.status(result.status).end();
    return res.status(result.status).json(result.body);
  }
}
