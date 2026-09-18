import { DestinationSender, SendResult } from './sender.interface';
import { DestinationType, NormalizedEvent } from '@hub/common';
import axios from 'axios';

export class DiscordSender implements DestinationSender {
  readonly type: DestinationType = 'discord';

  async send(config: Record<string, any>, renderedContent: string, event: NormalizedEvent): Promise<SendResult> {
    const url = config.webhookUrl;
    if (!url) {
      return { status: 400, error: 'Thiếu cấu hình webhookUrl của Discord', durationMs: 0 };
    }

    const payload = {
      content: renderedContent || `[Webhook Hub] Nhận sự kiện ${event.type} từ ${event.source}`,
      embeds: [
        {
          title: `Sự kiện: ${event.type}`,
          description: `ID: ${event.id}\nNguồn: ${event.source}\nChủ đề: ${event.subject || 'N/A'}`,
          color: 5814783,
          timestamp: event.occurredAt,
        },
      ],
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
        body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {}),
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        status: err.response?.status || 500,
        error: err.message,
        body: typeof err.response?.data === 'string' ? err.response.data : JSON.stringify(err.response?.data || {}),
        durationMs: Date.now() - start,
      };
    }
  }
}
