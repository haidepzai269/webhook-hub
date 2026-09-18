import { Controller, Post, Req, Res, Body, Param } from '@nestjs/common';
import { Request, Response } from 'express';
import { logger } from '@hub/common';

@Controller('mock')
export class MockController {
  @Post('discord')
  mockDiscord(@Body() body: any, @Res() res: Response) {
    logger.info({ body }, '[MOCK DISCORD] Nhận thành công thông báo webhook');
    return res.status(204).send();
  }

  @Post('telegram/bot:token/sendMessage')
  mockTelegram(@Param('token') token: string, @Body() body: any, @Res() res: Response) {
    logger.info({ token, body }, '[MOCK TELEGRAM] Nhận thành công tin nhắn bot');
    return res.status(200).json({ ok: true, result: { message_id: 123456 } });
  }
}
