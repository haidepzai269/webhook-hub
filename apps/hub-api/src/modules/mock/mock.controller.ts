import { Controller, Post, Res, Body, Param, All, Query } from '@nestjs/common';
import { Request, Response } from 'express';
import { logger } from '@hub/common';

/** `123456:ABCdef...` -> `123456:***` (giữ bot id để phân biệt, che phần bí mật). */
export function maskToken(token: string | undefined): string {
  if (!token) return '';
  const i = token.indexOf(':');
  return i > 0 ? `${token.slice(0, i)}:***` : '***';
}

@Controller('mock')
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
