import { Controller, Post, Res, Req, Body, Param, All, Query } from '@nestjs/common';
import { Request, Response } from 'express';
import { logger } from '@hub/common';
import { PublicRoute } from '../service-api/require-scope.decorator';

/** `123456:ABCdef...` -> `123456:***` (giữ bot id để phân biệt, che phần bí mật). */
export function maskToken(token: string | undefined): string {
  if (!token) return '';
  const i = token.indexOf(':');
  return i > 0 ? `${token.slice(0, i)}:***` : '***';
}

@Controller('mock')
@PublicRoute('đích giả Telegram/Discord cho local/verify (ADR-054), không đọc dữ liệu tenant')
export class MockController {
  /**
   * S2-1: đích luôn hỏng để kiểm circuit breaker — `GET|POST /mock/fail?status=500` luôn trả đúng mã
   * được yêu cầu (200–599; ngoài khoảng hoặc không phải số nguyên -> 500). Không ghi log body để khỏi ồn khi bắn nhiều.
   */
  @All('fail')
  mockFail(@Query('status') status: string | undefined, @Res() res: Response) {
    const n = Number(status ?? 500);
    const code = Number.isInteger(n) && n >= 200 && n <= 599 ? n : 500;
    logger.info({ status: code }, '[MOCK FAIL] trả mã theo yêu cầu');
    return res.status(code).json({ mock: 'fail', status: code });
  }

  /**
   * S12: endpoint mock của project demo (`cafe`, `bookstore`) trên stack dev — trả lại challenge (S6) và 200 cho
   * sự kiện. KHÔNG verify chữ ký (mock); hubv dùng sink riêng (DEMO_ENDPOINT_BASE_URL). Chỉ log type + webhook-id.
   */
  @Post('echo/:name')
  mockEcho(@Param('name') name: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    if (body?.type === 'endpoint.verification' && typeof body?.challenge === 'string') {
      return res.status(200).json({ challenge: body.challenge });
    }
    logger.info({ endpoint: name, type: body?.type, webhookId: req.headers['webhook-id'] }, '[MOCK ECHO] nhận sự kiện');
    return res.status(200).json({ ok: true });
  }

  @Post('discord')
  mockDiscord(@Body() body: any, @Res() res: Response) {
    logger.info({ body }, '[MOCK DISCORD] Nhận thành công thông báo webhook');
    return res.status(204).send();
  }

  @Post('telegram/bot:token/sendMessage')
  mockTelegram(@Param('token') token: string, @Body() body: any, @Res() res: Response) {
    // Không log bot token (review SPEC-2 #7): seed có thể trỏ token THẬT vào mock.
    logger.info({ token: maskToken(token), body }, '[MOCK TELEGRAM] Nhận thành công tin nhắn bot');
    return res.status(200).json({ ok: true, result: { message_id: 123456 } });
  }
}
