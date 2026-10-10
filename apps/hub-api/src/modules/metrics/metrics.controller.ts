import { Controller, Get, Headers, Res } from '@nestjs/common';
import { Response } from 'express';
import { bearerAuthorized } from '@hub/crypto';
import { apiRegistry } from './metrics';
import { PublicRoute } from '../service-api/require-scope.decorator';

/**
 * `GET /metrics` (S3-4) — KHÔNG qua JWT (Prometheus không đăng nhập). Nếu đặt `METRICS_TOKEN`
 * (môi trường deployed) thì bắt buộc `Authorization: Bearer <token>`, so bằng timingSafeEqual.
 * Local docker để trống -> Prometheus scrape thẳng trong mạng compose.
 */
export function metricsAuthorized(authHeader: string | undefined, token: string | undefined = process.env.METRICS_TOKEN): boolean {
  return bearerAuthorized(authHeader, token);
}

@Controller('metrics')
@PublicRoute('Prometheus scrape, bảo vệ bằng METRICS_TOKEN; số liệu gộp, không theo tenant')
export class MetricsController {
  @Get()
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    if (!metricsAuthorized(auth)) return res.status(401).json({ error: 'metrics_unauthorized' });
    res.setHeader('Content-Type', apiRegistry.contentType);
    return res.send(await apiRegistry.metrics());
  }
}
