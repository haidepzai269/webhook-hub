import { Controller, Post, Param, Req, Res, Headers } from '@nestjs/common';
import { Request, Response } from 'express';
import { IngestService } from './ingest.service';
import { ProviderType, RawWebhookRequest } from '@hub/common';
import { PublicRoute } from '../service-api/require-scope.decorator';

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
    const rawBodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

    const rawReq: RawWebhookRequest = {
      provider: provider as ProviderType,
      sourceKey,
      headers,
      rawBody: rawBodyBuffer,
      body: req.body,
      contentType: req.headers['content-type'],
      ip: req.ip,
    };

    const result = await this.ingestService.ingestWebhook(rawReq);
    return res.status(result.status).json(result.body);
  }
}
