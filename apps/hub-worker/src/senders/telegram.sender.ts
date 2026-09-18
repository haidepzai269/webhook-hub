import { DestinationSender, SendResult } from './sender.interface';
import { DestinationType, NormalizedEvent } from '@hub/common';
import axios from 'axios';

export class TelegramSender implements DestinationSender {
  readonly type: DestinationType = 'telegram';

  async send(config: Record<string, any>, renderedContent: string, event: NormalizedEvent): Promise<SendResult> {
    const { botToken, chatId } = config;
    if (!botToken || !chatId) {
      return { status: 400, error: 'Thiếu cấu hình botToken hoặc chatId Telegram', durationMs: 0 };
    }

    // Nếu chạy local với mock token, có thể trỏ về mock endpoint
    const baseUrl = config.apiUrl || (botToken.includes('mock') ? 'http://localhost:4000/mock/telegram' : 'https://api.telegram.org');
    const url = `${baseUrl}/bot${botToken}/sendMessage`;

    const text = renderedContent || `[Webhook Hub] Sự kiện: ${event.type}\nID: ${event.id}\nNguồn: ${event.source}`;
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    };

    const start = Date.now();
    try {
      const res = await axios.post(url, payload, {
        timeout: 5000,
        maxRedirects: 0,
        headers: { 'Content-Type': 'application/json' },
      });
      return {
        status: res.status,
        body: JSON.stringify(res.data || {}),
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        status: err.response?.status || 500,
        error: err.message,
        body: JSON.stringify(err.response?.data || {}),
        durationMs: Date.now() - start,
      };
    }
  }
}
